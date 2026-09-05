import { z } from "zod";
import type { EventRegistrationOptions } from "../events.js";
import { ATTRIBUTES, EQUIPMENT_SLOTS } from "./items.js";
import { CONTAINERS } from "./sheet.js";

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
  /** authority → everyone: a stack left a sheet at a world point (spawn a pickup here). */
  dropped: "inventory.dropped",
  /** authority → everyone: a request was refused, with the reason (UIs toast it). */
  refused: "character.refused",
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
    schema: z.object({ actorId, itemId: z.string().min(1), qty: z.number().int().min(1).default(1) }),
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
    schema: z.object({
      actorId,
      itemId: z.string().min(1),
      qty: z.number().int().min(1),
      at: z.tuple([z.number(), z.number(), z.number()]),
    }),
    options: toPeers,
  },
  {
    name: CHARACTER_EVENTS.refused,
    schema: z.object({ actorId, request: z.string(), error: z.string() }),
    options: toPeers,
  },
];
