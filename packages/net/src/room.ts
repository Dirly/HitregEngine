/**
 * Room protocol — host/client session management on top of any Transport.
 *
 * Trust boundary, enforced structurally: RoomHost has NO code path that
 * applies state received from a client. Clients send `hello`, `command`,
 * and `bye` — anything else is dropped with a one-time warning. Only the
 * host produces `welcome` and `snapshot` messages.
 */

import type { Transport } from "./transport.js";
import {
  decodeMessage,
  encodeMessage,
  type ClientMessage,
  type Message,
} from "./protocol.js";

const DEFAULT_SNAPSHOT_EVERY = 3;

// -- RoomHost -----------------------------------------------------------------

export interface RoomHostOptions {
  /** Maximum simultaneous clients; further hellos are rejected. */
  maxPeers?: number;
  /** Broadcast a snapshot every N ticks (default 3). */
  snapshotEvery?: number;
}

export type CommandHandler = (peer: string, tick: number, input: unknown) => void;

interface HostPeer {
  name: string;
  lastSeq: number;
}

export class RoomHost {
  private readonly transport: Transport;
  private readonly maxPeers: number;
  private readonly snapshotEvery: number;
  private readonly joined = new Map<string, HostPeer>();
  private readonly commandHandlers = new Set<CommandHandler>();
  private readonly warned = new Set<string>();
  private readonly unsubscribes: Array<() => void> = [];
  private fullSource: ((peerId?: string) => unknown) | null = null;
  private deltaSource: ((baseTick: number, peerId?: string) => unknown) | null = null;
  private currentTick = 0;
  private lastSnapshotTick: number | null = null;
  private closed = false;

  constructor(transport: Transport, options: RoomHostOptions = {}) {
    this.transport = transport;
    this.maxPeers = options.maxPeers ?? Infinity;
    this.snapshotEvery = options.snapshotEvery ?? DEFAULT_SNAPSHOT_EVERY;
    this.unsubscribes.push(
      transport.onMessage((from, _channel, data) => this.handleMessage(from, data)),
      transport.onPeer((peer, state) => {
        if (state === "disconnected") this.removePeer(peer);
      }),
    );
  }

  /** Ids and names of currently joined clients. */
  peers(): Array<{ peerId: string; name: string }> {
    return [...this.joined].map(([peerId, p]) => ({ peerId, name: p.name }));
  }

  /**
   * Inject the authoritative state source. `full(peerId?)` produces a
   * complete snapshot (welcome + v1 snapshots) — when it uses the peerId,
   * each peer gets its own VIEW (interest management: entities transmit on
   * a need-to-know basis); ignore the argument for identical broadcasts.
   * `delta(baseTick, peerId?)` is the hook for delta encoding — wired now,
   * may simply return full state until the ECS-table milestone lands.
   */
  setStateSource(
    full: (peerId?: string) => unknown,
    delta?: (baseTick: number, peerId?: string) => unknown,
  ): void {
    this.fullSource = full;
    this.deltaSource = delta ?? null;
  }

  /** Subscribe to validated, deduplicated client commands. Returns unsubscribe. */
  onCommand(cb: CommandHandler): () => void {
    this.commandHandlers.add(cb);
    return () => this.commandHandlers.delete(cb);
  }

  /**
   * Replicate gameplay events to every joined peer, reliable-ordered.
   * (The authority's event bus collects replicate-flagged events per tick;
   * this ships them.) No-op with nothing to send or nobody to hear it.
   */
  broadcastEvents(events: Array<{ name: string; payload: unknown }>): void {
    if (this.closed || events.length === 0 || this.joined.size === 0) return;
    const packet = encodeMessage({ t: "events", tick: this.currentTick, events });
    for (const peerId of this.joined.keys()) {
      this.transport.send(peerId, "reliable", packet);
    }
  }

  /** Full session-state sync to one peer (joiner sync), reliable-ordered. */
  sendStateTo(peerId: string, full: Record<string, unknown>): void {
    if (this.closed || !this.joined.has(peerId)) return;
    this.transport.send(
      peerId,
      "reliable",
      encodeMessage({ t: "state", tick: this.currentTick, full }),
    );
  }

  /** Session-state delta to every joined peer, reliable-ordered. */
  broadcastState(delta: { set: Record<string, unknown>; removed: string[] }): void {
    if (this.closed || this.joined.size === 0) return;
    if (Object.keys(delta.set).length === 0 && delta.removed.length === 0) return;
    const packet = encodeMessage({ t: "state", tick: this.currentTick, delta });
    for (const peerId of this.joined.keys()) {
      this.transport.send(peerId, "reliable", packet);
    }
  }

  /**
   * Advance to tick `now`. Broadcasts a snapshot on the unreliable channel
   * every `snapshotEvery` ticks.
   */
  tick(now: number): void {
    if (this.closed) return;
    this.currentTick = now;
    if (now % this.snapshotEvery !== 0) return;
    if (this.joined.size === 0) return;
    // per-peer encode: state sources may return a different view per peer
    for (const peerId of this.joined.keys()) {
      let baseTick: number | null = null;
      let state: unknown;
      if (this.deltaSource !== null && this.lastSnapshotTick !== null) {
        baseTick = this.lastSnapshotTick;
        state = this.deltaSource(baseTick, peerId);
      } else {
        state = this.fullSource ? this.fullSource(peerId) : null;
      }
      this.transport.send(peerId, "unreliable", encodeMessage({ t: "snapshot", tick: now, baseTick, state }));
    }
    this.lastSnapshotTick = now;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const unsub of this.unsubscribes) unsub();
    this.joined.clear();
  }

  // -- internals --------------------------------------------------------------

  private handleMessage(from: string, data: Uint8Array): void {
    if (this.closed) return;
    const msg = decodeMessage(data);
    if (msg === null) return; // malformed — drop silently
    switch (msg.t) {
      case "hello":
        this.handleHello(from, msg.name);
        return;
      case "command":
        this.handleCommand(from, msg.tick, msg.seq, msg.input);
        return;
      case "bye":
        this.removePeer(from);
        return;
      default:
        // Host-only message types arriving FROM a client. There is no code
        // path that applies them — clients never dictate state.
        this.warnOnce(
          `RoomHost: dropped "${msg.t}" from client "${from}" — clients may only send hello/command/bye`,
        );
        return;
    }
  }

  private handleHello(from: string, name: string): void {
    if (this.joined.has(from)) return; // duplicate hello — already welcomed
    if (this.joined.size >= this.maxPeers) {
      this.transport.send(from, "reliable", encodeMessage({ t: "reject", reason: "room full" }));
      return;
    }
    // Replay the existing roster to the newcomer, then admit them.
    for (const [peerId, peer] of this.joined) {
      this.transport.send(
        from,
        "reliable",
        encodeMessage({ t: "peerJoined", peerId, name: peer.name }),
      );
    }
    this.joined.set(from, { name, lastSeq: 0 });
    this.transport.send(
      from,
      "reliable",
      encodeMessage({
        t: "welcome",
        peerId: from,
        tick: this.currentTick,
        full: this.fullSource ? this.fullSource(from) : null,
      }),
    );
    const joinedPacket = encodeMessage({ t: "peerJoined", peerId: from, name });
    for (const peerId of this.joined.keys()) {
      if (peerId !== from) this.transport.send(peerId, "reliable", joinedPacket);
    }
  }

  private handleCommand(from: string, tick: number, seq: number, input: unknown): void {
    const peer = this.joined.get(from);
    if (!peer) return; // commands before hello are dropped
    if (seq <= peer.lastSeq) return; // duplicate or reordered — drop
    peer.lastSeq = seq;
    for (const cb of [...this.commandHandlers]) cb(from, tick, input);
  }

  private removePeer(peerId: string): void {
    if (!this.joined.delete(peerId)) return;
    const packet = encodeMessage({ t: "peerLeft", peerId });
    for (const remaining of this.joined.keys()) {
      this.transport.send(remaining, "reliable", packet);
    }
  }

  private warnOnce(message: string): void {
    if (this.warned.has(message)) return;
    this.warned.add(message);
    console.warn(message);
  }
}

// -- RoomClient ---------------------------------------------------------------

export type RoomClientState = "connecting" | "joined" | "closed";

export interface RoomPeer {
  peerId: string;
  name: string;
}

export interface RoomSnapshot {
  tick: number;
  /** null = full state (the welcome's full state also arrives this way). */
  baseTick: number | null;
  state: unknown;
}

/** A batch of replicated gameplay events from the authority. */
export interface RoomEvents {
  tick: number;
  events: Array<{ name: string; payload: unknown }>;
}

/** A session-state sync from the authority (full replaces, delta merges). */
export interface RoomStateSync {
  tick: number;
  full?: Record<string, unknown>;
  delta?: { set: Record<string, unknown>; removed: string[] };
}

export interface RoomClientOptions {}

export class RoomClient {
  private readonly transport: Transport;
  private readonly hostId: string;
  private readonly snapshotHandlers = new Set<(snapshot: RoomSnapshot) => void>();
  private readonly eventsHandlers = new Set<(events: RoomEvents) => void>();
  private readonly stateHandlers = new Set<(sync: RoomStateSync) => void>();
  private readonly peersHandlers = new Set<(peers: RoomPeer[]) => void>();
  private readonly roster = new Map<string, string>(); // peerId -> name
  private readonly unsubscribes: Array<() => void> = [];
  private _state: RoomClientState = "connecting";
  private _peerId: string | null = null;
  private serverTick = 0;
  private seq = 0;

  constructor(transport: Transport, hostId: string, _options: RoomClientOptions = {}) {
    this.transport = transport;
    this.hostId = hostId;
    this.unsubscribes.push(
      transport.onMessage((from, _channel, data) => {
        if (from === this.hostId) this.handleMessage(data);
      }),
      transport.onPeer((peer, state) => {
        if (peer === this.hostId && state === "disconnected") this.shutdown();
      }),
    );
  }

  get state(): RoomClientState {
    return this._state;
  }

  /** Assigned by the host's welcome; null until joined. */
  get peerId(): string | null {
    return this._peerId;
  }

  /** Other clients currently in the room (never includes self or host). */
  peers(): RoomPeer[] {
    return [...this.roster].map(([peerId, name]) => ({ peerId, name }));
  }

  join(name: string): void {
    if (this._state === "closed") throw new Error("RoomClient: cannot join after close");
    this.send({ t: "hello", name });
  }

  /**
   * Send an input command (an intention — never state). Tick and seq are
   * stamped automatically. No-op unless joined.
   */
  sendCommand(input: unknown): void {
    if (this._state !== "joined") return;
    this.seq += 1;
    this.send({ t: "command", tick: this.serverTick, seq: this.seq, input });
  }

  onSnapshot(cb: (snapshot: RoomSnapshot) => void): () => void {
    this.snapshotHandlers.add(cb);
    return () => this.snapshotHandlers.delete(cb);
  }

  /** Subscribe to replicated gameplay events from the authority. */
  onEvents(cb: (events: RoomEvents) => void): () => void {
    this.eventsHandlers.add(cb);
    return () => this.eventsHandlers.delete(cb);
  }

  /** Subscribe to session-state syncs from the authority. */
  onState(cb: (sync: RoomStateSync) => void): () => void {
    this.stateHandlers.add(cb);
    return () => this.stateHandlers.delete(cb);
  }

  onPeers(cb: (peers: RoomPeer[]) => void): () => void {
    this.peersHandlers.add(cb);
    return () => this.peersHandlers.delete(cb);
  }

  leave(): void {
    if (this._state === "closed") return;
    this.send({ t: "bye" });
    this.shutdown();
  }

  // -- internals --------------------------------------------------------------

  private send(message: ClientMessage): void {
    this.transport.send(this.hostId, "reliable", encodeMessage(message));
  }

  private handleMessage(data: Uint8Array): void {
    if (this._state === "closed") return;
    const msg: Message | null = decodeMessage(data);
    if (msg === null) return;
    switch (msg.t) {
      case "welcome":
        this._state = "joined";
        this._peerId = msg.peerId;
        this.serverTick = msg.tick;
        this.emitSnapshot({ tick: msg.tick, baseTick: null, state: msg.full });
        return;
      case "snapshot":
        if (this._state !== "joined") return;
        this.serverTick = msg.tick;
        this.emitSnapshot({ tick: msg.tick, baseTick: msg.baseTick, state: msg.state });
        return;
      case "events":
        if (this._state !== "joined") return;
        for (const cb of [...this.eventsHandlers]) cb({ tick: msg.tick, events: msg.events });
        return;
      case "state": {
        if (this._state !== "joined") return;
        const sync: RoomStateSync = { tick: msg.tick };
        if (msg.full) sync.full = msg.full;
        if (msg.delta) sync.delta = msg.delta;
        for (const cb of [...this.stateHandlers]) cb(sync);
        return;
      }
      case "peerJoined":
        this.roster.set(msg.peerId, msg.name);
        this.emitPeers();
        return;
      case "peerLeft":
        if (this.roster.delete(msg.peerId)) this.emitPeers();
        return;
      case "reject":
        this.shutdown();
        return;
      default:
        return; // client-only message types from the host — nonsense, drop
    }
  }

  private emitSnapshot(snapshot: RoomSnapshot): void {
    for (const cb of [...this.snapshotHandlers]) cb(snapshot);
  }

  private emitPeers(): void {
    const peers = this.peers();
    for (const cb of [...this.peersHandlers]) cb(peers);
  }

  private shutdown(): void {
    if (this._state === "closed") return;
    this._state = "closed";
    for (const unsub of this.unsubscribes) unsub();
    this.roster.clear();
  }
}
