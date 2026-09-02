/**
 * Draws the key's island boundaries over a generated sheet, so layout drift is
 * visible rather than inferred from fit percentages.
 *
 * usage: node tools/atlas/overlay.mjs <key.png> <art.png> <out.png> [scale]
 */
import fs from "node:fs";
import { decodePng, encodePng } from "./png.mjs";

const [, , keyPath, artPath, outPath, scaleArg] = process.argv;
const key = decodePng(fs.readFileSync(keyPath));
const art = decodePng(fs.readFileSync(artPath));
const f = Number(scaleArg ?? 2); // downscale factor
const W = key.width;
const H = key.height;
const OW = Math.floor(W / f);
const OH = Math.floor(H / f);

const isBg = (i) => key.data[i * 4] > 245 && key.data[i * 4 + 1] > 245 && key.data[i * 4 + 2] > 245;
const idAt = (i) =>
  isBg(i) ? -1 : (key.data[i * 4] << 16) | (key.data[i * 4 + 1] << 8) | key.data[i * 4 + 2];

// island edge at full res: a pixel whose 4-neighbourhood is not all the same id
const edge = new Uint8Array(W * H);
for (let y = 1; y < H - 1; y++)
  for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    const id = idAt(i);
    if (id < 0) continue;
    if (idAt(i - 1) !== id || idAt(i + 1) !== id || idAt(i - W) !== id || idAt(i + W) !== id) edge[i] = 1;
  }

const out = new Uint8Array(OW * OH * 4);
for (let y = 0; y < OH; y++)
  for (let x = 0; x < OW; x++) {
    const d = (y * OW + x) * 4;
    // box-average the artwork
    let r = 0, g = 0, b = 0, n = 0, onEdge = 0;
    for (let sy = y * f; sy < (y + 1) * f && sy < H; sy++)
      for (let sx = x * f; sx < (x + 1) * f && sx < W; sx++) {
        const s = sy * W + sx;
        r += art.data[s * 4];
        g += art.data[s * 4 + 1];
        b += art.data[s * 4 + 2];
        n++;
        if (edge[s]) onEdge = 1;
      }
    if (onEdge) {
      out[d] = 255; out[d + 1] = 0; out[d + 2] = 255; // island boundary
    } else {
      out[d] = Math.round(r / n); out[d + 1] = Math.round(g / n); out[d + 2] = Math.round(b / n);
    }
    out[d + 3] = 255;
  }

fs.writeFileSync(outPath, encodePng(OW, OH, out));
console.log(`${outPath}  ${OW}x${OH}`);
