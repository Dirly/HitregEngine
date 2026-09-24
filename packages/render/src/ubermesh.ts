import * as THREE from "three/webgpu";
import { cloneMaterial } from "./node-material.js";

/**
 * UBERMESH parts and looks on an ordinary (non-instanced) model — the held
 * sword, the worn helm: one model on one entity whose look changes at runtime.
 *
 * The instanced path (instancing.ts) collapses hidden parts in the vertex
 * stage from a per-instance mask, because a hundred swords share one batch.
 * A single held model has no batch to share, so here the mask is applied to
 * the geometry itself: the index is rebuilt to the triangles of the shown
 * parts. That is a few hundred indices on an equip, never per frame, and the
 * hidden parts cost nothing afterwards — not even vertex work.
 *
 * Both paths read the same data: the part index of every vertex in the
 * model's SECOND UV set (glTF TEXCOORD_1, three's `uv1`), written by
 * unwrap-weapon, and bit i of a mask shows part i.
 *
 * Part NAMES ride in the model too: unwrap-weapon writes `{ parts: { name:
 * index } }` into the ubermesh node's glTF extras, which GLTFLoader hands
 * back as `userData.parts`. So a look can say `["Blade1", "Handle"]` and
 * never carry a bit mask that silently goes stale when the model is re-cut.
 */

const FULL_INDEX = "uberFullIndex";
const OWN_MATERIAL = "uberOwnMaterial";

/** `{ partName: bitIndex }` from the first node that carries one, or null. */
export function modelPartIndex(root: THREE.Object3D): Record<string, number> | null {
  let found: Record<string, number> | null = null;
  root.traverse((node) => {
    if (found) return;
    const parts = node.userData["parts"];
    if (parts && typeof parts === "object") found = parts as Record<string, number>;
  });
  return found;
}

/**
 * A mask from part names. Unknown names are returned in `missing` rather than
 * thrown, so a look written against an older cut of the model still shows the
 * parts that do exist.
 */
export function partMaskFromNames(
  index: Record<string, number>,
  names: readonly string[],
): { mask: number; missing: string[] } {
  let mask = 0;
  const missing: string[] = [];
  for (const name of names) {
    const bit = index[name];
    if (bit === undefined) missing.push(name);
    else mask |= 1 << bit;
  }
  return { mask, missing };
}

/**
 * Show only the parts whose bit is set. Returns how many meshes carried a
 * part index (0 = this model is not an ubermesh and nothing changed).
 *
 * The loaded glTF is SHARED by every entity that uses it (the model cache
 * hands out clones that share geometry), so the first call gives each mesh
 * its own geometry before the index is touched.
 */
export function applyModelPartMask(root: THREE.Object3D, mask: number): number {
  let touched = 0;
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const part = mesh.geometry.getAttribute("uv1");
    if (!part) return;
    let full = mesh.geometry.userData[FULL_INDEX] as ArrayLike<number> | undefined;
    if (!full) {
      mesh.geometry = mesh.geometry.clone();
      const index = mesh.geometry.getIndex();
      full = index
        ? Array.from(index.array as ArrayLike<number>)
        : Array.from({ length: mesh.geometry.getAttribute("position").count }, (_, i) => i);
      mesh.geometry.userData[FULL_INDEX] = full;
    }
    const kept: number[] = [];
    for (let t = 0; t + 2 < full.length; t += 3) {
      // a triangle belongs to one part, so its first vertex decides
      const bit = Math.round(part.getX(full[t]!));
      if (bit >= 0 && bit < 31 && (mask & (1 << bit)) !== 0) kept.push(full[t]!, full[t + 1]!, full[t + 2]!);
    }
    mesh.geometry.setIndex(kept);
    // bounds of the parts actually shown, or a bare grip is culled by a blade
    // that is not there (and a long blade by a short one's box)
    mesh.geometry.computeBoundingBox();
    mesh.geometry.computeBoundingSphere();
    mesh.visible = kept.length > 0;
    touched += 1;
  });
  return touched;
}

/**
 * Swap the base-colour map of every material in this model — the THEME of an
 * ubermesh. Materials are cloned once per model instance (the loaded ones are
 * shared with every other user of the asset), then only `map` changes, so the
 * cut-out/double-sided settings the model shipped with are kept. Filtering is
 * copied from the map it replaces, so a `textureFilter: "nearest"` model stays
 * crisp. The texture must already follow glTF's convention (`flipY = false`).
 */
export function applyModelMap(root: THREE.Object3D, map: THREE.Texture): number {
  let touched = 0;
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const own = mesh.userData[OWN_MATERIAL] === true;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const next = materials.map((material) => {
      const target = (own ? material : cloneMaterial(material)) as THREE.MeshStandardMaterial;
      const previous = target.map;
      if (previous && previous !== map) {
        map.magFilter = previous.magFilter;
        map.minFilter = previous.minFilter;
      }
      target.map = map;
      target.needsUpdate = true;
      return target;
    });
    mesh.material = Array.isArray(mesh.material) ? next : next[0]!;
    mesh.userData[OWN_MATERIAL] = true;
    touched += 1;
  });
  return touched;
}

/**
 * Glow on a NON-batched model (the fallback for a host without moving
 * batches): the emissive of the model's own material copy. Whole model, steady
 * — per-part and pulsing glow are the batched path's. Null clears it.
 */
export function applyModelEmissive(root: THREE.Object3D, glow: { color: string; intensity: number } | null): number {
  let touched = 0;
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const own = mesh.userData[OWN_MATERIAL] === true;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const next = materials.map((material) => {
      const target = (own ? material : cloneMaterial(material)) as THREE.MeshStandardMaterial;
      if (target.emissive) {
        target.emissive.set(glow ? glow.color : "#000000");
        target.emissiveIntensity = glow ? glow.intensity : 1;
      }
      return target;
    });
    mesh.material = Array.isArray(mesh.material) ? next : next[0]!;
    mesh.userData[OWN_MATERIAL] = true;
    touched += 1;
  });
  return touched;
}

// ---------------------------------------------------------------------------
// anchors: points ON an item, for the effects it carries
// ---------------------------------------------------------------------------

/** A point on a model: a part (or every shown part) and where in its box. */
export interface PartAnchor {
  part?: string;
  at?: "tip" | "base" | "center" | readonly [number, number, number];
}

const PART_BOUNDS = "uberPartBounds";

/**
 * Each part's bounding box in the geometry's own space, keyed by part index
 * (uv1.x), cached on the geometry. Reads every vertex, not the current index,
 * so a part hidden by a mask still has its box.
 */
export function partBounds(geometry: THREE.BufferGeometry): Map<number, THREE.Box3> {
  // instanceof, not truthiness: geometry.clone() JSON-copies userData, turning a Map into {}
  const cached = geometry.userData[PART_BOUNDS];
  if (cached instanceof Map) return cached as Map<number, THREE.Box3>;
  const out = new Map<number, THREE.Box3>();
  const position = geometry.getAttribute("position");
  const part = geometry.getAttribute("uv1");
  const p = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    const index = part ? Math.round(part.getX(i)) : 0;
    let box = out.get(index);
    if (!box) out.set(index, (box = new THREE.Box3()));
    box.expandByPoint(p.fromBufferAttribute(position, i));
  }
  geometry.userData[PART_BOUNDS] = out;
  return out;
}

/** A part's box size in the geometry's space (every shown part when `part` is omitted); null if unknown. */
export function partSize(
  geometry: THREE.BufferGeometry,
  index: Record<string, number> | null,
  part: string | undefined,
  shownMask: number,
): THREE.Vector3 | null {
  const bounds = partBounds(geometry);
  const box = new THREE.Box3();
  if (part !== undefined) {
    const bit = index?.[part];
    const found = bit === undefined ? undefined : bounds.get(bit);
    if (!found) return null;
    box.copy(found);
  } else {
    for (const [bit, b] of bounds) if (shownMask & (1 << bit)) box.union(b);
    if (box.isEmpty()) return null;
  }
  return box.getSize(new THREE.Vector3());
}

/**
 * Resolve an anchor to a point in the geometry's space. `shownMask` is the
 * set a part-less anchor spans (the whole item as drawn). Null when the part is
 * unknown or nothing is shown.
 */
export function resolvePartAnchor(
  geometry: THREE.BufferGeometry,
  index: Record<string, number> | null,
  anchor: PartAnchor,
  shownMask: number,
  out = new THREE.Vector3(),
): THREE.Vector3 | null {
  const bounds = partBounds(geometry);
  const box = new THREE.Box3();
  if (anchor.part !== undefined) {
    const bit = index?.[anchor.part];
    const found = bit === undefined ? undefined : bounds.get(bit);
    if (!found) return null;
    box.copy(found);
  } else {
    for (const [bit, b] of bounds) if (shownMask & (1 << bit)) box.union(b);
    if (box.isEmpty()) return null;
  }
  const size = box.getSize(new THREE.Vector3());
  const at = anchor.at ?? "center";
  let f: [number, number, number];
  if (Array.isArray(at)) {
    f = [at[0], at[1], at[2]];
  } else {
    f = [0.5, 0.5, 0.5];
    if (at !== "center") {
      const axis = size.x >= size.y && size.x >= size.z ? 0 : size.y >= size.z ? 1 : 2;
      f[axis] = at === "tip" ? 1 : 0;
    }
  }
  return out.set(box.min.x + size.x * f[0], box.min.y + size.y * f[1], box.min.z + size.z * f[2]);
}
