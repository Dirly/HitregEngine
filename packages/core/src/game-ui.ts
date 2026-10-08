import { z } from "zod";
import { EQUIPMENT_SLOTS } from "./character/items.js";
import { dialogueConditionSchema } from "./npc/conditions.js";
import { ACTION_FIELDS, questAreaSchema, questBlocks, questConsequenceSchema, questSourceSchema, type QuestArea, type QuestSource } from "./quest-blocks.js";

export const tooltipSchema = z.object({
  title: z.string(), subtitle: z.string().default(""), description: z.string().default(""),
  rows: z.array(z.object({ label: z.string(), value: z.string() })).default([]),
  hint: z.string().default(""),
}).describe("Presentation-only tooltip. Text is rendered literally, never as HTML.");

export const nineSliceSchema = z.object({
  texture: z.string().min(1), slice: z.number().int().positive(), border: z.number().positive(),
  repeat: z.enum(["stretch", "repeat", "round"]).default("stretch").describe("Edge sampling only; corner ornaments always retain their proportions. Use repeat with a seamless straight rail crop."),
}).describe("CSS nine-slice: slice is measured in SOURCE pixels; border is the displayed width. Preserve alpha outside ornaments and keep corner proportions fixed.");

export const chatLayoutSchema = z.object({
  active: z.string().default("all"), opacity: z.number().min(0).max(1).default(0.9),
  tabs: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/).max(64), name: z.string().min(1).max(24),
    channels: z.array(z.enum(["proximity", "zone", "global", "team", "party", "guild", "system"])).min(1),
    detached: z.boolean().default(false), opacity: z.number().min(0).max(1).default(0.9),
  })).min(1).max(12),
}).describe("Local chat receive filters and detached-window preferences. Filters operate only on messages delivered to this player; they never change server routing or membership.");

export const gameHudSchema = z.object({
  title: z.string().default("Inventory"),
  frames: z.object({ panel: nineSliceSchema, slot: nineSliceSchema, button: nineSliceSchema }),
  equipmentSlots: z.array(z.enum(EQUIPMENT_SLOTS)).min(1).refine(a => new Set(a).size === a.length, "duplicate equipment slot"),
  icons: z.record(z.string(), z.string()),
  sounds: z.record(z.enum(["hover", "click", "open", "close", "equip", "unequip", "drop", "error", "quest"]), z.string()),
  soundVolume: z.number().min(0).max(1).default(0.35),
  chat: chatLayoutSchema.prefault({ tabs: [{ id: "all", name: "All", channels: ["proximity", "zone", "global", "team", "party", "guild", "system"] }] }),
  windows: z.object({
    movable: z.boolean().default(true), rememberLayout: z.boolean().default(true),
    chatWidth: z.number().min(320).max(1000).default(510), chatHeight: z.number().min(220).max(700).default(310),
    chatMinWidth: z.number().min(280).default(330), chatMinHeight: z.number().min(180).default(220),
  }).prefault({}),
  status: z.object({
    texture: z.string(), width: z.number().positive(), height: z.number().positive(),
    bars: z.array(z.object({
      stat: z.enum(["hp", "stamina", "mana"]), label: z.string(), fill: z.string(),
      rect: z.tuple([z.number().nonnegative(), z.number().nonnegative(), z.number().positive(), z.number().positive()]),
    })),
  }).optional().describe("Status artwork at source dimensions. Bar rectangles [x,y,width,height] clip the fill without scaling its texture as values change."),
  tooltip: z.object({ delayMs: z.number().min(0).max(2000).default(180), maxWidth: z.number().min(160).max(480).default(280) }).prefault({}),
  navigation: z.object({
    clockEntity: z.string().default("sky").describe("Entity owning the day-night script; HUD reads its live dayNightHour so offline and replicated clocks match the sky."),
    townRadius: z.number().positive().default(1800), minimapRadius: z.number().positive().default(650),
    compassFov: z.number().min(60).max(180).default(150),
    compassResponseMs: z.number().min(0).max(300).default(55).describe("Visual heading smoothing time constant, in milliseconds; zero follows the camera immediately. Rendered every animation frame with wrap-safe angles."),
    questGuidance: z.literal("compass-only").default("compass-only"),
    mapMarkers: z.tuple([z.literal("player"), z.literal("town")]).default(["player", "town"]),
  }).prefault({}),
}).describe("Game HUD skin, equipment layout, audio and navigation policy. Quest areas are compass-only; maps never contain quests or other POIs.");
export type GameHud = z.infer<typeof gameHudSchema>;

const objectiveBase = {
  id: z.string().min(1),
  label: z.string().min(1),
  target: z.string().default("").describe("What the action is aimed at: an entity id (kill, talk, interact, read, deliver, perform) or an item id (collect). A kill may also name a spawn template id (every spawned copy counts) or `tag:<tag>` (every body carrying the tag, e.g. `tag:creature:wolf`)."),
  required: z.number().int().positive().default(1),
  area: questAreaSchema
    .optional()
    .describe("This step's own region (visit, endure, an untargeted perform); absent = the quest's `area`. A step in another town carries its own."),
  places: z
    .string()
    .default("")
    .describe("places asset id this step's label tokens resolve against; empty = the quest's `places`. How one quest's steps span several towns."),
  after: z.array(z.string()).default([]).describe("Objective ids of this quest that must be complete before this one can progress. Empty = no order."),
  scene: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Scene this step happens in when it is not the quest's world scene: an instance reached through a `portal` (e.g. a dungeon). Informational — progress is counted wherever the character is (the journal travels with it); tools use it to route there. Absent = the world scene.",
    ),
  when: dialogueConditionSchema
    .optional()
    .describe("Progress counts only while this holds, tested on the authority (clock, weather, flag, item, quest …; `met` and `bound` never hold here)."),
  then: z.array(questConsequenceSchema).default([]).describe("Consequences run once, on the authority, the moment this objective completes."),
};
const actionText = (kind: string): string => questBlocks.get("action", kind)?.description ?? kind;

export const questObjectiveSchema = z
  .discriminatedUnion("kind", [
    z.object({ ...objectiveBase, kind: z.literal("visit"), ...ACTION_FIELDS.visit }).describe(actionText("visit")),
    z.object({ ...objectiveBase, kind: z.literal("kill"), ...ACTION_FIELDS.kill }).describe(actionText("kill")),
    z.object({ ...objectiveBase, kind: z.literal("collect"), ...ACTION_FIELDS.collect }).describe(actionText("collect")),
    z.object({ ...objectiveBase, kind: z.literal("talk"), ...ACTION_FIELDS.talk }).describe(actionText("talk")),
    z.object({ ...objectiveBase, kind: z.literal("interact"), ...ACTION_FIELDS.interact }).describe(actionText("interact")),
    z.object({ ...objectiveBase, kind: z.literal("read"), ...ACTION_FIELDS.read }).describe(actionText("read")),
    z.object({ ...objectiveBase, kind: z.literal("deliver"), ...ACTION_FIELDS.deliver }).describe(actionText("deliver")),
    z.object({ ...objectiveBase, kind: z.literal("endure"), ...ACTION_FIELDS.endure }).describe(actionText("endure")),
    z.object({ ...objectiveBase, kind: z.literal("perform"), ...ACTION_FIELDS.perform }).describe(actionText("perform")),
  ])
  .describe("One step of a quest. `kind` is a registered action block (spec `questBlocks.action`); its extra fields are that block's.");
export type QuestObjective = z.infer<typeof questObjectiveSchema>;

export const questSchema = z.object({
  id: z.string().min(1), title: z.string().min(1), description: z.string(),
  objectives: z.array(questObjectiveSchema).min(1)
    .refine(a => new Set(a.map(o => o.id)).size === a.length, "duplicate objective id")
    .refine(a => a.every(o => o.after.every(x => x !== o.id && a.some(p => p.id === x))), "`after` names an objective this quest does not have (or itself)"),
  area: questAreaSchema.optional().describe("Approximate search region [world X, world Z], never an exact objective marker. Only the compass may visualize this region. Absent = no compass guidance (an errand inside a town)."),
  rewardXp: z.number().int().min(0).default(0),
  rewardCoins: z.number().int().min(0).default(0).describe("Coins paid on completion, in copper (100 copper = 1 silver, 100 silver = 1 gold)."),
  rewardItems: z.array(z.object({ itemId: z.string().min(1), qty: z.number().int().min(1).default(1) })).default([])
    .describe("Items given on completion. A hand-in is refused while they do not fit the bags."),
  giver: z.string().default("").describe("Entity id of the NPC (or object, see `source`) who offers it (its dialogue's `acceptQuest`). Empty = granted by a script (quest-log `autoStart` / `autoOffer`)."),
  turnIn: z.string().default("").describe(
    "Entity id of the NPC it is handed in to. Set = finishing the objectives makes it READY, and it completes (paying its " +
    "rewards) only through that NPC's dialogue (`turnInQuest`). Empty = it completes the moment the objectives do.",
  ),
  requires: z.array(z.string()).default([]).describe("Quest ids that must be COMPLETE before this one can be accepted (a chain)."),
  consume: z.boolean().default(false).describe("On hand-in, take the `collect` objectives' items out of the bags (the ore is handed over)."),
  level: z.number().int().min(1).default(1).describe("Suggested level, shown in the journal; never enforced."),
  places: z.string().default("").describe("places asset id (assets/places/<town>.json) its text's {dir:id} / {far:id} / {place:id} tokens resolve against — never write a compass word by hand. A step in another town names its own (objective `places`)."),
  source: questSourceSchema.optional(),
}).describe("Quest definition (assets/quests/<id>.json). Progress belongs to authority-owned quest journals, not this asset.");
export type Quest = z.infer<typeof questSchema>;
export type QuestInput = z.input<typeof questSchema>;
export const QUEST_STATUSES = ["active", "ready", "complete"] as const;
export type QuestStatus = (typeof QUEST_STATUSES)[number];
const questStateSchema = z.object({
  status: z.enum(QUEST_STATUSES).describe("active: objectives open; ready: objectives done, waiting to be handed in to the quest's `turnIn` NPC; complete: rewarded."),
  progress: z.record(z.string(), z.number().int().min(0)),
});
export type QuestState = z.infer<typeof questStateSchema>;
export const questJournalSchema = z.object({
  version: z.literal(1).default(1), tracked: z.string().nullable().default(null),
  quests: z.record(z.string(), questStateSchema).describe("Every quest the character has started: a started quest is always in the journal."),
  hidden: z.record(z.string(), questStateSchema).optional().describe(
    "LEGACY, never written: journals saved by an earlier build may carry quests here. `migrateJournal` (the quest-log on load) moves them into `quests`.",
  ),
});
export type QuestJournal = z.infer<typeof questJournalSchema>;

/** A quest's state in the journal (a legacy `hidden` entry included until it is migrated). */
export function questState(journal: QuestJournal | null | undefined, id: string): QuestState | undefined {
  return journal?.quests[id] ?? journal?.hidden?.[id];
}

/** Move a legacy journal's `hidden` quests into `quests`; the same journal when there is nothing to move. */
export function migrateJournal(journal: QuestJournal): QuestJournal {
  if (!journal.hidden) return journal;
  const { hidden, ...rest } = journal;
  return { ...rest, quests: { ...hidden, ...journal.quests } };
}

/** How the quest reaches the player: its `source`, else derived from `giver`. */
export function questSource(quest: Quest): QuestSource {
  if (quest.source) return quest.source;
  return quest.giver ? { kind: "npc", ref: quest.giver } : { kind: "auto" };
}

/** The region an objective counts in: its own `area`, else the quest's. */
export function objectiveArea(quest: Quest, objective: QuestObjective): QuestArea | undefined {
  return objective.area ?? quest.area;
}

/** The places asset an objective's label resolves against: its own, else the quest's. */
export function objectivePlaces(quest: Quest, objective: QuestObjective): string {
  return objective.places || quest.places;
}

/** Whether every objective this one waits on (`after`) is complete. */
export function objectiveOpen(quest: Quest, progress: Readonly<Record<string, number>>, objectiveId: string): boolean {
  const o = quest.objectives.find(x => x.id === objectiveId);
  if (!o) return false;
  return o.after.every(id => {
    const before = quest.objectives.find(x => x.id === id);
    return !!before && (progress[id] ?? 0) >= before.required;
  });
}

/** Shared navigation math: north = -Z, clockwise bearings, seam-safe wrap. */
export const bearing = (dx: number, dz: number): number => (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360;
export const bearingDelta = (target: number, heading: number): number => ((target - heading + 540) % 360) - 180;
export function nearbyTowns<T extends { center: readonly [number, number] }>(towns: readonly T[], x: number, z: number, radius: number): T[] {
  return towns.filter(t => Math.hypot(t.center[0] - x, t.center[1] - z) <= radius);
}

/**
 * Monotonic objective progress; completion/rewards can only happen once. A
 * quest with a `turnIn` NPC stops at "ready": only {@link turnInQuest} completes it.
 * An objective whose `after` steps are not complete does not progress.
 */
export function advanceQuest(journal: QuestJournal, quest: Quest, objectiveId: string, amount = 1): QuestJournal {
  const state = journal.quests[quest.id];
  const objective = quest.objectives.find(o => o.id === objectiveId);
  if (!state || state.status !== "active" || !objective || !Number.isFinite(amount) || amount <= 0) return journal;
  if (!objectiveOpen(quest, state.progress, objectiveId)) return journal;
  const was = state.progress[objectiveId] ?? 0;
  const now = Math.min(objective.required, was + Math.floor(amount));
  if (now <= was) return journal;
  const progress = { ...state.progress, [objectiveId]: now };
  const done = quest.objectives.every(o => (progress[o.id] ?? 0) >= o.required);
  const status: QuestStatus = !done ? "active" : quest.turnIn ? "ready" : "complete";
  const next: QuestState = { status, progress };
  return { ...journal, tracked: status === "complete" && journal.tracked === quest.id ? null : journal.tracked,
    quests: { ...journal.quests, [quest.id]: next } };
}

const emptyJournal = (): QuestJournal => questJournalSchema.parse({ quests: {} });

/** Why `quest` cannot be accepted into `journal` right now, or null when it can. */
export function questOfferProblem(journal: QuestJournal | null | undefined, quest: Quest): string | null {
  const state = questState(journal, quest.id);
  if (state) return state.status === "complete" ? "already completed" : "already accepted";
  for (const need of quest.requires) if (questState(journal, need)?.status !== "complete") return `requires "${need}" first`;
  return null;
}

/**
 * Accept a quest (a giver's dialogue, a script's autoStart); it becomes the tracked one when `track`.
 */
export function acceptQuest(journal: QuestJournal | null | undefined, quest: Quest, track = true): { journal: QuestJournal; error: string | null } {
  const base = journal ?? emptyJournal();
  const problem = questOfferProblem(base, quest);
  if (problem) return { journal: base, error: problem };
  const fresh: QuestState = { status: "active", progress: {} };
  const quests = { ...base.quests, [quest.id]: fresh };
  return { journal: { ...base, tracked: track || !base.tracked ? quest.id : base.tracked, quests }, error: null };
}

/** Hand a READY quest in: it becomes complete. Paying the rewards (once, on this transition) is the caller's. */
export function turnInQuest(journal: QuestJournal | null | undefined, quest: Quest): { journal: QuestJournal; error: string | null } {
  const base = journal ?? emptyJournal();
  const state = base.quests[quest.id];
  if (!state) return { journal: base, error: "quest not accepted" };
  if (state.status === "complete") return { journal: base, error: "already handed in" };
  if (state.status !== "ready") return { journal: base, error: "objectives not finished" };
  const quests = { ...base.quests, [quest.id]: { ...state, status: "complete" as const } };
  return { journal: { ...base, tracked: base.tracked === quest.id ? null : base.tracked, quests }, error: null };
}
