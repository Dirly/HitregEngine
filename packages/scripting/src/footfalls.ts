/**
 * Footsteps in time with the feet.
 *
 * A distance counter ("a step every N metres") knows nothing about the legs:
 * its beat is right on average and wrong on every single step, drifting across
 * the stride until the sound lands mid-swing. The clip already knows where its
 * feet come down — `retarget` measures it and prints `clipFootfalls` — so the
 * controller watches the clip's playhead and fires a step as it passes each
 * contact. Speed changes, gait changes and playback-rate changes then cannot
 * put the sound out of step, because the sound is read off the same playhead
 * the pose is.
 *
 * Pure and DOM-free: a playhead in, crossings out. The controller owns the
 * sound.
 */

/**
 * Which of `footfalls` (normalized clip times, 0..1) a looping playhead passed
 * going from `prev` to `now`, in order. The interval is half-open — `(prev,
 * now]` round the loop — so a contact the playhead lands exactly on fires on
 * this tick and not again on the next.
 *
 * `extraCycles` is how many WHOLE loops happened on top of the visible move —
 * zero unless the clip ran more than a full cycle between two reads (a very
 * short clip at a very high rate, or a long hitch). Each adds every contact
 * once more. The playhead alone cannot tell 0.1 from 1.1; the caller, who
 * knows the rate, can.
 *
 * Returns indices into `footfalls`.
 */
export function footfallsCrossed(
  prev: number,
  now: number,
  footfalls: readonly number[],
  extraCycles = 0,
): number[] {
  const out: number[] = [];
  const wrap = (v: number): number => ((v % 1) + 1) % 1;
  const moved = wrap(now - prev);
  const loops = Math.max(0, Math.floor(extraCycles));
  // the full loops first: they happened before the partial move that ends here
  for (let c = 0; c < loops; c++) {
    const order = footfalls
      .map((f, i) => ({ i, at: wrap(f - prev) || 1 }))
      .sort((a, b) => a.at - b.at);
    for (const { i } of order) out.push(i);
  }
  if (moved === 0) return out;
  const passed = footfalls
    .map((f, i) => ({ i, at: wrap(f - prev) }))
    .filter(({ at }) => at > 0 && at <= moved)
    .sort((a, b) => a.at - b.at);
  for (const { i } of passed) out.push(i);
  return out;
}

/** What one read of the playhead produced. */
export interface FootfallStep {
  /** Contacts passed since the last read (0 = nothing to play). */
  count: number;
  /** Index into the clip's footfall list of the LAST contact passed — even = one foot, odd = the other. */
  foot: number;
}

/**
 * Follows one body's base-clip playhead across reads and reports the contacts
 * it passes. Clip changes are the subtle part:
 *
 * - A gait change (walk → run) is PHASE-synced by the animation host, so the
 *   incoming clip's playhead carries on from where the outgoing one was. A
 *   short move across that seam is real stride progress and is counted
 *   against the NEW clip's contacts.
 * - Anything else (a clip that restarts at frame 0, a phase that jumped more
 *   than a quarter of the cycle) is re-anchored silently — a guessed step is
 *   worse than a missing one.
 */
export class FootfallTracker {
  private clip: string | null = null;
  private t = 0;

  /** Forget the playhead — the next read anchors and fires nothing. */
  reset(): void {
    this.clip = null;
  }

  /**
   * @param clip       the base clip playing now
   * @param t01        its playhead, 0..1
   * @param footfalls  that clip's contacts (from `clipFootfalls`)
   * @param advance    how far the playhead should have moved since the last
   *                   read, in cycles (rate × dt ÷ duration) — only used to
   *                   spot whole extra loops; omit when unknown
   */
  step(clip: string, t01: number, footfalls: readonly number[], advance?: number): FootfallStep {
    const prevClip = this.clip;
    const prev = this.t;
    this.clip = clip;
    this.t = t01;
    if (prevClip === null) return { count: 0, foot: 0 };
    const moved = (((t01 - prev) % 1) + 1) % 1;
    // across a clip change only a small, forward, phase-synced move counts
    if (prevClip !== clip && moved > 0.25) return { count: 0, foot: 0 };
    const extra =
      prevClip === clip && advance !== undefined && Number.isFinite(advance) ? Math.round(advance - moved) : 0;
    const hits = footfallsCrossed(prev, t01, footfalls, extra);
    return hits.length ? { count: hits.length, foot: hits[hits.length - 1]! } : { count: 0, foot: 0 };
  }
}
