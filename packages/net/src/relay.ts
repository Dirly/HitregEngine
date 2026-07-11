/**
 * Relay transport — Transport over a SignalingChannel.
 *
 * The dev fallback for environments where WebRTC cannot connect at all
 * (privacy extensions / Brave shields / firewalls that block non-proxied
 * UDP): every payload rides the same message relay that normally only
 * carries SDP/ICE envelopes. Latency and fan-out costs are what they are —
 * this is a DEV transport; production peers use WebRTC or a real
 * WebSocket/WebTransport edge (ARCHITECTURE §3a keeps transports swappable
 * for exactly this reason).
 *
 * It deliberately shares the signaling channel with the WebRTC transports:
 * relay envelopes are invisible to them (`parseRtcSignal` returns null) and
 * RTC envelopes are invisible here, so a host can listen on BOTH transports
 * at once (see `mergeTransports`) while each client picks whichever works.
 *
 * Wire envelopes (JSON over the relay):
 *   { relay: "hello", name? }   client dials the host (re-sent until welcomed)
 *   { relay: "welcome" }        host accepts — both sides now "connected"
 *   { relay: "bye" }            graceful close, either direction
 *   { relay: "data", channel: "reliable"|"unreliable", b64: string }
 *
 * The relay delivers everything in order and never drops, so the channel
 * distinction is semantic only here (upper layers still choose per-message).
 */

import type { Channel, PeerState, Transport } from "./transport.js";
import type { SignalingChannel } from "./webrtc.js";

export interface RelayTransportOptions {
  /** Lifecycle tap for debugging (event name + short detail). Never throws. */
  trace?: (event: string, detail?: string) => void;
  /** Client only: ms between hello retries until welcomed (default 1000). */
  helloIntervalMs?: number;
  /** Client only: give up dialing after this many hellos (default 15). */
  helloAttempts?: number;
}

// -- envelope ----------------------------------------------------------------

export type RelaySignal =
  | { relay: "hello" }
  | { relay: "welcome" }
  | { relay: "bye" }
  | { relay: "data"; channel: Channel; b64: string };

/** Validate an incoming relay payload; null for anything else (incl. RTC). */
export function parseRelaySignal(data: unknown): RelaySignal | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const msg = data as Record<string, unknown>;
  switch (msg.relay) {
    case "hello":
    case "welcome":
    case "bye":
      return { relay: msg.relay };
    case "data":
      return (msg.channel === "reliable" || msg.channel === "unreliable") &&
        typeof msg.b64 === "string"
        ? { relay: "data", channel: msg.channel, b64: msg.b64 }
        : null;
    default:
      return null;
  }
}

// -- base64 (browser atob/btoa or Node Buffer — whichever exists) -------------

const NodeBuffer = (
  globalThis as { Buffer?: { from(x: unknown, e?: string): { toString(e: string): string } } }
).Buffer;

export function bytesToB64(data: Uint8Array): string {
  if (NodeBuffer) return NodeBuffer.from(data).toString("base64");
  let s = "";
  for (let i = 0; i < data.length; i++) s += String.fromCharCode(data[i]!);
  return btoa(s);
}

const B64_SHAPE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function b64ToBytes(b64: string): Uint8Array | null {
  // Node's Buffer decodes garbage leniently; validate the shape explicitly
  // so malformed relay payloads drop identically in every environment.
  if (!B64_SHAPE.test(b64)) return null;
  try {
    if (NodeBuffer) return new Uint8Array(NodeBuffer.from(b64, "base64") as unknown as Uint8Array);
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  } catch {
    return null; // malformed base64 from the shared relay — drop, never throw
  }
}

// -- shared plumbing -----------------------------------------------------------

abstract class RelayTransportBase implements Transport {
  readonly localId: string;
  protected readonly signaling: SignalingChannel;
  protected readonly unsubSignal: () => void;
  protected readonly trace: (event: string, detail?: string) => void;
  protected closed = false;
  private readonly messageHandlers = new Set<
    (from: string, channel: Channel, data: Uint8Array) => void
  >();
  private readonly peerHandlers = new Set<(peer: string, state: PeerState) => void>();

  constructor(signaling: SignalingChannel, options: RelayTransportOptions) {
    this.localId = signaling.selfId;
    this.signaling = signaling;
    this.trace = options.trace ?? (() => undefined);
    this.unsubSignal = signaling.onMessage((from, data) => {
      // relay callbacks must never throw back into the signaling client
      try {
        const signal = parseRelaySignal(data);
        if (signal !== null) this.handleSignal(from, signal);
      } catch (error) {
        console.warn(`[relay] message from "${from}" failed:`, error);
      }
    });
  }

  protected abstract handleSignal(from: string, signal: RelaySignal): void;
  abstract peers(): string[];
  abstract send(peer: string, channel: Channel, data: Uint8Array): void;
  abstract close(): void;

  broadcast(channel: Channel, data: Uint8Array): void {
    for (const peer of this.peers()) this.send(peer, channel, data);
  }

  onMessage(cb: (from: string, channel: Channel, data: Uint8Array) => void): () => void {
    this.messageHandlers.add(cb);
    return () => this.messageHandlers.delete(cb);
  }

  onPeer(cb: (peer: string, state: PeerState) => void): () => void {
    this.peerHandlers.add(cb);
    return () => this.peerHandlers.delete(cb);
  }

  protected sendData(to: string, channel: Channel, data: Uint8Array): void {
    this.signaling.send(to, {
      relay: "data",
      channel,
      b64: bytesToB64(data),
    } satisfies RelaySignal);
  }

  protected dispatchData(from: string, signal: RelaySignal & { relay: "data" }): void {
    const bytes = b64ToBytes(signal.b64);
    if (bytes === null) return;
    if (this.closed) return;
    for (const cb of [...this.messageHandlers]) cb(from, signal.channel, bytes);
  }

  protected dispatchPeer(peer: string, state: PeerState): void {
    if (this.closed) return;
    for (const cb of [...this.peerHandlers]) cb(peer, state);
  }
}

// -- host ------------------------------------------------------------------------

/** Accepts a hello from every joining peer (mirror of WebRtcHostTransport). */
export class RelayHostTransport extends RelayTransportBase {
  private readonly connected = new Set<string>();

  constructor(signaling: SignalingChannel, options: RelayTransportOptions = {}) {
    super(signaling, options);
  }

  peers(): string[] {
    return [...this.connected];
  }

  send(peer: string, channel: Channel, data: Uint8Array): void {
    if (this.closed || !this.connected.has(peer)) return;
    this.sendData(peer, channel, data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubSignal();
    for (const peer of this.connected) {
      this.signaling.send(peer, { relay: "bye" } satisfies RelaySignal);
    }
    this.connected.clear();
  }

  protected handleSignal(from: string, signal: RelaySignal): void {
    if (this.closed || from === this.localId) return;
    switch (signal.relay) {
      case "hello": {
        // welcome is idempotent — hello retries must not double-connect
        const isNew = !this.connected.has(from);
        this.connected.add(from);
        this.signaling.send(from, { relay: "welcome" } satisfies RelaySignal);
        if (isNew) {
          this.trace("relay-peer", from);
          this.dispatchPeer(from, "connected");
        }
        return;
      }
      case "bye":
        if (this.connected.delete(from)) this.dispatchPeer(from, "disconnected");
        return;
      case "data":
        if (this.connected.has(from)) this.dispatchData(from, signal);
        return;
      case "welcome":
        return; // host never dials — stray
    }
  }
}

// -- client ----------------------------------------------------------------------

/** Dials the host with retried hellos; its only peer is the host. */
export class RelayClientTransport extends RelayTransportBase {
  private readonly hostId: string;
  private connectedToHost = false;
  private helloTimer: ReturnType<typeof setInterval> | undefined;

  constructor(signaling: SignalingChannel, hostId: string, options: RelayTransportOptions = {}) {
    super(signaling, options);
    this.hostId = hostId;
    const interval = options.helloIntervalMs ?? 1000;
    let attempts = options.helloAttempts ?? 15;
    const hello = () => {
      if (this.closed || this.connectedToHost) return;
      if (attempts-- <= 0) {
        this.stopHello();
        this.trace("relay-give-up", this.hostId);
        return;
      }
      this.trace("relay-hello", this.hostId);
      this.signaling.send(this.hostId, { relay: "hello" } satisfies RelaySignal);
    };
    hello(); // dial immediately, then retry until welcomed (host may be slow to listen)
    this.helloTimer = setInterval(hello, interval);
  }

  peers(): string[] {
    return this.connectedToHost && !this.closed ? [this.hostId] : [];
  }

  send(peer: string, channel: Channel, data: Uint8Array): void {
    if (this.closed || peer !== this.hostId || !this.connectedToHost) return;
    this.sendData(peer, channel, data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopHello();
    this.unsubSignal();
    if (this.connectedToHost) {
      this.signaling.send(this.hostId, { relay: "bye" } satisfies RelaySignal);
    }
    this.connectedToHost = false;
  }

  protected handleSignal(from: string, signal: RelaySignal): void {
    if (this.closed || from !== this.hostId) return;
    switch (signal.relay) {
      case "welcome":
        if (this.connectedToHost) return; // duplicate welcome (hello retry crossed it)
        this.connectedToHost = true;
        this.stopHello();
        this.trace("relay-open", this.hostId);
        this.dispatchPeer(this.hostId, "connected");
        return;
      case "bye":
        if (!this.connectedToHost) return;
        this.connectedToHost = false;
        this.dispatchPeer(this.hostId, "disconnected");
        return;
      case "data":
        if (this.connectedToHost) this.dispatchData(from, signal);
        return;
      case "hello":
        return; // clients don't accept dials — stray
    }
  }

  private stopHello(): void {
    clearInterval(this.helloTimer);
    this.helloTimer = undefined;
  }
}
