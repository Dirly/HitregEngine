import { test } from "node:test";
import assert from "node:assert/strict";
import { blankUv, blankUvFault, unpaintedAt } from "../tools/_prop-blank-uv.mts";
import { flipRows } from "../tools/_prop-make.mts";
import type { PixelPage, PropGeometry, TexInfo, Tri } from "../tools/_prop-geometry.mts";

/** A 32 x 32 page: the TOP half painted (noisy red stone), the bottom half an empty atlas cell (flat white). */
function page(bottom: [number, number, number, number] = [255, 255, 255, 255]): PixelPage {
  const W = 32, H = 32, data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, n = (x * 7 + y * 13) % 23;
    if (y < H / 2) data.set([150 + n, 60 + n, 40 + n, 255], i);
    else data.set(bottom, i);
  }
  return { width: W, height: H, data };
}
/** One 1 x 1 m quad whose UVs cover v 0.05..0.45 (the top rows of a glTF page). */
function quad(tex: TexInfo): PropGeometry {
  const uv = (u: number, v: number): [number, number] => [u, v];
  const tris: Tri[] = [
    { a: [0, 0, 0], b: [1, 0, 0], c: [1, 1, 0], uv: [uv(0.05, 0.45), uv(0.95, 0.45), uv(0.95, 0.05)], tex },
    { a: [0, 0, 0], b: [1, 1, 0], c: [0, 1, 0], uv: [uv(0.05, 0.45), uv(0.95, 0.05), uv(0.05, 0.05)], tex },
  ];
  return { tris, min: [0, 0, 0], max: [1, 1, 0], effects: [], lights: 0, nested: [], warnings: [] };
}
const tex = (flipY: boolean): TexInfo => ({ key: "page.png", size: [32, 32], repeat: [1, 1], flipY });

test("a glTF page read the glTF way lands on paint", () => {
  const img = page();
  const r = blankUv(quad(tex(false)), { pixels: () => img });
  assert.equal(r.share, 0);
  assert.equal(blankUvFault(r), null);
});

test("the same page as an engine material map (flipY) samples the blank half: the strand well's white roof", () => {
  const img = page();
  const r = blankUv(quad(tex(true)), { pixels: () => img });
  assert.ok(r.share > 0.95, `share ${r.share}`);
  assert.equal(r.islands.length, 1);
  assert.equal(r.islands[0]!.kind, "white");
  assert.match(blankUvFault(r)!, /^blank-uv: 100% /);
});

test("black padding and clear texels are unpainted too (the near-black trough)", () => {
  for (const [bottom, kind] of [[[0, 0, 0, 255], "black"], [[90, 90, 90, 0], "clear"]] as const) {
    const img = page([...bottom] as [number, number, number, number]);
    const r = blankUv(quad(tex(true)), { pixels: () => img });
    assert.equal(r.islands[0]?.kind, kind);
    assert.ok(blankUvFault(r));
  }
});

test("flipping the page (what props variant now does for a glTF-laid-out art page) lands the flipY map back on paint", () => {
  const img = page(), flipped = { ...img, data: flipRows(img) };
  const r = blankUv(quad(tex(true)), { pixels: () => flipped });
  assert.equal(r.share, 0);
});

test("painted white and painted black are not blank: only FLAT white/black/clear is", () => {
  const W = 8, H = 8, data = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { const n = (i * 5) % 9; data.set([246 + n, 246 + n, 246 + n, 255], i * 4); }
  assert.equal(unpaintedAt({ width: W, height: H, data }, 4, 4), null);
  data.fill(255);
  assert.equal(unpaintedAt({ width: W, height: H, data }, 4, 4), "white");
});

test("a world-projected material is not judged on its UVs", () => {
  const img = page();
  const r = blankUv(quad(tex(true)), { pixels: () => img, projected: () => 40 });
  assert.equal(r.texturedArea, 0);
  assert.equal(blankUvFault(r), null);
});

test("a cut-out's holes are not blank; an island that is ALL clear is (it draws nothing)", () => {
  // left half of every row clear (a web's holes), right half painted
  const W = 32, H = 32, data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data.set(x < W / 2 ? [0, 0, 0, 0] : [120 + ((x * 7 + y * 3) % 17), 110, 90, 255], (y * W + x) * 4);
  const img = { width: W, height: H, data };
  const holes = blankUv(quad(tex(false)), { pixels: () => img });
  assert.equal(blankUvFault(holes), null, `share ${holes.share}`);
  const allClear = { width: W, height: H, data: new Uint8Array(W * H * 4) };
  assert.ok(blankUvFault(blankUv(quad(tex(false)), { pixels: () => allClear })));
});

test("a flat black cell enclosed among painted cells is deliberate paint (a jar mouth), black padding at the border is not", () => {
  const W = 32, H = 32, data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data.set([150 + ((x * 7 + y * 13) % 23), 70, 50, 255], (y * W + x) * 4);
  for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) data.set([0, 0, 0, 255], (y * W + x) * 4);
  const img = { width: W, height: H, data };
  assert.equal(unpaintedAt(img, 15, 15), null);
  for (let x = 0; x < W; x++) data.set([0, 0, 0, 255], (12 * W + x) * 4); // a black row joins the cell to the border
  const joined = { width: W, height: H, data };
  assert.equal(unpaintedAt(joined, 15, 15), "black");
});
