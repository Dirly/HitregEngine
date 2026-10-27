import { z } from "zod";
import type { NetStateStore } from "./net-state.js";

/**
 * Staff — "this peer is a GM or a developer".
 *
 * A layer writes `staff/<peerId>` = the account's role when a staff account
 * joins. The role comes from the signed play ticket (the main server reads it
 * off the account record), never from the tab, and netState writes apply only
 * on the authority, so a client cannot claim it. Authority handlers that would
 * otherwise refuse a request from the wire (`/give`, `/soulbind` on the
 * character sheet) accept one from a staff peer — which is what lets a GM run
 * the console's authority commands on a live server. Granted on the server
 * machine only: `pnpm -F @hitreg/server account-role <name> gm` (docs/hosting.md, "Staff accounts").
 */
export const STAFF_NETSTATE = "staff";

export const STAFF_ROLES = ["gm", "dev"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export function staffKey(peerId: string): string {
  return `${STAFF_NETSTATE}/${peerId}`;
}

export const staffSchema = z
  .enum(STAFF_ROLES)
  .describe(
    "The staff role of a connected peer (staff/<peerId>, written by the server from the signed play ticket): " +
      "gm or dev. Authority handlers accept console requests (/give, /soulbind) from a staff peer that they refuse " +
      "from a player.",
  );

/** Register the namespace so writes validate and it shows in the spec. Once per store. */
export function registerStaffNetState(store: NetStateStore): void {
  store.define(STAFF_NETSTATE, staffSchema);
}

/** The staff role of a peer, or null for a player (or no peer: a local emission). */
export function staffRole(store: { get(key: string): unknown }, peerId: string | undefined): StaffRole | null {
  if (peerId === undefined) return null;
  const role = store.get(staffKey(peerId));
  return (STAFF_ROLES as readonly unknown[]).includes(role) ? (role as StaffRole) : null;
}

/**
 * client → authority: the console's `/teleport` (and a map click) from a STAFF peer on a dedicated server. The
 * server checks {@link staffTeleportRefusal}, waits for the destination's ground (the same hold a joining or
 * portal-arriving body gets), lands the body on the first collider over the column (else the field surface) and
 * answers a refusal as `character.refused` with request "teleport". In local play the client moves its own body.
 */
export const STAFF_TELEPORT_EVENT = "staff.teleport";

export const staffTeleportSchema = z
  .object({
    actorId: z.string().min(1).describe("The body to move: the requester's own (owner/<actorId> must be the sender)."),
    x: z.number().finite().describe("World X, metres."),
    z: z.number().finite().describe("World Z, metres."),
    y: z.number().finite().optional().describe("Height to land at; omitted = the server's ground under (x, z)."),
  })
  .describe(
    "The console's /teleport on a server: move your own body to (x, z). Honoured only from a STAFF peer " +
      "(staff/<peer>, from the signed ticket) or a local emission; a player is refused.",
  );

export type StaffTeleportRequest = z.infer<typeof staffTeleportSchema>;

/** Why the authority refuses a teleport request from `from` (undefined = a local emission), or null to honour it. */
export function staffTeleportRefusal(store: { get(key: string): unknown }, from: string | undefined, actorId: string): string | null {
  if (from === undefined) return null;
  if (staffRole(store, from) === null) return "Only staff (a GM or dev account) can teleport on a server.";
  if (store.get(`owner/${actorId}`) !== from) return "That is not your character.";
  return null;
}
