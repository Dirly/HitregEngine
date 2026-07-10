/**
 * Transport abstraction — the bottom layer of the networking stack.
 *
 *   simulation → replication protocol → transport
 *
 * The simulation must never know which transport carries its packets.
 * Everything above this file speaks in peers, channels, and Uint8Array
 * payloads; whether those bytes travel over WebRTC data channels, a
 * WebSocket relay, WebTransport, or an in-memory loopback is a deployment
 * choice.
 */

export type Channel = "reliable" | "unreliable";

export type PeerState = "connected" | "disconnected";

export interface Transport {
  /** This endpoint's peer id (unique within the session). */
  readonly localId: string;
  /** Ids of all currently connected remote peers. */
  peers(): string[];
  /** Send to a single peer. Unknown/disconnected peers are silently dropped. */
  send(peer: string, channel: Channel, data: Uint8Array): void;
  /** Send to every connected remote peer (never echoes to self). */
  broadcast(channel: Channel, data: Uint8Array): void;
  /** Subscribe to incoming messages. Returns an unsubscribe function. */
  onMessage(cb: (from: string, channel: Channel, data: Uint8Array) => void): () => void;
  /** Subscribe to peer connect/disconnect events. Returns an unsubscribe function. */
  onPeer(cb: (peer: string, state: PeerState) => void): () => void;
  /** Disconnect from the session. Remote peers observe a "disconnected" event. */
  close(): void;
}

/**
 * Deterministic drop control for the unreliable channel. Either a boolean
 * pattern that is cycled per delivery attempt (`[false, false, true]` drops
 * every third unreliable delivery) or a predicate over a 1-based delivery
 * counter. Math.random is deliberately not an option.
 */
export type DropRule = boolean[] | ((deliveryCount: number) => boolean);

export interface LoopbackHubOptions {
  /**
   * When true, nothing is delivered until `hub.flush()` is called — an
   * artificial-latency mode for deterministic tests. When false (default),
   * delivery is queued on a microtask so senders never observe synchronous
   * receipt (the same code paths a real network forces).
   */
  manualFlush?: boolean;
  /** Applied to unreliable-channel deliveries only. Reliable never drops. */
  drop?: DropRule;
}

type Thunk = () => void;

/**
 * In-memory hub connecting any number of peers. Used for single-player
 * (host and client in one process) and tests; it is also the reference
 * behavior for future WebRTC/WebSocket/WebTransport adapters.
 */
export class LoopbackHub {
  private readonly peersById = new Map<string, LoopbackPeer>();
  private readonly queue: Thunk[] = [];
  private readonly manualFlush: boolean;
  private readonly drop?: DropRule;
  private deliveryCount = 0;
  private flushing = false;

  constructor(options: LoopbackHubOptions = {}) {
    this.manualFlush = options.manualFlush ?? false;
    this.drop = options.drop;
  }

  /** Attach a new peer with the given id. Ids must be unique per hub. */
  connect(id: string): Transport {
    if (this.peersById.has(id)) {
      throw new Error(`LoopbackHub: peer id "${id}" is already connected`);
    }
    const peer = new LoopbackPeer(this, id);
    // Notify existing peers of the newcomer (async, like a real network).
    for (const other of this.peersById.values()) {
      this.enqueue(() => other.dispatchPeer(id, "connected"));
    }
    this.peersById.set(id, peer);
    return peer;
  }

  /**
   * Deliver everything queued, including messages enqueued by handlers that
   * run during the flush (loops until the queue drains). No-op unless the
   * hub was created with `manualFlush: true` (otherwise the queue is always
   * empty — microtasks drain it).
   */
  flush(): void {
    if (this.flushing) return; // handlers calling flush() re-entrantly
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const thunk = this.queue.shift()!;
        thunk();
      }
    } finally {
      this.flushing = false;
    }
  }

  // -- internal (used by LoopbackPeer) ------------------------------------

  peerIds(exclude: string): string[] {
    return [...this.peersById.keys()].filter((id) => id !== exclude);
  }

  route(from: string, to: string, channel: Channel, data: Uint8Array): void {
    if (channel === "unreliable" && this.shouldDrop()) return;
    const copy = data.slice(); // no aliasing between sender and receiver
    this.enqueue(() => {
      const target = this.peersById.get(to);
      if (target) target.dispatchMessage(from, channel, copy);
    });
  }

  disconnect(id: string): void {
    if (!this.peersById.delete(id)) return;
    for (const other of this.peersById.values()) {
      this.enqueue(() => other.dispatchPeer(id, "disconnected"));
    }
  }

  private enqueue(thunk: Thunk): void {
    if (this.manualFlush) {
      this.queue.push(thunk);
    } else {
      queueMicrotask(thunk);
    }
  }

  private shouldDrop(): boolean {
    if (!this.drop) return false;
    this.deliveryCount += 1;
    if (typeof this.drop === "function") return this.drop(this.deliveryCount);
    if (this.drop.length === 0) return false;
    return this.drop[(this.deliveryCount - 1) % this.drop.length] === true;
  }
}

class LoopbackPeer implements Transport {
  readonly localId: string;
  private readonly hub: LoopbackHub;
  private readonly messageHandlers = new Set<
    (from: string, channel: Channel, data: Uint8Array) => void
  >();
  private readonly peerHandlers = new Set<(peer: string, state: PeerState) => void>();
  private closed = false;

  constructor(hub: LoopbackHub, id: string) {
    this.hub = hub;
    this.localId = id;
  }

  peers(): string[] {
    if (this.closed) return [];
    return this.hub.peerIds(this.localId);
  }

  send(peer: string, channel: Channel, data: Uint8Array): void {
    if (this.closed) throw new Error(`LoopbackHub: peer "${this.localId}" is closed`);
    if (peer === this.localId) return;
    this.hub.route(this.localId, peer, channel, data);
  }

  broadcast(channel: Channel, data: Uint8Array): void {
    if (this.closed) throw new Error(`LoopbackHub: peer "${this.localId}" is closed`);
    for (const peer of this.hub.peerIds(this.localId)) {
      this.hub.route(this.localId, peer, channel, data);
    }
  }

  onMessage(cb: (from: string, channel: Channel, data: Uint8Array) => void): () => void {
    this.messageHandlers.add(cb);
    return () => this.messageHandlers.delete(cb);
  }

  onPeer(cb: (peer: string, state: PeerState) => void): () => void {
    this.peerHandlers.add(cb);
    return () => this.peerHandlers.delete(cb);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.hub.disconnect(this.localId);
  }

  // -- internal (called by the hub at delivery time) -----------------------

  dispatchMessage(from: string, channel: Channel, data: Uint8Array): void {
    if (this.closed) return; // queued before close — a real network drops these too
    for (const cb of [...this.messageHandlers]) cb(from, channel, data);
  }

  dispatchPeer(peer: string, state: PeerState): void {
    if (this.closed) return;
    for (const cb of [...this.peerHandlers]) cb(peer, state);
  }
}
