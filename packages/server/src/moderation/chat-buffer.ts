/**
 * Chat history for moderation (docs/moderation.md §2).
 *
 * Chat moderation is self-reporting: nothing reads chat on its own. What a
 * report needs is what was said just BEFORE it — so every game server keeps
 * a short rolling buffer of the lines it routed (default 15 minutes, and a
 * line cap so a busy layer cannot grow it without bound), and main keeps one
 * of the lines it bridged between layers (zone, global, party, guild). When a
 * player reports someone, main asks for the lines involving the two and
 * stores that slice WITH the report. Everything else ages out of memory and
 * is never written down.
 *
 * The buffer is plain memory: one small object per line, oldest first, pruned
 * from the front on every write. Recipients are kept as character ids only
 * long enough to answer "did the reporter hear this?"; an evidence slice
 * carries flags, not other players' ids.
 */

/** Default window a buffer keeps (15 minutes). */
export const CHAT_BUFFER_WINDOW_MS = 15 * 60_000;
/** Default line cap of a game server's buffer. */
export const LAYER_CHAT_BUFFER_LINES = 5000;
/** Default line cap of main's buffer (it sees every layer's bridged lines). */
export const MAIN_CHAT_BUFFER_LINES = 20000;

/** One routed line as a buffer holds it. */
export interface BufferedChatLine {
  /** The origin's stamp (`<sender>:<seq>`), with `at` it identifies the line everywhere. */
  id: string;
  channel: string;
  /** Sender character id (peer id on a layer). */
  from: string;
  /** Sender account (player id), when the buffering process knows it. */
  account: string | null;
  name: string;
  text: string;
  /** The origin's wall-clock ms. */
  at: number;
  /** Where the sender stood when they spoke; null when not known here (a bridged line). */
  position: [number, number, number] | null;
  /** The sender's zone (a recipe region id, climate cell or the scene). */
  zone: string | null;
  /** Server the line was spoken on. */
  origin: string;
  /** Characters this process delivered it to (layers only; main does not know). */
  to: string[] | null;
}

/** A line as it appears in evidence: no third parties, only whether the two heard it. */
export interface EvidenceLine {
  id: string;
  channel: string;
  from: string;
  account: string | null;
  name: string;
  text: string;
  at: number;
  position: [number, number, number] | null;
  zone: string | null;
  origin: string;
  /** How many players the line reached on the server that answered (null: not known there). */
  recipients: number | null;
  /** Whether the reporter / the reported received it there (null: not known there). */
  reporterHeard: boolean | null;
  targetHeard: boolean | null;
  /** Who supplied it: a game server's id, or "main" for a bridged line main saw. */
  source: string;
}

/** Where one of the two stands right now, as the answering server sees them. */
export interface EvidencePlace {
  characterId: string;
  /** True when the character is on the answering server. */
  here: boolean;
  position: [number, number, number] | null;
  zone: string | null;
}

/** A game server's answer to `evidence.request`. */
export interface ChatEvidence {
  server: string;
  scene: string;
  collectedAt: number;
  minutes: number;
  reporter: EvidencePlace;
  target: EvidencePlace;
  lines: EvidenceLine[];
}

export interface ChatBufferOptions {
  windowMs?: number;
  maxLines?: number;
  now?: () => number;
}

/**
 * A time- and count-bounded log of chat lines. Appends are O(1); pruning
 * drops from the front (lines arrive in time order on one process).
 */
export class ChatBuffer {
  readonly windowMs: number;
  readonly maxLines: number;
  private readonly now: () => number;
  private lines: BufferedChatLine[] = [];
  private start = 0;

  constructor(opts: ChatBufferOptions = {}) {
    this.windowMs = opts.windowMs ?? CHAT_BUFFER_WINDOW_MS;
    this.maxLines = Math.max(1, opts.maxLines ?? LAYER_CHAT_BUFFER_LINES);
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.lines.length - this.start;
  }

  push(line: BufferedChatLine): BufferedChatLine {
    this.lines.push(line);
    this.prune();
    return line;
  }

  /** Drop lines older than the window and beyond the cap. */
  prune(): void {
    const cutoff = this.now() - this.windowMs;
    while (this.start < this.lines.length && (this.lines.length - this.start > this.maxLines || this.lines[this.start]!.at < cutoff)) {
      this.start++;
    }
    // compact now and then rather than shifting on every line
    if (this.start > 1024 && this.start * 2 > this.lines.length) {
      this.lines = this.lines.slice(this.start);
      this.start = 0;
    }
  }

  /** Every line still held, oldest first. */
  all(): BufferedChatLine[] {
    this.prune();
    return this.lines.slice(this.start);
  }

  /** Lines from the last `minutes` (capped at the window) that either character SPOKE. */
  involving(a: string, b: string, minutes = this.windowMs / 60_000): BufferedChatLine[] {
    const since = this.now() - Math.min(this.windowMs, Math.max(0, minutes) * 60_000);
    return this.all().filter((l) => l.at >= since && (l.from === a || l.from === b));
  }

  clear(): void {
    this.lines = [];
    this.start = 0;
  }
}

/**
 * The evidence form of a buffered line: third-party recipients become a count
 * and two flags. Only lines spoken by the reporter or the reported are ever
 * turned into evidence (`ChatBuffer.involving`).
 */
export function toEvidenceLine(line: BufferedChatLine, reporter: string, target: string, source: string): EvidenceLine {
  return {
    id: line.id,
    channel: line.channel,
    from: line.from,
    account: line.account,
    name: line.name,
    text: line.text,
    at: line.at,
    position: line.position,
    zone: line.zone,
    origin: line.origin,
    recipients: line.to ? line.to.length : null,
    reporterHeard: line.to ? line.from === reporter || line.to.includes(reporter) : null,
    targetHeard: line.to ? line.from === target || line.to.includes(target) : null,
    source,
  };
}

/** Same line seen by two processes (the origin layer and main): one entry. */
const lineKey = (l: { id: string; from: string; at: number }): string => `${l.from}|${l.id}|${l.at}`;

const orNull = (a: boolean | null, b: boolean | null): boolean | null => (a === null ? b : b === null ? a : a || b);

/**
 * Merge evidence slices from several sources, oldest first. A bridged line can
 * be held by its origin layer (position, recipients there), by the layer the
 * other character stands on (recipients there) and by main (the account):
 * the copies become one entry that keeps whatever each knew — recipients
 * summed, "heard" true when it was heard anywhere.
 */
export function mergeEvidenceLines(...sources: ReadonlyArray<ReadonlyArray<EvidenceLine>>): EvidenceLine[] {
  const byKey = new Map<string, EvidenceLine>();
  for (const list of sources) {
    for (const line of list) {
      const key = lineKey(line);
      const had = byKey.get(key);
      if (!had) {
        byKey.set(key, line);
        continue;
      }
      byKey.set(key, {
        ...had,
        account: had.account ?? line.account,
        position: had.position ?? line.position,
        zone: had.zone ?? line.zone,
        recipients: had.recipients === null ? line.recipients : line.recipients === null ? had.recipients : had.recipients + line.recipients,
        reporterHeard: orNull(had.reporterHeard, line.reporterHeard),
        targetHeard: orNull(had.targetHeard, line.targetHeard),
        source: had.source.split("+").includes(line.source) ? had.source : `${had.source}+${line.source}`,
      });
    }
  }
  return [...byKey.values()].sort((a, b) => a.at - b.at);
}
