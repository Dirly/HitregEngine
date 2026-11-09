/**
 * The terrain material is DERIVED from a world recipe's `surfaces`: one splat
 * layer per palette entry, in palette order. The mesher writes palette ids into
 * the geometry (`splatIndex`), and the renderer looks each id up in the
 * material's layer array — clamped into range (terrain-splat `indexedBlend`).
 *
 * So a surface added to the palette WITHOUT re-deriving the material renders
 * as the material's LAST layer, silently. That is how Bell Strand's
 * `redstrand-pale-flagstone` (palette #26 on a 26-layer material) kept drawing
 * the hive floor's red flag in every browser frame while every field-side gate
 * (town-paving samples `splatAt`) read pale flagstone (e-paving, 2026-11-02).
 *
 * `terrainMaterialDoc` is the one derivation (worldgen writes it);
 * `terrainPaletteFaults` says which palette surfaces would not reach the render
 * through a given material doc (worldgen status, town-paving, the client).
 */
import { recipeSplatIndexed, type WorldRecipe } from "./recipe.js";

type PaletteRecipe = Pick<WorldRecipe, "surfaces" | "splat"> & Partial<Pick<WorldRecipe, "textureFilter" | "macroNoise">>;

/** The terrain material document a recipe's palette derives (the file `worldgen material` writes). */
export function terrainMaterialDoc(recipe: PaletteRecipe): Record<string, unknown> {
  return {
    shader: "terrain-splat",
    color: "#ffffff",
    roughness: 0.95,
    metalness: 0,
    ...(recipe.textureFilter !== undefined ? { filter: recipe.textureFilter } : {}),
    splat: {
      // the mesher and this ask the same question, so geometry and material agree
      source: recipeSplatIndexed(recipe) ? "indexed" : "vertex",
      tintByVertexColor: true,
      layers: recipe.surfaces.map((surface) => ({
        // A textured layer tints WHITE so the texture reads as painted; the
        // surface's own colour stays in the recipe as the fallback (and as
        // what `worldgen map` draws the overview with).
        color: surface.map ? "#ffffff" : surface.color,
        roughness: surface.roughness,
        uvScale: surface.uvScale,
        ...(surface.map ? { map: surface.map } : {}),
        ...(surface.normalMap ? { normalMap: surface.normalMap } : {}),
      })),
      ...(recipe.macroNoise ? { macroNoise: recipe.macroNoise } : {}),
    },
  };
}

export interface TerrainPaletteFault {
  /** Palette index, or -1 for a fault of the whole material. */
  surface: number;
  name: string;
  why: string;
}

interface LayerLike {
  map?: unknown;
  color?: unknown;
}

/**
 * Every palette surface of `recipe` that would NOT draw as itself through
 * `material` (a material document or its parsed data; null = no material).
 * Empty = every painted surface reaches the render.
 *
 * Checked: the material exists and is a splat; its source matches the
 * geometry the mesher writes (indexed vs vertex weights); it has a layer for
 * every palette index (a missing one draws as the LAST layer); each layer
 * carries its surface's texture. Tile scale, roughness and tint are tuning,
 * not reach, and are not faults.
 */
export function terrainPaletteFaults(recipe: PaletteRecipe, material: unknown): TerrainPaletteFault[] {
  const whole = (why: string): TerrainPaletteFault[] => [{ surface: -1, name: "*", why }];
  if (!material || typeof material !== "object") return whole("no terrain material: the terrain draws the default material");
  const splat = (material as { splat?: { source?: string; layers?: LayerLike[] } }).splat;
  if (!splat || !Array.isArray(splat.layers)) return whole("the terrain material has no splat layers");
  const out: TerrainPaletteFault[] = [];
  const want = recipeSplatIndexed(recipe) ? "indexed" : "vertex";
  const source = splat.source ?? "height";
  if (source !== want) out.push({ surface: -1, name: "*", why: `material splat source "${source}", the mesher writes "${want}" weights` });
  const layers = splat.layers;
  const last = layers.length - 1;
  recipe.surfaces.forEach((surface, i) => {
    const layer = layers[i];
    if (!layer) {
      const shown = layers[last];
      out.push({
        surface: i,
        name: surface.name,
        why: `palette #${i} is past the material's ${layers.length} layers: it draws as layer #${last} (${String(shown?.map ?? shown?.color ?? "?")})`,
      });
      return;
    }
    const map = typeof layer.map === "string" ? layer.map : undefined;
    if ((surface.map ?? undefined) !== map) {
      out.push({ surface: i, name: surface.name, why: `layer #${i} draws ${map ?? "a flat colour"}, the palette paints ${surface.map ?? "a flat colour"}` });
    }
  });
  if (layers.length > recipe.surfaces.length) {
    out.push({ surface: -1, name: "*", why: `material has ${layers.length} layers for a ${recipe.surfaces.length}-surface palette (stale: re-derive it)` });
  }
  return out;
}
