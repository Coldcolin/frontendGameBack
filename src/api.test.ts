import { afterAll, beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import request from "supertest";

process.env.STORAGE_DIR = path.join(os.tmpdir(), `diffarena-test-${Date.now()}`);

const { connectDb, disconnectDb } = await import("./db.js");
const { createApp } = await import("./app.js");
const { ensureStorage, seedChallenges } = await import("./services/challenges.js");
const { closeRenderer, renderCode } = await import("./grading/renderer.js");
const { diffPngs } = await import("./grading/diff.js");
const { builtInChallenges } = await import("./seedChallenges.js");
const { endMatch, loadMatch, scoreSnapshot } = await import("./services/matches.js");
const { targetPath } = await import("./services/challenges.js");
const fsp = await import("node:fs/promises");
const { MatchModel } = await import("./models.js");

const app = createApp();

beforeAll(async () => {
  await ensureStorage();
  await connectDb("");
  await seedChallenges();
}, 120_000);

afterAll(async () => {
  await closeRenderer();
  await disconnectDb();
});

const tokenOf = (link: string) => new URL(link, "http://x").searchParams.get("t")!;
const keyOf = (link: string) => new URL(link, "http://x").searchParams.get("k")!;

async function newMatch(durationSec = 600) {
  const [challenge] = (await request(app).get("/api/challenges")).body;
  const res = await request(app)
    .post("/api/matches")
    .send({ challengeId: challenge.id, durationSec, players: [{ name: "Alex Rivera" }, { name: "Sarah Chen" }] });
  expect(res.status).toBe(201);
  return res.body;
}

describe("matches API", () => {
  it("lists the three seeded targets", async () => {
    const res = await request(app).get("/api/challenges");
    expect(res.body.map((c: { slug: string }) => c.slug)).toEqual(builtInChallenges.map((c) => c.slug));
  });

  it("validates match input", async () => {
    const res = await request(app).post("/api/matches").send({ challengeId: "x", durationSec: 600, players: [] });
    expect(res.status).toBe(400);
  });

  it("never exposes tokens in the public match", async () => {
    const { match } = await newMatch();
    const res = await request(app).get(`/api/matches/${match.id}`);
    expect(JSON.stringify(res.body)).not.toMatch(/tokenHash|adminKeyHash/);
    expect(res.body.status).toBe("lobby");
  });

  it("requires the admin key to start and a player token to submit", async () => {
    const { match, links } = await newMatch();
    expect((await request(app).post(`/api/matches/${match.id}/start`).set("x-admin-key", "nope")).status).toBe(403);
    expect((await request(app).post(`/api/matches/${match.id}/submit`).set("x-player-token", tokenOf(links.a)).send({ code: "" })).status).toBe(409);
    const started = await request(app).post(`/api/matches/${match.id}/start`).set("x-admin-key", keyOf(links.admin));
    expect(started.body.status).toBe("live");
    expect((await request(app).post(`/api/matches/${match.id}/submit`).set("x-player-token", "bad").send({ code: "" })).status).toBe(403);
  });

  it("accepts matches up to an hour long", async () => {
    const { match } = await newMatch(3600);
    expect(match.durationSec).toBe(3600);
  });

  it("grades the target's own HTML at ≥ 99.5% and the untouched starter at 0", async () => {
    const { match, links } = await newMatch();
    await request(app).post(`/api/matches/${match.id}/start`).set("x-admin-key", keyOf(links.admin));
    const perfect = await request(app)
      .post(`/api/matches/${match.id}/submit`)
      .set("x-player-token", tokenOf(links.a))
      .send({ code: builtInChallenges[0].html });
    expect(perfect.status).toBe(200);
    expect(perfect.body.score).toBeGreaterThanOrEqual(99.5);

    const blank = await request(app)
      .post(`/api/matches/${match.id}/submit`)
      .set("x-player-token", tokenOf(links.b))
      .send({ code: builtInChallenges[0].starterCode });
    expect(blank.body.score).toBe(0);
    expect(blank.body.regions.length).toBeGreaterThan(0);

    await endMatch(match.id);
    const results = await request(app).get(`/api/matches/${match.id}/results`);
    expect(results.body.match.status).toBe("finished");
    expect(results.body.match.winner).toBe("A");
    expect(results.body.match.players[1].didNotStart).toBe(true);
    expect(results.body.finals).toHaveLength(2);
  }, 60_000);

  it("never lets an untouched starter tie a player who built something", async () => {
    const { match, links } = await newMatch();
    await request(app).post(`/api/matches/${match.id}/start`).set("x-admin-key", keyOf(links.admin));
    // Edited, but still renders blank, so it scores 0 like the starter.
    const edited = await request(app)
      .post(`/api/matches/${match.id}/submit`)
      .set("x-player-token", tokenOf(links.a))
      .send({ code: `<div class="w-[600px] h-[400px] bg-white"><p></p></div>` });
    expect(edited.body.score).toBe(0);

    await endMatch(match.id);
    const { body } = await request(app).get(`/api/matches/${match.id}/results`);
    expect(body.match.players.map((p: { officialScore: number }) => p.officialScore)).toEqual([0, 0]);
    expect(body.match.players.map((p: { didNotStart: boolean }) => p.didNotStart)).toEqual([false, true]);
    expect(body.match.winner).toBe("A");
  }, 60_000);

  it("calls it a tie when neither player starts", async () => {
    const { match, links } = await newMatch();
    await request(app).post(`/api/matches/${match.id}/start`).set("x-admin-key", keyOf(links.admin));
    await endMatch(match.id);
    const { body } = await request(app).get(`/api/matches/${match.id}/results`);
    expect(body.match.players.every((p: { didNotStart: boolean }) => p.didNotStart)).toBe(true);
    expect(body.match.winner).toBe("tie");
  }, 60_000);

  it("renders plain CSS like Tailwind, and keeps the page shell locked", async () => {
    const tailwind = await renderCode(`<div class="absolute left-10 top-10 w-40 h-24 bg-[#00aeef] rounded-lg"></div>`);
    const css = await renderCode(
      `<style>.box{position:absolute;left:40px;top:40px;width:160px;height:96px;background:#00aeef;border-radius:8px}</style><div class="box"></div>`,
    );
    expect(diffPngs(tailwind, css).diffPixels).toBe(0);

    const blank = await renderCode("");
    const shell = await renderCode(`<style>html,body{background:#000;margin:40px}#root{width:10px}</style>`);
    expect(diffPngs(blank, shell).diffPixels).toBe(0);
  }, 60_000);

  it("starts a match only once under concurrent starts", async () => {
    const { match, links } = await newMatch();
    const start = () => request(app).post(`/api/matches/${match.id}/start`).set("x-admin-key", keyOf(links.admin));
    const statuses = (await Promise.all([start(), start()])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
  });

  it("rejects diff checks after the clock runs out", async () => {
    const { match, links } = await newMatch();
    await request(app).post(`/api/matches/${match.id}/start`).set("x-admin-key", keyOf(links.admin));
    await MatchModel.updateOne({ _id: match.id }, { $set: { endsAt: new Date(Date.now() - 1000) } });
    const late = await request(app).post(`/api/matches/${match.id}/submit`).set("x-player-token", tokenOf(links.a)).send({ code: "" });
    expect(late.status).toBe(409);
    await endMatch(match.id);
  }, 60_000);
});

describe("hidden target", () => {
  it("hides the target from the public match until the start, but not from the host", async () => {
    const { match, links } = await newMatch();
    expect(match.challenge).toBeNull();
    const pub = await request(app).get(`/api/matches/${match.id}`);
    expect(pub.body.challenge).toBeNull();
    expect(JSON.stringify(pub.body)).not.toMatch(/files\/targets/);
    expect(pub.body.starterCode).toContain("<div");
    const host = await request(app).get(`/api/matches/${match.id}/admin`).set("x-admin-key", keyOf(links.admin));
    expect(host.body.challenge.targetUrl).toMatch(/files\/targets/);
    const stranger = await request(app).get(`/api/matches/${match.id}/admin`).set("x-admin-key", "nope");
    expect(stranger.body.challenge).toBeNull();
    const started = await request(app).post(`/api/matches/${match.id}/start`).set("x-admin-key", keyOf(links.admin));
    expect(started.body.challenge.targetUrl).toMatch(/files\/targets/);
  });
});

describe("server-scored snapshots", () => {
  it("scores the image itself, only while live, and throttles", async () => {
    const { match, links } = await newMatch();
    const m = (await loadMatch(match.id))!;
    const target = await fsp.readFile(targetPath(m.challenge));
    const perfect = `data:image/png;base64,${target.toString("base64")}`;
    // Lobby: no score, so the hidden target can't be probed.
    expect(await scoreSnapshot(match.id, "A", m.challenge, perfect)).toBeNull();
    await request(app).post(`/api/matches/${match.id}/start`).set("x-admin-key", keyOf(links.admin));
    expect(await scoreSnapshot(match.id, "A", m.challenge, perfect)).toBe(100);
    expect(await scoreSnapshot(match.id, "A", m.challenge, perfect)).toBeNull(); // throttled
    const wrongSize = (await import("sharp")).default({ create: { width: 10, height: 10, channels: 3, background: "#fff" } });
    const small = `data:image/png;base64,${(await wrongSize.png().toBuffer()).toString("base64")}`;
    expect(await scoreSnapshot(match.id, "B", m.challenge, small)).toBeNull();
    await new Promise((r) => setTimeout(r, 550));
    expect(await scoreSnapshot(match.id, "B", m.challenge, "data:text/html;base64,PGI+")).toBeNull();
    await endMatch(match.id);
    await new Promise((r) => setTimeout(r, 550));
    expect(await scoreSnapshot(match.id, "A", m.challenge, perfect)).toBeNull(); // finished
  }, 60_000);
});

describe("uploads", () => {
  it("stores SVG avatars as PNG", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10"/></svg>`;
    const res = await request(app).post("/api/uploads/avatar").attach("file", Buffer.from(svg), { filename: "a.svg", contentType: "image/svg+xml" });
    expect(res.status).toBe(201);
    expect(res.body.url).toMatch(/\.png$/);
    const file = await request(app).get(res.body.url);
    expect(file.headers["content-type"]).toBe("image/png");
    expect(file.headers["content-security-policy"]).toContain("sandbox");
  });

  it("answers oversized uploads with 413", async () => {
    const res = await request(app).post("/api/uploads/avatar").attach("file", Buffer.alloc(6 * 1024 * 1024), { filename: "big.png", contentType: "image/png" });
    expect(res.status).toBe(413);
  });

  it("rate-limits uploads per IP", async () => {
    let status = 0;
    for (let i = 0; i < 40 && status !== 429; i++) status = (await request(app).post("/api/uploads/avatar")).status;
    expect(status).toBe(429);
    const res = await request(app).post("/api/uploads/avatar");
    expect(res.body.error).toMatch(/Too many uploads/);
  });
});
