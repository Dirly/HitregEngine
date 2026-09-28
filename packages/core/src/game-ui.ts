import { z } from "zod";
import { EQUIPMENT_SLOTS } from "./character/items.js";

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

export const questSchema = z.object({
  id: z.string().min(1), title: z.string().min(1), description: z.string(),
  objectives: z.array(z.object({
    id: z.string().min(1), label: z.string().min(1),
    kind: z.enum(["visit", "kill", "collect", "talk"]).describe(
      "visit: stand inside `area`; kill: defeat `target` (an entity id or its template prefix); collect: carry `target` " +
      "(an item id); talk: open a conversation with the NPC whose entity id is `target`.",
    ),
    target: z.string().default(""), required: z.number().int().positive().default(1),
  })).min(1).refine(a => new Set(a.map(o => o.id)).size === a.length, "duplicate objective id"),
  area: z.object({
    label: z.string(), center: z.tuple([z.number(), z.number()]), radius: z.number().min(50),
  }).optional().describe("Approximate search region [world X, world Z], never an exact objective marker. Only the compass may visualize this region. Absent = no compass guidance (an errand inside a town)."),
  rewardXp: z.number().int().min(0).default(0),
  rewardCoins: z.number().int().min(0).default(0).describe("Coins paid on completion, in copper (100 copper = 1 silver, 100 silver = 1 gold)."),
  rewardItems: z.array(z.object({ itemId: z.string().min(1), qty: z.number().int().min(1).default(1) })).default([])
    .describe("Items given on completion. A hand-in is refused while they do not fit the bags."),
  giver: z.string().default("").describe("Entity id of the NPC who offers it (its dialogue's `acceptQuest`). Empty = granted by a script (quest-log `autoStart`)."),
  turnIn: z.string().default("").describe(
    "Entity id of the NPC it is handed in to. Set = finishing the objectives makes it READY, and it completes (paying its " +
    "rewards) only through that NPC's dialogue (`turnInQuest`). Empty = it completes the moment the objectives do.",
  ),
  requires: z.array(z.string()).default([]).describe("Quest ids that must be COMPLETE before this one can be accepted (a chain)."),
  consume: z.boolean().default(false).describe("On hand-in, take the `collect` objectives' items out of the bags (the ore is handed over)."),
  level: z.number().int().min(1).default(1).describe("Suggested level, shown in the journal; never enforced."),
  places: z.string().default("").describe("places asset id (assets/places/<town>.json) its text's {dir:id} / {far:id} / {place:id} tokens resolve against — never write a compass word by hand."),
}).describe("Quest definition (assets/quests/<id>.json). Progress belongs to authority-owned quest journals, not this asset.");
export type Quest = z.infer<typeof questSchema>;
export type QuestInput = z.input<typeof questSchema>;
export const QUEST_STATUSES = ["active", "ready", "complete"] as const;
export type QuestStatus = (typeof QUEST_STATUSES)[number];
export const questJournalSchema = z.object({
  version: z.literal(1).default(1), tracked: z.string().nullable().default(null),
  quests: z.record(z.string(), z.object({
    status: z.enum(QUEST_STATUSES).describe("active: objectives open; ready: objectives done, waiting to be handed in to the quest's `turnIn` NPC; complete: rewarded."),
    progress: z.record(z.string(), z.number().int().min(0)),
  })),
});
export type QuestJournal = z.infer<typeof questJournalSchema>;

/** Shared navigation math: north = -Z, clockwise bearings, seam-safe wrap. */
export const bearing = (dx: number, dz: number): number => (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360;
export const bearingDelta = (target: number, heading: number): number => ((target - heading + 540) % 360) - 180;
export function nearbyTowns<T extends { center: readonly [number, number] }>(towns: readonly T[], x: number, z: number, radius: number): T[] {
  return towns.filter(t => Math.hypot(t.center[0] - x, t.center[1] - z) <= radius);
}

/**
 * Monotonic objective progress; completion/rewards can only happen once. A
 * quest with a `turnIn` NPC stops at "ready": only {@link turnInQuest} completes it.
 */
export function advanceQuest(journal: QuestJournal, quest: Quest, objectiveId: string, amount = 1): QuestJournal {
  const state = journal.quests[quest.id];
  const objective = quest.objectives.find(o => o.id === objectiveId);
  if (!state || state.status !== "active" || !objective || !Number.isFinite(amount) || amount <= 0) return journal;
  const progress = { ...state.progress, [objectiveId]: Math.min(objective.required, (state.progress[objectiveId] ?? 0) + Math.floor(amount)) };
  const done = quest.objectives.every(o => (progress[o.id] ?? 0) >= o.required);
  const status: QuestStatus = !done ? "active" : quest.turnIn ? "ready" : "complete";
  return { ...journal, tracked: status === "complete" && journal.tracked === quest.id ? null : journal.tracked,
    quests: { ...journal.quests, [quest.id]: { status, progress } } };
}

const emptyJournal = (): QuestJournal => questJournalSchema.parse({ quests: {} });

/** Why `quest` cannot be accepted into `journal` right now, or null when it can. */
export function questOfferProblem(journal: QuestJournal | null | undefined, quest: Quest): string | null {
  const state = journal?.quests[quest.id];
  if (state) return state.status === "complete" ? "already completed" : "already accepted";
  for (const need of quest.requires) if (journal?.quests[need]?.status !== "complete") return `requires "${need}" first`;
  return null;
}

/** Accept a quest (a giver's dialogue, a script's autoStart); it becomes the tracked one when `track`. */
export function acceptQuest(journal: QuestJournal | null | undefined, quest: Quest, track = true): { journal: QuestJournal; error: string | null } {
  const base = journal ?? emptyJournal();
  const problem = questOfferProblem(base, quest);
  if (problem) return { journal: base, error: problem };
  const quests = { ...base.quests, [quest.id]: { status: "active" as const, progress: {} } };
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
