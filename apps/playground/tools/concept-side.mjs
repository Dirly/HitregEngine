// concept-side: a town/place built TO its paintings is judged beside them. One sheet, one row per view: the painting
// on the left, the render(s) from the same camera on the right, labelled. Overwrites --out (no iteration files).
//   node tools/concept-side.mjs --out <sheet.png> --concept <dir/prefix> --shots <dir> [--views top,gate,street,square] [--times 12,20] [--w 640]
//     painting = <prefix>-<view>.png, renders = <shots>/<view>-<time>.png (light-shots --spots output names)
//   node tools/concept-side.mjs --out <sheet.png> --row "<label>|<painting.png>|<render.png>[|<render2.png>]" [--row ...]
// A missing file is a grey "MISSING" cell AND a non-zero exit (pass --allow-missing to keep going): k-town7's sheet
// came out with every render cell empty because Git Bash rewrote "label|C:/a.png" as a path list ("C;P:\Program
// Files\Git\..."). Prefer --concept/--shots (no packed arguments); packed rows are repaired when MSYS mangled them.
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const argv = process.argv.slice(2);
const rows = []; let out = "", W = 640, concept = "", shots = "", views = ["top", "gate", "street", "square"], times = ["12", "20"], allowMissing = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--row") rows.push(argv[++i].split("|"));
  else if (a === "--out") out = argv[++i];
  else if (a === "--w") W = +argv[++i];
  else if (a === "--concept") concept = argv[++i];
  else if (a === "--shots") shots = argv[++i];
  else if (a === "--views") views = argv[++i].split(",");
  else if (a === "--times") times = argv[++i].split(",");
  else if (a === "--allow-missing") allowMissing = true;
}
if (concept && shots) for (const v of views) rows.push([v, `${concept}-${v}.png`, ...times.map((t) => path.join(shots, `${v}-${t}.png`))]);
if (!out || !rows.length) { console.error("usage: concept-side.mjs --out <png> (--concept <dir/prefix> --shots <dir> | --row \"label|painting|render[|render2]\" ...)"); process.exit(2); }

// MSYS path-list conversion turns "x|C:/a/b.png" into "x|C;P:\Program Files\Git\a\b.png" (and "/c/..." forms alike):
// undo it so a packed row still finds its files.
const unmangle = (f) => {
  const m = /^([A-Za-z]);[A-Za-z]:\\.*?\\Git\\(.*)$/.exec(f);
  return m ? `${m[1]}:\\${m[2]}` : f;
};
const H = Math.round(W * 9 / 16), LBL = 26, cols = Math.max(...rows.map((r) => r.length - 1));
const esc = (s) => s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]);
const label = (t, bad) => Buffer.from(`<svg width="${W}" height="${LBL}"><rect width="100%" height="100%" fill="${bad ? "#5a1010" : "#111"}"/><text x="8" y="18" font-family="monospace" font-size="15" fill="#f0d890">${esc(t)}</text></svg>`);
const comps = [], missing = [];
for (const [r, row] of rows.entries()) {
  const [name, ...raw] = row;
  const files = raw.map(unmangle);
  for (const [c, f] of files.entries()) {
    const x = c * W, y = r * (H + LBL), ok = fs.existsSync(f);
    if (!ok) missing.push(f);
    const tag = `${name} - ${c === 0 ? "PAINTING" : `NOW${files.length > 2 ? ` ${c}` : ""} (${f.split(/[\\/]/).pop()})`}${ok ? "" : " MISSING"}`;
    comps.push({ input: await sharp(label(tag, !ok)).png().toBuffer(), left: x, top: y });
    const img = ok ? await sharp(f).resize(W, H, { fit: "cover" }).png().toBuffer()
      : await sharp({ create: { width: W, height: H, channels: 3, background: "#333" } }).png().toBuffer();
    comps.push({ input: img, left: x, top: y + LBL });
  }
}
await sharp({ create: { width: cols * W, height: rows.length * (H + LBL), channels: 3, background: "#111" } }).composite(comps).png().toFile(out);
console.log(`concept-side: ${rows.length} row(s), ${missing.length} missing cell(s) -> ${out}`);
for (const f of missing) console.error(`  MISSING ${f}`);
if (missing.length && !allowMissing) process.exit(1);
