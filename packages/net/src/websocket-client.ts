/**
 * WebSocket transport — the dedicated-server transport (ARCHITECTURE §3a's
 * "WebSocket: universal fallback", promoted to the primary edge for hosted
 * worlds, where UDP is unavailable anyway).
 *
 * Both channels ride one TCP socket, so "unreliable" is a semantic: the host
 * side DROPS an unreliable send when the socket is backed up instead of
 * queueing stale snapshots behind fresher ones. Reliable sends always queue.
 *
 * Wire format (shared by client and server):
 *   text frame   — handshake JSON: {"ws":"hello","peerId"} up, {"ws":"welcome","peerId"} down
 *   binary frame — 1 byte channel tag (0 reliable, 1 unreliable) + the protocol payload
 *
 * The server's id is the constant {@link WS_HOST_ID}: a RoomClient needs the
 * host id before the socket opens, and a dedicated server is never one of
 * several peers. The CLIENT proposes its own id (so the tab's identity stays
 * stable across reconnects); the server may answer with a different one if
 * it collides — read `localId` after the host reports "connected".
 *
 * This file is browser-safe. The host half lives in `websocket-server.ts`
 * (`@hitreg/net/server`) because it imports `ws`.
 */

import type { Channel, PeerState, Transport } from "./transport.js";

export const WS_HOST_ID = "server";

export const WS_CHANNEL_RELIABLE = 0;
export const WS_CHANNEL_UNRELIABLE = 1;

export type WsHandshake =
  | { ws: "hello"; peerId: string; name?: string }
  | { ws: "welcome"; peerId: string }
  | { ws: "reject"; reason: string };

const PEER_ID_SHAPE = /^[A-Za-z0-9_-]{3,64}$/;

export function parseWsHandshake(text: string): WsHandshake | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const m = value as Record<string, unknown>;
  switch (m.ws) {
    case "hello":
      if (typeof m.peerId !== "string" || !PEER_ID_SHAPE.test(m.peerId)) return null;
      return {
        ws: "hello",
        peerId: m.peerId,
        ...(typeof m.name === "string" ? { name: m.name.slice(0, 32) } : {}),
      };
    case "welcome":
      return typeof m.peerId === "string" && PEER_ID_SHAPE.test(m.peerId)
        ? { ws: "welcome", peerId: m.peerId }
        : null;
    case "reject":
      return typeof m.reason === "string" ? { ws: "reject", reason: m.reason } : null;
    default:
      return null;
  }
}

export function frameData(channel: Channel, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + data.length);
  out[0] = channel === "reliable" ? WS_CHANNEL_RELIABLE : WS_CHANNEL_UNRELIABLE;
  out.set(data, 1);
  return out;
}

export function unframeData(frame: Uint8Array): { channel: Channel; data: Uint8Array } | null {
  if (frame.length < 1) return null;
  const tag = frame[0];
  if (tag !== WS_CHANNEL_RELIABLE && tag !== WS_CHANNEL_UNRELIABLE) return null;
  return { channel: tag === WS_CHANNEL_RELIABLE ? "reliable" : "unreliable", data: frame.subarray(1) };
}

/** The slice of the WebSocket API both browsers and `ws` implement. */
export interface WebSocketLike {
  binaryType: string;
  readyState: number;
  bufferedAmount: number;
  send(data: string | ArrayBufferLike | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", cb: () => void): void;
  addEventListener(type: "close", cb: (ev: { code: number; reason: string }) => void): void;
  addEventListener(type: "error", cb: (ev: unknown) => void): void;
  addEventListener(type: "message", cb: (ev: { data: unknown }) => void): void;
}

export interface WebSocketClientTransportOptions {
  /** Proposed peer id (default: random `p-xxxxxxxx`). */
  peerId?: string;
  /** Display name carried in the handshake (the room `hello` carries the real one). */
  name?: string;
  /** WebSocket constructor to use (default: `globalThis.WebSocket`). */
  WebSocket?: new (url: string) => WebSocketLike;
  /** Lifecycle tap for debugging. Never throws. */
  trace?: (event: string, detail?: string) => void;
}

export function randomPeerId(): string {
  return `p-${Math.random().toString(36).slice(2, 10)}`;
}

/** Decode a message-event payload (ArrayBuffer / Buffer / Blob-less) to bytes. */
function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (Array.isArray(data)) {
    // `ws` may deliver fragmented binary messages as Buffer[]
    let total = 0;
    for (const part of data as ArrayBufferView[]) total += part.byteLength;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of data as ArrayBufferView[]) {
      out.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength), offset);
      offset += part.byteLength;
    }
    return out;
  }
  return null;
}

/**
 * Dials a dedicated server. Its only peer is {@link WS_HOST_ID}; the host is
 * reported "connected" once the server's welcome lands (so `localId` is final
 * by then) and "disconnected" when the socket closes for any reason.
 */
export class WebSocketClientTransport implements Transport {
  private _localId: string;
  private readonly socket: WebSocketLike;
  private readonly trace: (event: string, detail?: string) => void;
  private readonly messageHandlers = new Set<
    (from: string, channel: Channel, data: Uint8Array) => void
  >();
  private readonly peerHandlers = new Set<(peer: string, state: PeerState) => void>();
  private welcomed = false;
  private closed = false;

  constructor(url: string, options: WebSocketClientTransportOptions = {}) {
    this._localId = options.peerId ?? randomPeerId();
    this.trace = options.trace ?? (() => undefined);
    const Ctor =
      options.WebSocket ??
      ((globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket as
        | (new (url: string) => WebSocketLike)
        | undefined);
    if (!Ctor) throw new Error("WebSocketClientTransport: no WebSocket implementation available");
    this.socket = new Ctor(url);
    this.socket.binaryType = "arraybuffer";
    this.socket.addEventListener("open", () => {
      this.trace("ws-open", url);
      const hello: WsHandshake = {
        ws: "hello",
        peerId: this._localId,
        ...(options.name ? { name: options.name } : {}),
      };
      this.socket.send(JSON.stringify(hello));
    });
    this.socket.addEventListener("message", (ev) => {
      try {
        this.handleMessage(ev.data);
      } catch (error) {
        console.warn("[ws] message handling failed:", error);
      }
    });
    this.socket.addEventListener("close", (ev) => {
      this.trace("ws-close", `${ev.code} ${ev.reason}`);
      this.onSocketGone();
    });
    this.socket.addEventListener("error", () => {
      this.trace("ws-error");
      // a close event follows; nothing to do here — but never throw
    });
  }

  get localId(): string {
    return this._localId;
  }

  peers(): string[] {
    return this.welcomed && !this.closed ? [WS_HOST_ID] : [];
  }

  send(peer: string, channel: Channel, data: Uint8Array): void {
    if (this.closed || !this.welcomed || peer !== WS_HOST_ID) return;
    if (this.socket.readyState !== 1) return;
    this.socket.send(frameData(channel, data));
  }

  broadcast(channel: Channel, data: Uint8Array): void {
    this.send(WS_HOST_ID, channel, data);
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
    try {
      this.socket.close(1000, "bye");
    } catch {
      // already closed — fine
    }
    if (this.welcomed) {
      this.welcomed = false;
      for (const cb of [...this.peerHandlers]) cb(WS_HOST_ID, "disconnected");
    }
  }

  private handleMessage(data: unknown): void {
    if (this.closed) return;
    if (typeof data === "string") {
      const hs = parseWsHandshake(data);
      if (!hs) return;
      if (hs.ws === "welcome") {
        if (this.welcomed) return;
        this._localId = hs.peerId;
        this.welcomed = true;
        this.trace("ws-welcome", hs.peerId);
        for (const cb of [...this.peerHandlers]) cb(WS_HOST_ID, "connected");
      } else if (hs.ws === "reject") {
        this.trace("ws-reject", hs.reason);
        console.warn(`[ws] server rejected the connection: ${hs.reason}`);
        this.close();
      }
      return;
    }
    if (!this.welcomed) return; // data before welcome — the server never does this
    const bytes = toBytes(data);
    if (!bytes) return;
    const frame = unframeData(bytes);
    if (!frame) return;
    // copy: the ArrayBuffer behind a message event may be reused by the runtime
    const payload = frame.data.slice();
    for (const cb of [...this.messageHandlers]) cb(WS_HOST_ID, frame.channel, payload);
  }

  private onSocketGone(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.welcomed) {
      this.welcomed = false;
      for (const cb of [...this.peerHandlers]) cb(WS_HOST_ID, "disconnected");
    }
  }
}
