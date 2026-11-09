import * as THREE from "three/webgpu";
import { cameraPosition, color, float, materialEmissive, mix, modelWorldMatrix, modelWorldMatrixInverse, positionLocal, uniform, vec3, vec4, vertexStage, uv } from "three/tsl";
import { asNodeMaterial, cloneMaterial } from "./node-material.js";
import { materialMapsLoading, onMaterialMapsWired } from "./material-maps.js";
import { addModelFill } from "./model-fill.js";

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
/** mesh.userData key: the geometry this mesh made its own (so a shared one is never edited). */
const OWN_GEOMETRY = "uberOwnGeometry";

/** A geometry sharing `source`'s vertex attributes (never written here) with room for an index of its own. */
function ownIndexGeometry(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(source.attributes)) g.setAttribute(name, attribute);
  Object.assign(g.morphAttributes, source.morphAttributes);
  g.morphTargetsRelative = source.morphTargetsRelative;
  for (const group of source.groups) g.addGroup(group.start, group.count, group.materialIndex);
  g.name = source.name;
  g.userData = { ...source.userData };
  return g;
}
// A look can replace a mesh's material with a shared appearance material.
// Ownership follows the actual material, not a stale flag on that mesh.
const ownedMaterials = new WeakMap<THREE.Mesh, Set<THREE.Material>>();
function ownMaterial(mesh: THREE.Mesh, material: THREE.Material): THREE.Material {
  let owned = ownedMaterials.get(mesh);
  if (!owned) ownedMaterials.set(mesh, (owned = new Set()));
  if (owned.has(material)) return material;
  const copy = cloneMaterial(material);
  owned.add(copy);
  return copy;
}

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

/** Per drawn object: 1 while a part that covers others shows (applyModelPartMask sets `userData.uberCoverOn`). */
const coverOn = uniform(0, "float").onObjectUpdate(({ object }) => (object?.userData["uberCoverOn"] ? 1 : 0));

/** Materials already given a model's depth pull (a node material keeps its positionNode through clone/copy). */
const pulledMaterials = new WeakSet<THREE.Material>();

/**
 * DEPTH PULL: the model's `depthPull` extras, `{ parts: [name, ...], cm }`, draw those parts as if `cm` nearer the
 * camera. Each vertex moves along its own sightline, so it lands on the same pixel (seams cannot open, the silhouette
 * does not change) and only its depth changes: a body surface less than `cm` behind a robe stays behind it however
 * the run averages the cloth through it. Cloth over a moving body, the cheap way games do it; written by playground
 * `tools/skirt-fit.mjs --robe`. Shadows are cast from the unmoved position.
 *
 * With `back` and `origin` (geometry space) it also hides the triangles marked `uv1.y = -1` (the inner thighs:
 * seen through the open front, so not `covers`) while the camera is on the `back` side of `origin` and a covering
 * part shows (`userData.uberCoverOn`, set by applyModelPartMask): from behind they are under the robe, so all they
 * could do there is poke through it. Their three vertices fold to one point. (`uv1.y` is the hang weight of socketed
 * models, which reads only values above 0.) Converts the meshes' materials to node
 * materials once (owned copies); a later clone keeps the pull.
 */
export function applyModelDepthPull(root: THREE.Object3D): number {
  let pull: { parts: string[]; cm: number; back?: number[]; origin?: number[] } | null = null;
  root.traverse((node) => {
    const p = node.userData["depthPull"];
    if (!pull && p && Array.isArray(p.parts) && typeof p.cm === "number") pull = p as { parts: string[]; cm: number };
  });
  const index = pull ? modelPartIndex(root) : null;
  if (!pull || !index) return 0;
  const { parts, cm, back, origin } = pull as { parts: string[]; cm: number; back?: number[]; origin?: number[] };
  const bits = parts.flatMap((name) => (index[name] === undefined ? [] : [index[name]!]));
  if (bits.length === 0) return 0;
  let touched = 0;
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material || !mesh.geometry.hasAttribute("uv1")) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const next = materials.map((material) => {
      if (pulledMaterials.has(material)) return material;
      let target = material as THREE.NodeMaterial;
      if (!target.isNodeMaterial) {
        target = asNodeMaterial(ownMaterial(mesh, material));
        ownedMaterials.get(mesh)!.add(target);
      }
      let on = float(0).add(0);
      for (const bit of bits) on = on.add(uv(1).x.round().equal(float(bit)).select(float(1), float(0)));
      const world = modelWorldMatrix.mul(vec4(positionLocal, 1)).xyz;
      const nearer = world.add(cameraPosition.sub(world).normalize().mul(on.mul(cm / 100)));
      let placed = modelWorldMatrixInverse.mul(vec4(nearer, 1)).xyz;
      if (back?.length === 3 && origin?.length === 3) {
        const camera = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz;
        const behind = camera.sub(vec3(origin[0]!, origin[1]!, origin[2]!)).dot(vec3(back[0]!, back[1]!, back[2]!)).greaterThan(0);
        const hide = uv(1).y.lessThan(-0.5).and(behind).and(coverOn.greaterThan(0.5));
        placed = hide.select(vec3(origin[0]!, origin[1]!, origin[2]!), placed);
      }
      target.positionNode = placed;
      target.castShadowPositionNode = positionLocal;
      target.needsUpdate = true;
      pulledMaterials.add(target);
      return target;
    });
    mesh.material = Array.isArray(mesh.material) ? next : next[0]!;
    touched += 1;
  });
  return touched;
}

/**
 * Triangles a shown part COVERS, left out of the draw while it shows: the model's `covers` extras (beside `parts`),
 * `{ coveringPart: [triangle, ...] }`, triangles numbered in the full index (or vertex order, non-indexed) / 3. The
 * robe back covers the back of the legs above its hem: under it they can only poke through it in a run, and a part
 * cannot be split instead (the human body uses all 32 part bits). Written by playground `tools/skirt-fit.mjs --robe`.
 * Null when nothing shown covers anything.
 */
export function coveredTriangles(root: THREE.Object3D, mask: number): Set<number> | null {
  let covers: Record<string, number[]> | null = null;
  root.traverse((node) => {
    const c = node.userData["covers"];
    if (!covers && c && typeof c === "object") covers = c as Record<string, number[]>;
  });
  const index = covers ? modelPartIndex(root) : null;
  if (!covers || !index) return null;
  let out: Set<number> | null = null;
  for (const [part, triangles] of Object.entries(covers as Record<string, number[]>)) {
    const bit = index[part];
    if (bit === undefined || (mask & (1 << bit)) === 0) continue;
    out ??= new Set();
    for (const t of triangles) out.add(t);
  }
  return out;
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
 * hands out clones that share geometry), so the first call gives each MESH
 * its own geometry before the index is touched. Ownership is recorded on the
 * mesh, not the geometry: a template whose geometry was already masked (and
 * so carries the full index) is still shared by every clone made from it —
 * with the check on the geometry, a town of NPCs all edited ONE index and the
 * last one dressed chose every body's parts. The own geometry shares the
 * vertex attributes (read-only here) and owns only its index.
 */
export function applyModelPartMask(root: THREE.Object3D, mask: number): number {
  let touched = 0;
  const covered = coveredTriangles(root, mask);
  applyModelDepthPull(root);
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const part = mesh.geometry.getAttribute("uv1");
    if (!part) return;
    if (mesh.userData[OWN_GEOMETRY] !== mesh.geometry) {
      const shared = mesh.geometry;
      const index = shared.getIndex();
      const full =
        (shared.userData[FULL_INDEX] as ArrayLike<number> | undefined) ??
        (index ? Array.from(index.array as ArrayLike<number>) : Array.from({ length: shared.getAttribute("position").count }, (_, i) => i));
      mesh.geometry = ownIndexGeometry(shared);
      mesh.geometry.userData[FULL_INDEX] = full;
      mesh.userData[OWN_GEOMETRY] = mesh.geometry;
    }
    const full = mesh.geometry.userData[FULL_INDEX] as ArrayLike<number>;
    const kept: number[] = [];
    for (let t = 0; t + 2 < full.length; t += 3) {
      // a triangle belongs to one part, so its first vertex decides
      const bit = Math.round(part.getX(full[t]!));
      if (bit >= 0 && bit < 32 && (mask & (1 << bit)) !== 0 && !covered?.has(t / 3)) kept.push(full[t]!, full[t + 1]!, full[t + 2]!);
    }
    mesh.geometry.setIndex(kept);
    mesh.userData["uberCoverOn"] = covered !== null;
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
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const next = materials.map((material) => {
      const target = ownMaterial(mesh, material) as THREE.MeshStandardMaterial;
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
    touched += 1;
  });
  return touched;
}

const authoredEmissive = new WeakMap<THREE.Material, { color: string; intensity: number; node: THREE.Node | null }>();

/** A material with an authored emissive shader, blended to the plain glow by a uniform: built once, on its first glow. */
const glowBlends = new WeakMap<THREE.Material, { on: { value: number }; node: THREE.Node }>();
type ModelGlow = { color: string; intensity: number; parts?: readonly string[] } | null;
const pendingGlows = new WeakMap<THREE.Mesh, { material: THREE.Material | THREE.Material[]; glow: ModelGlow }>();

/**
 * Glow on a NON-batched model (the fallback for a host without moving
 * batches): steady glow on the selected ubermesh parts, or the whole model
 * when parts are omitted. Pulsing glow uses the batched path. Null clears it back to
 * the material's AUTHORED emissive (a ghost's own glow), not to black.
 * Apply after appearance/material styling, as the model-look host does: glow
 * is the final layer over the dressed material, not a source for a new material.
 *
 * A whole-model glow must not touch the shader: a creature's tell steps it six times a wind-up, and each new node was a
 * new shader and pipeline, with the body undrawn until it compiled (measured 2026-11-06: 0 of 44 frames drawn through a
 * tell). The colour and intensity are material uniforms, so writing them is all a step does.
 *
 * A material with an authored emissive shader (a rim-lit character, a ghost) does need one new shader, for the blend. It
 * goes on a fresh copy, never on the material being drawn: a drawn material given a new shader has nothing to fall back
 * on, while a mesh given a new material keeps drawing the old one until the new one is ready (spreadShaderBuilds). A
 * `null` glow builds it too, so a fight's warm-up has the shader ready before the first blow.
 */
export function applyModelEmissive(root: THREE.Object3D, glow: ModelGlow): number {
  const index = modelPartIndex(root);
  const bits = glow?.parts ? [...new Set(glow.parts.flatMap((name) => index?.[name] === undefined ? [] : [index[name]!]))] : null;
  let touched = 0;
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    // A spawn's initial clear-glow can arrive before a named material's maps.
    // Owning a copy now would strand it with the flat graph forever. Keep the
    // live source until it is wired, then apply only this mesh's latest look.
    const loading = materials.filter(materialMapsLoading);
    if (loading.length) {
      const previous = pendingGlows.get(mesh);
      pendingGlows.set(mesh, { material: mesh.material, glow });
      if (previous?.material !== mesh.material) {
        for (const material of loading) onMaterialMapsWired(material, () => {
          const pending = pendingGlows.get(mesh);
          if (!pending) return;
          if (mesh.material !== pending.material) {
            pendingGlows.delete(mesh);
            return;
          }
          const current = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          if (current.some(materialMapsLoading)) return;
          pendingGlows.delete(mesh);
          applyModelEmissive(mesh, pending.glow);
        });
      }
      touched += 1;
      return;
    }
    const next = materials.map((material) => {
      let target = ownMaterial(mesh, material) as THREE.MeshStandardMaterial & THREE.NodeMaterial;
      if (glow?.parts && !target.isNodeMaterial) {
        const previous = authoredEmissive.get(target);
        target = asNodeMaterial(target) as THREE.MeshStandardMaterial & THREE.NodeMaterial;
        ownedMaterials.get(mesh)!.add(target);
        if (previous) authoredEmissive.set(target, previous);
      }
      if (target.emissive) {
        // Named creature overrides bypass the glTF rim/appearance path.
        // The initial owned copy is not on screen yet; install its floor
        // there, once. Rigid held models use the moving-material path.
        if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) addModelFill(target);
        // what the material was authored with, kept from before the first glow
        let authored = authoredEmissive.get(target);
        if (!authored) authoredEmissive.set(target, (authored = {
          color: `#${target.emissive.getHexString()}`,
          intensity: target.emissiveIntensity,
          node: target.emissiveNode ?? null,
        }));
        const selected = glow !== null && bits !== null;
        if (target.isNodeMaterial && authored.node && target.emissiveNode === authored.node && !selected && !glowBlends.has(target)) {
          const fresh = (target === material ? cloneMaterial(target) : target) as typeof target;
          ownedMaterials.get(mesh)!.add(fresh);
          authoredEmissive.set(fresh, authored);
          const on = uniform(0, "float");
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          glowBlends.set(fresh, { on, node: mix(authored.node as any, materialEmissive, on) });
          target = fresh;
        }
        target.emissive.set(glow && !selected ? glow.color : authored.color);
        target.emissiveIntensity = glow && !selected ? glow.intensity : authored.intensity;
        if (target.isNodeMaterial) {
          if (selected) {
            // Part ids are constant per triangle. Evaluate in the vertex stage
            // so the selection cannot track the atlas's texture coordinates.
            let mask = float(0).add(0);
            if (mesh.geometry.hasAttribute("uv1")) {
              for (const bit of bits!) mask = mask.add(uv(1).x.round().equal(float(bit)).select(float(1), float(0)));
            }
            // Authored custom nodes have Three's broad Node type; the TSL
            // expression supports the same vector addition as materialEmissive.
            const base = (authored.node ?? materialEmissive) as typeof materialEmissive;
            target.emissiveNode = base.add(color(glow.color).mul(glow.intensity).mul(vertexStage(mask)));
            target.needsUpdate = true;
          } else {
            const blend = glowBlends.get(target);
            if (blend) blend.on.value = glow ? 1 : 0;
            const node = blend?.node ?? authored.node;
            if (target.emissiveNode !== node) {
              target.emissiveNode = node;
              target.needsUpdate = true;
            }
          }
        }
      }
      return target;
    });
    mesh.material = Array.isArray(mesh.material) ? next : next[0]!;
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
