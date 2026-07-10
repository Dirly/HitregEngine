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
import {
  AnimationSystem,
  attachPhysicsDebug,
  buildScene,
  EngineRenderer,
  type AnimatorData,
  type BuiltScene,
} from "@hitreg/render";
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
  const assets = new AssetLibrary();
  registerCoreAssetTypes(assets);

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
  const animations = new AnimationSystem();

  // debug viz is an EDIT-mode tool — the game view stays clean during play
  function refreshPhysicsDebugVisibility(): void {
    if (!built) return;
    const visible = playMode.get() === "edit" && settings.get().showPhysics;
    built.scene.traverse((node) => {
      if (node.userData["physicsDebug"]) node.visible = visible;
    });
  }
  function rebuild(): void {
    // v1: full rebuild per change — fine at this scale; diffing comes with ECS
    const expanded = expandScene(store.doc, assets, registry);
    lastExpanded = expanded;
    animations.clear();
    built = buildScene(expanded, {
      resolveModel: (assetId) => assets.getModel(assetId)?.url,
      resolveMaterial: (assetId) => assets.getDataAsset(assetId)?.data,
      resolveTexture: (assetId) => assets.getTexture(assetId)?.url,
      onModelLoaded: (entityId, root, clips) => {
        const animator = lastExpanded.entities[entityId]?.components["animator"] as
          | AnimatorData
          | undefined;
        animations.register(entityId, root, clips, animator ?? null);
      },
    });
    if (settings.get().showPhysics) attachPhysicsDebug(expanded, built.objects);
    refreshPhysicsDebugVisibility();
    built.scene.background = new THREE.Color(0x0b0e14);
    for (const sceneCam of built.cameras.values()) {
      sceneCam.aspect = (canvas.clientWidth || 1) / (canvas.clientHeight || 1);
      sceneCam.updateProjectionMatrix();
    }
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
    dockSizes,
    assetsVersion,
    saveAsset,
    onFocusEntity: frameEntity,
    scenes: sceneList,
    onSwitchScene: (name) => void switchScene(name),
    onNewScene: newScene,
  });

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

  // Unity-style flow: play = fullscreen game; ~ pauses and opens the editor;
  // ~ again resumes fullscreen; stop (toolbar) returns to editing.
  playMode.subscribe(() => {
    if (playMode.get() === "playing") editorVisible.set(false);
  });

  window.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.code === "Backquote") {
      if (playMode.get() === "playing") {
        playMode.set("paused");
        editorVisible.set(true);
      } else if (playMode.get() === "paused" && editorVisible.get()) {
        playMode.set("playing"); // auto-hides the editor via the subscription above
      } else {
        editorVisible.set(!editorVisible.get());
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

  let sim: PhysicsSim | null = null;
  let scripts: ScriptRuntime | null = null;
  let followTargetId: string | null = null;
  function startPlaySession(): void {
    sim?.free();
    scripts?.dispose();
    audio.stopAll();
    audio.resume();
    sim = new PhysicsSim(lastExpanded);
    scripts = new ScriptRuntime({
      doc: lastExpanded,
      objects: built.objects,
      sim,
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
  playMode.subscribe(() => {
    const mode = playMode.get();
    if (mode === "edit") {
      endPlaySession();
      rebuild();
    } else if (mode === "playing" && !sim) {
      startPlaySession();
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
  const loop = new FixedTimestepLoop({
    fixedUpdate: (dt) => {
      if (playMode.get() !== "playing" || !sim) return;
      // sim/scripts mutate RUNTIME objects only — the document is authoring truth
      sim.step(dt);
      for (const [id, state] of sim.states()) {
        const object = built.objects.get(id);
        if (object) applyBodyState(object, state);
      }
      scripts?.fixedUpdate(dt);
    },
    update: (dt) => {
      // follow cam: keep the orbit center on the target; mouse still orbits/zooms
      if (playMode.get() !== "edit" && followTargetId) {
        const target = built.objects.get(followTargetId);
        if (target) {
          const p = target.getWorldPosition(followPos);
          void controls.moveTo(p.x, p.y + 1, p.z, true);
        }
      }
      if (playMode.get() === "playing") animations.update(dt);
      controls.update(dt);
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
    hud.textContent =
      `backend: ${backend}\n` +
      `entities: ${Object.keys(store.doc.entities).length} (source)\n` +
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
