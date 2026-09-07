/**
 * ClusterLink — a layer's socket to main.
 *
 * Dials, registers, re-dials with backoff when the link drops (main
 * restarting must not kill the layers: players keep playing, commits queue
 * for a bounded time, and the layer re-registers under the same id). Every
 * durable thing a layer needs is an RPC here; `backend` adapts the RPC to
 * core's `PlayerDataBackend` so the layer's `PlayerStore` never knows main
 * exists.
 */

import WebSocket from "ws";
import type { PlayerDataBackend, PlayerDataRecord, PlayerDataScope, WorldRecipe } from "@hitreg/core";
import {
  CLUSTER_PATH,
  parseClusterMessage,
  type BridgedChatLine,
  type HostedZones,
  type SocialEvent,
  type LayerRpc,
  type LayerToMain,
  type MainToLayer,
  type PlayerPresence,
  type ServerKind,
} from "./protocol.js";

export interface ClusterLinkOptions {
  mainUrl: string;
  secret: string;
  id: string;
  kind: ServerKind;
  /** What clients dial to reach THIS server. */
  url: string;
  scene: string;
  cap: number;
  instanceOf?: string;
  /** Seconds an RPC may wait for the link to come back before failing (default 15). */
  rpcTimeoutSeconds?: number;
  log?: (line: string) => void;
}

export interface Registered {
  id: string;
  experienceId: string;
  primary: boolean;
  commitEverySeconds: number;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ClusterLink {
  readonly opts: ClusterLinkOptions;
  private socket: WebSocket | null = null;
  private registered: Registered | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly queue: string[] = [];
  private nextRpc = 1;
  private closed = false;
  private backoffMs = 500;
  private redial: ReturnType<typeof setTimeout> | null = null;
  private readonly log: (line: string) => void;
  private readonly handlers = {
    transfer: new Set<(m: { characterId: string; srv: string; url: string; reason: string }) => void>(),
    recipe: new Set<(id: string, recipe: WorldRecipe) => void>(),
    terraform: new Set<(requestId: string, edits: unknown[]) => void>(),
    drain: new Set<() => void>(),
    zones: new Set<(hosted: HostedZones) => void>(),
    arrival: new Set<(requestId: string, position: [number, number, number]) => void>(),
    link: new Set<(up: boolean) => void>(),
    chat: new Set<(line: BridgedChatLine, origin: string) => void>(),
    party: new Set<(characterId: string, party: string | null) => void>(),
    social: new Set<(characterId: string, event: SocialEvent) => void>(),
    blocks: new Set<(characterId: string, blocked: string[]) => void>(),
  };
  private firstRegistration: { resolve: (r: Registered) => void; reject: (e: Error) => void } | null = null;

  constructor(opts: ClusterLinkOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => undefined);
  }

  get isUp(): boolean {
    return this.registered !== null && this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  get info(): Registered | null {
    return this.registered;
  }

  /** Dial and register; resolves on the first successful registration. */
  connect(): Promise<Registered> {
    return new Promise((resolve, reject) => {
      this.firstRegistration = { resolve, reject };
      this.dial();
    });
  }

  private dial(): void {
    if (this.closed) return;
    const url = this.opts.mainUrl.replace(/\/+$/, "") + CLUSTER_PATH;
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.on("open", () => {
      this.backoffMs = 500;
      const reg: LayerToMain = {
        t: "register",
        secret: this.opts.secret,
        id: this.opts.id,
        kind: this.opts.kind,
        url: this.opts.url,
        scene: this.opts.scene,
        cap: this.opts.cap,
        ...(this.opts.instanceOf ? { instanceOf: this.opts.instanceOf } : {}),
      };
      socket.send(JSON.stringify(reg));
    });
    socket.on("message", (raw) => this.onMessage(parseClusterMessage<MainToLayer>(raw.toString())));
    socket.on("close", () => this.onDown("closed"));
    socket.on("error", (error) => {
      this.log(`[cluster] link error: ${error.message}`);
    });
  }

  private onDown(why: string): void {
    if (this.socket === null) return;
    const wasUp = this.registered !== null;
    this.socket = null;
    this.registered = null;
    if (wasUp) {
      this.log(`[cluster] link to main ${why} — re-dialing`);
      for (const cb of this.handlers.link) cb(false);
    }
    if (this.closed) return;
    this.redial = setTimeout(() => this.dial(), this.backoffMs);
    this.backoffMs = Math.min(10_000, this.backoffMs * 2);
  }

  private onMessage(msg: MainToLayer | null): void {
    if (!msg) return;
    switch (msg.t) {
      case "registered": {
        this.registered = { id: msg.id, experienceId: msg.experienceId, primary: msg.primary, commitEverySeconds: msg.commitEverySeconds };
        this.log(`[cluster] registered with main as "${msg.id}"${msg.primary ? " (primary)" : ""}`);
        for (const line of this.queue.splice(0)) this.socket?.send(line);
        for (const cb of this.handlers.link) cb(true);
        this.firstRegistration?.resolve(this.registered);
        this.firstRegistration = null;
        return;
      }
      case "rejected": {
        this.log(`[cluster] main rejected registration: ${msg.reason}`);
        const err = new Error(`main rejected registration: ${msg.reason}`);
        this.firstRegistration?.reject(err);
        this.firstRegistration = null;
        this.close();
        return;
      }
      case "rpc.result": {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error));
        return;
      }
      case "transfer.begin":
        for (const cb of this.handlers.transfer) cb(msg);
        return;
      case "recipe":
        for (const cb of this.handlers.recipe) cb(msg.id, msg.recipe);
        return;
      case "terraform":
        for (const cb of this.handlers.terraform) cb(msg.requestId, msg.edits);
        return;
      case "drain":
        for (const cb of this.handlers.drain) cb();
        return;
      case "zones":
        this.hosted = msg.hosted;
        for (const cb of this.handlers.zones) cb(msg.hosted);
        return;
      case "arrival.check":
        for (const cb of this.handlers.arrival) cb(msg.requestId, msg.position);
        return;
      case "chat":
        for (const cb of this.handlers.chat) cb(msg.line, msg.origin);
        return;
      case "party":
        for (const cb of this.handlers.party) cb(msg.characterId, msg.party);
        return;
      case "social":
        for (const cb of this.handlers.social) cb(msg.characterId, msg.event);
        return;
      case "blocks":
        for (const cb of this.handlers.blocks) cb(msg.characterId, msg.blocked);
        return;
    }
  }

  private send(msg: LayerToMain): void {
    const line = JSON.stringify(msg);
    if (this.isUp) this.socket!.send(line);
    else if (this.queue.length < 1000) this.queue.push(line);
  }

  status(payload: { players: PlayerPresence[]; tickMs: number; entities: number; accepting: boolean }): void {
    if (!this.isUp) return; // stale status is worthless; skip rather than queue
    this.socket!.send(JSON.stringify({ t: "status", ...payload } satisfies LayerToMain));
  }

  playerJoined(player: PlayerPresence): void {
    this.send({ t: "player.joined", player });
  }

  playerLeft(characterId: string, reason: "leave" | "transfer" | "grace" | "replaced"): void {
    this.send({ t: "player.left", characterId, reason });
  }

  transferFailed(characterId: string, reason: string): void {
    this.send({ t: "transfer.failed", characterId, reason });
  }

  /** A zone/global line this layer delivered — for main to fan to the other layers. Dropped while main is down (chat is not worth queuing). */
  chat(line: BridgedChatLine): void {
    if (!this.isUp) return;
    this.socket!.send(JSON.stringify({ t: "chat", line } satisfies LayerToMain));
  }

  onChat(cb: (line: BridgedChatLine, origin: string) => void): () => void {
    this.handlers.chat.add(cb);
    return () => this.handlers.chat.delete(cb);
  }

  /** Main says which party a character on this layer is in (null = none). */
  onParty(cb: (characterId: string, party: string | null) => void): () => void {
    this.handlers.party.add(cb);
    return () => this.handlers.party.delete(cb);
  }

  /** A friends/party event for a character standing here — deliver it to their client. */
  onSocial(cb: (characterId: string, event: SocialEvent) => void): () => void {
    this.handlers.social.add(cb);
    return () => this.handlers.social.delete(cb);
  }

  /** Main says which characters this character must not hear. */
  onBlocks(cb: (characterId: string, blocked: string[]) => void): () => void {
    this.handlers.blocks.add(cb);
    return () => this.handlers.blocks.delete(cb);
  }

  rpc<T = unknown>(call: LayerRpc): Promise<T> {
    if (this.closed) return Promise.reject(new Error("cluster link closed"));
    const id = this.nextRpc++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc ${call.op} timed out (main unreachable)`));
      }, (this.opts.rpcTimeoutSeconds ?? 15) * 1000);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ t: "rpc", id, call });
    });
  }

  onTransferBegin(cb: (m: { characterId: string; srv: string; url: string; reason: string }) => void): () => void {
    this.handlers.transfer.add(cb);
    return () => this.handlers.transfer.delete(cb);
  }
  onRecipe(cb: (id: string, recipe: WorldRecipe) => void): () => void {
    this.handlers.recipe.add(cb);
    return () => this.handlers.recipe.delete(cb);
  }
  onTerraform(cb: (requestId: string, edits: unknown[]) => void): () => void {
    this.handlers.terraform.add(cb);
    return () => this.handlers.terraform.delete(cb);
  }
  onDrain(cb: () => void): () => void {
    this.handlers.drain.add(cb);
    return () => this.handlers.drain.delete(cb);
  }
  onLink(cb: (up: boolean) => void): () => void {
    this.handlers.link.add(cb);
    return () => this.handlers.link.delete(cb);
  }

  /** Zones main places players here for ("all" until main says otherwise). */
  hosted: HostedZones = "all";

  onZones(cb: (hosted: HostedZones) => void): () => void {
    this.handlers.zones.add(cb);
    return () => this.handlers.zones.delete(cb);
  }
  /** Main asks whether a spot is quiet here; answer with rpc `arrival.result`. */
  onArrivalCheck(cb: (requestId: string, position: [number, number, number]) => void): () => void {
    this.handlers.arrival.add(cb);
    return () => this.handlers.arrival.delete(cb);
  }

  /** Core's persistence contract, served by main over this socket. */
  get backend(): PlayerDataBackend {
    return {
      load: (scope: PlayerDataScope, namespace: string) =>
        this.rpc<PlayerDataRecord | null>({ op: "data.load", scope, namespace }),
      store: (scope: PlayerDataScope, namespace: string, record: PlayerDataRecord, expectedRevision: number | null) =>
        this.rpc<"ok" | "conflict">({ op: "data.store", scope, namespace, record, expectedRevision }),
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.redial) clearTimeout(this.redial);
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("cluster link closed"));
      this.pending.delete(id);
    }
    const socket = this.socket;
    this.socket = null;
    this.registered = null;
    try {
      socket?.close(1000, "layer closing");
    } catch {
      // already closed
    }
  }
}
