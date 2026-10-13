import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { storagePaths } from "../config.js";
import type { ChallengeDTO } from "../contracts.js";
import { ChallengeModel, type ChallengeDoc } from "../models.js";
import { builtInChallenges, uploadStarter } from "../seedChallenges.js";
import { normalizeImage, renderCode } from "../grading/renderer.js";

export async function ensureStorage() {
  await Promise.all(Object.values(storagePaths).map((p) => fs.mkdir(p, { recursive: true })));
}

/** 2× copy for display only; grading always uses the 1× file. */
const displayFile = (targetFile: string) => targetFile.replace(/\.png$/, "@2x.png");

const exists = (p: string) => fs.access(p).then(() => true, () => false);

/** Upserts built-in challenges and renders any missing target PNGs. */
export async function seedChallenges() {
  for (const c of builtInChallenges) {
    const targetFile = `${c.slug}.png`;
    const file = path.join(storagePaths.targets, targetFile);
    const existing = await ChallengeModel.findOne({ slug: c.slug });
    const htmlChanged = existing?.html !== c.html;
    const retina = path.join(storagePaths.targets, displayFile(targetFile));
    if (htmlChanged || !(await exists(file)) || !(await exists(retina))) {
      await fs.writeFile(file, await renderCode(c.html));
      await fs.writeFile(retina, await renderCode(c.html, 2));
    }
    await ChallengeModel.updateOne(
      { slug: c.slug },
      { $set: { ...c, kind: "html", targetFile, builtIn: true } },
      { upsert: true },
    );
  }
}

export async function createImageChallenge(title: string, upload: Buffer) {
  const slug = `upload-${nanoid(8).toLowerCase()}`;
  const targetFile = `${slug}.png`;
  await fs.writeFile(path.join(storagePaths.targets, targetFile), await normalizeImage(upload));
  await fs.writeFile(path.join(storagePaths.targets, displayFile(targetFile)), await normalizeImage(upload, 2));
  return ChallengeModel.create({ slug, title, kind: "image", targetFile, starterCode: uploadStarter });
}

export function targetPath(c: Pick<ChallengeDoc, "targetFile">) {
  return path.join(storagePaths.targets, c.targetFile);
}

export function toChallengeDTO(c: ChallengeDoc): ChallengeDTO {
  return {
    id: c.id,
    slug: c.slug,
    title: c.title,
    kind: c.kind as ChallengeDTO["kind"],
    targetUrl: `/files/targets/${c.targetFile}`,
    displayUrl: `/files/targets/${displayFile(c.targetFile)}`,
    starterCode: c.starterCode ?? "",
  };
}
