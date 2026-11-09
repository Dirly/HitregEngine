import { z } from "zod";

/**
 * How a placed place (a POI, a dressing group, a town) streams on a CLIENT. Runtime-only: the place stays authored
 * in the scene doc; the client builds its subtree when the focus comes within `distance` of its footprint and frees
 * it past `distance + keepPadding`. `landmark` subtrees inside it stay built for the far view. Servers and headless
 * tools never stream places (gameplay authority sees every collider, anchor and spawn). Parentless roots tagged
 * `poi`, `poi:<id>` or `town:<id>` use defaults without this component; nested boundaries require it explicitly.
 * docs/culling.md "Places stream".
 */
export const placeStreamSchema = z
  .object({
    mode: z
      .enum(["proximity", "always"])
      .default("proximity")
      .describe("proximity: built only near the focus. A parentless always root stays built; a nested always root inherits its enclosing place instead of creating a separate boundary."),
    distance: z
      .number()
      .min(0)
      .max(4000)
      .default(300)
      .describe(
        "Metres from the edge of the place's footprint (its entities' origins, padded) at which it is built. Past " +
          "the world's full-detail ring (~150 m) detail reads only as a silhouette; landmarks carry the far view.",
      ),
    keepPadding: z
      .number()
      .min(0)
      .max(2000)
      .default(100)
      .describe("Hysteresis: a built place is freed only past distance + keepPadding, so walking a boundary never rebuilds it."),
    footprintPadding: z
      .number()
      .min(0)
      .max(2000)
      .default(16)
      .describe("Metres added around the footprint of entity origins to cover mesh extents. Use a measured smaller padding for an explicitly streamed interior room; distance is measured from this padded footprint."),
  })
  .describe(
    "Client-side streaming for a static place or nested room root. Parentless poi / poi:<id> / town:<id> roots stream " +
      "with defaults. Only an explicit nested proximity component creates an independent boundary, even beneath a " +
      "landmark; nested tags alone inherit the parent. Render boundaries detach at world transforms without changing " +
      "the authored hierarchy or server physics. Root mode 'always' stays built; nested mode 'always' inherits its enclosing place.",
  );

export type PlaceStreamData = z.infer<typeof placeStreamSchema>;
