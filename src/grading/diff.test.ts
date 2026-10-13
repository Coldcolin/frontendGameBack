import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { PNG } from "pngjs";
import { combineScores, diffPngs, scoreFromDiff } from "./diff.js";
import { sanitizeCode } from "./document.js";

function png(w: number, h: number, paint: (x: number, y: number) => [number, number, number]) {
  const img = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const [r, g, b] = paint(x, y);
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
    }
  return PNG.sync.write(img);
}

describe("scoreFromDiff", () => {
  it("measures progress from a blank canvas", () => {
    expect(scoreFromDiff(0, 1000)).toBe(100);
    expect(scoreFromDiff(1000, 1000)).toBe(0);
    expect(scoreFromDiff(250, 1000)).toBe(75);
  });

  it("clamps renders worse than blank to 0", () => {
    expect(scoreFromDiff(5000, 1000)).toBe(0);
  });
});

describe("diffPngs", () => {
  const white = png(600, 400, () => [255, 255, 255]);
  const block = (x0: number, x1: number) =>
    png(600, 400, (x, y) => (x >= x0 && x < x1 && y >= 40 && y < 80 ? [0, 0, 0] : [255, 255, 255]));
  const target = block(100, 200);

  it("scores a blank canvas 0 even when the target is mostly white", () => {
    expect(diffPngs(target, white).score).toBe(0);
  });

  it("scores an exact match 100 with no regions", () => {
    const r = diffPngs(target, target);
    expect(r.score).toBe(100);
    expect(r.regions).toHaveLength(0);
  });

  it("rewards partial progress", () => {
    const r = diffPngs(target, block(100, 150));
    expect(r.pixelScore).toBeCloseTo(50, 0);
    expect(r.score).toBeGreaterThan(0);
  });

  it("gives a slightly misplaced element most of the structure credit", () => {
    const r = diffPngs(target, block(110, 210));
    expect(r.structureScore).toBeGreaterThan(70);
    expect(r.score).toBeGreaterThan(r.pixelScore);
  });

  it("gives an element far from its place no structure credit", () => {
    expect(diffPngs(target, block(400, 500)).structureScore).toBe(0);
  });

  it("finds the mismatched block as a region", () => {
    expect(diffPngs(white, target).regions[0]).toMatchObject({ x: 100, y: 40, w: 100, h: 40 });
  });

  it("rejects mismatched sizes", () => {
    expect(() => diffPngs(white, png(10, 10, () => [0, 0, 0]))).toThrow(/Size mismatch/);
  });
});

describe("structure and colour scores", () => {
  const fixture = (name: string) => fs.readFileSync(new URL(`./fixtures/${name}.png`, import.meta.url));
  const solid = (c: [number, number, number]) => png(600, 400, () => c);
  const fills: [number, number, number][] = [[0, 0, 0], [255, 255, 255], [128, 128, 128], [30, 30, 30], [60, 20, 90], [14, 114, 237]];
  // Mostly dark with light content everywhere, like an app screenshot.
  const dense = png(600, 400, (x, y) =>
    x % 150 < 140 && y % 100 > 70 ? [235, 235, 235] : x % 150 < 140 && y % 100 > 40 ? [88, 28, 135] : [20, 20, 24]);
  const card = (bg: [number, number, number]) =>
    png(600, 400, (x, y) => (x >= 150 && x < 450 && y >= 50 && y < 350 ? (y >= 280 && y < 320 ? [15, 23, 42] : [255, 255, 255]) : bg));

  it("credits a near-complete attempt with the wrong background colour", () => {
    // Real final renders from a match where both scored 0 and tied: the
    // attempt has every element, slightly off, on a gray instead of slate-50
    // background; the other player never touched the starter.
    const target = fixture("pricing-target");
    const partial = diffPngs(target, fixture("pricing-partial"));
    const blank = diffPngs(target, fixture("pricing-blank"));
    expect(partial.pixelScore).toBe(0);
    expect(partial.structureScore).toBeGreaterThanOrEqual(40);
    expect(partial.score).toBeGreaterThan(20);
    expect(blank.score).toBe(0);
  });

  it("gives a close but not pixel-exact attempt credit over a blank canvas", () => {
    const target = fixture("meetings-target");
    const partial = diffPngs(target, fixture("meetings-partial"));
    const blank = diffPngs(target, fixture("meetings-blank"));
    expect(partial.pixelScore).toBe(0);
    expect(partial.score).toBeGreaterThan(blank.score);
    expect(blank.score).toBe(0);
  });

  it("gives flat fills no structure credit", () => {
    for (const t of [fixture("meetings-target"), fixture("pricing-target"), dense])
      for (const c of fills) expect(diffPngs(t, solid(c)).structureScore).toBeLessThanOrEqual(2);
  });

  it("gives random noise little credit", () => {
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) % 256);
    const noise = png(600, 400, () => [rand(), rand(), rand()]);
    for (const t of [fixture("meetings-target"), fixture("pricing-target"), dense])
      expect(diffPngs(t, noise).score).toBeLessThanOrEqual(10);
  });

  it("scores the right layout on the wrong background high on structure, lower on colour", () => {
    const target = card([241, 245, 249]);
    const exact = diffPngs(target, target);
    const wrongBg = diffPngs(target, card([209, 213, 219]));
    expect(wrongBg.structureScore).toBeGreaterThan(80);
    expect(wrongBg.colorScore!).toBeLessThan(exact.colorScore!);
    expect(wrongBg.score).toBeLessThan(exact.score);
    expect(wrongBg.score).toBeGreaterThan(40);
  });

  it("scores an exact match 100 on a dense target", () => {
    expect(diffPngs(dense, dense).score).toBe(100);
  });

  it("drops parts that can't be measured and reweights the rest", () => {
    expect(combineScores({ pixel: 42, structure: null, color: null })).toBe(42);
    expect(combineScores({ pixel: 40, structure: 80, color: null })).toBe(65);
    expect(combineScores({ pixel: 0, structure: 90, color: 0 })).toBe(45);
  });
});

describe("sanitizeCode", () => {
  it("strips scripts, handlers and javascript urls", () => {
    const out = sanitizeCode(`<div onclick="steal()"><script>alert(1)</script><a href="javascript:x()">x</a><iframe src="//e"></iframe></div>`);
    expect(out).not.toMatch(/script|onclick|javascript:|iframe/i);
    expect(out).toContain("<div>");
  });

  it("keeps plain CSS", () => {
    const css = `<style>.box{width:100px;background:#00aeef}</style><div class="box" style="height:50px"></div>`;
    expect(sanitizeCode(css)).toBe(css);
  });
});
