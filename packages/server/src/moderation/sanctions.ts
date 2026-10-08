import { randomBytes } from "node:crypto";
import type { PlayerDataBackend, PlayerDataRecord } from "@hitreg/core";
import type { ModerationRecord } from "./reports.js";
import type { NameReview } from "./names.js";

/**
 * Sanctions — what an audit or a staff member did to an account, and what is
 * in force right now (docs/moderation.md §3).
 *
 * Everything lives in the account's `moderation` record beside the reports
 * (reports.ts carries unknown fields through every write):
 *
 *   sanctions   every sanction ever given, newest last, never deleted — a
 *               lifted one keeps `liftedAt`/`liftedBy`, an expired one just
 *               has its `until` in the past. History is what the judge reads
 *               on the next audit ("the account's sanction history").
 *   audits      every audit that ran: which reports, what the judge said,
 *               what was done, and whether staff still have to decide.
 *
 * In force = not lifted and (no `until`, or `until` in the future). A warn is
 * never "in force"; it is delivered once (a system line) and marked.
 *
 * Main also keeps ONE cluster-level record (`ModerationQueue`): the
 * escalation queue and the name review list staff read at
 * `GET /admin/moderation/queue`. Player data has no "list every account"
 * call, so the queue is the index into the per-account records.
 *
 * This file is shared: the layer imports `formatUntil`/`muteLine` for the
 * line it shows a muted player, so nothing here may reach for main.
 */

export const SANCTION_KINDS = ["warn", "mute", "ban", "rename"] as const;
export type SanctionKind = (typeof SANCTION_KINDS)[number];

export interface Sanction {
  id: string;
  kind: SanctionKind;
  /** Epoch ms it ends (mute, ban). Absent: warn (a mark), rename (until the character picks a new name). */
  until?: number;
  /** Plain words, shown to the player. */
  reason: string;
  by: "judge" | "staff";
  /** The audit that gave it (judge verdicts and staff decisions on an escalation). */
  auditId?: string;
  /** Epoch ms given. */
  at: number;
  /** A rename names the character whose name was refused. */
  characterId?: string;
  /** The refused name (rename). */
  name?: string;
  /** Lifted before its time: by staff, or by the rename that cleared it. */
  liftedAt?: number;
  liftedBy?: "staff" | "rename";
  /** The name the character took (a cleared rename). */
  newName?: string;
  /** A warn (or a mute/ban's notice) reached the player as a system line. */
  deliveredAt?: number;
}

export const AUDIT_OPTIONS = ["no_action", "warn", "mute_1h", "mute_24h", "temp_ban_24h", "temp_ban_7d", "escalate"] as const;
export type AuditOption = (typeof AUDIT_OPTIONS)[number];
/** What staff may decide on an escalated audit (everything but passing it on again). */
export type AuditAction = Exclude<AuditOption, "escalate">;
export const AUDIT_ACTIONS: readonly AuditAction[] = AUDIT_OPTIONS.filter((o): o is AuditAction => o !== "escalate");

export interface Audit {
  id: string;
  at: number;
  reportIds: string[];
  /** Sum of the reporters' weights when it opened (3 = three ordinary reporters). */
  weight: number;
  /** decided: an action was applied (by the judge or staff). escalated: staff must decide. */
  status: "decided" | "escalated";
  answer?: AuditOption;
  probability?: number;
  model?: string;
  /** Why staff got it: the judge said escalate, was not sure enough, or failed. */
  why?: "escalate" | "below_threshold" | "judge_error";
  error?: string;
  action?: AuditAction;
  decidedBy?: "judge" | "staff";
  decidedAt?: number;
  sanctionId?: string;
}

/** The sanction fields of a `moderation` record, every list present. */
export function sanctionsOf(record: ModerationRecord): Sanction[] {
  if (!Array.isArray(record["sanctions"])) record["sanctions"] = [];
  return record["sanctions"] as Sanction[];
}

export function auditsOf(record: ModerationRecord): Audit[] {
  if (!Array.isArray(record["audits"])) record["audits"] = [];
  return record["audits"] as Audit[];
}

/** Audits a record keeps (oldest decided first out; escalated ones stay). */
export const MAX_AUDITS = 200;

export function pruneAudits(record: ModerationRecord): void {
  const audits = auditsOf(record);
  if (audits.length <= MAX_AUDITS) return;
  const excess = audits.length - MAX_AUDITS;
  const drop = new Set(audits.filter((a) => a.status === "decided").slice(0, excess).map((a) => a.id));
  record["audits"] = audits.filter((a) => !drop.has(a.id));
}

export function inForce(s: Sanction, now: number): boolean {
  if (s.liftedAt !== undefined) return false;
  if (s.kind === "warn") return false;
  return s.until === undefined || s.until > now;
}

export interface ActiveSanctions {
  /** The mute ending last, if any. */
  mute: Sanction | null;
  ban: Sanction | null;
  /** Rename sanctions in force, by character id. */
  renames: Sanction[];
  /** Warns not yet shown to the player. */
  undeliveredWarns: Sanction[];
}

export function activeSanctions(record: ModerationRecord, now: number): ActiveSanctions {
  const out: ActiveSanctions = { mute: null, ban: null, renames: [], undeliveredWarns: [] };
  for (const s of sanctionsOf(record)) {
    if (s.kind === "warn") {
      if (s.liftedAt === undefined && s.deliveredAt === undefined) out.undeliveredWarns.push(s);
      continue;
    }
    if (!inForce(s, now)) continue;
    if (s.kind === "rename") out.renames.push(s);
    else if (s.kind === "mute" && (!out.mute || (s.until ?? Infinity) > (out.mute.until ?? Infinity))) out.mute = s;
    else if (s.kind === "ban" && (!out.ban || (s.until ?? Infinity) > (out.ban.until ?? Infinity))) out.ban = s;
  }
  return out;
}

export function newModerationId(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString("hex")}`;
}

// -- the words a player reads -------------------------------------------------------

/** "2026-10-07 14:05 UTC" — one unambiguous form for every player, whatever their clock. */
export function formatUntil(until: number | undefined): string {
  if (until === undefined || !Number.isFinite(until)) return "further notice";
  return `${new Date(until).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function muteLine(until: number | undefined, reason: string): string {
  return `You are muted until ${formatUntil(until)} (${reason}).`;
}

export function banLine(until: number | undefined, reason: string): string {
  return `This account is banned until ${formatUntil(until)} (${reason}).`;
}

export function warnLine(reason: string): string {
  return `Warning from the moderators: ${reason}. Further reports can lead to a mute or a ban.`;
}

export function renameLine(name: string): string {
  return `The name "${name}" was refused. You can keep playing now; you will be asked to choose a new name the next time you enter the world.`;
}

// -- the cluster-level queue ------------------------------------------------------------

/** One escalated audit waiting for staff. */
export interface Escalation {
  auditId: string;
  account: string;
  at: number;
  why: NonNullable<Audit["why"]>;
  answer?: AuditOption;
  probability?: number;
  error?: string;
  reports: number;
  /** The reported characters' names at the time (for the list; the record has the detail). */
  names: string[];
}

export interface QueueRecord {
  escalations: Escalation[];
  /** Names accepted below the judge's threshold or while it was down (step 1's review list, persisted). */
  names: NameReview[];
}

export const MODERATION_QUEUE_SCOPE = "moderation-main";
export const MODERATION_QUEUE_NAMESPACE = "moderation-queue";
/** Names kept on the review list (oldest out first). */
export const NAME_REVIEW_LIMIT = 500;

function normalizeQueue(data: unknown): QueueRecord {
  const d = (data ?? {}) as Partial<QueueRecord>;
  return { ...d, escalations: Array.isArray(d.escalations) ? d.escalations : [], names: Array.isArray(d.names) ? d.names : [] };
}

/** Main's one queue record: compare-and-swap, like every other moderation write. */
export class ModerationQueue {
  constructor(
    private readonly backend: PlayerDataBackend,
    private readonly experienceId: string,
  ) {}

  private get scope() {
    return { playerId: MODERATION_QUEUE_SCOPE, experienceId: this.experienceId };
  }

  async load(): Promise<QueueRecord> {
    return normalizeQueue((await this.backend.load(this.scope, MODERATION_QUEUE_NAMESPACE))?.data);
  }

  async mutate(fn: (q: QueueRecord) => void): Promise<QueueRecord> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const current = await this.backend.load(this.scope, MODERATION_QUEUE_NAMESPACE);
      const q = normalizeQueue(current ? structuredClone(current.data) : undefined);
      fn(q);
      if (q.names.length > NAME_REVIEW_LIMIT) q.names.splice(0, q.names.length - NAME_REVIEW_LIMIT);
      const next: PlayerDataRecord = {
        schemaVersion: current?.schemaVersion ?? 1,
        revision: (current?.revision ?? -1) + 1,
        updatedAt: new Date().toISOString(),
        data: q as unknown as Record<string, unknown>,
      };
      if ((await this.backend.store(this.scope, MODERATION_QUEUE_NAMESPACE, next, current?.revision ?? null)) === "ok") return q;
    }
    throw new Error("moderation queue: too many concurrent writes");
  }

  addName(review: NameReview): Promise<QueueRecord> {
    return this.mutate((q) => {
      q.names.push(review);
    });
  }

  addEscalation(e: Escalation): Promise<QueueRecord> {
    return this.mutate((q) => {
      if (!q.escalations.some((x) => x.auditId === e.auditId)) q.escalations.push(e);
    });
  }

  removeEscalation(auditId: string): Promise<QueueRecord> {
    return this.mutate((q) => {
      q.escalations = q.escalations.filter((x) => x.auditId !== auditId);
    });
  }
}
