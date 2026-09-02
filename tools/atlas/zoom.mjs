// Nearest-neighbour zoom / crop helper for eyeballing atlas output.
// usage: node tools/atlas/zoom.mjs <in.png> <out.png> <factor> [x y w h]
import fs from "node:fs";
import { decodePng, encodePng } from "./png.mjs";

const [, , inPath, outPath, factorArg, xArg, yArg, wArg, hArg] = process.argv;
const f = Number(factorArg ?? 4);
const img = decodePng(fs.readFileSync(inPath));
const x0 = Number(xArg ?? 0);
const y0 = Number(yArg ?? 0);
const cw = Number(wArg ?? img.width - x0);
const ch = Number(hArg ?? img.height - y0);

const W = cw * f;
const H = ch * f;
const out = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const s = ((y0 + ((y / f) | 0)) * img.width + (x0 + ((x / f) | 0))) * 4;
    const d = (y * W + x) * 4;
    out[d] = img.data[s];
    out[d + 1] = img.data[s + 1];
    out[d + 2] = img.data[s + 2];
    out[d + 3] = img.data[s + 3];
  }
fs.writeFileSync(outPath, encodePng(W, H, out));
console.log(`${outPath}  ${W}x${H}`);
