// texture-swatch: a lone solid mark on a tile (the Hagsheer lichen clover that repeated into rows of plus signs) is a
// MOTIF; an even texture or one with many small highlights is not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { motifScore, tileSwatch } from "../tools/texture-swatch.mjs";

function tile(paint: (x: number, y: number) => number, n = 64) {
  const px = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const v = paint(x, y), i = (y * n + x) * 4; px[i] = px[i + 1] = px[i + 2] = v; px[i + 3] = 255; }
  return px;
}

test("a lone pale blob on a grey tile is a motif", () => {
  const px = tile((x, y) => ((x - 32) ** 2 + (y - 32) ** 2 < 25 ? 230 : 100 + ((x * 7 + y * 13) % 9)));
  assert.ok(motifScore(64, 64, px).score >= 1);
});

test("an even tile and a tile of many small highlights are not", () => {
  assert.equal(motifScore(64, 64, tile((x, y) => 100 + ((x * 7 + y * 13) % 9))).score, 0);
  assert.equal(motifScore(64, 64, tile((x, y) => (x % 8 < 3 && y % 8 < 3 ? 230 : 100))).score, 0);
});

test("tileSwatch repeats the tile n x n", () => {
  const px = tile((x) => x * 4, 4);
  const sw = tileSwatch(4, 4, px, 3);
  assert.equal(sw.width, 12);
  assert.equal(sw.rgba[(0 * 12 + 5) * 4], px[1 * 4]);
});
