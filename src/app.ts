import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import { z } from "zod";
import { nanoid } from "nanoid";
import fs from "node:fs/promises";
import path from "node:path";
import { config, corsOrigin, storagePaths } from "./config.js";
import { ChallengeModel } from "./models.js";
import { createImageChallenge, toChallengeDTO } from "./services/challenges.js";
import { normalizeAvatar } from "./grading/renderer.js";
import {
  createMatch, finalSubmissions, HttpError, loadMatch, startMatch, submit, tokenMatches, toMatchDTO,
} from "./services/matches.js";
import type { CreateMatchResponse } from "./contracts.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    cb(null, ["image/png", "image/svg+xml", "image/jpeg", "image/webp"].includes(file.mimetype)),
});

const createMatchBody = z.object({
  challengeId: z.string().regex(/^[a-f0-9]{24}$/i, "Pick a target."),
  durationSec: z.number().int().min(10).max(3600),
  players: z
    .array(
      z.object({
        name: z.string().trim().min(1, "Enter a name for each contender.").max(40),
        handle: z.string().trim().max(40).optional(),
        avatarUrl: z.string().startsWith("/files/uploads/").optional(),
      }),
    )
    .length(2),
});

const submitBody = z.object({ code: z.string().max(100_000) });

const limiter = (limit: number, error: string) =>
  rateLimit({ windowMs: 15 * 60_000, limit, standardHeaders: "draft-8", legacyHeaders: false, message: { error } });

export function createApp() {
  const app = express();
  if (config.trustProxy) app.set("trust proxy", config.trustProxy);
  app.use(cors({ origin: corsOrigin }));
  app.use("/api", limiter(config.rateLimits.api, "Too many requests. Wait a few minutes and try again."));
  const uploadLimit = limiter(config.rateLimits.uploads, "Too many uploads. Wait a few minutes and try again.");
  const matchLimit = limiter(config.rateLimits.matches, "Too many matches created. Wait a few minutes and try again.");
  app.use(express.json({ limit: "512kb" }));
  app.use(
    "/files",
    express.static(config.storageDir, {
      maxAge: "1h",
      fallthrough: false,
      // Files are only ever images; never let one run as a document on this origin.
      setHeaders: (res) => {
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
        res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      },
    }),
  );

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/challenges", async (_req, res) => {
    const list = await ChallengeModel.find({ builtIn: true }).sort({ createdAt: 1 });
    res.json(list.map(toChallengeDTO));
  });

  app.post("/api/challenges", uploadLimit, upload.single("file"), async (req, res) => {
    if (!req.file) throw new HttpError(400, "Upload a PNG, JPG, WebP or SVG under 5 MB.");
    const title = String(req.body.title ?? "").trim() || req.file.originalname.replace(/\.[^.]+$/, "");
    const challenge = await createImageChallenge(title.slice(0, 60), req.file.buffer);
    res.status(201).json(toChallengeDTO(challenge));
  });

  app.post("/api/uploads/avatar", uploadLimit, upload.single("file"), async (req, res) => {
    if (!req.file) throw new HttpError(400, "Upload a PNG, JPG, WebP or SVG under 5 MB.");
    // Rasterised so no uploaded SVG (which can carry script) is ever served back.
    const name = `${nanoid(12)}.png`;
    const png = await normalizeAvatar(req.file.buffer).catch(() => {
      throw new HttpError(400, "That image couldn't be read. Try a PNG or JPG.");
    });
    await fs.writeFile(path.join(storagePaths.uploads, name), png);
    res.status(201).json({ url: `/files/uploads/${name}` });
  });

  app.post("/api/matches", matchLimit, async (req, res) => {
    const body = createMatchBody.parse(req.body);
    const { id, links } = await createMatch(body);
    const match = await loadMatch(id);
    const response: CreateMatchResponse = { match: toMatchDTO(match!), links };
    res.status(201).json(response);
  });

  app.get("/api/matches/:id", async (req, res) => {
    const m = await loadMatch(req.params.id);
    if (!m) throw new HttpError(404, "Match not found.");
    res.json(toMatchDTO(m));
  });

  app.get("/api/matches/:id/admin", async (req, res) => {
    const m = await loadMatch(req.params.id);
    if (!m) throw new HttpError(404, "Match not found.");
    const valid = tokenMatches(req.header("x-admin-key"), m.adminKeyHash);
    // The host may preview the target before the start; the public match hides it.
    res.json({ valid, challenge: valid ? toChallengeDTO(m.challenge) : null });
  });

  app.post("/api/matches/:id/start", async (req, res) => {
    const m = await startMatch(req.params.id, req.header("x-admin-key"));
    res.json(toMatchDTO(m));
  });

  app.post("/api/matches/:id/submit", async (req, res) => {
    const { code } = submitBody.parse(req.body);
    res.json(await submit(req.params.id, req.header("x-player-token"), code));
  });

  app.get("/api/matches/:id/results", async (req, res) => {
    const m = await loadMatch(req.params.id);
    if (!m) throw new HttpError(404, "Match not found.");
    res.json({ match: toMatchDTO(m), finals: await finalSubmissions(m.id) });
  });

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: err.issues[0]?.message ?? "Check the form and try again." });
    } else if (err instanceof multer.MulterError) {
      const tooBig = err.code === "LIMIT_FILE_SIZE";
      res.status(tooBig ? 413 : 400).json({ error: tooBig ? "Upload a PNG, JPG, WebP or SVG under 5 MB." : "Upload one image file." });
    } else if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
    } else if (err?.code === "ENOENT") {
      res.status(404).json({ error: "File not found." });
    } else {
      console.error(err);
      res.status(500).json({ error: "The server hit an error. Try again." });
    }
  };
  app.use(onError);
  return app;
}
