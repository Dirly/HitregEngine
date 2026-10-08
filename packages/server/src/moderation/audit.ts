import type { ModerationJudge, JudgeLog } from "./judge.js";
import type { NameModeration } from "./names.js";
import type { ModerationRecord, Report, ReportStore } from "./reports.js";
import {
  AUDIT_OPTIONS,
  activeSanctions,
  auditsOf,
  newModerationId,
  pruneAudits,
  sanctionsOf,
  type ActiveSanctions,
  type Audit,
  type AuditAction,
  type AuditOption,
  type ModerationQueue,
  type Sanction,
  type SanctionKind,
} from "./sanctions.js";

/**
 * AUDITS — reports in, a verdict out (docs/moderation.md §3).
 *
 * Main calls `afterReport` once a report is stored. Two roads:
 *
 *   a name report   skips the count: the reported character's name goes
 *                   through the full name check (word list, then the judge,
 *                   names.ts). Refused above the name threshold → a `rename`
 *                   sanction on that character (they keep playing; the next
 *                   `/play` asks for a new name). Below it → the name review
 *                   list. Never a ban.
 *   anything else   the AUDIT RULE: the open reports of the last 24 hours,
 *                   one vote per distinct reporter ACCOUNT, must weigh at
 *                   least 3. A reporter counts half when their account is
 *                   less than an hour old (throwaway accounts), or when the
 *                   reported account has blocked them (a feud, not a
 *                   witness). One report never acts on its own.
 *
 * An audit hands the judge every open report against the account — with its
 * stored evidence — and the account's sanction history, and asks for one of
 * `no_action | warn | mute_1h | mute_24h | temp_ban_24h | temp_ban_7d |
 * escalate`. The answer is applied only when its probability clears that
 * action's threshold (warn 0.70, mutes 0.85, bans 0.95, no_action 0.70);
 * anything less, every `escalate`, and any judge failure goes to the
 * escalation queue for staff. Either way the audited reports close, with
 * the audit as their outcome, so the same reports never audit twice.
 *
 * Audits of one account run one at a time (a chain per account); reports
 * filed while one runs are judged by the next.
 *
 * Enforcement is not here: `enforce` is main's hook (push a mute, end a
 * banned player's session, deliver a warn line), called after the record
 * is written.
 */

export interface AuditRule {
  /** Reports older than this do not count toward opening an audit (default 24 h). */
  windowMs: number;
  /** Weighted distinct reporters needed (default 3). */
  reporters: number;
  /** A reporter account younger than this counts `lightWeight` (default 1 h). */
  newAccountMs: number;
  /** What a new or blocked reporter counts for (default 0.5). */
  lightWeight: number;
}

export const DEFAULT_AUDIT_RULE: AuditRule = { windowMs: 24 * 3600_000, reporters: 3, newAccountMs: 3600_000, lightWeight: 0.5 };

/** The probability an answer must clear before it is applied. */
export interface VerdictThresholds {
  no_action: number;
  warn: number;
  mute: number;
  ban: number;
}

export const DEFAULT_VERDICT_THRESHOLDS: VerdictThresholds = { no_action: 0.7, warn: 0.7, mute: 0.85, ban: 0.95 };

export const AUDIT_QUESTION =
  "Players of an online game reported this account. Read the reports, the chat evidence stored with each one (who spoke, and whether the reporter heard it) and the account's earlier sanctions. Which action fits what the evidence shows? Choose no_action when the evidence does not show a rule being broken, and escalate when a human must decide.";

/** What each answer does: a sanction kind and how long, or nothing. */
export const ACTION_EFFECT: Record<AuditAction, { kind: SanctionKind; ms?: number } | null> = {
  no_action: null,
  warn: { kind: "warn" },
  mute_1h: { kind: "mute", ms: 3600_000 },
  mute_24h: { kind: "mute", ms: 24 * 3600_000 },
  temp_ban_24h: { kind: "ban", ms: 24 * 3600_000 },
  temp_ban_7d: { kind: "ban", ms: 7 * 24 * 3600_000 },
};

export function thresholdFor(action: AuditAction, t: VerdictThresholds): number {
  const kind = ACTION_EFFECT[action]?.kind;
  return kind === "mute" ? t.mute : kind === "ban" ? t.ban : kind === "warn" ? t.warn : t.no_action;
}

/** A sanction was given or lifted: main makes it true on the servers. */
export type Enforce = (account: string, change: { sanction: Sanction; lifted: boolean }) => void | Promise<void>;

export interface ModerationDeskOptions {
  store: ReportStore;
  queue: ModerationQueue;
  /** Null: no judge — every audit goes to staff. */
  judge: ModerationJudge | null;
  names: NameModeration;
  /** When an account was made (epoch ms); null when unknown (counts as old). */
  accountCreatedAt: (account: string) => Promise<number | null>;
  /** Has `account` blocked `other`? */
  hasBlocked: (account: string, other: string) => Promise<boolean>;
  enforce: Enforce;
  rule?: Partial<AuditRule>;
  thresholds?: Partial<VerdictThresholds>;
  now?: () => number;
  log?: JudgeLog;
}

/** One reporter's vote in the audit rule. */
export interface ReporterWeight {
  account: string;
  weight: number;
  newAccount: boolean;
  blocked: boolean;
}

export type AuditResult =
  | { kind: "none"; weight: number }
  | { kind: "decided"; audit: Audit; sanction: Sanction | null }
  | { kind: "escalated"; audit: Audit }
  | { kind: "name"; outcome: "rename" | "review" | "accepted"; sanction?: Sanction };

const KIND_WORDS: Record<string, string> = { chat: "abusive chat", cheating: "cheating", other: "misconduct", name: "an unsuitable name" };

/** The reason a player reads for a judge's sanction: what they were reported for. */
export function reportedFor(reports: readonly Report[]): string {
  const kinds = [...new Set(reports.map((r) => KIND_WORDS[r.kind] ?? r.kind))];
  return `reported by ${new Set(reports.map((r) => r.reporterAccount)).size} players for ${kinds.join(" and ")}`;
}

export class ModerationDesk {
  readonly rule: AuditRule;
  readonly thresholds: VerdictThresholds;
  private readonly now: () => number;
  private readonly log: JudgeLog;
  /** One audit chain per account. */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly opts: ModerationDeskOptions) {
    this.rule = { ...DEFAULT_AUDIT_RULE, ...opts.rule };
    this.thresholds = { ...DEFAULT_VERDICT_THRESHOLDS, ...opts.thresholds };
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => undefined);
  }

  /** Runs `fn` after whatever this account is already doing. */
  private serial<T>(account: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(account) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.chains.set(account, next);
    void next.finally(() => {
      if (this.chains.get(account) === next) this.chains.delete(account);
    }).catch(() => undefined);
    return next;
  }

  /** Every audit in flight has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.chains.size > 0) await Promise.allSettled([...this.chains.values()]);
  }

  /** The hook main calls after `POST /reports` stored `report` against `account`. */
  afterReport(report: Report, account: string): Promise<AuditResult> {
    return this.serial(account, () => (report.kind === "name" ? this.judgeName(account, report) : this.maybeAudit(account)));
  }

  /** The weights of the reporters behind these reports (one per distinct account). */
  async weigh(account: string, reports: readonly Report[]): Promise<ReporterWeight[]> {
    const out: ReporterWeight[] = [];
    const seen = new Set<string>();
    for (const r of reports) {
      if (seen.has(r.reporterAccount)) continue;
      seen.add(r.reporterAccount);
      const created = await this.opts.accountCreatedAt(r.reporterAccount).catch(() => null);
      const newAccount = created !== null && r.at - created < this.rule.newAccountMs;
      const blocked = await this.opts.hasBlocked(account, r.reporterAccount).catch(() => false);
      out.push({ account: r.reporterAccount, weight: newAccount || blocked ? this.rule.lightWeight : 1, newAccount, blocked });
    }
    return out;
  }

  /** The audit rule over an account's open (non-name) reports; runs the audit when it is met. */
  private async maybeAudit(account: string): Promise<AuditResult> {
    const now = this.now();
    const open = (await this.opts.store.openReports(account)).filter((r) => r.kind !== "name");
    const recent = open.filter((r) => now - r.at < this.rule.windowMs);
    const weights = await this.weigh(account, recent);
    const weight = weights.reduce((n, w) => n + w.weight, 0);
    if (weight < this.rule.reporters) return { kind: "none", weight };
    return this.runAudit(account, open, weights, weight);
  }

  /** The bundle the judge reads: every open report with its evidence, and the account's history. */
  async bundle(account: string, reports: readonly Report[], weights: readonly ReporterWeight[]): Promise<unknown> {
    const record = await this.opts.store.load(account);
    const w = new Map(weights.map((x) => [x.account, x]));
    return {
      account,
      reports: reports.map((r) => ({
        id: r.id,
        reporter: r.reporterAccount,
        reporterAccount: r.reporterAccount,
        reporterName: r.reporterName,
        reported: r.targetName,
        kind: r.kind,
        reason: r.reason,
        at: new Date(r.at).toISOString(),
        weight: w.get(r.reporterAccount)?.weight ?? 1,
        reporterAccountIsNew: w.get(r.reporterAccount)?.newAccount ?? false,
        reporterBlockedByReported: w.get(r.reporterAccount)?.blocked ?? false,
        evidence: record.evidence[r.evidenceId] ?? null,
      })),
      sanctionHistory: sanctionsOf(record).map((s) => ({
        kind: s.kind,
        reason: s.reason,
        by: s.by,
        at: new Date(s.at).toISOString(),
        ...(s.until !== undefined ? { until: new Date(s.until).toISOString() } : {}),
        ...(s.liftedAt !== undefined ? { lifted: true } : {}),
      })),
      earlierAudits: auditsOf(record).length,
    };
  }

  private async runAudit(account: string, reports: Report[], weights: ReporterWeight[], weight: number): Promise<AuditResult> {
    const audit: Audit = { id: newModerationId("aud"), at: this.now(), reportIds: reports.map((r) => r.id), weight, status: "escalated" };
    let action: AuditAction | null = null;
    if (!this.opts.judge) {
      audit.why = "judge_error";
      audit.error = "no judge configured";
    } else {
      try {
        const evidence = await this.bundle(account, reports, weights);
        const d = await this.opts.judge.decide<AuditOption>({ task: "audit", question: AUDIT_QUESTION, options: AUDIT_OPTIONS, evidence });
        audit.answer = d.answer;
        audit.probability = d.probability;
        audit.model = d.model;
        if (d.answer === "escalate") audit.why = "escalate";
        else if (d.probability > thresholdFor(d.answer, this.thresholds)) action = d.answer;
        else audit.why = "below_threshold";
      } catch (error) {
        audit.why = "judge_error";
        audit.error = error instanceof Error ? error.message : String(error);
      }
    }
    const reason = reportedFor(reports);
    let sanction: Sanction | null = null;
    if (action) {
      audit.status = "decided";
      audit.action = action;
      audit.decidedBy = "judge";
      audit.decidedAt = audit.at;
      sanction = this.sanctionFor(action, reason, "judge", audit.id);
      if (sanction) audit.sanctionId = sanction.id;
    }
    const outcome = `audit:${audit.id}:${action ?? "escalated"}`;
    await this.opts.store.mutate(account, (record) => {
      for (const r of record.reports) {
        if (audit.reportIds.includes(r.id) && r.status === "open") {
          r.status = "closed";
          r.closedAt = audit.at;
          r.outcome = outcome;
        }
      }
      auditsOf(record).push(audit);
      if (sanction) sanctionsOf(record).push(sanction);
      pruneAudits(record);
    });
    this.log(`[moderation] audit ${audit.id} of ${account}: ${reports.length} report(s), weight ${weight} -> ${action ?? `escalated (${audit.why})`}`);
    if (!action) {
      await this.opts.queue.addEscalation({
        auditId: audit.id,
        account,
        at: audit.at,
        why: audit.why!,
        ...(audit.answer ? { answer: audit.answer } : {}),
        ...(audit.probability !== undefined ? { probability: audit.probability } : {}),
        ...(audit.error ? { error: audit.error } : {}),
        reports: reports.length,
        names: [...new Set(reports.map((r) => r.targetName))],
      });
      return { kind: "escalated", audit };
    }
    if (sanction) await this.opts.enforce(account, { sanction, lifted: false });
    return { kind: "decided", audit, sanction };
  }

  private sanctionFor(action: AuditAction, reason: string, by: "judge" | "staff", auditId?: string): Sanction | null {
    const effect = ACTION_EFFECT[action];
    if (!effect) return null;
    const at = this.now();
    return { id: newModerationId("san"), kind: effect.kind, ...(effect.ms ? { until: at + effect.ms } : {}), reason, by, ...(auditId ? { auditId } : {}), at };
  }

  /** A name report: the full name check on the reported character's name, now. */
  private async judgeName(account: string, report: Report): Promise<AuditResult> {
    const verdict = await this.opts.names.check(report.targetName, { accountId: account, characterId: report.targetCharacter });
    const at = this.now();
    let sanction: Sanction | undefined;
    if (!verdict.ok) {
      const existing = activeSanctions(await this.opts.store.load(account), at).renames.find((s) => s.characterId === report.targetCharacter);
      if (!existing) {
        sanction = {
          id: newModerationId("san"),
          kind: "rename",
          reason: verdict.reason,
          by: "judge",
          at,
          characterId: report.targetCharacter,
          name: report.targetName,
        };
      }
    }
    const outcome = !verdict.ok ? "rename" : verdict.queued ? "review" : "accepted";
    await this.opts.store.mutate(account, (record) => {
      // every open name report on this character is answered by the same check
      for (const r of record.reports) {
        if (r.kind === "name" && r.status === "open" && r.targetCharacter === report.targetCharacter) {
          r.status = "closed";
          r.closedAt = at;
          r.outcome = `name:${outcome}`;
        }
      }
      if (sanction) sanctionsOf(record).push(sanction);
    });
    this.log(`[moderation] name report on "${report.targetName}" (${account}): ${outcome}`);
    if (sanction) await this.opts.enforce(account, { sanction, lifted: false });
    return { kind: "name", outcome, ...(sanction ? { sanction } : {}) };
  }

  // -- staff ------------------------------------------------------------------------

  /** Staff decide an escalated audit. */
  async decide(auditId: string, action: AuditAction): Promise<{ audit: Audit; sanction: Sanction | null }> {
    const q = await this.opts.queue.load();
    const entry = q.escalations.find((e) => e.auditId === auditId);
    if (!entry) throw new ModerationError(404, `no escalated audit "${auditId}"`);
    if (!(AUDIT_OPTIONS as readonly string[]).includes(action) || action === ("escalate" as string)) {
      throw new ModerationError(400, `action must be one of: ${AUDIT_OPTIONS.filter((o) => o !== "escalate").join(", ")}`);
    }
    const account = entry.account;
    return this.serial(account, async () => {
      let audit: Audit | null = null;
      let sanction: Sanction | null = null;
      await this.opts.store.mutate(account, (record) => {
        audit = auditsOf(record).find((a) => a.id === auditId) ?? null;
        if (!audit) throw new ModerationError(404, `audit "${auditId}" is not on ${account}'s record`);
        const reports = record.reports.filter((r) => audit!.reportIds.includes(r.id));
        sanction = this.sanctionFor(action, reportedFor(reports), "staff", auditId);
        audit.status = "decided";
        audit.action = action;
        audit.decidedBy = "staff";
        audit.decidedAt = this.now();
        if (sanction) {
          audit.sanctionId = sanction.id;
          sanctionsOf(record).push(sanction);
        }
        for (const r of reports) r.outcome = `audit:${auditId}:${action}`;
      });
      await this.opts.queue.removeEscalation(auditId);
      if (sanction) await this.opts.enforce(account, { sanction, lifted: false });
      return { audit: audit!, sanction };
    });
  }

  /** Staff give a sanction directly (`minutes` for mute/ban; a rename names the character). */
  async sanction(account: string, input: { kind: SanctionKind; minutes?: number; reason: string; characterId?: string; name?: string }): Promise<Sanction> {
    const at = this.now();
    if ((input.kind === "mute" || input.kind === "ban") && !(typeof input.minutes === "number" && input.minutes > 0)) {
      throw new ModerationError(400, `a ${input.kind} needs minutes (a positive number)`);
    }
    if (input.kind === "rename" && !input.characterId) throw new ModerationError(400, "a rename needs the character (characterId)");
    const sanction: Sanction = {
      id: newModerationId("san"),
      kind: input.kind,
      ...(input.kind === "mute" || input.kind === "ban" ? { until: at + input.minutes! * 60_000 } : {}),
      reason: input.reason,
      by: "staff",
      at,
      ...(input.characterId ? { characterId: input.characterId } : {}),
      ...(input.name ? { name: input.name } : {}),
    };
    await this.serial(account, () => this.opts.store.mutate(account, (record) => void sanctionsOf(record).push(sanction)));
    await this.opts.enforce(account, { sanction, lifted: false });
    return sanction;
  }

  /** Staff lift every sanction of a kind that is in force. */
  async lift(account: string, kind: SanctionKind): Promise<Sanction[]> {
    const now = this.now();
    const lifted: Sanction[] = [];
    await this.serial(account, () =>
      this.opts.store.mutate(account, (record) => {
        lifted.length = 0;
        for (const s of sanctionsOf(record)) {
          if (s.kind !== kind || s.liftedAt !== undefined) continue;
          if (kind !== "warn" && s.until !== undefined && s.until <= now) continue;
          s.liftedAt = now;
          s.liftedBy = "staff";
          lifted.push({ ...s });
        }
      }),
    );
    for (const s of lifted) await this.opts.enforce(account, { sanction: s, lifted: true });
    return lifted;
  }

  /** A rename sanction is cleared by the rename itself. */
  async renamed(account: string, characterId: string, newName: string): Promise<void> {
    const now = this.now();
    await this.serial(account, () =>
      this.opts.store.mutate(account, (record) => {
        for (const s of sanctionsOf(record)) {
          if (s.kind === "rename" && s.characterId === characterId && s.liftedAt === undefined) {
            s.liftedAt = now;
            s.liftedBy = "rename";
            s.newName = newName;
          }
        }
      }),
    );
  }

  /** What is in force on an account now. */
  async active(account: string): Promise<ActiveSanctions> {
    return activeSanctions(await this.opts.store.load(account), this.now());
  }

  /** Mark warns as shown to the player. */
  async delivered(account: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const now = this.now();
    await this.opts.store.mutate(account, (record: ModerationRecord) => {
      for (const s of sanctionsOf(record)) if (ids.includes(s.id) && s.deliveredAt === undefined) s.deliveredAt = now;
    });
  }
}

/** A refusal with an HTTP status (staff routes). */
export class ModerationError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
