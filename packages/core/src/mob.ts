import { z } from "zod";
import type { EventRegistrationOptions } from "./events.js";

/**
 * What a mob brain says out loud.
 *
 * The `mob-brain` builtin (in @hitreg/scripting) decides *where a body goes*
 * and *when it wants to swing*; it never decides what a swing DOES. That line
 * is the whole point: damage, abilities, cooldowns, threat and loot differ per
 * game, and a brain that reached into any of them would be a game script
 * wearing an engine badge. So the brain emits, and the game's combat layer
 * listens — three lines to bridge `mob.attack` onto whatever "cast" means in
 * that game.
 *
 * Both events are AUTHORITY-INTERNAL (no replication): brains run only on the
 * session authority — a peer's copy of an NPC is net-suspended — so a `mob.*`
 * event arriving from the wire would be a second brain arguing with the first.
 * A game that wants clients to react (a "!" over an alerted mob) replicates
 * its own event off the back of these.
 *
 * The shapes live here in core, not in the scripting package, so a dedicated
 * server, a test or an AI tool can validate a mob event without loading the
 * script layer — the same reason `characterEventDecls` lives beside them.
 */

export const MOB_EVENTS = {
  /** authority-internal: this mob is in range and wants to hit its target. */
  attack: "mob.attack",
  /** authority-internal: the brain changed state (idle/roam/chase/attack/leash/dead). */
  state: "mob.state",
  /** authority-internal: the game telling a mob how angry to be, and at whom. */
  threat: "mob.threat",
  /** authority-internal: a mob pulling its neighbours into a fight. */
  alert: "mob.alert",
} as const;

/** The brain's state machine, in the order a fight walks through it. */
export const MOB_STATES = ["idle", "roam", "chase", "attack", "leash", "dead"] as const;
export type MobState = (typeof MOB_STATES)[number];

const mobId = z.string().min(1).describe("Body entity id of the mob (the thing that moves and swings, not the model child).");

export interface MobEventDecl {
  name: string;
  schema: z.ZodType;
  options?: EventRegistrationOptions;
}

export const mobEventDecls: readonly MobEventDecl[] = [
  {
    name: MOB_EVENTS.attack,
    schema: z.object({
      mobId,
      targetId: z.string().min(1).describe("Body entity id the mob is swinging at."),
      abilityId: z
        .string()
        .describe("One of the brain's `abilities` param, chosen at random; empty when the mob has none listed.")
        .default(""),
      aim: z
        .tuple([z.number(), z.number()])
        .describe("Unit horizontal direction [x, z] from the mob to its target — what a placed ability points at."),
      distance: z.number().min(0).describe("Horizontal metres to the target when the swing was requested."),
    }),
  },
  {
    name: MOB_EVENTS.state,
    schema: z.object({
      mobId,
      state: z.enum(MOB_STATES),
      previous: z.enum(MOB_STATES),
      targetId: z
        .string()
        .describe("Body it is fighting, or empty. Read this on `chase` to build pack pulls: everyone nearby takes the same target.")
        .default(""),
    }),
  },
  {
    name: MOB_EVENTS.threat,
    schema: z.object({
      mobId,
      sourceId: z.string().min(1).describe("Body entity id that earned the threat — whoever dealt the damage or landed the heal."),
      amount: z
        .number()
        .describe(
          "How much. The engine has no combat model and cannot know what a hit is worth, so this is the game's number: " +
            "damage dealt is the usual unit, healing is conventionally worth about half, and a threat drop is negative.",
        )
        .default(0),
      kind: z
        .enum(["add", "set", "taunt"])
        .describe(
          "add = accrue (the default, what damage does); set = replace the value outright; taunt = top the table AND " +
            "force the mob to look at this source for `seconds`.",
        )
        .default("add"),
      seconds: z.number().min(0).describe("Taunt duration. Ignored by every other kind.").default(3),
    }),
  },
  {
    name: MOB_EVENTS.alert,
    schema: z.object({
      mobId,
      targetId: z.string().min(1).describe("Body the alerting mob has picked a fight with."),
      at: z.tuple([z.number(), z.number(), z.number()]).describe("Where the shout came from — neighbours judge the radius against this, not against the mob's current position."),
      radius: z.number().min(0).describe("Metres the shout carries."),
      faction: z.string().describe("Who is shouting. A mob only answers its own faction; empty means 'anyone in earshot who shares my spawn area'.").default(""),
    }),
  },
];

/**
 * Replicated combat pools, by convention.
 *
 * The engine does not own a combat model — but it does have to know two facts
 * about a body to manage a population at all, and `NpcManager` already reads
 * them off netState to decide when to respawn something. Spelling them once
 * here keeps a brain, a server and a game agreeing on the key rather than each
 * one typing the string.
 *
 * A namespace/field split (`combat/<id>.hp`, never `combat.hp.<id>`) because
 * netState defines SCHEMAS PER NAMESPACE: a second dot in the namespace half
 * is rejected with a warning and writes nothing, which looks exactly like
 * combat not running.
 */
export const COMBAT_NETSTATE = "combat";

export const combatKey = {
  hp: (bodyId: string) => `${COMBAT_NETSTATE}/${bodyId}.hp`,
  maxHp: (bodyId: string) => `${COMBAT_NETSTATE}/${bodyId}.maxHp`,
  dead: (bodyId: string) => `${COMBAT_NETSTATE}/${bodyId}.dead`,
  /**
   * Who this body fights for. The rule everywhere is the simple one: a
   * DIFFERENT published faction is an enemy, the same one is not — so a mob
   * that publishes nothing is invisible to faction targeting and falls back to
   * tags, and two factions never need a matrix to be at war.
   */
  faction: (bodyId: string) => `${COMBAT_NETSTATE}/${bodyId}.faction`,
} as const;

/**
 * Entity ids with any published combat state.
 *
 * The only way to enumerate "everything that could be fought" without the
 * engine owning a combat model: whoever publishes a pool is a combatant. A
 * brain uses this to find enemies that carry no target tag — the other
 * faction's NPCs, which is what makes goblins-vs-dwarves work without either
 * side being tagged "player".
 */
export function combatants(netState: { keys(prefix?: string): string[] }): string[] {
  const ids = new Set<string>();
  for (const key of netState.keys(`${COMBAT_NETSTATE}/`)) {
    const rest = key.slice(COMBAT_NETSTATE.length + 1);
    const dot = rest.lastIndexOf(".");
    if (dot > 0) ids.add(rest.slice(0, dot));
  }
  return [...ids];
}
