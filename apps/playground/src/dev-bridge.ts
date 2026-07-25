import * as THREE from "three/webgpu";
import type CameraControls from "camera-controls";
import {
  buildEngineSpec,
  type AssetLibrary,
  type ComponentRegistry,
  type EventRegistry,
  type SceneDoc,
  type SceneStore,
} from "@hitreg/core";
import type { BuiltScene } from "@hitreg/render";
import type { PhysicsSim } from "@hitreg/physics";
import type { EventBus, ScriptRegistry } from "@hitreg/scripting";
import type { EditingPrefab, ModelBones, Observable, PlayMode, Selection } from "@hitreg/editor";
import type { ChunkManager } from "./chunk-manager.js";
import type { SubsceneManager } from "./subscene-manager.js";
import type { NetPresence } from "./net-presence.js";
import type { BillboardSystem } from "@hitreg/render";

export interface DevBridgeDeps {
  registry: ComponentRegistry;
  assets: AssetLibrary;
  events: EventRegistry;
  camera: THREE.PerspectiveCamera;
  controls: CameraControls;
  store: SceneStore;
  selection: Selection;
  editingPrefab: EditingPrefab;
  playMode: Observable<PlayMode>;
  modelNodes: Record<string, string[]>;
  modelBones: ModelBones;
  chunkManager: ChunkManager;
  subsceneManager: SubsceneManager;
  billboards: BillboardSystem;
  scriptRegistry: ScriptRegistry;
  seeded: boolean;
  sceneLoadError: string;
  netSuspended: Set<string>;
  getBuilt: () => BuiltScene;
  getLastExpanded: () => SceneDoc;
  getSim: () => PhysicsSim | null;
  getEventBus: () => EventBus | null;
  getNetPresence: () => NetPresence | null;
  getReconcileCount: () => number;
  getRebuildCount: () => number;
  /** Rolling per-system frame-time breakdown (ms, smoothed) + the same
   * draw-call/triangle/LOD-tier numbers the in-canvas HUD shows — so "where
   * did the frame time go" is answerable via curl, not just a screenshot. */
  getPerf: () => {
    frame: {
      physics: number;
      scripts: number;
      chunks: number;
      foliage: number;
      render: number;
      other: number;
      total: number;
    };
    drawCalls: number;
    triangles: number;
    foliageTiers: { near: number; mid: number; far: number };
  };
}

// -- context bridge: post what the user sees for AI focus tasks -------------

const frustum = new THREE.Frustum();
const projScreen = new THREE.Matrix4();
const worldPos = new THREE.Vector3();

/**
 * One random id per page load, sent with every /__hitreg/context POST so the
 * dev-bridge server (vite.config.ts) can key its stored context per tab
 * instead of one shared global overwritten by whichever tab posts last —
 * confirmed by profiling to otherwise blend two unrelated tabs' data into
 * nondeterministic GET responses that read exactly like engine-level
 * corruption (impossible chunk counts, drawcall spikes) but aren't.
 */
const bridgeSessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function postContext(deps: DevBridgeDeps): void {
  const {
    camera,
    controls,
    store,
    selection,
    editingPrefab,
    playMode,
    modelNodes,
    modelBones,
    chunkManager,
    subsceneManager,
    billboards,
    seeded,
    sceneLoadError,
    netSuspended,
    getBuilt,
    getLastExpanded,
    getSim,
    getEventBus,
    getNetPresence,
    getReconcileCount,
    getRebuildCount,
    getPerf,
  } = deps;
  const built = getBuilt();
  const lastExpanded = getLastExpanded();
  const sim = getSim();
  const eventBus = getEventBus();
  const netPresence = getNetPresence();

  const inView: Array<{ id: string; name: string; distance: number }> = [];
  projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(projScreen);
  for (const [id, entity] of Object.entries(store.doc.entities)) {
    const object = built.objects.get(id);
    if (!object) continue;
    object.getWorldPosition(worldPos);
    if (frustum.containsPoint(worldPos)) {
      inView.push({
        id,
        name: entity.name,
        distance: Number(worldPos.distanceTo(camera.position).toFixed(2)),
      });
    }
  }
  inView.sort((a, b) => a.distance - b.distance);

  const selectedId = selection.get();
  void fetch("/__hitreg/context", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bridgeSessionId,
      scene: store.doc.name,
      editingPrefab: editingPrefab.get(),
      playMode: playMode.get(),
      selection: selectedId
        ? { id: selectedId, entity: store.doc.entities[selectedId] ?? null }
        : null,
      camera: {
        position: camera.position.toArray().map((v) => Number(v.toFixed(2))),
        target: controls.getTarget(new THREE.Vector3()).toArray().map((v) => Number(v.toFixed(2))),
      },
      inView: inView.slice(0, 25),
      modelNodes,
      modelBones: modelBones.get(),
      chunks: chunkManager.stats,
      subscenes: subsceneManager.stats,
      perf: getPerf(),
      // unresolved references (missing sheet frames etc.) — what an AI should fix
      diagnostics: billboards.diagnostics(),
      // last gameplay events delivered this play session ({ tick, name, payload })
      recentEvents: eventBus ? eventBus.trace().slice(-20) : null,
      net: netPresence?.debug() ?? null,
      // replicated session state (first 60 keys) — what every tab agrees on
      netState: netPresence
        ? Object.fromEntries(Object.entries(netPresence.netState.snapshot()).slice(0, 60))
        : null,
      // per-NPC sim probe: which layer is alive on THIS tab (net debugging)
      netProbe:
        playMode.get() === "playing"
          ? {
              docCount: Object.keys(lastExpanded.entities).length,
              objCount: built.objects.size,
              npcs: ["pet-dog", "elder", "sheep", "enemy-wolf-1"].map((id) => {
                const object = built.objects.get(id);
                return {
                  id,
                  inDoc: lastExpanded.entities[id] !== undefined,
                  inStore: store.doc.entities[id] !== undefined,
                  body: sim ? sim.getLinvel(id) !== null : false,
                  suspended: netSuspended.has(id),
                  pos: object
                    ? object.position.toArray().map((v) => Number(v.toFixed(2)))
                    : null,
                };
              }),
            }
          : null,
      debug: {
        sceneSource: seeded ? "code-fallback" : "file",
        sceneLoadError: sceneLoadError || undefined,
        // doc-change handling since boot: reconciled = patched in place,
        // rebuilt = full scene reconstruction (structural/scene-level edits)
        reconciled: getReconcileCount(),
        rebuilt: getRebuildCount(),
      },
      updatedAt: performance.now(),
    }),
  }).catch(() => undefined);
}

/**
 * Publish the live capability spec once — registrations are fixed after boot.
 * This is the running app's FULL surface (core + chunk components, core + app
 * events, built-in behaviors, data types, the ops protocol), generated from
 * the same Zod schemas that validate; an AI GETs /__hitreg/spec to learn what
 * it can build without reading docs that might have drifted.
 */
export function publishEngineSpec(
  deps: Pick<DevBridgeDeps, "registry" | "assets" | "events" | "scriptRegistry" | "getNetPresence">,
): void {
  const { registry, assets, events, scriptRegistry, getNetPresence } = deps;
  void fetch("/__hitreg/spec", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      buildEngineSpec({
        registry,
        assets,
        events,
        netState: getNetPresence()?.netState,
        scripts: scriptRegistry.describe(),
      }),
    ),
  }).catch(() => undefined);
}
