/**
 * Ground ROLES a zone may restyle (recipe `regions[].ground`).
 *
 * `grass`, `ground`, `cliff` and `accent` are NATURAL roles: a palette surface
 * tagged with one (`surfaces[].role`) is what the zone's surface replaces,
 * blended by zone membership. `road` and `paving` are PAINT roles: they come
 * from the road being painted (`features.roads[].role`), so a road's dirt
 * becomes the zone's road surface without the zone's open dirt becoming road.
 */
export const SURFACE_ROLES = ["grass", "ground", "cliff", "road", "paving", "accent"] as const;
export type SurfaceRole = (typeof SURFACE_ROLES)[number];
/** The roles a palette surface can be tagged with (paint roles come from roads). */
export const NATURAL_SURFACE_ROLES = ["grass", "ground", "cliff", "accent"] as const;
export type NaturalSurfaceRole = (typeof NATURAL_SURFACE_ROLES)[number];
