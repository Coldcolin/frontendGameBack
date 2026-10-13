import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import sharp from "sharp";
import { chromium, type Browser } from "playwright";
import { config } from "../config.js";
import { renderDocument } from "./document.js";

const require = createRequire(import.meta.url);
let runtime: string | null = null;
let browserPromise: Promise<Browser> | null = null;
let active = 0;
const queue: (() => void)[] = [];
const MAX_PAGES = config.maxRenderPages;

async function tailwindRuntime() {
  runtime ??= await fs.readFile(require.resolve("@tailwindcss/browser"), "utf8");
  return runtime;
}

function browser() {
  browserPromise ??= chromium.launch({ args: ["--font-render-hinting=none", "--disable-dev-shm-usage", "--no-sandbox"] });
  return browserPromise;
}

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_PAGES) await new Promise<void>((r) => queue.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    queue.shift()?.();
  }
}

/** Renders contender HTML (Tailwind and/or plain CSS) to a 600×400 PNG in a locked-down page. */
export async function renderCode(code: string, scale = 1): Promise<Buffer> {
  const { width, height } = config.canvas;
  const [b, tw] = await Promise.all([browser(), tailwindRuntime()]);
  return withSlot(async () => {
    const context = await b.newContext({ viewport: { width, height }, deviceScaleFactor: scale });
    try {
      await context.route("**/*", (route) => route.abort());
      const page = await context.newPage();
      await page.setContent(renderDocument(code, tw, randomBytes(12).toString("base64")), {
        waitUntil: "load",
      });
      // The Tailwind runtime compiles asynchronously; wait for its stylesheet.
      await page
        .waitForFunction(() => Array.from(document.querySelectorAll("style")).some((s) => s.textContent?.includes("tailwindcss")), null, { timeout: 3000 })
        .catch(() => undefined);
      await page.evaluate(() => document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))));
      return await page.screenshot({ clip: { x: 0, y: 0, width, height }, type: "png" });
    } finally {
      await context.close();
    }
  });
}

/** Normalises an uploaded image to a 600×400 PNG (× scale), contain, white letterbox. */
export async function normalizeImage(input: Buffer, scale = 1): Promise<Buffer> {
  const { width, height } = config.canvas;
  return sharp(input, { density: 144 * scale })
    .resize(width * scale, height * scale, { fit: "contain", background: "#ffffff" })
    .flatten({ background: "#ffffff" })
    .png()
    .toBuffer();
}

/** Square 256 px PNG for avatars (cover crop). */
export async function normalizeAvatar(input: Buffer): Promise<Buffer> {
  return sharp(input, { density: 144 }).resize(256, 256, { fit: "cover" }).png().toBuffer();
}

export async function closeRenderer() {
  if (browserPromise) await (await browserPromise).close();
  browserPromise = null;
}
