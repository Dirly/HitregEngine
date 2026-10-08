import { z } from "zod";

/**
 * A body's cast in progress, as a CAST BAR needs it: netState `cast/<bodyId>`.
 *
 * Written by the game's authority when a cast with a wind-up is accepted,
 * marked `interruptedAt` when it is stopped, and deleted when it is over. The
 * engine only draws it (the `nameplates` builtin over other bodies); what a
 * cast IS, and which casts get a bar, are the game's. Times are sim seconds
 * (`ctx.now() / 1000`), the clock every tab shares.
 */
export const CAST_NETSTATE = "cast";

export function castKey(bodyId: string): string {
  return `${CAST_NETSTATE}/${bodyId}`;
}

export const castBarSchema = z
  .object({
    id: z.string().max(64).optional().describe("The game's id for what is being cast (an ability id). Opaque to the engine."),
    label: z.string().max(64).describe("Text on the bar: the cast's display name."),
    tag: z
      .string()
      .max(16)
      .optional()
      .describe("Short text before the label (a school's initial), so the bar never says its kind by colour alone."),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional()
      .describe("Fill colour, #rrggbb (a school's colour). Absent = the bar's neutral colour."),
    school: z.string().max(32).optional().describe("The game's category of the cast (a school of magic). Opaque to the engine."),
    start: z.number().describe("Sim seconds the cast began; the bar fills from here."),
    end: z.number().describe("Sim seconds the wind-up (or channel) ends; the bar is full here and hidden after."),
    show: z
      .boolean()
      .optional()
      .describe("false = published for rules that ask 'is this body casting?' but drawn as no bar (a weapon swing). Absent = shown."),
    mark: z
      .string()
      .max(24)
      .optional()
      .describe(
        "A short marker for a cast drawn with show:false, a glyph and a word (a creature's wind-up class, '■ HEAVY'). " +
          "nameplates draws it as a small chip in `color`, filled over the wind-up, where the bar would be. Absent = nothing drawn.",
      ),
    interruptedAt: z
      .number()
      .optional()
      .describe("Sim seconds the cast was stopped (an interrupt, a stagger). The bar freezes there, marked, for a moment."),
  })
  .describe(
    "A body's cast in progress, keyed cast/<bodyId>, for cast bars. Authority-written by the game when a cast with a " +
      "wind-up is accepted, marked interruptedAt when stopped, deleted when over. Drawn over other bodies by the " +
      "nameplates builtin (DOM, no draw call).",
  );
export type CastBar = z.infer<typeof castBarSchema>;

/**
 * Overhead BADGES: short timed statuses over a body, netState `badge/<bodyId>`
 * (a school locked by an interrupt, say). Same contract as the cast bar: the
 * game's authority writes them, the `nameplates` builtin draws them over
 * other bodies as DOM (no draw call), each with its seconds left.
 */
export const BADGE_NETSTATE = "badge";

export function badgeKey(bodyId: string): string {
  return `${BADGE_NETSTATE}/${bodyId}`;
}

export const plateBadgeSchema = z.object({
  id: z.string().max(48).describe("The game's slot for this badge (e.g. 'lock.shadow'); a writer replaces its own slot."),
  text: z.string().max(32).describe("What it says, glyph first ('✕ SHADOW LOCKED'): never meaning by colour alone."),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional()
    .describe("Text and border colour, #rrggbb. Absent = the plate's neutral colour."),
  until: z.number().describe("Sim seconds it ends; drawn with its whole seconds left until then, hidden after."),
});
export type PlateBadge = z.infer<typeof plateBadgeSchema>;

export const plateBadgesSchema = z
  .array(plateBadgeSchema)
  .max(8)
  .describe(
    "Timed statuses over a body, keyed badge/<bodyId>, for overhead badges. Authority-written by the game; expired " +
      "entries are hidden (and may be pruned by the writer). Drawn over other bodies by the nameplates builtin (DOM, no draw call).",
  );

/** Tolerant read: the well-formed badges still running at `now` (sim seconds). */
export function readBadges(value: unknown, now: number): PlateBadge[] {
  const r = plateBadgesSchema.safeParse(value);
  return r.success ? r.data.filter((b) => b.until > now) : [];
}

/** Tolerant read: anything that is not a well-formed cast bar is null. */
export function readCastBar(value: unknown): CastBar | null {
  const r = castBarSchema.safeParse(value);
  return r.success ? r.data : null;
}

/**
 * How full a cast bar is at `now` (0..1), and whether it shows at all.
 * An interrupted bar holds where it stopped for `linger` seconds; a finished
 * one is hidden. Pure, so a HUD and the nameplates agree.
 */
export function castBarProgress(bar: CastBar, now: number, linger = 0.8): { fill: number; visible: boolean; interrupted: boolean } {
  const span = Math.max(1e-3, bar.end - bar.start);
  if (bar.interruptedAt !== undefined) {
    const fill = Math.min(1, Math.max(0, (bar.interruptedAt - bar.start) / span));
    return { fill, visible: bar.show !== false && now < bar.interruptedAt + linger, interrupted: true };
  }
  const fill = Math.min(1, Math.max(0, (now - bar.start) / span));
  return { fill, visible: bar.show !== false && now < bar.end && now >= bar.start - 0.5, interrupted: false };
}
