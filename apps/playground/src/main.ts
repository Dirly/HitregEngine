import CameraControls from "camera-controls";
import * as THREE from "three/webgpu";
import {
  AssetLibrary,
  ComponentRegistry,
  expandScene,
  FixedTimestepLoop,
  newId,
  registerChunkComponents,
  PlayerDataService,
  registerCoreAssetTypes,
  registerCoreComponents,
  sceneDocSchema,
  SceneStore,
  validateScene,
  type ChunkStreamerData,
  type SceneDoc,
} from "@hitreg/core";
import {
  AnimationSystem,
  attachPhysicsDebug,
  attachSkeletonDebug,
  buildScene,
  collectBones,
  EngineRenderer,
  loadGltf,
  makeMaterial,
  makeMeshGeometryProvider,
  ParticleSystem,
  type AnimatorData,
  type BuiltScene,
  type MaterialData,
} from "@hitreg/render";
import { clone as skeletonClone } from "three/addons/utils/SkeletonUtils.js";
import { AudioSystem, type AudioComponentData } from "./audio-system.js";
import { initPhysics, PhysicsSim, type BodyState } from "@hitreg/physics";
import {
  InputService,
  registerBuiltinScripts,
  ScriptRegistry,
  ScriptRuntime,
} from "@hitreg/scripting";
import {
  createAssetSelection,
  createContextMenu,
  createDockSizes,
  createModelBones,
  createSelection,
  defaultEditorSettings,
  GrayboxTool,
  mountEditor,
  observable,
  ViewportTools,
  type GizmoMode,
  type GrayboxShape,
  type PlayMode,
} from "@hitreg/editor";
import { buildStarterDoc, buildStreetDoc } from "./street-scene.js";
import { ChunkManager } from "./chunk-manager.js";
import { BridgePlayerDataBackend } from "./player-data-bridge.js";
import { NetPresence } from "./net-presence.js";

CameraControls.install({ THREE });

/**
 * assets/ is the project content folder. In dev everything is fetched FRESH
 * from disk through the bridge — vite's module cache must never serve assets
 * (its watcher ignores assets/, so cached imports go stale across reloads).
 * Returns the freshest scene doc content found, if any.
 */
async function loadAssets(assets: AssetLibrary): Promise<string | null> {
  const index = (await fetch("/__hitreg/assets-index").then((r) => r.json())) as Record<
    string,
    string[]
  >;
  const fileUrl = (kind: string, file: string) =>
    `/__hitreg/asset-file?file=${encodeURIComponent(`${kind}/${file}`)}`;
  const readJson = (kind: string, file: string) =>
    fetch(fileUrl(kind, file)).then((r) => r.json());

  for (const file of index["prefabs"] ?? []) {
    const id = file.replace(/\.json$/, "");
    assets.addPrefab(id, await readJson("prefabs", file));
  }
  for (const file of index["materials"] ?? []) {
    const id = file.replace(/\.json$/, "");
    assets.addDataAsset({ id, type: "material", name: id, data: await readJson("materials", file) });
  }
  for (const file of index["models"] ?? []) {
    if (!/\.(glb|gltf)$/.test(file)) continue;
    assets.addModel({ id: file, name: file.split("/").pop()!, url: fileUrl("models", file) });
  }
  for (const file of index["textures"] ?? []) {
    if (!/\.(png|jpe?g|webp)$/i.test(file)) continue;
    assets.addTexture({ id: file, name: file.split("/").pop()!, url: fileUrl("textures", file) });
  }
  for (const file of index["audio"] ?? []) {
    if (!/\.(wav|mp3|ogg)$/i.test(file)) continue;
    assets.addSound({ id: file, name: file.split("/").pop()!, url: fileUrl("audio", file) });
  }

  const sceneFile = (index["scenes"] ?? []).find((f) => f.endsWith(".scene.json"));
  if (!sceneFile) return null;
  return fetch(fileUrl("scenes", sceneFile)).then((r) => r.text());
}

/** Persist an asset file through the dev server's write endpoint. */
function saveAsset(file: string, content: string): void {
  void fetch("/__hitreg/write-asset", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file, content }),
  }).then((res) => {
    if (!res.ok) console.warn("[playground] asset save failed:", file);
  });
}

function clientLog(message: string): void {
  void fetch("/__hitreg/log", { method: "POST", body: message }).catch(() => undefined);
}
window.addEventListener("error", (e) => clientLog(`window.error: ${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => clientLog(`unhandledrejection: ${String(e.reason)}`));

async function main(): Promise<void> {
  clientLog("boot: main() start");
  const canvas = document.getElementById("app") as HTMLCanvasElement;
  const hud = document.getElementById("hud")!;

  const registry = new ComponentRegistry();
  registerCoreComponents(registry);
  registerChunkComponents(registry);
  const assets = new AssetLibrary();
  registerCoreAssetTypes(assets);
  // trimesh/convex colliders cook their geometry from the entity's GLB model
  const meshGeometry = makeMeshGeometryProvider((assetId) => assets.getModel(assetId)?.url);
  // streamed chunk worlds: runtime-only content loaded by distance to the focus
  const chunkManager = new ChunkManager(assets, registry, {
    resolveModel: (assetId) => assets.getModel(assetId)?.url,
    resolveMaterial: (assetId) => assets.getDataAsset(assetId)?.data,
    resolveTexture: (assetId) => assets.getTexture(assetId)?.url,
  }, {
    onLoaded: (doc, objects) => {
      for (const [id, object] of objects) built.objects.set(id, object);
      scripts?.addEntities(doc, objects);
    },
    onUnloaded: (ids) => {
      for (const id of ids) built.objects.delete(id);
      scripts?.removeEntities(ids);
    },
  });

  // -- scene: files are the source of truth (fetched fresh, never bundled) ----
  // otherwise the code-built street seeds the first scene file.

  let initialDoc: SceneDoc | null = null;
  let sceneLoadError = "";
  let loadedSceneContent = "";
  try {
    const content = await loadAssets(assets);
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
  const store = new SceneStore(initialDoc ?? buildStreetDoc(registry), registry);

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
  function persistScene(): void {
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

  async function switchScene(name: string): Promise<void> {
    if (name === store.doc.name) return;
    persistScene(); // save where we were
    try {
      const content = await fetch(
        `/__hitreg/asset-file?file=${encodeURIComponent(`scenes/${name}.scene.json`)}`,
      ).then((r) => r.text());
      const parsed = sceneDocSchema.safeParse(JSON.parse(content));
      if (!parsed.success) {
        console.warn(`[scene] ${name} failed validation:`, parsed.error);
        return;
      }
      playMode.set("edit");
      selection.set(null);
      lastWrittenScene = content;
      store.replace(parsed.data);
    } catch (error) {
      console.warn(`[scene] failed to load ${name}:`, error);
    }
  }

  function newScene(rawName: string): void {
    const name = rawName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!name) return;
    if (sceneList.get().includes(name)) {
      void switchScene(name);
      return;
    }
    persistScene();
    playMode.set("edit");
    selection.set(null);
    const starter = buildStarterDoc(name, registry);
    lastWrittenScene = "";
    store.replace(starter);
    persistScene();
    sceneList.set([...sceneList.get(), name].sort());
  }

  // -- render side -----------------------------------------------------------

  let built: BuiltScene;
  let lastExpanded: SceneDoc;
  let netPresence: NetPresence | null = null; // constructed after the editor mounts
  const animations = new AnimationSystem();
  const particles = new ParticleSystem();
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
  // camera collision: in play mode the follow camera dollies in instead of
  // clipping through static scenery (terrain, rocks, trees)
  function refreshCameraColliders(): void {
    if (!built || playMode.get() === "edit") {
      controls.colliderMeshes = [];
      return;
    }
    const meshes: THREE.Object3D[] = [];
    for (const [id, entity] of Object.entries(lastExpanded.entities)) {
      if (!entity.tags.includes("static")) continue;
      built.objects.get(id)?.traverse((node) => {
        if ((node as THREE.Mesh).isMesh) meshes.push(node);
      });
    }
    controls.colliderMeshes = meshes;
  }
  function rebuild(): void {
    // v1: full rebuild per change — fine at this scale; diffing comes with ECS
    const expanded = expandScene(store.doc, assets, registry);
    lastExpanded = expanded;
    animations.clear();
    particles.clear();
    built = buildScene(expanded, {
      resolveModel: (assetId) => assets.getModel(assetId)?.url,
      resolveMaterial: (assetId) => assets.getDataAsset(assetId)?.data,
      resolveTexture: (assetId) => assets.getTexture(assetId)?.url,
      onParticles: (entityId, group, data) =>
        particles.register(entityId, group, data, (assetId) => assets.getTexture(assetId)?.url),
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
    });
    if (settings.get().showPhysics) attachPhysicsDebug(expanded, built.objects);
    refreshPhysicsDebugVisibility();
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
    void chunkManager.configure(streamer, built.scene);
    for (const sceneCam of built.cameras.values()) {
      sceneCam.aspect = (canvas.clientWidth || 1) / (canvas.clientHeight || 1);
      sceneCam.updateProjectionMatrix();
    }
    netPresence?.attach(built.scene); // remote-player avatars survive rebuilds
    viewport?.onSceneRebuilt();
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
  const thumbnails = observable<Record<string, string>>({});
  const dockSizes = createDockSizes();
  const assetsVersion = observable(0);
  assetsVersion.subscribe(() => rebuild()); // material/prefab edits re-render the scene
  settings.subscribe(() => rebuild()); // physics-debug toggle takes effect immediately

  const viewport: ViewportTools = new ViewportTools({
    canvas,
    camera,
    store,
    selection,
    enabled: editorVisible,
    settings,
    gizmoMode,
    contextMenu,
    grayboxActive,
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
    getScene: () => built.scene,
    onDraggingChanged: (dragging) => {
      gizmoDragging = dragging;
      controls.enabled = !dragging;
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
    visible: editorVisible,
    settings,
    gizmoMode,
    playMode,
    contextMenu,
    assetSelection,
    grayboxActive,
    grayboxShape,
    grayboxBevel,
    thumbnails,
    dockSizes,
    assetsVersion,
    modelBones,
    saveAsset,
    onFocusEntity: frameEntity,
    onUnpackModel: unpackModel,
    scenes: sceneList,
    onSwitchScene: (name) => void switchScene(name),
    onNewScene: newScene,
  });

  // -- multiplayer presence (dev): other tabs on this scene appear as avatars --

  const netPlayerPos = new THREE.Vector3();
  const netPlayerQuat = new THREE.Quaternion();
  const netPlayerEuler = new THREE.Euler(0, 0, 0, "YXZ");
  netPresence = new NetPresence({
    getSceneName: () => store.doc.name,
    getLocalPlayer: () => {
      if (playMode.get() !== "playing") return null;
      const playerId = Object.entries(lastExpanded.entities).find(([, e]) =>
        e.tags.includes("player"),
      )?.[0];
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
  });

  // Unity gesture: double-click a prefab instance in the viewport opens its definition
  canvas.addEventListener("dblclick", (e) => {
    if (!editorVisible.get() || grayboxActive.get()) return;
    const id = viewport.pickAt(e.clientX, e.clientY);
    if (!id) return;
    const prefabId = (store.doc.entities[id]?.components["prefab"] as { prefabId?: string } | undefined)
      ?.prefabId;
    if (prefabId) {
      selection.set(null);
      assetSelection.set({ kind: "prefab", id: prefabId });
    }
  });

  // -- play mode: physics world + script runtime from the expanded doc --------

  const scriptRegistry = new ScriptRegistry();
  registerBuiltinScripts(scriptRegistry);
  // project-defined scripts: any default-exported Script class in src/scripts/
  const projectScripts = import.meta.glob("./scripts/*.ts", { eager: true });
  for (const [path, mod] of Object.entries(projectScripts)) {
    const cls = (mod as { default?: Parameters<ScriptRegistry["register"]>[0] }).default;
    if (cls) {
      try {
        scriptRegistry.register(cls);
      } catch (error) {
        console.warn(`[scripts] failed to register ${path}:`, error);
      }
    }
  }
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
  let followTargetId: string | null = null;
  function startPlaySession(): void {
    sim?.free();
    scripts?.dispose();
    audio.stopAll();
    audio.resume();
    prevBodyPos.clear();
    currBodyPos.clear();
    sim = new PhysicsSim(lastExpanded, undefined, { meshGeometry });
    chunkManager.setSim(sim); // loaded chunks collide too
    scripts = new ScriptRuntime({
      doc: lastExpanded,
      objects: built.objects,
      sim,
      // dev identity: single local player; the scene is the experience
      playerData: new PlayerDataService(playerDataBackend, {
        playerId: "local",
        experienceId: store.doc.name,
      }),
      registry: scriptRegistry,
      input,
      viewForward,
      setAnimation: (entityId, clip, fade) =>
        animations.play(entityId, clip, fade ?? 0.3),
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
    animations.setRunning(true);

    // autoplay audio components (music, ambience)
    for (const [id, entity] of Object.entries(lastExpanded.entities)) {
      const comp = entity.components["audio"] as AudioComponentData | undefined;
      if (comp?.autoplay) void audio.play(built.objects.get(id) ?? null, comp.src, comp);
    }

    // data-driven follow cam: an active camera with a follow rig tracks its target tag
    followTargetId = null;
    for (const entity of Object.values(lastExpanded.entities)) {
      const cam = entity.components["camera"] as
        | { active?: boolean; rig?: { mode: string; targetTag: string } }
        | undefined;
      if (cam?.active && cam.rig?.mode === "follow") {
        const tag = cam.rig.targetTag;
        followTargetId =
          Object.entries(lastExpanded.entities).find(([, e]) => e.tags.includes(tag))?.[0] ?? null;
        break;
      }
    }
  }
  function endPlaySession(): void {
    scripts?.dispose();
    scripts = null;
    chunkManager.setSim(null);
    sim?.free();
    sim = null;
    followTargetId = null;
    animations.setRunning(false);
    audio.stopAll();
  }

  store.subscribe(rebuild);
  store.subscribe(() => {
    if (sim) startPlaySession(); // edits during play restart the session on the new doc
  });
  // stop restores the scene from the document — sim/script state is runtime-only
  playMode.subscribe(refreshPhysicsDebugVisibility);
  playMode.subscribe(refreshSkeletonDebugVisibility);
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
    void controls.rotate(-e.movementX * MOUSE_LOOK_SPEED, -e.movementY * MOUSE_LOOK_SPEED, false);
  });
  canvas.addEventListener("mousedown", () => {
    if (playMode.get() === "playing" && document.pointerLockElement !== canvas) {
      canvas.requestPointerLock();
    }
  });
  const editorMinDistance = controls.minDistance;
  playMode.subscribe(() => {
    if (playMode.get() === "playing") {
      controls.maxPolarAngle = 1.45; // don't let the game camera dive underground
      controls.minDistance = 2; // collision dolly-in stops at arm's length
      void controls.dollyTo(8, true); // game framing: tighter than editor zoom
      canvas.requestPointerLock(); // the play-button click is our user gesture
    } else {
      controls.maxPolarAngle = editorMaxPolar;
      controls.minDistance = editorMinDistance;
      if (document.pointerLockElement === canvas) document.exitPointerLock();
    }
    refreshCameraColliders();
  });
  rebuild();

  const bodyWorldPos = new THREE.Vector3();
  const parentQuat = new THREE.Quaternion();
  const bodyQuat = new THREE.Quaternion();
  function applyBodyState(object: THREE.Object3D, state: BodyState): void {
    const parent = object.parent;
    if (!parent) return;
    parent.updateWorldMatrix(true, false);
    object.position.copy(
      parent.worldToLocal(bodyWorldPos.set(state.position[0], state.position[1], state.position[2])),
    );
    parent.getWorldQuaternion(parentQuat).invert();
    object.quaternion.copy(
      parentQuat.multiply(bodyQuat.set(state.rotation[0], state.rotation[1], state.rotation[2], state.rotation[3])),
    );
  }

  // -- prefab thumbnails: render each prefab to a tiny offscreen target -------

  const THUMB = 96;

  /** Frame `object` in a 3/4 studio view and rasterize it to a PNG data URL. */
  async function snapshotObject(object: THREE.Object3D): Promise<string> {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0e14);
    scene.add(new THREE.AmbientLight(0xffffff, 1.2));
    const sun = new THREE.DirectionalLight(0xfff5e0, 2);
    sun.position.set(3, 5, 4);
    scene.add(sun);
    scene.add(object);

    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3()).length() || 1;
    const center = box.getCenter(new THREE.Vector3());
    const cam = new THREE.PerspectiveCamera(45, 1, 0.01, size * 10);
    cam.position.copy(center).add(new THREE.Vector3(size * 0.7, size * 0.55, size * 0.7));
    cam.lookAt(center);

    const target = new THREE.RenderTarget(THUMB, THUMB);
    renderer.renderer.setRenderTarget(target);
    renderer.renderer.render(scene, cam);
    const pixels = (await renderer.renderer.readRenderTargetPixelsAsync(
      target,
      0,
      0,
      THUMB,
      THUMB,
    )) as Uint8Array;
    renderer.renderer.setRenderTarget(null);
    target.dispose();

    const canvas2d = document.createElement("canvas");
    canvas2d.width = THUMB;
    canvas2d.height = THUMB;
    const ctx = canvas2d.getContext("2d")!;
    const image = ctx.createImageData(THUMB, THUMB);
    // WebGPU copies each row into a buffer aligned to 256 bytes;
    // `readRenderTargetPixelsAsync()` returns that padded buffer verbatim.
    // Treating it as tightly packed RGBA made every following row start 128
    // bytes early at our 96px thumbnail size, producing horizontal strips.
    // WebGPU uses top-left row order, while the WebGL fallback is bottom-up.
    const bytesPerPixel = 4; // RenderTarget's default RGBA UnsignedByteType
    const sourceRowStride = Math.ceil((THUMB * bytesPerPixel) / 256) * 256;
    const destinationRowStride = THUMB * bytesPerPixel;
    for (let y = 0; y < THUMB; y++) {
      const sourceY = backend === "webgl" ? THUMB - 1 - y : y;
      const src = sourceY * sourceRowStride;
      image.data.set(
        pixels.subarray(src, src + destinationRowStride),
        y * destinationRowStride,
      );
    }
    ctx.putImageData(image, 0, 0);
    return canvas2d.toDataURL();
  }

  async function renderThumbnails(): Promise<void> {
    const out: Record<string, string> = { ...thumbnails.get() };
    let changed = false;
    for (const pid of assets.prefabIds()) {
      try {
        const key = `${pid}:${JSON.stringify(assets.getPrefab(pid)).length}`;
        if (out[`__key_${pid}`] === key) continue;
        const thumbDoc = buildStreetDocEmpty(pid);
        const expanded = expandScene(thumbDoc, assets, registry);
        const thumb = buildScene(expanded, {
          resolveMaterial: (id) => assets.getDataAsset(id)?.data,
        });
        out[pid] = await snapshotObject(thumb.scene);
        out[`__key_${pid}`] = key;
        changed = true;
      } catch (error) {
        console.warn(`[thumbnails] failed for prefab ${pid}:`, error);
      }
    }

    for (const mid of assets.modelIds()) {
      try {
        const model = assets.getModel(mid);
        if (!model) continue;
        const key = model.url;
        if (out[`__key_model_${mid}`] === key) continue;
        const gltf = await loadGltf(model.url);
        // the cache shares one loaded scene: always render a skeleton-safe clone
        const instance = skeletonClone(gltf.scene);
        out[mid] = await snapshotObject(instance);
        out[`__key_model_${mid}`] = key;
        changed = true;
      } catch (error) {
        console.warn(`[thumbnails] failed for model ${mid}:`, error);
      }
    }

    for (const asset of assets.dataAssetsOfType("material")) {
      try {
        const key = JSON.stringify(asset.data);
        if (out[`__key_material_${asset.id}`] === key) continue;
        const data = asset.data as MaterialData;
        const material = makeMaterial(data) as THREE.Material & { map?: THREE.Texture | null };
        const textureUrl = data.map ? assets.getTexture(data.map)?.url : undefined;
        if (textureUrl && data.shader !== "wireframe") {
          // snapshot is one-shot (no render loop to pick up a later-arriving
          // texture), so wait for it instead of the fire-and-forget helper
          const texture = await new THREE.TextureLoader().loadAsync(textureUrl);
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.wrapS = THREE.RepeatWrapping;
          texture.wrapT = THREE.RepeatWrapping;
          const [rx, ry] = data.repeat ?? [1, 1];
          texture.repeat.set(rx, ry);
          material.map = texture;
          material.needsUpdate = true;
        }
        const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), material);
        out[asset.id] = await snapshotObject(sphere);
        out[`__key_material_${asset.id}`] = key;
        changed = true;
      } catch (error) {
        console.warn(`[thumbnails] failed for material ${asset.id}:`, error);
      }
    }

    if (changed) thumbnails.set(out);
  }

  function buildStreetDocEmpty(prefabId: string) {
    const { doc: d } = (() => {
      const empty = { version: 1 as const, name: "thumb", entities: {} };
      return {
        doc: {
          ...empty,
          entities: {
            subject: {
              name: "Subject",
              parent: null,
              tags: [],
              components: { transform: {}, prefab: { prefabId, props: {}, overrides: [] } },
            },
          },
        },
      };
    })();
    return d;
  }

  void renderThumbnails();
  assetsVersion.subscribe(() => void renderThumbnails());

  // -- live sync: file changes (AI edits, text editors) apply in place --------

  if (import.meta.hot) {
    import.meta.hot.on(
      "hitreg:asset-changed",
      (payload: { file: string; content: string | null }) => {
        const { file, content } = payload;
        if (!content) return;
        try {
          if (file.startsWith("scenes/")) {
            const name = file.slice("scenes/".length).replace(/\.scene\.json$/, "");
            if (!sceneList.get().includes(name)) {
              sceneList.set([...sceneList.get(), name].sort()); // e.g. an agent made a scene
            }
            if (name !== store.doc.name) return; // change to a scene we're not editing
            if (content === lastWrittenScene) return; // our own autosave echo
            const doc = sceneDocSchema.parse(JSON.parse(content));
            const issues = validateScene(doc, registry);
            if (issues.length > 0) {
              console.warn("[live-sync] scene file invalid:", issues);
              return;
            }
            lastWrittenScene = content;
            selection.set(null);
            store.replace(doc);
          } else if (file.startsWith("materials/")) {
            const id = file.slice("materials/".length).replace(/\.json$/, "");
            const data = JSON.parse(content);
            const asset = { id, type: "material", name: id, data };
            if (assets.getDataAsset(id)) assets.updateDataAsset(asset);
            else assets.addDataAsset(asset);
            assetsVersion.set(assetsVersion.get() + 1);
          } else if (file.startsWith("prefabs/")) {
            const id = file.slice("prefabs/".length).replace(/\.json$/, "");
            const doc = JSON.parse(content);
            if (assets.getPrefab(id)) assets.updatePrefab(id, doc);
            else assets.addPrefab(id, doc);
            assetsVersion.set(assetsVersion.get() + 1);
          } else if (file.startsWith("chunks/")) {
            // hot-swap a loaded chunk in place (or pick up a brand-new cell)
            void chunkManager.onFileChanged(file.slice("chunks/".length), content);
          }
        } catch (error) {
          console.warn(`[live-sync] rejected change to ${file}:`, error);
        }
      },
    );
  }

  // -- context bridge: post what the user sees for AI focus tasks -------------

  const frustum = new THREE.Frustum();
  const projScreen = new THREE.Matrix4();
  function postContext(): void {
    const inView: Array<{ id: string; name: string; distance: number }> = [];
    projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreen);
    const worldPos = new THREE.Vector3();
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
        scene: store.doc.name,
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
        net: netPresence?.debug() ?? null,
        debug: {
          sceneSource: seeded ? "code-fallback" : "file",
          sceneLoadError: sceneLoadError || undefined,
        },
        updatedAt: performance.now(),
      }),
    }).catch(() => undefined);
  }
  setInterval(postContext, 1000);
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
    } else {
      canvas.style.left = "0px";
      canvas.style.top = "0px";
      canvas.style.width = "100vw";
      canvas.style.height = "100vh";
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
    renderer.setSize(w, h, window.devicePixelRatio);
  }
  window.addEventListener("resize", onResize);
  editorVisible.subscribe(applyCanvasLayout);
  dockSizes.subscribe(applyCanvasLayout);
  applyCanvasLayout();

  let lastFrameMs = 0;
  const followPos = new THREE.Vector3();
  // render-side smoothing: bodies step at the fixed rate, frames don't — draw
  // them interpolated between the last two sim states (scripts still read the
  // exact stepped state inside fixedUpdate)
  const prevBodyPos = new Map<string, THREE.Vector3>();
  const currBodyPos = new Map<string, THREE.Vector3>();
  const lerpPos = new THREE.Vector3();
  const TELEPORT_SNAP_SQ = 25; // jumps larger than this are teleports, not motion
  const loop = new FixedTimestepLoop({
    fixedUpdate: (dt) => {
      if (playMode.get() !== "playing" || !sim) return;
      // sim/scripts mutate RUNTIME objects only — the document is authoring truth
      sim.step(dt);
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
      scripts?.fixedUpdate(dt);
    },
    update: (dt, alpha) => {
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
      // follow cam: keep the orbit center on the target; the pointer-lock
      // mouse look (play) or drag-orbit (paused) supplies the rotation
      if (playMode.get() !== "edit" && followTargetId) {
        const target = built.objects.get(followTargetId);
        if (target) {
          const p = target.getWorldPosition(followPos);
          void controls.moveTo(p.x, p.y + 1, p.z, true);
        }
      }
      if (playMode.get() === "playing") animations.update(dt);
      // chunk streaming follows the player in play mode, the fly-cam in edit
      {
        const focusObj =
          playMode.get() !== "edit" && followTargetId ? built.objects.get(followTargetId) : null;
        if (focusObj) {
          const p = focusObj.getWorldPosition(followPos);
          chunkManager.update(p.x, p.z);
        } else {
          chunkManager.update(camera.position.x, camera.position.z);
        }
      }
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
      particles.update(dt, renderCamera); // billboards face the camera actually used
      netPresence?.update(dt); // remote avatars lerp toward their snapshot targets
      renderer.render(built.scene, renderCamera);
      lastFrameMs = dt * 1000;
    },
  });

  setInterval(() => {
    const mode = playMode.get();
    const hint =
      mode === "playing"
        ? "~ pause + editor"
        : mode === "paused"
          ? "PAUSED — ~ resume · ⏹ stop in toolbar"
          : "~ editor";
    const chunkStats = chunkManager.stats;
    const netStats = netPresence?.stats();
    hud.textContent =
      `backend: ${backend}\n` +
      `entities: ${Object.keys(store.doc.entities).length} (source)\n` +
      (chunkStats.chunks > 0
        ? `chunks: ${chunkStats.chunks} (${chunkStats.entities} streamed)\n`
        : "") +
      (netStats && netStats.role !== "off"
        ? `net: ${netStats.role} · ${netStats.players} players\n`
        : "") +
      `frame: ${lastFrameMs.toFixed(1)}ms\n` +
      `mode: ${mode}  ·  ${hint}`;
  }, 500);

  function frame(t: number): void {
    loop.tick(t);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

void main();
