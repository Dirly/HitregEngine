/**
 * Path ribbons — the support commands of the `path` landform operator (packages/core/src/voxel/ribbon.ts).
 *
 *   tsx tools/worldgen-ribbon.mts materials <world.json>   write ribbon/<surface>[--trodden] (terrain tint, alphaHash verge) and
 *       ribbon-wall/<cliff>-rubble|ashlar (kit masonry in the zone stone tone) materials next to the world;
 *       for every palette surface a compiled ribbon paves with (the streamer draws a ribbon with `ribbon/<surface>`)
 *   tsx tools/worldgen-ribbon.mts report <world.json>      per ribbon: length, steepest ramp, flights/risers, walls,
 *       switchbacks, warnings, and how far the drawn ground sits from the walk surface (the 5 cm contract)
 *
 * Install / preview a path with the operator commands: `worldgen op <world> --apply <file>` and
 * `worldgen op-preview <world> --op <id>` (both take `--recipe <file>` for a scratch copy).
 */
import fs from "node:fs";
import path from "node:path";
// @ts-expect-error untyped helper module
import { decodePng, encodePng } from "./_png.mjs";
import { createWorldField, ribbonSurfaces, RIBBON_LIFT, ribbonMaterialId, ribbonWallMaterialId, worldRecipeSchema, type WorldRecipe } from "@hitreg/core";

/**
 * Trodden earth from a terrain tile: each pixel pulled 55 % toward its 5x5 (wrapping) neighbourhood mean (worn smooth:
 * the grain softens, the tile still tiles), its spread about the tile mean cut to 70 %, then lifted 12 % in value.
 */
function troddenTile(buf: Buffer): Buffer {
  const { width: w, height: h, data } = decodePng(buf);
  const out = new Uint8Array(w * h * 4);
  const mean = [0, 0, 0];
  for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) mean[c]! += data[i * 4 + c]! / (w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) sum += data[(((y + dy + h) % h) * w + ((x + dx + w) % w)) * 4 + c]!;
      const soft = data[o + c]! + (sum / 25 - data[o + c]!) * 0.55;
      out[o + c] = Math.max(0, Math.min(255, Math.round((mean[c]! + (soft - mean[c]!) * 0.45) * 1.3)));
    }
    out[o + 3] = 255;
  }
  return encodePng(w, h, out);
}

const [cmd, file] = process.argv.slice(2);
if (!cmd || !file) {
  console.error("usage: worldgen-ribbon.mts materials|report <world.json>");
  process.exit(2);
}
const recipe: WorldRecipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
const ribbons = recipe.features.ribbons ?? [];
const surfaces = ribbonSurfaces(recipe);

if (cmd === "materials") {
  const assets = path.resolve(path.dirname(file), "..");
  const wrote: string[] = [];
  const write = (id: string, doc: object) => {
    const out = path.join(assets, "materials", `${id}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
    wrote.push(path.relative(process.cwd(), out));
  };
  const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
  const toHex = (v: number[]) => `#${v.map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, "0")).join("")}`;
  const mix = (a: number[], b: number[], t: number) => a.map((x, i) => x + (b[i]! - x) * t);
  // a palette map path resolves under some project's assets/textures (the world's own project first)
  const projectsDir = path.resolve(assets, "..", "..");
  const findTexture = (rel: string): string | null => {
    const own = path.join(assets, "textures", rel);
    if (fs.existsSync(own)) return own;
    for (const d of fs.readdirSync(projectsDir)) { const f = path.join(projectsDir, d, "assets", "textures", rel); if (fs.existsSync(f)) return f; }
    return null;
  };
  const byName = new Map(recipe.surfaces.map((s) => [s.name, s]));
  const done = new Set<string>();
  for (const r of ribbons) {
    const name = surfaces.surfaceOf(r);
    const toward = surfaces.troddenToward?.(r) ?? null;
    const id = ribbonMaterialId(name, toward);
    if (done.has(id)) continue;
    done.add(id);
    const s = byName.get(name);
    if (!s?.map) { console.warn(`  ${name}: no texture on the palette surface; the ribbon draws untextured`); continue; }
    // the terrain draws a textured layer as map x white x the biome tint (COLOR_0) at its roughness: so does the ribbon
    // (the streamer writes the same biome tint into its vertex colours). Cobble / slab: no extra tint, no brightness.
    // Trodden earth: its own copy of the tile, smoothed (less grain than the ground around it) and lifted a little, so
    // the path reads from afar in the zone's own hue; the mesh darkens its worn rim.
    let map = s.map;
    if (toward) {
      const src = findTexture(s.map);
      if (!src) console.warn(`  ${name}: texture ${s.map} not found in any project; the trodden copy is skipped`);
      else {
        map = `ribbon/${name}--trodden.png`;
        const outPng = path.join(assets, "textures", map);
        fs.mkdirSync(path.dirname(outPng), { recursive: true });
        fs.writeFileSync(outPng, troddenTile(fs.readFileSync(src)));
        wrote.push(path.relative(process.cwd(), outPng));
      }
    }
    write(id, { shader: "standard", map, color: "#ffffff", filter: recipe.textureFilter, roughness: s.roughness, metalness: 0, repeat: [1, 1], vertexColors: true, alphaHash: true });
  }
  // retaining walls in the zone's stone: the kit's masonry maps (run-space UVs, baked AO), tinted toward the cliff tone
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
  const kitDir = path.resolve(here, "..", "projects", "world-kit", "assets", "materials", "retaining-wall");
  for (const r of ribbons) {
    const skin = surfaces.wallSkinOf?.(r) ?? null;
    const cliff = skin ? byName.get(skin) : undefined;
    if (!skin || !cliff) continue;
    const c = hex(cliff.color), peak = Math.max(...c, 1e-3);
    const tone = toHex(mix([1, 1, 1], c.map((v) => v / peak), 0.85));
    for (const kind of ["rubble", "ashlar"] as const) {
      const id = ribbonWallMaterialId(skin, kind);
      if (done.has(id)) continue;
      done.add(id);
      const kit = JSON.parse(fs.readFileSync(path.join(kitDir, `${kind}.json`), "utf8")) as Record<string, unknown>;
      write(id, { ...kit, color: tone });
    }
  }
  console.log(`ribbon materials: ${wrote.length ? wrote.join(", ") : "none needed"}`);
} else if (cmd === "report") {
  const field = createWorldField(recipe);
  let bad = 0;
  for (const r of ribbons) {
    const inStair = (i: number) => r.flights.some((f) => i >= f.from - 2 && i <= f.to + 2);
    let worst = 0, at = -1;
    for (let i = 0; i < r.samples.length; i++) {
      if (inStair(i)) continue;
      const [x, y, z] = r.samples[i]!;
      const d = Math.abs(field.height(x, z) - (y - RIBBON_LIFT));
      if (d > worst) { worst = d; at = i; }
    }
    const risers = r.flights.reduce((n, f) => n + f.treads.length, 0);
    const ok = worst <= 0.05;
    if (!ok) bad++;
    console.log(`${ok ? "ok  " : "FAIL"} ${r.id}: ${r.samples.length} m, ${surfaces.surfaceOf(r)}, ${r.flights.length} flight(s) / ${risers} treads, ${r.switchbacks} switchback(s), ${r.pieces.filter((p) => p.role !== "cap").length} wall piece(s); ground vs walk surface ${worst.toFixed(3)} m (sample ${at})${r.warnings.length ? `; ${r.warnings.join("; ")}` : ""}`);
  }
  process.exit(bad ? 1 : 0);
} else {
  console.error(`unknown command ${cmd}`);
  process.exit(2);
}
