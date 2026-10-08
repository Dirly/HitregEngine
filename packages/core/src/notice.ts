import { z } from "zod";
import type { NetStateStore } from "./net-state.js";

/**
 * How NOTICEABLE a body is to creatures — the engine's half of stealth.
 *
 * A game's stealth system writes `notice/<bodyId>` = a multiplier on how far
 * a `mob-brain` notices that body: its sight range (`aggroRange`) and its
 * hearing radius (`hearRadius`) are both scaled by it before the body is
 * acquired. 1 (or absent) = plainly seen; 0.3 = sneaking; 0 = unnoticeable
 * until it does something that earns threat. What makes a body stealthy, what
 * breaks it and how long it lasts are the game's; the brain only reads the
 * number. A target the brain already has is kept whatever this says — stealth
 * hides an approach, it does not end a fight (the game drops threat for that,
 * `mob.threat` kind `forget`).
 */
export const NOTICE_NETSTATE = "notice";

export function noticeKey(bodyId: string): string {
  return `${NOTICE_NETSTATE}/${bodyId}`;
}

export const noticeSchema = z
  .number()
  .min(0)
  .max(10)
  .describe(
    "Multiplier on how far creatures notice this body (notice/<bodyId>, written by the game's stealth system on the " +
      "authority): mob-brain scales its aggroRange and hearRadius by it when acquiring a NEW target. 1 or absent = " +
      "plainly noticed, below 1 = sneaking, 0 = unnoticeable. A target already held is kept regardless.",
  );

/** Register the namespace so writes validate and it shows in the spec. Once per store. */
export function registerNoticeNetState(store: NetStateStore): void {
  store.define(NOTICE_NETSTATE, noticeSchema);
}

/** A body's notice multiplier: the published number, else 1. Never negative. */
export function readNotice(store: { get(key: string): unknown } | undefined, bodyId: string): number {
  const v = store?.get(noticeKey(bodyId));
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 1;
}
