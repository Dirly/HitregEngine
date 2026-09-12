/**
 * A threat table — who a mob is angriest at.
 *
 * This is the piece that turns "the monster runs at whoever is closest" into a
 * fight with roles. A tank holds a boar by being the thing it hates most, not
 * by standing in front of it; a healer who never lands a hit still climbs the
 * table; a taunt is a promise the mob will look at you for a few seconds even
 * though someone else has out-damaged you all fight.
 *
 * Pure and headless on purpose. The engine has no combat model — it cannot
 * know what a hit is worth — so nothing here generates threat: the game's
 * combat layer feeds it (`mob.threat`) and this decides who wins. That also
 * makes it testable without a scene, and readable by a server admin endpoint
 * that wants to answer "why is it chasing HIM".
 *
 * Decay is LAZY. Entries hold a value and the time it was stamped, and the
 * current value is computed on read from an exponential half-life, so a table
 * costs nothing on the ticks nobody reads it and a hundred idle mobs are not a
 * hundred decay loops.
 */

export interface ThreatEntry {
  id: string;
  threat: number;
}

export interface ThreatTableOptions {
  /**
   * Seconds for threat to halve. This is the whole feel knob: short, and a mob
   * turns on whoever hit it last; long, and the first person to commit holds it
   * for the fight. 0 disables decay entirely.
   */
  halfLife?: number;
  /** Entries below this are dropped on read, so the table cannot grow forever. */
  forgetBelow?: number;
}

interface Stamped {
  value: number;
  at: number;
}

export class ThreatTable {
  private readonly entries = new Map<string, Stamped>();
  private readonly halfLife: number;
  private readonly forgetBelow: number;
  private forcedId = "";
  private forcedUntil = 0;

  constructor(opts: ThreatTableOptions = {}) {
    this.halfLife = opts.halfLife ?? 12;
    this.forgetBelow = opts.forgetBelow ?? 0.5;
  }

  /** Current threat from one source, decayed to `now`. */
  get(id: string, now: number): number {
    const entry = this.entries.get(id);
    if (!entry) return 0;
    return this.decayed(entry, now);
  }

  /** Add to a source's threat (damage dealt, a heal landed nearby). Returns the new value. */
  add(id: string, amount: number, now: number): number {
    const value = this.get(id, now) + amount;
    this.entries.set(id, { value, at: now });
    return value;
  }

  /** Replace a source's threat outright — a threat drop, a debug poke, a script that owns the number. */
  set(id: string, amount: number, now: number): number {
    this.entries.set(id, { value: amount, at: now });
    return amount;
  }

  /**
   * Taunt: become the top of the table AND the forced target for `seconds`.
   *
   * Both halves matter. Topping the table alone loses the mob the instant the
   * real damage dealer swings again, which is not what a taunt is for; forcing
   * the target alone means the mob turns away the moment the window closes,
   * because nothing changed underneath. So do both — the window buys time, the
   * threat makes it stick.
   */
  taunt(id: string, now: number, seconds = 3): number {
    let top = 0;
    for (const [other, entry] of this.entries) {
      if (other === id) continue;
      top = Math.max(top, this.decayed(entry, now));
    }
    const value = Math.max(this.get(id, now), top * 1.1 + 1);
    this.entries.set(id, { value, at: now });
    if (seconds > 0) {
      this.forcedId = id;
      this.forcedUntil = now + seconds;
    }
    return value;
  }

  /** The taunt currently in force, or null. */
  forcedTarget(now: number): string | null {
    return this.forcedUntil > now && this.forcedId ? this.forcedId : null;
  }

  /**
   * Who the mob should be fighting, or null.
   *
   * `isValid` filters to targets that are still worth having — alive, in
   * range, not on the other side of a zone border. It is applied to the taunt
   * too: a forced target that walked away is not a target, and a mob that kept
   * charging at one would run itself off its leash on the strength of a
   * three-second promise.
   */
  top(now: number, isValid?: (id: string) => boolean): string | null {
    const forced = this.forcedTarget(now);
    if (forced && (!isValid || isValid(forced))) return forced;
    let bestId: string | null = null;
    let best = 0;
    for (const [id, entry] of this.entries) {
      const value = this.decayed(entry, now);
      if (value < this.forgetBelow) {
        this.entries.delete(id);
        continue;
      }
      if (value <= best) continue;
      if (isValid && !isValid(id)) continue;
      best = value;
      bestId = id;
    }
    return bestId;
  }

  /** Everything in the table, angriest first — for a debug overlay or an admin readout. */
  list(now: number): ThreatEntry[] {
    const out: ThreatEntry[] = [];
    for (const [id, entry] of this.entries) {
      const threat = this.decayed(entry, now);
      if (threat >= this.forgetBelow) out.push({ id, threat });
    }
    return out.sort((a, b) => b.threat - a.threat || (a.id < b.id ? -1 : 1));
  }

  /** Drop one source (it died, it left the world, it changed layer). */
  forget(id: string): void {
    this.entries.delete(id);
    if (this.forcedId === id) {
      this.forcedId = "";
      this.forcedUntil = 0;
    }
  }

  /** Wipe the table — the mob reset, or died. Resetting is what makes a leash a real escape. */
  clear(): void {
    this.entries.clear();
    this.forcedId = "";
    this.forcedUntil = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  private decayed(entry: Stamped, now: number): number {
    if (this.halfLife <= 0) return entry.value;
    const elapsed = now - entry.at;
    if (elapsed <= 0) return entry.value;
    return entry.value * Math.pow(0.5, elapsed / this.halfLife);
  }
}
