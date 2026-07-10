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
import { attachPhysicsDebug, buildScene, EngineRenderer, type BuiltScene } from "@hitreg/render";
import { initPhysics, PhysicsSim, type BodyState } from "@hitreg/physics";
import {
  createAssetSelection,
  createContextMenu,
  createSelection,
  defaultEditorSettings,
  DOCK,
  GrayboxTool,
  mountEditor,
  observable,
  ViewportTools,
  type GizmoMode,
  type GrayboxShape,
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
    const expanded = expandScene(store.doc, assets, registry);
    built = buildScene(expanded, {
      resolveModel: (assetId) => assets.getModel(assetId)?.url,
      resolveMaterial: (assetId) => assets.getDataAsset(assetId)?.data,
    });
    if (settings.get().showPhysics) attachPhysicsDebug(expanded, built.objects);
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
  const grayboxActive = observable(false);
  const grayboxShape = observable<GrayboxShape>("box");
  const grayboxBevel = observable(0);
  const thumbnails = observable<Record<string, string>>({});
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
    getScene: () => built.scene,
    getObject: (id) => built.objects.get(id),
    onDraggingChanged: (dragging) => {
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
    assetsVersion,
    saveAsset,
  });

  window.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.code === "Backquote") {
      editorVisible.set(!editorVisible.get());
    }
    // Unity F: frame the selection
    if (e.code === "KeyF" && editorVisible.get()) {
      const id = selection.get();
      const object = id ? built.objects.get(id) : undefined;
      if (object) {
        void controls.fitToBox(new THREE.Box3().setFromObject(object), true, {
          paddingLeft: 1,
          paddingRight: 1,
          paddingTop: 1,
          paddingBottom: 1,
        });
      }
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

  // -- prefab thumbnails: render each prefab to a tiny offscreen target -------

  const THUMB = 96;
  async function renderThumbnails(): Promise<void> {
    const out: Record<string, string> = { ...thumbnails.get() };
    let changed = false;
    for (const pid of assets.prefabIds()) {
      try {
        const key = `${pid}:${JSON.stringify(assets.getPrefab(pid)).length}`;
        if (out[`__key_${pid}`] === key) continue;
        const { doc: thumbDoc } = (() => {
          const d = buildStreetDocEmpty(pid);
          return { doc: d };
        })();
        const expanded = expandScene(thumbDoc, assets, registry);
        const thumb = buildScene(expanded, {
          resolveMaterial: (id) => assets.getDataAsset(id)?.data,
        });
        thumb.scene.background = new THREE.Color(0x0b0e14);
        thumb.scene.add(new THREE.AmbientLight(0xffffff, 1.2));
        const sun = new THREE.DirectionalLight(0xfff5e0, 2);
        sun.position.set(3, 5, 4);
        thumb.scene.add(sun);

        const box = new THREE.Box3().setFromObject(thumb.scene);
        const size = box.getSize(new THREE.Vector3()).length() || 1;
        const center = box.getCenter(new THREE.Vector3());
        const cam = new THREE.PerspectiveCamera(45, 1, 0.01, size * 10);
        cam.position.copy(center).add(new THREE.Vector3(size * 0.7, size * 0.55, size * 0.7));
        cam.lookAt(center);

        const target = new THREE.RenderTarget(THUMB, THUMB);
        renderer.renderer.setRenderTarget(target);
        renderer.renderer.render(thumb.scene, cam);
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
        // flip Y: render targets are bottom-up
        for (let y = 0; y < THUMB; y++) {
          const src = (THUMB - 1 - y) * THUMB * 4;
          image.data.set(pixels.subarray(src, src + THUMB * 4), y * THUMB * 4);
        }
        ctx.putImageData(image, 0, 0);
        out[pid] = canvas2d.toDataURL();
        out[`__key_${pid}`] = key;
        changed = true;
      } catch (error) {
        console.warn(`[thumbnails] failed for ${pid}:`, error);
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

  // docked editor layout: the canvas shrinks to the center hole (Unity-style),
  // fullscreen when the editor is closed
  function applyCanvasLayout(): void {
    canvas.style.position = "fixed";
    if (editorVisible.get()) {
      canvas.style.left = `${DOCK.left}px`;
      canvas.style.top = `${DOCK.top}px`;
      canvas.style.width = `calc(100vw - ${DOCK.left + DOCK.right}px)`;
      canvas.style.height = `calc(100vh - ${DOCK.top + DOCK.bottom}px)`;
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
    renderer.setSize(w, h, window.devicePixelRatio);
  }
  window.addEventListener("resize", onResize);
  editorVisible.subscribe(applyCanvasLayout);
  applyCanvasLayout();

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
