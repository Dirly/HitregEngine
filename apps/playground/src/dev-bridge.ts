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
import type {
  AssetSelection,
  EditingChunk,
  EditingPrefab,
  Hover,
  Manipulating,
  MeshEditState,
  ModelBones,
  MultiSelection,
  Pins,
  Observable,
  PlayMode,
  Selection,
} from "@hitreg/editor";
import type { ChunkManager } from "./chunk-manager.js";
import type { SubsceneManager } from "./subscene-manager.js";
import type { NetPresence } from "./net-presence.js";
import type { Comms } from "@hitreg/comms";

/** Context-bridge view of player comms: recent chat lines + voice state. */
function describeComms(comms: Comms | null): Record<string, unknown> | null {
  if (!comms) return null;
  const voice = comms.voice.state();
  return {
    chat: comms.chat
      .history()
      .slice(-10)
      .map((m) => ({ channel: m.channel, name: m.name, text: m.text })),
    voice: {
      enabled: voice.enabled,
      muted: voice.muted,
      mode: voice.mode,
      speakChannel: voice.speakChannel,
      transmitting: voice.transmitting,
      peers: voice.peers.map((p) => ({
        name: p.name,
        connected: p.connected,
        speaking: p.speaking,
        channel: p.channel,
      })),
    },
  };
}
import type { BillboardSystem } from "@hitreg/render";

export interface DevBridgeDeps {
  registry: ComponentRegistry;
  assets: AssetLibrary;
  events: EventRegistry;
  camera: THREE.PerspectiveCamera;
  controls: CameraControls;
  store: SceneStore;
  selection: Selection;
  multiSelection: MultiSelection;
  hover: Hover;
  manipulating: Manipulating;
  editorVisible: Observable<boolean>;
  editingPrefab: EditingPrefab;
  editingChunk: EditingChunk;
  assetSelection: AssetSelection;
  /** Modal authoring tools, for the synthesized `focus.mode`. */
  tools: {
    graybox: Observable<boolean>;
    terrain: Observable<boolean>;
    path: Observable<boolean>;
    /** Mesh-edit mode (vertex/edge/face); its element selection is published under `focus.meshEdit`. */
    meshEdit?: MeshEditState;
  };
  /** World-anchored notes for the current scene. */
  pins: Pins;
  /**
   * Frame an entity the way the editor's own "focus selection" does; false
   * when nothing is built for that id. Passed in rather than recomputed here
   * so POST /__hitreg/camera {frame} and double-clicking the hierarchy land
   * on exactly the same pose.
   */
  frameEntity: (id: string, transition?: boolean) => boolean;
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
  getComms: () => Comms | null;
  getReconcileCount: () => number;
  getRebuildCount: () => number;
  /**
   * The frame profiler, condensed: percentiles rather than means, the hottest
   * scopes by self time, recent spikes with the marker that explains each.
   * Shape is owned by main.ts's buildPerfReport — kept as its return type so
   * adding a field there can't silently fail to reach the bridge.
   *
   * Percentiles specifically, because a mean cannot answer the question people
   * actually ask ("why does it hitch"): a 40ms stall every two seconds is
   * invisible in an average and obvious in a p99.
   */
  getPerf: () => unknown;
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

/**
 * One line naming what the user is actually doing, synthesized from the six
 * independent observables that each know a fragment of it. Nothing else in the
 * editor computes this — every consumer that wanted "what mode is this?" had to
 * re-derive it from play mode plus three tool booleans plus two isolation
 * states, and get the precedence right. Precedence here is deliberate: play
 * mode wins over everything (the doc isn't being authored at all), then
 * isolation contexts (the working doc isn't the scene), then modal tools.
 */
function describeMode(deps: DevBridgeDeps): string {
  const play = deps.playMode.get();
  if (play !== "edit") return play;
  if (!deps.editorVisible.get()) return "viewing";
  const chunk = deps.editingChunk.get();
  if (chunk) return `editing-chunk:${chunk.world}/${chunk.cx}_${chunk.cz}`;
  const prefab = deps.editingPrefab.get();
  if (prefab) return `editing-prefab:${prefab}`;
  if (deps.tools.graybox.get()) return "graybox";
  if (deps.tools.terrain.get()) return "terrain-sculpt";
  if (deps.tools.path.get()) return "path-draw";
  const meshEdit = deps.tools.meshEdit;
  if (meshEdit?.active.get() && meshEdit.mode.get() !== "object" && meshEdit.entityId.get()) {
    return `mesh-edit:${meshEdit.mode.get()}`;
  }
  return "edit";
}

/**
 * What the human's attention is on, in the order an agent should trust it.
 *
 * The whole point: a request like "make this one taller" or "put a bench here"
 * carries a referent the words don't. Selection alone is a weak signal — it can
 * be ten minutes stale. A live gizmo drag is the strongest ("I have hold of
 * THIS"), hover is next ("I'm pointing at it right now"), selection after that,
 * and the camera/in-view list is the fallback the engine already published.
 * Publishing the ranking rather than one blurred "focus" value lets the agent
 * decide how much to trust it, and lets it say *why* it resolved a reference
 * the way it did.
 */
function buildFocus(deps: DevBridgeDeps): Record<string, unknown> {
  const manipulating = deps.manipulating.get();
  const hover = deps.hover.get();
  const selected = deps.multiSelection.get();
  const asset = deps.assetSelection.get();

  const strongest = manipulating
    ? "manipulating"
    : hover?.id
      ? "hover"
      : selected.length > 0
        ? "selection"
        : asset
          ? "asset"
          : "none";

  const name = (id: string): string | null => deps.store.doc.entities[id]?.name ?? null;

  return {
    /** Which signal below an agent should resolve "this" against. */
    strongest,
    mode: describeMode(deps),
    /** Live gizmo drag — the user physically has hold of these right now. */
    manipulating: manipulating
      ? { ids: manipulating.ids, mode: manipulating.mode, names: manipulating.ids.map(name) }
      : null,
    /** Cursor target: entity under it plus the world point and surface normal. */
    hover: hover ? { ...hover, name: hover.id ? name(hover.id) : null } : null,
    /** Full selected set (capped); `selection` above stays the active member. */
    selected: selected.slice(0, 32).map((id) => ({ id, name: name(id) })),
    selectedCount: selected.length,
    /** Asset panel selection — "this material", not "this entity". */
    asset: asset ?? null,
    /**
     * Mesh-edit element selection while a poly mesh is open for editing:
     * "bevel these edges" / "extrude this face" resolve to real indices into
     * that entity's `mesh.source` (vertices/faces arrays). Edit the mesh with
     * the @hitreg/core poly-mesh ops (or by hand) and write it back with one
     * set-component op; the editor picks the change up live.
     */
    meshEdit: (() => {
      const m = deps.tools.meshEdit;
      const id = m?.entityId.get();
      if (!m || !m.active.get() || !id) return null;
      const sel = m.selection.get();
      return {
        entityId: id,
        name: name(id),
        mode: m.mode.get(),
        vertices: sel.vertices.slice(0, 256),
        edges: sel.edges.slice(0, 256),
        faces: sel.faces.slice(0, 256),
        counts: m.stats.get(),
      };
    })(),
    /**
     * Open notes the human left in the world, nearest the camera first. These
     * are standing requests: unlike selection, nobody has to be pointing at
     * anything for them to be actionable, and they survive the session. An
     * agent that reads context and ignores these is missing the part of the
     * conversation that was written down on purpose.
     */
    pins: openPins(deps),
    openPinCount: deps.pins.get().filter((pin) => !pin.resolved).length,
  };
}

/** Unresolved notes, nearest-first, capped like every other context list. */
function openPins(deps: DevBridgeDeps): Array<Record<string, unknown>> {
  const camera = deps.camera.position;
  return deps.pins
    .get()
    .filter((pin) => !pin.resolved)
    .map((pin) => ({
      id: pin.id,
      text: pin.text,
      point: pin.point,
      entityId: pin.entityId,
      entityName: pin.entityId
        ? (deps.store.doc.entities[pin.entityId]?.name ?? null)
        : null,
      author: pin.author,
      createdAt: pin.createdAt,
      distance: Number(
        Math.hypot(pin.point[0] - camera.x, pin.point[1] - camera.y, pin.point[2] - camera.z).toFixed(2),
      ),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 20);
}

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
    getComms,
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
      // where the user's attention is, ranked — see buildFocus
      focus: buildFocus(deps),
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
      // player comms (@hitreg/comms): the last chat lines THIS tab was allowed
      // to see, and voice state — "what are they saying" for an agent
      comms: describeComms(getComms()),
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

/** A pose command from POST /__hitreg/camera, broadcast to every tab. */
interface CameraCommand {
  cmdId: string;
  /** bridgeSessionId of the tab this is for — the ws send is a broadcast. */
  to: string;
  position?: [number, number, number];
  target?: [number, number, number];
  /** Entity id to frame, or the literal "selection". */
  frame?: string;
  transitionMs: number;
}

const camTarget = new THREE.Vector3();

/**
 * Aim the editor camera from outside the browser (POST /__hitreg/camera).
 *
 * This is the piece that lets an agent LOOK at its own work: nothing publishes
 * the camera on `window`, and synthetic input can't fly it (the fly-cam needs
 * real pointer capture), so before this the only way to pose the view for a
 * screenshot was to rewrite the dev server's main.ts response and smuggle a
 * handle out.
 *
 * Every reply is measured, never assumed — see the ack comment below.
 */
export function installCameraBridge(deps: DevBridgeDeps): void {
  if (!import.meta.hot) return; // no dev server, no bridge
  const { camera, controls, playMode, selection, frameEntity } = deps;

  // camera-controls eases with a smooth-damp TIME CONSTANT, not a duration:
  // a move is ~63% done after one `smoothTime` and only arrives around three
  // of them (measured — a 600ms request set as smoothTime rested well past
  // 1.1s and a third of the way short). So transitionMs, which callers read as
  // "how long the move takes", maps to smoothTime/3. Captured once at install
  // rather than at command time: two overlapping commands would otherwise save
  // each other's modified value and leak it into the editor's permanent feel.
  const baseSmoothTime = controls.smoothTime;
  const SMOOTH_TIME_PER_MS = 1 / 3000;

  const pose = (): { position: number[]; target: number[] } => ({
    position: camera.position.toArray().map((v) => Number(v.toFixed(3))),
    target: controls
      .getTarget(camTarget)
      .toArray()
      .map((v) => Number(v.toFixed(3))),
  });

  import.meta.hot.on("hitreg:camera", (cmd: CameraCommand) => {
    if (cmd.to !== bridgeSessionId) return; // broadcast — not addressed to this tab
    const transition = cmd.transitionMs > 0;
    let error: string | null = null;
    try {
      if (transition) controls.smoothTime = cmd.transitionMs * SMOOTH_TIME_PER_MS;
      if (cmd.frame !== undefined) {
        const id = cmd.frame === "selection" ? selection.get() : cmd.frame;
        if (!id) error = 'frame:"selection" but nothing is selected';
        else if (!frameEntity(id, transition)) error = `nothing is built for entity "${id}"`;
      } else if (cmd.position) {
        const t = cmd.target ?? controls.getTarget(camTarget).toArray();
        // Deliberately NOT touching controls.enabled. It is false on purpose
        // while the pointer is locked (main.ts's syncPointerLockState) so that
        // orbit-drag doesn't double-apply the mouse look; `enabled` only gates
        // DOM input, and setLookAt/update work with it off either way.
        void controls.setLookAt(
          cmd.position[0], cmd.position[1], cmd.position[2],
          t[0]!, t[1]!, t[2]!,
          transition,
        );
        if (!transition) {
          // land it THIS frame: a screenshot tool posts a pose and shoots.
          controls.update(0);
          camera.updateMatrixWorld(true);
        }
      }
    } catch (e) {
      error = String(e);
    }

    /**
     * Report what the camera DID, not what was asked for. The follow/chase rig
     * and the fly-cam both run inside main's animation frame and can overrule
     * this move entirely; camera-controls also clamps against minDistance and
     * maxPolarAngle (both tightened in play mode). Acking from a rAF
     * registered after theirs means we observe their result instead of racing
     * it, so a caller that got overruled can see it in the response.
     */
    const ack = (): void => {
      controls.smoothTime = baseSmoothTime;
      requestAnimationFrame(() => {
        void fetch("/__hitreg/camera", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ack: cmd.cmdId,
            bridgeSessionId,
            ok: error === null,
            camera: pose(),
            playMode: playMode.get(),
            ...(error ? { error } : {}),
          }),
        }).catch(() => undefined);
      });
    };

    if (error !== null || !transition) {
      ack();
      return;
    }
    // eased move: answer when the controls actually come to rest — smooth-damp
    // approaches asymptotically, so "transitionMs elapsed" is not the same as
    // "arrived", and acking on a timer alone reports a pose still in flight.
    // The cap is the fallback for a move that never rests (the user grabs the
    // camera mid-flight); it stays inside the server's ack deadline.
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      controls.removeEventListener("rest", finish);
      clearTimeout(cap);
      ack();
    };
    const cap = setTimeout(finish, cmd.transitionMs + 1500);
    controls.addEventListener("rest", finish);
  });
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
