import { z } from "zod";

/**
 * What a body is fighting and whom it is helping: netState `target/<bodyId>`.
 *
 * Two slots, one per side, so a hybrid never has to swap:
 *
 *   - `primary`  — the ENEMY it is fighting. A player gets it by landing a
 *     hit, by being hit while it has none, or by picking one (Tab, a click);
 *     a creature's brain publishes whom it is going for. A primary picked by
 *     hand (`manual`) is kept until it is cleared or dies; an automatic one
 *     follows the fight.
 *   - `secondary` — the FRIEND it is supporting: where heals, wards and a
 *     weapon's on-hit mending go. Picked by hand (a party frame, F1–F5) and
 *     kept until changed, or until that friend leaves or dies.
 *
 * Authority-written: a player's from its own request (the game checks the
 * sides), a creature's by its brain. Every tab reads the same answer, so a
 * party sees who its healer is on and a tank sees what the boss is on
 * (target-of-target: `target/<primary>.primary`).
 */
export const TARGET_NETSTATE = "target";

export function targetKey(bodyId: string): string {
  return `${TARGET_NETSTATE}/${bodyId}`;
}

export const targetStateSchema = z
  .object({
    primary: z.string().min(1).max(128).optional().describe("Body id of the enemy it is fighting. Absent = none."),
    manual: z
      .boolean()
      .optional()
      .describe("The primary was picked by hand (Tab, a click): an automatic pick never replaces it. Absent = automatic."),
    secondary: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe("Body id of the friend it is supporting (heals, wards, on-hit mending). Absent = none chosen: the game's fallback decides."),
  })
  .describe(
    "A body's targets, keyed target/<bodyId>: primary = the enemy it fights (hit = picked; Tab picks by hand), " +
      "secondary = the friend it supports (a party frame, F1–F5). Authority-written; a creature's brain publishes its primary. " +
      "Target-of-target is target/<primary>.primary.",
  );
export type TargetState = z.infer<typeof targetStateSchema>;

/** A body's targets, tolerant of absence and junk (both read as none). */
export function readTarget(store: { get(key: string): unknown } | undefined | null, bodyId: string): TargetState {
  const parsed = targetStateSchema.safeParse(store?.get(targetKey(bodyId)) ?? {});
  return parsed.success ? parsed.data : {};
}

/** The same target state with `next` merged in; `null` clears a field. Undefined fields keep their value. */
export function withTarget(
  current: TargetState,
  next: { primary?: string | null; secondary?: string | null; manual?: boolean | null },
): TargetState {
  const out: TargetState = { ...current };
  if (next.primary !== undefined) {
    if (next.primary) out.primary = next.primary;
    else delete out.primary;
    if (!next.primary) delete out.manual;
  }
  if (next.manual !== undefined && out.primary) {
    if (next.manual) out.manual = true;
    else delete out.manual;
  }
  if (next.secondary !== undefined) {
    if (next.secondary) out.secondary = next.secondary;
    else delete out.secondary;
  }
  return out;
}

/** Two target states say the same thing (a write that changes nothing is skipped). */
export function sameTarget(a: TargetState, b: TargetState): boolean {
  return a.primary === b.primary && !!a.manual === !!b.manual && a.secondary === b.secondary;
}

/**
 * Where support goes when it is not aimed: the friend a heal, a ward or an
 * on-hit mend lands on. In order:
 *
 *   1. `requested` — a party frame under the mouse, the friend under the
 *      crosshair — when it is a usable friend;
 *   2. the chosen `secondary`, when usable;
 *   3. whoever the primary enemy is attacking (target-of-target), when that
 *      is a usable friend — a paladin locked on the boss heals the tank;
 *   4. the most hurt party member in range (lowest health share, below full);
 *   5. the body itself.
 *
 * `usable` is the game's whole judgement (a friend, alive, in range, in
 * sight); this only orders the candidates, so the authority and a client
 * preview agree on the rule.
 */
export function resolveSupportTarget(opts: {
  self: string;
  requested?: string | undefined;
  secondary?: string | undefined;
  /** Whom the primary enemy is attacking (its own target/<id>.primary). */
  enemyTarget?: string | undefined;
  party?: readonly string[];
  usable(id: string): boolean;
  /** Health share 0..1 of a body (party fallback); absent = the party step is skipped. */
  health?(id: string): number;
}): string {
  const { self, usable } = opts;
  for (const id of [opts.requested, opts.secondary, opts.enemyTarget]) {
    if (id && (id === self || usable(id))) return id;
  }
  if (opts.health && opts.party?.length) {
    let best = "";
    let lowest = 1;
    for (const id of opts.party) {
      if (id === self || !usable(id)) continue;
      const share = opts.health(id);
      if (share < lowest) {
        lowest = share;
        best = id;
      }
    }
    if (best) return best;
  }
  return self;
}

/**
 * A creature fighting for a player: netState `pet/<petBodyId>`.
 *
 * Summoned by a trinket's skill and dismissed when the trinket comes off
 * (the game's pet keeper owns both); the record says whose it is and how it
 * behaves. The brain (mob-brain with `owner`) reads `stance` and `order`;
 * HUDs draw pet frames from it. Authority-written; the owner changes stance
 * and orders only by request.
 */
export const PET_NETSTATE = "pet";

export function petKey(petId: string): string {
  return `${PET_NETSTATE}/${petId}`;
}

export const PET_STANCES = ["assist", "defend", "passive"] as const;
export type PetStance = (typeof PET_STANCES)[number];
export const PET_ORDERS = ["follow", "stay", "attack"] as const;
export type PetOrder = (typeof PET_ORDERS)[number];

export const petStateSchema = z
  .object({
    owner: z.string().min(1).max(128).describe("Body id of the player it belongs to."),
    source: z
      .string()
      .min(1)
      .max(64)
      .describe("What summoned it (the game's skill id, a trinket's summon): one live pet per source per owner."),
    name: z.string().max(48).optional().describe("Display name on its frame. Absent = the creature's own name."),
    stance: z
      .enum(PET_STANCES)
      .default("assist")
      .describe(
        "assist = fights its owner's primary target and whatever fights its owner; defend = only what attacks it or its " +
          "owner; passive = never fights, only follows.",
      ),
    order: z
      .enum(PET_ORDERS)
      .default("follow")
      .describe("follow = stays at its owner's side between fights; stay = holds `at`; attack = goes for `orderTarget` now, whatever the stance."),
    orderTarget: z.string().min(1).max(128).optional().describe("The enemy an `attack` order names."),
    at: z
      .tuple([z.number(), z.number(), z.number()])
      .optional()
      .describe("World point a `stay` order holds, [x, y, z]."),
    role: z.enum(["tank", "damage", "support"]).optional().describe("What it is for, for its frame and tooltips. Opaque to the brain."),
  })
  .describe(
    "A creature fighting for a player, keyed pet/<petBodyId>: its owner, what summoned it, its stance " +
      "(assist/defend/passive) and its current order (follow/stay/attack). Authority-written by the game's pet keeper; " +
      "the owner changes it by request. mob-brain with an `owner` reads it.",
  );
export type PetState = z.infer<typeof petStateSchema>;

/** A pet's record, or null when the body is no pet (or the record is junk). */
export function readPet(store: { get(key: string): unknown } | undefined | null, petId: string): PetState | null {
  const value = store?.get(petKey(petId));
  if (value === undefined) return null;
  const parsed = petStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Whose pet a body is, or undefined. */
export function petOwner(store: { get(key: string): unknown } | undefined | null, bodyId: string): string | undefined {
  const value = store?.get(petKey(bodyId));
  return value && typeof value === "object" && typeof (value as { owner?: unknown }).owner === "string"
    ? (value as { owner: string }).owner
    : undefined;
}

/** Every pet an owner has out, in key order (a prefix scan of pet/). */
export function petsOf(store: { keys(prefix?: string): string[]; get(key: string): unknown } | undefined | null, ownerId: string): string[] {
  if (!store) return [];
  const out: string[] = [];
  for (const key of store.keys(`${PET_NETSTATE}/`)) {
    const id = key.slice(PET_NETSTATE.length + 1);
    if (petOwner(store, id) === ownerId) out.push(id);
  }
  return out;
}

/** The body that earns what a body does: its owner when it is a pet, else itself (kill credit, quest kills). */
export function creditedBody(store: { get(key: string): unknown } | undefined | null, bodyId: string): string {
  return petOwner(store, bodyId) ?? bodyId;
}
