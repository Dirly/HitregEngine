import CameraControls from "camera-controls";
import * as THREE from "three/webgpu";
import {
  AssetLibrary,
  ComponentRegistry,
  expandScene,
  FixedTimestepLoop,
  registerCoreAssetTypes,
  registerCoreComponents,
  sceneDocSchema,
  SceneStore,
  validateScene,
  type SceneDoc,
} from "@hitreg/core";
import { buildScene, EngineRenderer, type BuiltScene } from "@hitreg/render";
import { initPhysics, PhysicsSim, type BodyState } from "@hitreg/physics";
import {
  createAssetSelection,
  createContextMenu,
  createSelection,
  defaultEditorSettings,
  mountEditor,
  observable,
  ViewportTools,
  type GizmoMode,
  type PlayMode,
} from "@hitreg/editor";
import { buildStreetDoc } from "./street-scene.js";

CameraControls.install({ THREE });

/** assets/ is the project content folder: prefabs and models load from disk. */
function loadAssets(assets: AssetLibrary): void {
  const prefabs = import.meta.glob("../assets/prefabs/*.json", { eager: true });
  for (const [path, mod] of Object.entries(prefabs)) {
    const id = path.split("/").pop()!.replace(/\.json$/, "");
    assets.addPrefab(id, (mod as { default: unknown }).default);
  }
  const models = import.meta.glob("../assets/models/*.{glb,gltf}", {
    eager: true,
    query: "?url",
    import: "default",
  });
  for (const [path, url] of Object.entries(models)) {
    const name = path.split("/").pop()!;
    assets.addModel({ id: name, name, url: url as string });
  }
  const materials = import.meta.glob("../assets/materials/*.json", { eager: true });
  for (const [path, mod] of Object.entries(materials)) {
    const id = path.split("/").pop()!.replace(/\.json$/, "");
    assets.addDataAsset({
      id,
      type: "material",
      name: id,
      data: (mod as { default: unknown }).default,
    });
  }
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
  const assets = new AssetLibrary();
  registerCoreAssetTypes(assets);
  loadAssets(assets);

  // -- scene: files are the source of truth ----------------------------------
  // assets/scenes/*.scene.json is loaded if present; otherwise the code-built
  // street seeds the first scene file. Editor edits autosave back to the file.

  const sceneFiles = import.meta.glob("../assets/scenes/*.scene.json", { eager: true });
  let initialDoc: SceneDoc | null = null;
  let sceneLoadError = "";
  for (const [file, mod] of Object.entries(sceneFiles)) {
    const parsed = sceneDocSchema.safeParse((mod as { default: unknown }).default);
    if (parsed.success) {
      initialDoc = parsed.data;
      break;
    }
    sceneLoadError = `${file}: ${parsed.error.message.slice(0, 200)}`;
    console.warn("[scene] failed to load", file, parsed.error);
  }
  const seeded = initialDoc === null;
  const store = new SceneStore(initialDoc ?? buildStreetDoc(registry), registry);

  let lastWrittenScene = "";
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

  // -- render side -----------------------------------------------------------

  let built: BuiltScene;
  function rebuild(): void {
    // v1: full rebuild per change — fine at this scale; diffing comes with ECS
    built = buildScene(expandScene(store.doc, assets, registry), {
      resolveModel: (assetId) => assets.getModel(assetId)?.url,
      resolveMaterial: (assetId) => assets.getDataAsset(assetId)?.data,
    });
    built.scene.background = new THREE.Color(0x0b0e14);
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

  // -- editor ----------------------------------------------------------------

  const selection = createSelection();
  const editorVisible = observable(false);
  const settings = observable(defaultEditorSettings);
  const gizmoMode = observable<GizmoMode>("translate");
  const playMode = observable<PlayMode>("edit");
  const contextMenu = createContextMenu();
  const assetSelection = createAssetSelection();
  const assetsVersion = observable(0);
  assetsVersion.subscribe(() => rebuild()); // material/prefab edits re-render the scene

  const viewport: ViewportTools = new ViewportTools({
    canvas,
    camera,
    store,
    selection,
    enabled: editorVisible,
    settings,
    gizmoMode,
    contextMenu,
    getScene: () => built.scene,
    getObject: (id) => built.objects.get(id),
    onDraggingChanged: (dragging) => {
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
    assetsVersion,
    saveAsset,
  });

  window.addEventListener("keydown", (e) => {
    if (e.code === "Backquote" && !(e.target instanceof HTMLInputElement)) {
      editorVisible.set(!editorVisible.get());
    }
  });

  // -- physics: play mode builds a Rapier world from the expanded doc ---------

  let sim: PhysicsSim | null = null;
  function rebuildSim(): void {
    sim?.free();
    sim = new PhysicsSim(expandScene(store.doc, assets, registry));
  }

  store.subscribe(rebuild);
  store.subscribe(() => {
    if (sim) rebuildSim(); // edits during play restart the sim from the new doc
  });
  // stop restores the scene from the document — sim state is runtime-only
  playMode.subscribe(() => {
    const mode = playMode.get();
    if (mode === "edit") {
      sim?.free();
      sim = null;
      rebuild();
    } else if (mode === "playing" && !sim) {
      rebuildSim();
    }
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

  // -- live sync: file changes (AI edits, text editors) apply in place --------

  if (import.meta.hot) {
    import.meta.hot.on(
      "hitreg:asset-changed",
      (payload: { file: string; content: string | null }) => {
        const { file, content } = payload;
        if (!content) return;
        try {
          if (file.startsWith("scenes/")) {
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
            const id = file.split("/").pop()!.replace(/\.json$/, "");
            const data = JSON.parse(content);
            const asset = { id, type: "material", name: id, data };
            if (assets.getDataAsset(id)) assets.updateDataAsset(asset);
            else assets.addDataAsset(asset);
            assetsVersion.set(assetsVersion.get() + 1);
          } else if (file.startsWith("prefabs/")) {
            const id = file.split("/").pop()!.replace(/\.json$/, "");
            const doc = JSON.parse(content);
            if (assets.getPrefab(id)) assets.updatePrefab(id, doc);
            else assets.addPrefab(id, doc);
            assetsVersion.set(assetsVersion.get() + 1);
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
        debug: {
          sceneSource: seeded ? "code-fallback" : "file",
          sceneFilesFound: Object.keys(sceneFiles).length,
          sceneLoadError: sceneLoadError || undefined,
        },
        updatedAt: performance.now(),
      }),
    }).catch(() => undefined);
  }
  setInterval(postContext, 1000);
  clientLog(`boot: ready (backend=${backend}, sceneSource=${seeded ? "code" : "file"})`);

  // -- loop --------------------------------------------------------------------

  function onResize(): void {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight, window.devicePixelRatio);
  }
  window.addEventListener("resize", onResize);
  onResize();

  let lastFrameMs = 0;
  const loop = new FixedTimestepLoop({
    fixedUpdate: (dt) => {
      if (playMode.get() !== "playing" || !sim) return;
      // sim mutates RUNTIME objects only — the document is authoring truth
      sim.step(dt);
      for (const [id, state] of sim.states()) {
        const object = built.objects.get(id);
        if (object) applyBodyState(object, state);
      }
    },
    update: (dt) => {
      controls.update(dt);
      renderer.render(built.scene, camera);
      lastFrameMs = dt * 1000;
    },
  });

  setInterval(() => {
    hud.textContent =
      `backend: ${backend}\n` +
      `entities: ${Object.keys(store.doc.entities).length} (source)\n` +
      `frame: ${lastFrameMs.toFixed(1)}ms\n` +
      `mode: ${playMode.get()}  ·  press ~ for editor`;
  }, 500);

  function frame(t: number): void {
    loop.tick(t);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

void main();
