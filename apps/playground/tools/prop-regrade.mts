/**
 * prop-regrade — re-skin a prop's GREY stone onto a region's stone tile, keeping its painted detail (k-town3, Derek
 * 2026-10-31: "some rock / stonework choices were still the grey"). The art for `props variant --art`.
 *
 *   npx tsx tools/prop-regrade.mts <prefab> --palette <stone tile png> --out <png> [--project <p>] [--page <png>] [--flip yes|no]
 *   then: npx tsx tools/props.mts variant <prefab> --id <coll/name> --art <png>
 *
 * Every texel the town-grey rule calls grey (tools/town-grey.mts isGrey: opaque, mid-value, colourless) is replaced by
 * its own luminance in the palette's mean hue (a luminance-preserving recolour), so mortar stays dark, faces stay
 * light and the stone pattern is the prop's own; wood, rope, iron and every tinted texel are untouched. Grey texels
 * that border tinted ones keep the same rule (no halo pass: the page's cells are separate).
 * ROW CONVENTION: the page is written as read (k-town3: `props variant --art` keeps the source page's rows; the four
 * Bell Strand re-skins written flipped drew black in the engine and read 10 tx/m in `props status`). `--flip yes`
 * mirrors it; always confirm with `props status` (blank-uv + texel density) and one engine frame.
 */
import fs from "node:fs";
import path from "node:path";
import { PROJECTS } from "./_closure.mjs";
import { prefabGeometry } from "./_prop-geometry.mts";
import { texPixels } from "./_prop-blank-uv.mts";
import { decodePng, encodePng } from "./_png.mjs";
import { isGrey } from "./town-grey.mts";

const luma = (d: ArrayLike<number>, i: number) => 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;

/** Regrade grey texels of `src` (RGBA) onto `pal`: each keeps its own LUMINANCE and takes the palette's mean hue and
 *  saturation (a luminance-preserving recolour), so the painted pattern, mortar and wear stay the prop's own. */
export function regrade(src: { width: number; height: number; data: Uint8Array }, pal: { width: number; height: number; data: Uint8Array }) {
  let pr = 0, pg = 0, pb = 0, n = 0;
  for (let i = 0; i < pal.data.length; i += 4) if (pal.data[i + 3]! >= 128) { pr += pal.data[i]!; pg += pal.data[i + 1]!; pb += pal.data[i + 2]!; n++; }
  pr /= n; pg /= n; pb /= n;
  const pl = 0.299 * pr + 0.587 * pg + 0.114 * pb;
  const out = new Uint8Array(src.data); let changed = 0;
  for (let i = 0; i < src.data.length; i += 4) {
    if (src.data[i + 3]! < 128 || !isGrey(src.data[i]!, src.data[i + 1]!, src.data[i + 2]!)) continue;
    const k = luma(src.data, i) / pl;
    out[i] = Math.min(255, Math.round(pr * k)); out[i + 1] = Math.min(255, Math.round(pg * k)); out[i + 2] = Math.min(255, Math.round(pb * k)); changed++;
  }
  return { data: out, changed };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).replace(/\\/g, "/").endsWith("tools/prop-regrade.mts");
if (isMain) {
  const argv = process.argv.slice(2);
  const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const id = argv[0], palF = opt("palette"), out = opt("out");
  if (!id || !palF || !out) { console.error("usage: prop-regrade <prefab> --palette <png> --out <png> [--project <p>]"); process.exit(2); }
  const geo = prefabGeometry(path.join(PROJECTS, opt("project") ?? "world-kit", "assets"), id);
  const texs = new Map<string, any>(); for (const t of geo.tris) if (t.tex) texs.set(t.tex.key, t.tex);
  if (texs.size !== 1) { console.error(`${id}: ${texs.size} textures; prop-regrade re-skins a one-page prop`); process.exit(1); }
  const tex = [...texs.values()][0];
  // --page <png>: the source page by hand (a glTF with several images: the geometry reader may hand back the emissive
  // page); --flip yes mirrors the rows (default: none -- four re-skins proved it: a flipped page drew black and read
  // 10 tx/m). Check with `props status`
  // (blank-uv) after `props variant`: a mirrored page samples empty cells.
  const img = opt("page") ? (decodePng(fs.readFileSync(opt("page")!)) as { width: number; height: number; data: Uint8Array }) : texPixels(tex)!;
  tex.flipY = opt("flip") !== "yes"; // k-town3: written as read (props variant keeps the page's rows); --flip yes mirrors
  const pal = decodePng(fs.readFileSync(palF)) as { width: number; height: number; data: Uint8Array };
  const r = regrade(img, pal);
  let data = r.data;
  if (!tex.flipY) { // glTF page -> material map: flip rows
    const W = img.width * 4, f = new Uint8Array(data.length);
    for (let y = 0; y < img.height; y++) f.set(data.subarray(y * W, y * W + W), (img.height - 1 - y) * W);
    data = f;
  }
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, encodePng(img.width, img.height, data));
  console.log(`${id}: ${r.changed} grey texels of ${img.width}x${img.height} regraded onto ${path.basename(palF)}${tex.flipY ? "" : " (glTF page written flipped: material-map rows)"} -> ${out}`);
}
