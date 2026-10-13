import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type { Region } from "../contracts.js";

/**
 * Progress from a blank canvas toward the target: a blank canvas scores 0,
 * a pixel-perfect render 100, and anything worse than blank is clamped to 0.
 */
export function scoreFromDiff(diffPixels: number, baselinePixels: number): number {
  const score = (1 - diffPixels / Math.max(baselinePixels, 1)) * 100;
  return Math.round(Math.max(0, Math.min(100, score)) * 10) / 10;
}

const MATCH_OPTIONS: Parameters<typeof pixelmatch>[5] = {
  threshold: 0.1,
  alpha: 0.15,
  diffColor: [236, 0, 140],
  aaColor: [236, 0, 140],
  includeAA: true,
};

const baselineCache = new Map<string, number>();

/** Pixels a blank white canvas gets wrong against this target (cached per key). */
export function blankBaseline(target: Buffer, cacheKey?: string): number {
  if (cacheKey && baselineCache.has(cacheKey)) return baselineCache.get(cacheKey)!;
  const t = PNG.sync.read(target);
  const white = Buffer.alloc(t.width * t.height * 4, 255);
  const n = pixelmatch(t.data, white, null, t.width, t.height, MATCH_OPTIONS);
  if (cacheKey) baselineCache.set(cacheKey, n);
  return n;
}

// ---- Structure and colour scores --------------------------------------------
// The pixel diff alone punishes anything that isn't pixel-exact: one wrong
// background colour or a card 10 px off scores worse than a blank canvas. So the
// final score blends three questions:
//   structure — are the elements there, roughly where the target has them?
//               Compares edge maps (outlines, glyphs, shapes), so it ignores
//               fill and background colours, and gives graded credit for
//               elements that are close but not exactly in place.
//   pixel     — how close to pixel-exact is it? (scoreFromDiff)
//   color     — are the colours, background included, right per area?
// Mirrored in frontend/lib/diff.ts — keep in sync.

export const STRUCTURE_WEIGHT = 0.5;
export const PIXEL_WEIGHT = 0.3;
export const COLOR_WEIGHT = 0.2;
/** RGB distance between neighbouring pixels that counts as an edge */
const EDGE_DISTANCE = 16;
/** Edges within this many px of a matching edge get full credit */
const FULL_CREDIT_PX = 3;
/** Credit falls off linearly to 0 over this many px beyond FULL_CREDIT_PX */
const MAX_SHIFT_PX = 40;
/** Render edges beyond this multiple of the target's are penalised (scribbling doesn't pay) */
const EDGE_EXCESS = 2;
/** Colour is compared per COLOR_GRID × COLOR_GRID cell */
const COLOR_GRID = 20;
/** RGB distance between cell means at which a cell earns no colour credit */
const COLOR_TOLERANCE = 80;

type Pixels = ArrayLike<number>;
const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp100 = (n: number) => round1(Math.max(0, Math.min(100, n)));

/** 1 where a pixel differs from its right or bottom neighbour by more than EDGE_DISTANCE. */
function edgeMask(d: Pixels, w: number, h: number) {
  const m = new Uint8Array(w * h);
  const t = EDGE_DISTANCE * EDGE_DISTANCE;
  let count = 0;
  const far = (i: number, j: number) => {
    const dr = d[i] - d[j], dg = d[i + 1] - d[j + 1], db = d[i + 2] - d[j + 2];
    return dr * dr + dg * dg + db * db > t;
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x, i = p * 4;
      if ((x + 1 < w && far(i, i + 4)) || (y + 1 < h && far(i, i + w * 4))) { m[p] = 1; count++; }
    }
  return { m, count };
}

const FAR = 1 << 28;

/** Chamfer (3-4) distance to the nearest set pixel, in thirds of a px. */
function distanceTo(m: Uint8Array, w: number, h: number) {
  const d = new Int32Array(w * h);
  for (let p = 0; p < d.length; p++) d[p] = m[p] ? 0 : FAR;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      let v = d[p];
      if (x > 0) v = Math.min(v, d[p - 1] + 3);
      if (y > 0) {
        v = Math.min(v, d[p - w] + 3);
        if (x > 0) v = Math.min(v, d[p - w - 1] + 4);
        if (x + 1 < w) v = Math.min(v, d[p - w + 1] + 4);
      }
      d[p] = v;
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const p = y * w + x;
      let v = d[p];
      if (x + 1 < w) v = Math.min(v, d[p + 1] + 3);
      if (y + 1 < h) {
        v = Math.min(v, d[p + w] + 3);
        if (x + 1 < w) v = Math.min(v, d[p + w + 1] + 4);
        if (x > 0) v = Math.min(v, d[p + w - 1] + 4);
      }
      d[p] = v;
    }
  return d;
}

/** 1 for an edge in place, falling to 0 at MAX_SHIFT_PX beyond FULL_CREDIT_PX. */
const credit = (thirds: number) => Math.max(0, Math.min(1, 1 - (thirds / 3 - FULL_CREDIT_PX) / MAX_SHIFT_PX));

export interface StructureTarget {
  w: number;
  h: number;
  edges: Uint8Array;
  edgeCount: number;
  dist: Int32Array;
}

export function prepareStructure(t: Pixels, w: number, h: number): StructureTarget {
  const { m, count } = edgeMask(t, w, h);
  return { w, h, edges: m, edgeCount: count, dist: distanceTo(m, w, h) };
}

/**
 * 0–100: recall (target edges matched) × precision (render edges that belong),
 * each with credit decaying by distance. Null when the target has no edges.
 */
export function structureScore(st: StructureTarget, r: Pixels): number | null {
  if (!st.edgeCount) return null;
  const { m, count } = edgeMask(r, st.w, st.h);
  if (!count) return 0;
  const rDist = distanceTo(m, st.w, st.h);
  let recall = 0, precision = 0;
  for (let p = 0; p < m.length; p++) {
    if (st.edges[p]) recall += credit(rDist[p]);
    if (m[p]) precision += credit(st.dist[p]);
  }
  const excess = Math.min(1, (EDGE_EXCESS * st.edgeCount) / count);
  return clamp100((recall / st.edgeCount) * (precision / count) * excess * 100);
}

function cellMeans(d: Pixels, w: number, h: number) {
  const cols = Math.ceil(w / COLOR_GRID), rows = Math.ceil(h / COLOR_GRID);
  const sums = new Float64Array(cols * rows * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = (Math.floor(y / COLOR_GRID) * cols + Math.floor(x / COLOR_GRID)) * 4, i = (y * w + x) * 4;
      sums[c] += d[i]; sums[c + 1] += d[i + 1]; sums[c + 2] += d[i + 2]; sums[c + 3]++;
    }
  const means = new Float32Array(cols * rows * 3);
  for (let c = 0; c < cols * rows; c++)
    for (let k = 0; k < 3; k++) means[c * 3 + k] = sums[c * 4 + k] / sums[c * 4 + 3];
  return means;
}

function colorRaw(target: Float32Array, render: Float32Array) {
  let sum = 0;
  const cells = target.length / 3;
  for (let c = 0; c < cells; c++) {
    const i = c * 3;
    const dist = Math.hypot(target[i] - render[i], target[i + 1] - render[i + 1], target[i + 2] - render[i + 2]);
    sum += Math.max(0, 1 - dist / COLOR_TOLERANCE);
  }
  return sum / cells;
}

export interface ColorTarget {
  w: number;
  h: number;
  means: Float32Array;
  /** Zero point: the better of a blank (white) or black canvas */
  floorRaw: number;
}

export function prepareColor(t: Pixels, w: number, h: number): ColorTarget {
  const means = cellMeans(t, w, h);
  const flat = (v: number) => new Float32Array(means.length).fill(v);
  return { w, h, means, floorRaw: Math.max(colorRaw(means, flat(255)), colorRaw(means, flat(0))) };
}

/** 0–100, where a blank canvas scores 0. Null when a blank canvas already matches. */
export function colorScore(ct: ColorTarget, r: Pixels): number | null {
  if (ct.floorRaw >= 0.999) return null;
  return clamp100(((colorRaw(ct.means, cellMeans(r, ct.w, ct.h)) - ct.floorRaw) / (1 - ct.floorRaw)) * 100);
}

export interface ScoreParts {
  pixel: number;
  structure: number | null;
  color: number | null;
}

/** Weighted blend; a null part drops out and the rest are reweighted. */
export function combineScores({ pixel, structure, color }: ScoreParts): number {
  let total = PIXEL_WEIGHT * pixel, weight = PIXEL_WEIGHT;
  if (structure !== null) { total += STRUCTURE_WEIGHT * structure; weight += STRUCTURE_WEIGHT; }
  if (color !== null) { total += COLOR_WEIGHT * color; weight += COLOR_WEIGHT; }
  return round1(total / weight);
}

/** Structure and colour data for a target, from its raw RGBA pixels. */
export interface ScoringTarget {
  structure: StructureTarget;
  color: ColorTarget;
}

export function prepareScoring(t: Pixels, w: number, h: number): ScoringTarget {
  return { structure: prepareStructure(t, w, h), color: prepareColor(t, w, h) };
}

// ---- Scoring ----------------------------------------------------------------

const scoringTargets = new Map<string, ScoringTarget>();
function scoringTarget(t: Pixels, w: number, h: number, cacheKey?: string) {
  if (!cacheKey) return prepareScoring(t, w, h);
  let st = scoringTargets.get(cacheKey);
  if (!st) scoringTargets.set(cacheKey, (st = prepareScoring(t, w, h)));
  return st;
}

/** Every score part for a render, plus the blended score. */
function scoreParts(t: Pixels, r: Pixels, w: number, h: number, pixel: number, cacheKey?: string) {
  const st = scoringTarget(t, w, h, cacheKey);
  const parts: ScoreParts = { pixel, structure: structureScore(st.structure, r), color: colorScore(st.color, r) };
  return { ...parts, score: combineScores(parts) };
}

const decodedTargets = new Map<string, { data: Buffer; baseline: number }>();

/**
 * Scores raw RGBA pixels against a target PNG without building a diff image.
 * Used for live snapshots, so the decoded target is cached per key.
 */
export function scoreRgba(target: Buffer, cacheKey: string, rgba: Uint8Array, width: number, height: number): number {
  let t = decodedTargets.get(cacheKey);
  if (!t) {
    const png = PNG.sync.read(target);
    t = { data: png.data, baseline: blankBaseline(target, cacheKey) };
    decodedTargets.set(cacheKey, t);
  }
  if (t.data.length !== width * height * 4) throw new Error("Size mismatch");
  const diff = pixelmatch(t.data, rgba, null, width, height, MATCH_OPTIONS);
  return scoreParts(t.data, rgba, width, height, scoreFromDiff(diff, t.baseline), cacheKey).score;
}

export interface DiffOutput {
  /** Weighted blend of structureScore, pixelScore and colorScore */
  score: number;
  pixelScore: number;
  structureScore: number | null;
  colorScore: number | null;
  diffPixels: number;
  diffPng: Buffer;
  regions: Region[];
}

/** Pixel-diffs two equal-size PNGs. Mismatches are painted magenta in diffPng. */
export function diffPngs(target: Buffer, candidate: Buffer, cacheKey?: string): DiffOutput {
  const a = PNG.sync.read(target);
  const b = PNG.sync.read(candidate);
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`Size mismatch: ${a.width}×${a.height} vs ${b.width}×${b.height}`);
  }
  const { width, height } = a;
  const out = new PNG({ width, height });
  const diffPixels = pixelmatch(a.data, b.data, out.data, width, height, MATCH_OPTIONS);
  const pixelScore = scoreFromDiff(diffPixels, blankBaseline(target, cacheKey));
  const parts = scoreParts(a.data, b.data, width, height, pixelScore, cacheKey);
  return {
    score: parts.score,
    pixelScore,
    structureScore: parts.structure,
    colorScore: parts.color,
    diffPixels,
    diffPng: PNG.sync.write(out),
    regions: findRegions(out.data, width, height),
  };
}

const CELL = 20;

/**
 * Groups magenta diff pixels into 20px cells, joins neighbouring hot cells,
 * and returns the largest regions — used for the yellow callouts.
 */
export function findRegions(rgba: Uint8Array | Buffer, width: number, height: number, limit = 3): Region[] {
  const cols = Math.ceil(width / CELL);
  const rows = Math.ceil(height / CELL);
  const counts = new Uint32Array(cols * rows);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (rgba[i] === 236 && rgba[i + 1] === 0 && rgba[i + 2] === 140) {
        counts[Math.floor(y / CELL) * cols + Math.floor(x / CELL)]++;
      }
    }
  }
  const hot = (c: number) => counts[c] > 3;
  const seen = new Uint8Array(cols * rows);
  const regions: (Region & { pixels: number })[] = [];
  for (let start = 0; start < counts.length; start++) {
    if (seen[start] || !hot(start)) continue;
    const stack = [start];
    seen[start] = 1;
    let minC = cols, minR = rows, maxC = 0, maxR = 0, pixels = 0;
    while (stack.length) {
      const c = stack.pop()!;
      const cx = c % cols;
      const cy = Math.floor(c / cols);
      pixels += counts[c];
      minC = Math.min(minC, cx); maxC = Math.max(maxC, cx);
      minR = Math.min(minR, cy); maxR = Math.max(maxR, cy);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const n = ny * cols + nx;
        if (!seen[n] && hot(n)) { seen[n] = 1; stack.push(n); }
      }
    }
    const x = minC * CELL, y = minR * CELL;
    const w = Math.min(width, (maxC + 1) * CELL) - x;
    const h = Math.min(height, (maxR + 1) * CELL) - y;
    regions.push({ x, y, w, h, pixels, density: Math.round((pixels / (w * h)) * 100) / 100 });
  }
  return regions
    .sort((p, q) => q.pixels - p.pixels)
    .slice(0, limit)
    .map(({ pixels: _pixels, ...r }) => r);
}
