import { z } from "zod";
import type { AssetLibrary } from "../assets.js";
import type { NetStateStore } from "../net-state.js";
import { itemSchema } from "./items.js";
import { progressionSchema } from "./progression.js";
import { characterBuildSchema, characterCreationSchema, type CharacterCreation } from "./creation.js";
import { characterSheetSchema } from "./sheet.js";
import { questJournalSchema } from "../game-ui.js";
import { registerNpcNetState } from "../npc/index.js";

export * from "./items.js";
export * from "./progression.js";
export * from "./sheet.js";
export * from "./events.js";
export * from "./creation.js";
export * from "./part-rules.js";
export * from "./looks.js";

/** The replicated namespace a character sheet lives under: `character/<bodyId>`. */
export const CHARACTER_NETSTATE = "character";

/** Data-asset types: `item` (assets/items/), `progression` (assets/progression/) and `creation` (assets/creation/). */
export function registerCharacterAssetTypes(assets: AssetLibrary): void {
  assets.defineDataType("item", itemSchema);
  assets.defineDataType("progression", progressionSchema);
  assets.defineDataType("creation", characterCreationSchema);
}

/**
 * The game's creation rules: the `creation` asset named `id`, or — with no
 * id — the only one installed. Null when there is none (or several and no id),
 * which means "no creation screen": characters are made from a name alone.
 */
export function findCreation(
  assets: Pick<AssetLibrary, "getDataAsset" | "dataAssetsOfType">,
  id?: string,
): CharacterCreation | null {
  if (id) {
    const asset = assets.getDataAsset(id);
    return asset?.type === "creation" ? (asset.data as CharacterCreation) : null;
  }
  const all = assets.dataAssetsOfType("creation");
  return all.length === 1 ? (all[0]!.data as CharacterCreation) : null;
}

/**
 * Register the `character` netState namespace so sheets validate on write
 * and the namespace shows up in the AI-facing spec. Once per store.
 */
export function registerCharacterNetState(store: NetStateStore): void {
  store.define(
    "holster",
    z
      .boolean()
      .describe(
        "Whether a body's weapons are HOLSTERED (on its back), keyed holster/<bodyId>. Authority-written by the " +
          "weapon-stance script on a stance.holster request from the body's owner; every tab moves the held items " +
          "to their back slots from it.",
      ),
  );
  store.define(
    "build",
    characterBuildSchema.describe(
      "The creation build a body arrives with, keyed build/<bodyId>. Written by the server from the signed play ticket " +
        "before the body spawns; the character-sheet authority applies it to a FRESH sheet only (a saved sheet already carries its build).",
    ),
  );
  registerNpcNetState(store);
  store.define("quests", questJournalSchema.describe("Authority-owned quest journal keyed quests/<actorId>. Tracking requests validate body ownership; objective progress never accepts peer assertions."));
  store.define(
    CHARACTER_NETSTATE,
    characterSheetSchema.describe(
      "A body's whole character sheet, keyed character/<bodyId>. Authority-written by the character-sheet script; " +
        "clients change it only through the inventory.*/character.* request events.",
    ),
  );
}
