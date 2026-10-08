import { z } from "zod";
import type { ComponentRegistry } from "./registry.js";

/**
 * Projected "sticker" detail — cracks, moss patches, drips, scorch marks,
 * carved runes — placed at a specific world point to break texture tiling and
 * carry local storytelling. The doc holds only INTENT (texture, size,
 * projection); the renderer projects it onto whatever geometry sits behind it
 * (three's DecalGeometry — clipped, fitted, z-offset) at build time and
 * re-projects live when the decal or nearby geometry changes, so the JSON
 * stays truth and nothing hand-authors fitted geometry.
 *
 * Zod-only module (like placement.ts/physics.ts) so registerCoreComponents can
 * import it without pulling any renderer dependency into a circular init.
 *
 * Local tuple/hex helpers are duplicated from core.ts on purpose: importing
 * them from core.ts would make this module circular with the file that
 * registers it.
 */
const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "expected hex color like #ff8800");

export const decalSchema = z
  .object({
    texture: z
      .string()
      .min(1)
      .describe(
        "Texture asset id (assets/textures/) for the decal's color map — normally an image with meaningful alpha, " +
          "because the alpha channel IS the sticker's silhouette (crack, moss patch, drip, scorch, carved rune). " +
          "A fully opaque texture reads as a hard-edged projected rectangle. Sampled as sRGB color.",
      ),
    size: z
      .tuple([z.number().positive(), z.number().positive()])
      .default([1, 1])
      .describe(
        "Projected size [width, height] in METRES on the receiving surface. World-space and authoritative — the " +
          "entity's scale does not resize the decal; edit this instead. The projection box is width x height across " +
          "and `depth` deep, centered on the entity.",
      ),
    depth: z
      .number()
      .positive()
      .default(0.25)
      .describe(
        "Projection box depth in metres along the projection direction — how far the decal wraps onto geometry in " +
          "front of and behind the entity's position. Larger values wrap around corners and catch rougher surfaces, " +
          "but also smear across unrelated geometry passing through the box; pair with `fadeDepth` so the wrapped " +
          "ends feather out instead of ending in a hard clip.",
      ),
    rotation: z
      .number()
      .default(0)
      .describe(
        "Spin around the projection axis, in DEGREES — rotates the sticker on the surface without touching the " +
          "entity's transform (so a wall-snapped entity keeps the solver's orientation while the rune tilts).",
      ),
    direction: vec3
      .default([0, 0, -1])
      .describe(
        "LOCAL projection direction — the entity's transform aims the decal; this says which local axis fires into " +
          "the surface. The default [0,0,-1] is exactly what the placement solver's `placement.snap: \"wall\"` " +
          "produces: it backs the entity against the wall with local +Z facing into the room, so -Z points straight " +
          "into the wall. For `snap: \"ground\"`/`\"ceiling\"` (which keep the authored upright rotation) use " +
          "[0,-1,0] / [0,1,0]. Place the decal entity ON the surface — the solver's snap does this — and the box " +
          "extends half of `depth` to each side of it.",
      ),
    opacity: z
      .number()
      .min(0)
      .max(1)
      .default(1)
      .describe(
        "Overall decal opacity 0..1, multiplied with the texture's own alpha. Weathering usually reads better " +
          "slightly translucent (0.7-0.9) so the base material's texture shows through.",
      ),
    color: hexColor
      .default("#ffffff")
      .describe(
        "Tint multiplied over the texture. #ffffff = the texture as-authored; darken toward the theme's grime tone, " +
          "or tint a grayscale generic (one crack texture serves stone and plaster via tint).",
      ),
    emissive: hexColor
      .optional()
      .describe(
        "Self-lit color multiplied by the same decal texture, for glowing runes or hot scars. " +
          "Omit for ordinary non-emissive detail (black). Texture alpha, opacity and depth feathering still " +
          "clip the glow to the projected mark. Bloom depends on the scene's post-processing; this does not cast light.",
      ),
    emissiveIntensity: z
      .number()
      .nonnegative()
      .optional()
      .describe(
        "Multiplier for emissive color; defaults to 1 when omitted. Zero disables emission. " +
          "Has no visible effect without a non-black emissive color; values above 1 can drive scene bloom.",
      ),
    filter: z
      .enum(["linear", "nearest", "pixel"])
      .optional()
      .describe(
        "Texture sampling, matching material filters. Omit for existing smooth linear sampling. " +
          "Nearest keeps crisp texels up close and mipmaps in the distance; pixel disables mipmaps for " +
          "hard sampling at every distance. Author the texture resolution relative to size to match world texel density.",
      ),
    fadeDepth: z
      .number()
      .positive()
      .optional()
      .describe(
        "Optional alpha falloff, in metres, near the projection box's depth limits: geometry caught within this " +
          "distance of the box's front/back planes fades to transparent, so wrapped edges feather out instead of " +
          "slicing off mid-surface. Omit for a hard clip at the box.",
      ),
    sortOffset: z
      .number()
      .optional()
      .describe(
        "Render-order bias for stacked decals on the same surface (higher draws later, i.e. on top). Omit unless " +
          "decals overlap and flicker or sort wrongly against each other.",
      ),
  })
  .describe(
    "Projected sticker detail: the renderer builds fitted, clipped geometry (three DecalGeometry) for whatever " +
      "static meshes intersect the projection box, and REGENERATES the projection whenever the decal component is " +
      "edited, the decal entity moves, or nearby geometry is edited/moved — never author fitted geometry by hand. " +
      "Position the entity with the placement solver (`placement.snap: \"wall\"|\"ground\"|\"ceiling\"`), which puts " +
      "it ON the surface in exactly the orientation the default `direction` expects.",
  );

export type DecalData = z.infer<typeof decalSchema>;

/** Register the `decal` component (called from registerCoreComponents). */
export function registerDecalComponent(registry: ComponentRegistry): void {
  registry.register("decal", decalSchema);
}
