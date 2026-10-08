/**
 * Where a town resident goes in the scene graph, and the culling it carries (tools/town-npcs.mts).
 * Pure functions over a scene document so they can be tested without a world or a GPU.
 *
 * docs/culling.md: a small thing in a place is culled by SCREEN SIZE; a building's furnishings
 * and anyone standing inside it go under that building's INTERIOR unit, so they are hidden from
 * outside the building and arrive as the camera reaches its door.
 */
import * as THREE from "three";

export type PlacementEntity = { parent: string | null; components: Record<string, unknown> };
type Transform = { position?: number[]; rotation?: number[]; scale?: number[] };

/**
 * Every resident root's culling: a person is a few render pixels from about 100 m (a 1.8 m body at
 * 6 px in a 480-line frame), and then costs a skinned draw plus its shadow draws for nothing.
 * Behind-terrain occlusion keeps its default.
 */
export const RESIDENT_CULLING = { occlusion: true, minScreenPx: 6, interior: false, reveal: 12 };

const isInterior = (e: PlacementEntity | undefined): boolean =>
  !!e && (e.components["culling"] as { interior?: boolean } | undefined)?.interior === true;

/**
 * The interior unit a resident standing `inside` belongs under: `inside` names either that unit
 * (an entity with `culling.interior`) or a building whose direct child is one. Null if neither.
 */
export function interiorUnitFor(entities: Record<string, PlacementEntity>, inside: string): string | null {
  if (isInterior(entities[inside])) return inside;
  if (!entities[inside]) return null;
  for (const [id, e] of Object.entries(entities)) if (e.parent === inside && isInterior(e)) return id;
  return null;
}

function localMatrix(t: Transform | undefined, out: THREE.Matrix4): THREE.Matrix4 {
  const p = t?.position ?? [0, 0, 0], r = t?.rotation ?? [0, 0, 0, 1], s = t?.scale ?? [1, 1, 1];
  return out.compose(new THREE.Vector3(p[0], p[1], p[2]), new THREE.Quaternion(r[0], r[1], r[2], r[3]), new THREE.Vector3(s[0], s[1], s[2]));
}

/** An entity's world matrix from the document's transform chain. */
export function worldMatrixOf(entities: Record<string, PlacementEntity>, id: string): THREE.Matrix4 {
  const world = new THREE.Matrix4();
  const m = new THREE.Matrix4();
  for (let at: string | null = id; at; at = entities[at]?.parent ?? null) {
    world.premultiply(localMatrix(entities[at]?.components["transform"] as Transform | undefined, m));
  }
  return world;
}

/**
 * A world position and yaw (radians about +Y) expressed under `parent`, so the resident stands
 * where the town doc says whatever the building's own transform is. Null parent = world.
 */
export function placeUnder(
  entities: Record<string, PlacementEntity>,
  parent: string | null,
  world: [number, number, number],
  yaw: number,
): { position: [number, number, number]; rotation: [number, number, number, number] } {
  const target = new THREE.Matrix4().compose(
    new THREE.Vector3(...world),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw),
    new THREE.Vector3(1, 1, 1),
  );
  if (parent) target.premultiply(worldMatrixOf(entities, parent).invert());
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  target.decompose(p, q, s);
  return { position: [p.x, p.y, p.z], rotation: [q.x, q.y, q.z, q.w] };
}
