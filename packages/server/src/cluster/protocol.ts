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
  | { t: "transfer.failed"; characterId: string; reason: string };

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
  | { op: "terraform.result"; requestId: string; ok: boolean; result?: unknown; error?: string };

export type TransferTarget =
  | { kind: "instance"; scene: string; party?: boolean }
  | { kind: "layer"; layerId?: string; party?: boolean };

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
  | { t: "drain" };

export function parseClusterMessage<T>(raw: unknown): T | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as { t?: unknown };
    return v && typeof v === "object" && typeof v.t === "string" ? (v as T) : null;
  } catch {
    return null;
  }
}
