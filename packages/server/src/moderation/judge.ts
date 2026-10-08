/**
 * THE MODERATION JUDGE — one interface for every automatic moderation call
 * (docs/moderation.md §5).
 *
 * A judge is a DECISION model, not a chat model: it is handed a bundle of
 * evidence and a closed list of answers, and returns exactly one of those
 * answers with a calibrated probability. Callers never parse prose and never
 * see an answer outside the list — an adapter that gets one throws, and the
 * caller treats a throw as "no decision" (accept-and-review for names,
 * escalate-to-staff for audits).
 *
 * Two judges ship:
 *
 *   RuleJudge   deterministic stand-in: the name word list for "name", a
 *               report count for "audit", always `escalate` for "item-claim".
 *               Tests use it, and so does any cluster with no provider key —
 *               the code paths above it are the same either way.
 *   JevJudge    the provider adapter for TypeSafe AI's Jev decision model
 *               (HTTP, key from `JEV_API_KEY`). The wire shape lives in ONE
 *               place (`jevRequest` / `jevAnswer`) so a change on their side is
 *               a one-function fix.
 *
 * `judgeFromEnv()` picks Jev when a key is set, else the rules, and wraps the
 * choice in `withDecisionLog` so EVERY decision — inputs summary, options,
 * answer, probability, model, milliseconds — lands in main's log and a wrong
 * call can be traced back to what the judge was shown.
 *
 * Option names are written out in full on purpose (`reject_impersonation`,
 * `temp_ban_24h`, never `B`): a decision model leans on the option NAME.
 */

import { listHit } from "./names.js";

export type JudgeTask = "name" | "audit" | "item-claim";

export interface JudgeQuestion<Option extends string> {
  task: JudgeTask;
  /** What is being decided, in plain words. */
  question: string;
  /** The only valid answers. */
  options: readonly Option[];
  /** JSON: the name / the audit bundle / the item-log slice. */
  evidence: unknown;
}

export interface JudgeDecision<Option extends string> {
  answer: Option;
  /** The judge's probability for `answer`, 0..1. */
  probability: number;
  /** Which model decided (provider model id, or "rules"). */
  model: string;
}

export interface ModerationJudge {
  decide<Option extends string>(q: JudgeQuestion<Option>): Promise<JudgeDecision<Option>>;
}

/** Where decision lines go (main passes its `log`). */
export type JudgeLog = (line: string) => void;

// ---------------------------------------------------------------------------
// decision log

/** A short, single-line rendering of the evidence for the log (never the whole bundle). */
export function summarizeEvidence(evidence: unknown, max = 240): string {
  let text: string;
  try {
    text = JSON.stringify(evidence) ?? String(evidence);
  } catch {
    text = String(evidence);
  }
  return text.length > max ? `${text.slice(0, max)}… (${text.length} chars)` : text;
}

/**
 * Wrap a judge so every decision (and every failure) is written to `log` with
 * what it was asked, what it answered, how sure it was, which model, and how
 * long it took. Failures are logged and re-thrown — the caller decides what
 * "no decision" means for its task.
 */
export function withDecisionLog(judge: ModerationJudge, log: JudgeLog): ModerationJudge {
  return {
    async decide<Option extends string>(q: JudgeQuestion<Option>): Promise<JudgeDecision<Option>> {
      const start = Date.now();
      const head = `[moderation] judge task=${q.task} options=${q.options.join("|")} evidence=${summarizeEvidence(q.evidence)}`;
      try {
        const d = await judge.decide(q);
        log(`${head} -> ${d.answer} p=${d.probability.toFixed(3)} model=${d.model} ${Date.now() - start}ms`);
        return d;
      } catch (error) {
        log(`${head} -> FAILED (${error instanceof Error ? error.message : String(error)}) ${Date.now() - start}ms`);
        throw error;
      }
    },
  };
}

/** Throws unless `answer` is one of `options` (the guard every adapter runs on what comes back). */
export function assertOption<Option extends string>(answer: unknown, options: readonly Option[], source: string): Option {
  if (typeof answer !== "string" || !(options as readonly string[]).includes(answer)) {
    throw new Error(`${source} answered ${JSON.stringify(answer)}, which is not one of the declared options (${options.join(", ")})`);
  }
  return answer as Option;
}

// ---------------------------------------------------------------------------
// RuleJudge

/**
 * The deterministic stand-in.
 *
 *   name        evidence `{ name }` (or a bare string). The word list
 *               (names.ts) decides: no hit → `accept`; a hit → the matching
 *               reject option (`reject_impersonation` for staff titles and the
 *               game's reserved names, `reject_offensive` for the obscenity
 *               list, else `reject_other`). Probability 0.99 both ways.
 *   audit       evidence `{ reports: [{ reporter }] }`. Fewer than THREE
 *               distinct reporters → `no_action` (0.99): the audit rule
 *               (§3: 3 reports from 3 accounts) was not met, so there is
 *               nothing to judge. Anything else → `escalate` (1.0): rules do
 *               not sanction people, staff do.
 *   item-claim  always `escalate` (1.0).
 *
 * When the answer it would give is not among the caller's options it falls
 * back to `escalate`, then `reject_other`, and otherwise throws — it never
 * invents an answer.
 */
export class RuleJudge implements ModerationJudge {
  readonly model = "rules";
  constructor(private readonly opts: { reservedNames?: Iterable<string> } = {}) {}

  async decide<Option extends string>(q: JudgeQuestion<Option>): Promise<JudgeDecision<Option>> {
    const pick = (wanted: string[], probability: number): JudgeDecision<Option> => {
      for (const w of wanted) if ((q.options as readonly string[]).includes(w)) return { answer: w as Option, probability, model: this.model };
      throw new Error(`rules: none of ${wanted.join(", ")} is among the options (${q.options.join(", ")})`);
    };
    if (q.task === "name") {
      const ev = q.evidence as { name?: unknown } | string | null;
      const name = typeof ev === "string" ? ev : typeof ev?.name === "string" ? ev.name : "";
      const hit = listHit(name, this.opts.reservedNames ? { reserved: this.opts.reservedNames } : {});
      if (!hit) return pick(["accept"], 0.99);
      const want = hit.category === "obscene" ? "reject_offensive" : "reject_impersonation";
      return pick([want, "reject_other"], 0.99);
    }
    if (q.task === "audit") {
      const reports = (q.evidence as { reports?: unknown } | null)?.reports;
      if (Array.isArray(reports)) {
        const reporters = new Set(
          reports.map((r, i) => {
            const who = (r as { reporter?: unknown; reporterAccount?: unknown } | null) ?? {};
            return typeof who.reporter === "string" ? who.reporter : typeof who.reporterAccount === "string" ? who.reporterAccount : `#${i}`;
          }),
        );
        if (reporters.size < 3) return pick(["no_action", "escalate"], 0.99);
      }
      return pick(["escalate"], 1);
    }
    return pick(["escalate"], 1);
  }
}

// ---------------------------------------------------------------------------
// JevJudge

/**
 * Plain-words descriptions for the option names the engine uses. Jev's choice
 * questions take a label → description map (`criteria`); an option not in this
 * table is described by its own name with the underscores spaced out.
 */
const OPTION_TEXT: Record<string, string> = {
  accept: "The name is fine for a fantasy game character.",
  reject_offensive: "The name is obscene, hateful, sexual, or insulting, including disguised spellings.",
  reject_impersonation: "The name poses as game staff (GM, admin, moderator, developer, support) or as a character in the game.",
  reject_real_person: "The name is that of a real, identifiable person (celebrity, politician, public figure).",
  reject_other: "The name is unacceptable for another clear reason (spam, advertising, gibberish meant to annoy).",
  no_action: "The reports do not show a rule being broken.",
  warn: "A minor first offence: a warning is enough.",
  mute_1h: "Abusive chat that warrants a one-hour mute.",
  mute_24h: "Repeated or serious abusive chat that warrants a 24-hour mute.",
  temp_ban_24h: "A serious offence that warrants a 24-hour ban from the game.",
  temp_ban_7d: "A severe or repeated serious offence that warrants a seven-day ban.",
  escalate: "Unclear or serious: a human staff member must decide.",
  restore: "The log shows the item was lost in a way that should be restored.",
  deny: "The log shows the item was lost by normal play (or never owned): no restore.",
};

export interface JevJudgeOptions {
  apiKey: string;
  /** Endpoint (default `https://api.typesafe.ai/v1/systemone`; env `JEV_API_URL`). */
  url?: string;
  /** Model id sent with each call (default `jev-latest`; env `JEV_MODEL`). */
  model?: string;
  /** Per-attempt timeout (default 10 s). */
  timeoutMs?: number;
  /** Extra attempts after a 429, a 5xx, a timeout or a network error (default 2). */
  retries?: number;
  /** First backoff (default 400 ms, doubled per retry; a Retry-After header wins, capped at 10 s). */
  backoffMs?: number;
  /** Injectable fetch (tests). */
  fetch?: typeof fetch;
}

export const JEV_DEFAULT_URL = "https://api.typesafe.ai/v1/systemone";
const QUESTION_ID = "decision";

/**
 * THE WIRE SHAPE — the one place to change if TypeSafe's API differs.
 *
 * Written against TypeSafe's "System One" endpoint as documented by LiteLLM's
 * TypeSafe pass-through and OpenRouter's Jev guide (2026-10): `POST
 * /v1/systemone`, `Authorization: Bearer <key>`, a `state` (text) and a map of
 * named questions; a `choice` question carries `instructions` and `criteria`
 * (label → description, 1..255 labels). The response carries
 * `answers.<id>.choice`, per-label `probabilities` and an overall `confidence`.
 */
export function jevRequest(q: JudgeQuestion<string>, model: string): unknown {
  return {
    model,
    state: JSON.stringify({ task: q.task, evidence: q.evidence }),
    questions: {
      [QUESTION_ID]: {
        type: "choice",
        instructions: q.question,
        criteria: Object.fromEntries(q.options.map((o) => [o, OPTION_TEXT[o] ?? o.replace(/_/g, " ")])),
      },
    },
  };
}

/**
 * Read one decision out of a response body (the other half of the wire shape).
 * The probability reported is the one Jev gives the CHOSEN label
 * (`probabilities[choice]`); `confidence` is the fallback when no per-label
 * map comes back. Anything off-list or malformed throws.
 */
export function jevAnswer<Option extends string>(body: unknown, options: readonly Option[], fallbackModel: string): JudgeDecision<Option> {
  const b = body as { model?: unknown; answers?: Record<string, { choice?: unknown; probabilities?: Record<string, unknown>; confidence?: unknown }> } | null;
  const a = b?.answers?.[QUESTION_ID];
  if (!a) throw new Error("jev: response has no answer for the question");
  const answer = assertOption(a.choice, options, "jev");
  const p = a.probabilities?.[answer] ?? a.confidence;
  if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) throw new Error(`jev: probability ${JSON.stringify(p)} is not a number in 0..1`);
  return { answer, probability: p, model: typeof b?.model === "string" ? b.model : fallbackModel };
}

class RetryableError extends Error {
  constructor(message: string, readonly retryAfterMs: number | null = null) {
    super(message);
  }
}

export class JevJudge implements ModerationJudge {
  private readonly url: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly fetch: typeof fetch;

  constructor(private readonly opts: JevJudgeOptions) {
    if (!opts.apiKey) throw new Error("JevJudge: an API key is required (JEV_API_KEY)");
    this.url = opts.url ?? JEV_DEFAULT_URL;
    this.model = opts.model ?? "jev-latest";
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.retries = Math.max(0, opts.retries ?? 2);
    this.backoffMs = opts.backoffMs ?? 400;
    this.fetch = opts.fetch ?? fetch;
  }

  async decide<Option extends string>(q: JudgeQuestion<Option>): Promise<JudgeDecision<Option>> {
    if (q.options.length === 0 || q.options.length > 255) throw new Error(`jev: a choice takes 1..255 options, got ${q.options.length}`);
    const payload = JSON.stringify(jevRequest(q, this.model));
    let last: unknown = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) {
        const hinted = last instanceof RetryableError ? last.retryAfterMs : null;
        await new Promise((r) => setTimeout(r, Math.min(10_000, hinted ?? this.backoffMs * 2 ** (attempt - 1))));
      }
      try {
        return jevAnswer(await this.post(payload), q.options, this.model);
      } catch (error) {
        last = error;
        if (!(error instanceof RetryableError)) throw error;
      }
    }
    throw new Error(`jev: gave up after ${this.retries + 1} attempts: ${last instanceof Error ? last.message : String(last)}`);
  }

  private async post(payload: string): Promise<unknown> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` },
        body: payload,
        signal: ctl.signal,
      });
    } catch (error) {
      // a timeout or a dropped connection: worth another try
      throw new RetryableError(ctl.signal.aborted ? `timed out after ${this.timeoutMs} ms` : `network: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get("retry-after"));
      throw new RetryableError(`HTTP ${res.status}`, Number.isFinite(ra) && ra > 0 ? ra * 1000 : null);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`jev: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    return res.json();
  }
}

// ---------------------------------------------------------------------------

/**
 * The judge a cluster runs: Jev when `JEV_API_KEY` is set (endpoint
 * `JEV_API_URL`, model `JEV_MODEL`), else the rules. Always decision-logged
 * through `log`.
 */
export function judgeFromEnv(opts: { log?: JudgeLog; env?: Record<string, string | undefined>; reservedNames?: Iterable<string>; fetch?: typeof fetch } = {}): ModerationJudge {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => console.log(line));
  const key = env["JEV_API_KEY"];
  const judge: ModerationJudge = key
    ? new JevJudge({
        apiKey: key,
        ...(env["JEV_API_URL"] ? { url: env["JEV_API_URL"] } : {}),
        ...(env["JEV_MODEL"] ? { model: env["JEV_MODEL"] } : {}),
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      })
    : new RuleJudge(opts.reservedNames ? { reservedNames: opts.reservedNames } : {});
  log(`[moderation] judge: ${key ? `jev (${env["JEV_API_URL"] ?? JEV_DEFAULT_URL})` : "rules (no JEV_API_KEY)"}`);
  return withDecisionLog(judge, log);
}
