import { z } from "zod";
import type { AssetLibrary } from "../assets.js";
import type { NetStateStore } from "../net-state.js";
import { itemSchema } from "./items.js";
import { progressionSchema } from "./progression.js";
import { characterBuildSchema, characterCreationSchema, type CharacterCreation } from "./creation.js";
import { characterSheetSchema } from "./sheet.js";
import { GROUND_NETSTATE, groundItemSchema } from "./transfer.js";
import {
  LOOT_LOCK_NETSTATE,
  LOOT_NETSTATE,
  LOOT_ROLL_NETSTATE,
  LOOT_SAVE_NETSTATE,
  lootBagSchema,
  lootLockSchema,
  lootRollSchema,
  savedBagsSchema,
} from "./loot.js";
import { HAND_NETSTATE, handStateSchema } from "./hand.js";
import { BADGE_NETSTATE, CAST_NETSTATE, castBarSchema, plateBadgesSchema } from "./cast.js";
import { PET_NETSTATE, TARGET_NETSTATE, petStateSchema, targetStateSchema } from "./target.js";
import { questJournalSchema } from "../game-ui.js";
import { registerNpcNetState } from "../npc/index.js";
import { registerPortalNetState } from "../portal.js";

export * from "./items.js";
export * from "./progression.js";
export * from "./sheet.js";
export * from "./durability.js";
export * from "./instance.js";
export * from "./transfer.js";
export * from "./loot.js";
export * from "./soulbind.js";
export * from "./events.js";
export * from "./creation.js";
export * from "./part-rules.js";
export * from "./looks.js";
export * from "./hand.js";
export * from "./cast.js";
export * from "./target.js";

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
  store.define(GROUND_NETSTATE, groundItemSchema); // ground/<dropId> — an item anyone may pick up, with its instance data
  store.define(LOOT_NETSTATE, lootBagSchema, { audience: "owner" }); // lootbag/<bagId> — sent to its owner alone
  store.define(LOOT_SAVE_NETSTATE, savedBagsSchema, { audience: "owner" }); // lootbags/<bodyId> — bags saved with their owner
  store.define(LOOT_LOCK_NETSTATE, lootLockSchema); // lootlock/<bodyId> — a killed character being looted
  store.define(LOOT_ROLL_NETSTATE, lootRollSchema); // lootroll/<rollId> — a party need/greed/pass roll
  store.define(HAND_NETSTATE, handStateSchema); // hand/<bodyId> — the weapon set in hand and a pending swap
  store.define(CAST_NETSTATE, castBarSchema); // cast/<bodyId> — a cast in progress, for cast bars
  store.define(BADGE_NETSTATE, plateBadgesSchema); // badge/<bodyId> — timed statuses over a body (an interrupt lock)
  store.define(TARGET_NETSTATE, targetStateSchema); // target/<bodyId> — the enemy it fights, the friend it supports
  store.define(PET_NETSTATE, petStateSchema); // pet/<petId> — a creature fighting for a player
  registerNpcNetState(store);
  registerPortalNetState(store); // portal/<bodyId> — a portal trip's arrival + way back, saved with the character
  store.define("quests", questJournalSchema.describe("Authority-owned quest journal keyed quests/<actorId>. Tracking requests validate body ownership; objective progress never accepts peer assertions."));
  store.define(
    CHARACTER_NETSTATE,
    characterSheetSchema.describe(
      "A body's whole character sheet, keyed character/<bodyId>. Authority-written by the character-sheet script; " +
        "clients change it only through the inventory.*/character.* request events.",
    ),
  );
}
