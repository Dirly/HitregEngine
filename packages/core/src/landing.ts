import { z } from "zod";
import type { NetStateStore } from "./net-state.js";

/**
 * Landing grace — "this body just arrived on this server; leave it alone".
 *
 * A layer writes `landing/<bodyId>` = sim time (ms) until which the body is
 * settling, when it spawns a player who just logged in or was transferred
 * from another server. NPC brains read it and neither aggro nor target a
 * landing body; the grace ends early when the body acts (an authoritative
 * combat script clears the key on the first hit it deals — see
 * `clearLanding`). The cluster tries to land players on quiet ground
 * (docs/hosting.md, "Crossing a border"); this is the backstop for the
 * cases it cannot wait out.
 */
export const LANDING_NETSTATE = "landing";

export function landingKey(bodyId: string): string {
  return `${LANDING_NETSTATE}/${bodyId}`;
}

export const landingSchema = z
  .number()
  .min(0)
  .describe(
    "Simulated time in ms (ctx.now()) until which this body is still landing after a login or a server transfer " +
      "(landing/<bodyId>, written by the server). NPC brains must not aggro or target a landing body; an " +
      "authoritative combat script clears the key on the first hit the body deals.",
  );

/** Register the namespace so writes validate and it shows in the spec. Once per store. */
export function registerLandingNetState(store: NetStateStore): void {
  store.define(LANDING_NETSTATE, landingSchema);
}

/** Whether a body is still landing at sim time `nowMs`. */
export function isLanding(store: { get(key: string): unknown }, bodyId: string, nowMs: number): boolean {
  const until = store.get(landingKey(bodyId));
  return typeof until === "number" && until > nowMs;
}

/**
 * End the grace early (the body acted). Writes 0 rather than deleting so it
 * works through any store a script holds (`ctx.netState` has no delete);
 * a 0 deadline is "not landing" to `isLanding`. No-op when there is none.
 */
export function clearLanding(store: { get(key: string): unknown; set(key: string, value: unknown): unknown }, bodyId: string): void {
  const until = store.get(landingKey(bodyId));
  if (typeof until === "number" && until > 0) store.set(landingKey(bodyId), 0);
}
