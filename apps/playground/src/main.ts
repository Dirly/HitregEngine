import CameraControls from "camera-controls";
import * as THREE from "three/webgpu";
import {
  AssetLibrary,
  chunkDocSchema,
  chunkFileName,
  chunkLocalToWorld,
  worldToChunkLocal,
  moveEntityAcrossChunks,
  ComponentRegistry,
  EventRegistry,
  expandScene,
  FixedTimestepLoop,
  digestProfile,
  newId,
  Profiler,
  registerChunkComponents,
  PlayerDataService,
  registerCoreAssetTypes,
  registerCoreComponents,
  registerCoreEvents,
  sceneDocSchema,
  SceneStore,
  validatePrefab,
  sampleHeightmap,
  worldTransforms,
  type ApplyResult,
  type TerrainHeightfield,
  type ChunkDoc,
  type ChunkStreamerData,
  type EntityDoc,
  type NetObjectData,
  type PrefabDoc,
  type SceneDoc,
  type SpritesheetDoc,
  type SubsceneData,
} from "@hitreg/core";
import {
  AnimationSystem,
  attachPhysicsDebug,
  attachSkeletonDebug,
  attachLightDebug,
  BillboardSystem,
  buildScene,
  collectBones,
  EngineRenderer,
  FoliageLodSystem,
  ClusterLodSystem,
  gltfLoadingCount,
  GrassSystem,
  LightBudgetSystem,
  makeMeshGeometryProvider,
  ParticleSystem,
  patchMaterial,
  pathGeometry,
  reconcileScene,
  type AnimatorData,
  type BuildOptions,
  type BuiltScene,
  type MaterialData,
  type PathMeshSource,
} from "@hitreg/render";
import { AudioSystem, type AudioComponentData } from "./audio-system.js";
import { initPhysics, PhysicsSim } from "@hitreg/physics";
import {
  EventBus,
  InputService,
  registerBuiltinScripts,
  ScriptRegistry,
  ScriptRuntime,
} from "@hitreg/scripting";
import {
  createAssetSelection,
  createContextMenu,
  createDockSizes,
  createEditingPrefab,
  createEditingChunk,
  createModelBones,
  createSelection,
  createMultiSelection,
  createHover,
  createManipulating,
  defaultEditorSettings,
  GrayboxTool,
  MeshEditTool,
  TerrainTool,
  PathTool,
  createMeshEditState,
  defaultTerrainBrush,
  mountEditor,
  observable,
  ViewportTools,
  type GizmoMode,
  type GrayboxShape,
  type PlayMode,
  type TerrainBrushSettings,
  type PathCrossSection,
} from "@hitreg/editor";
import { buildStarterDoc } from "./starter-scene.js";
import { ChunkManager } from "./chunk-manager.js";
import { SubsceneManager, type SubsceneInstance } from "./subscene-manager.js";
import { BridgePlayerDataBackend } from "./player-data-bridge.js";
import { NetPresence, type NetReplica } from "./net-presence.js";
import { loadAssets } from "./asset-loader.js";
import { saveAsset, clientLog } from "./dev-log.js";
import { applyBodyState } from "./physics-sync.js";
import { bakeImpostorAtlas } from "./impostor-bake.js";
import { renderThumbnails } from "./thumbnails.js";
import { initProjectScripts } from "./project-scripts.js";
import { installLiveSync } from "./live-sync.js";
import { createPinStore } from "./pins.js";
import { postContext, publishEngineSpec } from "./dev-bridge.js";
import { openProfilerWindow } from "./profiler-window.js";

CameraControls.install({ THREE });

async function main(): Promise<void> {
  clientLog("boot: main() start");
  const canvas = document.getElementById("app") as HTMLCanvasElement;
  const hud = document.getElementById("hud")!;
  const sceneLoadingEl = document.getElementById("scene-loading")!;
  const sceneLoadingTextEl = document.getElementById("scene-loading-text")!;

  // Frame profiler: ALWAYS on, deliberately. Its per-scope cost is the same
  // two performance.now() calls the hand-rolled EMA counters it replaced were
  // already paying, and leaving it running means the profiler window opens
  // with ~15 seconds of history ALREADY RECORDED. That is the difference
  // between "reproduce the hitch again, now with the window open" and
  // "the hitch just happened — open the window and look at it".
  const profiler = new Profiler({ historyFrames: 900 });
  profiler.enabled = true;

  // Anything that blocks the main thread for >50ms, whatever it was — a GC
  // pause, shader compilation, a promise continuation parsing a chunk, an
  // extension. The profiler's own scopes only see inside the frame callback,
  // so this is what puts a name and a duration on the "off-loop" gap they
  // report but cannot explain. Not supported everywhere; failure is fine.
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        // startTime shares performance.now()'s origin, so the span lands on
        // the timeline where the stall actually was, at its true width
        profiler.recordSpan("long-task", entry.startTime, entry.duration, entry.name);
      }
    }).observe({ entryTypes: ["longtask"] });
  } catch {
    /* longtask unsupported (Safari/Firefox) — the gap number still stands */
  }

  const registry = new ComponentRegistry();
  registerCoreComponents(registry);
  registerChunkComponents(registry);
  // typed gameplay events: schema-validated like components (registry.jsonSchemas
  // is the AI-facing spec of what can be emitted/listened to)
  // core events only — project-specific contracts (a game's own
  // gameplay events) self-register from the owning script's static
  // `events` field when it loads, see the project-script loop below.
  const events = new EventRegistry();
  registerCoreEvents(events);
  const assets = new AssetLibrary();
  registerCoreAssetTypes(assets);
  // trimesh/convex colliders cook their geometry from the entity's GLB model
  const meshGeometry = makeMeshGeometryProvider((assetId) => assets.getModel(assetId)?.url);
  // distance LOD for renderMode:"instanced" props — shared across the main
  // scene build AND both streamers, so every source registers into the same
  // system and gets updated from the same camera each frame
  const foliageLod = new FoliageLodSystem();
  // cluster-DAG continuous LOD for `renderMode: "clustered"` hero meshes —
  // re-selects each mesh's cut per frame; prunes meshes streamed out itself
  const clusterLod = new ClusterLodSystem();
  // Forward-rendered point lights multiply fragment work. Share one
  // camera-relative budget across the main scene and both streamers.
  const lightBudget = new LightBudgetSystem(8);
  // "chunk sections" list for the hierarchy dock — updated on load/unload
  // (below), not per-frame: loaded cells only change when the focus crosses
  // a cell boundary, so this stays a rare React update, not a 60/sec one.
  const loadedChunkCells = observable<Array<{ world: string; cx: number; cz: number; count: number }>>([]);
  // streamed chunk worlds: runtime-only content loaded by distance to the focus
  const chunkManager = new ChunkManager(assets, registry, {
    resolveModel: (assetId) => assets.getModel(assetId)?.url,
    resolveMaterial: (assetId) => assets.getDataAsset(assetId)?.data,
    resolveTexture: (assetId) => assets.getTexture(assetId)?.url,
    resolveMaxAnisotropy: () => renderer.getMaxAnisotropy(),
    onInstancedBatch: (batch) => foliageLod.register(batch),
    onLight: (_entityId, light, importance) => lightBudget.register(light, importance),
    bakeImpostor: (object, bounds) => bakeImpostorAtlas(renderer, object, bounds),
    onClusteredMesh: (_entityId, mesh) => clusterLod.register(mesh),
  }, {
    onLoaded: (doc, objects, simulated) => {
      for (const [id, object] of objects) built.objects.set(id, object);
      // render-only LOD rings (fullRender/hlod/far) render but never simulate
      if (simulated) scripts?.addEntities(doc, objects);
      loadedChunkCells.set(chunkManager.loadedCells());
    },
    // re-parented into a freshly rebuilt scene, NOT a fresh load — every doc
    // edit triggers rebuild(), so this must stay cheap bookkeeping only (see
    // ChunkLifecycle.onReattached). Re-running scripts.addEntities here was
    // re-registering every streamed entity's scripts on every single edit —
    // for a large loaded chunk, that's the "one edit -> grinding halt" bug.
    onReattached: (doc, objects) => {
      for (const [id, object] of objects) built.objects.set(id, object);
    },
    onUnloaded: (ids) => {
      for (const id of ids) built.objects.delete(id);
      scripts?.removeEntities(ids);
      loadedChunkCells.set(chunkManager.loadedCells());
    },
    onDisposeInstancedBatch: (batch) => foliageLod.unregister(batch),
    // simulation/fullRender retier in place (chunk-manager.ts's retier()) —
    // objects are already built and already in `built.objects`; only scripts
    // need to (de)register, same as onLoaded/onUnloaded's script half.
    onSimulationGained: (doc, objects) => scripts?.addEntities(doc, objects),
    onSimulationLost: (ids) => scripts?.removeEntities(ids),
  });
  chunkManager.profiler = profiler; // chunk loads land as spans, see ChunkManager.profiler
  // additive scene modules: whole scene files placed as one-line `subscene`
  // entities, streamed by proximity (or resident with mode "always")
  const subsceneManager = new SubsceneManager(assets, registry, {
    resolveModel: (assetId) => assets.getModel(assetId)?.url,
    resolveMaterial: (assetId) => assets.getDataAsset(assetId)?.data,
    resolveTexture: (assetId) => assets.getTexture(assetId)?.url,
    resolveMaxAnisotropy: () => renderer.getMaxAnisotropy(),
    onInstancedBatch: (batch) => foliageLod.register(batch),
    onLight: (_entityId, light, importance) => lightBudget.register(light, importance),
    bakeImpostor: (object, bounds) => bakeImpostorAtlas(renderer, object, bounds),
    onClusteredMesh: (_entityId, mesh) => clusterLod.register(mesh),
  }, {
    onLoaded: (doc, objects) => {
      for (const [id, object] of objects) built.objects.set(id, object);
      scripts?.addEntities(doc, objects);
    },
    // see chunkManager's onReattached above — same fix, same reason
    onReattached: (doc, objects) => {
      for (const [id, object] of objects) built.objects.set(id, object);
    },
    onUnloaded: (ids) => {
      for (const id of ids) built.objects.delete(id);
      scripts?.removeEntities(ids);
    },
    onDisposeInstancedBatch: (batch) => foliageLod.unregister(batch),
  });

  // -- scene: files are the source of truth (fetched fresh, never bundled) ----
  // otherwise a minimal code-built starter seeds the first scene file.

  // reopen the scene the user was last editing (persisted on every switch);
  // falls back to the first scene in the index when unset or missing.
  const LAST_SCENE_KEY = "hitreg-editor-last-scene";
  const rememberLastScene = (name: string) => {
    try {
      localStorage.setItem(LAST_SCENE_KEY, name);
    } catch {
      /* private mode / storage disabled — non-fatal */
    }
  };

  let initialDoc: SceneDoc | null = null;
  let sceneLoadError = "";
  let loadedSceneContent = "";
  try {
    const preferredScene = (() => {
      try {
        return localStorage.getItem(LAST_SCENE_KEY);
      } catch {
        return null;
      }
    })();
    const content = await loadAssets(assets, preferredScene);
    if (content) {
      const parsed = sceneDocSchema.safeParse(JSON.parse(content));
      if (parsed.success) {
        initialDoc = parsed.data;
        loadedSceneContent = content;
      } else {
        sceneLoadError = parsed.error.message.slice(0, 200);
        console.warn("[scene] scene file failed validation:", parsed.error);
      }
    }
  } catch (error) {
    sceneLoadError = String(error);
    console.warn("[assets] fresh load failed:", error);
  }
  const seeded = initialDoc === null;
  const store = new SceneStore(initialDoc ?? buildStarterDoc("Untitled", registry), registry);
  rememberLastScene(store.doc.name);

  let lastWrittenScene = loadedSceneContent;
  const sceneList = observable<string[]>([]);
  try {
    const index = (await fetch("/__hitreg/assets-index").then((r) => r.json())) as {
      scenes?: string[];
    };
    sceneList.set(
      (index.scenes ?? [])
        .filter((f) => f.endsWith(".scene.json"))
        .map((f) => f.replace(/\.scene\.json$/, ""))
        .sort(),
    );
  } catch {
    /* prod build: no bridge */
  }
  if (seeded && !sceneList.get().includes(store.doc.name)) {
    sceneList.set([...sceneList.get(), store.doc.name].sort());
  }
  // -- prefab isolation editing (Unity-style): the prefab definition becomes
  // the working doc; autosave redirects to the prefab file, never a scene file
  const PREFAB_EDIT_SCENE = "__prefab-edit";
  const editingPrefab = createEditingPrefab();
  let prefabEditReturn: { scene: string } | null = null;
  let lastWrittenPrefab = "";

  // -- chunk-cell isolation editing: same Unity-style mechanism as prefab
  // editing above, but the rest of the streamed world stays visible around
  // the cell being edited (chunkManager.suppressCell hides just this one
  // cell's normal read-only copy so it isn't drawn twice; rebuild()'s
  // chunkManager.configure() call keeps the ORIGINAL streamer config alive
  // for the duration instead of losing it along with the working doc — see
  // below). Declared here (ahead of persistScene) so persistScene's first
  // call, a few lines down, doesn't hit these before they're initialized.
  const CHUNK_EDIT_SCENE = "__chunk-edit";
  const editingChunk = createEditingChunk();
  let chunkEditReturn: { scene: string; streamer: ChunkStreamerData } | null = null;
  let lastWrittenChunk = "";
  // ids relocated to a different cell already this session — moveEntityAcrossChunks
  // isn't idempotent (the destination file already has the entity after the
  // first save), so re-running it on the next autosave tick would collide;
  // skip anything already moved instead of re-attempting it every 500ms.
  let chunkEditRelocated = new Set<string>();

  /**
   * Convert the working doc back into the prefab definition. Only `entities`
   * change — `version`, `name`, `root`, and `props` are preserved verbatim.
   * New parentless entities are reparented under the original root so the
   * prefab keeps exactly one root. Returns null (with a warning) if the
   * original root was deleted or the result fails prefab validation.
   */
  function docToPrefab(prefabId: string): PrefabDoc | null {
    const original = assets.getPrefab(prefabId);
    if (!original) {
      console.warn(`[prefab-edit] prefab ${prefabId} disappeared — cannot save`);
      return null;
    }
    if (!(original.root in store.doc.entities)) {
      console.warn(
        `[prefab-edit] root entity "${original.root}" was deleted — undo, or discard the edit`,
      );
      return null;
    }
    const entities = structuredClone(store.doc.entities);
    for (const [id, entity] of Object.entries(entities)) {
      if (id !== original.root && entity.parent === null) entity.parent = original.root;
    }
    entities[original.root]!.parent = null; // the root must stay the single parentless entity
    const doc: PrefabDoc = {
      version: original.version,
      name: original.name,
      root: original.root,
      entities,
      props: structuredClone(original.props),
    };
    try {
      validatePrefab(doc);
    } catch (error) {
      console.warn("[prefab-edit] edited prefab is invalid, not saved:", error);
      return null;
    }
    return doc;
  }

  /** Autosave path while isolation-editing: definition + file + live instances. */
  function persistPrefabEdit(prefabId: string): boolean {
    const doc = docToPrefab(prefabId);
    if (!doc) return false;
    const content = JSON.stringify(doc, null, 2);
    if (content === lastWrittenPrefab) return true;
    try {
      assets.updatePrefab(prefabId, doc);
    } catch (error) {
      console.warn("[prefab-edit] definition update rejected:", error);
      return false;
    }
    lastWrittenPrefab = content;
    saveAsset(`prefabs/${prefabId}.json`, content);
    assetsVersion.set(assetsVersion.get() + 1); // open instances re-render live
    return true;
  }

  function persistScene(): void {
    const editingId = editingPrefab.get();
    if (editingId) {
      persistPrefabEdit(editingId);
      return;
    }
    const editingCell = editingChunk.get();
    if (editingCell) {
      const streamer = chunkEditReturn?.streamer;
      if (streamer) void persistChunkEdit(editingCell.world, editingCell.cx, editingCell.cz, streamer.cellSize);
      return;
    }
    // an isolation working doc must NEVER be written to assets/scenes/
    if (store.doc.name === PREFAB_EDIT_SCENE || store.doc.name === CHUNK_EDIT_SCENE) return;
    const content = JSON.stringify(store.doc, null, 2);
    if (content === lastWrittenScene) return;
    lastWrittenScene = content;
    saveAsset(`scenes/${store.doc.name}.scene.json`, content);
  }
  if (seeded) persistScene();
  let sceneSaveTimer: ReturnType<typeof setTimeout> | undefined;
  store.subscribe(() => {
    clearTimeout(sceneSaveTimer);
    sceneSaveTimer = setTimeout(persistScene, 500);
  });

  /** Open a prefab definition alone in the viewport (full toolset, live saves). */
  function editPrefab(id: string): void {
    if (editingPrefab.get() === id) return;
    if (editingPrefab.get()) {
      console.warn("[prefab-edit] already editing a prefab — save or discard it first");
      return;
    }
    const prefab = assets.getPrefab(id);
    if (!prefab) {
      console.warn(`[prefab-edit] prefab ${id} not found`);
      return;
    }
    persistScene(); // flush the scene we're leaving (editingPrefab still null here)
    prefabEditReturn = { scene: store.doc.name };
    playMode.set("edit");
    selection.set(null);
    multiSelection.set([]);
    assetSelection.set(null);
    editingPrefab.set(id); // set BEFORE replace so the autosave it triggers redirects
    lastWrittenScene = "";
    lastWrittenPrefab = "";
    store.replace({
      version: 1,
      name: PREFAB_EDIT_SCENE,
      entities: structuredClone(prefab.entities),
    });
    // the untouched working doc round-trips to the stored definition — seed the
    // dedupe so entering the mode doesn't immediately rewrite the prefab file
    const unchanged = docToPrefab(id);
    if (unchanged) lastWrittenPrefab = JSON.stringify(unchanged, null, 2);
    frameEntity(prefab.root);
  }

  /** Leave isolation. save=true flushes to the definition (stays open on failure). */
  function closePrefabEdit(save: boolean): void {
    const editingId = editingPrefab.get();
    if (!editingId) return;
    clearTimeout(sceneSaveTimer); // the pending autosave dies with the mode
    if (save && !persistPrefabEdit(editingId)) return; // warned inside; banner stays
    const returnScene = prefabEditReturn?.scene;
    prefabEditReturn = null;
    editingPrefab.set(null);
    lastWrittenPrefab = "";
    if (returnScene) {
      void switchScene(returnScene); // working doc is named "__prefab-edit", so no early return
    }
  }

  function chunkFilePath(world: string, cx: number, cz: number): string {
    return `chunks/${world}/${chunkFileName(cx, cz)}`;
  }

  /** Read one chunk cell's raw file fresh (not the running ChunkManager's
   * expanded/id-prefixed copy) — an empty doc if the cell doesn't exist yet
   * (opening or saving into brand new territory past the current grid). */
  async function fetchChunkDoc(world: string, cx: number, cz: number): Promise<ChunkDoc> {
    try {
      const res = await fetch(
        `/__hitreg/asset-file?file=${encodeURIComponent(chunkFilePath(world, cx, cz))}`,
      );
      if (!res.ok) throw new Error(String(res.status));
      const parsed = chunkDocSchema.safeParse(JSON.parse(await res.text()));
      if (parsed.success) return parsed.data;
      console.warn(
        `[chunk-edit] ${world} ${cx}_${cz} failed validation, treating as empty:`,
        parsed.error.message,
      );
    } catch {
      /* cell file doesn't exist yet */
    }
    return { version: 1, entities: {} };
  }

  function entityPosition(entity: EntityDoc): [number, number, number] {
    const transform = entity.components["transform"] as { position?: [number, number, number] } | undefined;
    return transform?.position ?? [0, 0, 0];
  }

  function withPosition(entity: EntityDoc, position: [number, number, number]): EntityDoc {
    const transform = entity.components["transform"] as object | undefined;
    return { ...entity, components: { ...entity.components, transform: { ...transform, position } } };
  }

  /** Open one chunk cell for isolation editing (double-clicked in the hierarchy's
   * chunk-sections list). Neighboring cells keep streaming normally around it —
   * see the editingChunk branch in rebuild(), below. */
  async function editChunkCell(world: string, cx: number, cz: number): Promise<void> {
    const already = editingChunk.get();
    if (already && already.world === world && already.cx === cx && already.cz === cz) return;
    if (already || editingPrefab.get()) {
      console.warn("[chunk-edit] already isolation-editing something — save or discard it first");
      return;
    }
    let streamer: ChunkStreamerData | null = null;
    for (const entity of Object.values(lastExpanded.entities)) {
      const cs = entity.components["chunkStreamer"] as ChunkStreamerData | undefined;
      if (cs) {
        streamer = cs;
        break;
      }
    }
    if (!streamer || streamer.source !== world) {
      console.warn(`[chunk-edit] no active chunkStreamer for world "${world}" in the current scene`);
      return;
    }
    const raw = await fetchChunkDoc(world, cx, cz);
    // only TOP-LEVEL entities are chunk-local; children stay local to their
    // parent, same convention chunkToSceneDoc/partitionScene already use
    const entities: Record<string, EntityDoc> = {};
    for (const [id, entity] of Object.entries(raw.entities)) {
      entities[id] =
        entity.parent === null
          ? withPosition(entity, chunkLocalToWorld(entityPosition(entity), cx, cz, streamer.cellSize))
          : structuredClone(entity);
    }

    persistScene(); // flush the scene we're leaving
    chunkEditReturn = { scene: store.doc.name, streamer };
    chunkEditRelocated = new Set();
    chunkManager.suppressCell(cx, cz);
    playMode.set("edit");
    selection.set(null);
    multiSelection.set([]);
    assetSelection.set(null);
    editingChunk.set({ world, cx, cz }); // set BEFORE replace so the autosave it triggers redirects
    lastWrittenScene = "";
    lastWrittenChunk = JSON.stringify(raw); // untouched doc round-trips as-is
    store.replace({ version: 1, name: CHUNK_EDIT_SCENE, entities });
  }

  /** Autosave path while isolation-editing a cell: converts the world-positioned
   * working doc back to this cell's local space, relocates anything dragged
   * into a different cell (moveEntityAcrossChunks), and writes every file touched. */
  async function persistChunkEdit(world: string, cx: number, cz: number, cellSize: number): Promise<boolean> {
    let home: ChunkDoc = { version: 1, entities: {} };
    for (const [id, entity] of Object.entries(store.doc.entities)) {
      home.entities[id] =
        entity.parent === null
          ? withPosition(entity, worldToChunkLocal(entityPosition(entity), cx, cz, cellSize))
          : structuredClone(entity);
    }
    const parsedHome = chunkDocSchema.safeParse(home);
    if (!parsedHome.success) {
      console.warn("[chunk-edit] edited cell failed validation, not saved:", parsedHome.error.message);
      return false;
    }
    home = parsedHome.data;

    const destDocs = new Map<string, { cx: number; cz: number; doc: ChunkDoc }>();
    for (const [id, entity] of Object.entries(store.doc.entities)) {
      if (entity.parent !== null || chunkEditRelocated.has(id)) continue;
      const worldPos = entityPosition(entity);
      const destCx = Math.round(worldPos[0] / cellSize);
      const destCz = Math.round(worldPos[2] / cellSize);
      if (destCx === cx && destCz === cz) continue; // still home
      const destKey = `${destCx}_${destCz}`;
      let dest = destDocs.get(destKey);
      if (!dest) {
        dest = { cx: destCx, cz: destCz, doc: await fetchChunkDoc(world, destCx, destCz) };
        destDocs.set(destKey, dest);
      }
      const result = moveEntityAcrossChunks(id, { cx, cz, doc: home }, dest, cellSize);
      if ("error" in result) {
        console.warn(`[chunk-edit] couldn't move "${id}" to cell ${destKey}:`, result.error);
        continue;
      }
      home = result.source;
      dest.doc = result.dest;
      chunkEditRelocated.add(id);
    }

    const content = JSON.stringify(home, null, 2);
    if (content !== lastWrittenChunk) {
      lastWrittenChunk = content;
      saveAsset(chunkFilePath(world, cx, cz), content);
    }
    for (const dest of destDocs.values()) {
      saveAsset(chunkFilePath(world, dest.cx, dest.cz), JSON.stringify(dest.doc, null, 2));
    }
    return true;
  }

  /** Leave chunk-cell isolation. save=true flushes to its file(s) first (stays open on failure). */
  async function closeChunkEdit(save: boolean): Promise<void> {
    const editing = editingChunk.get();
    if (!editing) return;
    clearTimeout(sceneSaveTimer); // the pending autosave dies with the mode
    const streamer = chunkEditReturn?.streamer;
    if (save && streamer) {
      const ok = await persistChunkEdit(editing.world, editing.cx, editing.cz, streamer.cellSize);
      if (!ok) return; // warned inside; stays open on failure, same as prefab-edit
    }
    const returnScene = chunkEditReturn?.scene;
    chunkEditReturn = null;
    editingChunk.set(null);
    lastWrittenChunk = "";
    chunkManager.unsuppressCell(editing.cx, editing.cz);
    if (returnScene) void switchScene(returnScene);
  }

  // scene-switch loading overlay: covers the gap between "clicked a scene"
  // and "it's actually here" — the scene-doc fetch itself is usually quick,
  // but the rebuild it triggers can kick off a burst of chunk/subscene/glTF
  // loads (see gltfLoadingCount et al. in the stats-tick loop below) that
  // used to leave the viewport looking frozen/empty with no feedback at all.
  let sceneSwitchPending = false;
  let sceneSwitchStartedAt = 0;
  const SCENE_SWITCH_TIMEOUT_MS = 10000; // don't stay stuck forever if something never resolves
  function showSceneLoading(name: string): void {
    sceneSwitchPending = true;
    sceneSwitchStartedAt = performance.now();
    sceneLoadingTextEl.textContent = `loading ${name}…`;
    sceneLoadingEl.classList.add("visible");
  }
  function hideSceneLoading(): void {
    sceneSwitchPending = false;
    sceneLoadingEl.classList.remove("visible");
  }

  async function switchScene(name: string): Promise<void> {
    if (editingPrefab.get()) {
      console.warn("[prefab-edit] save or discard the prefab edit before switching scenes");
      return;
    }
    if (editingChunk.get()) {
      console.warn("[chunk-edit] save or discard the chunk edit before switching scenes");
      return;
    }
    if (name === store.doc.name) return;
    persistScene(); // save where we were
    showSceneLoading(name);
    try {
      const content = await fetch(
        `/__hitreg/asset-file?file=${encodeURIComponent(`scenes/${name}.scene.json`)}`,
      ).then((r) => r.text());
      const parsed = sceneDocSchema.safeParse(JSON.parse(content));
      if (!parsed.success) {
        console.warn(`[scene] ${name} failed validation:`, parsed.error);
        hideSceneLoading();
        return;
      }
      playMode.set("edit");
      selection.set(null);
      multiSelection.set([]);
      lastWrittenScene = content;
      store.replace(parsed.data);
      rememberLastScene(name);
      void pinStore.load(name);
      // hideSceneLoading() fires once the stats tick sees loadingCount hit 0
      // (or the timeout, below) — the doc fetch above is done, but chunks/
      // models the rebuild just kicked off are very likely still streaming in.
    } catch (error) {
      console.warn(`[scene] failed to load ${name}:`, error);
      hideSceneLoading();
    }
  }

  function newScene(rawName: string): void {
    if (editingPrefab.get()) {
      console.warn("[prefab-edit] save or discard the prefab edit before creating a scene");
      return;
    }
    if (editingChunk.get()) {
      console.warn("[chunk-edit] save or discard the chunk edit before creating a scene");
      return;
    }
    const name = rawName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!name) return;
    if (sceneList.get().includes(name)) {
      void switchScene(name);
      return;
    }
    persistScene();
    playMode.set("edit");
    selection.set(null);
    multiSelection.set([]);
    showSceneLoading(name);
    const starter = buildStarterDoc(name, registry);
    lastWrittenScene = "";
    store.replace(starter);
    persistScene();
    rememberLastScene(name);
    sceneList.set([...sceneList.get(), name].sort());
  }

  // -- render side -----------------------------------------------------------

  let built: BuiltScene;
  let lastExpanded: SceneDoc;
  // the sky dome (scene-builder.ts's buildSkyDome) is a fixed-radius BackSide
  // sphere that only reads as an infinite background while the camera stays
  // inside it — re-found after every rebuild() (a fresh scene graph each
  // time) and recentered on the camera every frame, below.
  let skyDomeMesh: THREE.Object3D | null = null;
  // cached terrain tiles for ground-height queries (grass placement, camera
  // height-above-ground fade) — rebuilt alongside `lastExpanded`, not on every
  // query, since it only covers the base scene doc's handful of heightmap
  // tiles (chunk-streamed props are separate and irrelevant here)
  interface SplatLayerBand {
    heightStart: number;
    heightEnd: number;
    grassy?: boolean;
  }
  let terrainTiles: Array<{
    params: Parameters<typeof sampleHeightmap>[0];
    x: number;
    y: number;
    z: number;
    halfW: number;
    halfD: number;
    /** terrain-splat layers (if any) — see grassBlendWeight/sampleGrassyGround. */
    splatLayers: SplatLayerBand[] | null;
  }> = [];
  /** World (x, z) -> ground height under whichever terrain tile covers that
   * point, or null if nothing is loaded there. */
  function sampleTerrainHeight(x: number, z: number): number | null {
    for (const tile of terrainTiles) {
      const lx = x - tile.x;
      const lz = z - tile.z;
      if (Math.abs(lx) > tile.halfW || Math.abs(lz) > tile.halfD) continue;
      return tile.y + sampleHeightmap(tile.params, lx, lz);
    }
    return null;
  }
  /** How much of the terrain-splat's final blended color at `height` is the
   * layer flagged `grassy`, in [0, 1] — mirrors scene-builder.ts's
   * buildTerrainSplatMaterial mix chain exactly (each layer above the base
   * mixes in by smoothstep(heightStart, heightEnd, height), scaling down
   * every layer mixed in before it), so this is the true blended color
   * weight, not just "is height inside the layer's own authored band". */
  function grassBlendWeight(layers: SplatLayerBand[], height: number): number {
    const grassyIndex = layers.findIndex((l) => l.grassy);
    if (grassyIndex < 0) return 0;
    const weights = new Array(layers.length).fill(0);
    weights[0] = 1;
    for (let i = 1; i < layers.length; i++) {
      const layer = layers[i]!;
      const span = Math.max(1e-6, layer.heightEnd - layer.heightStart);
      const raw = Math.min(1, Math.max(0, (height - layer.heightStart) / span));
      const t = raw * raw * (3 - 2 * raw); // smoothstep, matches the TSL node
      for (let j = 0; j < i; j++) weights[j] *= 1 - t;
      weights[i] = t;
    }
    return weights[grassyIndex] as number;
  }
  // only place blades where the grass layer is the MAJORITY blended color —
  // excludes ground that still reads visually as tan/sand or brown/moss, but
  // without shrinking to just the sliver right at the band's exact peak
  const GRASS_BLEND_THRESHOLD = 0.5;
  /** Same as sampleTerrainHeight, but returns null unless the ground there is
   * solidly the terrain's grassy splat color — so the grass field only grows
   * where the terrain actually reads as green (not sand/rock/moss). */
  function sampleGrassyGround(x: number, z: number): number | null {
    for (const tile of terrainTiles) {
      const lx = x - tile.x;
      const lz = z - tile.z;
      if (Math.abs(lx) > tile.halfW || Math.abs(lz) > tile.halfD) continue;
      if (!tile.splatLayers) return null;
      const h = sampleHeightmap(tile.params, lx, lz);
      if (grassBlendWeight(tile.splatLayers, h) < GRASS_BLEND_THRESHOLD) return null;
      return tile.y + h;
    }
    return null;
  }
  // doc-change telemetry for the context bridge: in-place patches vs full rebuilds
  let reconcileCount = 0;
  let rebuildCount = 0;
  let netPresence: NetPresence | null = null; // constructed after the editor mounts
  const animations = new AnimationSystem();
  const particles = new ParticleSystem();
  const billboards = new BillboardSystem();
  const grass = new GrassSystem();
  const pathPointsInverse = new THREE.Matrix4();
  const pathPointScratch = new THREE.Vector3();
  /** entity id -> its last-applied LOCAL points, so a near-static rope (the
   * common case: a wrecking ball chain hanging still between swings) skips
   * the rebuild instead of disposing+reallocating a GPU buffer every single
   * physics tick for a shape that hasn't visibly moved. */
  const lastPathPoints = new Map<string, Array<[number, number, number]>>();
  const PATH_POINTS_EPSILON_SQ = 0.0004; // 2cm — well below anything visible
  /** ctx.setPathPoints host hook: rebuild a live-simulated rope/chain's path
   * geometry from new WORLD-space points, reusing every other authored field
   * (crossSection/width/radius/...) off the mesh's original source — see
   * scene-builder.ts's "pathMesh"/"pathSource" userData tags. */
  function setRuntimeLight(
    entityId: string,
    opts: { enabled?: boolean; intensity?: number; color?: string },
  ): void {
    const object = built.objects.get(entityId);
    if (!object) return;
    object.traverse((node) => {
      const light = node as THREE.Light;
      if (!light.isLight) return;
      if (opts.enabled !== undefined) {
        light.userData["runtimeEnabled"] = opts.enabled;
        light.visible = opts.enabled;
      }
      if (opts.intensity !== undefined) light.intensity = Math.max(0, opts.intensity);
      if (opts.color !== undefined) light.color.set(opts.color);
    });
  }

  function setPathPoints(entityId: string, points: Array<[number, number, number]>): void {
    const group = built.objects.get(entityId);
    if (!group) return;
    const mesh = group.children.find((c) => c.userData["pathMesh"] === true) as
      | THREE.Mesh
      | undefined;
    const source = mesh?.userData["pathSource"] as PathMeshSource | undefined;
    if (!mesh || !source) return;
    group.updateWorldMatrix(true, false);
    pathPointsInverse.copy(group.matrixWorld).invert();
    const localPoints = points.map(([x, y, z]) => {
      pathPointScratch.set(x, y, z).applyMatrix4(pathPointsInverse);
      return [pathPointScratch.x, pathPointScratch.y, pathPointScratch.z] as [number, number, number];
    });
    const prev = lastPathPoints.get(entityId);
    if (
      prev &&
      prev.length === localPoints.length &&
      prev.every(([px, py, pz], i) => {
        const [x, y, z] = localPoints[i]!;
        return (x - px) ** 2 + (y - py) ** 2 + (z - pz) ** 2 < PATH_POINTS_EPSILON_SQ;
      })
    ) {
      return;
    }
    lastPathPoints.set(entityId, localPoints);
    mesh.geometry.dispose();
    mesh.geometry = pathGeometry({ ...source, points: localPoints });
  }
  /** model asset id -> its named sub-objects (kits) — exposed to the AI bridge. */
  const modelNodes: Record<string, string[]> = {};
  /** entity id -> bone names of its loaded skinned model (inspector bone dropdowns). */
  const modelBones = createModelBones();

  // debug viz is an EDIT-mode tool — the game view stays clean during play
  function refreshPhysicsDebugVisibility(): void {
    if (!built) return;
    const visible = playMode.get() === "edit" && settings.get().showPhysics;
    built.scene.traverse((node) => {
      if (node.userData["physicsDebug"]) node.visible = visible;
    });
  }
  function refreshSkeletonDebugVisibility(): void {
    if (!built) return;
    const visible = playMode.get() === "edit" && settings.get().showSkeletons;
    built.scene.traverse((node) => {
      if (node.userData["skeletonDebug"]) node.visible = visible;
    });
  }
  function refreshLightDebugVisibility(): void {
    if (!built) return;
    const visible = playMode.get() === "edit" && settings.get().showLights;
    built.scene.traverse((node) => {
      if (node.userData["lightDebug"]) node.visible = visible;
    });
  }
  // camera collision: in play mode the follow camera dollies in instead of
  // clipping through static scenery (terrain, rocks, trees).
  // camera-controls' dolly-collision test raycasts this ENTIRE list, every
  // frame, brute-force (no BVH/acceleration structure) — confirmed via CPU
  // profiling to be the single dominant per-frame cost once terrain/ocean
  // triangle counts get large (70%+ of total frame time: 16 full-resolution
  // terrain tiles + the ocean's 200x200-segment plane, checked in full
  // regardless of where the camera actually is). Dolly-collision only needs
  // to catch what the camera could plausibly clip into RIGHT NOW, not every
  // static mesh in the loaded world — cap it to a generous radius around the
  // camera (comfortably covers the current 175-unit terrain tile plus its
  // immediate neighbors) instead of the unbounded, unfiltered list.
  const COLLIDER_RADIUS_SQ = 200 * 200;
  function refreshCameraColliders(): void {
    // A chase rig writes an exact camera pose every frame. camera-controls'
    // four-ray dolly collision would brute-force nearby terrain triangles for
    // a result that the next exact chase pose immediately overwrites.
    if (!built || playMode.get() === "edit" || followRigMode === "chase") {
      controls.colliderMeshes = [];
      return;
    }
    const meshes: THREE.Object3D[] = [];
    const scratch = new THREE.Vector3();
    for (const [id, entity] of Object.entries(lastExpanded.entities)) {
      if (!entity.tags.includes("static")) continue;
      const object = built.objects.get(id);
      if (!object) continue;
      object.getWorldPosition(scratch);
      if (scratch.distanceToSquared(camera.position) > COLLIDER_RADIUS_SQ) continue;
      object.traverse((node) => {
        // a coarse collision-only proxy (scene-builder.ts's heightmap build)
        // stands in for the real terrain mesh — same raycast result for
        // "don't clip through the ground", far fewer triangles to check
        if (node.userData["isColliderProxy"]) meshes.push(node);
        else if ((node as THREE.Mesh).isMesh && !node.userData["hasColliderProxy"]) meshes.push(node);
      });
    }
    controls.colliderMeshes = meshes;
  }
  /** Expand the doc and hydrate runtime-only data (editable terrain lives in
   * a standalone file; renderer and physics must consume the same samples). */
  function expandForRuntime(): SceneDoc {
    const expanded = expandScene(store.doc, assets, registry);
    for (const entity of Object.values(expanded.entities)) {
      const mesh = entity.components["mesh"] as { source?: Record<string, unknown> } | undefined;
      if (mesh?.source?.["kind"] !== "heightmap") continue;
      const terrainId = mesh.source["terrainAsset"] as string | undefined;
      const terrain = terrainId ? assets.getDataAsset(terrainId)?.data as { size: [number, number]; resolution: number; heights: number[] } | undefined : undefined;
      if (terrain) mesh.source = { ...mesh.source, size: terrain.size, resolution: terrain.resolution, heights: terrain.heights };
    }
    return expanded;
  }

  // shared by the full rebuild and per-entity reconcile: callbacks read
  // `built`/`lastExpanded` at call time, so one options object serves both
  const sceneBuildOptions: BuildOptions = {
    resolveModel: (assetId) => assets.getModel(assetId)?.url,
    resolveMaterial: (assetId) => assets.getDataAsset(assetId)?.data,
    resolveTexture: (assetId) => assets.getTexture(assetId)?.url,
    resolveMaxAnisotropy: () => renderer.getMaxAnisotropy(),
    onParticles: (entityId, group, data) =>
      particles.register(entityId, group, data, (assetId) => assets.getTexture(assetId)?.url),
    onLight: (_entityId, light, importance) => lightBudget.register(light, importance),
    onBillboard: (entityId, group, data) =>
      billboards.register(entityId, group, data, {
        texture: (assetId) => assets.getTexture(assetId)?.url,
        sheet: (assetId) => {
          const doc = assets.getDataAsset(assetId);
          return doc?.type === "spritesheet" ? (doc.data as SpritesheetDoc) : undefined;
        },
      }),
    onGrass: (entityId, group, data) => grass.register(entityId, group, data),
    onInstancedBatch: (batch) => foliageLod.register(batch),
    bakeImpostor: (object, bounds) => bakeImpostorAtlas(renderer, object, bounds),
    onClusteredMesh: (_entityId, mesh) => clusterLod.register(mesh),
    onModelLoaded: (entityId, root, clips) => {
      const entity = lastExpanded.entities[entityId];
      const animator = entity?.components["animator"] as AnimatorData | undefined;
      animations.register(entityId, root, clips, animator ?? null);
      // report kit contents so AI (and unpack) can see what's inside a model
      const source = (
        entity?.components["mesh"] as { source?: { assetId?: string; node?: string } } | undefined
      )?.source;
      if (source?.assetId && !source.node) {
        modelNodes[source.assetId] = root.children.map((c) => c.name).filter(Boolean);
      }
      // rigged models: expose bone names to the inspector + skeleton overlay
      const bones = collectBones(root);
      if (bones.length > 0) {
        modelBones.set({ ...modelBones.get(), [entityId]: bones });
        if (built) {
          attachSkeletonDebug(built.objects); // idempotent — one call per async load
          refreshSkeletonDebugVisibility();
        }
      }
      // late-loading static models (rocks, trees) must block the camera too
      if (playMode.get() !== "edit") refreshCameraColliders();
    },
  };

  function rebuild(): void {
    lastExpanded = expandForRuntime();
    animations.clear();
    particles.clear();
    billboards.clear();
    grass.clear();
    built = buildScene(lastExpanded, sceneBuildOptions);
    skyDomeMesh = null;
    built.scene.traverse((node) => {
      if (!skyDomeMesh && node.userData["skyDome"] === true) skyDomeMesh = node;
    });
    const expanded = lastExpanded;
    if (settings.get().showPhysics) attachPhysicsDebug(expanded, built.objects);
    refreshPhysicsDebugVisibility();
    if (settings.get().showLights) attachLightDebug(expanded, built.objects);
    refreshLightDebugVisibility();
    refreshCameraColliders();
    // sky component sets its own background; this is only the no-sky fallback
    if (!built.scene.background) built.scene.background = new THREE.Color(0x0b0e14);
    // postfx component drives renderer post-processing (one per scene, first wins);
    // live file edits land here via the same store.subscribe(rebuild) path as sky
    type BloomData = { enabled: boolean; strength: number; radius: number; threshold: number };
    let bloomOpts: BloomData | null = null;
    for (const entity of Object.values(expanded.entities)) {
      const fx = entity.components["postfx"] as { bloom?: BloomData } | undefined;
      if (fx) {
        bloomOpts = fx.bloom ?? null;
        break;
      }
    }
    renderer.setBloom(bloomOpts?.enabled ? bloomOpts : null);
    // chunkStreamer component opts the scene into streamed chunk content
    let streamer: ChunkStreamerData | null = null;
    for (const entity of Object.values(expanded.entities)) {
      const cs = entity.components["chunkStreamer"] as ChunkStreamerData | undefined;
      if (cs) {
        streamer = cs;
        break;
      }
    }
    // isolation-editing a chunk cell: the working doc has no chunkStreamer of
    // its own (it's a synthetic single-cell doc), but the rest of the
    // streamed world should stay visible around it — keep the ORIGINAL
    // scene's streamer config alive instead of losing it with the doc swap.
    if (editingChunk.get() && chunkEditReturn) streamer = chunkEditReturn.streamer;
    void chunkManager.configure(streamer, built.scene);
    // subscene components: whole scene files composed additively at runtime
    const subscenes: SubsceneInstance[] = [];
    const worlds = worldTransforms(expanded);
    terrainTiles = [];
    for (const [id, entity] of Object.entries(expanded.entities)) {
      const sub = entity.components["subscene"] as SubsceneData | undefined;
      if (sub) subscenes.push({ id, world: worlds.get(id)!, data: sub });
      const mesh = entity.components["mesh"] as
        | { source?: Record<string, unknown>; material?: string }
        | undefined;
      if (mesh?.source?.["kind"] === "heightmap") {
        const size = mesh.source["size"] as [number, number] | undefined;
        if (size) {
          const pos = worlds.get(id)?.position ?? [0, 0, 0];
          const materialData = mesh.material ? assets.getDataAsset(mesh.material)?.data : undefined;
          const splatMaterial = materialData as
            | { shader?: string; splat?: { layers?: SplatLayerBand[] } }
            | undefined;
          terrainTiles.push({
            params: mesh.source as unknown as Parameters<typeof sampleHeightmap>[0],
            x: pos[0],
            y: pos[1],
            z: pos[2],
            halfW: size[0] / 2,
            halfD: size[1] / 2,
            splatLayers: splatMaterial?.shader === "terrain-splat" ? splatMaterial.splat?.layers ?? null : null,
          });
        }
      }
    }
    subsceneManager.configure(store.doc.name, subscenes, built.scene);
    for (const sceneCam of built.cameras.values()) {
      sceneCam.aspect = (canvas.clientWidth || 1) / (canvas.clientHeight || 1);
      sceneCam.updateProjectionMatrix();
    }
    netPresence?.attach(built.scene); // remote-player avatars survive rebuilds
    viewport?.onSceneRebuilt();
    meshEditTool?.onSceneRebuilt();
  }

  const renderer = new EngineRenderer(canvas);
  const [backend] = await Promise.all([renderer.init(), initPhysics()]);

  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.1,
    500,
  );
  const controls = new CameraControls(camera, canvas);
  controls.setLookAt(18, 12, 22, 0, 1, 0, false);

  // editor fly-cam: hold LEFT mouse + WASD (QE = down/up, Shift = boost);
  // plain left-drag keeps orbiting. Once a fly key is pressed, camera-controls
  // is parked and we drive the camera directly — drag = FPS look, keys = move —
  // because camera-controls' update()/setLookAt would stomp the drag rotation
  // every frame if both tried to own the camera.
  let flyBtnDown = false;
  let flyLookMode = false;
  let gizmoDragging = false;
  let flyYaw = 0;
  let flyPitch = 0;
  const FLY_LOOK_SPEED = 0.0025; // rad per px
  const FLY_PITCH_LIMIT = Math.PI / 2 - 0.03;
  const flyEuler = new THREE.Euler(0, 0, 0, "YXZ");
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button === 0) flyBtnDown = true;
  });
  window.addEventListener("pointerup", (e) => {
    if (e.button === 0) {
      flyBtnDown = false;
      exitFlyLook();
    }
  });
  window.addEventListener("pointermove", (e) => {
    if (!flyLookMode) return;
    flyYaw -= e.movementX * FLY_LOOK_SPEED;
    flyPitch = THREE.MathUtils.clamp(
      flyPitch - e.movementY * FLY_LOOK_SPEED,
      -FLY_PITCH_LIMIT,
      FLY_PITCH_LIMIT,
    );
    camera.quaternion.setFromEuler(flyEuler.set(flyPitch, flyYaw, 0));
  });

  function enterFlyLook(): void {
    if (flyLookMode || gizmoDragging) return;
    flyLookMode = true;
    // seed yaw/pitch from where the camera already looks — no visual jump
    camera.getWorldDirection(flyDir);
    flyPitch = Math.asin(THREE.MathUtils.clamp(flyDir.y, -1, 1));
    flyYaw = Math.atan2(-flyDir.x, -flyDir.z);
    controls.enabled = false;
  }
  function exitFlyLook(): void {
    if (!flyLookMode) return;
    flyLookMode = false;
    // hand the camera back with the orbit pivot a comfortable distance ahead
    camera.getWorldDirection(flyDir);
    const p = camera.position;
    void controls.setLookAt(p.x, p.y, p.z, p.x + flyDir.x * 12, p.y + flyDir.y * 12, p.z + flyDir.z * 12, false);
    controls.enabled = document.pointerLockElement !== canvas;
  }
  const flyDir = new THREE.Vector3();
  const flyRight = new THREE.Vector3();
  const flyDelta = new THREE.Vector3();
  const WORLD_UP = new THREE.Vector3(0, 1, 0);
  function updateFlyCam(dt: number): void {
    if (!editorVisible.get() || !flyBtnDown) return;
    const boost = input.isDown("ShiftLeft") || input.isDown("ShiftRight") ? 3 : 1;
    const move = 14 * dt * boost;
    // W flies along the LOOK direction (pitch included); A/D strafe camera-right
    camera.getWorldDirection(flyDir);
    flyRight.crossVectors(flyDir, WORLD_UP).normalize();
    flyDelta.set(0, 0, 0);
    if (input.isDown("KeyW")) flyDelta.addScaledVector(flyDir, move);
    if (input.isDown("KeyS")) flyDelta.addScaledVector(flyDir, -move);
    if (input.isDown("KeyA")) flyDelta.addScaledVector(flyRight, -move);
    if (input.isDown("KeyD")) flyDelta.addScaledVector(flyRight, move);
    if (input.isDown("KeyE")) flyDelta.addScaledVector(WORLD_UP, move);
    if (input.isDown("KeyQ")) flyDelta.addScaledVector(WORLD_UP, -move);
    if (flyDelta.lengthSq() === 0) return;
    enterFlyLook(); // first fly key hands the camera to the fly-cam
    if (!flyLookMode) return; // gizmo drag owns this mouse gesture
    camera.position.add(flyDelta);
  }

  // -- editor ----------------------------------------------------------------

  const selection = createSelection();
  const multiSelection = createMultiSelection();
  // attention signals — what the cursor is over and what a drag has hold of.
  // Published to the AI context bridge so "this one" resolves to an entity and
  // a world point instead of a guess from the camera pose.
  const hover = createHover();
  const manipulating = createManipulating();
  // world-anchored notes, persisted per scene beside the scene file
  const pinStore = createPinStore();
  void pinStore.load(store.doc.name);
  // Authoring is the default state. The editor stays available whenever the
  // game is not actively running; play mode is the clean fullscreen view.
  const editorVisible = observable(true);
  const settings = observable(defaultEditorSettings);
  const gizmoMode = observable<GizmoMode>("translate");
  const playMode = observable<PlayMode>("edit");
  const contextMenu = createContextMenu();
  const assetSelection = createAssetSelection();
  const grayboxActive = observable(false);
  const grayboxShape = observable<GrayboxShape>("box");
  const grayboxBevel = observable(0);
  const grayboxMaterial = observable(""); // "" = engine default; else a material GUID
  const grayboxEditable = observable(true); // drawn shapes are editable poly meshes
  // ProBuilder-style element editing (vertex/edge/face) of poly meshes
  const meshEdit = createMeshEditState();
  const terrainActive = observable(false);
  const terrainBrush = observable<TerrainBrushSettings>({ ...defaultTerrainBrush });
  const pathActive = observable(false);
  const pathCrossSection = observable<PathCrossSection>("ribbon");
  const pathWidth = observable(4);
  const pathThickness = observable(0);
  const pathRadius = observable(0.15);
  const thumbnails = observable<Record<string, string>>({});
  const dockSizes = createDockSizes();
  const assetsVersion = observable(0);
  assetsVersion.subscribe(() => rebuild()); // material/prefab edits re-render the scene
  // Scene-affecting debug overlays (physics/lights/skeleton wireframes) attach
  // during a rebuild, so flipping them must rebuild. View-only flags — the
  // stats HUD — must NOT: compare a signature of the rebuild-relevant fields so
  // toggling stats doesn't tear down and rebuild the whole scene.
  const rebuildKey = (s: ReturnType<typeof settings.get>) => JSON.stringify({ ...s, showStats: 0 });
  let lastRebuildKey = rebuildKey(settings.get());
  settings.subscribe(() => {
    const key = rebuildKey(settings.get());
    if (key === lastRebuildKey) return;
    lastRebuildKey = key;
    rebuild();
  });

  const viewport: ViewportTools = new ViewportTools({
    canvas,
    camera,
    store,
    selection,
    multiSelection,
    enabled: editorVisible,
    settings,
    gizmoMode,
    contextMenu,
    grayboxActive,
    pathActive,
    meshEdit,
    hover,
    manipulating,
    assets,
    getScene: () => built.scene,
    getObject: (id) => built.objects.get(id),
    onDraggingChanged: (dragging) => {
      gizmoDragging = dragging;
      controls.enabled = !dragging;
    },
  });

  new GrayboxTool({
    canvas,
    camera,
    store,
    selection,
    settings,
    enabled: editorVisible,
    active: grayboxActive,
    shape: grayboxShape,
    bevel: grayboxBevel,
    material: grayboxMaterial,
    editable: grayboxEditable,
    getScene: () => built.scene,
    onDraggingChanged: (dragging) => {
      gizmoDragging = dragging;
      controls.enabled = !dragging;
    },
  });

  const meshEditTool: MeshEditTool = new MeshEditTool({
    canvas,
    camera,
    store,
    selection,
    multiSelection,
    settings,
    enabled: editorVisible,
    gizmoMode,
    state: meshEdit,
    getScene: () => built.scene,
    getObject: (id) => built.objects.get(id),
    onDraggingChanged: (dragging) => {
      gizmoDragging = dragging;
      controls.enabled = !dragging;
    },
  });
  // (rebuild() calls meshEditTool.onSceneRebuilt() once the scene exists)
  // the draw tool and element editing are mutually exclusive modal tools
  grayboxActive.subscribe(() => {
    if (grayboxActive.get() && meshEdit.active.get()) meshEdit.active.set(false);
  });
  meshEdit.active.subscribe(() => {
    if (meshEdit.active.get() && grayboxActive.get()) grayboxActive.set(false);
  });

  new PathTool({
    canvas,
    camera,
    store,
    selection,
    settings,
    enabled: editorVisible,
    active: pathActive,
    crossSection: pathCrossSection,
    width: pathWidth,
    thickness: pathThickness,
    radius: pathRadius,
    getScene: () => built.scene,
    onDraggingChanged: (dragging) => {
      gizmoDragging = dragging;
      controls.enabled = !dragging;
    },
  });

  new TerrainTool({
    canvas,
    camera,
    selection,
    active: terrainActive,
    brush: terrainBrush,
    getObject: (id) => built.objects.get(id),
    onStroke: (id, point, brush) => {
      const entity = store.doc.entities[id];
      const mesh = entity?.components["mesh"] as { source?: Record<string, unknown> } | undefined;
      const source = mesh?.source;
      if (!source || source["kind"] !== "heightmap") return;
      let terrainId = source["terrainAsset"] as string | undefined;
      let asset = terrainId ? assets.getDataAsset(terrainId) : undefined;
      if (!asset) {
        terrainId = `${store.doc.name}-${id}`.replace(/[^a-zA-Z0-9/_-]+/g, "-");
        const resolution = Number(source["resolution"] ?? 96);
        const size = (source["size"] ?? [80, 80]) as [number, number];
        const params = source as unknown as Parameters<typeof sampleHeightmap>[0];
        const heights: number[] = [];
        for (let z = 0; z <= resolution; z++) for (let x = 0; x <= resolution; x++) {
          heights.push(sampleHeightmap(params, (x / resolution - 0.5) * size[0], (z / resolution - 0.5) * size[1]));
        }
        asset = assets.addDataAsset({ id: terrainId, type: "terrain-heightfield", name: terrainId, data: { version: 1, size, resolution, heights } });
        store.apply([{ op: "set-component", id, component: "mesh", data: { ...mesh, source: { ...source, terrainAsset: terrainId } } }]);
      }
      const data = structuredClone(asset.data) as TerrainHeightfield;
      const row = data.resolution + 1;
      const gx = (point[0] / data.size[0] + 0.5) * data.resolution;
      const gz = (point[2] / data.size[1] + 0.5) * data.resolution;
      const radiusX = brush.radius / data.size[0] * data.resolution;
      const radiusZ = brush.radius / data.size[1] * data.resolution;
      const centerIndex = Math.round(gz) * row + Math.round(gx);
      const flattenHeight = data.heights[Math.max(0, Math.min(data.heights.length - 1, centerIndex))] ?? 0;
      const before = [...data.heights];
      for (let z = Math.max(0, Math.floor(gz - radiusZ)); z <= Math.min(data.resolution, Math.ceil(gz + radiusZ)); z++) {
        for (let x = Math.max(0, Math.floor(gx - radiusX)); x <= Math.min(data.resolution, Math.ceil(gx + radiusX)); x++) {
          const distance = Math.hypot((x - gx) / radiusX, (z - gz) / radiusZ);
          if (distance > 1) continue;
          const i = z * row + x, falloff = (1 - distance) ** 2, amount = brush.strength * falloff;
          if (brush.mode === "raise") data.heights[i]! += amount;
          else if (brush.mode === "lower") data.heights[i]! -= amount;
          else if (brush.mode === "flatten") data.heights[i]! += (flattenHeight - data.heights[i]!) * Math.min(1, amount);
          else {
            let sum = 0, count = 0;
            for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
              const sx = x + dx, sz = z + dz;
              if (sx >= 0 && sx <= data.resolution && sz >= 0 && sz <= data.resolution) { sum += before[sz * row + sx]!; count++; }
            }
            data.heights[i]! += (sum / count - data.heights[i]!) * Math.min(1, amount);
          }
        }
      }
      assets.updateDataAsset({ ...asset, data });
      saveAsset(`terrain/${terrainId}.json`, JSON.stringify(data, null, 2));
      assetsVersion.set(assetsVersion.get() + 1);
    },
  });

  const overlayContainer = document.createElement("div");
  document.body.appendChild(overlayContainer);
  mountEditor({
    container: overlayContainer,
    store,
    registry,
    assets,
    selection,
    multiSelection,
    visible: editorVisible,
    settings,
    gizmoMode,
    playMode,
    contextMenu,
    assetSelection,
    grayboxActive,
    grayboxShape,
    grayboxBevel,
    grayboxMaterial,
    grayboxEditable,
    meshEdit,
    meshEditActions: meshEditTool,
    terrainActive,
    terrainBrush,
    pathActive,
    pathCrossSection,
    pathWidth,
    pathThickness,
    pathRadius,
    thumbnails,
    dockSizes,
    assetsVersion,
    modelBones,
    pins: pinStore.pins,
    camera,
    canvas,
    onPinCreate: (point, entityId) => pinStore.create(point, entityId),
    // from the inspector: anchor the note at the entity's own world origin, so
    // it shows up in the viewport where the thing actually is
    onPinCreateForEntity: (entityId) => {
      const object = built.objects.get(entityId);
      const at = object
        ? object.getWorldPosition(new THREE.Vector3())
        : new THREE.Vector3();
      pinStore.create(
        [Number(at.x.toFixed(3)), Number(at.y.toFixed(3)), Number(at.z.toFixed(3))],
        entityId,
      );
    },
    onPinUpdate: (id, patch) => pinStore.update(id, patch),
    onPinDelete: (id) => pinStore.remove(id),
    onFocusPoint: (point) => void controls.setTarget(point[0], point[1], point[2], true),
    saveAsset,
    onProfiler: openProfiler,
    onFocusEntity: frameEntity,
    onUnpackModel: unpackModel,
    scenes: sceneList,
    onSwitchScene: (name) => void switchScene(name),
    onNewScene: newScene,
    editingPrefab,
    onEditPrefab: editPrefab,
    onClosePrefabEdit: closePrefabEdit,
    editingChunk,
    loadedChunkCells,
    onEditChunkCell: (world, cx, cz) => void editChunkCell(world, cx, cz),
    onCloseChunkEdit: (save) => void closeChunkEdit(save),
  });

  // -- multiplayer presence (dev): other tabs on this scene appear as avatars --

  const netPlayerPos = new THREE.Vector3();
  const netPlayerQuat = new THREE.Quaternion();
  const netPlayerEuler = new THREE.Euler(0, 0, 0, "YXZ");

  // -- world replication (host-authoritative NPCs) ----------------------------
  // What syncs: entities with a `netObject` component (declarative policy:
  // authority, relevancy radius, send cadence), plus an implicit default —
  // script+rigidbody entities replicate as if they had `netObject: {}`, so
  // moving NPCs are multiplayer-correct with zero configuration. The local
  // player is excluded (it's the presence/prediction path), and pure-logic
  // scripts (managers, sockets) stay local. The host reads world transforms
  // per tick; NetPresence scopes them per peer (need-to-know) and peers
  // suspend their own sim for the managed set.
  const netEntityPos = new THREE.Vector3();
  const netEntityQuat = new THREE.Quaternion();
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  /** Peer side: ids whose local sim is currently suspended (host owns them). */
  const netSuspended = new Set<string>();
  function suspendForHost(ids: string[]): void {
    if (!scripts || !sim) {
      netSuspended.clear(); // not playing — nothing is actually suspended
      return; // (session start re-derives from netPresence.replicatedIds())
    }
    const target = new Set(ids);
    const toSuspend = [...target].filter((id) => !netSuspended.has(id));
    const toResume = [...netSuspended].filter((id) => !target.has(id));
    if (toSuspend.length > 0 || toResume.length > 0) {
      console.log(`[net] host-simulated entities: +${toSuspend.length} -${toResume.length}`);
    }
    if (toSuspend.length > 0) {
      // scripts SUSPEND (entities stay registered — peers can still target
      // ghosts for interactions); physics bodies come off entirely
      scripts.suspendEntities(toSuspend);
      sim.removeEntities(toSuspend);
      for (const id of toSuspend) {
        // stale render-smoothing entries would keep writing old positions
        // to the ghost objects every frame, fighting the interpolator
        prevBodyPos.delete(id);
        currBodyPos.delete(id);
      }
    }
    if (toResume.length > 0) {
      const entities: SceneDoc["entities"] = {};
      for (const id of toResume) {
        const e = lastExpanded.entities[id];
        if (e) entities[id] = e;
      }
      const partial: SceneDoc = { ...lastExpanded, entities };
      sim.addEntities(partial);
      scripts.resumeEntities(toResume);
      // continuity: resume each body where its ghost stood (host migration,
      // host stopped playing) — NOT at its scene-doc spawn position
      for (const id of toResume) {
        const object = built.objects.get(id);
        if (object) sim.setPosition(id, [object.position.x, object.position.y, object.position.z]);
      }
    }
    netSuspended.clear();
    for (const id of target) netSuspended.add(id);
  }

  function localPlayerId(): string | null {
    return (
      Object.entries(lastExpanded.entities).find(([, e]) => e.tags.includes("player"))?.[0] ?? null
    );
  }
  /** Host-side physics proxies for remote players (entity ids in the sim). */
  const netProxies = new Set<string>();
  const netProxyId = (peerId: string) => `__net:player:${peerId}`;
  const NET_MAX_SPEED = 20; // trust boundary: cap any claimed input velocity
  const NET_JUMP_VELOCITY = 8;
  const NET_NUDGE_DIST = 1.0; // prediction drift beyond this eases toward authority
  const NET_SNAP_DIST = 3.5; // …and beyond this teleports (velocity reset)

  netPresence = new NetPresence({
    getSceneName: () => store.doc.name,
    getLocalPlayer: () => {
      if (playMode.get() !== "playing") return null;
      const playerId = localPlayerId();
      const object = playerId ? built.objects.get(playerId) : undefined;
      if (!object) return null;
      object.getWorldPosition(netPlayerPos);
      object.getWorldQuaternion(netPlayerQuat);
      netPlayerEuler.setFromQuaternion(netPlayerQuat);
      return {
        position: [netPlayerPos.x, netPlayerPos.y, netPlayerPos.z],
        yaw: netPlayerEuler.y,
      };
    },
    // movement INTENT for the host's proxy sim — mirrors the controller's
    // input mapping (camera-relative WASD → desired horizontal velocity)
    getLocalInput: () => {
      if (playMode.get() !== "playing") return null;
      const playerId = localPlayerId();
      const object = playerId ? built.objects.get(playerId) : undefined;
      if (!playerId || !object) return null;
      const ud = object.userData as { speedMult?: number; frozen?: boolean };
      if (ud.frozen) return { v: [0, 0], jump: false };
      let forward = 0;
      let strafe = 0;
      if (input.isDown("KeyW") || input.isDown("ArrowUp")) forward += 1;
      if (input.isDown("KeyS") || input.isDown("ArrowDown")) forward -= 1;
      if (input.isDown("KeyA") || input.isDown("ArrowLeft")) strafe -= 1;
      if (input.isDown("KeyD") || input.isDown("ArrowRight")) strafe += 1;
      const [fx, fz] = viewForward();
      let x = fx * forward + -fz * strafe;
      let z = fz * forward + fx * strafe;
      const len = Math.hypot(x, z);
      const script = lastExpanded.entities[playerId]?.components["script"] as
        | { params?: { speed?: number } }
        | undefined;
      const speed = (script?.params?.speed ?? 6.5) * (ud.speedMult ?? 1);
      if (len > 0) {
        x = (x / len) * speed;
        z = (z / len) * speed;
      }
      return { v: [x, z], jump: input.isDown("Space") };
    },
    getProxyState: (peerId) => {
      const state = sim?.states().get(netProxyId(peerId));
      return state
        ? { p: [r3(state.position[0]), r3(state.position[1]), r3(state.position[2])] }
        : null;
    },
    // client-side prediction reconciliation: our local sim ran ahead; the
    // host's verdict arrived. Small drift is normal (dead-band), medium
    // drift glides toward authority keeping velocity, huge drift snaps.
    reconcileLocalPlayer: (p) => {
      if (playMode.get() !== "playing" || !sim) return;
      const playerId = localPlayerId();
      if (!playerId) return;
      const state = sim.states().get(playerId);
      if (!state) return;
      const dx = p[0] - state.position[0];
      const dy = p[1] - state.position[1];
      const dz = p[2] - state.position[2];
      const err = Math.hypot(dx, dy, dz);
      if (err > NET_SNAP_DIST) {
        sim.setPosition(playerId, p);
      } else if (err > NET_NUDGE_DIST) {
        const k = 0.2; // one-fifth of the error per snapshot ≈ invisible glide
        sim.setTranslation(playerId, [
          state.position[0] + dx * k,
          state.position[1] + dy * k,
          state.position[2] + dz * k,
        ]);
      }
    },
    collectReplicas: () => {
      if (playMode.get() !== "playing") return null; // host not simulating
      const out: NetReplica[] = [];
      for (const [id, e] of Object.entries(lastExpanded.entities)) {
        const netObj = e.components["netObject"] as NetObjectData | undefined;
        const implicit =
          e.components["script"] !== undefined && e.components["rigidbody"] !== undefined;
        if (!netObj && !implicit) continue;
        if (e.tags.includes("player")) continue; // presence/prediction path
        if (netObj?.authority === "owner") continue; // ownership wiring: task #14
        const object = built.objects.get(id);
        if (!object) continue;
        object.getWorldPosition(netEntityPos);
        object.getWorldQuaternion(netEntityQuat);
        const anim =
          (netObj?.sync.animation ?? true) ? (animations.currentClip(id) ?? undefined) : undefined;
        out.push({
          id,
          p: [r3(netEntityPos.x), r3(netEntityPos.y), r3(netEntityPos.z)],
          q: [
            r3(netEntityQuat.x),
            r3(netEntityQuat.y),
            r3(netEntityQuat.z),
            r3(netEntityQuat.w),
          ],
          ...(anim ? { anim } : {}),
          relevancy: netObj?.relevancy ?? "always",
          radius: netObj?.radius ?? 50,
          sendEvery: netObj?.sendEvery ?? 1,
          syncTransform: netObj?.sync.transform ?? true,
        });
      }
      return out;
    },
    onWorldEntities: (ids) => suspendForHost(ids),
    getEntityObject: (id) =>
      playMode.get() === "playing" ? (built.objects.get(id) ?? null) : null,
    setEntityAnim: (id, clip) => animations.play(id, clip, 0.25),
    // replicated gameplay events ride the session event bus in both directions
    collectNetEvents: () => eventBus?.takeOutbox() ?? [],
    onNetEvents: (events) => eventBus?.injectRemote(events),
    emitLocalEvent: (name, payload) => eventBus?.emit(name, payload),
    // peer→authority requests (to-authority events): out on peers, in on host
    collectPeerEvents: () => eventBus?.takeCommandOutbox() ?? [],
    onPeerEvent: (from, events) => eventBus?.injectFromPeer(from, events),
    onRoleChanged: (role) =>
      eventBus?.setNetRole(role === "host" ? "authority" : role === "peer" ? "peer" : "local"),
  });
  // "unpack model parts": each named sub-object of a loaded kit becomes a child
  // entity referencing that node; the original keeps only the group transform
  function unpackModel(id: string): void {
    const entity = store.doc.entities[id];
    const mesh = structuredClone(entity?.components["mesh"]) as
      | { source: { kind: string; assetId?: string; node?: string }; [k: string]: unknown }
      | undefined;
    if (!entity || mesh?.source.kind !== "asset" || mesh.source.node) return;
    const root = built.objects.get(id)?.children.find((c) => c.userData["modelRoot"]);
    if (!root || root.children.length === 0) {
      console.warn("[unpack] model not loaded yet or has no sub-objects");
      return;
    }
    const ops: Parameters<typeof store.apply>[0] = [];
    for (const node of root.children) {
      if (!node.name) continue;
      ops.push({
        op: "add-entity",
        id: newId(),
        entity: {
          name: node.name,
          parent: id,
          tags: [],
          components: {
            transform: {
              position: node.position.toArray() as [number, number, number],
              rotation: node.quaternion.toArray() as [number, number, number, number],
              scale: node.scale.toArray() as [number, number, number],
            },
            mesh: { ...mesh, source: { ...mesh.source, node: node.name } },
          },
        },
      });
    }
    if (ops.length === 0) return;
    ops.push({ op: "remove-component", id, component: "mesh" });
    try {
      store.apply(ops);
    } catch (error) {
      console.warn("[unpack] rejected:", error);
    }
  }

  function frameEntity(id: string): void {
    const object = built.objects.get(id);
    if (!object) return;
    void controls.fitToBox(new THREE.Box3().setFromObject(object), true, {
      paddingLeft: 1,
      paddingRight: 1,
      paddingTop: 1,
      paddingBottom: 1,
    });
  }

  // Unity-style flow: edit/paused = editor visible; play = fullscreen game.
  // Backquote starts play from edit, pauses from play, and resumes from pause.
  playMode.subscribe(() => {
    editorVisible.set(playMode.get() !== "playing");
  });

  window.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.code === "Backquote") {
      if (playMode.get() === "playing") {
        playMode.set("paused");
      } else {
        // Both edit and paused transition straight into the running game.
        playMode.set("playing");
      }
    }
    // Unity F: frame the selection
    if (e.code === "KeyF" && editorVisible.get()) {
      const id = selection.get();
      if (id) frameEntity(id);
    }
    // H: toggle the perf/stats HUD (mirrors the toolbar "stats" checkbox)
    if (e.code === "KeyH" && editorVisible.get()) {
      settings.set({ ...settings.get(), showStats: !settings.get().showStats });
    }
    // Shift+P: open the profiler window. Bare P belongs to the path tool
    // (packages/editor/src/path-tool.ts), which ignores Shift for exactly
    // this reason — the two must never both fire off one keystroke.
    //
    // Works IN PLAY MODE too, unlike the editor-only bindings above: a hitch
    // you can only reproduce while actually flying is the case this exists
    // for, and a trip back to the editor to look at it defeats the purpose.
    // Safe there because P is not a movement key, so Shift+P stays
    // unambiguous even with Shift held down as the fly-cam boost.
    if (e.code === "KeyP" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const target = e.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true;
      if (!typing) openProfiler();
    }
  });

  // Unity gesture: double-click a prefab instance in the viewport opens its
  // definition in isolation (full toolset; saving propagates to all instances)
  canvas.addEventListener("dblclick", (e) => {
    if (!editorVisible.get() || grayboxActive.get() || pathActive.get()) return;
    const id = viewport.pickAt(e.clientX, e.clientY);
    if (!id) return;
    const prefabId = (store.doc.entities[id]?.components["prefab"] as { prefabId?: string } | undefined)
      ?.prefabId;
    if (prefabId) editPrefab(prefabId);
  });

  // -- play mode: physics world + script runtime from the expanded doc --------

  const scriptRegistry = new ScriptRegistry();
  registerBuiltinScripts(scriptRegistry);
  // any default-exported Script class in src/scripts/ (engine-illustrative,
  // committed) or projects/<game>/scripts/ (self-contained game builds,
  // gitignored — see PROJECTS.md). Both are outside assets/, so Vite's normal
  // watcher/HMR covers them like any other source file, no bridge needed.
  // project-scripts.js owns the glob AND is the HMR boundary for it: a script
  // edit re-registers in place (no full page reload). onReload restarts a live
  // play session so already-running instances pick up the new code.
  initProjectScripts({
    registry: scriptRegistry,
    events,
    onReload: () => {
      if (sim) startPlaySession();
    },
  });
  const input = new InputService();

  const viewDir = new THREE.Vector3();
  function viewForward(): [number, number] {
    camera.getWorldDirection(viewDir);
    viewDir.y = 0;
    if (viewDir.lengthSq() < 1e-6) return [0, -1];
    viewDir.normalize();
    return [viewDir.x, viewDir.z];
  }

  const audio = new AudioSystem(camera, (soundId) => assets.getSound(soundId)?.url);
  const playerDataBackend = new BridgePlayerDataBackend();

  let sim: PhysicsSim | null = null;
  let scripts: ScriptRuntime | null = null;
  let eventBus: EventBus | null = null;
  let followTargetId: string | null = null;
  let followRigMode: "follow" | "chase" | null = null;
  let followRigDistance = 8;
  let followRigHeight = 1;
  function startPlaySession(): void {
    sim?.free();
    scripts?.dispose();
    audio.stopAll();
    audio.resume();
    prevBodyPos.clear();
    currBodyPos.clear();
    sim = new PhysicsSim(lastExpanded, undefined, { meshGeometry });
    // fresh sim — clean out stale proxy anchors; proxies respawn on next input
    for (const id of [...netProxies]) despawnNetProxy(id);
    chunkManager.setSim(sim); // loaded chunks collide too
    subsceneManager.setSim(sim);
    eventBus = new EventBus(events); // one bus per play session — trace starts clean
    // one-shot animations end → a local "animation.completed" on this session's bus
    animations.onClipFinished = (entityId, clip) =>
      eventBus?.emit("animation.completed", { entityId, clip });
    // the net session may already be live — seed the bus with the current role
    const netRole = netPresence?.stats().role ?? "off";
    eventBus.setNetRole(netRole === "host" ? "authority" : netRole === "peer" ? "peer" : "local");
    // alone in the room = fresh single-player run = clean session state;
    // with others present the state belongs to the ROOM and must survive
    netPresence?.resetSessionStateIfSolo();
    scripts = new ScriptRuntime({
      doc: lastExpanded,
      objects: built.objects,
      sim,
      events: eventBus,
      // dev identity: single local player; the scene is the experience
      playerData: new PlayerDataService(playerDataBackend, {
        playerId: "local",
        experienceId: store.doc.name,
      }),
      registry: scriptRegistry,
      profiler, // per-script-name scopes under "scripts" (see RuntimeOptions)
      input,
      viewForward,
      setAnimation: (entityId, clip, fade, opts) =>
        animations.play(entityId, clip, fade ?? 0.3, opts?.loop ?? true),
      setBillboard: (entityId, opts) => billboards.setValue(entityId, opts),
      setParticles: (entityId, opts) => particles.setValue(entityId, opts),
      setLight: setRuntimeLight,
      setPathPoints,
      // replicated session state (ctx.netState) — facts every tab agrees on
      ...(netPresence ? { netState: netPresence.netState } : {}),
      playSound: (entityId, soundId) => {
        const comp = lastExpanded.entities[entityId]?.components["audio"] as
          | AudioComponentData
          | undefined;
        const src = soundId ?? comp?.src;
        if (!src) return;
        void audio.play(built.objects.get(entityId) ?? null, src, soundId ? {} : (comp ?? {}));
      },
    });
    scripts.start();
    chunkManager.forEachLoaded((doc, objects) => scripts?.addEntities(doc, objects));
    subsceneManager.forEachLoaded((doc, objects) => scripts?.addEntities(doc, objects));
    animations.setRunning(true);

    // autoplay audio components (music, ambience)
    for (const [id, entity] of Object.entries(lastExpanded.entities)) {
      const comp = entity.components["audio"] as AudioComponentData | undefined;
      if (comp?.autoplay) void audio.play(built.objects.get(id) ?? null, comp.src, comp);
    }

    // a peer mid-net-session: the host still owns the replicated NPCs, so
    // re-suspend them in the fresh session (the id set didn't change, so
    // onWorldEntities won't re-fire on its own)
    netSuspended.clear();
    if (netPresence) suspendForHost(netPresence.replicatedIds());

    // data-driven follow cam: an active camera with a follow/chase rig tracks its target tag
    followTargetId = null;
    followRigMode = null;
    for (const entity of Object.values(lastExpanded.entities)) {
      const cam = entity.components["camera"] as
        | {
            active?: boolean;
            rig?: { mode: string; targetTag: string; distance?: number; height?: number };
          }
        | undefined;
      if (cam?.active && (cam.rig?.mode === "follow" || cam.rig?.mode === "chase")) {
        const tag = cam.rig.targetTag;
        followTargetId =
          Object.entries(lastExpanded.entities).find(([, e]) => e.tags.includes(tag))?.[0] ?? null;
        followRigMode = cam.rig.mode as "follow" | "chase";
        followRigDistance = cam.rig.distance ?? 8;
        followRigHeight = cam.rig.height ?? 1;
        break;
      }
    }
  }
  function endPlaySession(): void {
    netSuspended.clear(); // the session owns nothing anymore
    for (const id of [...netProxies]) despawnNetProxy(id); // anchors + bodies
    scripts?.dispose();
    scripts = null;
    eventBus = null;
    chunkManager.setSim(null);
    subsceneManager.setSim(null);
    sim?.free();
    sim = null;
    followTargetId = null;
    followRigMode = null;
    animations.setRunning(false);
    audio.stopAll();
  }

  // Incremental path: a batch that only edits EXISTING entities' data patches
  // the live scene in place — no rebuild, no async model reload, no flicker.
  // Anything structural (add/remove/reparent), prefab-shaped (props/overrides
  // change the expanded subtree), or scene-level (sky, cameras, postfx,
  // streaming) falls back to the full rebuild.
  function tryReconcile(result: ApplyResult): boolean {
    if (!built) return false;
    if (result.addedEntities.size > 0 || result.removedEntities.size > 0) return false;
    if (result.changedEntities.size === 0) return true; // no-op batch
    for (const id of result.changedEntities) {
      if (result.changedComponents.get(id)?.has("prefab")) return false;
    }
    // debug overlays (attachPhysicsDebug/attachSkeletonDebug/attachLightDebug,
    // called only from rebuild(), never from this reconcile path) are children
    // of entity groups; an in-place visual rebuild of a DECORATED entity would
    // strip its overlay without anything reattaching it, so those specific
    // entities must take the full rebuild that redraws it. Gating on entity
    // relevance rather than "is any overlay category on anywhere in the
    // scene" matters: with showPhysics/showLights on by default, the blanket
    // form forced every material/mesh/light edit into a full buildScene()
    // teardown+rebuild of the WHOLE doc, regardless of scene size.
    const isDebugRelevant = (doc: EntityDoc): boolean =>
      (settings.get().showPhysics &&
        ("rigidbody" in doc.components || "collider" in doc.components || "joint" in doc.components)) ||
      (settings.get().showLights && "light" in doc.components) ||
      (settings.get().showSkeletons && "animator" in doc.components);
    // scripting/net/audio have no render visuals; physics components join them
    // only while their debug wireframes aren't being drawn — with the overlay
    // on, a collider edit must take the full rebuild that redraws its shape
    const dataOnly = new Set(["script", "netObject", "audio"]);
    if (!settings.get().showPhysics) {
      dataOnly.add("rigidbody").add("collider").add("joint");
    }
    const expanded = expandForRuntime();
    const ok = reconcileScene(
      built,
      lastExpanded,
      expanded,
      result.changedEntities,
      sceneBuildOptions,
      {
        onEntityReset: (id) => {
          animations.unregister(id);
          particles.unregister(id);
          billboards.unregister(id);
          if (id in modelBones.get()) {
            const next = { ...modelBones.get() };
            delete next[id];
            modelBones.set(next);
          }
        },
        allowVisualRebuild: (_id, before, after) => !isDebugRelevant(before) && !isDebugRelevant(after),
        dataOnlyComponents: dataOnly,
      },
    );
    if (!ok) return false;
    lastExpanded = expanded;
    refreshCameraColliders(); // static-tagged scenery may have moved or changed
    return true;
  }

  store.subscribe((change) => {
    if (change.kind === "ops" && tryReconcile(change.result)) {
      reconcileCount++;
      profiler.mark("scene.reconcile");
      return;
    }
    rebuildCount++;
    // A full rebuild reconstructs every mesh and material in the scene and is
    // by far the most expensive thing an editor action can trigger. Marked so
    // that when the frame graph shows a 400ms cliff, the timeline underneath
    // says whether an edit caused it — the difference between a real
    // performance problem and the editor doing what it was told.
    const endRebuild = profiler.span("scene.rebuild", `${Object.keys(store.doc.entities).length} entities`);
    rebuild();
    endRebuild();
  });
  store.subscribe(() => {
    if (sim) startPlaySession(); // edits during play restart the session on the new doc
  });
  // stop restores the scene from the document — sim/script state is runtime-only
  playMode.subscribe(refreshPhysicsDebugVisibility);
  playMode.subscribe(refreshSkeletonDebugVisibility);
  playMode.subscribe(refreshLightDebugVisibility);
  settings.subscribe(refreshSkeletonDebugVisibility);
  playMode.subscribe(() => {
    const mode = playMode.get();
    if (mode === "edit") {
      endPlaySession();
      rebuild();
    } else if (mode === "playing" && !sim) {
      startPlaySession();
    }
  });

  // Fortnite-style mouse look: play mode captures the pointer, so moving the
  // mouse IS the camera. Esc (browser-enforced) or leaving play releases it;
  // clicking the game recaptures. camera-controls' own pointer handling is
  // parked while locked so drags don't double-apply.
  const editorMaxPolar = controls.maxPolarAngle;
  const MOUSE_LOOK_SPEED = 0.0025; // rad per px
  function syncPointerLockState(): void {
    const locked = document.pointerLockElement === canvas;
    controls.enabled = !locked;
  }
  document.addEventListener("pointerlockchange", syncPointerLockState);
  document.addEventListener("mousemove", (e) => {
    if (document.pointerLockElement !== canvas) return;
    // chase rig: the mouse steers the TARGET (e.g. a vehicle's nose) via
    // ctx.input.mouseDelta(), not the camera — it rigidly tracks the target's
    // own heading instead of free-orbiting (see the update loop below).
    if (followRigMode === "chase") {
      input.addMouseDelta(e.movementX, e.movementY);
      return;
    }
    void controls.rotate(-e.movementX * MOUSE_LOOK_SPEED, -e.movementY * MOUSE_LOOK_SPEED, false);
  });
  canvas.addEventListener("mousedown", () => {
    if (playMode.get() === "playing" && document.pointerLockElement !== canvas) {
      // best-effort: modern browsers return a Promise that rejects if the
      // document isn't focused yet (e.g. this click is what's focusing it) —
      // nothing to recover, the next click retries, just don't let it surface
      // as an uncaught rejection
      void canvas.requestPointerLock()?.catch(() => undefined);
    }
  });
  const editorMinDistance = controls.minDistance;
  playMode.subscribe(() => {
    if (playMode.get() === "playing") {
      controls.maxPolarAngle = 1.45; // don't let the game camera dive underground
      controls.minDistance = 2; // collision dolly-in stops at arm's length
      void controls.dollyTo(8, true); // game framing: tighter than editor zoom
      // the play-button click is our user gesture, but this fires from a
      // store subscription (async relative to that click), so the browser
      // can still see it as "document not focused" and reject — best-effort,
      // the mousedown handler above retries on the player's next click
      void canvas.requestPointerLock()?.catch(() => undefined);
    } else {
      controls.maxPolarAngle = editorMaxPolar;
      controls.minDistance = editorMinDistance;
      if (document.pointerLockElement === canvas) document.exitPointerLock();
    }
    refreshCameraColliders();
  });
  rebuild();

  void renderThumbnails({ assets, registry, renderer, backend, thumbnails });
  assetsVersion.subscribe(() => void renderThumbnails({ assets, registry, renderer, backend, thumbnails }));

  // A live material-file edit: patch the already-built material instance in
  // place when the change is a plain property tweak (color/PBR scalars on a
  // material still in the scene), and only refresh that one swatch. Returns
  // false — meaning "take the full rebuild" — for shader-class/texture changes
  // or a material not currently instanced. This spares the common AI edit (nudge
  // a color) the whole-scene teardown + pipeline recompile it used to trigger.
  function patchMaterialLive(id: string, data: unknown): boolean {
    if (!built) return false;
    const material = built.materials.get(id);
    if (!material) return false;
    if (!patchMaterial(material, data as MaterialData)) return false;
    void renderThumbnails({ assets, registry, renderer, backend, thumbnails });
    return true;
  }

  installLiveSync({
    assets,
    registry,
    store,
    selection,
    sceneList,
    chunkManager,
    subsceneManager,
    editingPrefab,
    assetsVersion,
    patchMaterialLive,
    getLastWrittenScene: () => lastWrittenScene,
    setLastWrittenScene: (content) => {
      lastWrittenScene = content;
    },
    getLastWrittenPrefab: () => lastWrittenPrefab,
  });

  const devBridgeDeps = {
    registry,
    assets,
    events,
    camera,
    controls,
    store,
    selection,
    multiSelection,
    hover,
    manipulating,
    editorVisible,
    editingPrefab,
    editingChunk,
    assetSelection,
    tools: { graybox: grayboxActive, terrain: terrainActive, path: pathActive, meshEdit },
    pins: pinStore.pins,
    playMode,
    modelNodes,
    modelBones,
    chunkManager,
    subsceneManager,
    billboards,
    scriptRegistry,
    seeded,
    sceneLoadError,
    netSuspended,
    getBuilt: () => built,
    getLastExpanded: () => lastExpanded,
    getSim: () => sim,
    getEventBus: () => eventBus,
    getNetPresence: () => netPresence,
    getReconcileCount: () => reconcileCount,
    getRebuildCount: () => rebuildCount,
    getPerf: () => buildPerfReport(),
  };
  setInterval(() => postContext(devBridgeDeps), 1000);
  publishEngineSpec(devBridgeDeps);

  clientLog(`boot: ready (backend=${backend}, sceneSource=${seeded ? "code" : "file"})`);

  // -- loop --------------------------------------------------------------------

  // docked editor layout: the canvas shrinks to the center hole (Unity-style),
  // fullscreen when the editor is closed
  function applyCanvasLayout(): void {
    canvas.style.position = "fixed";
    if (editorVisible.get()) {
      const dock = dockSizes.get();
      canvas.style.left = `${dock.left}px`;
      canvas.style.top = `${dock.top}px`;
      canvas.style.width = `calc(100vw - ${dock.left + dock.right}px)`;
      canvas.style.height = `calc(100vh - ${dock.top + dock.bottom}px)`;
      // stats HUD lives in the canvas's own top-right corner, not the
      // window's — otherwise it sits under the editor's right-side dock
      hud.style.top = `${dock.top + 8}px`;
      hud.style.right = `${dock.right + 8}px`;
    } else {
      canvas.style.left = "0px";
      canvas.style.top = "0px";
      canvas.style.width = "100vw";
      canvas.style.height = "100vh";
      hud.style.top = "8px";
      hud.style.right = "8px";
    }
    onResize();
  }

  function onResize(): void {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    for (const sceneCam of built?.cameras.values() ?? []) {
      sceneCam.aspect = w / h;
      sceneCam.updateProjectionMatrix();
    }
    // uncapped devicePixelRatio renders at 4-9x the pixel count on common
    // hi-DPI displays (2x-3x scaling) — every per-pixel cost (bloom's blur
    // chain, the custom terrain-splat/water shaders, standard PBR lighting)
    // scales directly with that, so an uncapped ratio can turn "moderate"
    // scene cost into an unplayable one. Confirmed fill-rate/fragment-bound
    // via real frame-timing data (JS submission cost stayed low while total
    // frame time didn't move) — 1.0 trades hi-DPI sharpness for a guaranteed,
    // resolution-proportional cut to every per-pixel cost in the scene at
    // once, rather than guessing which specific shader is the heavy one.
    const pixelRatio = Math.min(window.devicePixelRatio, 1.0);
    renderer.setSize(w, h, pixelRatio);
  }
  window.addEventListener("resize", onResize);
  editorVisible.subscribe(applyCanvasLayout);
  dockSizes.subscribe(applyCanvasLayout);
  applyCanvasLayout();

  let lastFrameMs = 0;
  /**
   * Cached profiler summary. summary() walks the whole ring (900 frames x
   * every interned scope), which is cheap at 4Hz and wasteful at 60Hz — the
   * HUD, the dev bridge, and the profiler window all read this one copy
   * instead of each recomputing it on their own cadence.
   */
  let perfCache: ReturnType<typeof profiler.summary> | null = null;
  let perfCachedAt = 0;
  function perfSummary(): ReturnType<typeof profiler.summary> {
    const t = performance.now();
    if (!perfCache || t - perfCachedAt > 250) {
      perfCache = profiler.summary();
      perfCachedAt = t;
    }
    return perfCache;
  }
  /**
   * Open the profiler in its own window (toolbar button, or P).
   *
   * GPU timestamps switch on with the window and off with it: they cost a
   * query pair plus a buffer copy per pass every frame, which is a price
   * worth paying while someone is looking and not otherwise.
   */
  function openProfiler(): void {
    openProfilerWindow({
      profiler,
      setGpuTiming: (on) => renderer.setGpuTiming(on),
      backend,
      describeSession: () =>
        `${store.doc.name} · ${playMode.get()}${chunkManager.stats.chunks > 0 ? ` · ${chunkManager.stats.chunks} chunks` : ""}`,
      // The snapshot goes where an agent can read it: a FILE, in the repo,
      // under .hitreg/profiles/. This is the loop the whole feature is for —
      // hit a hitch, press one button, then say "read the latest profile
      // snapshot" instead of describing a stutter in prose. The note is the
      // most valuable field in it: "choppy flying low over the north shore"
      // is the context that makes numbers a bug report.
      sendToAgent: async (note) => {
        const summary = profiler.summary();
        const response = await fetch("/__hitreg/profile", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            scene: store.doc.name,
            playMode: playMode.get(),
            backend,
            note,
            capturedAt: new Date().toISOString(),
            camera: camera.position.toArray().map((v) => Number(v.toFixed(1))),
            // the verdict in plain English, so whoever opens the file first —
            // person or model — reads the conclusion before the numbers
            digest: digestProfile(summary),
            report: buildPerfReport(),
            full: summary,
          }),
        });
        if (!response.ok) throw new Error(`snapshot failed (HTTP ${response.status})`);
        const body = (await response.json()) as { ok?: boolean; file?: string; error?: string };
        if (!body.ok || !body.file) throw new Error(body.error ?? "snapshot rejected");
        return { file: body.file };
      },
    });
  }

  /**
   * The profiler, condensed for `GET /__hitreg/context` — an agent debugging a
   * hitch over curl gets the same numbers the popup window draws, without a
   * screenshot. Trimmed to what is actionable: percentiles rather than means,
   * the heaviest scopes by SELF time, the most recent spikes with whatever
   * marker explains each one.
   */
  function buildPerfReport() {
    const perf = perfSummary();
    const r1 = (v: number) => Number(v.toFixed(2));
    return {
      fps: perf.fps,
      windowSeconds: perf.windowSeconds,
      /** Wall-clock frame arrival — what the player feels. */
      frameMs: {
        p50: r1(perf.intervalMs.p50),
        p95: r1(perf.intervalMs.p95),
        p99: r1(perf.intervalMs.p99),
        max: r1(perf.intervalMs.max),
      },
      /** Split of that: JS in the loop, GPU, and time outside the loop entirely. */
      jsMs: { avg: r1(perf.frameMs.avg), p95: r1(perf.frameMs.p95), max: r1(perf.frameMs.max) },
      gpuMs: perf.gpuMs ? { avg: r1(perf.gpuMs.avg), max: r1(perf.gpuMs.max) } : null,
      offLoopMs: { avg: r1(perf.gapMs.avg), p95: r1(perf.gapMs.p95), max: r1(perf.gapMs.max) },
      jankPct: { over16: r1(perf.over16Pct), over33: r1(perf.over33Pct) },
      hotScopes: [...perf.scopes]
        .sort((a, b) => b.avgSelfMs - a.avgSelfMs)
        .slice(0, 12)
        .map((s) => ({
          path: s.path,
          selfMs: r1(s.avgSelfMs),
          totalMs: r1(s.avgMs),
          p95Ms: r1(s.p95Ms),
          maxMs: r1(s.maxMs),
          callsPerFrame: r1(s.callsPerFrame),
        })),
      counters: Object.fromEntries(
        Object.entries(perf.counters).map(([k, v]) => [k, { last: r1(v.last), max: r1(v.max) }]),
      ),
      spikes: perf.spikes.slice(-8).map((s) => ({
        frameMs: r1(Math.max(s.totalMs, s.intervalMs)),
        jsMs: r1(s.totalMs),
        offLoopMs: r1(s.gapMs),
        worst: s.scopes.slice(0, 3).map((x) => `${x.path} ${x.selfMs.toFixed(1)}ms`),
        markers: s.markers.map((m) => `${m.label}${m.ms > 0 ? ` ${m.ms.toFixed(0)}ms` : ""}${m.detail ? ` (${m.detail})` : ""}`),
      })),
      /** Long spans (loads, rebuilds) recently seen, newest last. */
      recentEvents: perf.markers
        .slice(-14)
        .map((m) => `${m.label}${m.ms > 0 ? ` ${m.ms.toFixed(0)}ms` : ""}${m.detail ? ` (${m.detail})` : ""}`),
      gpuTiming: renderer.gpuTimingActive,
    };
  }

  /**
   * Per-frame scalars the profiler graphs alongside the timings. Sampled after
   * render() so the renderer's counters describe the frame just submitted.
   *
   * These are what turn a timing into a diagnosis: "render 9ms" says nothing
   * on its own, but "render 9ms at 4,300 draw calls" and "render 9ms at 180
   * draw calls" are different problems with different fixes (batching vs.
   * fill rate / shader cost).
   */
  function sampleFrameCounters(): void {
    if (!profiler.enabled) return;
    const info = renderer.renderer.info;
    profiler.setCounter("drawCalls", info.render.drawCalls);
    profiler.setCounter("triangles", info.render.triangles);
    profiler.setCounter("geometries", info.memory.geometries);
    profiler.setCounter("textures", info.memory.textures);
    // program count is not on the WebGPU Info type but is present at runtime;
    // a climbing count during play means shaders are still compiling, which is
    // the classic "first lap through a level stutters" cause
    profiler.setCounter("programs", (info as { programs?: unknown[] }).programs?.length ?? 0);
    const gpuMs = renderer.gpuFrameMs();
    if (gpuMs !== null) profiler.setGpuMs(gpuMs);
    const chunkStats = chunkManager.stats;
    profiler.setCounter("chunks", chunkStats.chunks);
    profiler.setCounter("chunkEntities", chunkStats.entities);
    profiler.setCounter("loading", chunkStats.loading + subsceneManager.stats.loading + gltfLoadingCount());
    const tiers = foliageLod.tierCounts();
    profiler.setCounter("foliageNear", tiers.near);
    profiler.setCounter("foliageMid", tiers.mid);
    profiler.setCounter("foliageFar", tiers.far);
    const clusterStats = clusterLod.stats();
    profiler.setCounter("clusterMeshes", clusterStats.meshes);
    profiler.setCounter("clusterTris", clusterStats.triangles);
    profiler.setCounter("objects", built.objects.size);
  }

  const followPos = new THREE.Vector3();
  // camera colliders are now distance-limited (see refreshCameraColliders) —
  // must stay synced with camera movement, not just scene/model-load events;
  // throttled by distance (like chunkManager's cell-boundary check) since the
  // refresh itself does real work (traverse per nearby static entity), just
  // far less than the raycast cost it replaced.
  let lastColliderRefreshPos: THREE.Vector3 | null = null;
  const COLLIDER_REFRESH_DIST_SQ = 20 * 20;
  const foliageLodCameraPos = new THREE.Vector3();
  const chaseForward = new THREE.Vector3();
  const chaseUpAxis = new THREE.Vector3(0, 1, 0);
  const chaseOffset = new THREE.Vector3();
  const chaseEye = new THREE.Vector3();
  const chaseYawQuat = new THREE.Quaternion();
  // render-side smoothing: bodies step at the fixed rate, frames don't — draw
  // them interpolated between the last two sim states (scripts still read the
  // exact stepped state inside fixedUpdate)
  const prevBodyPos = new Map<string, THREE.Vector3>();
  const currBodyPos = new Map<string, THREE.Vector3>();
  const lerpPos = new THREE.Vector3();
  const TELEPORT_SNAP_SQ = 25; // jumps larger than this are teleports, not motion
  /** Host: spawn a physics proxy for a remote player, cloning the local
   * player's rigidbody/collider so both feel identical to the world. The
   * proxy also registers with the script runtime under the "player" tag —
   * NPCs (chasers, future AI) target remote players exactly like the local
   * one, via an anchor object the sim's body-state loop keeps updated. */
  function spawnNetProxy(id: string, p: [number, number, number]): void {
    if (!sim) return;
    const playerEntity = Object.values(lastExpanded.entities).find((e) =>
      e.tags.includes("player"),
    );
    const rigidbody = playerEntity?.components["rigidbody"] ?? { kind: "dynamic" };
    const collider = playerEntity?.components["collider"] ?? {
      shape: "capsule",
      size: [0.4, 1.2, 0.4],
    };
    const partial: SceneDoc = {
      ...lastExpanded,
      entities: {
        [id]: {
          name: id,
          parent: null,
          tags: ["player", "net-player"],
          components: {
            transform: { position: p, rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
            rigidbody: structuredClone(rigidbody),
            collider: structuredClone(collider),
          },
        },
      },
    };
    const anchor = new THREE.Group();
    anchor.name = id;
    anchor.position.set(p[0], p[1], p[2]);
    built.scene.add(anchor);
    built.objects.set(id, anchor); // the sim body-state loop now drives it
    sim.addEntities(partial);
    scripts?.addEntities(partial, built.objects, { silent: true }); // tag visibility, no script
    netProxies.add(id);
  }

  function despawnNetProxy(id: string): void {
    sim?.removeEntities([id]);
    scripts?.removeEntities([id], { silent: true });
    const anchor = built.objects.get(id);
    if (anchor) {
      built.scene.remove(anchor);
      built.objects.delete(id);
    }
    prevBodyPos.delete(id);
    currBodyPos.delete(id);
    netProxies.delete(id);
  }

  const loop = new FixedTimestepLoop({
    fixedUpdate: (dt) => {
      if (playMode.get() !== "playing" || !sim) return;
      // "fixed" nests under the frame, and can run MORE THAN ONCE per frame
      // (the loop substeps to catch up). callsPerFrame in the profiler table
      // is how that shows: a fixed scope averaging 2.4 calls/frame means the
      // sim is chasing a backlog, which is itself a finding.
      profiler.begin("fixed");
      // host-authoritative remote players: fresh intentions drive proxy
      // bodies (clamped — peers send intent, never state), stale peers despawn
      if (netPresence) {
        profiler.begin("net.inputs");
        const active = new Set<string>();
        for (const { peerId, v, jump, p } of netPresence.activeRemoteInputs()) {
          const id = netProxyId(peerId);
          active.add(id);
          if (!netProxies.has(id)) spawnNetProxy(id, p);
          const vel = sim.getLinvel(id);
          if (!vel) continue; // proxy failed to spawn (no sim yet)
          let [vx, vz] = v;
          const speed = Math.hypot(vx, vz);
          if (speed > NET_MAX_SPEED) {
            vx = (vx / speed) * NET_MAX_SPEED;
            vz = (vz / speed) * NET_MAX_SPEED;
          }
          let vy = vel[1];
          if (jump && Math.abs(vy) < 0.05) vy = NET_JUMP_VELOCITY;
          sim.setLinvel(id, [vx, vy, vz]);
        }
        for (const id of [...netProxies]) {
          if (!active.has(id)) despawnNetProxy(id);
        }
        profiler.end();
      }
      // sim/scripts mutate RUNTIME objects only — the document is authoring truth
      // solver and state-readback are split: the solver scales with body
      // COUNT and contact complexity, the readback with how many of those
      // bodies have render objects — they grow for different reasons and
      // have different fixes, so one "physics" number can't be acted on
      profiler.begin("physics.step");
      sim.step(dt);
      profiler.end();
      profiler.begin("physics.readback");
      for (const [id, state] of sim.states()) {
        const object = built.objects.get(id);
        if (!object) continue;
        applyBodyState(object, state);
        const curr = currBodyPos.get(id);
        if (curr) {
          const prev = prevBodyPos.get(id)!;
          prev.copy(curr);
          curr.set(state.position[0], state.position[1], state.position[2]);
          if (prev.distanceToSquared(curr) > TELEPORT_SNAP_SQ) prev.copy(curr);
        } else {
          const p = new THREE.Vector3(state.position[0], state.position[1], state.position[2]);
          currBodyPos.set(id, p);
          prevBodyPos.set(id, p.clone());
        }
      }
      profiler.end();
      // per-script-name scopes come from inside the runtime (see its
      // `profiler` option) — this wrapper is what nests them under "scripts"
      profiler.begin("scripts");
      scripts?.fixedUpdate(dt);
      profiler.end();
      profiler.end(); // fixed
    },
    update: (dt, alpha) => {
      profiler.begin("update");
      profiler.begin("interpolate");
      // draw dynamic bodies between their last two sim states
      if (playMode.get() === "playing" && sim) {
        for (const [id, curr] of currBodyPos) {
          const object = built.objects.get(id);
          const prev = prevBodyPos.get(id);
          if (!object?.parent || !prev) continue;
          lerpPos.lerpVectors(prev, curr, alpha);
          object.parent.updateWorldMatrix(true, false);
          object.position.copy(object.parent.worldToLocal(lerpPos));
        }
      }
      profiler.end(); // interpolate
      profiler.begin("follow-cam");
      // follow cam: keep the orbit center on the target; the pointer-lock
      // mouse look (play) or drag-orbit (paused) supplies the rotation.
      // chase cam: rigid third-person — camera sits behind the target's own
      // current YAW (roll/pitch ignored so it never tips with the vehicle) at
      // rig.distance/height; the mouse is free for a script to steer instead.
      if (playMode.get() !== "edit" && followTargetId) {
        const target = built.objects.get(followTargetId);
        if (target) {
          const p = target.getWorldPosition(followPos);
          if (followRigMode === "chase") {
            chaseForward.set(0, 0, -1).applyQuaternion(target.quaternion);
            const yaw = Math.atan2(-chaseForward.x, -chaseForward.z);
            chaseYawQuat.setFromAxisAngle(chaseUpAxis, yaw);
            chaseOffset.set(0, followRigHeight, followRigDistance).applyQuaternion(chaseYawQuat);
            chaseEye.copy(p).add(chaseOffset);
            void controls.setLookAt(chaseEye.x, chaseEye.y, chaseEye.z, p.x, p.y + 1, p.z, false);
          } else {
            void controls.moveTo(p.x, p.y + 1, p.z, true);
          }
        }
      }
      profiler.end(); // follow-cam
      if (playMode.get() === "playing") {
        profiler.begin("animations");
        animations.update(dt);
        profiler.end();
      }
      // chunk streaming follows the player in play mode, the fly-cam in edit
      {
        const focusObj =
          playMode.get() !== "edit" && followTargetId ? built.objects.get(followTargetId) : null;
        profiler.begin("chunks");
        if (focusObj) {
          const p = focusObj.getWorldPosition(followPos);
          chunkManager.update(p.x, p.z);
          profiler.end();
          profiler.begin("subscenes");
          subsceneManager.update(p.x, p.z);
        } else {
          chunkManager.update(camera.position.x, camera.position.z);
          profiler.end();
          profiler.begin("subscenes");
          subsceneManager.update(camera.position.x, camera.position.z);
        }
        profiler.end();
      }
      if (
        playMode.get() !== "edit" &&
        (!lastColliderRefreshPos || lastColliderRefreshPos.distanceToSquared(camera.position) > COLLIDER_REFRESH_DIST_SQ)
      ) {
        lastColliderRefreshPos = camera.position.clone();
        profiler.begin("camera-colliders");
        refreshCameraColliders();
        profiler.end();
      }
      profiler.begin("camera");
      updateFlyCam(dt);
      // while flying, the fly-cam owns the camera — camera-controls' update
      // would overwrite our position/rotation from its own internal state
      if (!flyLookMode) controls.update(dt);
      // camera priority in play mode: script-switched cam > rigless active scene
      // cam > editor/follow camera. Edit mode always uses the editor camera.
      let renderCamera: THREE.Camera = camera;
      if (playMode.get() !== "edit") {
        const switched = scripts?.getActiveCameraId();
        if (switched && built.cameras.get(switched)) {
          renderCamera = built.cameras.get(switched)!;
        } else if (!followTargetId && built.activeCamera) {
          renderCamera = built.activeCamera;
        }
      }
      profiler.end(); // camera
      // each of these walks or rebuilds its own instanced/visibility set every
      // frame, and any one of them can dominate alone — the old lumped
      // "foliage" number could never say which
      profiler.begin("particles");
      particles.update(dt, renderCamera); // billboards face the camera actually used
      profiler.end();
      profiler.begin("grass");
      grass.update(renderCamera, sampleTerrainHeight, sampleGrassyGround);
      profiler.end();
      profiler.begin("foliage-lod");
      // the near→mid LOD switch is judged in screen pixels, so the system
      // needs the projection actually in use — idempotent when unchanged
      if ((renderCamera as THREE.PerspectiveCamera).isPerspectiveCamera) {
        foliageLod.setProjection(
          canvas.clientHeight || window.innerHeight,
          (renderCamera as THREE.PerspectiveCamera).fov,
        );
      }
      foliageLod.update(renderCamera.getWorldPosition(foliageLodCameraPos));
      clusterLod.update(renderCamera, canvas.clientHeight || window.innerHeight);
      profiler.end();
      profiler.begin("light-budget");
      lightBudget.update(built.scene, renderCamera);
      profiler.end();
      // recenter the sky dome on whichever camera is actually rendering — a
      // fixed-radius BackSide sphere only reads as an infinite background
      // while the camera stays inside it (see scene-builder.ts's buildSkyDome)
      if (skyDomeMesh) skyDomeMesh.position.copy(renderCamera.getWorldPosition(foliageLodCameraPos));
      profiler.begin("net");
      netPresence?.update(dt); // remote avatars lerp toward their snapshot targets
      profiler.end();
      profiler.end(); // update
      // render sits OUTSIDE "update", at the top level: it is the one scope
      // you compare directly against the GPU number, and burying it inside
      // another subtotal makes that comparison harder to read
      profiler.begin("render");
      renderer.render(built.scene, renderCamera);
      profiler.end();
      sampleFrameCounters();
      lastFrameMs = dt * 1000;
    },
  });

  setInterval(() => {
    // stats HUD is a view-only overlay toggled from the toolbar / H key
    const statsOn = settings.get().showStats;
    hud.style.display = statsOn ? "" : "none";
    if (!statsOn) return;
    const mode = playMode.get();
    const hint =
      mode === "playing"
        ? "~ pause + editor"
        : mode === "paused"
          ? "PAUSED — ~ resume · ⏹ stop in toolbar"
          : "~ editor";
    const chunkStats = chunkManager.stats;
    const subStats = subsceneManager.stats;
    const netStats = netPresence?.stats();
    // GPU-side reality check: entity counts don't tell you what actually got
    // submitted to the renderer this frame — draw calls / triangles do.
    const info = renderer.renderer.info;
    const tiers = foliageLod.tierCounts();
    const perf = perfSummary();
    // the heaviest leaves by SELF time — the code actually burning the frame,
    // not the parent scopes that merely contain it
    const top = [...perf.scopes]
      .sort((a, b) => b.avgSelfMs - a.avgSelfMs)
      .filter((s) => s.avgSelfMs >= 0.15)
      .slice(0, 3)
      .map((s) => `${s.name} ${s.avgSelfMs.toFixed(1)}`)
      .join(" · ");
    // "is it stuck or just loading" was previously invisible — chunk/subscene
    // files streaming in and glTF models fetching/parsing (loadGltf) are the
    // three async load sources that can leave props/geometry silently absent
    // for a while; surface all three as one number, impossible to miss.
    const loadingCount = chunkStats.loading + subStats.loading + gltfLoadingCount();
    hud.style.color = loadingCount > 0 ? "#ffd633" : "";
    if (sceneSwitchPending) {
      const elapsed = performance.now() - sceneSwitchStartedAt;
      // a brief grace period before "loadingCount === 0" counts as "done" —
      // chunk/model loads kicked off by the rebuild take a beat (an
      // animation frame or two) to actually register as in-flight; checking
      // too early would read as "nothing loading" before anything's started
      if ((elapsed > 300 && loadingCount === 0) || elapsed > SCENE_SWITCH_TIMEOUT_MS) hideSceneLoading();
    }
    hud.textContent =
      (loadingCount > 0 ? `⏳ loading: ${loadingCount}\n` : "") +
      `backend: ${backend}\n` +
      `entities: ${Object.keys(store.doc.entities).length} (source)\n` +
      (chunkStats.chunks > 0
        ? `chunks: ${chunkStats.chunks} (${chunkStats.entities} streamed)\n`
        : "") +
      (subStats.loaded > 0
        ? `subscenes: ${subStats.loaded} (${subStats.entities} streamed)\n`
        : "") +
      (netStats && netStats.role !== "off"
        ? `net: ${netStats.role}${netStats.via ? ` (${netStats.via})` : ""} · ${netStats.players} players\n`
        : "") +
      (tiers.near + tiers.mid + tiers.far > 0
        ? `foliage LOD: ${tiers.near} near · ${tiers.mid} mid · ${tiers.far} far\n`
        : "") +
      ((s) =>
        s.meshes > 0
          ? `cluster LOD: ${s.meshes} meshes · ${s.clusters} clusters · ${s.triangles.toLocaleString()} tris · ${s.culled} culled\n`
          : "")(clusterLod.stats()) +
      `draw calls: ${info.render.drawCalls}  ·  tris: ${info.render.triangles.toLocaleString()}\n` +
      `geometries: ${info.memory.geometries}  ·  textures: ${info.memory.textures}\n` +
      // p95, not the mean: the HUD's job is to make a hitch visible, and a
      // mean is a machine for hiding one. The three worst scopes are named
      // inline so the common case never needs the profiler window at all.
      `fps ${perf.fps.toFixed(0)}  ·  frame p50 ${perf.intervalMs.p50.toFixed(1)} / ` +
      `p95 ${perf.intervalMs.p95.toFixed(1)} / max ${perf.intervalMs.max.toFixed(1)}ms\n` +
      `  js ${perf.frameMs.avg.toFixed(1)}  ·  ` +
      (perf.gpuMs ? `gpu ${perf.gpuMs.avg.toFixed(1)}  ·  ` : "") +
      `off-loop ${perf.gapMs.avg.toFixed(1)}  ·  janky ${perf.over33Pct.toFixed(0)}%\n` +
      (top.length > 0 ? `  ${top}\n` : "") +
      `mode: ${mode}  ·  ${hint}  ·  Shift+P profiler`;
  }, 500);

  function frame(t: number): void {
    profiler.beginFrame();
    loop.tick(t);
    profiler.endFrame();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // The authoritative sim must NOT pause when this window is hidden or fully
  // occluded — browsers stop rAF there, which froze the whole world for every
  // peer the moment a host tab lost visibility. Worker timers are exempt from
  // background throttling, so a tiny worker keeps the fixed loop stepping
  // while hidden; rAF takes back over seamlessly on return (the loop's
  // substep cap guards against catch-up spirals either way).
  const tickerUrl = URL.createObjectURL(
    new Blob(["setInterval(() => postMessage(0), 50);"], { type: "text/javascript" }),
  );
  const bgTicker = new Worker(tickerUrl);
  bgTicker.onmessage = () => {
    if (document.hidden) loop.tick(performance.now());
  };
}

void main();
