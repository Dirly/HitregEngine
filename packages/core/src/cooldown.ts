import { z } from "zod";
import type { NetStateStore } from "./net-state.js";

/**
 * Ability cooldowns — `cooldown/<bodyId>.<abilityId>` = the sim time in SECONDS (`ctx.now() / 1000`) until which
 * that body may not use that ability again; 0 (or a time in the past) means ready. Written by the authority's
 * combat scripts when a cast lands, shortened by cooldown-refund effects, cleared on respawn. Every tab reads it
 * for hotbar sweeps; the server sends it only to peers that can see the body.
 */
export const COOLDOWN_NETSTATE = "cooldown";

export function cooldownKey(bodyId: string, abilityId: string): string {
  return `${COOLDOWN_NETSTATE}/${bodyId}.${abilityId}`;
}

export const cooldownSchema = z
  .number()
  .min(0)
  .describe(
    "Sim time in seconds (ctx.now() / 1000) until which this body's ability is cooling down, keyed " +
      "cooldown/<bodyId>.<abilityId>; 0 or a past time means ready. Authority-written by combat scripts.",
  );

/** Register the namespace so writes validate and it shows in the spec. Once per store. */
export function registerCooldownNetState(store: NetStateStore): void {
  store.define(COOLDOWN_NETSTATE, cooldownSchema);
}
