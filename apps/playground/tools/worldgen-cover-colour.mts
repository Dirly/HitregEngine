/**
 * GRASS MATCHES ITS GROUND TILE (owner ruling 2026-10-30, Derek: "grass always needs to match the colour of the grass
 * tile"; first seen on the owner walk 2026-10-27: grass popped in at the fade distance in a colour the zone's ground did
 * not have).
 *
 * A cover layer's blades are drawn as sprite x bladeColor (packages/render grass.ts), one colour for the whole world. The
 * ground under them is the tile of the surface's ROLE in the zone the point is in (`regions[].ground[role]`, worldgen
 * zone-textures), or the base surface's own tile where no zone restyles that role. So for every LIVE layer (it grows in
 * a biome this world has) and every ground surface it grows on (named in `surfaces`, weighted in one of its live
 * biomes), the effective blade colour is compared with the mean colour of every tile that surface draws in a zone where
 * the layer is not denied (`regions[].vegetation.cover`), by value (luminance ratio) and hue.
 *
 *   coverColourFindings  the check: the `flora` status row and `worldgen flora --check` / `worldgen cover`
 *   fitCoverColours      the fix: a failing layer's bladeColor becomes the tint that brings its sprite onto its tiles
 *                        (per channel the geometric mean of tile / sprite over every tile it stands on); a layer whose
 *                        tiles are too far apart for one tint is reported (split it per zone with region allow lists)
 *
 * Water layers (reeds, pads, weeds) stand on water, not on a ground tile, and are not judged.
 */
import fs from "node:fs";
import { vegetationIndex, type WorldRecipe } from "@hitreg/core";
// @ts-expect-error plain JS helper
import { decodePng } from "./_png.mjs";

export type Rgb = [number, number, number];

/** The tolerance: the blades' value within x0.7-1.4 of the tile's and their hue within 25 degrees (when both carry colour). */
export const COVER_COLOUR = { lumRatio: [0.7, 1.4] as const, hueDeg: 25, minSat: 0.15 };
/** A surface counts as ground a layer grows on when a live biome of the layer gives it at least this weight. */
const SURFACE_MIN_WEIGHT = 0.1;

export interface CoverColourSources {
  /** Mean opaque colour of a cover page over the tiles a layer draws (weighted by repeats), or null. */
  sprite(texture: string, atlas: { columns: number; rows: number } | undefined, tiles: readonly number[]): Rgb | null;
  /** Mean colour of a ground surface's tile (its `map`), or null. */
  tile(map: string): Rgb | null;
}

export interface CoverColourFinding {
  layer: string;
  surface: string;
  /** The tile drawn for it ("redstrand-grass"), and where ("zone-1", "" = the base tile). */
  tile: string;
  where: string;
  blade: string;
  ground: string;
  ratio: number;
  hueOff: number;
}

type Layer = WorldRecipe["cover"][number];

export const lum = (c: Rgb): number => (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;
export function hueSat(c: Rgb): [number, number] {
  const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-6) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, mx > 0 ? d / mx : 0];
}
const hueGap = (a: number, b: number): number => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
export function hexRgb(s: string | undefined): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec((s ?? "").trim());
  if (!m) return null;
  const v = parseInt(m[1]!, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
export const rgbHex = (c: Rgb): string => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;

/** The colour a layer's blades draw (sprite x bladeColor; blade/tip mixed when untextured), or null. */
export function bladeColour(layer: Layer, src: CoverColourSources): Rgb | null {
  if (layer.texture) {
    const used = layer.atlas ? (layer.tiles.length ? layer.tiles : [...Array(layer.atlas.columns * layer.atlas.rows).keys()]) : [];
    const sprite = src.sprite(layer.texture, layer.atlas, used);
    if (!sprite) return null;
    const k = hexRgb(layer.bladeColor) ?? [255, 255, 255];
    return [(sprite[0] * k[0]) / 255, (sprite[1] * k[1]) / 255, (sprite[2] * k[2]) / 255];
  }
  const a = hexRgb(layer.bladeColor), b = hexRgb(layer.tipColor);
  return a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2] : null;
}

interface GroundTile { surface: string; tile: string; where: string; map: string }

/** Every ground tile a layer's blades stand on: per surface it grows on, the zone tiles of its role and/or the base tile. */
export function groundTilesOf(recipe: WorldRecipe, layer: Layer): GroundTile[] {
  const live = new Set(recipe.biomes.map((b) => b.id));
  const biomes = layer.biomes.length ? recipe.biomes.filter((b) => layer.biomes.includes(b.id)) : recipe.biomes;
  if (layer.biomes.length && !layer.biomes.some((b) => live.has(b))) return []; // grows nowhere in this world
  const surfaces = recipe.surfaces;
  const byName = new Map(surfaces.map((s, i) => [s.name.toLowerCase(), i] as const));
  // the ground surfaces it grows on: named and weighted in a live biome (a fields/any-surface layer: each biome's main one)
  const names = new Set<string>();
  for (const b of biomes) {
    const w = b.surface ?? [];
    if (layer.surfaces.length) {
      for (const n of layer.surfaces) {
        const i = byName.get(n.toLowerCase());
        if (i !== undefined && (w[i] ?? 0) >= SURFACE_MIN_WEIGHT) names.add(surfaces[i]!.name);
      }
    } else {
      let best = -1;
      for (let i = 0; i < w.length; i++) if ((w[i] ?? 0) > (best >= 0 ? w[best]! : 0)) best = i;
      if (best >= 0) names.add(surfaces[best]!.name);
    }
  }
  // where the layer may grow: its own region limits (cover[].regions / exceptRegions) and region vegetation denials
  const index = vegetationIndex(recipe);
  const li = index.layerIndex(layer); // the cached index's own numbering (a copy made since is not in its plans: -1)
  const byId = new Map(recipe.regions.map((r, i) => [r.id, i] as const));
  const chainOf = (i: number): number[] => {
    const out: number[] = [];
    for (let at: number | undefined = i; at !== undefined && !out.includes(at); at = recipe.regions[at]!.within ? byId.get(recipe.regions[at]!.within!) : undefined) out.push(at);
    return out;
  };
  const grows = (i: number): boolean => {
    const ids = chainOf(i).map((k) => recipe.regions[k]!.id);
    if (layer.regions?.length && !ids.some((id) => layer.regions!.includes(id))) return false;
    if (ids.some((id) => layer.exceptRegions?.includes(id))) return false;
    const plan = index.plans[i];
    return !plan || li < 0 || (plan.layerKeep[li] ?? 1) > 0;
  };
  // a role no zone restyles draws its base tile everywhere the layer grows (a world without regions: everywhere)
  const growsSomewhere = recipe.regions.length === 0 ? !layer.regions?.length : recipe.regions.some((_, i) => grows(i));
  const out: GroundTile[] = [];
  for (const name of names) {
    const s = surfaces.find((x) => x.name === name)!;
    const role = (s as { role?: string }).role ?? name.toLowerCase();
    const groundOf = (i: number): string | undefined => (recipe.regions[i] as { ground?: Record<string, string> }).ground?.[role];
    const restyled = recipe.regions.some((_, i) => !!groundOf(i));
    // the tile drawn in each region it grows in: the nearest region up its chain that restyles the role, else the base
    let base = !restyled && growsSomewhere;
    recipe.regions.forEach((_, i) => {
      if (!restyled || !grows(i)) return;
      const from = chainOf(i).find((k) => !!groundOf(k));
      if (from === undefined) {
        base = true;
        return;
      }
      const t = surfaces.find((x) => x.name.toLowerCase() === groundOf(from)!.toLowerCase());
      if (t?.map) out.push({ surface: name, tile: t.name, where: recipe.regions[from]!.id, map: t.map });
    });
    // the base tile shows where no zone restyles the role
    if (base && s.map) out.push({ surface: name, tile: s.name, where: "", map: s.map });
  }
  // two surfaces of one role (grass, drygrass) draw the same zone tile: judge it once
  const seen = new Set<string>();
  return out.filter((g) => {
    const key = `${g.tile}|${g.where}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Every (layer, ground tile) pair whose blades do not read as the tile's colour. */
export function coverColourFindings(recipe: WorldRecipe, src: CoverColourSources): CoverColourFinding[] {
  const out: CoverColourFinding[] = [];
  for (const layer of recipe.cover) {
    // water layers stand on water; a crop (fields) is a sown field's own colour, not wild grass
    if (layer.water || layer.fields) continue;
    const blade = bladeColour(layer, src);
    if (!blade) continue;
    const [bh, bs] = hueSat(blade);
    for (const g of groundTilesOf(recipe, layer)) {
      const ground = src.tile(g.map);
      if (!ground) continue;
      const ratio = lum(blade) / Math.max(0.02, lum(ground));
      const [gh, gs] = hueSat(ground);
      const hueOff = bs >= COVER_COLOUR.minSat && gs >= COVER_COLOUR.minSat ? hueGap(bh, gh) : 0;
      if (ratio < COVER_COLOUR.lumRatio[0] || ratio > COVER_COLOUR.lumRatio[1] || hueOff > COVER_COLOUR.hueDeg)
        out.push({ layer: layer.id, surface: g.surface, tile: g.tile, where: g.where, blade: rgbHex(blade), ground: rgbHex(ground), ratio, hueOff });
    }
  }
  return out;
}

export function describeCoverColour(f: CoverColourFinding): string {
  return (
    `${f.layer}: blades read ${f.blade} over ${f.tile}${f.where ? ` in ${f.where}` : ""} (${f.ground}): value x${f.ratio.toFixed(2)}, ` +
    `hue ${Math.round(f.hueOff)} deg off (wanted x${COVER_COLOUR.lumRatio[0]}-${COVER_COLOUR.lumRatio[1]}, <= ${COVER_COLOUR.hueDeg} deg) — grass matches its ground tile`
  );
}

/**
 * Re-tint every failing layer onto its tiles: bladeColor = per channel the geometric mean over its tiles of
 * tile / sprite (sprite = the page under a white bladeColor), capped at white (a tint can only darken). A layer one
 * tint cannot fit is SPLIT per zone: a copy `<id>--<region>` limited to that region (`regions`) carries the region's
 * own fit, the layer itself stops there (`exceptRegions`). Nested regions (an oasis inside its zone) split first.
 * Mutates the recipe; returns one note per layer changed, split or left failing.
 */
export function fitCoverColours(recipe: WorldRecipe, src: CoverColourSources): string[] {
  const notes: string[] = [];
  const fit = (layer: Layer): void => {
    const sprite = bladeColour({ ...layer, bladeColor: "#ffffff" } as Layer, src);
    const tiles = groundTilesOf(recipe, layer).map((g) => src.tile(g.map)).filter((c): c is Rgb => !!c);
    if (!sprite || !tiles.length) return;
    const k: Rgb = [0, 1, 2].map((c) => {
      const logs = tiles.map((t) => Math.log(Math.max(1, t[c]!) / Math.max(1, sprite[c]!)));
      return Math.min(1, Math.exp(logs.reduce((a, b) => a + b, 0) / logs.length)) * 255;
    }) as Rgb;
    layer.bladeColor = rgbHex(k);
    if (!layer.texture) layer.tipColor = layer.bladeColor;
  };
  const failing = (layer: Layer) => coverColourFindings({ ...recipe, cover: [layer] } as WorldRecipe, src);
  const depth = (id: string): number => {
    let d = 0;
    for (let r = recipe.regions.find((x) => x.id === id); r?.within && d < 8; r = recipe.regions.find((x) => x.id === r!.within)) d++;
    return d;
  };
  for (const layer of [...recipe.cover]) {
    if (layer.water || layer.fields || !failing(layer).length) continue;
    const before = layer.bladeColor;
    fit(layer);
    const split: string[] = [];
    // one tint cannot fit: give a zone its own copy, most nested zone first, until the rest fits
    for (let guard = 0; guard < 8 && failing(layer).length; guard++) {
      const zones = [...new Set(groundTilesOf(recipe, layer).map((g) => g.where).filter((w) => w))];
      if (zones.length < 2) break;
      const offs = new Set(failing(layer).map((f) => f.where));
      // a zone whose copy would leave the layer itself growing nowhere is not split (the whole layer is that zone)
      const keeps = (z: string) => groundTilesOf(recipe, { ...layer, exceptRegions: [...(layer.exceptRegions ?? []), z] } as Layer).length > 0;
      // only a zone whose own tile is off (a base tile that is off — a surface no zone restyles — is narrowed below)
      const pick = zones.filter((z) => offs.has(z) && keeps(z)).sort((a, b) => depth(b) - depth(a))[0];
      if (!pick) break;
      const copy = { ...layer, id: `${layer.id}--${pick}`, regions: [pick], note: `${layer.id} on ${pick}'s ground: its own tint (worldgen flora colour fit; owner ruling 2026-10-30)` } as Layer & { exceptRegions?: string[] };
      delete copy.exceptRegions;
      recipe.cover = recipe.cover.filter((l) => l.id !== copy.id);
      recipe.cover.splice(recipe.cover.indexOf(layer) + 1, 0, copy);
      layer.exceptRegions = [...new Set([...(layer.exceptRegions ?? []), pick])];
      fit(copy);
      fit(layer);
      split.push(`split ${copy.id} ${copy.bladeColor}`);
    }
    // still off inside one zone: the layer stops growing on the ground surface it cannot match (it keeps the others)
    const narrowed: string[] = [];
    for (const l of [layer, ...recipe.cover.filter((c) => c.id.startsWith(`${layer.id}--`))]) {
      for (let guard = 0; guard < 6 && l.surfaces.length > 1; guard++) {
        const off = failing(l);
        if (!off.length) break;
        const count = new Map<string, number>();
        for (const f of off) count.set(f.surface, (count.get(f.surface) ?? 0) + 1);
        const worst = [...count].sort((a, b) => b[1] - a[1])[0]![0];
        const keep = l.surfaces.filter((n) => n.toLowerCase() !== worst.toLowerCase());
        if (!keep.length || keep.length === l.surfaces.length) break;
        l.surfaces = keep;
        fit(l);
        narrowed.push(`${l.id} off ${worst}`);
      }
    }
    const still = [layer, ...recipe.cover.filter((c) => c.id.startsWith(`${layer.id}--`))].flatMap((l) => failing(l));
    if (narrowed.length) split.push(`narrowed ${narrowed.join(", ")}`);
    notes.push(
      `cover colour: ${layer.id} bladeColor ${before} -> ${layer.bladeColor}` +
        (split.length ? `; ${split.join(", ")}` : "") +
        (still.length ? ` — STILL off on ${still.map((f) => `${f.layer}: ${f.tile}${f.where ? `@${f.where}` : ""}`).join(", ")} (one surface left and its tile is out of reach of the sprite: change the layer's tiles)` : ""),
    );
  }
  return notes;
}

/**
 * The sources read from disk: `resolve` maps a texture id under assets/textures (a cover page, a ground tile) to its
 * file (a project closure lookup). Also the pages' tile names (`<page>.tiles.json`) for the cover-kind rules.
 */
export function fileColourSources(resolve: (textureId: string) => string): CoverColourSources & { tileNames(texture: string): (string | null)[] | null } {
  const decoded = new Map<string, { width: number; height: number; data: Uint8Array } | null>();
  const image = (id: string) => {
    if (!decoded.has(id)) {
      let img: { width: number; height: number; data: Uint8Array } | null = null;
      try { img = decodePng(fs.readFileSync(resolve(id))) as never; } catch { img = null; }
      decoded.set(id, img);
    }
    return decoded.get(id)!;
  };
  const means = new Map<string, Rgb | null>();
  return {
    sprite(texture, atlas, tiles) {
      const key = `${texture}|${atlas ? `${atlas.columns}x${atlas.rows}` : ""}|${tiles.join(",")}`;
      if (means.has(key)) return means.get(key)!;
      const img = image(texture);
      let out: Rgb | null = null;
      if (img) {
        const cols = atlas?.columns ?? 1, rows = atlas?.rows ?? 1;
        const tw = img.width / cols, th = img.height / rows;
        const weight = new Map<number, number>();
        for (const t of atlas ? tiles : [0]) weight.set(t, (weight.get(t) ?? 0) + 1);
        let r = 0, g = 0, b = 0, n = 0;
        for (let y = 0; y < img.height; y++) {
          for (let x = 0; x < img.width; x++) {
            const w = weight.get(Math.floor(y / th) * cols + Math.floor(x / tw));
            if (!w) continue;
            const i = (y * img.width + x) * 4;
            if (img.data[i + 3]! < 64) continue;
            r += w * img.data[i]!; g += w * img.data[i + 1]!; b += w * img.data[i + 2]!; n += w;
          }
        }
        if (n > 0) out = [r / n, g / n, b / n];
      }
      means.set(key, out);
      return out;
    },
    tile(map) {
      const key = `tile|${map}`;
      if (means.has(key)) return means.get(key)!;
      const img = image(map);
      let out: Rgb | null = null;
      if (img) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < img.data.length; i += 4) {
          if (img.data[i + 3]! < 64) continue;
          r += img.data[i]!; g += img.data[i + 1]!; b += img.data[i + 2]!; n++;
        }
        if (n > 0) out = [r / n, g / n, b / n];
      }
      means.set(key, out);
      return out;
    },
    tileNames(texture) {
      try {
        const f = resolve(texture).replace(/\.png$/i, ".tiles.json");
        return (JSON.parse(fs.readFileSync(f, "utf8")) as { tiles: (string | null)[] }).tiles;
      } catch {
        return null;
      }
    },
  };
}
