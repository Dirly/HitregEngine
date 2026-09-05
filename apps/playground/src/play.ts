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
  Profiler,
  getVoxelWorld,
  type SceneDoc,
  type GameManifest,
  type ChunkStreamerData,
  type SpritesheetDoc,
} from "@hitreg/core";
import { EngineRenderer, buildScene, type PostFxData, makeMeshGeometryProvider, AnimationSystem, ParticleSystem, BillboardSystem, LightBudgetSystem, FoliageLodSystem, ClusterLodSystem, GrassSystem, type BuildOptions } from "@hitreg/render";
import { createVfx, makeVfxHost, warmVfx } from "./vfx-host.js";
import { ScriptRegistry, registerBuiltinScripts, ScriptRuntime, InputService, EventBus } from "@hitreg/scripting";
import { PhysicsSim, initPhysics } from "@hitreg/physics";
import { applyBodyState } from "./physics-sync.js";
import { initProjectScripts } from "./project-scripts.js";
import { ChunkManager } from "./chunk-manager.js";
import { bakeImpostorAtlas } from "./impostor-bake.js";
import { voxelGroundProbes } from "./voxel-ground.js";
import {
  loadWorldRecipes,
  resolveVoxelWorld,
  voxelChunkProvider,
  voxelMeshViaWorker,
  voxelSupercellViaWorker,
} from "./voxel-world.js";

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
      // a bad data asset is skipped with a warning, never a blank game (see asset-loader.ts)
      for (const { id, data } of loaded) {
        try {
          if (type) assets.addDataAsset({ id, type, name: id, data });
          else assets.addPrefab(id, data);
        } catch (error) {
          console.warn(`[assets] skipped ${kind}/${id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }),
  );
  // World recipes register into the voxel world registry rather than the asset
  // library, and they must be in place BEFORE the scene is resolved: a
  // `voxelWorld` component names its recipe by id, and resolveVoxelWorld
  // returns null (world silently empty) for an id nothing has registered.
  await loadWorldRecipes(index, readJson);

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
  // composed effects + spells (ctx.vfx); its slot lights join the scene at
  // attach so the light set never changes mid-game (see VfxSystem)
  const vfx = createVfx(assets);
  let vfxWarmed = false;
  // Point-light budget. 8 was far too few once levels carried real practicals
  // (see main.ts for the measurements): brightness saturates around 32 while
  // cost climbs steeply past 48. Shared across the main scene AND the chunk
  // streamer, so every source competes for the same slots.
  const lightBudget = new LightBudgetSystem(32);
  // distance LOD for renderMode:"instanced" props (scatter: trees, rocks,
  // shrubs) — shared with the chunk streamer, since a generated world's props
  // arrive almost entirely through streamed cells
  const foliageLod = new FoliageLodSystem();
  // cluster-DAG continuous LOD for `renderMode: "clustered"` hero meshes
  const clusterLod = new ClusterLodSystem();
  // ground cover (the `grass` component) — scattered against the terrain via
  // the probes below, so it needs a world field to stand on
  const grass = new GrassSystem();

  // 7. build the scene
  const expanded = expandScene(doc, assets, registry);
  const buildOptions: BuildOptions = {
    resolveModel: (id: string) => assets.getModel(id)?.url,
    resolveMaterial: (id: string) => assets.getDataAsset(id)?.data,
    resolveTexture: (id: string) => assets.getTexture(id)?.url,
    resolveMaxAnisotropy: () => renderer.getMaxAnisotropy(),
    onParticles: (entityId, group, data) => particles.register(entityId, group, data, (id: string) => assets.getTexture(id)?.url),
    onLight: (_entityId, light, importance) => lightBudget.register(light, importance),
    onBillboard: (entityId, group, data) =>
      billboards.register(entityId, group, data, {
        texture: (id: string) => assets.getTexture(id)?.url,
        sheet: (id: string) => {
          const doc = assets.getDataAsset(id);
          return doc?.type === "spritesheet" ? (doc.data as SpritesheetDoc) : undefined;
        },
      }),
    onGrass: (entityId, group, data) => grass.register(entityId, group, data, (id: string) => assets.getTexture(id)?.url),
    onInstancedBatch: (batch) => foliageLod.register(batch),
    onClusteredMesh: (_entityId, mesh) => clusterLod.register(mesh),
    bakeImpostor: (object, bounds) => bakeImpostorAtlas(renderer, object, bounds),
    onModelLoaded: (entityId, root, clips) => {
      const animator = expanded.entities[entityId]?.components["animator"];
      animations.register(entityId, root, clips, (animator as Parameters<AnimationSystem["register"]>[3]) ?? null);
    },
  };
  const built = buildScene(expanded, buildOptions);
  vfx.attach(built.scene);

  // post-build: bloom + camera aspects + fallback background
  // the whole component, one per scene (first wins): bloom, grading, AO,
  // pixelate and the rest — schema-validated upstream, so partials are fine
  const postfx = Object.values(expanded.entities).map((e) => e.components["postfx"]).find(Boolean) as PostFxData | undefined;
  renderer.setPostFx(postfx ?? null);
  for (const cam of built.cameras.values()) cam.aspect = canvas.clientWidth / canvas.clientHeight;
  // The `sky` component's dome is a fixed-radius BackSide sphere: it only
  // reads as an infinite background while the camera stays INSIDE it, so it
  // gets recentred on the rendering camera every frame. In a streamed world
  // the player walks past that radius within seconds.
  let skyDomeMesh: THREE.Object3D | null = null;
  built.scene.traverse((node) => {
    if (!skyDomeMesh && node.userData["skyDome"] === true) skyDomeMesh = node;
  });

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
    vfx: makeVfxHost(vfx),
    assets,
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

  // 8b. streamed chunk worlds -------------------------------------------------
  // The scene's terrain is runtime-only content: it never appears in the scene
  // document, it streams in and out around a focus point. Two sources, one
  // streamer: a `chunkStreamer` component reads authored cell FILES, a
  // `voxelWorld` component GENERATES cells from a recipe. Both produce the
  // same ChunkStreamerData and travel the same residency rings, HLOD
  // supercells and physics attach path.
  /** Runtime-tunable flags + handles for measurement; see the end of main(). */
  const probe: Record<string, unknown> & { precompile: boolean } = {
    precompile: new URLSearchParams(location.search).get("precompile") !== "0",
  };
  const chunkManager = new ChunkManager(assets, registry, {
    // HLOD supercells re-mesh their member cells on a coarser lattice; these
    // send that marching-cubes run to the voxel worker pool instead of the
    // frame. Both return null when no pool could start (no `Worker`), and the
    // builder meshes inline — slower, never broken.
    voxelMeshAsync: (source) => voxelMeshViaWorker(source),
    voxelSupercellAsync: (buckets) => voxelSupercellViaWorker(buckets),
    resolveModel: (id: string) => assets.getModel(id)?.url,
    resolveMaterial: (id: string) => assets.getDataAsset(id)?.data,
    resolveTexture: (id: string) => assets.getTexture(id)?.url,
    resolveMaxAnisotropy: () => renderer.getMaxAnisotropy(),
    onInstancedBatch: (batch) => foliageLod.register(batch),
    onLight: (_entityId, light, importance) => lightBudget.register(light, importance),
    onClusteredMesh: (_entityId, mesh) => clusterLod.register(mesh),
    bakeImpostor: (object, bounds) => bakeImpostorAtlas(renderer, object, bounds),
  }, {
    onLoaded: (doc, objects, simulated) => {
      for (const [id, object] of objects) built.objects.set(id, object);
      // render-only LOD rings (fullRender/hlod/far) render but never simulate
      if (simulated) scripts.addEntities(doc, objects);
    },
    onUnloaded: (ids) => {
      for (const id of ids) built.objects.delete(id);
      scripts.removeEntities(ids);
    },
    onDisposeInstancedBatch: (batch) => foliageLod.unregister(batch),
    // a streamed cell compiles its shaders in the background, so turning to
    // face a cell that arrived earlier does not stall inside render()
    precompile: (group) => { if (probe.precompile) void renderer.precompileGroup(group, camera, built.scene); },
    // a cell can cross the simulation/fullRender boundary WITHOUT a mesh
    // rebuild: the objects already exist, only scripts (de)register. Physics
    // is ChunkManager's own job — setSim below owns that half.
    onSimulationGained: (doc, objects) => scripts.addEntities(doc, objects),
    onSimulationLost: (ids) => scripts.removeEntities(ids),
  });
  // A published game is always "playing", so the sim is attached once and
  // stays attached — there is no edit mode to detach for. Streamed terrain's
  // collider is cooked from the built objects, so this must be in place before
  // the first cell lands or the player spawns before the ground does.
  chunkManager.setSim(sim);

  let streamer: ChunkStreamerData | null = null;
  for (const entity of Object.values(expanded.entities)) {
    const cs = entity.components["chunkStreamer"] as ChunkStreamerData | undefined;
    if (cs) { streamer = cs; break; }
  }
  // A `voxelWorld` wins over `chunkStreamer` when a scene somehow has both:
  // a generated world has no cell files for the file path to find. `cellSize`
  // comes from the RECIPE, not the component — see streamerFor.
  const voxelWorld = resolveVoxelWorld(expanded);
  chunkManager.setProvider(voxelWorld ? voxelChunkProvider(voxelWorld, assets) : null);
  if (voxelWorld) streamer = voxelWorld.streamer;
  const voxelWorldId = voxelWorld?.data.world ?? null;
  await chunkManager.configure(streamer, built.scene);
  // ground probes for the `grass` component; null world -> no cover, no throw
  const ground = voxelGroundProbes(() => (voxelWorldId ? getVoxelWorld(voxelWorldId) : null));

  // camera rig config (data-driven from the active camera's rig)
  let followId: string | null = null;
  let rigMode: "follow" | "chase" | null = null;
  let rigDist = 8;
  let rigHeight = 1;
  /** Never end up inside the character's own head. */
  const PLAY_CAM_MIN = 1.6;
  const PLAY_CAM_MAX = 14;
  /** Probe sphere radius — the camera's near plane has width, a ray doesn't. */
  const CAM_PROBE_RADIUS = 0.3;
  /** Stop this far short of whatever the probe hit. */
  const CAM_SKIN = 0.25;
  for (const entity of Object.values(expanded.entities)) {
    const cam = entity.components["camera"] as { active?: boolean; fov?: number; near?: number; far?: number; rig?: { mode: string; targetTag: string; distance?: number; height?: number } } | undefined;
    if (cam?.active && (cam.rig?.mode === "follow" || cam.rig?.mode === "chase")) {
      followId = Object.entries(expanded.entities).find(([, e]) => e.tags.includes(cam.rig!.targetTag))?.[0] ?? null;
      rigMode = cam.rig.mode as "follow" | "chase";
      rigDist = cam.rig.distance ?? 8;
      rigHeight = cam.rig.height ?? 1;
      // A rigged camera is DRIVEN, so its own scene object is never what
      // renders — the rig moves this one instead. Its lens settings still
      // belong to the author though, and in a streamed world the far plane is
      // not a detail: a scene asking for 4000 rendered through the default 500
      // clips the outer LOD rings away and the world ends in mid-air.
      if (cam.fov !== undefined) camera.fov = cam.fov;
      if (cam.near !== undefined) camera.near = cam.near;
      if (cam.far !== undefined) camera.far = cam.far;
      camera.updateProjectionMatrix();
      // "follow" only steers the orbit TARGET, so the boom length is whatever
      // the camera happened to start at unless the rig's distance is applied.
      if (rigMode === "follow") {
        rigDist = Math.min(PLAY_CAM_MAX, Math.max(PLAY_CAM_MIN, rigDist));
        controls.minDistance = PLAY_CAM_MIN; // collision may squeeze in this far
        controls.maxDistance = PLAY_CAM_MAX;
        void controls.dollyTo(rigDist, false);
      }
      break;
    }
  }

  /**
   * Third-person camera collision, run against the PHYSICS colliders rather
   * than camera-controls' own dolly-collision.
   *
   * It has to be physics, not meshes: the mesh path can only see the scene
   * document's own entities, so streamed chunk content — all the voxel
   * terrain, every scattered tree — was never in `colliderMeshes` at all and
   * the camera swung straight through hillsides and trunks, which in a
   * generated world means most of the time the view is buried in dirt. One
   * spherecast also reuses the broadphase instead of brute-force raycasting
   * every triangle of every listed mesh each frame.
   *
   * A SPHERE, not a ray: the camera's near plane has width, so a ray grazing a
   * trunk still leaves the corner of the view inside it.
   */
  const camPivot = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  function updateFollowCamDistance(px: number, py: number, pz: number, dt: number): void {
    camPivot.set(px, py, pz);
    camDir.copy(camera.position).sub(camPivot);
    if (camDir.lengthSq() < 1e-6) return;
    camDir.normalize();
    let allowed = rigDist;
    if (followId) {
      // exclude the target: the sweep starts inside its own capsule, and a
      // shape stopped by itself reports distance 0 and jams the camera in the
      // character's head every frame
      const hit = sim.spherecast(
        CAM_PROBE_RADIUS,
        [px, py, pz],
        [px + camDir.x * rigDist, py + camDir.y * rigDist, pz + camDir.z * rigDist],
        { exclude: [followId] },
      );
      if (hit) allowed = Math.max(PLAY_CAM_MIN, hit.distance - CAM_SKIN);
    }
    // Snap IN immediately, ease OUT. A single frame with the camera inside a
    // wall shows the player through the world, so intrusion cannot be eased;
    // easing the recovery stops the camera flinging outward every time it
    // clears a tree trunk.
    const current = controls.distance;
    const next = allowed < current ? allowed : current + (allowed - current) * Math.min(1, dt * 6);
    void controls.dollyTo(next, false);
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
  const streamFocus = new THREE.Vector3();
  const camWorldPos = new THREE.Vector3();

  /**
   * Stats overlay for the PUBLISHED runtime.
   *
   * The editor has a HUD and a profiler; a published build deliberately has
   * neither, which makes "is the engine fast, or is the editor slow?"
   * unanswerable from the thing you actually ship. This is the same
   * `Profiler` the editor uses, so the numbers are directly comparable —
   * in particular the JS / off-loop / GPU split, which is the only way to
   * tell main-thread work from a blocked GPU queue or GC.
   *
   * F3 toggles it; it starts ON here because measuring is the point.
   */
  const profiler = new Profiler();
  profiler.enabled = true;
  const hud = document.createElement("div");
  hud.style.cssText =
    "position:fixed;top:8px;right:8px;z-index:9999;font:11px ui-monospace,Menlo,Consolas,monospace;" +
    "white-space:pre;text-align:right;color:#d29922;background:rgba(10,14,20,.72);padding:8px 10px;" +
    "border-radius:6px;pointer-events:none;line-height:1.45";
  document.body.appendChild(hud);
  window.addEventListener("keydown", (e) => {
    if (e.code === "F3") hud.style.display = hud.style.display === "none" ? "" : "none";
    if (e.code === "F4") renderer.setGpuTiming(!renderer.gpuTimingActive);
  });
  setInterval(() => {
    if (hud.style.display === "none") return;
    const s = profiler.summary();
    const info = renderer.renderer.info;
    const cs = chunkManager.stats;
    const draw = s.scopes.find((x) => x.name === "draw");
    const n = (v: number) => (Math.round(v * 10) / 10).toFixed(1);
    hud.textContent =
      `${n(s.fps)} fps   frame p50 ${n(s.frameMs.p50)} / p95 ${n(s.frameMs.p95)} / max ${n(s.frameMs.max)}
` +
      `js ${n(s.frameMs.avg)}   off-loop ${n(s.gapMs.avg)}${s.gpuMs ? `   gpu ${n(s.gpuMs.avg)}` : "   gpu — (F4)"}
` +
      `draw ${draw ? n(draw.avgSelfMs) : "—"}   calls ${info.render.drawCalls}   tris ${info.render.triangles.toLocaleString()}
` +
      `chunks ${cs.chunks} (${cs.simulated} sim / ${cs.proxied} proxy)   loading ${cs.loading}
` +
      `geometries ${info.memory.geometries}   F3 hide · F4 gpu timing`;
  }, 250);

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
      profiler.beginFrame();
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
          } else {
            void controls.moveTo(p.x, p.y + 1, p.z, true);
            updateFollowCamDistance(p.x, p.y + 1, p.z, dt);
          }
        }
      }
      // Chunk streaming follows the PLAYER, not the camera: the camera orbits
      // and its position sweeps a circle around what it looks at, so using it
      // would re-stream a world that had not changed every time the view
      // rotated. With no follow target the camera is the only focus there is.
      {
        const focusObj = followId ? built.objects.get(followId) : null;
        const p = focusObj
          ? focusObj.getWorldPosition(streamFocus)
          : streamFocus.copy(camera.position);
        chunkManager.update(p.x, p.z);
      }
      controls.update(dt);
      animations.update(dt);
      // Camera priority: a script-switched camera wins, then a RIGLESS active
      // scene camera, then the rig camera. The `rigless` half matters: a
      // camera entity with a follow/chase rig is DRIVEN by the rig above,
      // which moves `camera` — rendering that entity's own object instead
      // leaves the view frozen at the transform the scene file happens to
      // carry, and the player walks out of frame.
      const activeId = scripts.getActiveCameraId();
      const renderCam =
        (activeId && built.cameras.get(activeId)) || (!followId && built.activeCamera) || camera;
      particles.update(dt, renderCam);
      billboards.update(dt); // flipbook VFX frames
      if (!vfxWarmed) {
        // once: every effect pipeline compiles now instead of on the first cast
        vfxWarmed = true;
        if (probe.precompile) void warmVfx(vfx, assets, (group) => renderer.precompileGroup(group, renderCam, built.scene), renderCam);
      }
      vfx.update(dt, renderCam, built.scene);
      grass.update(renderCam, ground.sampleGround, ground.sampleCover);
      // the near->mid foliage LOD switch is judged in screen pixels, so the
      // system needs the projection actually in use (idempotent when unchanged)
      if ((renderCam as THREE.PerspectiveCamera).isPerspectiveCamera) {
        foliageLod.setProjection(canvas.clientHeight || window.innerHeight, (renderCam as THREE.PerspectiveCamera).fov);
      }
      foliageLod.update(renderCam.getWorldPosition(camWorldPos));
      clusterLod.update(renderCam, canvas.clientHeight || window.innerHeight);
      lightBudget.update(built.scene, renderCam);
      if (skyDomeMesh) (skyDomeMesh as THREE.Object3D).position.copy(renderCam.getWorldPosition(camWorldPos));
      profiler.begin("draw");
      vfx.applyShake(renderCam); // the rig owns the camera; the offset lives only inside the draw
      renderer.render(built.scene, renderCam);
      vfx.restoreShake(renderCam);
      profiler.end();
      const gpu = renderer.gpuFrameMs();
      if (gpu !== null) profiler.setGpuMs(gpu);
      profiler.endFrame();
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
  // Probe handle for headless measurement (see docs/perf-investigation-2026-09-02.md):
  // the published build has no editor, so this is the only way a script can
  // read draw calls, chunk state and the pipeline caches behind a stall.
  Object.assign(probe, { renderer, chunkManager, profiler, controls, camera, built, sim, lightBudget, foliageLod, grass });
  (window as unknown as { __hitreg: unknown }).__hitreg = probe;
}

main().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML("beforeend", `<pre style="position:fixed;inset:0;padding:20px;color:#f88;background:#111;font:13px monospace;white-space:pre-wrap;z-index:9999">Failed to start:\n${(e as Error).message}\n${(e as Error).stack ?? ""}</pre>`);
});
