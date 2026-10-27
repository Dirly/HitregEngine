/**
 * The materials a compiled path ribbon draws with: ribbon/<surface>[--trodden] (terrain tint, alphaHash verge; a
 * trodden copy of the tile for dirt) and ribbon-wall/<cliff>-rubble|ashlar (kit masonry in the zone stone tone), written
 * next to the world (<project>/assets/materials|textures). A ribbon whose material is missing draws FLAT WHITE-GREY:
 * `worldgen op --apply` writes them after every apply and `worldgen op --check` fails while any is missing, so no
 * installer can forget them. `tools/worldgen-ribbon.mts materials <world.json>` runs the same writer by hand.
 */
import fs from "node:fs";
import path from "node:path";
// @ts-expect-error untyped helper module
import { decodePng, encodePng } from "./_png.mjs";
import { ribbonSurfaces, ribbonMaterialId, ribbonWallMaterialId, type WorldRecipe } from "@hitreg/core";

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


/** Every material id the recipe's ribbons draw with (paving + wall skins). */
export function ribbonMaterialIds(recipe: WorldRecipe): string[] {
  const surfaces = ribbonSurfaces(recipe);
  const byName = new Map(recipe.surfaces.map((s) => [s.name, s]));
  const ids = new Set<string>();
  for (const r of recipe.features.ribbons ?? []) {
    const name = surfaces.surfaceOf(r);
    if (byName.get(name)?.map) ids.add(ribbonMaterialId(name, surfaces.troddenToward?.(r) ?? null));
    const skin = surfaces.wallSkinOf?.(r) ?? null;
    if (skin && byName.get(skin) && r.pieces.length) for (const kind of ["rubble", "ashlar"] as const) ids.add(ribbonWallMaterialId(skin, kind));
  }
  return [...ids];
}

/** Ribbon material ids with no materials/<id>.json in the world's project or any project beside it. */
export function missingRibbonMaterials(recipe: WorldRecipe, file: string): string[] {
  const assets = path.resolve(path.dirname(file), "..");
  const projectsDir = path.resolve(assets, "..", "..");
  const dirs = [path.join(assets, "materials"), ...(fs.existsSync(projectsDir) ? fs.readdirSync(projectsDir).map((d) => path.join(projectsDir, d, "assets", "materials")) : [])];
  return ribbonMaterialIds(recipe).filter((id) => !dirs.some((d) => fs.existsSync(path.join(d, `${id}.json`))));
}

/** Write (overwrite in place) every ribbon material the recipe needs, next to the world file. */
export function writeRibbonMaterials(recipe: WorldRecipe, file: string): { wrote: string[]; warnings: string[] } {
  const ribbons = recipe.features.ribbons ?? [];
  const surfaces = ribbonSurfaces(recipe);
  const warnings: string[] = [];

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
    if (!s?.map) { warnings.push(`  ${name}: no texture on the palette surface; the ribbon draws untextured`); continue; }
    // the terrain draws a textured layer as map x white x the biome tint (COLOR_0) at its roughness: so does the ribbon
    // (the streamer writes the same biome tint into its vertex colours). Cobble / slab: no extra tint, no brightness.
    // Trodden earth: its own copy of the tile, smoothed (less grain than the ground around it) and lifted a little, so
    // the path reads from afar in the zone's own hue; the mesh darkens its worn rim.
    let map = s.map;
    if (toward) {
      const src = findTexture(s.map);
      if (!src) warnings.push(`  ${name}: texture ${s.map} not found in any project; the trodden copy is skipped`);
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
  return { wrote, warnings };
}
