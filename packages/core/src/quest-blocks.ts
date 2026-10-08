import { z } from "zod";
import type { EventRegistrationOptions } from "./events.js";
import { clockWindowSchema, dialogueConditionSchema, weatherBandSchema } from "./npc/conditions.js";

/**
 * Quest mechanics as registered building blocks. A quest is assembled from
 * four slots — a SOURCE (how it reaches the player), CONDITIONS (tests that
 * gate a step or a source), ACTIONS (what the player does: an objective's
 * `kind`) and CONSEQUENCES (what the world does in answer: an objective's
 * `then`). Every block is a name + Zod schema + description + scope, listed in
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
  collect: {},
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
  perform: {
    action: z.string().regex(PERFORM_ACTION_NAME).describe("Perform-action name (\"dance\", \"dig\"): the engine vocabulary plus the quest-log's `performActions` asset."),
    range: z.number().min(1).max(50).default(6).describe("With a `target`: metres from that entity the performance counts within."),
  },
} as const;
export type QuestActionKind = keyof typeof ACTION_FIELDS;

const ACTION_TEXT: Record<QuestActionKind, string> = {
  visit: "Stand inside the objective's `area` (falls back to the quest's).",
  kill: "Defeat `target`: an entity id, its `<target>-` prefix, or a spawned `#<target>#` template id (from the project's killEvent).",
  collect: "Carry `required` of item `target`.",
  talk: "Open a conversation with the NPC whose entity id is `target`.",
  interact: "Use entity `target` (tagged `interactable`): the client sends player.interact; the authority checks owner and range.",
  read: "Open the readable entity `target` (an `npc` builtin with `readable: true` — a sign, a slab, a book); its text resolves like dialogue.",
  deliver: "Leave `required` × `item` at entity `target`: interacting with it while carrying the item hands them over (taken from the bags).",
  endure: "Stay inside the objective's area (or the quest's) for `seconds`, unbroken, while `when` holds.",
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

export const questConsequenceSchema = z
  .discriminatedUnion("do", [
    z.object({ do: z.literal("setFlag"), flag: z.string().min(1) }).describe("Remember something about this character (npc/<bodyId>.flags) — dialogue can then react to it."),
    z.object({ do: z.literal("clearFlag"), flag: z.string().min(1) }).describe("Forget a per-character flag."),
  ])
  .describe("What happens, on the authority and for this character only, the moment the objective completes.");
export type QuestConsequence = z.infer<typeof questConsequenceSchema>;

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
  { name: QUEST_EVENTS.interacted, schema: z.object({ actorId, entityId }).describe("Authority-internal: an interact request passed its checks.") },
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
    schema: questConsequenceSchema,
    description: "setFlag / clearFlag on this character when the objective completes (per-character, saved with it).",
    scope: "character",
  });
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
