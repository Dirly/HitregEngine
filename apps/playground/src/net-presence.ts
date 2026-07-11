import * as THREE from "three/webgpu";
import { NetStateStore } from "@hitreg/core";
import {
  computeView,
  dueThisTick,
  InterpolationClock,
  mergeTransports,
  RelayClientTransport,
  RelayHostTransport,
  RoomClient,
  RoomHost,
  TransformInterpolator,
  WebRtcClientTransport,
  WebRtcHostTransport,
  type SignalingChannel,
  type Transport,
  type TransformSnap,
} from "@hitreg/net";

/**
 * NetPresence — dev multiplayer presence for the playground.
 *
 * Tabs on the same scene auto-join room `scene:<name>` through the dev
 * server's websocket signaling relay (vite.config.ts), then talk P2P over
 * WebRTC data channels (falling back to the relay itself where a browser
 * blocks RTC). The relay elects the FIRST joiner as host: it runs a
 * RoomHost, everyone else dials it as a RoomClient.
 *
 * Milestone 2 core (commands up, snapshots down — ARCHITECTURE §3a):
 * - Peers send movement INTENT (desired velocity + jump) at 20 Hz; the host
 *   clamps it and simulates a physics proxy per remote player. Peers keep
 *   running their own controller locally — that IS client-side prediction —
 *   and reconcile against the host's authoritative position per snapshot
 *   (dead-band → soft nudge → hard snap).
 * - Entities with script+rigidbody (NPCs) are host-simulated; peers suspend
 *   their local sim for those and render ghosts.
 * - All remote motion (players + NPCs) renders through snapshot
 *   interpolation buffers, ~100ms behind, with brief extrapolation.
 * Remote players render as colored capsules with floating name labels. A
 * host change is handled crudely — tear down and re-dial the new host. The
 * 20 Hz setInterval host tick still stands in for the real fixed-tick sim.
 *
 * No-ops entirely without import.meta.hot (prod builds have no signaling).
 */

export interface NetPresenceOptions {
  getSceneName(): string;
  /** The local play-mode player, or null when not playing. */
  getLocalPlayer(): { position: [number, number, number]; yaw: number } | null;
  onRosterChanged?: () => void;

  // -- host-authoritative players (commands up, snapshots down) --------------
  /**
   * The local player's movement INTENT right now: desired horizontal
   * velocity + jump. Sent to the host as a command; the host clamps and
   * simulates it on a physics proxy (the trust boundary: peers send
   * intentions, never state). Null = no input this instant.
   */
  getLocalInput?(): { v: [number, number]; jump: boolean } | null;
  /** Host: world position of a remote player's physics proxy, if spawned. */
  getProxyState?(peerId: string): { p: [number, number, number] } | null;
  /**
   * Peer: the host's authoritative position for OUR player arrived.
   * The app reconciles its local prediction against it (dead-band →
   * soft nudge → hard snap).
   */
  reconcileLocalPlayer?(p: [number, number, number]): void;

  // -- world replication (host-authoritative NPCs) ----------------------------
  /**
   * Host: every replicated entity's state + policy this tick (from
   * `netObject` components, plus the implicit script+rigidbody default);
   * null = not playing. NetPresence turns these into per-peer snapshot
   * views (interest management + send cadence).
   */
  collectReplicas?(): NetReplica[] | null;
  /**
   * Peer: the set of host-simulated entity ids changed. The app suspends
   * its local sim for these (scripts + physics) — the host owns them now —
   * and resumes anything that left the set. Called with [] on teardown.
   */
  onWorldEntities?(ids: string[]): void;
  /** Peer: resolve a replicated entity to its render object (ghost target). */
  getEntityObject?(id: string): THREE.Object3D | null;
  /** Peer: apply a replicated animation clip change. */
  setEntityAnim?(id: string, clip: string): void;

  // -- replicated gameplay events ----------------------------------------------
  /**
   * Host: drain the event bus outbox (replicate-flagged events delivered
   * since last tick). Shipped reliable-ordered to every peer.
   */
  collectNetEvents?(): Array<{ name: string; payload: unknown }>;
  /** Peer: replicated events arrived — inject into the local event bus. */
  onNetEvents?(events: Array<{ name: string; payload: unknown }>): void;
  /**
   * Host: emit an engine-level event locally (roster changes become
   * player.joined / player.left on the host's bus, which replicate).
   */
  emitLocalEvent?(name: string, payload: unknown): void;
  /** Peer: drain pending peer→authority event requests to ship as commands. */
  collectPeerEvents?(): Array<{ name: string; payload: unknown }>;
  /** Host: a peer's event request arrived — inject with sender attribution. */
  onPeerEvent?(from: string, events: Array<{ name: string; payload: unknown }>): void;
  /** Role changed (host election, relay fallback, teardown) — retarget the bus. */
  onRoleChanged?(role: "host" | "peer" | "off"): void;
}

/** One replicated entity as the host's sim sees it, with its net policy. */
export interface NetReplica {
  id: string;
  p: [number, number, number];
  q: [number, number, number, number];
  anim?: string;
  relevancy: "always" | "proximity";
  radius: number;
  sendEvery: number;
  /** False = managed (peers suspend it) but transforms never transmit. */
  syncTransform: boolean;
}

/** Wire form of one replicated entity: position, quaternion, animation clip. */
export interface NetWorldEntity {
  p: [number, number, number];
  q: [number, number, number, number];
  anim?: string;
}

interface PresencePlayer {
  position: [number, number, number];
  yaw: number;
  name: string;
  /** Last input sequence the host processed for this player (reconciliation). */
  seq?: number;
}

/** Host: a peer's latest movement command. */
interface RemoteInput {
  v: [number, number];
  jump: boolean;
  yaw: number;
  seq: number;
  /** Claimed position — used ONLY to spawn the proxy, never as authority. */
  p: [number, number, number];
  at: number;
}

interface RemoteTarget {
  position: THREE.Vector3;
  yaw: number;
  name: string;
  /** True = interpolated sample (set exactly); false = host-local (eased). */
  exact?: boolean;
}

interface RemoteAvatar {
  root: THREE.Group;
  capsule: THREE.Mesh<THREE.CapsuleGeometry, THREE.MeshStandardMaterial>;
  label: THREE.Sprite;
  texture: THREE.CanvasTexture;
}

type NetSignalDown =
  | { kind: "members"; room: string; members: string[]; host: string | null }
  | { kind: "signal"; room: string; from: string; to: string; data: unknown };

type RoomSignaling = SignalingChannel & { deliver(from: string, data: unknown): void };

const HOST_TICK_MS = 50; // 20 Hz snapshots (placeholder for the sim tick)
const CLIENT_SEND_MS = 50; // 20 Hz client input commands
const INPUT_STALE_MS = 2000; // no input this long = the peer stopped playing
const INTERP_DELAY_TICKS = 2; // render 100ms behind the newest snapshot

function isFiniteVec(v: unknown, len: number): v is number[] {
  return (
    Array.isArray(v) &&
    v.length === len &&
    v.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

function colorForPeer(peerId: string): THREE.Color {
  let hash = 0;
  for (let i = 0; i < peerId.length; i++) hash = (hash * 31 + peerId.charCodeAt(i)) >>> 0;
  return new THREE.Color().setHSL((hash % 360) / 360, 0.62, 0.55);
}

function makeLabel(name: string): { sprite: THREE.Sprite; texture: THREE.CanvasTexture } {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.font = "600 26px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const width = Math.min(244, ctx.measureText(name).width + 28);
  ctx.fillStyle = "rgba(11, 14, 20, 0.6)";
  ctx.beginPath();
  ctx.roundRect((256 - width) / 2, 8, width, 48, 12);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.fillText(name, 128, 33);
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthWrite: false }));
  sprite.scale.set(1.8, 0.45, 1);
  return { sprite, texture };
}

export class NetPresence {
  private readonly opts: NetPresenceOptions;
  private readonly enabled: boolean;
  private readonly selfId = `p-${Math.random().toString(36).slice(2, 10)}`;
  private readonly selfName = `guest-${this.selfId.slice(-4)}`;

  // room membership (signaling relay)
  private room: string | null = null;
  private members: string[] = [];
  private signaling: RoomSignaling | null = null;

  /**
   * Replicated session state (NetStateStore). Lives with the ROOM, not a
   * play session: peers hold a read-replica; a promoted host inherits the
   * replica's contents as its authoritative state (migration for free).
   * Cleared on room change, and by the app when starting a solo session.
   */
  readonly netState = new NetStateStore();

  // active P2P session
  private role: "host" | "peer" | "off" = "off";
  private sessionHost: string | null = null;
  private transport: Transport | null = null;
  /** How this tab is (or will be) linked: host listens on both at once. */
  private via: "rtc" | "relay" | "rtc+relay" | null = null;
  /** RTC diagnostics survive the merge wrapper (context bridge / HUD). */
  private rtcDiag: (() => Record<string, Record<string, string>>) | null = null;
  private relayTransport: Transport | null = null;
  private roomHost: RoomHost | null = null;
  private roomClient: RoomClient | null = null;
  private readonly sessionUnsubs: Array<() => void> = [];
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private sendTimer: ReturnType<typeof setInterval> | undefined;
  private fallbackTimer: ReturnType<typeof setInterval> | undefined;
  private tick = 0;
  /** Host only: each peer's latest movement command. */
  private readonly remoteInputs = new Map<string, RemoteInput>();
  private inputSeq = 0;
  /** Host only: this tick's replica states + each peer's interest view. */
  private lastReplicas: NetReplica[] | null = null;
  private readonly peerViews = new Map<string, Set<string>>();

  // rendering
  private readonly group = new THREE.Group();
  private readonly remotes = new Map<string, RemoteAvatar>();
  private targets = new Map<string, RemoteTarget>();

  // peer side: snapshot interpolation buffers (players + host-simulated NPCs)
  private readonly playersInterp = new TransformInterpolator();
  private readonly entitiesInterp = new TransformInterpolator();
  private clock: InterpolationClock | null = null; // per client session
  private lastRenderTick: number | null = null;
  private reportedPlaying = false;
  private replicatedKey = ""; // sorted id-set fingerprint, to detect set changes
  private replicatedNow: string[] = [];

  constructor(opts: NetPresenceOptions) {
    this.opts = opts;
    this.group.name = "netPresence";
    this.group.userData["netPresence"] = true;
    this.enabled = typeof import.meta.hot !== "undefined" && import.meta.hot != null;
    if (!this.enabled) return; // prod build: no signaling channel, presence is off
    import.meta.hot!.on("hitreg:net-signal", (payload: NetSignalDown) => {
      // relay callbacks must never throw back into vite's ws client
      try {
        this.handleNetSignal(payload);
      } catch (error) {
        console.warn("[net] signal handling failed:", error);
      }
    });
  }

  /** Re-call after every scene rebuild — re-parents the avatar group. */
  attach(scene: THREE.Scene): void {
    scene.add(this.group);
  }

  stats(): { role: "host" | "peer" | "off"; players: number; via: string | null } {
    if (this.role === "off") return { role: "off", players: 0, via: null };
    const self = this.opts.getLocalPlayer() ? 1 : 0;
    return { role: this.role, players: this.targets.size + self, via: this.via };
  }

  /** Full wiring state for the context bridge — lets AI sessions debug net remotely. */
  debug(): Record<string, unknown> {
    return {
      selfId: this.selfId,
      role: this.role,
      via: this.via,
      room: this.room,
      members: this.members.length,
      sessionHost: this.sessionHost,
      transportPeers: this.transport?.peers() ?? [],
      rtc: this.rtcDiag?.() ?? null,
      relayPeers: this.relayTransport?.peers() ?? null,
      clientState: this.roomClient?.state ?? null,
      hostRoomPeers: this.roomHost?.peers().map((p) => p.peerId) ?? null,
      inputsRecorded: [...this.remoteInputs.keys()],
      remoteTargets: [...this.targets.keys()],
      replicatedEntities: this.replicatedNow.length,
      // replication health: host replica count / peer ghost streams
      replicaCount: this.lastReplicas ? this.lastReplicas.length : null,
      netStateKeys: this.netState.keys().length,
      netStateAuthority: this.netState.isAuthority(),
      ghostStreams: this.entitiesInterp.ids().length,
      snapshotTick: this.entitiesInterp.newestTick() ?? this.playersInterp.newestTick(),
      renderTick: this.lastRenderTick === null ? null : Math.round(this.lastRenderTick * 10) / 10,
      localPlaying: this.opts.getLocalPlayer() !== null,
    };
  }

  update(dt: number): void {
    if (!this.enabled) return;
    const room = `scene:${this.opts.getSceneName()}`;
    if (room !== this.room) this.joinRoom(room);

    // report play-state flips — the relay elects the first PLAYING member
    // as host (the authority must be a tab that actually simulates)
    const playing = this.opts.getLocalPlayer() !== null;
    if (playing !== this.reportedPlaying && this.room) {
      this.reportedPlaying = playing;
      import.meta.hot?.send("hitreg:net-signal", {
        kind: "state",
        room: this.room,
        peerId: this.selfId,
        playing,
      });
    }

    // peer: advance the render clock and sample the interpolation buffers —
    // remote motion is a true interpolation between bracketing snapshots
    if (this.role === "peer" && this.clock) {
      const renderTick = this.clock.advance(dt);
      if (renderTick !== null) this.applyInterpolated(renderTick);
    }

    // reconcile avatars with the latest targets
    for (const [peerId, avatar] of this.remotes) {
      if (!this.targets.has(peerId)) {
        this.disposeAvatar(avatar);
        this.remotes.delete(peerId);
      }
    }
    const k = 1 - Math.exp(-12 * dt);
    for (const [peerId, target] of this.targets) {
      let avatar = this.remotes.get(peerId);
      if (!avatar) {
        avatar = this.createAvatar(peerId, target);
        this.remotes.set(peerId, avatar);
      }
      if (target.exact) {
        // interpolated sample IS the smoothing — apply it exactly
        avatar.root.position.copy(target.position);
        avatar.root.rotation.y = target.yaw;
      } else {
        // host-local targets refresh at the net tick — ease between refreshes
        avatar.root.position.lerp(target.position, k);
        const yawDelta = target.yaw - avatar.root.rotation.y;
        avatar.root.rotation.y += Math.atan2(Math.sin(yawDelta), Math.cos(yawDelta)) * k;
      }
    }
  }

  /** Peer: apply one interpolated frame — remote players and NPC ghosts. */
  private applyInterpolated(renderTick: number): void {
    this.lastRenderTick = renderTick;
    const players = this.playersInterp.sample(renderTick);
    const next = new Map<string, RemoteTarget>();
    for (const [peerId, s] of players) {
      next.set(peerId, {
        position: new THREE.Vector3(s.p[0], s.p[1], s.p[2]),
        yaw: s.yaw ?? 0,
        name: (s.data as { name?: string } | undefined)?.name ?? peerId,
        exact: true,
      });
    }
    const rosterChanged =
      next.size !== this.targets.size || [...next.keys()].some((id) => !this.targets.has(id));
    this.targets = next;
    if (rosterChanged) this.opts.onRosterChanged?.();

    for (const [id, s] of this.entitiesInterp.sample(renderTick)) {
      const object = this.opts.getEntityObject?.(id);
      if (!object) continue;
      object.position.set(s.p[0], s.p[1], s.p[2]);
      if (s.q) object.quaternion.set(s.q[0], s.q[1], s.q[2], s.q[3]);
      const anim = (s.data as { anim?: string } | undefined)?.anim;
      // applied every frame, NOT cached here: the animation system is the
      // source of truth (its play() no-ops on the current clip) — a cache
      // in this layer goes stale whenever the app's play session restarts
      if (anim) this.opts.setEntityAnim?.(id, anim);
    }
  }

  /** Ids the host currently simulates for us (peer side; empty otherwise). */
  replicatedIds(): string[] {
    return [...this.replicatedNow];
  }

  /** Host: fresh movement intents, for stepping the player proxy bodies. */
  activeRemoteInputs(): Array<{
    peerId: string;
    v: [number, number];
    jump: boolean;
    p: [number, number, number];
  }> {
    if (this.role !== "host") return [];
    const now = performance.now();
    const out: Array<{
      peerId: string;
      v: [number, number];
      jump: boolean;
      p: [number, number, number];
    }> = [];
    for (const [peerId, input] of this.remoteInputs) {
      if (now - input.at > INPUT_STALE_MS) continue;
      out.push({ peerId, v: input.v, jump: input.jump, p: input.p });
    }
    return out;
  }

  // -- room membership ---------------------------------------------------------

  private joinRoom(room: string): void {
    this.leaveRoom();
    this.room = room;
    this.netState.clear(); // session state belongs to the room we just left
    this.signaling = this.makeSignaling(room);
    import.meta.hot?.send("hitreg:net-signal", { kind: "join", room, peerId: this.selfId });
  }

  /**
   * Called by the app when a play session starts and this tab is alone in
   * the room — a fresh single-player run starts from clean session state.
   * With others present the state is the ROOM's; joining play must not
   * wipe it.
   */
  resetSessionStateIfSolo(): void {
    if (this.members.length <= 1) this.netState.clear();
  }

  private leaveRoom(): void {
    this.teardownSession();
    this.sessionHost = null;
    if (this.room) {
      import.meta.hot?.send("hitreg:net-signal", {
        kind: "leave",
        room: this.room,
        peerId: this.selfId,
      });
    }
    this.room = null;
    this.members = [];
    this.signaling = null;
  }

  private makeSignaling(room: string): RoomSignaling {
    const handlers = new Set<(from: string, data: unknown) => void>();
    const selfId = this.selfId;
    return {
      selfId,
      send(to, data) {
        import.meta.hot?.send("hitreg:net-signal", { kind: "signal", room, from: selfId, to, data });
      },
      onMessage(cb) {
        handlers.add(cb);
        return () => handlers.delete(cb);
      },
      deliver(from, data) {
        for (const cb of [...handlers]) cb(from, data);
      },
    };
  }

  private handleNetSignal(payload: NetSignalDown): void {
    if (!payload || typeof payload !== "object" || !this.room) return;
    if (payload.kind === "members") {
      if (payload.room !== this.room) return;
      this.members = payload.members ?? [];
      // dev server restarted and lost us? best-effort re-join (and re-report
      // play state on the next update — the relay's election needs it)
      if (!this.members.includes(this.selfId)) {
        import.meta.hot?.send("hitreg:net-signal", {
          kind: "join",
          room: this.room,
          peerId: this.selfId,
        });
        this.reportedPlaying = false;
      }
      const host = payload.host ?? null;
      if (host !== this.sessionHost) {
        if (this.sessionHost !== null) {
          console.log(`[net] host changed ${this.sessionHost} -> ${host ?? "none"} — reconnecting`);
        }
        this.teardownSession();
        this.sessionHost = host;
        if (host) this.startSession(host);
      }
      this.opts.onRosterChanged?.();
    } else if (payload.kind === "signal") {
      if (payload.room !== this.room || payload.to !== this.selfId) return;
      if (payload.from === this.selfId) return; // broadcast echo of our own send
      this.signaling?.deliver(payload.from, payload.data);
    }
  }

  // -- P2P session -------------------------------------------------------------

  private startSession(hostId: string): void {
    if (!this.signaling) return;
    try {
      if (hostId === this.selfId) this.startHost();
      else this.startClient(hostId);
    } catch (error) {
      console.warn("[net] failed to start session:", error);
      this.teardownSession();
    }
  }

  /** RTC lifecycle events go to the dev relay's ring buffer (net-debug endpoint). */
  private makeTrace(): (event: string, detail?: string) => void {
    return (event, detail) => {
      import.meta.hot?.send("hitreg:net-signal", {
        kind: "trace",
        peerId: this.selfId,
        event,
        detail,
      });
    };
  }

  private startHost(): void {
    // Listen on BOTH transports: each client connects over WebRTC when it
    // can, or the dev ws relay when its browser blocks RTC entirely.
    const rtc = new WebRtcHostTransport(this.signaling!, { trace: this.makeTrace() });
    const relay = new RelayHostTransport(this.signaling!, { trace: this.makeTrace() });
    const transport = mergeTransports([rtc, relay]);
    this.opts.onRoleChanged?.("host");
    // authority over session state — a promoted peer KEEPS its replica's
    // contents here: that is the host-migration state transfer
    this.netState.setAuthority(true);
    this.via = "rtc+relay";
    this.rtcDiag = () => rtc.linkStates();
    this.relayTransport = relay;
    const host = new RoomHost(transport, { snapshotEvery: 1 });
    this.transport = transport;
    this.roomHost = host;
    this.role = "host";
    this.sessionUnsubs.push(
      // commands carry movement INTENT — the host applies intentions, never state
      host.onCommand((peer, _tick, input) => this.recordInput(peer, input)),
      transport.onPeer((peer, state) => {
        if (state === "disconnected") {
          this.remoteInputs.delete(peer);
          this.peerViews.delete(peer);
        }
        this.opts.onRosterChanged?.();
      }),
    );
    // per-peer state: each peer gets its own VIEW of the replicated world
    host.setStateSource((peerId) => this.buildStateFor(peerId));
    // 20 Hz net tick — still a placeholder for the real fixed-tick sim loop.
    const prevRoster = new Map<string, string>();
    this.tickTimer = setInterval(() => {
      this.tick += 1;
      // roster deltas become replicated player.joined / player.left events
      const roster = new Map(host.peers().map((p) => [p.peerId, p.name]));
      for (const [peerId, name] of roster) {
        if (!prevRoster.has(peerId)) {
          this.opts.emitLocalEvent?.("player.joined", { peerId, name });
          // joiners get the full session state before any delta (reliable
          // channel is per-peer ordered, so this always lands first)
          host.sendStateTo(peerId, this.netState.snapshot());
        }
      }
      for (const peerId of prevRoster.keys()) {
        if (!roster.has(peerId)) this.opts.emitLocalEvent?.("player.left", { peerId });
      }
      prevRoster.clear();
      for (const [k, v] of roster) prevRoster.set(k, v);

      this.lastReplicas = this.opts.collectReplicas?.() ?? null;
      host.tick(this.tick);
      // replicate-flagged events delivered on the host bus this tick go out
      const outbox = this.opts.collectNetEvents?.() ?? [];
      if (outbox.length > 0) host.broadcastEvents(outbox);
      // session-state changes this tick ship as a reliable delta
      const stateDelta = this.netState.takeDelta();
      if (stateDelta) host.broadcastState(stateDelta);
      this.applyPlayers(this.buildPlayers()); // the host renders its own snapshot
    }, HOST_TICK_MS);
  }

  /**
   * Host: one peer's snapshot — authoritative players (same for everyone)
   * plus that peer's interest-managed slice of the replicated world:
   * `managed` (suspend-set), `updates` (in-view + due this tick), and
   * `removed` (just left the view — drop, freeze in place).
   */
  private buildStateFor(peerId?: string): unknown {
    const state: Record<string, unknown> = { players: this.buildPlayers() };
    if (!peerId) return state;
    const replicas = this.lastReplicas;
    if (!replicas) {
      // host not simulating (stopped play / edit mode): hand every ghost
      // back EXPLICITLY — omitting the key would leave peers suspended and
      // frozen forever
      const prev = this.peerViews.get(peerId);
      this.peerViews.delete(peerId);
      state["entities"] = { managed: [], updates: {}, removed: prev ? [...prev] : [] };
      return state;
    }
    const input = this.remoteInputs.get(peerId);
    const center = this.opts.getProxyState?.(peerId)?.p ?? input?.p ?? null;
    const prev = this.peerViews.get(peerId) ?? new Set<string>();
    const { view, entered, left } = computeView(center, replicas, prev);
    this.peerViews.set(peerId, view);
    const enteredSet = new Set(entered);
    const updates: Record<string, NetWorldEntity> = {};
    for (const r of replicas) {
      if (!view.has(r.id) || !r.syncTransform) continue;
      // entering entities always get a full update; the rest honor cadence
      if (!enteredSet.has(r.id) && !dueThisTick(r, this.tick)) continue;
      updates[r.id] = { p: r.p, q: r.q, ...(r.anim ? { anim: r.anim } : {}) };
    }
    state["entities"] = { managed: replicas.map((r) => r.id), updates, removed: left };
    return state;
  }

  private startClient(hostId: string): void {
    const transport = new WebRtcClientTransport(this.signaling!, hostId, {
      trace: this.makeTrace(),
    });
    this.via = "rtc";
    this.rtcDiag = () => transport.linkStates();
    this.wireClient(transport, hostId);

    // Watchdog: environments that block WebRTC UDP (privacy extensions,
    // Brave shields, firewalls) fail ICE within milliseconds and no scene
    // will EVER connect — detect it and re-dial over the dev ws relay.
    let checks = 0;
    this.fallbackTimer = setInterval(() => {
      if (this.transport !== transport || transport.peers().length > 0) {
        clearInterval(this.fallbackTimer);
        this.fallbackTimer = undefined;
        return; // session changed under us, or the RTC link opened — keep it
      }
      checks += 1;
      const state = transport.linkStates()[hostId]?.connection;
      const dead = state === "failed" || state === "closed";
      if (!dead && checks < 8) return; // still dialing — give a healthy link ~5s
      const reason = dead ? `rtc ${state}` : "rtc timeout";
      this.makeTrace()("relay-fallback", reason);
      console.warn(`[net] WebRTC could not connect (${reason}) — using the dev relay transport`);
      this.teardownSession();
      this.startClientRelay(hostId);
    }, 700);
  }

  /** Dev fallback path: same room protocol, transport is the signaling relay. */
  private startClientRelay(hostId: string): void {
    if (!this.signaling) return;
    const transport = new RelayClientTransport(this.signaling, hostId, {
      trace: this.makeTrace(),
    });
    this.via = "relay";
    this.relayTransport = transport;
    this.wireClient(transport, hostId);
  }

  private wireClient(transport: Transport, hostId: string): void {
    const client = new RoomClient(transport, hostId);
    this.transport = transport;
    this.roomClient = client;
    this.role = "peer";
    this.opts.onRoleChanged?.("peer");
    this.netState.setAuthority(false); // read-only replica while a host exists
    this.clock = new InterpolationClock({
      hz: 1000 / HOST_TICK_MS,
      delayTicks: INTERP_DELAY_TICKS,
    });
    this.sessionUnsubs.push(
      transport.onPeer((peer, state) => {
        if (peer !== hostId) return;
        if (state === "connected") client.join(this.selfName);
        if (state === "disconnected") {
          console.warn("[net] lost the host — waiting for a members update");
          this.targets = new Map();
          this.opts.onRosterChanged?.();
        }
      }),
      client.onSnapshot((snapshot) => this.ingestSnapshot(snapshot.tick, snapshot.state)),
      client.onEvents(({ events }) => this.opts.onNetEvents?.(events)),
      client.onState((sync) => this.netState.applyRemote(sync)),
    );
    // movement intent up at 20 Hz while playing — never a transform claim;
    // the host simulates a proxy from these and snapshots the result back.
    // Pending event requests (to-authority events) ride the same cadence.
    this.sendTimer = setInterval(() => {
      for (const e of this.opts.collectPeerEvents?.() ?? []) {
        client.sendCommand({ t: "event", name: e.name, payload: e.payload });
      }
      const local = this.opts.getLocalPlayer();
      if (!local) return;
      const input = this.opts.getLocalInput?.() ?? null;
      this.inputSeq += 1;
      client.sendCommand({
        t: "input",
        seq: this.inputSeq,
        v: input?.v ?? [0, 0],
        jump: input?.jump ?? false,
        yaw: local.yaw,
        p: local.position,
      });
    }, CLIENT_SEND_MS);
  }

  private teardownSession(): void {
    clearInterval(this.tickTimer);
    clearInterval(this.sendTimer);
    clearInterval(this.fallbackTimer);
    this.tickTimer = undefined;
    this.sendTimer = undefined;
    this.fallbackTimer = undefined;
    for (const unsub of this.sessionUnsubs.splice(0)) unsub();
    try {
      this.roomClient?.leave(); // bye rides the transport while it is still up
    } catch (error) {
      console.warn("[net] leave failed:", error);
    }
    this.roomClient = null;
    this.roomHost?.close();
    this.roomHost = null;
    this.transport?.close(); // merged host transport closes rtc AND relay
    this.transport = null;
    this.via = null;
    this.rtcDiag = null;
    this.relayTransport = null;
    this.remoteInputs.clear();
    this.lastReplicas = null;
    this.peerViews.clear();
    this.tick = 0;
    this.role = "off";
    this.opts.onRoleChanged?.("off");
    // no session = local authority; a former replica keeps its contents,
    // so a promotion right after this inherits the world's state
    this.netState.setAuthority(true);
    this.targets = new Map();
    this.opts.onRosterChanged?.();
    // hand every ghost back to the local sim and drop the buffers
    this.playersInterp.clear();
    this.entitiesInterp.clear();
    this.clock = null;
    this.lastRenderTick = null;
    if (this.replicatedKey !== "") {
      this.replicatedKey = "";
      this.replicatedNow = [];
      this.opts.onWorldEntities?.([]);
    }
  }

  // -- commands (host) -----------------------------------------------------------

  private recordInput(peer: string, input: unknown): void {
    const cmd = input as
      | { t?: unknown; seq?: unknown; v?: unknown; jump?: unknown; yaw?: unknown; p?: unknown }
      | null;
    // peer→authority event request: hand to the bus with sender attribution
    // (the bus enforces that only "to-authority" registered events pass)
    if (cmd?.t === "event") {
      const e = cmd as { name?: unknown; payload?: unknown };
      if (typeof e.name === "string") {
        this.opts.onPeerEvent?.(peer, [{ name: e.name, payload: e.payload }]);
      }
      return;
    }
    if (cmd?.t !== "input") return;
    const v = cmd.v;
    const p = cmd.p;
    if (!isFiniteVec(v, 2) || !isFiniteVec(p, 3)) return;
    this.remoteInputs.set(peer, {
      v: [v[0] as number, v[1] as number],
      jump: cmd.jump === true,
      yaw: typeof cmd.yaw === "number" && Number.isFinite(cmd.yaw) ? cmd.yaw : 0,
      seq: typeof cmd.seq === "number" && Number.isFinite(cmd.seq) ? cmd.seq : 0,
      p: [p[0] as number, p[1] as number, p[2] as number],
      at: performance.now(),
    });
  }

  /**
   * Host: authoritative player states — proxy-body positions for peers with
   * fresh inputs (falling back to their claimed position until the proxy
   * spawns), plus our own locally-simulated player.
   */
  private buildPlayers(): Record<string, PresencePlayer> {
    const players: Record<string, PresencePlayer> = {};
    if (this.roomHost) {
      const now = performance.now();
      for (const { peerId, name } of this.roomHost.peers()) {
        const input = this.remoteInputs.get(peerId);
        if (!input || now - input.at > INPUT_STALE_MS) continue; // not playing
        const proxy = this.opts.getProxyState?.(peerId);
        players[peerId] = {
          position: proxy?.p ?? input.p,
          yaw: input.yaw,
          name,
          seq: input.seq,
        };
      }
    }
    const local = this.opts.getLocalPlayer();
    if (local) {
      players[this.selfId] = { position: local.position, yaw: local.yaw, name: this.selfName };
    }
    return players;
  }

  // -- snapshots (peer) ------------------------------------------------------------

  /** Buffer a host snapshot for interpolation; reconcile our own player. */
  private ingestSnapshot(tick: number, state: unknown): void {
    const s = state as { players?: unknown; entities?: unknown } | null;
    const players = s?.players;
    if (!players || typeof players !== "object") return;
    this.clock?.onSnapshot(tick);

    const playerSnaps: Record<string, TransformSnap> = {};
    for (const [peerId, raw] of Object.entries(players)) {
      const p0 = (raw as { position?: unknown } | null)?.position;
      if (!isFiniteVec(p0, 3)) continue;
      const position: [number, number, number] = [
        p0[0] as number,
        p0[1] as number,
        p0[2] as number,
      ];
      if (peerId === this.selfId) {
        // the host's authoritative verdict on OUR predicted movement
        this.opts.reconcileLocalPlayer?.(position);
        continue;
      }
      const e = raw as { yaw?: unknown; name?: unknown };
      playerSnaps[peerId] = {
        p: position,
        yaw: typeof e.yaw === "number" && Number.isFinite(e.yaw) ? e.yaw : 0,
        data: { name: typeof e.name === "string" ? e.name : peerId },
      };
    }
    this.playersInterp.push(tick, playerSnaps);
    // the players map is complete every snapshot — absentees left the room
    const present = new Set(Object.keys(playerSnaps));
    for (const id of this.playersInterp.ids()) {
      if (!present.has(id)) this.playersInterp.remove(id);
    }

    const entities = s?.entities as
      | { managed?: unknown; updates?: unknown; removed?: unknown }
      | undefined;
    if (!entities || typeof entities !== "object") return;

    // updates: this peer's in-view slice, gated by per-entity cadence —
    // entities absent this snapshot simply carry forward in their streams
    const updates =
      entities.updates && typeof entities.updates === "object"
        ? (entities.updates as Record<string, unknown>)
        : {};
    const entitySnaps: Record<string, TransformSnap> = {};
    for (const [id, raw] of Object.entries(updates)) {
      const e = raw as { p?: unknown; q?: unknown; anim?: unknown } | null;
      if (!isFiniteVec(e?.p, 3) || !isFiniteVec(e?.q, 4)) continue;
      const p = e!.p as number[];
      const q = e!.q as number[];
      entitySnaps[id] = {
        p: [p[0]!, p[1]!, p[2]!],
        q: [q[0]!, q[1]!, q[2]!, q[3]!],
        data: typeof e!.anim === "string" ? { anim: e!.anim } : undefined,
      };
    }
    this.entitiesInterp.push(tick, entitySnaps);

    // removed: left our interest view — drop the stream (ghost freezes; it
    // stays suspended because it is still in the managed set)
    if (Array.isArray(entities.removed)) {
      for (const id of entities.removed) {
        if (typeof id === "string") this.entitiesInterp.remove(id);
      }
    }

    // managed SET changed → the app suspends/resumes local simulation
    const managed = Array.isArray(entities.managed)
      ? entities.managed.filter((x): x is string => typeof x === "string")
      : [];
    const key = [...managed].sort().join("\n");
    if (key !== this.replicatedKey) {
      this.replicatedKey = key;
      this.replicatedNow = managed;
      this.opts.onWorldEntities?.(managed);
    }
  }

  /** Replace the render targets from a players map; self is never rendered. */
  private applyPlayers(players: Record<string, unknown>): void {
    const next = new Map<string, RemoteTarget>();
    for (const [peerId, raw] of Object.entries(players)) {
      if (peerId === this.selfId) continue; // own player is the local sim's job
      const p = raw as { position?: unknown; yaw?: unknown; name?: unknown } | null;
      const pos = p?.position;
      if (
        !Array.isArray(pos) ||
        pos.length !== 3 ||
        pos.some((v) => typeof v !== "number" || !Number.isFinite(v))
      ) {
        continue;
      }
      next.set(peerId, {
        position: new THREE.Vector3(pos[0], pos[1], pos[2]),
        yaw: typeof p?.yaw === "number" && Number.isFinite(p.yaw) ? p.yaw : 0,
        name: typeof p?.name === "string" ? p.name : peerId,
      });
    }
    const rosterChanged =
      next.size !== this.targets.size || [...next.keys()].some((id) => !this.targets.has(id));
    this.targets = next;
    if (rosterChanged) this.opts.onRosterChanged?.();
  }

  // -- avatars ---------------------------------------------------------------------

  private createAvatar(peerId: string, target: RemoteTarget): RemoteAvatar {
    const root = new THREE.Group();
    root.name = `net:${target.name}`;
    root.userData["netPresence"] = true;
    const capsule = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.35, 0.9, 4, 16),
      new THREE.MeshStandardMaterial({ color: colorForPeer(peerId), roughness: 0.6 }),
    );
    const { sprite, texture } = makeLabel(target.name);
    sprite.position.y = 1.15;
    root.add(capsule, sprite);
    root.position.copy(target.position); // spawn in place — no lerp from origin
    root.rotation.y = target.yaw;
    this.group.add(root);
    return { root, capsule, label: sprite, texture };
  }

  private disposeAvatar(avatar: RemoteAvatar): void {
    this.group.remove(avatar.root);
    avatar.capsule.geometry.dispose();
    avatar.capsule.material.dispose();
    avatar.label.material.dispose();
    avatar.texture.dispose();
  }
}
