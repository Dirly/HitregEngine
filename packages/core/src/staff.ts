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
