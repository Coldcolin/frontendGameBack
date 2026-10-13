import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { customAlphabet, nanoid } from "nanoid";
import { config, storagePaths } from "../config.js";
import type { Activity, GradeResult, MatchDTO, Slot } from "../contracts.js";
import { ChallengeModel, MatchModel, SubmissionModel, type ChallengeDoc } from "../models.js";
import sharp from "sharp";
import { diffPngs, scoreRgba } from "../grading/diff.js";
import { renderCode } from "../grading/renderer.js";
import { targetPath, toChallengeDTO } from "./challenges.js";

const matchCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6);

export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
const newToken = () => randomBytes(24).toString("base64url");

export function tokenMatches(token: string | undefined, hash: string) {
  if (!token) return false;
  const a = Buffer.from(hashToken(token), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function slotForToken(match: { players: { slot: string; tokenHash: string }[] }, token: string | undefined): Slot | null {
  const p = match.players.find((pl) => tokenMatches(token, pl.tokenHash));
  return (p?.slot as Slot) ?? null;
}

// ---- In-memory live state (per process) -------------------------------------

interface LiveState {
  code: Partial<Record<Slot, string>>;
  liveScore: Partial<Record<Slot, number>>;
  connected: Record<Slot, number>;
  lastEdit: Partial<Record<Slot, number>>;
  lastSubmit: Partial<Record<Slot, number>>;
  timer?: NodeJS.Timeout;
  /** Clock end while live (ms epoch); unset in the lobby and after the end */
  endsAt?: number;
  lastSnapshot: Partial<Record<Slot, number>>;
  /** Set while endMatch grades, so a duplicate timer can't grade twice */
  ending?: boolean;
}

const live = new Map<string, LiveState>();

export function liveState(matchId: string): LiveState {
  let s = live.get(matchId);
  if (!s) {
    s = { code: {}, liveScore: {}, connected: { A: 0, B: 0 }, lastEdit: {}, lastSubmit: {}, lastSnapshot: {} };
    live.set(matchId, s);
  }
  return s;
}

export function activityOf(matchId: string, slot: Slot): Activity {
  const t = liveState(matchId).lastEdit[slot];
  return t && Date.now() - t < 3000 ? "typing" : "idle";
}

/** True while the clock is running (in-memory; re-armed at boot by resumeLiveMatches). */
export function isLive(matchId: string) {
  const end = live.get(matchId)?.endsAt;
  return end !== undefined && Date.now() < end;
}

// ---- DTO --------------------------------------------------------------------

export async function loadMatch(id: string) {
  if (!/^[a-f0-9]{24}$/i.test(id)) return null;
  return MatchModel.findById(id).populate<{ challenge: ChallengeDoc }>("challenge");
}

type PopulatedMatch = NonNullable<Awaited<ReturnType<typeof loadMatch>>>;

export function toMatchDTO(m: PopulatedMatch): MatchDTO {
  const s = liveState(m.id);
  return {
    id: m.id,
    code: m.code,
    status: m.status as MatchDTO["status"],
    durationSec: m.durationSec,
    startedAt: m.startedAt?.toISOString() ?? null,
    endsAt: m.endsAt?.toISOString() ?? null,
    serverNow: new Date().toISOString(),
    challenge: m.status === "lobby" ? null : toChallengeDTO(m.challenge),
    starterCode: m.challenge.starterCode ?? "",
    winner: (m.winner as MatchDTO["winner"]) ?? null,
    players: m.players.map((p) => {
      const slot = p.slot as Slot;
      return {
        slot,
        name: p.name,
        handle: p.handle ?? "",
        avatarUrl: p.avatarUrl ?? undefined,
        connected: s.connected[slot] > 0,
        liveScore: s.liveScore[slot] ?? null,
        officialScore: p.officialScore ?? null,
        didNotStart: p.didNotStart ?? false,
      };
    }),
  };
}

// ---- Commands ---------------------------------------------------------------

export interface CreateMatchInput {
  challengeId: string;
  durationSec: number;
  players: { name: string; handle?: string; avatarUrl?: string }[];
}

export async function createMatch(input: CreateMatchInput) {
  const challenge = await ChallengeModel.findById(input.challengeId);
  if (!challenge) throw new HttpError(404, "That target no longer exists. Pick another one.");
  const tokens = { A: newToken(), B: newToken() };
  const adminKey = newToken();
  const match = await MatchModel.create({
    code: matchCode(),
    challenge: challenge._id,
    durationSec: input.durationSec,
    adminKeyHash: hashToken(adminKey),
    players: (["A", "B"] as const).map((slot, i) => ({
      slot,
      name: input.players[i].name,
      handle: input.players[i].handle ?? "",
      avatarUrl: input.players[i].avatarUrl,
      tokenHash: hashToken(tokens[slot]),
    })),
  });
  const id = match.id;
  return {
    id,
    links: {
      a: `/m/${id}/play?t=${tokens.A}`,
      b: `/m/${id}/play?t=${tokens.B}`,
      spectator: `/m/${id}/watch`,
      admin: `/admin/m/${id}?k=${adminKey}`,
    },
  };
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type Broadcast = {
  state: (m: PopulatedMatch) => void;
  ended: (m: PopulatedMatch) => void;
};
let broadcast: Broadcast = { state: () => {}, ended: () => {} };
export function setBroadcaster(b: Broadcast) {
  broadcast = b;
}

export async function startMatch(id: string, adminKey: string | undefined) {
  const m = await loadMatch(id);
  if (!m) throw new HttpError(404, "Match not found.");
  if (!tokenMatches(adminKey, m.adminKeyHash)) throw new HttpError(403, "This admin link is not valid for this match.");
  const now = new Date();
  const endsAt = new Date(now.getTime() + m.durationSec * 1000);
  // Atomic lobby → live, so two concurrent starts can't both reset the clock.
  const started = await MatchModel.findOneAndUpdate(
    { _id: m._id, status: "lobby" },
    { $set: { status: "live", startedAt: now, endsAt } },
  );
  if (!started) throw new HttpError(409, "This match has already started.");
  scheduleEnd(m.id, endsAt);
  const fresh = (await loadMatch(id))!;
  broadcast.state(fresh);
  return fresh;
}

export function scheduleEnd(matchId: string, endsAt: Date) {
  const s = liveState(matchId);
  clearTimeout(s.timer);
  s.endsAt = endsAt.getTime();
  s.timer = setTimeout(() => void endMatch(matchId).catch((e) => console.error("[match] end failed", e)), Math.max(0, endsAt.getTime() - Date.now()));
}

async function persistGrade(m: PopulatedMatch, slot: Slot, code: string, final: boolean): Promise<GradeResult> {
  const file = targetPath(m.challenge);
  const [target, render] = await Promise.all([fs.readFile(file), renderCode(code)]);
  const result = diffPngs(target, render, file);
  const base = `${m.id}-${slot}-${nanoid(6)}`;
  await Promise.all([
    fs.writeFile(path.join(storagePaths.diffs, `${base}-diff.png`), result.diffPng),
    fs.writeFile(path.join(storagePaths.diffs, `${base}-render.png`), render),
  ]);
  await SubmissionModel.create({
    match: m._id, slot, code, score: result.score, regions: result.regions,
    diffFile: `${base}-diff.png`, renderFile: `${base}-render.png`, final,
  });
  return {
    slot,
    score: result.score,
    regions: result.regions,
    diffUrl: `/files/diffs/${base}-diff.png`,
    renderUrl: `/files/diffs/${base}-render.png`,
  };
}

export async function submit(id: string, token: string | undefined, code: string) {
  const m = await loadMatch(id);
  if (!m) throw new HttpError(404, "Match not found.");
  const slot = slotForToken(m, token);
  if (!slot) throw new HttpError(403, "This player link is not valid for this match.");
  if (m.status !== "live") throw new HttpError(409, m.status === "lobby" ? "The match hasn't started yet." : "The match is over.");
  if (m.endsAt && Date.now() >= m.endsAt.getTime()) throw new HttpError(409, "The match is over.");
  const s = liveState(m.id);
  const last = s.lastSubmit[slot] ?? 0;
  if (Date.now() - last < config.submitCooldownMs) throw new HttpError(429, "Wait a few seconds between diff checks.");
  s.lastSubmit[slot] = Date.now();
  s.code[slot] = code;
  const result = await persistGrade(m, slot, code, false);
  await MatchModel.updateOne({ _id: m._id, "players.slot": slot }, { $set: { "players.$.officialScore": result.score } });
  const fresh = await loadMatch(id);
  if (fresh) broadcast.state(fresh);
  return result;
}

const sameCode = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

/** A player who never touched the starter loses to one who did, whatever the scores. */
export function decideWinner(scores: Record<Slot, number>, didNotStart: Record<Slot, boolean>): Slot | "tie" {
  if (didNotStart.A !== didNotStart.B) return didNotStart.A ? "B" : "A";
  return scores.A === scores.B ? "tie" : scores.A > scores.B ? "A" : "B";
}

export async function endMatch(id: string) {
  const m = await loadMatch(id);
  if (!m || m.status !== "live") return;
  const s = liveState(m.id);
  if (s.ending) return;
  s.ending = true;
  try {
    const scores: Record<Slot, number> = { A: 0, B: 0 };
    const didNotStart: Record<Slot, boolean> = { A: false, B: false };
    const starter = m.challenge.starterCode ?? "";
    for (const p of m.players) {
      const slot = p.slot as Slot;
      const lastSub = await SubmissionModel.findOne({ match: m._id, slot }).sort({ createdAt: -1 });
      const code = s.code[slot] ?? lastSub?.code ?? starter;
      didNotStart[slot] = sameCode(code, starter);
      p.didNotStart = didNotStart[slot];
      try {
        scores[slot] = (await persistGrade(m, slot, code, true)).score;
      } catch (e) {
        // A grader failure must not leave the match live forever.
        console.error(`[match] final grade failed for ${m.id}/${slot}`, e);
        scores[slot] = lastSub?.score ?? 0;
      }
      p.officialScore = scores[slot];
    }
    m.status = "finished";
    m.winner = decideWinner(scores, didNotStart);
    await m.save();
    clearTimeout(s.timer);
    s.endsAt = undefined;
    broadcast.ended(m);
  } finally {
    s.ending = false;
  }
}

const SNAPSHOT_INTERVAL_MS = 500;
const { width: W, height: H } = config.canvas;

/**
 * Scores a contender's rendered snapshot on the server, so the live score always
 * matches the canvas spectators see. Returns null for snapshots it drops
 * (not live, too frequent, wrong size or unreadable).
 */
export async function scoreSnapshot(
  matchId: string,
  slot: Slot,
  challenge: Pick<ChallengeDoc, "targetFile">,
  dataUrl: string,
): Promise<number | null> {
  // Outside the clock a score would let a player probe the hidden target.
  if (!isLive(matchId)) return null;
  const s = liveState(matchId);
  const now = Date.now();
  if (now - (s.lastSnapshot[slot] ?? 0) < SNAPSHOT_INTERVAL_MS) return null;
  s.lastSnapshot[slot] = now;
  const m = /^data:image\/(png|webp);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  try {
    const { data, info } = await sharp(Buffer.from(m[2], "base64"), { limitInputPixels: W * H })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.width !== W || info.height !== H) return null;
    const file = targetPath(challenge);
    return scoreRgba(await readTarget(file), file, data, W, H);
  } catch {
    return null;
  }
}

const targetBytes = new Map<string, Promise<Buffer>>();
const readTarget = (file: string) => {
  if (!targetBytes.has(file)) targetBytes.set(file, fs.readFile(file));
  return targetBytes.get(file)!;
};

/** Re-arms timers for live matches after a restart. */
export async function resumeLiveMatches() {
  const liveMatches = await MatchModel.find({ status: "live" });
  for (const m of liveMatches) if (m.endsAt) scheduleEnd(m.id, m.endsAt);
}

export async function finalSubmissions(id: string) {
  const subs = await SubmissionModel.find({ match: id, final: true }).sort({ createdAt: -1 });
  return subs.map((s) => ({
    slot: s.slot as Slot,
    score: s.score,
    regions: s.regions.map((r) => ({ x: r.x!, y: r.y!, w: r.w!, h: r.h!, density: r.density! })),
    diffUrl: `/files/diffs/${s.diffFile}`,
    renderUrl: `/files/diffs/${s.renderFile}`,
  }));
}
