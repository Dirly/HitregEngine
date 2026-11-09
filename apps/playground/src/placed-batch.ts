import * as THREE from "three/webgpu";
import { interiorEnclosures, propRevealIndex, shadowlessEntities, type InteriorEnclosure, type SceneDoc } from "@hitreg/core";
import {
  batchStaticMeshes,
  cullRootIndex,
  cullRootsOf,
  registerCullRoots,
  type CullUnit,
  type CullingSystem,
  type PropSheets,
  type StaticBatchHandle,
} from "@hitreg/render";
import { ungatedBaseUnits } from "./ground-gate.js";
import { STILL_COMPONENTS } from "./still-components.js";

/**
 * What merges and what hides, shared by both hosts. The published game once had none of it: every house, wall and prop
 * drew on its own, 2,255 draws where the editor's play mode drew ~430.
 */

/** Side of the square world cells that POI-tagged static meshes merge within (metres). */
const STATIC_BATCH_CELL = 256;
/** Side of the cells small props merge within per hide bucket (metres): a bucket's unit bounds stay tight. */
const PROP_HIDE_CELL = 64;
const groundGateBox = new THREE.Box3();

type StillScript = { stillWith?: (params: Record<string, unknown>) => boolean } | undefined;

/** Which entities never move and which cast no shadow, memoized per expansion of `getDoc`. */
export function createStillness(getDoc: () => SceneDoc | null, scriptClass: (name: string) => StillScript) {
  const scriptKeepsStill = (data: unknown): boolean => {
    const script = data as { name?: string; params?: Record<string, unknown> } | undefined;
    if (!script?.name) return false;
    return scriptClass(script.name)?.stillWith?.(script.params ?? {}) === true;
  };
  let autoStaticDoc: SceneDoc | null = null;
  const autoStaticMemo = new Map<string, boolean>();
  const isAutoStatic = (id: string): boolean => {
    if (autoStaticDoc !== getDoc()) {
      autoStaticDoc = getDoc();
      autoStaticMemo.clear();
    }
    const known = autoStaticMemo.get(id);
    if (known !== undefined) return known;
    const entity = getDoc()?.entities[id];
    let still = !!entity && Object.keys(entity.components).every((k) => STILL_COMPONENTS.has(k) || (k === "script" && scriptKeepsStill(entity.components[k])));
    if (still && entity!.parent) still = isAutoStatic(entity!.parent);
    autoStaticMemo.set(id, still);
    return still;
  };

  // interior furnishings and small props cast no shadow (core shadowlessEntities; every caster is a draw per cascade)
  let shadowlessDoc: SceneDoc | null = null;
  let shadowlessSet = new Set<string>();
  const isShadowless = (id: string): boolean => {
    const doc = getDoc();
    if (shadowlessDoc !== doc) {
      shadowlessDoc = doc;
      shadowlessSet = doc ? shadowlessEntities(doc) : new Set();
    }
    return shadowlessSet.has(id);
  };

  /** Is this entity AND everything under it still (see isAutoStatic)? Memoized per expansion. */
  let subtreeStillDoc: SceneDoc | null = null;
  const subtreeStillMemo = new Map<string, boolean>();
  let entityChildren = new Map<string, string[]>();
  const subtreeStill = (id: string): boolean => {
    if (subtreeStillDoc !== getDoc()) {
      subtreeStillDoc = getDoc();
      subtreeStillMemo.clear();
      entityChildren = new Map();
      for (const [childId, entity] of Object.entries(getDoc()?.entities ?? {})) {
        if (!entity.parent) continue;
        const list = entityChildren.get(entity.parent);
        if (list) list.push(childId);
        else entityChildren.set(entity.parent, [childId]);
      }
    }
    const known = subtreeStillMemo.get(id);
    if (known !== undefined) return known;
    let still = isAutoStatic(id);
    if (still) for (const child of entityChildren.get(id) ?? []) if (!subtreeStill(child)) { still = false; break; }
    subtreeStillMemo.set(id, still);
    return still;
  };
  // a room's light -> the structure that encloses it (core interiorEnclosures): the light budget holds it to that box
  let enclosureDoc: SceneDoc | null = null;
  let enclosures = new Map<string, InteriorEnclosure>();
  const lightEnclosure = (id: string): InteriorEnclosure | undefined => {
    const doc = getDoc();
    if (enclosureDoc !== doc) {
      enclosureDoc = doc;
      enclosures = doc ? interiorEnclosures(doc) : new Map();
    }
    return enclosures.get(id);
  };

  return { isAutoStatic, isShadowless, subtreeStill, lightEnclosure };
}

export interface PlacedBatcherOptions {
  culling: CullingSystem;
  sheets: PropSheets | undefined;
  subtreeStill: (id: string) => boolean;
}

/**
 * Batch a built tree of placed content and register its culling units (the base scene, or one streamed place):
 * authored units merge alone, the rest per STATIC_BATCH_CELL, every unit gated on streamed ground.
 */
export function createPlacedBatcher({ culling, sheets, subtreeStill }: PlacedBatcherOptions) {
  return (
    root: THREE.Object3D,
    doc: SceneDoc | null,
    objects: Map<string, THREE.Object3D>,
    cullObjects: ReadonlyMap<string, THREE.Object3D> = objects,
  ): { batch: StaticBatchHandle | null; units: CullUnit[] } => {
    // a `culling` or `landmark` entity's meshes merge apart from the rest, so it can hide (and fog) alone
    const cullRoots = doc ? cullRootsOf(doc) : [];
    const cullRootOf = cullRootIndex(cullRoots);
    // Merge groups. An AUTHORED culling unit (a `culling` component: an
    // interior, a clutter set) keeps its own merge so it can hide alone. A
    // unit that exists only because its entity is tagged `poi` (every town
    // building) only ever hid behind the horizon — and one unit per building
    // left every material of every house as its own draw (~110 of a town's
    // 240 main-pass draws). Those merge by STATIC_BATCH_CELL instead: a few draws per
    // cell, still frustum- and screen-size-culled cell by cell.
    const cullRootById = new Map(cullRoots.map((root) => [root.id, root]));
    const authoredUnit = (rootId: string | undefined): string | undefined => {
      for (let root = rootId ? cullRootById.get(rootId) : undefined; root; root = root.parent ? cullRootById.get(root.parent) : undefined) {
        const components = doc?.entities[root.id]?.components;
        if (components?.["culling"] || components?.["landmark"]) return root.id;
      }
      return undefined;
    };
    // A mesh wider than a batch cell (an ocean plane) does not stand on any one cell's ground: it merges apart, in
    // `wide`, which the ground gate below leaves alone.
    const cellOf = (mesh: THREE.Mesh): string => {
      if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
      const radius = (mesh.geometry.boundingSphere?.radius ?? 0) * mesh.matrixWorld.getMaxScaleOnAxis();
      if (radius > STATIC_BATCH_CELL) return "wide";
      const e = mesh.matrixWorld.elements;
      return `cell:${Math.floor(e[12]! / STATIC_BATCH_CELL)},${Math.floor(e[14]! / STATIC_BATCH_CELL)}`;
    };
    // Small catalogued props hide by distance (propHideIndex: from their dressing size/category; docs/culling.md
    // "Props hide by size"): merged per hide bucket per PROP_HIDE_CELL so each bucket's unit has tight bounds.
    const hideOf = doc ? propRevealIndex(doc) : new Map<string, number>();
    const hideKey = (mesh: THREE.Mesh): string | undefined => {
      const reveal = hideOf.get(mesh.userData["entityId"] as string);
      if (reveal === undefined) return undefined;
      const e = mesh.matrixWorld.elements;
      return `hide:${reveal}:${Math.floor(e[12]! / PROP_HIDE_CELL)},${Math.floor(e[14]! / PROP_HIDE_CELL)}`;
    };
    const batch = batchStaticMeshes(root, {
      sheets,
      // A room owns its furniture before generic distance buckets: otherwise a 12 m interior's
      // meshes escape into 60/100 m batches and still draw (including every shadow cascade) outside.
      groupOf: (mesh: THREE.Mesh) => authoredUnit(cullRootOf.get(mesh.userData["entityId"] as string)) ?? hideKey(mesh) ?? cellOf(mesh),
      // entity groups whose whole subtree is merged and still: hide them so no
      // pass walks a town of empty groups (see batchStaticMeshes)
      prunable: (node) => {
        const id = node.userData["entityId"] as string | undefined;
        return !!id && objects.get(id) === node && subtreeStill(id);
      },
    });
    const units: CullUnit[] = [];
    // Base-scene content stands on STREAMED ground: every unit (POIs, dressings, and each batch cell's merged town
    // buildings, stairs and structures) is hidden while the terrain under it has not streamed in, so nothing hangs
    // over unloaded cells kilometres off (docs/culling.md, "Over unloaded ground"). Judged on chunk load/unload only.
    units.push(...registerCullRoots(culling, cullRoots, cullObjects, batch, { grounded: true }));
    for (const [key, group] of batch?.groups ?? []) {
      if (key.startsWith("cell:")) units.push(culling.register({ name: `static-${key}`, objects: [group], grounded: true }));
      else if (key.startsWith("hide:")) {
        const reveal = Number(key.split(":")[1]);
        // outdoor props: past their reveal distance they leave the screen but keep their shadows inside shadow range
        units.push(culling.register({ name: `props-${key}`, objects: [group], grounded: true, interior: true, reveal, shadowWhenHidden: true }));
      }
    }
    // placed creatures (populate's `npc` roots) stand on the same streamed ground; they move, so no horizon test
    for (const [id, entity] of Object.entries(doc?.entities ?? {})) {
      if (entity.parent !== null || cullRootOf.has(id) || !entity.tags?.includes("npc")) continue;
      const object = objects.get(id);
      if (object) units.push(culling.register({ name: id, objects: [object], grounded: true, occlusion: false }));
    }
    // still placed content outside every culling root (a town root's buildings, walls and dressing: no `poi` tag, no
    // `culling`): their meshes that did not merge (late glTF arrivals, lit windows) drew at any distance over unloaded
    // ground (p-perf 2026-11-02, Bell Strand's shells seen from the Moon Gate 1.9 km off). Gate each child of such a
    // root, or the root itself when it has no children.
    for (const id of ungatedBaseUnits(doc, cullRootOf, subtreeStill)) {
      const object = objects.get(id);
      if (!object) continue;
      // wider than a batch cell (a sea plane, a world-long wall): it stands on no one cell's ground, like the batch's "wide"
      const extent = groundGateBox.setFromObject(object);
      if (!extent.isEmpty() && Math.max(extent.max.x - extent.min.x, extent.max.z - extent.min.z) > 2 * STATIC_BATCH_CELL) continue;
      units.push(culling.register({ name: id, objects: [object], grounded: true, occlusion: false }));
    }
    return { batch, units };
  };
}
