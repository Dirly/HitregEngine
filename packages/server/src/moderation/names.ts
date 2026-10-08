/**
 * CHARACTER NAME CHECK (docs/moderation.md §1) — the stages after shape and
 * uniqueness, which stay in main (`CHARACTER_NAME`, `findCharacter`):
 *
 *   word list   cheap and local. A data file (`names-blocklist.json`: staff
 *               titles and a starter obscenity list the owner extends) plus
 *               the game's own reserved names — its NPCs and bosses, which
 *               main reads from the game's content. Letter swaps are folded
 *               (1→i 0→o 3→e 4→a 5/$→s 7→t @→a), separators stripped and
 *               repeated letters tolerated, so "G.M", "4dm1n" and "fuuuck" all
 *               land. A hit is refused with a plain reason, no judge call.
 *   judge       everything that passed the list goes to the ModerationJudge
 *               with `accept | reject_offensive | reject_impersonation |
 *               reject_real_person | reject_other`. A reject is enforced only
 *               when its probability clears the threshold (default 0.80);
 *               below it — and whenever the judge cannot be reached — the
 *               name is ACCEPTED and put on the review list staff read at
 *               `GET /admin/moderation/names`. A provider outage never blocks
 *               character creation.
 *
 * WHOLE WORDS vs SUBSTRINGS. A list that matches anywhere in a name refuses
 * "Cassandra" for "ass" and "Devon" for "dev" — the classic Scunthorpe
 * failure. So each entry says how it matches:
 *   `word`       the entry must equal one whole word of the name, or a run of
 *                adjacent words joined ("GM Bob", "G M Bob", "Ass Kicker"),
 *                never a piece of a longer word ("Cassandra", "Bass").
 *   `substring`  anywhere, separators ignored — only for entries that never
 *                occur inside an ordinary name ("moderator", "fuck").
 *   `name`       the whole name, separators ignored (the game's reserved
 *                names: "Wynna Coyle" refuses "Wynna-Coyle", not "Wynna Smith").
 * Repeated letters: "collapse repeats" is done by matching each run of a
 * letter in the ENTRY as "at least that many" (`fuck` → f+u+c+k+, `nigger`
 * → n+i+gg+e+r+), which catches stretched spellings without letting a
 * collapsed entry ("niger") hit an innocent word ("Nigeria").
 *
 * This module is generic engine code: nothing here names one game. The game
 * supplies its reserved names; the owner extends the data file.
 */

import fs from "node:fs";
import type { JudgeLog, ModerationJudge } from "./judge.js";

export type BlockCategory = "staff" | "obscene" | "reserved";
export type BlockMatch = "word" | "substring" | "name";

export interface BlockEntry {
  word: string;
  category: BlockCategory;
  match: BlockMatch;
}

export const NAME_OPTIONS = ["accept", "reject_offensive", "reject_impersonation", "reject_real_person", "reject_other"] as const;
export type NameOption = (typeof NAME_OPTIONS)[number];

/** The question the judge is asked about every name that passed the list. */
export const NAME_QUESTION =
  "A player chose this name for their character in an online fantasy game. Is the name acceptable, or must it be refused — and for which reason?";

// ---------------------------------------------------------------------------
// folding

const SWAPS: Record<string, string> = { "1": "i", "0": "o", "3": "e", "4": "a", "5": "s", $: "s", "7": "t", "@": "a" };

/** Lowercase, undo letter swaps, and split into words on everything that is not a letter. */
export function nameTokens(name: string): string[] {
  let out = "";
  for (const ch of name.toLowerCase()) out += SWAPS[ch] ?? ch;
  return out.split(/[^a-z]+/).filter(Boolean);
}

/**
 * The folded form of a name: swaps undone, separators stripped, repeated
 * letters collapsed ("G..M" → "gm", "Fuuu-ck" → "fuck", "4dm1n" → "admin").
 * `collapse: false` keeps repeats (what the matcher reads).
 */
export function foldName(name: string, opts: { collapse?: boolean } = {}): string {
  const flat = nameTokens(name).join("");
  return opts.collapse === false ? flat : flat.replace(/([a-z])\1+/g, "$1");
}

/** Each run of a letter in the entry matches at least that many of it. */
function entryPattern(word: string): string | null {
  const flat = foldName(word, { collapse: false });
  if (!flat) return null;
  return flat.replace(/([a-z])\1*/g, (run, ch: string) => (run.length === 1 ? `${ch}+` : `${ch}{${run.length},}`));
}

// ---------------------------------------------------------------------------
// the list

export interface CompiledList {
  substring: Array<{ entry: BlockEntry; re: RegExp }>;
  word: Array<{ entry: BlockEntry; re: RegExp }>;
  name: Array<{ entry: BlockEntry; re: RegExp }>;
}

export function compileList(entries: Iterable<BlockEntry>): CompiledList {
  const out: CompiledList = { substring: [], word: [], name: [] };
  for (const entry of entries) {
    const p = entryPattern(entry.word);
    if (!p) continue;
    if (entry.match === "substring") out.substring.push({ entry, re: new RegExp(p) });
    else out[entry.match === "name" ? "name" : "word"].push({ entry, re: new RegExp(`^${p}$`) });
  }
  return out;
}

let shipped: BlockEntry[] | null = null;
/** The engine's starter list (`names-blocklist.json` beside this file). */
export function shippedBlocklist(): BlockEntry[] {
  if (!shipped) {
    const raw = JSON.parse(fs.readFileSync(new URL("./names-blocklist.json", import.meta.url), "utf8")) as { entries?: unknown };
    shipped = (Array.isArray(raw.entries) ? raw.entries : []).filter(
      (e): e is BlockEntry =>
        !!e &&
        typeof (e as BlockEntry).word === "string" &&
        ["staff", "obscene", "reserved"].includes((e as BlockEntry).category) &&
        ["word", "substring", "name"].includes((e as BlockEntry).match),
    );
  }
  return shipped;
}

let shippedCompiled: CompiledList | null = null;

/**
 * Reserved names (the game's NPCs, bosses) as whole-NAME entries: "Wynna
 * Coyle" refuses "Wynna Coyle" and "Wynna-Coyle", not "Wynna Smith" — and an
 * NPC called "Guard" does not take the word "guard" out of every name.
 */
export function reservedEntries(names: Iterable<string>): BlockEntry[] {
  const out: BlockEntry[] = [];
  const seen = new Set<string>();
  for (const n of names) {
    const flat = foldName(n, { collapse: false });
    if (flat.length < 3 || seen.has(flat)) continue;
    seen.add(flat);
    out.push({ word: n, category: "reserved", match: "name" });
  }
  return out;
}

function isCompiled(x: Iterable<string> | CompiledList): x is CompiledList {
  return !(Symbol.iterator in x) && "substring" in x;
}

export interface ListHit {
  entry: BlockEntry;
  category: BlockCategory;
}

/**
 * The word-list stage alone: the first entry the name hits, or null.
 * `compiled` defaults to the shipped list; `reserved` adds the game's names.
 */
export function listHit(name: string, opts: { compiled?: CompiledList; reserved?: Iterable<string> | CompiledList } = {}): ListHit | null {
  const lists: CompiledList[] = [opts.compiled ?? (shippedCompiled ??= compileList(shippedBlocklist()))];
  if (opts.reserved) lists.push(isCompiled(opts.reserved) ? opts.reserved : compileList(reservedEntries(opts.reserved)));
  const tokens = nameTokens(name);
  const flat = tokens.join("");
  // every run of adjacent words, joined: "g m bob" → g, gm, gmbob, m, mbob, bob
  const spans: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    let s = "";
    for (let j = i; j < tokens.length; j++) spans.push((s += tokens[j]));
  }
  for (const list of lists) {
    for (const { entry, re } of list.substring) if (re.test(flat)) return { entry, category: entry.category };
    for (const { entry, re } of list.name) if (re.test(flat)) return { entry, category: entry.category };
    for (const { entry, re } of list.word) if (spans.some((s) => re.test(s))) return { entry, category: entry.category };
  }
  return null;
}

/** The plain, user-facing reason for a list hit ("That name isn't allowed: " + this). */
export function listReason(hit: ListHit): string {
  if (hit.category === "staff") return `it looks like a staff title ("${hit.entry.word}")`;
  if (hit.category === "reserved") return `it belongs to a character in the game ("${hit.entry.word}")`;
  return "it contains a word that isn't allowed";
}

const JUDGE_REASON: Record<Exclude<NameOption, "accept">, string> = {
  reject_offensive: "it reads as offensive",
  reject_impersonation: "it impersonates staff or another character",
  reject_real_person: "it is the name of a real person",
  reject_other: "it isn't suitable for a character name",
};

// ---------------------------------------------------------------------------
// the check

export type NameVerdict =
  | { ok: true; queued: boolean }
  | { ok: false; stage: "list" | "judge"; reason: string; message: string; answer?: NameOption; probability?: number };

export interface NameReview {
  name: string;
  at: string;
  /** Why it is on the list: the judge leaned reject but below the threshold, or the judge failed. */
  why: "below_threshold" | "judge_unavailable";
  answer?: NameOption;
  probability?: number;
  model?: string;
  error?: string;
  accountId?: string;
  characterId?: string;
}

export interface NameModerationOptions {
  /** The judge (null = word list only). */
  judge?: ModerationJudge | null;
  /** A reject is enforced only above this probability (default 0.80). */
  threshold?: number;
  /** The game's reserved names (NPCs, bosses). */
  reserved?: Iterable<string>;
  /** Replaces the shipped list (default: `names-blocklist.json`). */
  blocklist?: Iterable<BlockEntry>;
  /** Review entries kept in memory, oldest dropped first (default 500). */
  reviewLimit?: number;
  /** Called (and awaited) for every name put on the review list — main persists it (moderation-queue). */
  onReview?: (review: NameReview) => void | Promise<void>;
  log?: JudgeLog;
}

/**
 * The name check main runs at creation, at rename and on a name report.
 * Holds the compiled lists and the review list (kept in memory here; main
 * persists each entry through `onReview` into its moderation queue).
 */
export class NameModeration {
  readonly threshold: number;
  /** Accepted names staff should look at, oldest first. */
  readonly review: NameReview[] = [];
  private readonly compiled: CompiledList;
  private readonly reserved: CompiledList;
  private readonly judge: ModerationJudge | null;
  private readonly reviewLimit: number;
  private readonly log: JudgeLog;
  private readonly onReview: NameModerationOptions["onReview"];

  constructor(opts: NameModerationOptions = {}) {
    this.threshold = opts.threshold ?? 0.8;
    this.judge = opts.judge ?? null;
    this.compiled = opts.blocklist ? compileList(opts.blocklist) : (shippedCompiled ??= compileList(shippedBlocklist()));
    this.reserved = compileList(reservedEntries(opts.reserved ?? []));
    this.reviewLimit = opts.reviewLimit ?? 500;
    this.log = opts.log ?? (() => undefined);
    this.onReview = opts.onReview;
  }

  /** The word-list stage only (cheap; the creation screen's as-you-type check uses it). */
  checkList(name: string): Extract<NameVerdict, { ok: false }> | null {
    const hit = listHit(name, { compiled: this.compiled, reserved: this.reserved });
    if (!hit) return null;
    const reason = listReason(hit);
    return { ok: false, stage: "list", reason, message: `That name isn't allowed: ${reason}.` };
  }

  /** Word list, then judge. Never throws: a judge failure accepts and queues the name for review. */
  async check(name: string, context: { accountId?: string; characterId?: string } = {}): Promise<NameVerdict> {
    const listed = this.checkList(name);
    if (listed) {
      this.log(`[moderation] name "${name}" refused by the word list (${listed.reason})`);
      return listed;
    }
    if (!this.judge) return { ok: true, queued: false };
    const at = new Date().toISOString();
    try {
      const d = await this.judge.decide({ task: "name", question: NAME_QUESTION, options: NAME_OPTIONS, evidence: { name } });
      if (d.answer === "accept") return { ok: true, queued: false };
      if (d.probability > this.threshold) {
        const reason = JUDGE_REASON[d.answer];
        return { ok: false, stage: "judge", reason, message: `That name isn't allowed: ${reason}.`, answer: d.answer, probability: d.probability };
      }
      await this.queue({ name, at, why: "below_threshold", answer: d.answer, probability: d.probability, model: d.model, ...context });
      return { ok: true, queued: true };
    } catch (error) {
      await this.queue({ name, at, why: "judge_unavailable", error: error instanceof Error ? error.message : String(error), ...context });
      return { ok: true, queued: true };
    }
  }

  private async queue(r: NameReview): Promise<void> {
    this.review.push(r);
    if (this.review.length > this.reviewLimit) this.review.splice(0, this.review.length - this.reviewLimit);
    this.log(`[moderation] name "${r.name}" accepted for review (${r.why}${r.answer ? `: ${r.answer} p=${r.probability?.toFixed(3)}` : ""})`);
    try {
      await this.onReview?.(r);
    } catch (error) {
      this.log(`[moderation] could not store the review of "${r.name}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * The game's reserved names from scene entities: every entity running the
 * `npc` builtin contributes its display name (`params.name`, else the
 * entity's own name), and any entity tagged `boss` or `named` contributes its
 * name. Callers pass the scene's entities (expanded or not — NPCs placed
 * inside prefab instances are only seen in an expanded scene).
 */
export function reservedNamesFromEntities(entities: Iterable<{ name?: string; tags?: readonly string[]; components?: Record<string, unknown> }>): string[] {
  const out = new Set<string>();
  for (const e of entities) {
    const script = e.components?.["script"] as { name?: unknown; params?: Record<string, unknown> } | undefined;
    if (script?.name === "npc") {
      const n = typeof script.params?.["name"] === "string" && script.params["name"] ? (script.params["name"] as string) : e.name;
      if (n) out.add(n);
    }
    if (e.name && e.tags?.some((t) => t === "boss" || t === "named")) out.add(e.name);
  }
  return [...out];
}
