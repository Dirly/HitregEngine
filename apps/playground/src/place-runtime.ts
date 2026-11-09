import * as THREE from "three/webgpu";
import type { SceneDoc } from "@hitreg/core";
import {
  buildScene,
  type BuildOptions,
  type ClusterLodSystem,
  type CullUnit,
  type CullingSystem,
  type FoliageLodSystem,
  type StaticBatchHandle,
} from "@hitreg/render";
import { PlaceStreamer, placeContainerVisible, placeCullObjects, placeInteriorRoot, placeStreamModeFromSearch } from "./place-streamer.js";

/** What a streamed place is made of at runtime, shared by both hosts (place-streamer.ts decides when; this is how). */
export interface BuiltPlace {
  /** Lifetime token: valid during synchronous build, invalid before any unload cleanup. */
  active: boolean;
  group: THREE.Group;
  scene: THREE.Object3D;
  doc: SceneDoc;
  objects: Map<string, THREE.Object3D>;
  batch: StaticBatchHandle | null;
  units: CullUnit[];
  lods: Set<Parameters<FoliageLodSystem["register"]>[0]>;
  clusters: Set<Parameters<ClusterLodSystem["register"]>[0]>;
  rebatchTimer: ReturnType<typeof setTimeout> | null;
}

export interface PlaceRuntimeOptions {
  placesRoot: THREE.Group;
  batch: (
    root: THREE.Object3D,
    doc: SceneDoc,
    objects: Map<string, THREE.Object3D>,
    cullObjects: ReadonlyMap<string, THREE.Object3D>,
  ) => { batch: StaticBatchHandle | null; units: CullUnit[] };
  culling: CullingSystem;
  foliageLod: FoliageLodSystem;
  clusterLod: ClusterLodSystem;
  buildOptions: () => BuildOptions;
  /** The host's id-to-object map: a built place's objects join it, a freed place's leave. */
  objects: () => Map<string, THREE.Object3D>;
  precompile: (group: THREE.Object3D) => void;
  /** The place is in the scene: freeze what is still and start its scripts. */
  onBuilt: (doc: SceneDoc, objects: Map<string, THREE.Object3D>) => void;
  /** The place is leaving: drop its objects from the host's registries and scripts. */
  onFreed: (objects: Map<string, THREE.Object3D>) => void;
}

/** Merge a place's static meshes again once its models stop landing (they arrive after the build). */
const PLACE_REBATCH_DELAY_MS = 400;

export function createPlaceRuntime(host: PlaceRuntimeOptions) {
  const { placesRoot, culling, foliageLod, clusterLod } = host;
  const batchPlace = (place: BuiltPlace): void => {
    place.group.visible = placeContainerVisible(place.doc);
    for (const unit of place.units) culling.unregister(unit);
    place.batch?.dispose();
    const done = host.batch(place.scene, place.doc, place.objects, placeCullObjects(place.doc, place.objects, place.group));
    place.batch = done.batch;
    place.units = done.units;
    const interiorRoot = placeInteriorRoot(place.doc);
    if (interiorRoot !== null) {
      done.units.find((unit) => unit.options.name === interiorRoot)
        ?.gateRootVisibility(place.group, () => placeContainerVisible(place.doc));
    }
  };
  const schedulePlaceBatch = (placeId: string, place: BuiltPlace): void => {
    if (!place.active) return;
    if (place.rebatchTimer) clearTimeout(place.rebatchTimer);
    place.rebatchTimer = setTimeout(() => {
      place.rebatchTimer = null;
      if (!place.active || placeStreamer.builtOf(placeId) !== place) return;
      batchPlace(place);
      if (place.batch) host.precompile(place.batch.group);
    }, PLACE_REBATCH_DELAY_MS);
  };
  const placeBuildOptions = (placeId: string, place: BuiltPlace): BuildOptions => {
    const base = host.buildOptions();
    return {
      ...base,
      onInstancedBatch: (batch) => {
        if (!place.active) return;
        foliageLod.register(batch);
        place.lods.add(batch);
        schedulePlaceBatch(placeId, place);
      },
      onClusteredMesh: (_entityId, mesh) => {
        if (!place.active) return;
        clusterLod.register(mesh);
        place.clusters.add(mesh);
        schedulePlaceBatch(placeId, place);
      },
      onModelLoaded: (entityId, root, clips) => {
        if (!place.active || placeStreamer.builtOf(placeId) !== place) return;
        base.onModelLoaded?.(entityId, root, clips);
        schedulePlaceBatch(placeId, place);
      },
    };
  };
  const placeStreamer: PlaceStreamer<BuiltPlace> = new PlaceStreamer<BuiltPlace>({
    build: (placeId, doc) => {
      const place: BuiltPlace = {
        active: true,
        group: new THREE.Group(), scene: placesRoot, doc, objects: new Map(), batch: null, units: [],
        lods: new Set(), clusters: new Set(), rebatchTimer: null,
      };
      if (placeInteriorRoot(doc) !== null) place.group.visible = false;
      const result = buildScene(doc, placeBuildOptions(placeId, place));
      place.scene = result.scene;
      place.objects = result.objects;
      place.group.name = `place:${placeId}`;
      place.group.add(result.scene);
      placesRoot.add(place.group);
      const all = host.objects();
      for (const [id, object] of result.objects) all.set(id, object);
      batchPlace(place);
      host.precompile(place.group);
      host.onBuilt(doc, result.objects);
      return place;
    },
    free: (_placeId, place) => {
      place.active = false;
      if (place.rebatchTimer) clearTimeout(place.rebatchTimer);
      for (const unit of place.units) culling.unregister(unit);
      place.batch?.dispose();
      for (const batch of place.lods) foliageLod.unregister(batch);
      for (const mesh of place.clusters) clusterLod.unregister(mesh);
      const all = host.objects();
      for (const [id, object] of place.objects) if (all.get(id) === object) all.delete(id);
      host.onFreed(place.objects);
      place.group.removeFromParent();
      place.group.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh) return;
        // materials are shared caches (never disposed on unload — docs/performance-lessons.md); geometry is per build
        if (!mesh.userData["sharedGeometry"]) mesh.geometry?.dispose();
        if ((mesh as THREE.InstancedMesh).isInstancedMesh) (mesh as THREE.InstancedMesh).dispose();
      });
    },
  }, placeStreamModeFromSearch(location.search));
  return { placeStreamer, batchPlace, placeBuildOptions };
}
