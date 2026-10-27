// tools/_png.mjs decodes 1/2/4-bit packed palette and grey PNGs (an image generator wrote a 4-bit palette tile: FIX-HW9)
import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
// @ts-expect-error plain JS module
import { decodePng } from "../tools/_png.mjs";
// @ts-expect-error plain JS module
import { decodePng as decodeWfc } from "../../../tools/wfc-3d/png.mjs"; // the town atlas reads kit/theme tiles with this one (T-R1)

function chunk(type: string, body: Buffer) {
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
  return Buffer.concat([len, Buffer.from(type, "ascii"), body, Buffer.alloc(4)]); // (the decoder does not check CRCs)
}
function png(w: number, h: number, bd: number, colorType: number, rows: number[][], plte?: number[]) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = bd; ihdr[9] = colorType;
  const stride = Math.ceil((w * bd) / 8), raw: number[] = [];
  for (const r of rows) { const line = new Array(stride).fill(0); r.forEach((v, x) => { const bit = x * bd; line[bit >> 3] |= v << (8 - bd - (bit & 7)); }); raw.push(1 /* Sub filter */, ...line.map((b, i) => (b - (i >= 1 ? line[i - 1]! : 0)) & 0xff)); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), ...(plte ? [chunk("PLTE", Buffer.from(plte))] : []), chunk("IDAT", zlib.deflateSync(Buffer.from(raw))), chunk("IEND", Buffer.alloc(0))]);
}

for (const [name, decode] of [["_png", decodePng], ["wfc-3d/png", decodeWfc]] as const) test(`${name}: 4-bit palette and 2-bit grey PNGs decode to RGBA8`, () => {
  const plte = Array.from({ length: 16 }, (_, i) => [i * 16, 255 - i * 16, i]).flat();
  const p = decode(png(5, 2, 4, 3, [[0, 1, 15, 7, 3], [8, 8, 2, 0, 15]], plte));
  assert.equal(p.width, 5);
  assert.deepEqual(Array.from(p.data.slice(8, 12)), [240, 15, 15, 255]); // pixel (2,0) = index 15
  assert.deepEqual(Array.from(p.data.slice(20 + 0, 20 + 4)), [128, 127, 8, 255]); // pixel (0,1) = index 8
  const g = decode(png(3, 1, 2, 0, [[0, 3, 1]]));
  assert.deepEqual([g.data[0], g.data[4], g.data[8]], [0, 255, 85]);
});
