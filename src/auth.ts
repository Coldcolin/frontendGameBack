import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { config } from "./config.js";
import { HttpError } from "./services/matches.js";

const SESSION_MS = 12 * 60 * 60_000;

/** True when ADMIN_PASSWORD is set; without it (dev only) match setup is open. */
export const authEnabled = () => config.adminPassword.length > 0;

const sha = (s: string) => createHash("sha256").update(s).digest();

function safeEqual(a: Buffer, b: Buffer) {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function checkPassword(password: unknown) {
  return typeof password === "string" && authEnabled() && safeEqual(sha(password), sha(config.adminPassword));
}

// Keyed by the password, so changing it signs every host out.
const sign = (payload: string) =>
  createHmac("sha256", sha(`diffarena-host:${config.adminPassword}`)).update(payload).digest("base64url");

/** Stateless host session: `<expiresAtMs>.<hmac>` */
export function issueSession(now = Date.now()) {
  const expiresAt = now + SESSION_MS;
  return { token: `${expiresAt}.${sign(String(expiresAt))}`, expiresAt: new Date(expiresAt).toISOString() };
}

export function verifySession(token: string | undefined, now = Date.now()) {
  if (!authEnabled()) return true;
  const [exp, mac] = token?.split(".") ?? [];
  if (!exp || !mac || !/^\d+$/.test(exp) || Number(exp) <= now) return false;
  return safeEqual(Buffer.from(mac), Buffer.from(sign(exp)));
}

export const bearer = (header: string | undefined) => header?.match(/^Bearer (\S+)$/)?.[1];

/** Only the signed-in host may create matches or upload their images. */
export const requireHost: RequestHandler = (req, _res, next) => {
  if (!verifySession(bearer(req.header("authorization")))) throw new HttpError(401, "Sign in to set up a match.");
  next();
};
