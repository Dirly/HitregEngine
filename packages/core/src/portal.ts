import { z } from "zod";
import type { NetStateStore } from "./net-state.js";
import type { EntityDoc } from "./scene.js";

/**
 * Portals — a door a player USES to be moved into another scene (an instanced
 * dungeon) and back. "Game black magic": the far side need not match the
 * facade; the player is moved by the authority to a named anchor entity.
 *
 * The state that makes the round trip survive a reconnect is ONE per-character
 * record, `portal/<bodyId>`, saved with the character beside the sheet (it is in
 * PERSISTED_PLAYER_NAMESPACES):
 *
 *   arrive   where the NEXT spawn in `scene` lands (an anchor id, or a point):
 *            written on the way out, consumed by whoever spawns the body there
 *            (a layer's join, the playground's local travel, the test harness)
 *   return   where the player came from (scene, point, yaw, origin layer):
 *            written by an entering portal, read by a returning one
 *
 * The `portal` builtin script writes the record and emits `portal.travel`; the
 * HOST (a dedicated layer, the playground in local play, the headless harness)
 * does the moving. No client ever moves itself. docs/hosting.md → "Portals".
 */
export const PORTAL_NETSTATE = "portal";

export function portalKey(bodyId: string): string {
  return `${PORTAL_NETSTATE}/${bodyId}`;
}

const vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);

export const portalArrivalSchema = z
  .object({
    scene: z.string().min(1).describe("Scene the arrival applies to; a spawn in any other scene ignores it."),
    anchor: z.string().min(1).optional().describe("Entity id in that scene whose world position and yaw the body lands on."),
    position: vec3.optional().describe("World point to land on when there is no anchor (a return point)."),
    yaw: z.number().finite().optional().describe("Heading in radians (0 = facing +Z) when landing on `position`."),
  })
  .describe("Where the next spawn in `scene` lands. Consumed (removed) by the spawn that honours it.");
export type PortalArrival = z.infer<typeof portalArrivalSchema>;

export const portalReturnSchema = z
  .object({
    scene: z.string().min(1).describe("Scene the player entered from."),
    position: vec3.describe("World point a returning portal lands the player on (in front of the entrance, outside it)."),
    yaw: z.number().finite().describe("Heading on return, radians (0 = facing +Z): away from the entrance."),
    srv: z.string().min(1).optional().describe("Cluster only: the layer the player left, asked for first on the way back."),
    portal: z.string().min(1).optional().describe("Entity id of the portal used to enter (diagnostics, quest tools)."),
  })
  .describe("Where a returning portal brings the player back to.");
export type PortalReturn = z.infer<typeof portalReturnSchema>;

export const portalRecordSchema = z
  .object({
    arrive: portalArrivalSchema.optional(),
    return: portalReturnSchema.optional(),
  })
  .describe(
    "A character's portal trip, keyed portal/<bodyId>: `arrive` (the next spawn's landing, written on the way out) and `return` " +
      "(where a returning portal sends them). Authority-written by the portal builtin and the host; saved with the character, so a " +
      "reconnect inside an instance still knows the way out.",
  );
export type PortalRecord = z.infer<typeof portalRecordSchema>;

/** Register `portal/` so writes validate and it shows in the spec. Once per store. */
export function registerPortalNetState(store: NetStateStore): void {
  store.define(PORTAL_NETSTATE, portalRecordSchema);
}

export const PORTAL_EVENTS = {
  /** authority-local: the portal script cleared a player to travel; the host moves them. */
  travel: "portal.travel",
} as const;

export const portalTravelSchema = z
  .object({
    actorId: z.string().min(1).describe("Body entity id of the traveller."),
    portalId: z.string().min(1).describe("Entity id of the portal used."),
    scene: z.string().min(1).describe("Destination scene (an instance on a cluster)."),
    back: z.boolean().describe("A RETURN trip: the destination is the traveller's `portal/<bodyId>.return` (an origin layer on a cluster), not a new instance."),
    party: z.boolean().describe("The traveller's whole party goes too (cluster: main pulls the other members into the same instance)."),
    anchor: z.string().min(1).optional().describe("Entering: the arrival anchor entity id in the destination scene."),
    returnTo: z
      .object({ position: vec3, yaw: z.number().finite() })
      .optional()
      .describe("Entering: the point (and heading) a returning portal brings the traveller back to, in THIS scene."),
  })
  .describe(
    "Emitted on the authority only (never replicated) once a portal has checked the traveller and written portal/<bodyId>. " +
      "The host acts on it: a layer asks main for the instance and transfers the character; the playground's local play swaps scenes.",
  );
export type PortalTravel = z.infer<typeof portalTravelSchema>;

export const portalEventDecls: ReadonlyArray<{ name: string; schema: z.ZodType; options: { replicate: "none" } }> = [
  { name: PORTAL_EVENTS.travel, schema: portalTravelSchema, options: { replicate: "none" } },
];

/** Metres a body is lifted above an anchor (anchors sit on the floor; a capsule body is centred on its origin, like the authored player). */
export const PORTAL_LANDING_LIFT = 1.2;

// -- poses -----------------------------------------------------------------------------------

type Quat = [number, number, number, number];
type Vec3 = [number, number, number];

function qmul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

function qrot(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  // v' = v + 2w(q×v) + 2q×(q×v)
  const cx = y * v[2] - z * v[1];
  const cy = z * v[0] - x * v[2];
  const cz = x * v[1] - y * v[0];
  const ccx = y * cz - z * cy;
  const ccy = z * cx - x * cz;
  const ccz = x * cy - y * cx;
  return [v[0] + 2 * (w * cx + ccx), v[1] + 2 * (w * cy + ccy), v[2] + 2 * (w * cz + ccz)];
}

/** Heading of a rotation, radians: where it turns +Z, measured about Y (0 = facing +Z). */
export function yawOfQuaternion(q: readonly [number, number, number, number]): number {
  const f = qrot(q as Quat, [0, 0, 1]);
  return Math.atan2(f[0], f[2]);
}

function localOf(e: EntityDoc): { p: Vec3; q: Quat; s: Vec3 } {
  const t = e.components["transform"] as { position?: number[]; rotation?: number[]; scale?: number[] } | undefined;
  const p = (t?.position?.length === 3 ? t.position : [0, 0, 0]) as Vec3;
  const q = (t?.rotation?.length === 4 ? t.rotation : [0, 0, 0, 1]) as Quat;
  const s = (t?.scale?.length === 3 ? t.scale : [1, 1, 1]) as Vec3;
  return { p, q, s };
}

/**
 * World position and heading of an entity in an EXPANDED scene doc (its
 * transform composed up the parent chain). Null when the id is not there.
 */
export function anchorPose(entities: Readonly<Record<string, EntityDoc>> | ReadonlyMap<string, EntityDoc>, id: string): { position: Vec3; yaw: number } | null {
  const get = (k: string): EntityDoc | undefined => (entities instanceof Map ? entities.get(k) : (entities as Record<string, EntityDoc>)[k]);
  let e = get(id);
  if (!e) return null;
  let { p, q } = localOf(e);
  let guard = 0;
  while (e.parent && guard++ < 64) {
    const parent = get(e.parent);
    if (!parent) break;
    const l = localOf(parent);
    const scaled: Vec3 = [p[0] * l.s[0], p[1] * l.s[1], p[2] * l.s[2]];
    const r = qrot(l.q, scaled);
    p = [r[0] + l.p[0], r[1] + l.p[1], r[2] + l.p[2]];
    q = qmul(l.q, q);
    e = parent;
  }
  return { position: [p[0], p[1], p[2]], yaw: yawOfQuaternion(q) };
}

/**
 * Where a body spawning in `scene` lands, given its portal record: the
 * arrival's anchor (looked up in the scene's expanded entities) or point.
 * `next` is the record with the arrival consumed — write it back so a later
 * respawn does not land there again. Null = no arrival for this scene (spawn
 * where the save or the spawn point says).
 */
export function resolvePortalArrival(
  record: unknown,
  scene: string,
  entities: Readonly<Record<string, EntityDoc>> | ReadonlyMap<string, EntityDoc>,
  occupied: readonly (readonly [number, number, number])[] = [],
): { position: Vec3; yaw: number; next: PortalRecord; anchor: string | null } | null {
  const parsed = portalRecordSchema.safeParse(record);
  if (!parsed.success || !parsed.data.arrive || parsed.data.arrive.scene !== scene) return null;
  const arrive = parsed.data.arrive;
  const next: PortalRecord = { ...parsed.data };
  delete next.arrive;
  if (arrive.anchor) {
    const pose = anchorPose(entities, arrive.anchor);
    if (pose) {
      const base: Vec3 = [pose.position[0], pose.position[1] + PORTAL_LANDING_LIFT, pose.position[2]];
      const position = portalArrivalSpot(base, pose.yaw, portalAnchorOf(entities, arrive.anchor).corridor, occupied);
      return { position, yaw: pose.yaw, next, anchor: arrive.anchor };
    }
  }
  if (arrive.position) return { position: [...arrive.position], yaw: arrive.yaw ?? 0, next, anchor: null };
  return null;
}

// -- arrival anchors -------------------------------------------------------------------------

export const portalAnchorSchema = z
  .object({
    corridor: z
      .number()
      .min(0)
      .max(20)
      .default(0)
      .describe(
        "Width in metres of the passage the anchor stands in (0 = open ground). Set it on an anchor inside a narrow passage: " +
          "arrivals that find the anchor taken line up along its FORWARD line (1.1 m apart, never sideways into a wall) instead of " +
          "a ring of up to 2.2 m around it, and portal installers size the return portal's trigger volume from it.",
      ),
  })
  .describe(
    "An arrival anchor of a portal (beside the `instance-entry` tag): how bodies land on it. The anchor sits on the floor, " +
      "rotated to face where the traveller should look; the body is lifted onto it and the camera turned to that heading.",
  );
export type PortalAnchor = z.infer<typeof portalAnchorSchema>;

/** The `portalAnchor` component of an entity (defaults when absent). */
export function portalAnchorOf(entities: Readonly<Record<string, EntityDoc>> | ReadonlyMap<string, EntityDoc>, id: string): PortalAnchor {
  const e = entities instanceof Map ? entities.get(id) : (entities as Record<string, EntityDoc>)[id];
  const parsed = portalAnchorSchema.safeParse(e?.components["portalAnchor"] ?? {});
  return parsed.success ? parsed.data : { corridor: 0 };
}

/**
 * Loading art of a scene a portal leads into (docs/hosting.md → "Loading art"):
 * a painted cover the client shows full-screen across the transfer, with the
 * destination's name and a progress line, until the ground there is ready.
 * One per scene, normally on its settings entity (the one carrying `sky`);
 * made by `apps/playground/tools/loading-art.mts`.
 */
export const loadingScreenSchema = z
  .object({
    image: z
      .string()
      .min(1)
      .regex(/^loading\/[^\\]+\.(png|jpe?g|webp)$/i, "expected loading/<file>.png")
      .describe(
        "The cover image, an asset path in the scene's project: loading/<scene>.png (assets/loading/). 16:9, about half the " +
          "display resolution (960x540 or 1024x576); shown with object-fit cover and smooth filtering, so a painted image is " +
          "never stair-stepped by a non-integer upscale. Raw snapshots kept beside it for review (loading/<scene>.snapshot.png) " +
          "are never named here and do not ship.",
      ),
    title: z
      .string()
      .max(80)
      .optional()
      .describe("The name shown over the art (the destination's player-facing name). Omitted: the portal's own label is used."),
    view: z
      .string()
      .max(120)
      .optional()
      .describe("Provenance only: the named view (authoring/views/views.json) or 'cam:x,y,z>look:x,y,z' the snapshot was taken from."),
    request: z
      .string()
      .max(120)
      .optional()
      .describe("Provenance only: the image-request id (apps/playground/.hitreg/image-requests/<id>.json) that painted the image."),
  })
  .describe(
    "The scene's loading screen: painted cover art shown across a portal or server transfer INTO this scene, held until its " +
      "near ground has streamed in, then faded. Data only; nothing renders it in the scene itself.",
  );
export type LoadingScreen = z.infer<typeof loadingScreenSchema>;

/** The scene's loading screen (the first entity carrying a valid `loadingScreen`), or null. */
export function loadingScreenOf(doc: { entities: Readonly<Record<string, EntityDoc>> } | null | undefined): (LoadingScreen & { entity: string }) | null {
  for (const [id, e] of Object.entries(doc?.entities ?? {})) {
    const raw = e.components["loadingScreen"];
    if (raw === undefined) continue;
    const parsed = loadingScreenSchema.safeParse(raw);
    if (parsed.success) return { ...parsed.data, entity: id };
  }
  return null;
}

/** Metres two landing bodies keep apart. */
const ARRIVAL_CLEARANCE = 0.9;

/**
 * Where ONE more body lands on an anchor others may already stand on
 * (`occupied` = their positions). The anchor itself first; then, in a
 * passage (`corridor` > 0), points 1.1 m apart along the anchor's forward
 * line — never sideways into a wall — else two rings of 1.2 and 2.2 m.
 * Falls back to the anchor when everything is taken.
 */
export function portalArrivalSpot(base: Vec3, yaw: number, corridor: number, occupied: readonly (readonly [number, number, number])[]): Vec3 {
  const free = (p: Vec3) => occupied.every((o) => Math.hypot(o[0] - p[0], o[2] - p[2]) >= ARRIVAL_CLEARANCE || Math.abs(o[1] - p[1]) > 2.5);
  if (free(base)) return base;
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  const candidates: Vec3[] = [];
  if (corridor > 0) {
    for (let i = 1; i <= 8; i++) candidates.push([base[0] + fx * 1.1 * i, base[1], base[2] + fz * 1.1 * i]);
  } else {
    for (const [r, n] of [
      [1.2, 6],
      [2.2, 10],
    ] as const) {
      for (let k = 0; k < n; k++) {
        const a = yaw + (k / n) * Math.PI * 2;
        candidates.push([base[0] + Math.sin(a) * r, base[1], base[2] + Math.cos(a) * r]);
      }
    }
  }
  return candidates.find(free) ?? base;
}

// -- walk-through trigger volumes ------------------------------------------------------------

/** The `portal` builtin's trigger-mode defaults (its params repeat them; installers and the client read them here). */
export const PORTAL_TRIGGER_DEFAULTS = {
  /** half extents in the portal entity's local space: 2.4 m wide (x), 2.6 m high (y), 1.5 m deep (z) */
  halfExtents: [1.2, 1.3, 0.75] as Vec3,
  /** box centre in the portal entity's local space: the box stands on the entity's origin (the floor) */
  offset: [0, 1.3, 0] as Vec3,
  /** metres before the volume over which the local screen darkens */
  fade: 2.5,
  /** seconds a body that just appeared (arrived) is ignored by trigger portals */
  arrivalGrace: 2,
};

export interface PortalVolume {
  half: Vec3;
  offset: Vec3;
}

const vec3Param = (v: unknown, fallback: Vec3): Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n)) ? [v[0], v[1], v[2]] : fallback;

/** The trigger volume of a `portal` script's params, or null for an interact portal. */
export function portalVolumeOf(params: Readonly<Record<string, unknown>> | undefined): PortalVolume | null {
  if (!params || params["mode"] !== "trigger") return null;
  const half = vec3Param(params["halfExtents"], PORTAL_TRIGGER_DEFAULTS.halfExtents).map((n) => Math.max(0.05, Math.abs(n))) as Vec3;
  return { half, offset: vec3Param(params["offset"], PORTAL_TRIGGER_DEFAULTS.offset) };
}

/** Distance (m) from a point in the portal entity's LOCAL space to its volume: 0 inside. */
export function portalVolumeDistance(local: readonly [number, number, number], v: PortalVolume): number {
  const dx = Math.max(Math.abs(local[0] - v.offset[0]) - v.half[0], 0);
  const dy = Math.max(Math.abs(local[1] - v.offset[1]) - v.half[1], 0);
  const dz = Math.max(Math.abs(local[2] - v.offset[2]) - v.half[2], 0);
  return Math.hypot(dx, dy, dz);
}

/** A return portal's volume from its anchor's corridor width (0 = 2.4 m): spans the passage, `height` tall, `depth` deep, standing on the floor. */
export function portalVolumeForCorridor(corridor: number, height = 2.6, depth = 1.5): { halfExtents: Vec3; offset: Vec3 } {
  const width = corridor > 0 ? corridor : 2.4;
  return { halfExtents: [width / 2, height / 2, depth / 2], offset: [0, height / 2, 0] };
}

/**
 * The host's half of a portal trip: given the traveller's current record and
 * the travel the script cleared, the record to write before the body leaves
 * (`arrive` for the destination, `return` for the way back) and the scene to
 * go to. `here` is the departure scene (the host knows its name; a script
 * does not) and, on a cluster, the layer id. A return trip with no way back
 * recorded falls back to the portal's own scene/anchor.
 */
export function portalDeparture(
  record: unknown,
  travel: PortalTravel,
  here: { scene: string; srv?: string },
): { record: PortalRecord; scene: string } {
  const parsed = portalRecordSchema.safeParse(record ?? {});
  const current: PortalRecord = parsed.success ? parsed.data : {};
  if (travel.back) {
    const back = current.return;
    if (back) {
      // the way back is used up: a later return portal elsewhere must not reuse it
      return { scene: back.scene, record: { arrive: { scene: back.scene, position: back.position, yaw: back.yaw } } };
    }
    // no recorded way back (a GM teleport, an old save): the portal's own target
    return { scene: travel.scene, record: { arrive: { scene: travel.scene, ...(travel.anchor ? { anchor: travel.anchor } : {}) } } };
  }
  const next: PortalRecord = { arrive: { scene: travel.scene, ...(travel.anchor ? { anchor: travel.anchor } : {}) } };
  if (travel.returnTo) {
    next.return = { scene: here.scene, position: travel.returnTo.position, yaw: travel.returnTo.yaw, portal: travel.portalId, ...(here.srv ? { srv: here.srv } : {}) };
  } else if (current.return) next.return = current.return;
  return { scene: travel.scene, record: next };
}
