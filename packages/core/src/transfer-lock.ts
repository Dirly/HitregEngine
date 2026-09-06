import { z } from "zod";
import type { NetStateStore } from "./net-state.js";

/**
 * Transfer lock — "this body may not change servers until sim time T".
 *
 * A cluster moves players between layers (a dungeon door, a party pull, a
 * rebalance) through one gate. Combat is the one thing the engine cannot
 * see from outside a game's scripts, so the gate reads this key instead:
 * an authoritative combat script writes `transferLock/<bodyId>` = the sim
 * time (`ctx.now()` ms) until which the body is committed — on every hit
 * taken or dealt — and the gate refuses while it is in the future. Result:
 * a player being chased cannot vanish into an instance mid-fight, and the
 * attacker cannot pull their party out of a fight they are losing.
 *
 * Sim time, not wall clock, so a replica agrees with the authority; every
 * peer holds the key, so a promoted host inherits the lock.
 */
export const TRANSFER_LOCK_NETSTATE = "transferLock";

export function transferLockKey(bodyId: string): string {
  return `${TRANSFER_LOCK_NETSTATE}/${bodyId}`;
}

export const transferLockSchema = z
  .number()
  .min(0)
  .describe(
    "Simulated time in ms (ctx.now()) until which this body may not be transferred between servers. " +
      "Written by authoritative combat scripts on every hit taken or dealt (transferLock/<bodyId>); the cluster's " +
      "transfer gate refuses while it is in the future.",
  );

/** Register the namespace so writes validate and it shows in the spec. Once per store. */
export function registerTransferLockNetState(store: NetStateStore): void {
  store.define(TRANSFER_LOCK_NETSTATE, transferLockSchema);
}

/** Whether a body is locked at sim time `nowMs`, given the store. */
export function isTransferLocked(store: { get(key: string): unknown }, bodyId: string, nowMs: number): boolean {
  const until = store.get(transferLockKey(bodyId));
  return typeof until === "number" && until > nowMs;
}
