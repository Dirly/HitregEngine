import { z } from "zod";
import type { EventRegistrationOptions } from "./events.js";
import { clockWindowSchema, dialogueConditionSchema, tideConditionSchema, weatherBandSchema } from "./npc/conditions.js";

/**
 * Quest mechanics as registered building blocks. A quest is assembled from
 * four slots — a SOURCE (how it reaches the player), CONDITIONS (tests that
 * gate a step or a source), ACTIONS (what the player does: an objective's
 * `kind`) and CONSEQUENCES (what the world does in answer: an objective's
 * `then` (flags, an exclusive `choose`), and the quest-level `repeat` that offers it again). Every block is a name + Zod schema + description + scope, listed in
 * {@link questBlocks} and emitted in the engine spec (`questBlocks`).
 *
 * The registry only lists what the runtime implements: the `quest-log` and
 * `npc` builtins evaluate every block here on the session authority, and the
 * quest-play gate proves each one. A planned block that is not here does not
 * exist — the zone lint refuses it.
 */

export const QUEST_BLOCK_SLOTS = ["source", "condition", "action", "consequence"] as const;
export type QuestBlockSlot = (typeof QUEST_BLOCK_SLOTS)[number];

export const questBlockRaritySchema = z
  .object({
    perZone: z.number().int().min(0).optional().describe("At most this many quests of one zone may use the block."),
    perWorld: z.number().int().min(0).optional().describe("At most this many quests of the whole world may use the block."),
  })
  .describe("A cap that keeps a rare mechanic rare: the zone lint counts uses against it. Absent = common.");
export type QuestBlockRarity = z.infer<typeof questBlockRaritySchema>;

export interface QuestBlock {
  slot: QuestBlockSlot;
  name: string;
  /** The block's own fields (an action's extra objective fields, a condition's value, a source, a consequence). */
  schema: z.ZodType;
  description: string;
  /** world = reads shared world state (never changes it); character = reads or writes this character's own state only. */
  scope: "world" | "character";
  rarity?: QuestBlockRarity;
}

export class QuestBlockRegistry {
  private readonly blocks = new Map<string, QuestBlock>();

  register(block: QuestBlock): void {
    const key = `${block.slot}:${block.name}`;
    if (this.blocks.has(key)) throw new Error(`quest block ${key} is already registered`);
    if (block.rarity) questBlockRaritySchema.parse(block.rarity);
    this.blocks.set(key, block);
  }

  get(slot: QuestBlockSlot, name: string): QuestBlock | undefined {
    return this.blocks.get(`${slot}:${name}`);
  }

  has(slot: QuestBlockSlot, name: string): boolean {
    return this.blocks.has(`${slot}:${name}`);
  }

  names(slot: QuestBlockSlot): string[] {
    return this.list(slot).map((b) => b.name);
  }

  list(slot?: QuestBlockSlot): QuestBlock[] {
    return [...this.blocks.values()].filter((b) => !slot || b.slot === slot);
  }

  /** slot -> name -> { description, scope, rarity?, schema (JSON Schema) }: the spec's `questBlocks`. */
  describe(): Record<QuestBlockSlot, Record<string, unknown>> {
    const out = { source: {}, condition: {}, action: {}, consequence: {} } as Record<QuestBlockSlot, Record<string, unknown>>;
    for (const b of this.blocks.values()) {
      out[b.slot][b.name] = {
        description: b.description,
        scope: b.scope,
        ...(b.rarity ? { rarity: b.rarity } : {}),
        schema: z.toJSONSchema(b.schema, { io: "input", unrepresentable: "any" }),
      };
    }
    return out;
  }
}

// -- shared shapes ---------------------------------------------------------------------------

export const questAreaSchema = z
  .object({
    label: z.string(),
    center: z.tuple([z.number(), z.number()]),
    radius: z.number().min(50),
  })
  .describe(
    "Approximate search region [world X, world Z], never an exact objective marker. Only the compass may visualize this region. " +
      "It is also where `visit`, `endure` and an untargeted `perform` count.",
  );
export type QuestArea = z.infer<typeof questAreaSchema>;

/** A perform action's name: lower-case, the word a player types ("dance" for /dance). */
export const PERFORM_ACTION_NAME = /^[a-z][a-z0-9-]{0,23}$/;

// -- actions: the extra fields of each objective kind ------------------------------------------

export const ACTION_FIELDS = {
  visit: {},
  kill: {},
  collect: {
    from: z
      .string()
      .min(1)
      .optional()
      .describe(
        "A DROP FROM THE SLAIN: a kill-target expression (`tag:creature:<id>`, a template id, an entity id — matched exactly as a " +
          "`kill` target) whose bodies, killed by this character while the step is open and short of `required`, put one `target` item " +
          "straight into the killer's bags (a per-character quest drop: nobody else sees it and no template's loot changes). Absent = the " +
          "item comes from anywhere (a dialogue `give`, a template's own loot, a pickup).",
      ),
    chance: z
      .number()
      .min(0.05)
      .max(1)
      .default(1)
      .describe("With `from`: the chance each such kill drops one (1 = every kill)."),
  },
  talk: {},
  interact: {},
  read: {},
  deliver: {
    item: z.string().min(1).describe("Item id handed over: each interact at `target` takes as many as are still `required` from the bags."),
  },
  endure: {
    seconds: z
      .number()
      .int()
      .min(1)
      .max(3600)
      .describe("Unbroken seconds to stay inside the area while `when` holds. Leaving or the condition breaking starts the count over."),
  },
  escort: {
    radius: z
      .number()
      .min(3)
      .max(60)
      .default(15)
      .describe(
        "Metres the character must stay within of the escorted NPC. Coming this close with the step open STARTS the escort; while " +
          "inside it the NPC walks on, outside it the NPC waits where it is.",
      ),
    grace: z
      .number()
      .min(1)
      .max(120)
      .default(10)
      .describe("Seconds in a row the character may be outside `radius` before the escort FAILS (the NPC walks back to its post; come back to it to try again)."),
  },
  perform: {
    action: z.string().regex(PERFORM_ACTION_NAME).describe("Perform-action name (\"dance\", \"dig\"): the engine vocabulary plus the quest-log's `performActions` asset."),
    range: z.number().min(1).max(50).default(6).describe("With a `target`: metres from that entity the performance counts within."),
  },
} as const;
export type QuestActionKind = keyof typeof ACTION_FIELDS;

const ACTION_TEXT: Record<QuestActionKind, string> = {
  visit:
    "DISCOVER a place: stand inside the objective's `area` (falls back to the quest's) — arriving completes it. A quest that offers " +
    "itself on arrival is an `auto` source with an `area`.",
  kill: "Defeat `target`: an entity id, its `<target>-` prefix, or a spawned `#<target>#` template id (from the project's killEvent).",
  collect:
    "Carry `required` of item `target`. With `from`, the item drops from the slain: each matching kill by this character while " +
    "the step is open rolls `chance` and gives one into the bags (counted like any carried item, so it is also a carry check).",
  talk: "Open a conversation with the NPC whose entity id is `target`.",
  interact: "Use entity `target` (tagged `interactable`): the client sends player.interact; the authority checks owner and range. An entity running the `npc` builtin (a quest object holding a dialogue) is used by opening its conversation (npc.talked): each conversation opened counts once.",
  read: "Open the readable entity `target` (an `npc` builtin with `readable: true` — a sign, a slab, a book); its text resolves like dialogue.",
  deliver: "Leave `required` × `item` at entity `target`: interacting with it while carrying the item hands them over (taken from the bags). For an `npc` entity, opening its conversation is the interaction.",
  endure: "Stay inside the objective's area (or the quest's) for `seconds`, unbroken, while `when` holds.",
  escort:
    "Walk the NPC `target` (an `npc` builtin with an `escort` param: its route) from its post to the route's end. It starts when the " +
    "character comes within `radius` with the step open, and completes when the NPC arrives while the character stayed near. Fails " +
    "(the step stays open, the NPC walks back, retry by going to it) when the character is outside `radius` for `grace` s in a row " +
    "or the NPC dies (combat dead). Shared world: ONE NPC body everyone sees, claimed by one character at a time (netState " +
    "escort/<npcId>); another character's escort of it waits until it is back at its post.",
  perform:
    "Perform the named action (player.perform: /dance, /dig) within `range` of entity `target`, else inside the objective's area " +
    "(or the quest's); no target and no area = anywhere.",
};

// -- sources -------------------------------------------------------------------------------------

const npcSourceSchema = z
  .object({ kind: z.literal("npc"), ref: z.string().default("").describe("NPC entity id; empty = the quest's `giver`.") })
  .describe("Offered by a person: an `acceptQuest` in that NPC's dialogue.");
const objectSourceSchema = z
  .object({ kind: z.literal("object"), ref: z.string().default("").describe("Entity id of the object; empty = the quest's `giver`.") })
  .describe(
    "Offered by a thing, not a person: a notice board, a carved stone, a lost satchel — an entity running the `npc` builtin with " +
      "`face: false` (and `readable: true` for text), whose dialogue carries the `acceptQuest`.",
  );
const autoSourceSchema = z
  .object({
    kind: z.literal("auto"),
    when: dialogueConditionSchema.optional().describe("Starts once this holds (clock, weather, flag, item, level …); absent = at once."),
    area: questAreaSchema.optional().describe("Starts once the character stands inside this region."),
  })
  .describe(
    "Starts by itself, with no announcement of its own: the quest-log of a character watching it (`autoStart` for a fresh " +
      "journal, `autoOffer` at any time) accepts it on the authority the moment `when` and `area` hold. Nothing advertises it: " +
      "players find it through leads (rumour, lore, a sight), never a marker.",
  );

const presenceSourceSchema = z
  .object({ kind: z.literal("presence"), ref: z.string().default("").describe("Entity id; empty = the quest's `giver`.") })
  .describe(
    "Offered by someone or something that is only THERE while a condition holds: an entity running the `npc` builtin plus the " +
      "`presence` builtin (its `when`: an hour window, weather, a flag). Shared world: it is never removed, only hidden per player, " +
      "and a conversation open with it holds it until the conversation ends.",
  );

export const questSourceSchema = z
  .discriminatedUnion("kind", [npcSourceSchema, objectSourceSchema, autoSourceSchema, presenceSourceSchema])
  .describe(
    "How the quest reaches the player. Absent = `npc` when `giver` is set, else `auto`. Only an `npc` source is advertised " +
      "(a giver marker); object, presence and auto starts carry no marker, map or compass pointer.",
  );
export type QuestSource = z.infer<typeof questSourceSchema>;

// -- consequences --------------------------------------------------------------------------------

const setFlagSchema = z
  .object({ do: z.literal("setFlag"), flag: z.string().min(1).describe("Flag name.") })
  .describe("Remember something about this character (npc/<bodyId>.flags) — dialogue can then react to it.");
const clearFlagSchema = z.object({ do: z.literal("clearFlag"), flag: z.string().min(1).describe("Flag name.") }).describe("Forget a per-character flag.");
const CHOICE_ID = /^[a-z][a-z0-9-]{0,47}$/;
export const chooseConsequenceSchema = z
  .object({
    do: z.literal("choose"),
    choice: z
      .string()
      .regex(CHOICE_ID)
      .describe("The decision's id (\"bell-fate\"), shared by every option of it: at least two steps of the quest carry it, each with its own `option`."),
    option: z
      .string()
      .regex(CHOICE_ID)
      .describe("This step's option (\"rang\"). Completing the step sets the flag `<choice>=<option>` (\"bell-fate=rang\") for dialogue to branch on."),
  })
  .describe(
    "An exclusive choice: the steps of a quest that carry the same `choice` are alternatives. Completing one sets the per-character " +
      "flag `<choice>=<option>` and LOCKS the others (they never progress, and count as settled for the quest's completion and for " +
      "`after`). The flag also locks every other option of the same choice in any other quest: a character decides once.",
  );
export type ChooseConsequence = z.infer<typeof chooseConsequenceSchema>;

export const questConsequenceSchema = z
  .discriminatedUnion("do", [setFlagSchema, clearFlagSchema, chooseConsequenceSchema])
  .describe("What happens, on the authority and for this character only, the moment the objective completes.");
export type QuestConsequence = z.infer<typeof questConsequenceSchema>;

/** The per-character flag an exclusive choice's option sets: `<choice>=<option>`. */
export const choiceFlag = (choice: string, option: string): string => `${choice}=${option}`;

/** Whether these flags lock option `option` of `choice`: another option of it was already taken. */
export function choiceLockedByFlags(flags: Readonly<Record<string, boolean>> | undefined, choice: string, option: string): boolean {
  const prefix = `${choice}=`;
  for (const [k, v] of Object.entries(flags ?? {})) if (v && k.startsWith(prefix) && k !== choiceFlag(choice, option)) return true;
  return false;
}

// -- escort --------------------------------------------------------------------------------------

/** netState namespace of escort claims: escort/<npcId>. */
export const ESCORT_NETSTATE = "escort";
export const escortKey = (npcId: string): string => `${ESCORT_NETSTATE}/${npcId}`;

export const escortRouteSchema = z
  .object({
    route: z
      .array(z.tuple([z.number(), z.number(), z.number()]))
      .min(1)
      .describe(
        "World points [x, y, z] ON THE GROUND walked in order after the NPC's own post (its placed position); the last is the destination. " +
          "Straight lines between them: the place owner keeps them clear and walkable.",
      ),
    speed: z.number().min(0.5).max(8).default(1.6).describe("Walking speed, m/s (1.6 = a walk a player keeps up with)."),
    hold: z.number().min(1).max(120).default(8).describe("Seconds it stays at the destination (or where it failed) before walking back to its post (at least 1: the escorter's quest-log reads the arrival in that time)."),
  })
  .strict()
  .describe(
    "The `escort` param of an `npc` builtin: makes it an NPC an `escort` step can walk. The authority moves it along the route while " +
      "a claim (netState escort/<npcId>) is live and every client places it from that claim. Its own collider (if any) stays at the " +
      "post: give an escorted NPC none.",
  );
export type EscortRoute = z.infer<typeof escortRouteSchema>;

export const escortStateSchema = z
  .object({
    by: z.string().min(1).describe("Body id of the character escorting (the claim): only its step counts the arrival; anyone else's waits."),
    quest: z.string().min(1).describe("Quest id of the step being done."),
    objective: z.string().min(1).describe("Objective id of the step being done."),
    state: z
      .enum(["walk", "arrived", "failed", "return"])
      .describe("walk: under way; arrived: at the destination (the step completes); failed: left behind or killed; return: walking back to its post (the claim ends there)."),
    d: z.number().min(0).describe("Metres walked along the route from the post."),
    away: z.number().min(0).describe("Seconds in a row the escorter has been outside `radius`."),
    t: z.number().min(0).describe("Seconds spent in the arrived/failed state (the hold before walking back)."),
    radius: z.number().positive().describe("The step's radius, metres."),
    grace: z.number().positive().describe("The step's grace, seconds."),
  })
  .describe("An escort in progress, keyed escort/<npcId>: the claim is written by the quest-log, the walk by the npc builtin, both on the authority.");
export type EscortState = z.infer<typeof escortStateSchema>;

type P3 = readonly [number, number, number];

/** Total length (x, z plane) of an escort walk: the post, then the route. */
export function escortLength(post: P3, route: readonly P3[]): number {
  let L = 0;
  let a = post;
  for (const b of route) {
    L += Math.hypot(b[0] - a[0], b[2] - a[2]);
    a = b;
  }
  return L;
}

/** Where an escorted NPC stands after `d` metres along post + route, and the yaw it faces (atan2(dx, dz) of its leg; null = no leg yet). */
export function escortPoint(post: P3, route: readonly P3[], d: number): { at: [number, number, number]; yaw: number | null } {
  let a = post;
  let left = Math.max(0, d);
  let yaw: number | null = null;
  for (const b of route) {
    const dx = b[0] - a[0], dz = b[2] - a[2];
    const L = Math.hypot(dx, dz);
    if (L > 1e-6) yaw = Math.atan2(dx, dz);
    if (left <= L && L > 1e-6) {
      const f = left / L;
      return { at: [a[0] + dx * f, a[1] + (b[1] - a[1]) * f, a[2] + dz * f], yaw };
    }
    left -= L;
    a = b;
  }
  return { at: [a[0], a[1], a[2]], yaw };
}

/**
 * One authority tick of an escort: walk while the escorter is near, fail when it stays away `grace` s or the NPC is dead,
 * arrive at the end, hold, walk back. Null = back at the post: the claim ends (delete the key).
 */
export function stepEscort(
  s: EscortState,
  i: { dt: number; length: number; speed: number; hold: number; near: boolean; dead: boolean },
): EscortState | null {
  if (s.state === "walk") {
    if (i.dead) return { ...s, state: "failed", t: 0 };
    if (!i.near) {
      const away = s.away + i.dt;
      return away > s.grace ? { ...s, away, state: "failed", t: 0 } : { ...s, away };
    }
    const d = Math.min(i.length, s.d + i.speed * i.dt);
    return d >= i.length ? { ...s, d, away: 0, state: "arrived", t: 0 } : { ...s, d, away: 0 };
  }
  if (s.state === "arrived" || s.state === "failed") {
    const t = s.t + i.dt;
    return t >= i.hold ? { ...s, t, state: "return" } : { ...s, t };
  }
  const d = s.d - i.speed * i.dt;
  return d <= 0 ? null : { ...s, d };
}

export const questRepeatSchema = z
  .object({
    after: z
      .union([
        z.number().min(1).max(720).describe("World-clock hours after the last completion (24 = a full day-night cycle later)."),
        z.literal("day").describe("The next world day: offered again from the first midnight after the last completion (a daily)."),
      ])
      .describe("When the quest is offered again, measured on the world clock (netState world/day * 24 + world/hour), never on real time."),
    limit: z.number().int().min(1).optional().describe("Completions in all, the first one included; absent = no cap."),
  })
  .strict()
  .describe(
    "The quest-level `repeat` field (not an objective `then`): once complete, the quest is offered again by its own source after " +
      "`after`; accepting it again resets its objectives and completing it pays its rewards again. Per character, on the authority: " +
      "the journal keeps `completions` and `completedAt` (world hours). No clock in the scene = never offered again.",
  );
export type QuestRepeat = z.infer<typeof questRepeatSchema>;

/**
 * Why a completed repeatable quest is not on offer again at world time `now` (hours), or null when it is.
 * A `completedAt` later than `now` means the world clock restarted (a fresh server): the wait is over.
 */
export function repeatProblem(repeat: QuestRepeat, state: { completions?: number; completedAt?: number }, now: number | null | undefined): string | null {
  const done = state.completions ?? 1;
  if (repeat.limit !== undefined && done >= repeat.limit) return `completed ${done} times (the limit)`;
  if (state.completedAt === undefined) return null;
  if (typeof now !== "number" || !Number.isFinite(now)) return "not yet (no world clock)";
  if (now < state.completedAt) return null;
  const at = repeat.after === "day" ? (Math.floor(state.completedAt / 24) + 1) * 24 : state.completedAt + repeat.after;
  return now >= at ? null : `not yet (again in ${Math.ceil(at - now)} h)`;
}

/** "daily" / "every 6 h", plus the cap: how a quest log names a repeatable. */
export function repeatLabel(repeat: QuestRepeat): string {
  const when = repeat.after === "day" ? "daily" : `every ${repeat.after} h`;
  return repeat.limit !== undefined ? `${when}, ${repeat.limit} times at most` : when;
}

// -- perform vocabulary --------------------------------------------------------------------------

export const performActionSchema = z.object({
  name: z.string().regex(PERFORM_ACTION_NAME).describe("The word a player types without the slash (\"dance\")."),
  label: z.string().min(1).describe("Shown to the player (\"Dance\")."),
  description: z.string().default(""),
});
export type PerformAction = z.infer<typeof performActionSchema>;

export const performActionsSchema = z
  .object({ actions: z.array(performActionSchema).min(1) })
  .describe("A project's extra perform actions (data type `performActions`), added to the engine vocabulary by the quest-log's `performActions` param.");

/** The engine's perform vocabulary; a project adds to it by data, never removes from it. */
export const DEFAULT_PERFORM_ACTIONS: readonly PerformAction[] = [
  { name: "dance", label: "Dance", description: "" },
  { name: "dig", label: "Dig", description: "" },
  { name: "kneel", label: "Kneel", description: "" },
  { name: "pray", label: "Pray", description: "" },
  { name: "sing", label: "Sing", description: "" },
  { name: "wave", label: "Wave", description: "" },
  { name: "sit", label: "Sit", description: "" },
  { name: "listen", label: "Listen", description: "" },
];

/** Metres between where a client says it performed and where the authority has its body. */
export const PERFORM_TOLERANCE = 4;
/** Metres a player may stand from an entity it interacts with. */
export const INTERACT_RANGE = 4;

// -- events --------------------------------------------------------------------------------------

export const QUEST_EVENTS = {
  interact: "player.interact",
  interacted: "player.interacted",
  perform: "player.perform",
  performed: "player.performed",
  read: "player.read",
} as const;

const actorId = z.string().min(1).describe("Body entity id of the character (its owner must be the sender).");
const entityId = z.string().min(1).describe("Entity id acted on.");
const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const toAuthority: EventRegistrationOptions = { replicate: "to-authority" };

export const questEventDecls: ReadonlyArray<{ name: string; schema: z.ZodType; options?: EventRegistrationOptions }> = [
  {
    name: QUEST_EVENTS.interact,
    schema: z
      .object({ actorId, entityId })
      .describe("A player asks to use an `interactable` entity. Refused unless the sender owns the body and stands within INTERACT_RANGE (4 m)."),
    options: toAuthority,
  },
  { name: QUEST_EVENTS.interacted, schema: z.object({ actorId, entityId }).describe("Authority-internal: an interact request passed its checks, or a conversation opened with an `npc` entity (its use).") },
  {
    name: QUEST_EVENTS.perform,
    schema: z
      .object({
        actorId,
        action: z.string().regex(PERFORM_ACTION_NAME).describe("Perform-action name from the vocabulary (\"dance\")."),
        at: vec3.describe(
          "Where the client believes its body is. Refused when more than PERFORM_TOLERANCE (4 m) from the authority's body; the authority's position is what counts.",
        ),
      })
      .describe("A player performs a named action where it stands (/dance, /dig). Rate-limited per character by the quest-log (`performCooldown`)."),
    options: toAuthority,
  },
  {
    name: QUEST_EVENTS.performed,
    schema: z
      .object({ actorId, action: z.string(), at: vec3.describe("The authority's body position.") })
      .describe("Authority-internal: a perform request passed its checks — presentation and other scripts may react."),
  },
  {
    name: QUEST_EVENTS.read,
    schema: z.object({ actorId, entityId }).describe("Authority-internal: a character opened a readable entity (`npc` builtin with readable: true)."),
  },
];

// -- the engine registry -------------------------------------------------------------------------

const conditionBlock = (name: string, schema: z.ZodType, description: string, scope: "world" | "character"): QuestBlock => ({
  slot: "condition",
  name,
  schema,
  description: `A field of the condition object (\`when\`, a dialogue \`if\`). ${description}`,
  scope,
});

export function registerEngineQuestBlocks(r: QuestBlockRegistry): void {
  r.register({ slot: "source", name: "npc", schema: npcSourceSchema, description: npcSourceSchema.description ?? "", scope: "character" });
  r.register({ slot: "source", name: "object", schema: objectSourceSchema, description: objectSourceSchema.description ?? "", scope: "character" });
  r.register({ slot: "source", name: "auto", schema: autoSourceSchema, description: autoSourceSchema.description ?? "", scope: "character" });
  r.register({ slot: "source", name: "presence", schema: presenceSourceSchema, description: presenceSourceSchema.description ?? "", scope: "world" });

  r.register(conditionBlock("clock", clockWindowSchema, clockWindowSchema.description ?? "", "world"));
  r.register(conditionBlock("weather", weatherBandSchema, weatherBandSchema.description ?? "", "world"));
  r.register(conditionBlock("tide", tideConditionSchema, tideConditionSchema.description ?? "", "world"));
  r.register(conditionBlock("quest", z.object({ quest: z.string(), status: z.string().optional() }), "Another quest's status in this character's journal.", "character"));
  r.register(conditionBlock("flag", z.object({ flag: z.string(), is: z.boolean().optional() }), "A per-character memory flag.", "character"));
  r.register(conditionBlock("level", z.object({ level: z.number().int().min(1) }), "Character level at least this.", "character"));
  r.register(conditionBlock("item", z.object({ item: z.string(), qty: z.number().int().optional() }), "Carries at least `qty` of the item.", "character"));
  r.register(conditionBlock("coins", z.object({ coins: z.number().int().min(0) }), "Carries at least this many copper.", "character"));

  for (const name of Object.keys(ACTION_FIELDS) as QuestActionKind[]) {
    r.register({ slot: "action", name, schema: z.object(ACTION_FIELDS[name]), description: ACTION_TEXT[name], scope: "character" });
  }

  r.register({
    slot: "consequence",
    name: "flag",
    schema: z.discriminatedUnion("do", [setFlagSchema, clearFlagSchema]),
    description: "setFlag / clearFlag on this character when the objective completes (per-character, saved with it).",
    scope: "character",
  });
  r.register({ slot: "consequence", name: "choose", schema: chooseConsequenceSchema, description: chooseConsequenceSchema.description ?? "", scope: "character" });
  r.register({ slot: "consequence", name: "repeat", schema: questRepeatSchema, description: questRepeatSchema.description ?? "", scope: "character" });
}

/** The engine's quest blocks: what the quest runtime implements, nothing more. */
export const questBlocks = new QuestBlockRegistry();
registerEngineQuestBlocks(questBlocks);

/** Condition block names a condition uses (recursively; combinators and qualifiers are not blocks). */
export function conditionBlockNames(c: unknown, out = new Set<string>()): Set<string> {
  if (!c || typeof c !== "object") return out;
  for (const [k, v] of Object.entries(c as Record<string, unknown>)) {
    if (k === "all" || k === "any") for (const x of (v as unknown[]) ?? []) conditionBlockNames(x, out);
    else if (k === "not") conditionBlockNames(v, out);
    else if (k !== "is" && k !== "qty" && k !== "status") out.add(k);
  }
  return out;
}
