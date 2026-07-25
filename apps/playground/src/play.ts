/**
 * play.ts — the EDITOR-FREE runtime entry for a PUBLISHED game.
 *
 * Boots a scene from a STATIC bundle (manifest.json + assets-index.json +
 * assets/ + the scene) and runs it: buildScene + physics + scripts + fixed
 * loop + a follow/chase camera rig. No editor overlay, no dev bridge, no
 * live-sync. Single-player (v1) — multiplayer is additive (re-add NetPresence).
 *
 * Bundle layout it expects (produced by tools/export-game.mjs), all relative to
 * this file's page:
 *   manifest.json                      (GameManifest — entry scene, etc.)
 *   assets-index.json                  ({ models:[], materials:[], prefabs:[], scenes:[], ... })
 *   assets/<kind>/<file>               (the copied content)
 */
import * as THREE from "three/webgpu";
import CameraControls from "camera-controls";
import {
  ComponentRegistry,
  registerCoreComponents,
  registerChunkComponents,
  EventRegistry,
  registerCoreEvents,
  AssetLibrary,
  registerCoreAssetTypes,
  expandScene,
  sceneDocSchema,
  FixedTimestepLoop,
  parseManifest,
  NetStateStore,
  type SceneDoc,
  type GameManifest,
} from "@hitreg/core";
import { EngineRenderer, buildScene, makeMeshGeometryProvider, AnimationSystem, ParticleSystem, BillboardSystem, LightBudgetSystem, type BuildOptions } from "@hitreg/render";
import { ScriptRegistry, registerBuiltinScripts, ScriptRuntime, InputService, EventBus } from "@hitreg/scripting";
import { PhysicsSim, initPhysics } from "@hitreg/physics";
import { applyBodyState } from "./physics-sync.js";
import { initProjectScripts } from "./project-scripts.js";

CameraControls.install({ THREE: THREE as unknown as Parameters<typeof CameraControls.install>[0]["THREE"] });

// bundle lives beside the page by default; ?base=/path/ points elsewhere (dev testing)
const BASE = new URL(new URLSearchParams(location.search).get("base") ?? ".", location.href).href;
const url = (p: string) => new URL(p, BASE).href;

async function loadBundleAssets(assets: AssetLibrary, entryScene: string): Promise<SceneDoc> {
  const index = (await fetch(url("assets-index.json")).then((r) => r.json())) as Record<string, string[]>;
  const fileUrl = (kind: string, file: string) => url(`content/${kind}/${file}`);
  const readJson = (kind: string, file: string) => fetch(fileUrl(kind, file)).then((r) => r.json());

  const jsonKinds: { kind: string; type?: string }[] = [
    { kind: "prefabs" },
    { kind: "materials", type: "material" },
    { kind: "terrain", type: "terrain-heightfield" },
    { kind: "spritesheets", type: "spritesheet" },
  ];
  await Promise.all(
    jsonKinds.map(async ({ kind, type }) => {
      const files = (index[kind] ?? []).filter((f) => f.endsWith(".json"));
      const loaded = await Promise.all(files.map(async (file) => ({ id: file.replace(/\.json$/, ""), data: await readJson(kind, file) })));
      for (const { id, data } of loaded) type ? assets.addDataAsset({ id, type, name: id, data }) : assets.addPrefab(id, data);
    }),
  );
  for (const file of index["models"] ?? []) if (/\.(glb|gltf)$/.test(file)) assets.addModel({ id: file, name: file.split("/").pop()!, url: fileUrl("models", file) });
  for (const file of index["textures"] ?? []) if (/\.(png|jpe?g|webp)$/i.test(file)) assets.addTexture({ id: file, name: file.split("/").pop()!, url: fileUrl("textures", file) });
  for (const file of index["audio"] ?? []) if (/\.(wav|mp3|ogg)$/i.test(file)) assets.addSound({ id: file, name: file.split("/").pop()!, url: fileUrl("audio", file) });

  const sceneText = await fetch(fileUrl("scenes", entryScene)).then((r) => r.text());
  const parsed = sceneDocSchema.safeParse(JSON.parse(sceneText));
  if (!parsed.success) throw new Error("entry scene invalid: " + JSON.stringify(parsed.error.issues.slice(0, 4)));
  return parsed.data;
}

async function main(): Promise<void> {
  // 0. manifest
  const manifestRaw = await fetch(url("manifest.json")).then((r) => r.json());
  const mres = parseManifest(manifestRaw);
  if (!mres.ok) throw new Error("manifest: " + mres.error);
  const manifest: GameManifest = mres.manifest;
  document.title = manifest.game.name;

  // 1. registries + libraries
  const registry = new ComponentRegistry();
  registerCoreComponents(registry);
  registerChunkComponents(registry);
  const events = new EventRegistry();
  registerCoreEvents(events);
  const assets = new AssetLibrary();
  registerCoreAssetTypes(assets);
  const meshGeometry = makeMeshGeometryProvider((assetId: string) => assets.getModel(assetId)?.url);

  // 2. assets + scene doc
  const doc = await loadBundleAssets(assets, manifest.entry.scene);

  // 3. canvas + renderer + physics
  const canvas = document.getElementById("game") as HTMLCanvasElement;
  const renderer = new EngineRenderer(canvas);
  await Promise.all([renderer.init(), initPhysics()]);

  // 4. camera + controls
  const camera = new THREE.PerspectiveCamera(60, canvas.clientWidth / canvas.clientHeight, 0.1, 500);
  camera.position.set(0, 6, 14);
  const controls = new CameraControls(camera, canvas);
  controls.maxPolarAngle = 1.45;
  controls.minDistance = 2;

  // 5. scripts
  const scriptRegistry = new ScriptRegistry();
  registerBuiltinScripts(scriptRegistry);
  initProjectScripts({ registry: scriptRegistry, events, onReload: undefined });
  const input = new InputService();

  // 6. render systems
  const animations = new AnimationSystem();
  const particles = new ParticleSystem();
  const billboards = new BillboardSystem();
  const lightBudget = new LightBudgetSystem(8);

  // 7. build the scene
  const expanded = expandScene(doc, assets, registry);
  const buildOptions: BuildOptions = {
    resolveModel: (id: string) => assets.getModel(id)?.url,
    resolveMaterial: (id: string) => assets.getDataAsset(id)?.data,
    resolveTexture: (id: string) => assets.getTexture(id)?.url,
    resolveMaxAnisotropy: () => renderer.getMaxAnisotropy(),
    onParticles: (entityId, group, data) => particles.register(entityId, group, data, (id: string) => assets.getTexture(id)?.url),
    onLight: (_entityId, light, importance) => lightBudget.register(light, importance),
    onBillboard: (entityId, group, data) => billboards.register(entityId, group, data, { texture: (id: string) => assets.getTexture(id)?.url }),
    bakeBillboardTexture: () => null,
    onModelLoaded: (entityId, root, clips) => {
      const animator = expanded.entities[entityId]?.components["animator"];
      animations.register(entityId, root, clips, (animator as Parameters<AnimationSystem["register"]>[3]) ?? null);
    },
  };
  const built = buildScene(expanded, buildOptions);

  // post-build: bloom + camera aspects + fallback background
  const postfx = Object.values(expanded.entities).map((e) => e.components["postfx"]).find(Boolean) as { bloom?: unknown } | undefined;
  if (postfx?.bloom) renderer.setBloom(postfx.bloom as Parameters<EngineRenderer["setBloom"]>[0]);
  for (const cam of built.cameras.values()) cam.aspect = canvas.clientWidth / canvas.clientHeight;

  // 8. play session — physics + event bus + script runtime
  const sim = new PhysicsSim(expanded, undefined, { meshGeometry });
  const eventBus = new EventBus(events);
  eventBus.setNetRole("local");
  // single-player: a local netState store IS the authority (default). Scripts
  // built on netState (like the mall manager) need this to run at all.
  const netState = new NetStateStore();
  const viewForward = (): [number, number] => {
    const d = camera.getWorldDirection(new THREE.Vector3());
    d.y = 0;
    d.normalize();
    return [d.x, d.z];
  };
  const scripts = new ScriptRuntime({
    doc: expanded,
    objects: built.objects,
    sim,
    events: eventBus,
    registry: scriptRegistry,
    input,
    viewForward,
    netState,
    setAnimation: (id, clip, fade, opts) => animations.play(id, clip, fade ?? 0.3, opts?.loop ?? true),
    setBillboard: (id, opts) => billboards.setValue(id, opts),
    setParticles: (id, opts) => particles.setValue(id, opts),
    setLight: (id, opts) => {
      const obj = built.objects.get(id);
      obj?.traverse((o) => {
        if ((o as THREE.Light).isLight) {
          const l = o as THREE.Light;
          if (opts.enabled !== undefined) l.visible = opts.enabled;
          if (opts.intensity !== undefined) l.intensity = opts.intensity;
          if (opts.color) l.color.set(opts.color);
        }
      });
    },
    playSound: () => {}, // v1: audio components/SFX via scripts' own WebAudio; AudioSystem is a later add
  });
  scripts.start();
  animations.setRunning(true);

  // camera rig config (data-driven from the active camera's rig)
  let followId: string | null = null;
  let rigMode: "follow" | "chase" | null = null;
  let rigDist = 8;
  let rigHeight = 1;
  for (const entity of Object.values(expanded.entities)) {
    const cam = entity.components["camera"] as { active?: boolean; rig?: { mode: string; targetTag: string; distance?: number; height?: number } } | undefined;
    if (cam?.active && (cam.rig?.mode === "follow" || cam.rig?.mode === "chase")) {
      followId = Object.entries(expanded.entities).find(([, e]) => e.tags.includes(cam.rig!.targetTag))?.[0] ?? null;
      rigMode = cam.rig.mode as "follow" | "chase";
      rigDist = cam.rig.distance ?? 8;
      rigHeight = cam.rig.height ?? 1;
      break;
    }
  }

  // pointer-lock mouse look
  const LOOK = 0.0025;
  document.addEventListener("pointerlockchange", () => { controls.enabled = document.pointerLockElement !== canvas; });
  document.addEventListener("mousemove", (e) => {
    if (document.pointerLockElement !== canvas) return;
    if (rigMode === "chase") { input.addMouseDelta(e.movementX, e.movementY); return; }
    void controls.rotate(-e.movementX * LOOK, -e.movementY * LOOK, false);
  });
  canvas.addEventListener("mousedown", () => { if (document.pointerLockElement !== canvas) void canvas.requestPointerLock()?.catch(() => undefined); });

  // 9. the loop
  const prev = new Map<string, THREE.Vector3>();
  const curr = new Map<string, THREE.Vector3>();
  const lerp = new THREE.Vector3();
  const followPos = new THREE.Vector3();
  const chaseFwd = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const yawQ = new THREE.Quaternion();
  const eye = new THREE.Vector3();
  const off = new THREE.Vector3();

  const loop = new FixedTimestepLoop({
    fixedUpdate: (dt) => {
      sim.step(dt);
      for (const [id, state] of sim.states()) {
        const obj = built.objects.get(id);
        if (obj) applyBodyState(obj, state);
        let p = curr.get(id);
        if (!p) { p = new THREE.Vector3(); curr.set(id, p); prev.set(id, new THREE.Vector3().fromArray(state.position)); }
        prev.get(id)!.copy(p);
        p.fromArray(state.position);
      }
      scripts.fixedUpdate(dt);
    },
    update: (dt, alpha) => {
      for (const [id, c] of curr) {
        const obj = built.objects.get(id);
        const p = prev.get(id);
        if (obj && p) { lerp.copy(p).lerp(c, alpha); obj.position.copy(lerp); }
      }
      if (followId) {
        const target = built.objects.get(followId);
        if (target) {
          const p = target.getWorldPosition(followPos);
          if (rigMode === "chase") {
            chaseFwd.set(0, 0, -1).applyQuaternion(target.quaternion);
            yawQ.setFromAxisAngle(up, Math.atan2(-chaseFwd.x, -chaseFwd.z));
            off.set(0, rigHeight, rigDist).applyQuaternion(yawQ);
            eye.copy(p).add(off);
            void controls.setLookAt(eye.x, eye.y, eye.z, p.x, p.y + 1, p.z, false);
          } else void controls.moveTo(p.x, p.y + 1, p.z, true);
        }
      }
      controls.update(dt);
      animations.update(dt);
      const activeId = scripts.getActiveCameraId();
      const renderCam = (activeId && built.cameras.get(activeId)) || built.activeCamera || camera;
      particles.update(dt, renderCam);
      lightBudget.update(built.scene, renderCam);
      renderer.render(built.scene, renderCam);
    },
  });

  const frame = (now: number): void => { loop.tick(now); requestAnimationFrame(frame); };
  requestAnimationFrame(frame);

  const resize = (): void => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    camera.aspect = w / h; camera.updateProjectionMatrix();
    for (const c of built.cameras.values()) { c.aspect = w / h; c.updateProjectionMatrix(); }
    renderer.setSize(w, h);
  };
  window.addEventListener("resize", resize);
  resize();
}

main().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML("beforeend", `<pre style="position:fixed;inset:0;padding:20px;color:#f88;background:#111;font:13px monospace;white-space:pre-wrap;z-index:9999">Failed to start:\n${(e as Error).message}\n${(e as Error).stack ?? ""}</pre>`);
});
