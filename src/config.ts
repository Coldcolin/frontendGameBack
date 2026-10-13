import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: Number(process.env.PORT ?? 4000),
  mongoUri: process.env.MONGODB_URI ?? "",
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
  storageDir: path.resolve(here, "..", process.env.STORAGE_DIR ?? "storage"),
  canvas: { width: 600, height: 400 },
  submitCooldownMs: 5000,
  /** Concurrent Chromium pages for grading; use 1 on small (512 MB) instances */
  /** Proxy hops in front of the app (1 on Render) so rate limits see the real client IP */
  trustProxy: Number(process.env.TRUST_PROXY ?? 0),
  /** Requests per IP per 15 minutes */
  rateLimits: {
    matches: Number(process.env.RATE_LIMIT_MATCHES ?? 30),
    uploads: Number(process.env.RATE_LIMIT_UPLOADS ?? 30),
    api: Number(process.env.RATE_LIMIT_API ?? 1500),
  },
  maxRenderPages: Math.max(1, Number(process.env.MAX_RENDER_PAGES ?? 2)),
};

// WEB_ORIGIN may list several origins (comma-separated). WEB_ORIGIN_PATTERN is an
// optional regex for preview deploys, e.g. ^https://diffarena-[a-z0-9-]+\.vercel\.app$
const origins = config.webOrigin.split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean);
const originPattern = process.env.WEB_ORIGIN_PATTERN ? new RegExp(process.env.WEB_ORIGIN_PATTERN) : null;
export const corsOrigin: (string | RegExp)[] = originPattern ? [...origins, originPattern] : origins;

export const storagePaths = {
  targets: path.join(config.storageDir, "targets"),
  uploads: path.join(config.storageDir, "uploads"),
  diffs: path.join(config.storageDir, "diffs"),
};
