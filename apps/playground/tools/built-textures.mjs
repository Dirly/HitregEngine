#!/usr/bin/env node
/**
 * BUILT-TEXTURES — a role texture set for a BUILT landmark (`landmark` operator `kind: "built"`): ashlar, trim band,
 * paving, relief panel, lintel... generated in ONE image session from a concept frame and a brief, at the town texel
 * standard (40 texels per metre), PSX, tileable where the role tiles, plus one engine material per role.
 *
 *   node tools/built-textures.mjs plan  <set.json>            # print the manifest + materials it would write
 *   node tools/built-textures.mjs gen   <set.json> [--force]  # generate (tools/image-request.mjs gen-set) + materials
 *   node tools/built-textures.mjs check <set.json>            # sizes = metres x 40, seams of tiling roles, materials
 *
 * set.json (paths resolve against apps/playground):
 *   { "project": "tower-lab", "prefix": "oasis-gate",            // ids are "<project>-<prefix>-<role>" (images are shared)
 *     "concept": "<concept frame png>", "styleRef": "<a house texture png>",
 *     "brief": "theme words: stone, palette, wear (tone, not darkness)",
 *     "roles": [ { "role": "ashlar", "kind": "tile",  "metres": [6.4, 6.4], "prompt": "..." },
 *                { "role": "trim",   "kind": "band",  "metres": [3.2, 1.6], "prompt": "..." },
 *                { "role": "relief", "kind": "panel", "metres": [4, 8],     "prompt": "..." } ] }
 * kind: `tile` (seamless on all four edges), `band` (seamless left-right AND top-bottom: a carved course that repeats
 * along a cornice and stacks on a tall face), `panel` (one picture: map it with a part `uvRegion`, never tiled).
 * Pixels = metres x 40, snapped to a multiple of 32 (the check reports the real texels/m). Textures land in
 * projects/<project>/assets/textures/<prefix>/<role>.png, materials in assets/materials/<prefix>/<role>.json
 * (standard, nearest filter, NO triplanar: the built mesh carries the UVs). Overwrites in place.
 * The operator then names `materials: { <role>: "<prefix>/<role>" }`; the baker derives each role's tile from the
 * texture size, so the spec needs no `tile`.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLAY = path.resolve(HERE, "..");
const TEXELS = 40;
const [cmd, setFile, ...rest] = process.argv.slice(2);
if (!cmd || !setFile) { console.error("usage: built-textures.mjs plan|gen|check <set.json> [--force]"); process.exit(1); }
const set = JSON.parse(fs.readFileSync(setFile, "utf8"));
const snap = (m) => Math.max(32, Math.round((m * TEXELS) / 32) * 32);

const HOUSE = "Texture for a PSX-era 3D game (late 90s): nearest-filtered pixel art, low colour count, straight-on, evenly lit, " +
  "no baked highlights, no directional shadows, no perspective, no text, no letters, no UI. Scale: 40 texture pixels per metre " +
  "(one pixel = 2.5 cm), so a 60 cm ashlar block is 24 pixels tall. Man-made stone reads as CUT stone and bricks with crisp " +
  "joints, never natural rock. Dark foreboding world: tone, not darkness - mid values stay readable.";
const KIND = {
  tile: "It must tile seamlessly on ALL FOUR edges (the left column continues the right, the top row continues the bottom).",
  band: "A carved horizontal course that repeats: it must tile seamlessly left-right AND top-bottom (it stacks on tall faces).",
  panel: "One single picture filling the whole image edge to edge, seen straight-on (not tiled, not a sheet of several).",
};

const roles = set.roles.map((r) => {
  const px = [snap(r.metres[0]), snap(r.metres[1])];
  const rel = `${set.prefix}/${r.role}`;
  return { ...r, px, id: `${set.project}-${set.prefix}-${r.role}`, target: `projects/${set.project}/assets/textures/${rel}.png`, materialId: rel,
    materialFile: path.join(PLAY, "projects", set.project, "assets", "materials", `${rel}.json`) };
});
const refs = [set.concept, set.styleRef].filter(Boolean);
const manifest = {
  brief: `${HOUSE} ${set.brief} The FIRST attached image is the concept frame: match its palette, mood and motifs (not its perspective). ` +
    (set.styleRef ? "The SECOND attached image is the house texture: match its pixel density and grain, NOT its colours or layout." : ""),
  images: roles.map((r) => ({ id: r.id, target: r.target, size: `${r.px[0]}x${r.px[1]}`, ref: refs, purpose: `built landmark role ${r.role} (${r.kind})`,
    prompt: `${r.prompt} ${KIND[r.kind]} Real size ${r.metres[0]} x ${r.metres[1]} m.` })),
};
const material = (r) => ({ shader: "standard", color: "#ffffff", map: `${set.prefix}/${r.role}.png`, filter: "nearest", roughness: 0.95, metalness: 0, repeat: [1, 1] });
const writeMaterials = () => { for (const r of roles) { fs.mkdirSync(path.dirname(r.materialFile), { recursive: true }); fs.writeFileSync(r.materialFile, JSON.stringify(material(r)) + "\n"); } };

function png(file) {
  const b = fs.readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}
/** Mean |difference| across the wrap seams (0..255), via the PNG decoder in sharp when present, else null. */
async function seams(file) {
  let sharp; try { sharp = (await import("sharp")).default; } catch { return null; }
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, at = (x, y, c) => data[(y * W + x) * 3 + c];
  let lr = 0, tb = 0, inner = 0;
  for (let y = 0; y < H; y++) for (let c = 0; c < 3; c++) { lr += Math.abs(at(0, y, c) - at(W - 1, y, c)); inner += Math.abs(at(W >> 1, y, c) - at((W >> 1) - 1, y, c)); }
  for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) tb += Math.abs(at(x, 0, c) - at(x, H - 1, c));
  return { lr: lr / (H * 3), tb: tb / (W * 3), inner: inner / (H * 3) };
}

if (cmd === "plan") { console.log(JSON.stringify({ manifest, materials: Object.fromEntries(roles.map((r) => [r.role, r.materialId])) }, null, 1)); process.exit(0); }
if (cmd === "gen") {
  const mf = path.join(PLAY, ".hitreg", `built-textures-${set.project}-${set.prefix}.json`);
  fs.mkdirSync(path.dirname(mf), { recursive: true });
  fs.writeFileSync(mf, JSON.stringify(manifest, null, 1));
  execFileSync(process.execPath, [path.join(HERE, "image-request.mjs"), "gen-set", "--manifest", mf, "--timeout", "1500", ...(rest.includes("--force") ? ["--force"] : [])], { cwd: PLAY, stdio: "inherit" });
  writeMaterials();
  console.log(`materials: ${roles.map((r) => r.materialId).join(", ")}`);
}
if (cmd === "gen" || cmd === "check") {
  if (cmd === "check" && roles.some((r) => !fs.existsSync(r.materialFile))) writeMaterials();
  let bad = 0;
  for (const r of roles) {
    const f = path.join(PLAY, r.target);
    if (!fs.existsSync(f)) { console.log(`MISSING ${r.role}: ${r.target}`); bad++; continue; }
    const { w, h } = png(f), tx = [w / r.metres[0], h / r.metres[1]];
    const okSize = tx.every((t) => Math.abs(t - TEXELS) / TEXELS <= 0.15);
    const s = r.kind === "panel" ? null : await seams(f);
    // a seam no worse than 1.6x the image's own column-to-column change (+6 levels) is seamless enough
    const okSeam = !s || (s.lr <= s.inner * 1.6 + 6 && (s.tb <= s.inner * 1.6 + 6));
    if (!okSize || !okSeam) bad++;
    console.log(`${okSize && okSeam ? "ok   " : "FAULT"} ${r.role.padEnd(8)} ${w}x${h} px = ${tx.map((t) => t.toFixed(1)).join(" x ")} texels/m${s ? `, seams lr ${s.lr.toFixed(1)} tb ${s.tb.toFixed(1)} (inner ${s.inner.toFixed(1)})` : r.kind === "panel" ? "" : ", seam check SKIPPED (no sharp module): tile it by eye"} -> material ${r.materialId}`);
  }
  process.exit(bad ? 1 : 0);
}
