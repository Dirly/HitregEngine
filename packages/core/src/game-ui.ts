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
    id: z.string().min(1), label: z.string().min(1), kind: z.enum(["visit", "kill", "collect"]),
    target: z.string().default(""), required: z.number().int().positive().default(1),
  })).min(1).refine(a => new Set(a.map(o => o.id)).size === a.length, "duplicate objective id"),
  area: z.object({
    label: z.string(), center: z.tuple([z.number(), z.number()]), radius: z.number().min(50),
  }).describe("Approximate search region [world X, world Z], never an exact objective marker. Only the compass may visualize this region."),
  rewardXp: z.number().int().min(0).default(0),
}).describe("Quest definition. Progress belongs to authority-owned quest journals, not this asset.");
export type Quest = z.infer<typeof questSchema>;
export const questJournalSchema = z.object({
  version: z.literal(1).default(1), tracked: z.string().nullable().default(null),
  quests: z.record(z.string(), z.object({
    status: z.enum(["active", "complete"]), progress: z.record(z.string(), z.number().int().min(0)),
  })),
});
export type QuestJournal = z.infer<typeof questJournalSchema>;

/** Shared navigation math: north = -Z, clockwise bearings, seam-safe wrap. */
export const bearing = (dx: number, dz: number): number => (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360;
export const bearingDelta = (target: number, heading: number): number => ((target - heading + 540) % 360) - 180;
export function nearbyTowns<T extends { center: readonly [number, number] }>(towns: readonly T[], x: number, z: number, radius: number): T[] {
  return towns.filter(t => Math.hypot(t.center[0] - x, t.center[1] - z) <= radius);
}

/** Monotonic objective progress; completion/rewards can only happen once. */
export function advanceQuest(journal: QuestJournal, quest: Quest, objectiveId: string, amount = 1): QuestJournal {
  const state = journal.quests[quest.id];
  const objective = quest.objectives.find(o => o.id === objectiveId);
  if (!state || state.status !== "active" || !objective || !Number.isFinite(amount) || amount <= 0) return journal;
  const progress = { ...state.progress, [objectiveId]: Math.min(objective.required, (state.progress[objectiveId] ?? 0) + Math.floor(amount)) };
  const complete = quest.objectives.every(o => (progress[o.id] ?? 0) >= o.required);
  return { ...journal, tracked: complete && journal.tracked === quest.id ? null : journal.tracked,
    quests: { ...journal.quests, [quest.id]: { status: complete ? "complete" : "active", progress } } };
}
