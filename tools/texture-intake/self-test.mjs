/**
 * Self-test for the texture-intake tool. No test framework: tools are
 * self-contained node. Run:  node tools/texture-intake/self-test.mjs
 *
 * Builds a deliberately non-tileable 128px gradient (as an RGB / colorType-2
 * PNG with Sub-filtered rows, to exercise the decoder beyond what encodePng
 * emits), runs run() against a stub host context, and asserts the whole
 * contract: seam deltas collapse with makeSeamless and stay large without,
 * normal map + preview are valid PNGs, and the theme doc gains the new slot
 * while preserving existing ones.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { decodePng } from "./png.mjs";
import { run, measureSeams } from "./run.mjs";

// --- minimal RGB PNG encoder (colorType 2, Sub filter) ---------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, body) => {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "ascii");
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
};
function encodeRgbSub(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit, colorType 2 (RGB)
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const rowAt = y * (stride + 1);
    raw[rowAt] = 1; // Sub filter
    for (let x = 0; x < stride; x++) {
      const cur = rgb[y * stride + x];
      const left = x >= 3 ? rgb[y * stride + x - 3] : 0;
      raw[rowAt + 1 + x] = (cur - left) & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- fixture: 128px gradient — maximally non-tileable ----------------------

const SIZE = 128;
const rgb = Buffer.alloc(SIZE * SIZE * 3);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 3;
    rgb[i] = Math.round((x / (SIZE - 1)) * 255); // ramps 0 -> 255 left to right
    rgb[i + 1] = Math.round((y / (SIZE - 1)) * 255); // ramps top to bottom
    rgb[i + 2] = 128;
  }
}
const imageB64 = encodeRgbSub(SIZE, SIZE, rgb).toString("base64");

// --- stub host context ------------------------------------------------------

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "texture-intake-selftest-"));
const runsRoot = path.join(tempRoot, ".hitreg", "tool-runs");
const written = new Map();
function makeContext(runName) {
  const runDir = path.join(runsRoot, runName);
  fs.mkdirSync(runDir, { recursive: true });
  return {
    runDir,
    writeAsset(file, data) {
      assert.ok(Buffer.isBuffer(data), `writeAsset(${file}) must receive a Buffer`);
      const normalized = file.replace(/\\/g, "/");
      const target = path.join(tempRoot, "assets", normalized);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
      written.set(normalized, data);
      return normalized;
    },
  };
}

// Pre-seed a theme with a wall slot that must survive the update.
const themePath = path.join(tempRoot, "assets", "themes", "self-theme.json");
fs.mkdirSync(path.dirname(themePath), { recursive: true });
fs.writeFileSync(
  themePath,
  JSON.stringify(
    {
      name: "Self Theme",
      slots: { wall: { map: "old/wall.png", uvScale: [3, 3], color: "#ccddee" } },
    },
    null,
    2,
  ),
);

const baseInputs = {
  image: { name: "gradient.png", mediaType: "image/png", data: imageB64 },
  name: "self/gradient",
  slot: "floor",
  theme: "self-theme",
  metresPerTile: 2,
  normalFromLuma: true,
  normalStrength: 1,
  previewTiling: true,
};

try {
  // --- run 1: makeSeamless OFF — seams must stay large ---------------------
  const rough = await run(makeContext("run-rough"), { ...baseInputs, makeSeamless: false });
  const roughImg = decodePng(written.get("textures/self/gradient.png"));
  const roughSeam = measureSeams(roughImg);
  assert.equal(roughImg.width, SIZE);
  assert.equal(roughImg.height, SIZE);
  assert.ok(
    roughSeam.horizontal > 25 && roughSeam.vertical > 25,
    `expected large seams without makeSeamless, got h=${roughSeam.horizontal} v=${roughSeam.vertical}`,
  );
  assert.equal(rough.report.seamless, false);

  // --- run 2: makeSeamless ON — seams must be near-zero --------------------
  const result = await run(makeContext("run-seamless"), { ...baseInputs, makeSeamless: true });

  const outImg = decodePng(written.get("textures/self/gradient.png"));
  assert.equal(outImg.width, SIZE);
  assert.equal(outImg.height, SIZE);
  const seam = measureSeams(outImg);
  assert.ok(
    seam.horizontal < 6 && seam.vertical < 6,
    `expected near-zero seams after makeSeamless, got h=${seam.horizontal} v=${seam.vertical}`,
  );
  assert.deepEqual(result.report.seam.after, seam, "report.seam.after must match the written image");
  assert.ok(result.report.seam.before.horizontal > 25, "report must carry the pre-pass seam delta");

  // normal map exists and is a valid PNG of the same size, blue-dominant
  const normal = decodePng(written.get("textures/self/gradient-normal.png"));
  assert.equal(normal.width, SIZE);
  assert.equal(normal.height, SIZE);
  const c = (SIZE / 2 * SIZE + SIZE / 2) * 4;
  assert.ok(normal.data[c + 2] > 128, "normal map centre pixel must point outward (blue > 128)");

  // theme doc: new floor slot written, wall slot preserved untouched
  const theme = JSON.parse(fs.readFileSync(themePath, "utf8"));
  assert.equal(theme.name, "Self Theme");
  assert.deepEqual(theme.slots.floor, {
    map: "self/gradient.png",
    uvScale: [2, 2],
    normalMap: "self/gradient-normal.png",
  });
  assert.deepEqual(theme.slots.wall, { map: "old/wall.png", uvScale: [3, 3], color: "#ccddee" });
  assert.ok(
    result.assets.some((a) => a.kind === "theme" && a.id === "self-theme" && a.file === "themes/self-theme.json"),
    "theme asset must be reported",
  );

  // previews: tiled 3x3 at 384 present and decodable
  assert.ok(result.previews.length >= 1, "expected a tiled preview");
  assert.equal(result.previews[0].label, "tiled 3x3");
  const preview = decodePng(Buffer.from(result.previews[0].data, "base64"));
  assert.equal(preview.width, 384);
  assert.equal(preview.height, 384);

  // asset list shape
  const kinds = result.assets.map((a) => `${a.kind}:${a.id}`).sort();
  assert.deepEqual(kinds, [
    "texture:self/gradient-normal.png",
    "texture:self/gradient.png",
    "theme:self-theme",
  ]);
  assert.ok(Array.isArray(result.warnings));
  assert.ok(typeof result.log === "string" && result.log.length > 0);

  console.log(
    `self-test OK — seam mean |RGB| delta: before h=${roughSeam.horizontal} v=${roughSeam.vertical}, ` +
      `after h=${seam.horizontal} v=${seam.vertical}`,
  );
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
