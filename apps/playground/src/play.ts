/**
 * play.ts — the EDITOR-FREE runtime entry for a PUBLISHED game.
 *
 * Boots a scene from a STATIC bundle (manifest.json + assets-index.json +
 * assets/ + the scene) and runs it: buildScene + physics + scripts + fixed
 * loop + a follow/chase camera rig. No editor overlay, no dev bridge, no
 * live-sync.
 *
 * Multiplayer: a project whose project.json says `multiplayer: "server"` joins
 * its dedicated server — sign in at the gateway, pick or create a character,
 * play on the layer main chose, with chat, voice, friends and party — through
 * the SAME session code the editor host uses (net-session.ts, net-client.ts).
 * Where the server is: net-session.ts `resolveNetEndpoint`. Every other
 * project plays alone, as before.
 *
 * Bundle layout it expects (produced by tools/export-game.mjs), all relative to
 * this file's page:
 *   manifest.json                      (GameManifest — entry scene, etc.)
 *   assets-index.json                  ({ models:[], materials:[], prefabs:[], scenes:[], ... })
 *   assets/<kind>/<file>               (the copied content)
 */
import { AudioSystem, type AudioComponentData } from "./audio-system.js";
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
  cameraSchema,
  sceneDocSchema,
  FixedTimestepLoop,
  parseManifest,
  NetStateStore,
  registerCharacterNetState,
  registerTransferLockNetState,
  Profiler,
  getVoxelWorld,
  findCreation,
  regionAt,
  type SceneDoc,
  type GameManifest,
  type ChunkStreamerData,
  type SpritesheetDoc,
} from "@hitreg/core";
import { MovingInstanceSystem, EngineRenderer, buildScene, gltfLoadingCount, type PostFxData, makeMeshGeometryProvider, AnimationSystem, CROWD_POSE_LOD, ParticleSystem, BillboardSystem, LightBudgetSystem, FoliageLodSystem, ClusterLodSystem, GrassSystem, PortraitView, ThirdPersonCameraRig, fitRigToBody, type RigBodyCollider, type BuildOptions, type RigVec3 } from "@hitreg/render";
import { createAmbientVfx, createVfx, makeVfxHost, warmVfx } from "./vfx-host.js";

/** The `camera` component, straight off the schema. */
type CameraComponentData = ReturnType<typeof cameraSchema.parse>;
import { ScriptRegistry, registerBuiltinScripts, ScriptRuntime, InputService, EventBus } from "@hitreg/scripting";
import { createModelLooks } from "./model-looks.js";
import { createFaceShotHost } from "./face-shot-host.js";
import { mountLoadScreen } from "./load-screen.js";
import { Layers, PhysicsSim, initPhysics } from "@hitreg/physics";
import { applyBodyState } from "./physics-sync.js";
import { initProjectScripts } from "./project-scripts.js";
import { startDevConsole } from "./dev-console.js";
import { createWorldMapOverlay } from "./world-map.js";
import { ChunkManager } from "./chunk-manager.js";
import { bakeImpostorAtlas } from "./impostor-bake.js";
import { syncWorldCover, voxelGroundProbes } from "./voxel-ground.js";
import {
  applyWorldRecipeEdit,
  loadVolumes,
  loadWorldRecipes,
  resolveVoxelWorld,
  voxelChunkProvider,
  voxelMeshViaWorker,
  voxelSupercellViaWorker,
} from "./voxel-world.js";
import { registerCommsEvents, type Comms } from "@hitreg/comms";
import { NetPresence } from "./net-presence.js";
import {
  NetRuntimeWorld,
  planSuspension,
  resolveNetEndpoint,
  savePendingGrant,
  stripServerPlayers,
  takePendingGrant,
} from "./net-session.js";
import {
  createSessionComms,
  mountConnectionOverlay,
  mountGatewayFlow,
  peerPresenceHooks,
  registerSessionNetState,
  type GatewayFlow,
} from "./net-client.js";
import type { GatewayCharacter, PlayGrant } from "./gateway.js";
import { createCreationPreview } from "./creation-preview.js";
import { loadingArtOf, mountPortalCurtain, type PortalCurtain } from "./portal-curtain.js";

CameraControls.install({ THREE: THREE as unknown as Parameters<typeof CameraControls.install>[0]["THREE"] });

// bundle lives beside the page by default; ?base=/path/ points elsewhere (dev testing)
const BASE = new URL(new URLSearchParams(location.search).get("base") ?? ".", location.href).href;
const url = (p: string) => new URL(p, BASE).href;

/**
 * `preferredScene`: a scene NAME to boot instead of the entry, when the bundle
 * carries it (`?scene=`, or the scene a server grant names); ignored otherwise.
 */
async function loadBundleAssets(assets: AssetLibrary, entryScene: string, preferredScene: string | null = null): Promise<SceneDoc> {
  const index = (await fetch(url("assets-index.json")).then((r) => r.json())) as Record<string, string[]>;
  if (preferredScene && (index["scenes"] ?? []).includes(`${preferredScene}.scene.json`)) entryScene = `${preferredScene}.scene.json`;
  const fileUrl = (kind: string, file: string) => url(`content/${kind}/${file}`);
  // At most 24 requests in flight: a project ships thousands of data files, and Chrome refuses
  // a few thousand simultaneous fetches outright (net::ERR_INSUFFICIENT_RESOURCES — the game
  // never started). Same files, same order of registration; only the concurrency is bounded.
  let inFlight = 0;
  const queued: Array<() => void> = [];
  const slot = (): Promise<void> => (inFlight < 24 ? (inFlight++, Promise.resolve()) : new Promise((r) => queued.push(r)));
  const release = (): void => {
    const next = queued.shift();
    if (next) next();
    else inFlight--;
  };
  const readJson = async (kind: string, file: string): Promise<unknown> => {
    await slot();
    try {
      return await fetch(fileUrl(kind, file)).then((r) => r.json());
    } finally {
      release();
    }
  };

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
  await loadVolumes(index, readJson);

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

  // 1b. multiplayer: does this bundle join a dedicated server, and where
  // (net-session.ts resolveNetEndpoint: ?gateway / ?server, then the manifest,
  // then this page's origin as the gateway — "server" projects only)
  const query = new URLSearchParams(location.search);
  const netEndpoint = resolveNetEndpoint({
    query,
    host: "published",
    mode: manifest.multiplayer.mode ?? "solo",
    manifest: manifest.multiplayer,
    origin: location.origin,
  });
  const networked = netEndpoint.kind !== "none";
  if (manifest.multiplayer.mode === "server" && !networked) console.warn(`[net] ${netEndpoint.reason}`);
  if (networked) console.log(`[net] ${netEndpoint.kind} ${netEndpoint.url} (from ${netEndpoint.source})`);
  const sessionStore = ((): Storage | null => {
    try {
      return sessionStorage;
    } catch {
      return null;
    }
  })();
  // a page reloaded onto the scene a grant named carries that grant across
  const resumed = netEndpoint.kind === "gateway" ? takePendingGrant<PlayGrant, GatewayCharacter>(sessionStore) : null;
  if (networked) registerCommsEvents(events); // "chat.message" — local-only, what THIS tab was allowed to see

  // Loading art (docs/hosting.md → "Loading art"): a scene this page boots on —
  // the reload a server transfer makes, or a direct ?scene= — shows its
  // loadingScreen until its near ground is in. Not over the gateway's sign-in
  // card (a fresh visit), which it would hide.
  let bootCurtain: PortalCurtain | null = null;
  if (netEndpoint.kind !== "gateway" || resumed) {
    const bootScene = resumed?.grant.scene ?? query.get("scene");
    const file = bootScene ? `${bootScene}.scene.json` : manifest.entry.scene;
    const text = await fetch(url(`content/scenes/${file}`)).then((r) => (r.ok ? r.text() : null)).catch(() => null);
    const art = loadingArtOf(text, (rel) => url(`content/${rel}`));
    if (art) {
      const title = art.title ?? file.replace(/.scene.json$/, "").replace(/-/g, " ").replace(/w/g, (c) => c.toUpperCase());
      bootCurtain = mountPortalCurtain();
      void bootCurtain.show(title);
      bootCurtain.setProgress(0.05);
      await bootCurtain.setArt({ url: art.url, title });
    }
  }

  // 2. assets + scene doc
  const doc = await loadBundleAssets(assets, manifest.entry.scene, resumed?.grant.scene ?? query.get("scene"));

  bootCurtain?.setProgress(0.4);
  // 3. canvas + renderer + physics
  const canvas = document.getElementById("game") as HTMLCanvasElement;
  const renderer = new EngineRenderer(canvas);
  await Promise.all([renderer.init(), initPhysics()]);

  // 4. camera + controls
  const camera = new THREE.PerspectiveCamera(60, canvas.clientWidth / canvas.clientHeight, 0.1, 500);
  const audio = new AudioSystem(camera, (soundId) => assets.getSound(soundId)?.url);
  camera.position.set(0, 6, 14);
  const controls = new CameraControls(camera, canvas);
  controls.maxPolarAngle = 1.45;
  controls.minDistance = 2;

  // 5. scripts
  const scriptRegistry = new ScriptRegistry();
  registerBuiltinScripts(scriptRegistry, events, assets);
  initProjectScripts({ registry: scriptRegistry, events, assets, onReload: undefined });
  const input = new InputService();

  // 6. render systems
  const animations = new AnimationSystem();
  // mobs and townsfolk with no authored poseLod still pose less often far away
  animations.defaultPoseLod = CROWD_POSE_LOD;
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
  // standing effects (the `vfx` component: torches, braziers) on the same
  // VfxSystem, their lights in the same budget
  const ambientVfx = createAmbientVfx(vfx, assets, lightBudget);
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
  // the server owns players: its per-joiner body replaces the authored one
  if (networked) stripServerPlayers(expanded);
  // held weapons / worn gear: every moving instance of an asset is one draw
  const movingInstances = new MovingInstanceSystem({ resolveModel: (id: string) => assets.getModel(id)?.url });
  // ctx.setModelLook — an ubermesh's runtime parts + theme (equipped gear)
  const modelLooks = createModelLooks({
    objectOf: (entityId) => built.objects.get(entityId),
    textureUrl: (assetId) => assets.getTexture(assetId)?.url,
    resolveModel: (assetId) => assets.getModel(assetId)?.url,
    moving: movingInstances,
    effects: () => ambientVfx, // item effects are standing vfx plays, batched with every other
  });
  // unit-frame face pictures (ctx.faceShot): shot once per look through this renderer, cached
  const faceShots = createFaceShotHost({
    renderer: renderer.renderer,
    objectOf: (entityId) => built?.objects.get(entityId),
    meshOf: (entityId) => {
      const doc = expanded.entities[entityId] ?? netWorld?.docs.get(entityId);
      const mesh = doc?.components["mesh"] as { source?: { assetId?: string }; material?: string } | undefined;
      return mesh ? { ...(mesh.source?.assetId ? { assetId: mesh.source.assetId } : {}), ...(mesh.material ? { material: mesh.material } : {}) } : undefined;
    },
    modelLooks,
    clipsOf: (entityId) => animations.clipsOf(entityId),
  });
  const buildOptions: BuildOptions = {
    movingInstances,
    resolveModel: (id: string) => assets.getModel(id)?.url,
    resolveMaterial: (id: string) => assets.getDataAsset(id)?.data,
    resolveTexture: (id: string) => assets.getTexture(id)?.url,
    resolveMaxAnisotropy: () => renderer.getMaxAnisotropy(),
    onParticles: (entityId, group, data) => particles.register(entityId, group, data, (id: string) => assets.getTexture(id)?.url),
    onVfx: (entityId, group, data) => ambientVfx.register(entityId, group, data),
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
      modelLooks.modelLoaded(entityId, root);
      // a server-spawned body's model: its doc lives in the session's runtime registry
      const entity = expanded.entities[entityId] ?? netWorld?.docs.get(entityId);
      const animator = entity?.components["animator"];
      // the parent id matters: a character's script sits on the physics body
      // and its model on a child, and that is how the body's animation calls
      // reach the model (see AnimationSystem.register)
      animations.register(
        entityId,
        root,
        clips,
        (animator as Parameters<AnimationSystem["register"]>[3]) ?? null,
        entity?.parent ?? null,
      );
    },
  };
  const built = buildScene(expanded, buildOptions);
  built.scene.add(movingInstances.root);
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
  // props and buildings collide only near the bodies this session simulates (as in the editor's play
  // mode and on the server): wasm memory never shrinks, and the whole world's colliders were most of it
  const sim = new PhysicsSim(expanded, undefined, { meshGeometry, streamStatics: { radius: 96 } });
  let staticsStreamStep = 0;
  const eventBus = new EventBus(events);
  eventBus.setNetRole("local");
  // the rig's AIM, not the camera's direction: a middle-button free look turns
  // the camera away from it and the character must keep its heading
  const viewForward = (): [number, number] => {
    const d = followId && rigMode === "follow"
      ? cameraRig.aimDirection(new THREE.Vector3())
      : camera.getWorldDirection(new THREE.Vector3());
    d.y = 0;
    d.normalize();
    return [d.x, d.z];
  };
  // the same aim in 3D (pitch included) and where it starts: the crosshair's ray
  const viewDirection = (): [number, number, number] => {
    const d = followId && rigMode === "follow"
      ? cameraRig.aimDirection(new THREE.Vector3())
      : camera.getWorldDirection(new THREE.Vector3());
    d.normalize();
    return [d.x, d.y, d.z];
  };
  const viewOrigin = (): [number, number, number] => {
    const p = camera.getWorldPosition(new THREE.Vector3());
    return [p.x, p.y, p.z];
  };
  // a world point on screen for DOM overlays (ctx.worldToScreen)
  const screenPoint = new THREE.Vector3();
  const worldToScreen = (x: number, y: number, z: number): { x: number; y: number; distance: number } | null => {
    screenPoint.set(x, y, z).project(camera);
    if (screenPoint.z < -1 || screenPoint.z > 1 || Math.abs(screenPoint.x) > 1.1 || Math.abs(screenPoint.y) > 1.1) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left + ((screenPoint.x + 1) / 2) * rect.width, y: rect.top + ((1 - screenPoint.y) / 2) * rect.height, distance: camera.position.distanceTo(screenPoint.set(x, y, z)) };
  };

  // 8a. the networked session — the editor host's code, not a copy of it
  // (net-session.ts + net-client.ts). The server spawns every player's body
  // and sends its docs over the `world` module; OUR body gets physics +
  // scripts (prediction, reconciled against the server), everyone else's and
  // the server's creatures run suspended and are driven by snapshots.
  let presence: NetPresence | null = null;
  let netWorld: NetRuntimeWorld | null = null;
  let gatewayFlow: GatewayFlow | null = null;
  let comms: Comms | null = null;
  let notifyRoster: () => void = () => undefined;
  /** Whichever camera rendered last frame — voice is heard from there. */
  let listenerCamera: THREE.Camera = camera;
  /** Ids whose local sim is suspended: the server simulates them. */
  const netSuspended = new Set<string>();
  const localPlayerId = (): string | null => {
    const self = netWorld?.selfId ?? null;
    return self && built.objects.has(self) ? self : null;
  };
  /** The camera rig re-aims at our body once the server has spawned it (set in the rig section below). */
  let configureRig: () => void = () => undefined;
  /** A grant for a scene this page does not host: reload on that scene and pick the grant up there. */
  const reloadOnScene = (scene: string, grant: PlayGrant, character: GatewayCharacter): boolean => {
    if (!savePendingGrant(sessionStore, grant, character)) return false;
    console.log(`[net] the server sends us to "${scene}" — reloading this page on it`);
    const next = new URL(location.href);
    next.searchParams.set("scene", scene);
    location.replace(next.href);
    return true;
  };
  function suspendForHost(ids: string[]): void {
    const world = netWorld;
    if (!world) return;
    const own = world.ownSubtree();
    const { toSuspend, toResume, next } = planSuspension(ids, netSuspended, (id) => world.isForeign(id, own));
    if (toSuspend.length > 0) {
      // scripts SUSPEND (entities stay registered — still targetable); physics bodies come off entirely
      scripts.suspendEntities(toSuspend);
      sim.removeEntities(toSuspend);
      // stale smoothing entries would keep writing old positions over the interpolator's
      for (const id of toSuspend) forgetBody(id);
    }
    if (toResume.length > 0) {
      const entities: SceneDoc["entities"] = {};
      for (const id of toResume) {
        const e = expanded.entities[id];
        if (e) entities[id] = e;
      }
      sim.addEntities({ ...expanded, entities });
      scripts.resumeEntities(toResume);
      // continuity: resume each body where its ghost stood, not at its authored spawn
      for (const id of toResume) {
        const object = built.objects.get(id);
        if (object) sim.setPosition(id, [object.position.x, object.position.y, object.position.z]);
      }
    }
    netSuspended.clear();
    for (const id of next) netSuspended.add(id);
  }
  if (networked) {
    const world = new NetRuntimeWorld({
      build: (docs) => {
        const result = buildScene({ ...expanded, entities: docs }, buildOptions);
        built.scene.add(result.scene);
        for (const [id, object] of result.objects) built.objects.set(id, object);
      },
      attach: (ids) => {
        const own = world.ownSubtree();
        const ownDocs: SceneDoc["entities"] = {};
        const otherDocs: SceneDoc["entities"] = {};
        const objects = new Map<string, THREE.Object3D>();
        for (const id of ids) {
          const entity = world.docs.get(id);
          const object = built.objects.get(id);
          if (!entity || !object) continue;
          objects.set(id, object);
          if (own.has(id)) ownDocs[id] = entity;
          else otherDocs[id] = entity;
        }
        if (Object.keys(ownDocs).length > 0) {
          sim.addEntities({ ...expanded, entities: ownDocs });
          scripts.addEntities({ ...expanded, entities: ownDocs }, objects, { silent: true });
        }
        const otherIds = Object.keys(otherDocs);
        if (otherIds.length > 0) {
          scripts.addEntities({ ...expanded, entities: otherDocs }, objects, { silent: true });
          scripts.suspendEntities(otherIds);
          for (const id of otherIds) netSuspended.add(id);
        }
      },
      despawn: (ids) => {
        sim.removeEntities(ids);
        scripts.removeEntities(ids, { silent: true });
        for (const id of ids) {
          const object = built.objects.get(id);
          object?.parent?.remove(object);
          built.objects.delete(id);
          netSuspended.delete(id);
          forgetBody(id);
        }
      },
      onSelf: () => {
        configureRig();
        gatewayFlow?.arrived();
      },
      // the server terraformed the world: re-stream it
      onRecipe: (id, recipe) => {
        if (applyWorldRecipeEdit(id, JSON.stringify(recipe))) chunkManager.reloadAll();
      },
      onTransfer: (t) => {
        if (!gatewayFlow) return presence?.rehome(t.url, t.ticket);
        const flow = gatewayFlow;
        flow.transfer(t, doc.name, (scene, _label, grant) => {
          const who = flow.character();
          return who && reloadOnScene(scene, grant, { id: who.id, name: who.name, createdAt: "" }) ? "reload" : undefined;
        });
      },
    });
    netWorld = world;
    const session: NetPresence = new NetPresence({
      ...peerPresenceHooks({
        playing: () => true, // a published game is always playing
        localPlayerId,
        objectOf: (id) => built.objects.get(id),
        docOf: (id) => expanded.entities[id] ?? world.docs.get(id),
        sim: () => sim,
        isDown: (code) => input.isDown(code),
        viewForward,
        animations,
        eventBus: () => eventBus,
      }),
      getSceneName: () => doc.name,
      serverUrl: netEndpoint.kind === "gateway" ? "gateway" : netEndpoint.url,
      allowP2P: () => false,
      // gateway: nothing to dial until main has placed us
      wantsSession: () => netEndpoint.kind === "server" || (gatewayFlow?.grant() ?? null) !== null,
      // a server-spawned body replaces the capsule avatar for that peer
      hasEntityForPeer: (peerId): boolean => {
        const id = session.netState.get(`player/${peerId}`);
        return typeof id === "string" && built.objects.has(id);
      },
      onRosterChanged: () => notifyRoster(),
      onWorldEntities: (ids) => suspendForHost(ids),
      getEntityObject: (id) => built.objects.get(id) ?? null,
      onRoleChanged: (role) => {
        eventBus.setNetRole(role === "host" ? "authority" : role === "peer" ? "peer" : "local");
        // the server session ended: its entities go with it (they come back with the next welcome)
        if (role === "off") world.clear();
      },
    });
    presence = session;
    session.onSession((s) => {
      if (s?.role === "peer") s.client.onModule("world", (data) => world.handle(data));
    });
    registerSessionNetState(session.netState);
    session.attach(built.scene); // capsule stand-ins for peers without a body (none, on a server)
    const zoneName = (id: string): string => {
      const field = voxelWorldId ? getVoxelWorld(voxelWorldId) : null;
      return field?.recipe.regions.find((r) => r.id === id)?.name ?? id;
    };
    if (netEndpoint.kind === "gateway") {
      gatewayFlow = mountGatewayFlow({
        url: netEndpoint.url,
        presence: session,
        localCreation: () => findCreation(assets),
        textureUrl: (id) => assets.getTexture(id)?.url,
        preview: (canvas, creation) => createCreationPreview(canvas, creation, (id) => assets.getModel(id)?.url, (id) => assets.getTexture(id)?.url),
        zoneName,
        say: (text) => comms?.chat.system(text),
        // a grant for another scene reloads the page on it — once: a bundle without that scene plays this one
        accept: (grant, character) =>
          grant.scene === doc.name || resumed?.grant.scene === grant.scene || !reloadOnScene(grant.scene, grant, character),
        resume: resumed ?? undefined,
      });
      const social = gatewayFlow.social;
      window.addEventListener("keydown", (e) => {
        if (e.code !== "KeyO" || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        social.toggle(); // friends, party & guild
      });
    }
    mountConnectionOverlay({
      presence: session,
      world,
      wanted: () => netEndpoint.kind === "server" || (gatewayFlow?.grant() ?? null) !== null,
      gateway: gatewayFlow,
    });
    const sessionComms = createSessionComms({
      presence: session,
      eventBus: () => eventBus,
      playing: () => true,
      listenerCamera: () => listenerCamera,
      zoneOf: (p) => {
        const field = voxelWorldId ? getVoxelWorld(voxelWorldId) : null;
        return (field ? regionAt(field.recipe.regions, p[0], p[2])?.id : undefined) ?? doc.name;
      },
      social: gatewayFlow?.social ?? null,
      runPlayerCommand: (name, args) => scripts.runPlayerCommand(name, args),
    });
    comms = sessionComms.comms;
    notifyRoster = () => sessionComms.notifyRoster();
  }
  // single-player: a local netState store IS the authority (default). Scripts
  // built on netState (like the mall manager) need this to run at all.
  // Networked: the presence's replica of the server's state.
  const netState = presence?.netState ?? new NetStateStore();
  if (!presence) {
    registerCharacterNetState(netState);
    registerTransferLockNetState(netState);
  }

  const scripts = new ScriptRuntime({
    doc: expanded,
    objects: built.objects,
    sim,
    events: eventBus,
    registry: scriptRegistry,
    input,
    worldToScreen,
    viewForward,
    viewDirection,
    viewOrigin,
    recenterView: () => cameraRig.returnToAim(),
    renderPortrait: (entityId, canvas, opts) => {
      const object = built.objects.get(entityId);
      if (!object) return null;
      const view = new PortraitView(object, canvas, { ...opts, clips: animations.clipsOf(entityId) });
      // the head, hair, helm and pads are drawn by moving batches, not under the body: seat copies on the clone's bones
      modelLooks.dressPortrait(object, view.model, () => view.refit());
      return () => view.dispose();
    },
    faceShot: (entityId) => faceShots.faceShot(entityId),
    netState,
    // networked: "me" is the body the server said is ours, not any player-tagged one; ctx.chat is the session's
    ...(networked ? { localPlayer: localPlayerId } : {}),
    ...(comms ? { chat: comms.chat } : {}),
    setAnimation: (id, clip, fade, opts) =>
      animations.play(id, clip, fade ?? 0.3, opts?.loop ?? true, opts?.restart ?? false, opts?.sync ?? false),
    setAnimationLayer: (id, clip, opts) => animations.playLayer(id, clip, opts),
    clearAnimationLayer: (id, fade) => animations.clearLayer(id, fade ?? 0.2),
    animationClips: (id) => animations.clipNames(id),
    animationDuration: (id, clip) => animations.clipDuration(id, clip),
    animationPhase: (id) => animations.baseClipPhase(id),
    setAnimationSpeed: (id, multiplier) => animations.setSpeed(id, multiplier),
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
    setModelLook: (id, look) => modelLooks.set(id, look),
    modelTables: (assetId) => modelLooks.tables(assetId),
    playSound: (entityId, soundId, opts) => {
      const src = soundId ?? (expanded.entities[entityId]?.components["audio"] as AudioComponentData | undefined)?.src;
      if (!src) return;
      if (opts?.at) void audio.playAt(built.scene, opts.at, src, opts);
      else void audio.play(built.objects.get(entityId) ?? null, src, opts);
    },
    setSoundLoop: (entityId, slot, soundId, opts) =>
      audio.setLoop(`${entityId}/${slot}`, built.objects.get(entityId) ?? null, soundId, opts),
    hasSound: (soundId) => assets.getSound(soundId) !== undefined,
    // called from a frame, long after the streamer below exists
    worldLoading: () => chunkManager.stats.loading > 0,
    soundDuration: (soundId) => {
      const seconds = audio.duration(soundId);
      if (seconds === undefined && assets.getSound(soundId)) audio.preload(soundId);
      return seconds;
    },
  });
  vfx.resolvers.playSound = (soundId, at, volume) => void audio.playAt(built.scene, at, soundId, { volume });
  // browsers start audio suspended until a gesture
  window.addEventListener("pointerdown", () => audio.resume(), { once: true });
  window.addEventListener("keydown", () => audio.resume(), { once: true });
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
    // particles in streamed cells (waterfall mist): registered like the scene's, dropped on unload
    onParticles: (entityId, group, data) => particles.register(entityId, group, data, (id: string) => assets.getTexture(id)?.url),
    onVfx: (entityId, group, data) => ambientVfx.register(entityId, group, data),
    onClusteredMesh: (_entityId, mesh) => clusterLod.register(mesh),
    bakeImpostor: (object, bounds) => bakeImpostorAtlas(renderer, object, bounds),
  }, {
    onLoaded: (doc, objects, simulated) => {
      for (const [id, object] of objects) built.objects.set(id, object);
      // render-only LOD rings (fullRender/hlod/far) render but never simulate
      if (simulated) scripts.addEntities(doc, objects);
    },
    onUnloaded: (ids) => {
      for (const id of ids) {
        built.objects.delete(id);
        particles.unregister(id);
      }
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
  // the load-in screen: painted, until the world around the player is in and the frame rate has settled
  mountLoadScreen({
    creation: () => findCreation(assets),
    textureUrl: (id) => assets.getTexture(id)?.url,
    signals: {
      wanted: () => !networked || netEndpoint.kind === "server" || (gatewayFlow?.grant() ?? null) !== null,
      connected: () => !networked || presence?.serverLink().phase === "connected",
      hasBody: () => !networked || localPlayerId() !== null,
      loading: () => chunkManager.stats.loading,
      switching: () => false,
      place: () => {
        const id = localPlayerId();
        const body = id ? built.objects.get(id) : undefined;
        const field = voxelWorldId ? getVoxelWorld(voxelWorldId) : null;
        return (body && field ? regionAt(field.recipe.regions, body.position.x, body.position.z)?.name : undefined) ?? "";
      },
    },
  });
  await chunkManager.configure(streamer, built.scene);
  // ground probes for the `grass` component; null world -> no cover, no throw
  const ground = voxelGroundProbes(() => (voxelWorldId ? getVoxelWorld(voxelWorldId) : null));
  // the world carries its own cover (recipe.cover), one layer per `cover:<id>`
  grass.regionTest = ground.regionTest;
  const worldCoverRoot = new THREE.Group();
  worldCoverRoot.name = "world-cover";
  built.scene.add(worldCoverRoot);
  syncWorldCover(grass, worldCoverRoot, voxelWorldId ? getVoxelWorld(voxelWorldId) : null, new Set(), (id: string) => assets.getTexture(id)?.url);

  // camera rig config (data-driven from the active camera's rig)
  let followId: string | null = null;
  let rigMode: "follow" | "chase" | null = null;
  let rigCollision = true;
  /**
   * The third-person camera, shared with the editor's play mode — one
   * implementation, so a fix to how the boom behaves in a town lands in the
   * published build too. It owns `camera` whenever there is a follow target;
   * camera-controls is left for the rigless case (a scene with no character).
   */
  const cameraRig = new ThirdPersonCameraRig();
  const PLAY_CAM_MIN = 0.25;
  const PLAY_CAM_MAX = 14;
  // Networked, the body arrives later (the server spawns it) and every
  // player's body carries the tag: follow OUR body, so this runs again when it lands.
  configureRig = (): void => {
    for (const entity of Object.values(expanded.entities)) {
      const cam = entity.components["camera"] as CameraComponentData | undefined;
      if (cam?.active && (cam.rig?.mode === "follow" || cam.rig?.mode === "chase")) {
        const self = netWorld?.selfId ?? null;
        followId = netWorld
          ? (self && netWorld.docs.get(self)?.tags.includes(cam.rig.targetTag) ? self : null)
          : (Object.entries(expanded.entities).find(([, e]) => e.tags.includes(cam.rig!.targetTag))?.[0] ?? null);
        rigMode = cam.rig.mode as "follow" | "chase";
        rigCollision = cam.rig.collision !== false;
        // A rigged camera is DRIVEN, so its own scene object is never what
        // renders — the rig moves this one instead. Its lens settings still
        // belong to the author though, and in a streamed world the far plane is
        // not a detail: a scene asking for 4000 rendered through the default 500
        // clips the outer LOD rings away and the world ends in mid-air.
        if (cam.fov !== undefined) camera.fov = cam.fov;
        if (cam.near !== undefined) camera.near = cam.near;
        if (cam.far !== undefined) camera.far = cam.far;
        camera.updateProjectionMatrix();
        // the pivot is authored from the body's ORIGIN, which on a capsule
        // character is its waist: keep it inside the body's own collider
        const body = followId ? (expanded.entities[followId] ?? netWorld?.docs.get(followId)) : undefined;
        cameraRig.applyAuthored({
          ...fitRigToBody(cam.rig, body?.components["collider"] as RigBodyCollider | undefined),
          minDistance: cam.rig.minDistance ?? PLAY_CAM_MIN,
          maxDistance: cam.rig.maxDistance ?? PLAY_CAM_MAX,
        });
        cameraRig.reset();
        break;
      }
    }
  };
  configureRig();

  /**
   * The rig's collision query: masked to the static world, never to actors, so
   * an NPC walking behind the player cannot shove the camera into their head.
   * Physics rather than meshes because a mesh list cannot see streamed chunk
   * terrain or scattered trees at all, and costs a full triangle raycast per
   * listed mesh per frame where this costs one broadphase sweep.
   */
  const CAMERA_BOOM_LAYERS = Layers.WORLD | Layers.TERRAIN | Layers.CAMERA_BLOCKER;
  function cameraBoomSweep(radius: number, from: RigVec3, to: RigVec3, fromInside = false): number | null {
    if (!followId) return null;
    // exclude the target: a sweep that starts inside its own capsule is
    // stopped by itself at distance 0, which jams the camera in the head.
    // `fromInside`: the rig's probes may begin touching what they are leaving
    // and must only be stopped by what they move INTO.
    const hit = sim.spherecast(radius, from, to, {
      exclude: [followId],
      layers: CAMERA_BOOM_LAYERS,
      stopAtPenetration: !fromInside,
    });
    return hit ? hit.distance : null;
  }

  // HOLD-TO-LOOK. The published game does not capture the cursor either: a
  // pointer lock is taken by a click rather than asked for, and it takes the
  // mouse away from everything else on the machine until the player finds out
  // that Escape is the way back. Holding a button over the view turns it —
  // the MMO convention — and the cursor stays where it was left.
  const LOOK = 0.0025;
  const LOOK_BUTTONS = 0b110; // right turns the aim; middle is a free look (parks; moving or casting brings it back)
  const FREE_LOOK_BUTTON = 1;
  let heldButtons = 0;
  /**
   * Mouse mode, the same pair the editor host offers: CURSOR by default (the
   * pointer is the player's, hold right/middle to turn) and MOUSELOOK on Z,
   * which captures the pointer so the mouse can keep steering past the edge of
   * the window. Only the player enters it; Escape or Z leaves.
   */
  let mouseLook = false;
  const MOUSE_LOOK_KEY = "KeyZ";
  window.addEventListener("keydown", (e) => {
    if (e.code !== MOUSE_LOOK_KEY || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (mouseLook) document.exitPointerLock();
    else void canvas.requestPointerLock()?.catch(() => undefined);
  });
  document.addEventListener("pointerlockchange", () => {
    mouseLook = document.pointerLockElement === canvas;
    if (!mouseLook) input.releaseMouse();
  });
  const trackButton = (e: MouseEvent, down: boolean): void => {
    if (down) heldButtons |= 1 << e.button;
    else heldButtons &= ~(1 << e.button);
    if (e.button === FREE_LOOK_BUTTON) {
      if (down) e.preventDefault(); // no autoscroll cursor
      cameraRig.setFreeLook(down);
    }
  };
  canvas.addEventListener("mousedown", (e) => trackButton(e, true));
  window.addEventListener("mouseup", (e) => trackButton(e, false));
  window.addEventListener("blur", () => {
    heldButtons = 0;
    cameraRig.setFreeLook(false);
  });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault()); // right-drag is a turn
  controls.enabled = false; // the play rig owns the camera; nothing else drags it
  document.addEventListener("mousemove", (e) => {
    if (!mouseLook && (heldButtons & LOOK_BUTTONS) === 0) return;
    if (rigMode === "chase") { input.addMouseDelta(e.movementX, e.movementY); return; }
    if (followId) { cameraRig.addLook(e.movementX, e.movementY); return; }
    void controls.rotate(-e.movementX * LOOK, -e.movementY * LOOK, false);
  });
  // wheel zoom: the framing the player wants, which collision may still shorten
  canvas.addEventListener(
    "wheel",
    (e) => {
      if (rigMode !== "follow") return;
      e.preventDefault();
      cameraRig.addZoom(e.deltaMode === 0 ? e.deltaY * 0.012 : e.deltaY * 0.4);
    },
    { passive: false },
  );

  // 9. the loop
  const prev = new Map<string, THREE.Vector3>();
  const curr = new Map<string, THREE.Vector3>();
  /** Drop a body's smoothing entries (the server took it over, or it left). */
  function forgetBody(id: string): void {
    prev.delete(id);
    curr.delete(id);
  }
  const lerp = new THREE.Vector3();
  const followPos = new THREE.Vector3();
  /** Scratch: the followed body's world rotation, which a chase rig sits behind. */
  const rigTargetQuat = new THREE.Quaternion();
  const streamFocus = new THREE.Vector3();
  const camWorldPos = new THREE.Vector3();

  /**
   * The PLAYER map (M) and the minimap service for a project HUD: terrain,
   * zones, roads, towns, the player and their own markers — nothing else.
   * `devLayers` stays false here, so named places, dungeon entrances, quest
   * givers and the DEV layer cannot be drawn in a published game, and there is
   * no click-to-travel. Markers are kept per signed-in character.
   */
  const mapPos = new THREE.Vector3();
  const mapDir = new THREE.Vector3();
  const worldMap = createWorldMapOverlay({
    devLayers: false,
    fileUrl: (path) => url(`content/${path}`),
    owner: () => gatewayFlow?.character()?.id ?? null,
    world: () => voxelWorldId,
    recipe: () => (voxelWorldId ? (getVoxelWorld(voxelWorldId)?.recipe ?? null) : null),
    position: () => {
      const target = followId ? built.objects.get(followId) : null;
      if (target) target.getWorldPosition(mapPos);
      else camera.getWorldPosition(mapPos);
      camera.getWorldDirection(mapDir);
      return { x: mapPos.x, z: mapPos.z, yaw: Math.atan2(-mapDir.x, -mapDir.z) };
    },
  });
  window.addEventListener("keydown", (e) => {
    if (e.code !== "KeyM" || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target instanceof HTMLElement && e.target.isContentEditable)) return;
    worldMap.toggle();
  });

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
  // The developer console, if this bundle was published with one. Normally
  // it was not: the import folds away at build time and nothing below runs.
  // There is no chat in a published game, so the console brings its own input
  // line — type "/" to open it.
  void startDevConsole({ runtime: () => scripts });

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
      if (++staticsStreamStep % 6 === 0) sim.updateStaticsAroundBodies();
      sim.step(dt);
      for (const [id, state] of sim.states()) {
        const obj = built.objects.get(id);
        if (obj) applyBodyState(obj, state);
        let p = curr.get(id);
        if (!p) { p = new THREE.Vector3(); curr.set(id, p); prev.set(id, new THREE.Vector3().fromArray(state.position)); }
        prev.get(id)!.copy(p);
        p.fromArray(state.position);
      }
      // a dedicated server's client reads deadlines stamped on the server's clock
      const hostMs = presence?.hostSimNow() ?? null;
      if (hostMs !== null) scripts.syncClock(hostMs);
      scripts.fixedUpdate(dt);
    },
    update: (dt, alpha) => {
      profiler.beginFrame();
      for (const [id, c] of curr) {
        const obj = built.objects.get(id);
        const p = prev.get(id);
        if (obj && p) { lerp.copy(p).lerp(c, alpha); obj.position.copy(lerp); }
      }
      presence?.update(dt); // dial / re-dial; remote bodies and creatures lerp toward their snapshots
      if (followId) {
        const target = built.objects.get(followId);
        if (target) {
          target.getWorldPosition(followPos);
          target.getWorldQuaternion(rigTargetQuat);
          cameraRig.update(dt, followPos, camera, rigCollision ? cameraBoomSweep : null, rigTargetQuat);
          // the boom is inside the body: take it out of the shot rather than
          // rendering the inside of its own head
          target.visible = !cameraRig.targetObscured;
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
      if (!followId) controls.update(dt); // the rig owns the camera when there is one
      // Camera priority: a script-switched camera wins, then a RIGLESS active
      // scene camera, then the rig camera. The `rigless` half matters: a
      // camera entity with a follow/chase rig is DRIVEN by the rig above,
      // which moves `camera` — rendering that entity's own object instead
      // leaves the view frozen at the transform the scene file happens to
      // carry, and the player walks out of frame.
      const activeId = scripts.getActiveCameraId();
      const renderCam =
        (activeId && built.cameras.get(activeId)) || (!followId && built.activeCamera) || camera;
      animations.update(dt, renderCam, followId);
      movingInstances.update(); // held weapons follow their sockets (after animation)
      particles.update(dt, renderCam);
      billboards.update(dt); // flipbook VFX frames
      if (!vfxWarmed) {
        // once: every effect pipeline compiles now instead of on the first cast
        vfxWarmed = true;
        if (probe.precompile) void warmVfx(vfx, assets, (group) => renderer.precompileGroup(group, renderCam, built.scene), renderCam);
      }
      modelLooks.update(); // item effects placed once their model has loaded
      ambientVfx.update(renderCam, built.scene); // before the plays step and the light budget re-aims
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
      listenerCamera = renderCam;
      comms?.update(); // voice: gate outgoing tracks, VAD, spatial gains
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
  if (bootCurtain) {
    // hold until the near ground (and the body, under a server) is in: three quiet checks in a row, 30 s at most
    const curtain = bootCurtain;
    const started = performance.now();
    let progress = 0.6;
    let quiet = 0;
    const poll = setInterval(() => {
      const ready = chunkManager.stats.loading === 0 && gltfLoadingCount() === 0 && chunkManager.isViewReady() && (!networked || localPlayerId() !== null);
      quiet = ready ? quiet + 1 : 0;
      curtain.setProgress((progress += (0.95 - progress) * 0.05));
      if (quiet < 3 && performance.now() - started < 30000) return;
      clearInterval(poll);
      curtain.setProgress(1);
      setTimeout(() => curtain.hide(), 160);
    }, 100);
  }
  // Probe handle for headless measurement (see docs/perf-investigation-2026-09-02.md):
  // the published build has no editor, so this is the only way a script can
  // read draw calls, chunk state and the pipeline caches behind a stall.
  Object.assign(probe, { renderer, chunkManager, profiler, controls, camera, built, sim, lightBudget, foliageLod, grass, ambientVfx });
  // read-only session facts for headless checks (no admin, no script runtime)
  if (presence) {
    const session = presence;
    probe["net"] = { stats: () => session.stats(), link: () => session.serverLink(), self: () => netWorld?.selfId ?? null, positionOf: (peerId: string) => session.positionOf(peerId) };
  }
  (window as unknown as { __hitreg: unknown }).__hitreg = probe;
}

main().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML("beforeend", `<pre style="position:fixed;inset:0;padding:20px;color:#f88;background:#111;font:13px monospace;white-space:pre-wrap;z-index:9999">Failed to start:\n${(e as Error).message}\n${(e as Error).stack ?? ""}</pre>`);
});
