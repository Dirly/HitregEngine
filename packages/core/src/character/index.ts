import type { AssetLibrary } from "../assets.js";
import type { NetStateStore } from "../net-state.js";
import { itemSchema } from "./items.js";
import { progressionSchema } from "./progression.js";
import { characterSheetSchema } from "./sheet.js";

export * from "./items.js";
export * from "./progression.js";
export * from "./sheet.js";
export * from "./events.js";

/** The replicated namespace a character sheet lives under: `character/<bodyId>`. */
export const CHARACTER_NETSTATE = "character";

/** Data-asset types: `item` (assets/items/) and `progression` (assets/progression/). */
export function registerCharacterAssetTypes(assets: AssetLibrary): void {
  assets.defineDataType("item", itemSchema);
  assets.defineDataType("progression", progressionSchema);
}

/**
 * Register the `character` netState namespace so sheets validate on write
 * and the namespace shows up in the AI-facing spec. Once per store.
 */
export function registerCharacterNetState(store: NetStateStore): void {
  store.define(
    CHARACTER_NETSTATE,
    characterSheetSchema.describe(
      "A body's whole character sheet, keyed character/<bodyId>. Authority-written by the character-sheet script; " +
        "clients change it only through the inventory.*/character.* request events.",
    ),
  );
}
