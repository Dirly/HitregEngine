import { z } from "zod";
import type { NetStateStore } from "./net-state.js";

export const encounterChoiceSchema = z.string().min(1).describe(
  "NPC template chosen once by the authority for an encounter in this instance. " +
  "Key encounter-choice/<encounter entity id>.template. Wipes and late joins reuse it; a new instance rolls again.",
);
const registered = new WeakSet<NetStateStore>();
export const bossGateTimestampSchema = z.number().finite().describe(
  "Shared simulation seconds for a gate transition. Keys boss-gate/<gate entity id>.openedAt (permanent boss-defeat latch) and .closedAt (aggro entrance closure; removable on boss evade). Peers derive art and collider motion from these timestamps; only the authority writes them.",
);
export function registerEncounterNetState(store: NetStateStore): void {
  if (registered.has(store)) return;
  store.define("encounter-choice", encounterChoiceSchema);
  store.define("boss-gate", bossGateTimestampSchema);
  registered.add(store);
}
