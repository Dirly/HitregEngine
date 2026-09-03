/**
 * WebSocket HOST transport — the Node half of the dedicated-server transport.
 * Wire format and handshake are documented in `websocket-client.ts`; this
 * file is the only one in the package that imports `ws`, and it is exported
 * from the separate `@hitreg/net/server` entry so browser bundles never see it.
 */

import { WebSocketServer, type WebSocket as WsSocket, type ServerOptions } from "ws";
import type { Channel, PeerState, Transport } from "./transport.js";
import { frameData, parseWsHandshake, unframeData, WS_HOST_ID, type WsHandshake } from "./websocket-client.js";

export interface WebSocketHostTransportOptions {
  /** Listen on this port (creates the WebSocketServer). */
  port?: number;
  /** Bind address (default: all interfaces). */
  host?: string;
  /** Or attach to an existing HTTP server (`noServer` upgrade handled by ws). */
  server?: ServerOptions["server"];
  /** URL path to accept (default: any). */
  path?: string;
  /**
   * Bytes allowed to sit unsent on a socket before UNRELIABLE sends are
   * dropped (default 64 KiB). Reliable sends always queue. This is what makes
   * the unreliable channel mean something over TCP: a client on a bad link
   * gets fewer snapshots rather than an ever-growing backlog of stale ones.
   */
  unreliableBacklogBytes?: number;
  /** Max simultaneous sockets (default unlimited). */
  maxPeers?: number;
  /** Lifecycle tap for debugging. Never throws. */
  trace?: (event: string, detail?: string) => void;
  /** Called with the handshake name a peer proposed (the room hello carries the real one). */
  onHandshake?: (peerId: string, name: string | undefined) => void;
}

interface PeerSocket {
  socket: WsSocket;
  connected: boolean;
}

/**
 * Accepts any number of dialing clients. Each is a peer once its handshake is
 * answered; a socket that never sends a valid hello is closed after a grace
 * period. Peer ids are the clients' proposals unless taken.
 */
export class WebSocketHostTransport implements Transport {
  readonly localId = WS_HOST_ID;
  private readonly wss: WebSocketServer;
  private readonly peersById = new Map<string, PeerSocket>();
  private readonly messageHandlers = new Set<
    (from: string, channel: Channel, data: Uint8Array) => void
  >();
  private readonly peerHandlers = new Set<(peer: string, state: PeerState) => void>();
  private readonly trace: (event: string, detail?: string) => void;
  private readonly backlog: number;
  private readonly maxPeers: number;
  private readonly onHandshake: ((peerId: string, name: string | undefined) => void) | undefined;
  private closed = false;
  private readonly listening: Promise<void>;

  constructor(options: WebSocketHostTransportOptions = {}) {
    this.trace = options.trace ?? (() => undefined);
    this.backlog = options.unreliableBacklogBytes ?? 64 * 1024;
    this.maxPeers = options.maxPeers ?? Infinity;
    this.onHandshake = options.onHandshake;
    const wssOptions: ServerOptions = options.server
      ? { server: options.server, ...(options.path ? { path: options.path } : {}) }
      : {
          port: options.port ?? 0,
          ...(options.host ? { host: options.host } : {}),
          ...(options.path ? { path: options.path } : {}),
        };
    this.wss = new WebSocketServer(wssOptions);
    this.listening = options.server
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => {
          this.wss.once("listening", () => resolve());
          this.wss.once("error", (error) => reject(error));
        });
    this.wss.on("connection", (socket) => this.accept(socket));
    this.wss.on("error", (error) => {
      console.warn("[ws] server error:", error);
    });
  }

  /** Resolves once the socket server is bound (immediately when attached). */
  ready(): Promise<void> {
    return this.listening;
  }

  /** Bound port (0 until listening, or when attached to an external server). */
  get port(): number {
    const address = this.wss.address();
    return typeof address === "object" && address !== null ? address.port : 0;
  }

  peers(): string[] {
    const out: string[] = [];
    for (const [id, peer] of this.peersById) if (peer.connected) out.push(id);
    return out;
  }

  send(peer: string, channel: Channel, data: Uint8Array): void {
    if (this.closed) return;
    const entry = this.peersById.get(peer);
    if (!entry || !entry.connected) return;
    const socket = entry.socket;
    if (socket.readyState !== socket.OPEN) return;
    if (channel === "unreliable" && socket.bufferedAmount > this.backlog) {
      this.trace("ws-drop", peer);
      return;
    }
    socket.send(frameData(channel, data), { binary: true });
  }

  broadcast(channel: Channel, data: Uint8Array): void {
    for (const id of this.peers()) this.send(id, channel, data);
  }

  onMessage(cb: (from: string, channel: Channel, data: Uint8Array) => void): () => void {
    this.messageHandlers.add(cb);
    return () => this.messageHandlers.delete(cb);
  }

  onPeer(cb: (peer: string, state: PeerState) => void): () => void {
    this.peerHandlers.add(cb);
    return () => this.peerHandlers.delete(cb);
  }

  /** Disconnect one peer (kick). */
  disconnect(peer: string, reason = "kicked"): void {
    const entry = this.peersById.get(peer);
    if (!entry) return;
    try {
      entry.socket.close(1000, reason);
    } catch {
      // already closed
    }
    this.dropPeer(peer);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const id of [...this.peersById.keys()]) this.disconnect(id, "server closing");
    this.wss.close();
  }

  // -- internals -------------------------------------------------------------

  private accept(socket: WsSocket): void {
    if (this.closed) {
      socket.close(1001, "server closing");
      return;
    }
    let peerId: string | null = null;
    // a socket that never says hello is not a peer — give it a moment, then drop it
    const helloTimer = setTimeout(() => {
      if (peerId === null) socket.close(4000, "no handshake");
    }, 5000);
    socket.on("message", (raw, isBinary) => {
      try {
        if (!isBinary) {
          if (peerId !== null) return; // a second handshake is noise
          const hs = parseWsHandshake(raw.toString());
          if (!hs || hs.ws !== "hello") return;
          clearTimeout(helloTimer);
          if (this.peersById.size >= this.maxPeers) {
            socket.send(JSON.stringify({ ws: "reject", reason: "server full" } satisfies WsHandshake));
            socket.close(4001, "server full");
            return;
          }
          peerId = this.peersById.has(hs.peerId) ? `${hs.peerId}-${Math.random().toString(36).slice(2, 6)}` : hs.peerId;
          this.peersById.set(peerId, { socket, connected: true });
          socket.send(JSON.stringify({ ws: "welcome", peerId } satisfies WsHandshake));
          this.trace("ws-peer", peerId);
          this.onHandshake?.(peerId, hs.name);
          for (const cb of [...this.peerHandlers]) cb(peerId, "connected");
          return;
        }
        if (peerId === null) return; // data before hello — drop
        const bytes = Array.isArray(raw)
          ? Buffer.concat(raw as Buffer[])
          : raw instanceof ArrayBuffer
            ? new Uint8Array(raw)
            : (raw as Uint8Array);
        const frame = unframeData(bytes);
        if (!frame) return;
        const from = peerId;
        const payload = frame.data.slice();
        for (const cb of [...this.messageHandlers]) cb(from, frame.channel, payload);
      } catch (error) {
        console.warn(`[ws] message from "${peerId ?? "?"}" failed:`, error);
      }
    });
    socket.on("close", () => {
      clearTimeout(helloTimer);
      if (peerId !== null) this.dropPeer(peerId);
    });
    socket.on("error", (error) => {
      this.trace("ws-socket-error", `${peerId ?? "?"}: ${error.message}`);
    });
  }

  private dropPeer(peerId: string): void {
    const entry = this.peersById.get(peerId);
    if (!entry) return;
    this.peersById.delete(peerId);
    if (entry.connected) {
      entry.connected = false;
      this.trace("ws-peer-gone", peerId);
      for (const cb of [...this.peerHandlers]) cb(peerId, "disconnected");
    }
  }
}
