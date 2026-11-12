/**
 * see-through scope: which hole sites belong to the place being judged.
 *
 * An outdoor route looks out over the whole world: a far scatter tree or a terrain chunk 60-100 m off (outside the
 * place, owned by the world, not the job) can show a few sentinel pixels through its foliage cutout. Such a site is
 * OUT OF PLACE — listed in the report, never counted — when BOTH hold:
 *   - none of its entities is an entity of the scene (world-streamed meshes: scatter vegetation, terrain; the probe
 *     names them by their three.js name, e.g. "Mesh"); an entity label may carry a ":<part>" suffix (a prefab's atlas)
 *   - its world estimate lies more than `withinM` (XZ) from every route sample (default 40 m: the place's own ground)
 * A site with no world estimate, or touching any scene entity, always counts.
 *
 * A CUTOUT on world-streamed meshes only (the first surface in the hole is a drawn alpha-tested face of scatter foliage or
 * a fall curtain: sky through leaves or spray) is out of place at ANY distance: the surface is there, the job does not own
 * it and cannot close it (FIX-HW8: a moor tree 25 m off the Weeping Stair's rim and the Weepwater curtain's spray edge,
 * 6-7 px each). A world mesh's seam/void/open-mesh near the route (a terrain hole) still counts.
 */
export type V3 = [number, number, number];
export const OUT_OF_PLACE_M = 40;

export function sceneOwned(label: string, sceneIds: ReadonlySet<string>): boolean {
  return sceneIds.has(label) || sceneIds.has(label.split(":")[0]!);
}

/** The XZ distance from `at` to the nearest route sample (Infinity: no samples). */
export function routeDistanceXZ(at: V3, samples: ReadonlyArray<{ at: V3 }>): number {
  let d = Infinity;
  for (const s of samples) d = Math.min(d, Math.hypot(s.at[0] - at[0], s.at[2] - at[2]));
  return d;
}

/** A part tagged or named as a rope rail (the stilt-village-kit rope rail, its collider): "rope rail", "rope_rail", "RopeRail". */
export const ROPE_RAIL = /rope[\s_.-]*rail/i;
/** A rope bridge span's rope and rag parts as streamed in a chunk (`.../bs_<span>_<seg>:mesh-rope`, `:mesh-rag`; bridges/build.mts
 *  make rope): the hand ropes, their lashing and the rags hung on them are the rail. Its `:mesh-tar` stringers and the bare segment
 *  (the wood: deck, posts, lintel) are NOT, so a seam touching them stays a hole. */
export const ROPE_SPAN_PART = /\/bs_[^/:]+_\d+:mesh-(rope|rag)$/;
/** An IRON RAILING section's or iron gate's alpha card (the graveyard standard, Derek 2026-11-10: "ONE alpha-tested plane per
 *  section"; composite-props/iron-railing-section part `p00-railing`, composite-props/iron-gate-ajar part `p04-gate-leaf`): the
 *  gaps between its painted bars are the design, so a CUTOUT site on such cards alone is an allowed opening like a rope rail. */
export const IRON_GRILLE_PART = /:p\d+-(railing|gate-leaf)$/;

/**
 * A site whose every entity is a rope rail part (by its id/label or its scene name) is an ALLOWED opening: the gaps between
 * a rope's strands are deliberate. Narrow on purpose: one non-rail entity, or no entity, keeps it a hole; hidden colliders
 * in general are not covered.
 */
export function ropeRailOpening(site: { entities: readonly string[]; cause?: string }, nameOf: (id: string) => string = (id) => id): boolean {
  return site.entities.length > 0 && site.entities.every((e) => ROPE_RAIL.test(e) || ROPE_SPAN_PART.test(e) || ROPE_RAIL.test(nameOf(e)) || ROPE_RAIL.test(nameOf(e.split(":")[0]!)) || (site.cause === "cutout" && IRON_GRILLE_PART.test(e)));
}

export function outOfPlace(site: { at: V3 | null; entities: readonly string[]; cause?: string; causes?: Record<string, number> }, samples: ReadonlyArray<{ at: V3 }>, sceneIds: ReadonlySet<string>, withinM = OUT_OF_PLACE_M): boolean {
  if (!site.at || !samples.length || !site.entities.length) return false;
  if (site.entities.some((e) => sceneOwned(e, sceneIds))) return false;
  // a streamed LANDMARK chunk (`/lm_` `/lmc_`: a job's baked build) is not scatter: its cutout still counts
  if (site.cause === "cutout" && !site.entities.some((e) => /\/lmc?_/.test(e)) && Object.keys(site.causes ?? { cutout: 1 }).every((c) => c === "cutout")) return true;
  return routeDistanceXZ(site.at, samples) > withinM;
}
