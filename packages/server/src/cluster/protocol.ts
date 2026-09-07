/**
 * Cluster protocol — MAIN ↔ LAYER, JSON over one WebSocket per layer.
 *
 * Roles (docs/hosting.md):
 *   MAIN   login + placement + the only process that touches the database
 *          + the writer of record for the world recipe. Never on the hot path.
 *   LAYER  a `GameServer` running the whole world for up to `cap` players
 *          (a Diablo-style copy). Holds nothing durable: loads a character
 *          on arrival, commits on departure / a timer / a transfer.
 *   INSTANCE  a layer started on demand for one scene (a dungeon), exits
 *          when empty.
 *
 * A layer dials main, registers with the shared secret, and from then on
 * everything durable is an RPC on this socket: player-data load/store
 * (main owns the backend), ticket minting, transfer requests. Main pushes
 * transfers it initiates (party pulls, rebalancing, an admin move) and
 * recipe changes (the agent's world edits) down the same socket.
 */

import type { PlayerDataRecord, PlayerDataScope, WorldRecipe } from "@hitreg/core";

export const CLUSTER_PATH = "/cluster";

export type ServerKind = "layer" | "instance";

export interface PlayerPresence {
  characterId: string;
  playerId: string;
  name: string;
  position: [number, number, number] | null;
}

/**
 * A chat line one layer routed and delivered on its side, carried to every
 * other layer so the copies of the world share a room. `zone` is the
 * sender's world zone (only the origin can compute it); `channel` is a
 * bridged channel — "zone" (delivered to players standing in `zone` on the
 * receiving layer), "party" (delivered to the members of `party`, which
 * MAIN fills in from its own party list — the layer's copy is a hint) or
 * "global" (everyone). The stamp (`id`, `at`) is the origin's, so the same
 * line is the same line everywhere.
 */
export interface BridgedChatLine {
  id: string;
  channel: "zone" | "global" | "party";
  from: string;
  name: string;
  text: string;
  at: number;
  zone: string | null;
  /** Party code of the sender, resolved by main on the way through. */
  party?: string | null;
}

// -- layer → main ----------------------------------------------------------------

export type LayerToMain =
  | {
      t: "register";
      secret: string;
      id: string;
      kind: ServerKind;
      /** What clients dial. */
      url: string;
      scene: string;
      cap: number;
      /** For instances: the request id main spawned it for. */
      instanceOf?: string;
    }
  | { t: "status"; players: PlayerPresence[]; tickMs: number; entities: number; accepting: boolean }
  | { t: "player.joined"; player: PlayerPresence }
  | { t: "player.left"; characterId: string; reason: "leave" | "transfer" | "grace" | "replaced" }
  | { t: "rpc"; id: number; call: LayerRpc }
  /** A main-initiated transfer could not happen (gate never opened, player gone). */
  | { t: "transfer.failed"; characterId: string; reason: string }
  /** A zone/global chat line this layer delivered — main fans it to every other layer. */
  | { t: "chat"; line: BridgedChatLine };

export type LayerRpc =
  | { op: "data.load"; scope: PlayerDataScope; namespace: string }
  | { op: "data.store"; scope: PlayerDataScope; namespace: string; record: PlayerDataRecord; expectedRevision: number | null }
  /** Mint a ticket for a character to enter server `srv`, bound to committed revisions. */
  | { op: "ticket.mint"; playerId: string; characterId: string; name: string; srv: string; rev: Record<string, number>; reason: string }
  /**
   * Ask main to place a character somewhere else (a portal, a dungeon door,
   * a script's decision). Main resolves the destination — starting an
   * instance if it has to — and answers with `{ srv, url }`; the layer then
   * commits, mints, and hands the client over. `party: true` moves the
   * character's whole party (main pushes `transfer.begin` to the others).
   */
  | { op: "transfer.request"; characterId: string; target: TransferTarget }
  /** A layer applied a terraform: main persists the recipe (writer of record) and fans it to the rest. */
  | { op: "recipe.changed"; id: string; recipe: WorldRecipe }
  /** Answer to a main-forwarded `terraform` (the admin's HTTP response). */
  | { op: "terraform.result"; requestId: string; ok: boolean; result?: unknown; error?: string }
  /** Answer to `arrival.check`: whether the spot is quiet on this layer. */
  | { op: "arrival.result"; requestId: string; clear: boolean };

export type TransferTarget =
  | { kind: "instance"; scene: string; party?: boolean }
  | { kind: "layer"; layerId?: string; party?: boolean }
  /**
   * The character walked into a zone this layer does not host: place them on
   * a copy that does. `position` is where the body stands (main asks the
   * destination whether that spot is quiet — no awake pack — before
   * answering; `force` skips that after the layer has waited long enough).
   */
  | { kind: "zone"; zone: string; position: [number, number, number]; force?: boolean };

/** Main's answer to a transfer request: go there, or not yet. */
export type TransferAnswer = { srv: string; url: string; wait?: undefined } | { wait: true; retryMs: number; srv?: undefined };

/** Which zones a layer hosts — the set main places players into it for. "all" = every zone (the low-population shape). */
export type HostedZones = "all" | string[];

// -- main → layer ----------------------------------------------------------------

export type MainToLayer =
  | { t: "registered"; id: string; experienceId: string; primary: boolean; commitEverySeconds: number }
  | { t: "rejected"; reason: string }
  | { t: "rpc.result"; id: number; ok: true; result: unknown }
  | { t: "rpc.result"; id: number; ok: false; error: string }
  /** Move this character to `srv` (commit → `ticket.mint` → tell the client). */
  | { t: "transfer.begin"; characterId: string; srv: string; url: string; reason: string }
  /** The world recipe changed elsewhere: apply without persisting. */
  | { t: "recipe"; id: string; recipe: WorldRecipe }
  /** Apply a terraform batch here (the primary layer persists) and answer over `recipe.changed`. */
  | { t: "terraform"; requestId: string; edits: unknown[] }
  /** Stop accepting joins; move everyone off; exit when empty. */
  | { t: "drain" }
  /** The zones this layer hosts from now on (placement + border transfers key off it). */
  | { t: "zones"; hosted: HostedZones }
  /** Is this spot quiet here (no awake pack in aggro range)? Answer with rpc `arrival.result`. */
  | { t: "arrival.check"; requestId: string; position: [number, number, number] }
  /** A chat line another layer delivered: deliver it here to whoever may hear it (zone / party / everyone). */
  | { t: "chat"; line: BridgedChatLine; origin: string }
  /** This character's party changed (or they just arrived here): write `comms.party/<characterId>` so party chat routes. Main owns parties. */
  | { t: "party"; characterId: string; party: string | null }
  /** Something happened to this character's friends or party: hand it to their client (a module message + a chat line). */
  | { t: "social"; characterId: string; event: SocialEvent }
  /** The characters this character must not hear (every character of every account they blocked). */
  | { t: "blocks"; characterId: string; blocked: string[] };

/** Module id the layer delivers social events on to the client (`sendModule(peerId, SOCIAL_MODULE, event)`). */
export const SOCIAL_MODULE = "social";

/**
 * What main tells a player about their friends and party, through the
 * layer they stand on (docs/hosting.md → "Parties and friends"). Every one
 * is also a chat line (`socialLine`); the module message is for a UI.
 */
export type SocialEvent =
  | { kind: "friend.request"; characterId: string; name: string }
  | { kind: "friend.accepted"; characterId: string; name: string }
  | { kind: "friend.removed"; characterId: string; name: string }
  | { kind: "friend.online" | "friend.offline"; characterId: string; name: string; zone: string | null }
  | { kind: "party.invite"; code: string; characterId: string; name: string }
  | { kind: "party.declined"; characterId: string; name: string }
  | { kind: "party.joined" | "party.left" | "party.leader"; characterId: string; name: string }
  | { kind: "party.kicked"; code: string };

export function socialLine(e: SocialEvent): string {
  switch (e.kind) {
    case "friend.request":
      return `${e.name} wants to be your friend — /accept or /decline.`;
    case "friend.accepted":
      return `${e.name} is now your friend.`;
    case "friend.removed":
      return `${e.name} removed you as a friend.`;
    case "friend.online":
      return `${e.name} is online${e.zone ? ` in ${e.zone}` : ""}.`;
    case "friend.offline":
      return `${e.name} went offline.`;
    case "party.invite":
      return `${e.name} invited you to their party — /accept or /decline.`;
    case "party.declined":
      return `${e.name} declined your party invitation.`;
    case "party.joined":
      return `${e.name} joined the party.`;
    case "party.left":
      return `${e.name} left the party.`;
    case "party.leader":
      return `${e.name} is now the party leader.`;
    case "party.kicked":
      return "You were removed from the party.";
  }
}

export function parseClusterMessage<T>(raw: unknown): T | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as { t?: unknown };
    return v && typeof v === "object" && typeof v.t === "string" ? (v as T) : null;
  } catch {
    return null;
  }
}
