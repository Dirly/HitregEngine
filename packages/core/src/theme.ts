import { z } from "zod";
import { hexColor } from "./components/core.js";
import type { AssetLibrary } from "./assets.js";

/**
 * THEMES — how one dungeon plan re-skins per location.
 *
 * A theme is a data asset mapping semantic ROLE SLOTS (floor, wall, rock, …)
 * to texture sets. The structure compiler, scatter pass, and dressing passes
 * consume slots — never raw material ids — so the same plan compiled against
 * two themes produces two visually distinct dungeons with identical geometry.
 * Derek's image-generation pass drops a per-location variant set under
 * `assets/textures/<theme>/`; `themeFromTextureFolder` is the on-ramp from
 * that folder to a theme doc, and `materialsForTheme` turns the theme into
 * the engine material docs the compiler's slots resolve to.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE (learned the hard way in
 * dungeon-lab, see `apps/playground/projects/dungeon-lab/tools/wfc/palette.mjs`):
 * a material's world-UV scale must travel WITH the slot. Shell materials pin
 * `repeat` to [1, 1] and the MESH carries `uv: { mode: "world", scale }` in
 * metres, baked at build time. Re-skinning a slot to a texture with a
 * different metres-per-tile while the mesh keeps the old scale silently
 * renders the texture at the wrong world size — a bug you only catch by
 * counting stones. So every slot that names a `map` MUST name a `uvScale`
 * (metres per texture tile), and compilers read it via `uvScaleFor`.
 */

// ---------------------------------------------------------------------------
// Slot vocabulary
// ---------------------------------------------------------------------------

/**
 * The role slots every theme fills, in the deterministic order all theme
 * tooling iterates them. `water` is optional (many dungeons are dry); the
 * rest are required — a missing slot is a surface that silently keeps some
 * authored default and stops following the theme, which is the exact failure
 * this mechanism exists to prevent (same rule as dungeon-lab's palettes).
 */
export const THEME_SLOTS = [
  "floor",
  "wall",
  "ceiling",
  "trim",
  "accent",
  "rock",
  "wood",
  "metal",
  "step",
  "water",
] as const;

export type ThemeSlotName = (typeof THEME_SLOTS)[number];

/** Slots a theme must always provide (everything except `water`). */
export const REQUIRED_THEME_SLOTS = THEME_SLOTS.filter(
  (s): s is Exclude<ThemeSlotName, "water"> => s !== "water",
);

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const uvScaleTuple = z
  .tuple([z.number().positive(), z.number().positive()])
  .describe(
    "METRES PER TEXTURE TILE [u, v] in world space — NOT a UV repeat count. [3, 3] = one tile every " +
      "3 m. REQUIRED whenever `map` is set: the shell materials generated from a theme pin `repeat` " +
      "to [1, 1] and the mesh carries `uv: { mode: \"world\", scale }` instead, so this value is what " +
      "keeps a re-skin from silently changing the texture's world size (the counting-stones bug). " +
      "Compilers read it with `uvScaleFor(theme, slot)` and bake it into the mesh they emit.",
  );

export const themeSlotSchema = z
  .object({
    map: z
      .string()
      .optional()
      .describe(
        "Texture asset id — the relative path under assets/textures/ INCLUDING extension " +
          "(e.g. \"crypt-a/mossy-brick-wall.png\"), which is how the asset loader keys textures. " +
          "Omit for a flat-colour slot (graybox, or a slot this location genuinely leaves untextured).",
      ),
    color: hexColor
      .default("#ffffff")
      .describe(
        "Base colour, multiplied with `map` when one is set (leave #ffffff to show the texture " +
          "untinted; darken it to grime a whole slot). With no `map` this IS the slot's look.",
      ),
    roughness: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        "PBR roughness 0..1. Omitted = engine material default (0.85, near-matte — right for stone). " +
          "Set it low only on slots that should read wet or polished.",
      ),
    metalness: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        "PBR metalness 0..1. Omitted = engine material default (0.05). Really only the `metal` slot " +
          "wants a high value; metallic stone reads as oily.",
      ),
    normalMap: z
      .string()
      .optional()
      .describe(
        "Texture asset id of a tangent-space normal map (OpenGL +Y convention), same id form as `map`. " +
          "Shares `map`'s UV transform, so the theme's single `uvScale` covers both.",
      ),
    uvScale: uvScaleTuple.optional(),
  })
  .superRefine((slot, ctx) => {
    if (slot.map !== undefined && slot.uvScale === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["uvScale"],
        message:
          "uvScale (metres per texture tile) is required when map is set — without it a re-skin " +
          "silently changes the texture's world scale",
      });
    }
  })
  .describe(
    "One role slot: which texture set a semantic surface role wears in this theme, plus the " +
      "metres-per-tile that keeps its world scale stable across re-skins.",
  );

export type ThemeSlot = z.infer<typeof themeSlotSchema>;
export type ThemeSlotInput = z.input<typeof themeSlotSchema>;

export const themeLightSchema = z
  .object({
    warm: hexColor.describe(
      "Colour cast by this theme's warm fixtures (torches, braziers, hearths).",
    ),
    cold: hexColor.describe(
      "Colour cast by this theme's cold sources (moonlight shafts, fungus, sorcery)." ,
    ),
    accent: hexColor.describe(
      "Colour cast by accent-slot fixtures (runes, crystals, shrines) — pairs with the `accent` slot.",
    ),
  })
  .describe(
    "The colours this theme's light fixtures CAST — part of the dressing vocabulary, not the layout. " +
      "Dressing passes read these when placing lights so a re-skin changes the light along with the walls.",
  );

export const themeSchema = z
  .object({
    name: z.string().min(1).describe("Human-readable theme name, e.g. \"The Ossuary Vaults\"."),
    description: z
      .string()
      .optional()
      .describe("One or two sentences of art direction — what this location should feel like."),
    light: themeLightSchema.optional(),
    slots: z
      .object({
        floor: themeSlotSchema.describe("Walkable worked surfaces — room floors, corridor floors."),
        wall: themeSlotSchema.describe("Vertical worked-stone shell surfaces."),
        ceiling: themeSlotSchema.describe("Overhead shell surfaces — flat ceilings and vault faces."),
        trim: themeSlotSchema.describe(
          "Carved edging: door frames, cornices, balustrades, pilasters — the detail band between shell slots.",
        ),
        accent: themeSlotSchema.describe(
          "The theme's signature flourish — runes, bone, glow, gilt. Small doses; pairs with light.accent.",
        ),
        rock: themeSlotSchema.describe(
          "Natural/unworked stone — cave walls, tunnel shells, rubble, stalagmites. The other half of the " +
            "worked/natural mix; transition assemblies blend wall→rock.",
        ),
        wood: themeSlotSchema.describe("Structural and prop timber — beams, planking, crates, scaffolds."),
        metal: themeSlotSchema.describe("Ironmongery — grates, hinges, sconces, portcullises, banding."),
        step: themeSlotSchema.describe(
          "Stair treads and risers. Separate from `floor` because steps are cut pieces that read best with " +
            "their own tighter texture, and stairs are exactly where a wrong uvScale is most visible.",
        ),
        water: themeSlotSchema
          .optional()
          .describe("Water surfaces, when this location has any. The only optional slot — many dungeons are dry."),
      })
      .describe(
        "Role slot → texture set. Compilers and dressing passes reference SLOTS, never material ids, " +
          "so swapping the theme re-skins everything built from the same plan.",
      ),
  })
  .describe(
    "A theme data asset: the complete per-location skin. One dungeon plan + N themes = N locations. " +
      "Generate the engine material docs from it with materialsForTheme(); resolve mesh world-UV " +
      "scales with uvScaleFor().",
  );

export type Theme = z.infer<typeof themeSchema>;
export type ThemeInput = z.input<typeof themeSchema>;

/** Register the "theme" data-asset type on an AssetLibrary. */
export function registerThemeAssetType(assets: AssetLibrary): void {
  // Folded into registerCoreAssetTypes; calling both (tests, older callers) must stay safe.
  if ("theme" in assets.dataTypeJsonSchemas()) return;
  assets.defineDataType("theme", themeSchema);
}

// ---------------------------------------------------------------------------
// Material generation
// ---------------------------------------------------------------------------

/** One generated engine material doc: where to write it, the data-asset id the
 * file path yields when loaded, and the bare material payload (data-asset
 * files hold the bare `data`, never the `{ id, type, … }` wrapper). */
export interface ThemeMaterialDoc {
  /** Path under the project's assets/ dir, e.g. "materials/crypt-a-wall.json". */
  file: string;
  /** The data-asset id the loader derives from that path, e.g. "crypt-a-wall". */
  id: string;
  /** Bare material doc (validates against the engine `material` schema). */
  data: Record<string, unknown>;
}

/** The material data-asset id a slot resolves to, e.g. ("crypt-a", "wall") → "crypt-a-wall". */
export function materialIdFor(idPrefix: string, slot: ThemeSlotName): string {
  return `${idPrefix}-${slot}`;
}

/**
 * Generate one engine material doc per populated slot. Pure — returns docs;
 * callers write the files (`file` is relative to the project's assets/ dir,
 * and the loader derives exactly `id` from it).
 *
 * `repeat` is pinned [1, 1] on every doc: theme materials are world-UV — the
 * MESH carries `uv: { mode: "world", scale: uvScaleFor(theme, slot) }`, so
 * texture world-scale belongs to the slot, not the material, and re-skins
 * can't silently change it.
 */
export function materialsForTheme(theme: Theme, idPrefix: string): ThemeMaterialDoc[] {
  const out: ThemeMaterialDoc[] = [];
  for (const slotName of THEME_SLOTS) {
    const slot = theme.slots[slotName];
    if (!slot) continue; // water absent
    const data: Record<string, unknown> = {
      shader: "standard",
      color: slot.color,
      repeat: [1, 1],
    };
    if (slot.map !== undefined) data.map = slot.map;
    if (slot.normalMap !== undefined) data.normalMap = slot.normalMap;
    if (slot.roughness !== undefined) data.roughness = slot.roughness;
    if (slot.metalness !== undefined) data.metalness = slot.metalness;
    const id = materialIdFor(idPrefix, slotName);
    out.push({ file: `materials/${id}.json`, id, data });
  }
  return out;
}

/**
 * The world-UV scale (metres per texture tile) geometry textured with this
 * slot must bake as `mesh.source.uv = { mode: "world", scale }`. Returns null
 * for an absent or untextured slot (flat colour needs no world UVs) — callers
 * simply omit the `uv` override then.
 */
export function uvScaleFor(theme: Theme, slot: ThemeSlotName): [number, number] | null {
  const s = theme.slots[slot];
  if (!s || s.map === undefined || s.uvScale === undefined) return null;
  return [s.uvScale[0], s.uvScale[1]];
}

// ---------------------------------------------------------------------------
// Texture-folder on-ramp
// ---------------------------------------------------------------------------

/**
 * Filename keywords per slot, checked in this order (most specific role
 * first) — the first slot whose keyword appears in the file's lowercased
 * path wins, so "mossy-brick-wall" is a wall, not an accent.
 */
const SLOT_KEYWORDS: ReadonlyArray<readonly [ThemeSlotName, readonly string[]]> = [
  ["water", ["water"]],
  ["ceiling", ["ceil", "vault"]],
  ["step", ["step", "stair"]],
  ["trim", ["trim"]],
  ["accent", ["accent", "glow", "rune"]],
  ["rock", ["rock", "cave"]],
  ["wood", ["wood", "plank"]],
  ["metal", ["metal", "iron"]],
  ["wall", ["wall", "brick"]],
  ["floor", ["floor", "flag", "slab"]],
];

/**
 * Best-guess metres-per-tile per slot, seeded from dungeon-lab's measured
 * values (docs/uv-scale.json there). These are STARTING POINTS for a
 * folder-generated theme — eyeball each texture in the editor and correct
 * the theme doc; the report flags every guessed value.
 */
export const DEFAULT_SLOT_UV_SCALE: Readonly<Record<ThemeSlotName, readonly [number, number]>> = {
  floor: [3, 3],
  wall: [4, 4],
  ceiling: [5, 5],
  trim: [2.4, 2.4],
  accent: [2, 2],
  rock: [3.5, 3.5],
  wood: [2, 2],
  metal: [2, 2],
  step: [3, 3],
  water: [4, 4],
};

/** Graybox placeholder colours for required slots no texture matched. */
const FALLBACK_SLOT_COLOR: Readonly<Record<ThemeSlotName, string>> = {
  floor: "#6f6a62",
  wall: "#7a746b",
  ceiling: "#5d5850",
  trim: "#8a8378",
  accent: "#c8b06a",
  rock: "#6b6560",
  wood: "#7c5a3a",
  metal: "#5a5e66",
  step: "#67625b",
  water: "#3fa8c9",
};

export interface ThemeFolderReport {
  /** Slot → texture path chosen as its colour `map`. */
  assigned: Partial<Record<ThemeSlotName, string>>;
  /** Slot → texture path detected as its `normalMap`. */
  normalMaps: Partial<Record<ThemeSlotName, string>>;
  /** Files no slot claimed (junk, unrecognised names, duplicate matches for an already-filled slot). */
  unassigned: string[];
  /** Slots whose uvScale is a DEFAULT_SLOT_UV_SCALE guess, not a measured value — verify by eye. */
  guessedUvScale: ThemeSlotName[];
}

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const NORMAL_HINT = /normal|(?:[_-]n)(?=\.[a-z]+$)/i;

function matchSlot(file: string): ThemeSlotName | null {
  const hay = file.toLowerCase();
  for (const [slot, keywords] of SLOT_KEYWORDS) {
    if (keywords.some((k) => hay.includes(k))) return slot;
  }
  return null;
}

/**
 * Build a best-effort theme doc from a folder of generated textures — the
 * on-ramp from an image-generator output drop (`assets/textures/<theme>/`) to
 * a working theme. `files` are texture paths RELATIVE TO assets/textures/
 * (which is exactly the texture asset id, extension included).
 *
 * Deterministic: files are matched in the given order, first match per slot
 * wins; files containing a normal-map hint ("normal", "_n"/"-n" suffix)
 * become the matched slot's `normalMap` instead of its `map`. Everything
 * unclaimed lands in `report.unassigned` — an empty `unassigned` plus an
 * empty `guessedUvScale` is the "nothing to review" signal.
 *
 * `opts.defaults` overrides per-slot fields AFTER matching (the way to supply
 * measured uvScales, tints, or a hand-picked map the keywords missed); a slot
 * whose uvScale came from `defaults` is not reported as guessed. The returned
 * theme is fully parsed (schema-valid); required slots with no texture fall
 * back to graybox placeholder colours.
 */
export function themeFromTextureFolder(
  files: string[],
  opts: {
    name: string;
    description?: string;
    light?: z.input<typeof themeLightSchema>;
    defaults?: Partial<Record<ThemeSlotName, Partial<ThemeSlotInput>>>;
  },
): { theme: Theme; report: ThemeFolderReport } {
  const report: ThemeFolderReport = { assigned: {}, normalMaps: {}, unassigned: [], guessedUvScale: [] };

  const images = files.filter((f) => IMAGE_EXT.test(f));
  report.unassigned.push(...files.filter((f) => !IMAGE_EXT.test(f)));

  // Pass 1: colour maps. Pass 2: normal maps (so a normal never steals a slot's map).
  const normals: string[] = [];
  for (const file of images) {
    if (NORMAL_HINT.test(file.split("/").pop() ?? file)) {
      normals.push(file);
      continue;
    }
    const slot = matchSlot(file);
    if (slot && report.assigned[slot] === undefined) report.assigned[slot] = file;
    else report.unassigned.push(file);
  }
  for (const file of normals) {
    const slot = matchSlot(file);
    if (slot && report.assigned[slot] !== undefined && report.normalMaps[slot] === undefined) {
      report.normalMaps[slot] = file;
    } else {
      report.unassigned.push(file);
    }
  }

  const slots: Record<string, ThemeSlotInput> = {};
  for (const slotName of THEME_SLOTS) {
    const map = report.assigned[slotName];
    const defaults = opts.defaults?.[slotName];
    if (map === undefined && defaults === undefined && slotName === "water") continue; // stays absent
    const slot: ThemeSlotInput = map !== undefined
      ? { map, color: "#ffffff", uvScale: [...DEFAULT_SLOT_UV_SCALE[slotName]] as [number, number] }
      : { color: FALLBACK_SLOT_COLOR[slotName] };
    const normalMap = report.normalMaps[slotName];
    if (normalMap !== undefined) slot.normalMap = normalMap;
    if (map !== undefined && !defaults?.uvScale) report.guessedUvScale.push(slotName);
    slots[slotName] = { ...slot, ...defaults };
  }

  const theme = themeSchema.parse({
    name: opts.name,
    ...(opts.description !== undefined ? { description: opts.description } : {}),
    ...(opts.light !== undefined ? { light: opts.light } : {}),
    slots,
  });
  return { theme, report };
}
