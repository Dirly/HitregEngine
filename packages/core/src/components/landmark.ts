import { z } from "zod";

/**
 * A landmark: geometry that must read from far beyond the zone's fog (a dungeon entrance, a POI's hero structure).
 * Runtime-only: the renderer draws the subtree with its own fog curve (packages/render/src/landmark-fog.ts) and the
 * culling system treats it as a unit that never hides by size (packages/render/src/culling.ts). docs/culling.md.
 */
export const landmarkComponentSchema = z
  .object({
    fogReach: z
      .number()
      .min(50)
      .max(4000)
      .default(600)
      .describe(
        "Metres out to which this subtree reads through the zone's fog. Its fog thickens evenly to fully opaque at " +
          "this distance (never thicker than the ground's fog, never thinner than a fraction of it), so a landmark the " +
          "zone fog hides at 200 m stands as a hazy shape out to here. Never culled by size inside it; streamed " +
          "landmarks still end at the world's farTerrain ring. Typical: 400-900 for an entrance seen across a zone.",
      ),
    silhouette: z
      .number()
      .min(0)
      .max(1)
      .default(0.6)
      .describe(
        "How dark the far landmark reads against the fog: 0 = fades toward the fog colour like the ground, 1 = a " +
          "clearly darker shape (40% under the fog colour; never a black cutout). The darkening dissolves back into the fog over the last 30% of `fogReach`, so it never " +
          "pops at the edge.",
      ),
  })
  .describe(
    "Marks a landmark — a dungeon entrance or a POI's hero structure — so it reads as a darker silhouette through " +
      "fog far past the zone's fog distance while terrain, props and plants keep the zone's fog. Put it on the " +
      "landmark's own root (the shell, not the POI root with its clutter). Its meshes get one fog variant per " +
      "material; it culls as its own unit (behind terrain only). See docs/culling.md 'Landmarks through fog'.",
  );

export type LandmarkComponentData = z.infer<typeof landmarkComponentSchema>;
