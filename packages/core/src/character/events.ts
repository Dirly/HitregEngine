import { z } from "zod";
import type { EventRegistrationOptions } from "../events.js";
import { ATTRIBUTES, BELT_SLOTS, EQUIPMENT_SLOTS, type EquipmentSlot } from "./items.js";
import { CONTAINERS, looseStackSchema } from "./sheet.js";
import { ROLL_CHOICES } from "./loot.js";

/**
 * The request/response contracts between a client (the inventory UI, a loot
 * pickup, a quest) and the authority that owns a character sheet.
 *
 * Direction is the whole design: a client never edits its own sheet. It
 * ASKS (`to-authority`), the `character-sheet` script applies the reducer on
 * the session authority, the new sheet replicates as netState, and a refusal
 * comes back as `character.refused`. Grants (`character.xp`,
 * `inventory.give`) are authority-internal — emitted by authoritative
 * gameplay scripts, never accepted from a peer — so a client cannot award
 * itself experience or items.
 *
 * Declared on the script (`static events`) from this list so loading the
 * script registers them; the shapes live in core so a server, a test or a
 * tool can validate a request without the scripting package.
 */

const actorId = z.string().min(1).describe("Body entity id whose sheet this concerns (netState character/<actorId>).");
const uid = z.string().min(1).describe("Stack uid inside the sheet's `items`.");

export const gridTargetSchema = z.object({
  container: z.enum(CONTAINERS),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
});

export const CHARACTER_EVENTS = {
  /** client → authority: spend one point. */
  allocate: "character.allocate",
  /** authority-internal: grant experience (a kill, a quest turn-in). */
  xp: "character.xp",
  /** authority → everyone: a level was gained. */
  leveled: "character.leveled",
  /** authority-internal: give items (loot, a vendor, a reward). */
  give: "inventory.give",
  /** authority-internal: wear every worn item (a death: 10% of each maximum). */
  wear: "character.wear",
  /** client → authority: move a stack to a cell (merge/swap on landing). */
  move: "inventory.move",
  /** client → authority: wear a carried stack. */
  equip: "inventory.equip",
  /** client → authority: take a worn item off into a cell. */
  unequip: "inventory.unequip",
  /** client → authority: throw a stack (or part of one) away. */
  drop: "inventory.drop",
  /** client → authority: split a stack into a free cell. */
  split: "inventory.split",
  /** authority → everyone: a stack left a sheet at a world point; it lies there as ground/<dropId>. */
  dropped: "inventory.dropped",
  /** client → authority: pick a ground item (ground/<dropId>) up, with all its instance data. */
  pickup: "inventory.pickup",
  /** authority-internal: put stacks (a creature's drops) or a killed character's gear in a loot bag only `actorId` sees. */
  bag: "inventory.bag",
  /** client → authority: take from a loot bag you own (one stack, everything that fits, or one item off a body). */
  loot: "inventory.loot",
  /** authority-internal: move a stack, with its instance data, from one character to another (trade, loot). */
  transfer: "inventory.transfer",
  /** authority → everyone: a stack moved from one character to another. */
  transferred: "inventory.transferred",
  /** authority → everyone: a request was refused, with the reason (UIs toast it). */
  refused: "character.refused",
  /** client → authority: use one item from a belt slot (allowed in combat; shared cooldown). */
  use: "inventory.use",
  /** authority → everyone: an item was used from the belt; the game applies its `skill`. */
  used: "inventory.used",
  /** client → authority: swap the weapon set in hand (timed; allowed in combat). */
  swap: "character.swap",
  /** client → authority: answer a party loot roll (need / greed / pass). */
  roll: "loot.roll",
  /** authority → everyone: a party loot roll was settled (who won, with what). */
  rolled: "loot.rolled",
  /** authority-internal: soulbind (or free) one equipment slot to what is worn there — an admin/console override of the soul binder. */
  soulbind: "inventory.soulbind",
  /** authority-internal: a character died — their bags' contents and copper leave them into a CORPSE at the body. */
  corpse: "inventory.corpse",
} as const;

export interface CharacterEventDecl {
  name: string;
  schema: z.ZodType;
  options?: EventRegistrationOptions;
}

const toAuthority: EventRegistrationOptions = { replicate: "to-authority" };
const toPeers: EventRegistrationOptions = { replicate: "to-peers" };

export const characterEventDecls: readonly CharacterEventDecl[] = [
  {
    name: CHARACTER_EVENTS.allocate,
    schema: z.object({ actorId, attribute: z.enum(ATTRIBUTES) }),
    options: toAuthority,
  },
  {
    name: CHARACTER_EVENTS.xp,
    schema: z.object({ actorId, amount: z.number().min(0) }),
  },
  {
    name: CHARACTER_EVENTS.leveled,
    schema: z.object({ actorId, level: z.number().int().min(1), unspent: z.number().int().min(0) }),
    options: toPeers,
  },
  {
    name: CHARACTER_EVENTS.give,
    schema: z.object({
      actorId,
      itemId: z.string().min(1),
      qty: z.number().int().min(1).default(1),
      twists: z
        .array(z.string().min(1))
        .max(8)
        .optional()
        .describe("Rolled twists for each new instance (opaque to the engine; the game gives them meaning). Only for items that do not stack."),
    }),
  },
  {
    name: CHARACTER_EVENTS.wear,
    schema: z
      .object({
        actorId,
        fraction: z.number().min(0).max(1).default(0.1).describe("Share of each worn item's maximum durability lost (rounded up, at least 1 point)."),
      })
      .describe("Authority-internal: the character's worn gear wears (emitted where death is decided). Items at 0 break."),
  },
  {
    name: CHARACTER_EVENTS.move,
    schema: z.object({ actorId, uid, to: gridTargetSchema }),
    options: toAuthority,
  },
  {
    name: CHARACTER_EVENTS.equip,
    schema: z.object({ actorId, uid, slot: z.enum(EQUIPMENT_SLOTS).optional() }),
    options: toAuthority,
  },
  {
    name: CHARACTER_EVENTS.unequip,
    schema: z.object({ actorId, slot: z.enum(EQUIPMENT_SLOTS), to: gridTargetSchema.optional() }),
    options: toAuthority,
  },
  {
    name: CHARACTER_EVENTS.drop,
    schema: z.object({ actorId, uid, qty: z.number().int().min(1).optional() }),
    options: toAuthority,
  },
  {
    name: CHARACTER_EVENTS.split,
    schema: z.object({ actorId, uid, qty: z.number().int().min(1), to: gridTargetSchema }),
    options: toAuthority,
  },
  {
    name: CHARACTER_EVENTS.dropped,
    schema: looseStackSchema
      .extend({
        actorId,
        at: z.tuple([z.number(), z.number(), z.number()]),
        dropId: z.string().min(1).optional().describe("Where it lies when it went to the shared ground: netState ground/<dropId>."),
        bagId: z.string().min(1).optional().describe("Where it now lies: the dropper's own loot bag, netState lootbag/<bagId>. Neither = destroyed."),
      })
      .describe("A stack left a sheet at a world point, with its instance data (wear, twists)."),
    options: toPeers,
  },
  {
    name: CHARACTER_EVENTS.bag,
    schema: z
      .object({
        actorId: actorId.describe("The bag's OWNER: the only character who sees it and may take from it (its sheet makes the bag)."),
        at: z.tuple([z.number(), z.number(), z.number()]).describe("Where it lies (settled onto the ground below)."),
        items: z
          .array(
            z.object({
              itemId: z.string().min(1),
              qty: z.number().int().min(1).default(1),
              twists: z.array(z.string().min(1)).max(8).optional().describe("Rolled twists for each instance (items that do not stack)."),
            }),
          )
          .max(64)
          .default([])
          .describe("New stacks to put in it (a creature's rolled drops)."),
        coins: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Item bag: copper to put in it (a kill's money). Body bag: the killed character's copper the owner may take."),
        share: z
          .boolean()
          .optional()
          .describe(
            "Item bag from a kill: share it with the owner's PARTY members in range (character-sheet `partyRange`) — items at or " +
              "above `rollRarity` go to a need/greed/pass roll, the rest round-robin, the copper split evenly; each member's " +
              "share lies in a bag of their own. No party in range = the owner's bag, as without it.",
          ),
        body: z.string().min(1).optional().describe("A killed character: the bag offers what is theirs (`carried`, `coins`, `offer`) instead; the victim is loot-locked while it lasts."),
        offer: z.array(z.string().min(1)).max(32).optional().describe("Body bag: the uids in `body`'s sheet the owner may CHOOSE `takes` of (worn gear)."),
        takes: z.number().int().min(1).optional().describe("Body bag: how many of `offer` may be taken (default 1)."),
        carried: z.array(z.string().min(1)).max(256).optional().describe("Body bag: the uids in `body`'s sheet the owner may take freely, as many as fit (their bags' contents)."),
        seconds: z
          .number()
          .min(-1)
          .optional()
          .describe("Lifetime in seconds; absent = the owner's character-sheet `bagSeconds`; -1 = until emptied."),
        from: z.string().optional().describe("What left it (a creature's id, the killed body): for the window title."),
      })
      .describe("Authority-internal: make a loot bag only `actorId` sees. Never accepted from a peer."),
  },
  {
    name: CHARACTER_EVENTS.loot,
    schema: z
      .object({
        actorId,
        bagId: z.string().min(1).describe("The bag (netState lootbag/<bagId>); refused unless actorId owns it and stands within `pickupRadius`."),
        index: z.number().int().min(0).optional().describe("Item bag: the stack to take; absent (with no other field) = everything that fits, and the copper."),
        uid: z.string().min(1).optional().describe("Body bag: a stack uid from its `carried` (any) or its `offer` (uses one of `takes`). Claimed corpse: one from its `offer`."),
        all: z.boolean().optional().describe("Body bag or corpse: every stack that fits, and the copper."),
        coins: z.boolean().optional().describe("Take only the copper (item or body bag)."),
        done: z.boolean().optional().describe("Body bag: leave the rest — the bag closes and the victim's lock ends. Claimed corpse: end the claim now (it passes to the dead character)."),
      })
      .describe(
        "Take from your own loot bag. What fits comes in with its instance data; what does not STAYS in the bag (a part of a " +
          "stack takes what fits). Refused with 'no room…' when nothing fits. What a soulbound slot protects is never taken from a body.",
      ),
    options: toAuthority,
  },
  {
    name: CHARACTER_EVENTS.pickup,
    schema: z
      .object({ actorId, dropId: z.string().min(1).describe("The ground item's id (netState ground/<dropId>).") })
      .describe("Pick a ground item up. Refused out of reach (character-sheet `pickupRadius`) or when nothing fits; what does not fit stays."),
    options: toAuthority,
  },
  {
    name: CHARACTER_EVENTS.transfer,
    schema: z
      .object({
        actorId: actorId.describe("The GIVER's body id (its character-sheet script carries the transfer out)."),
        toActorId: z.string().min(1).describe("The receiver's body id."),
        uid,
        qty: z.number().int().min(1).optional().describe("Units to move; default the whole stack."),
        to: gridTargetSchema.optional().describe("Receiver's cell to land in; default top-up, then the first free cell."),
        range: z.number().min(0).default(4).describe("Metres the two bodies may be apart."),
        allowWorn: z.boolean().default(false).describe("Allow taking a worn item (looting a body); a trade moves carried items only."),
      })
      .describe(
        "Authority-internal: move a stack WITH its instance data from one character to another, atomically (both present, " +
          "within range, room for all of it). The primitive under a trade or a loot; not accepted from a peer.",
      ),
  },
  {
    name: CHARACTER_EVENTS.transferred,
    schema: looseStackSchema
      .extend({ actorId, toActorId: z.string().min(1) })
      .describe("A stack moved from one character (actorId) to another, with its instance data."),
    options: toPeers,
  },
  {
    name: CHARACTER_EVENTS.refused,
    schema: z.object({ actorId, request: z.string(), error: z.string() }),
    options: toPeers,
  },
  {
    name: CHARACTER_EVENTS.use,
    schema: z
      .object({ actorId, slot: z.enum(BELT_SLOTS as [EquipmentSlot, ...EquipmentSlot[]]).describe("The belt slot to use from.") })
      .describe("Use one item from the belt. Allowed in combat; refused during the shared belt cooldown (sheet `beltReadyAt`)."),
    options: toAuthority,
  },
  {
    name: CHARACTER_EVENTS.used,
    schema: z
      .object({
        actorId,
        slot: z.enum(EQUIPMENT_SLOTS),
        itemId: z.string().min(1),
        skill: z.string().describe("The item's `skills.use` (\"\" = none): what the game should apply."),
      })
      .describe("An item left the belt. Act on it only on the authority, and only from a local emission (no `meta.from`)."),
    options: toPeers,
  },
  {
    name: CHARACTER_EVENTS.swap,
    schema: z
      .object({ actorId, set: z.union([z.literal(0), z.literal(1)]).optional().describe("Set to swap to; absent = the other one.") })
      .describe("Swap the weapon set in hand (netState hand/<bodyId>). Completes after the sheet's `swapSeconds`; allowed in combat."),
    options: toAuthority,
  },
  {
    name: CHARACTER_EVENTS.roll,
    schema: z
      .object({
        actorId,
        rollId: z.string().min(1).describe("The roll (netState lootroll/<rollId>); refused unless actorId is one of its `eligible`."),
        choice: z.enum(ROLL_CHOICES).describe("need beats greed; pass gives up the item."),
      })
      .describe("Answer a party loot roll, once. The roll is settled when everyone has answered or its time is up (no answer = pass)."),
    options: toAuthority,
  },
  {
    name: CHARACTER_EVENTS.rolled,
    schema: z
      .object({
        rollId: z.string().min(1),
        itemId: z.string().min(1),
        qty: z.number().int().min(1),
        from: z.string().optional().describe("What dropped it."),
        winner: z.string().min(1).describe("Body id that got it (the killer when everyone passed)."),
        choice: z.enum(ROLL_CHOICES).describe("The winning tier; pass = everyone passed."),
        roll: z.number().int().min(1).max(100).nullable().describe("The winner's 1–100; null when everyone passed."),
        rolls: z
          .array(z.object({ actorId: z.string().min(1), choice: z.enum(ROLL_CHOICES), roll: z.number().int().min(1).max(100).optional() }))
          .describe("Every eligible member's answer and, in the winning tier, their roll."),
      })
      .describe("A party loot roll was settled; the item now lies in a bag only the winner sees. Party UIs print one line per item."),
    options: toPeers,
  },
  {
    name: CHARACTER_EVENTS.soulbind,
    schema: z
      .object({
        actorId,
        slot: z.enum(EQUIPMENT_SLOTS).describe("The equipment slot."),
        bound: z.boolean().default(true).describe("true = soulbind the slot to the item worn there now; false = free the slot."),
      })
      .describe(
        "Authority-internal (admin, the console's /soulbind): set one soulbound slot directly, ignoring the binder's slot " +
          "count and price. Never accepted from a peer; players use a soul binder (soul.attune).",
      ),
  },
  {
    name: CHARACTER_EVENTS.corpse,
    schema: z
      .object({
        actorId: actorId.describe("The DEAD character: their sheet's grid stacks (all but the entrusted) and copper leave into the corpse."),
        at: z.tuple([z.number(), z.number(), z.number()]).describe("Where the corpse lies (settled onto the ground below)."),
        seconds: z.number().min(1).default(900).describe("The corpse's whole lifetime from the death; then it and whatever is left are gone."),
        killer: z.string().min(1).optional().describe("A killing PLAYER's body id: they hold the corpse first, for `claimSeconds`."),
        claimSeconds: z.number().min(0).default(0).describe("With `killer`: seconds the killer alone may take from it (0 = no claim)."),
        offer: z
          .array(z.string().min(1))
          .max(32)
          .default([])
          .describe("With a claim: uids of the dead character's WORN items the killer may choose `takes` of (the game decides)."),
        takes: z.number().int().min(0).default(1).describe("With a claim: how many of `offer` the killer may take."),
        plunder: z
          .number()
          .min(0)
          .default(0)
          .describe("Seconds the dead character is plundered after a worn item is taken (no second worn item meanwhile); 0 = off."),
        from: z.string().optional().describe("For the window title (the dead character)."),
      })
      .describe(
        "Authority-internal (where death is decided): make the dead character's CORPSE, a loot bag holding what they carried " +
          "(lootbag/<id> with `corpse`). With a killer's claim the killer owns it first and the dead character is loot-locked; " +
          "then it is the dead character's until `seconds` after the death. Nothing at all to leave = no corpse. Never from a peer.",
      ),
  },
];
