import * as THREE from "three/webgpu";
import {
  RoomClient,
  RoomHost,
  WebRtcClientTransport,
  WebRtcHostTransport,
  type SignalingChannel,
  type Transport,
} from "@hitreg/net";

/**
 * NetPresence — dev multiplayer presence for the playground.
 *
 * Tabs on the same scene auto-join room `scene:<name>` through the dev
 * server's websocket signaling relay (vite.config.ts), then talk P2P over
 * WebRTC data channels. The relay elects the FIRST joiner as host: it runs
 * a RoomHost, everyone else dials it as a RoomClient. Each tab reports its
 * play-mode player transform as a presence COMMAND (an intention — only the
 * host produces snapshots, per the net trust rule); the host folds those
 * plus its own player into 20 Hz snapshots. Remote players render as
 * colored capsules with floating name labels.
 *
 * This is presence, NOT the game sim: the 20 Hz setInterval host tick is a
 * placeholder that milestone 2 (sim integration) replaces with the real
 * fixed-tick loop feeding commands into @hitreg/core state. A host change
 * is handled crudely — tear everything down and re-dial the new host.
 *
 * No-ops entirely without import.meta.hot (prod builds have no signaling).
 */

export interface NetPresenceOptions {
  getSceneName(): string;
  /** The local play-mode player, or null when not playing. */
  getLocalPlayer(): { position: [number, number, number]; yaw: number } | null;
  onRosterChanged?: () => void;
}

interface PresencePlayer {
  position: [number, number, number];
  yaw: number;
  name: string;
}

interface RemoteTarget {
  position: THREE.Vector3;
  yaw: number;
  name: string;
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

const HOST_TICK_MS = 50; // 20 Hz presence snapshots (placeholder for the sim tick)
const CLIENT_SEND_MS = 66; // ~15 Hz client transform reports

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

  // active P2P session
  private role: "host" | "peer" | "off" = "off";
  private sessionHost: string | null = null;
  private transport: Transport | null = null;
  private roomHost: RoomHost | null = null;
  private roomClient: RoomClient | null = null;
  private readonly sessionUnsubs: Array<() => void> = [];
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private sendTimer: ReturnType<typeof setInterval> | undefined;
  private tick = 0;
  /** Host only: each peer's latest reported transform (from commands). */
  private readonly presences = new Map<string, { position: [number, number, number]; yaw: number }>();

  // rendering
  private readonly group = new THREE.Group();
  private readonly remotes = new Map<string, RemoteAvatar>();
  private targets = new Map<string, RemoteTarget>();

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

  stats(): { role: "host" | "peer" | "off"; players: number } {
    if (this.role === "off") return { role: "off", players: 0 };
    const self = this.opts.getLocalPlayer() ? 1 : 0;
    return { role: this.role, players: this.targets.size + self };
  }

  /** Full wiring state for the context bridge — lets AI sessions debug net remotely. */
  debug(): Record<string, unknown> {
    return {
      selfId: this.selfId,
      role: this.role,
      room: this.room,
      members: this.members.length,
      sessionHost: this.sessionHost,
      transportPeers: this.transport?.peers() ?? [],
      rtc:
        (this.transport as { linkStates?: () => Record<string, Record<string, string>> } | null)
          ?.linkStates?.() ?? null,
      clientState: this.roomClient?.state ?? null,
      hostRoomPeers: this.roomHost?.peers().map((p) => p.peerId) ?? null,
      presencesRecorded: [...this.presences.keys()],
      remoteTargets: [...this.targets.keys()],
      localPlaying: this.opts.getLocalPlayer() !== null,
    };
  }

  update(dt: number): void {
    if (!this.enabled) return;
    const room = `scene:${this.opts.getSceneName()}`;
    if (room !== this.room) this.joinRoom(room);

    // reconcile avatars with the latest targets, then ease toward them
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
      avatar.root.position.lerp(target.position, k);
      const yawDelta = target.yaw - avatar.root.rotation.y;
      avatar.root.rotation.y += Math.atan2(Math.sin(yawDelta), Math.cos(yawDelta)) * k;
    }
  }

  // -- room membership ---------------------------------------------------------

  private joinRoom(room: string): void {
    this.leaveRoom();
    this.room = room;
    this.signaling = this.makeSignaling(room);
    import.meta.hot?.send("hitreg:net-signal", { kind: "join", room, peerId: this.selfId });
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
      // dev server restarted and lost us? best-effort re-join
      if (!this.members.includes(this.selfId)) {
        import.meta.hot?.send("hitreg:net-signal", {
          kind: "join",
          room: this.room,
          peerId: this.selfId,
        });
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

  private startHost(): void {
    const transport = new WebRtcHostTransport(this.signaling!);
    const host = new RoomHost(transport, { snapshotEvery: 1 });
    this.transport = transport;
    this.roomHost = host;
    this.role = "host";
    this.sessionUnsubs.push(
      // presence is the command INPUT — the host applies intentions, never state
      host.onCommand((peer, _tick, input) => this.recordPresence(peer, input)),
      transport.onPeer((peer, state) => {
        if (state === "disconnected") this.presences.delete(peer);
        this.opts.onRosterChanged?.();
      }),
    );
    host.setStateSource(() => ({ players: this.buildPlayers() }));
    // 20 Hz presence tick — this is presence, not the game sim; milestone 2
    // replaces this interval with the real fixed-tick simulation loop.
    this.tickTimer = setInterval(() => {
      this.tick += 1;
      host.tick(this.tick);
      this.applyPlayers(this.buildPlayers()); // the host renders its own snapshot
    }, HOST_TICK_MS);
  }

  private startClient(hostId: string): void {
    const transport = new WebRtcClientTransport(this.signaling!, hostId);
    const client = new RoomClient(transport, hostId);
    this.transport = transport;
    this.roomClient = client;
    this.role = "peer";
    this.sessionUnsubs.push(
      transport.onPeer((peer, state) => {
        if (peer !== hostId) return;
        if (state === "connected") client.join(this.selfName);
        if (state === "disconnected") {
          console.warn("[net] lost the host — waiting for a members update");
          this.applyPlayers({});
        }
      }),
      client.onSnapshot((snapshot) => this.applySnapshotState(snapshot.state)),
    );
    // report our transform as an input command at ~15 Hz while playing
    this.sendTimer = setInterval(() => {
      const local = this.opts.getLocalPlayer();
      if (local) client.sendCommand({ t: "presence", position: local.position, yaw: local.yaw });
    }, CLIENT_SEND_MS);
  }

  private teardownSession(): void {
    clearInterval(this.tickTimer);
    clearInterval(this.sendTimer);
    this.tickTimer = undefined;
    this.sendTimer = undefined;
    for (const unsub of this.sessionUnsubs.splice(0)) unsub();
    try {
      this.roomClient?.leave(); // bye rides the transport while it is still up
    } catch (error) {
      console.warn("[net] leave failed:", error);
    }
    this.roomClient = null;
    this.roomHost?.close();
    this.roomHost = null;
    this.transport?.close();
    this.transport = null;
    this.presences.clear();
    this.tick = 0;
    this.role = "off";
    this.applyPlayers({});
  }

  // -- presence state ------------------------------------------------------------

  private recordPresence(peer: string, input: unknown): void {
    const cmd = input as { t?: unknown; position?: unknown; yaw?: unknown } | null;
    if (cmd?.t !== "presence") return;
    const p = cmd.position;
    if (
      !Array.isArray(p) ||
      p.length !== 3 ||
      p.some((v) => typeof v !== "number" || !Number.isFinite(v))
    ) {
      return;
    }
    const yaw = typeof cmd.yaw === "number" && Number.isFinite(cmd.yaw) ? cmd.yaw : 0;
    this.presences.set(peer, { position: [p[0], p[1], p[2]], yaw });
  }

  /** Host: joined peers that have reported a transform, plus our own player. */
  private buildPlayers(): Record<string, PresencePlayer> {
    const players: Record<string, PresencePlayer> = {};
    if (this.roomHost) {
      for (const { peerId, name } of this.roomHost.peers()) {
        const presence = this.presences.get(peerId);
        if (presence) players[peerId] = { ...presence, name };
      }
    }
    const local = this.opts.getLocalPlayer();
    if (local) {
      players[this.selfId] = { position: local.position, yaw: local.yaw, name: this.selfName };
    }
    return players;
  }

  private applySnapshotState(state: unknown): void {
    const players = (state as { players?: unknown } | null)?.players;
    if (!players || typeof players !== "object") return;
    this.applyPlayers(players as Record<string, unknown>);
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
