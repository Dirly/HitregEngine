import { randomBytes } from "node:crypto";
import type { PlayerDataBackend, PlayerDataRecord } from "@hitreg/core";
import type { MainToLayer } from "../cluster/protocol.js";
import { ChatBuffer, mergeEvidenceLines, toEvidenceLine, type ChatEvidence, type EvidenceLine } from "./chat-buffer.js";

/**
 * Player reports — the intake half of moderation (docs/moderation.md §2, §3).
 *
 * `/report <name> <reason>` lands on main as `POST /reports`. Main asks the
 * game server the reporter stands on (and the reported's, when that is a
 * different one) for the buffered chat lines either of them spoke
 * (`evidence.request`), adds the bridged lines it saw itself, and stores the
 * report WITH that bundle in the REPORTED account's `moderation` player-data
 * record — per account, because a new character is not a clean slate. Only
 * chat attached to a report is ever written down, and it is pruned after 30
 * days.
 *
 * Main is the only writer; the backend is compare-and-swap on revision, as
 * for `social`. Fields this module does not know (sanctions, name status —
 * step 3) are carried through every write untouched.
 *
 * Not here: the audit rule, the judge, sanctions. Step 3 reads
 * `ReportStore.openReports(account)` and closes reports with `mutate`.
 */

export const MODERATION_NAMESPACE = "moderation";
export const REPORT_KINDS = ["chat", "name", "cheating", "other"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** Evidence older than this is dropped on the next write to the record (30 days). */
export const EVIDENCE_TTL_MS = 30 * 24 * 3600_000;
/** Reports a record keeps (oldest closed ones go first). */
export const MAX_REPORTS = 500;
/** Longest reason kept. */
export const MAX_REASON = 500;
/** Minutes of chat asked for (the buffer's window). */
export const EVIDENCE_MINUTES = 15;

export interface Report {
  id: string;
  reporterAccount: string;
  reporterCharacter: string;
  reporterName: string;
  targetCharacter: string;
  targetName: string;
  kind: ReportKind;
  reason: string;
  /** Epoch ms. */
  at: number;
  /** Key into `ModerationRecord.evidence` (may be pruned by then). */
  evidenceId: string;
  /** "open" until an audit (step 3) closes it. */
  status: "open" | "closed";
  closedAt?: number;
  /** What closed it (an audit id, a staff decision) — step 3 writes it. */
  outcome?: string;
}

/** Where one of the two stood when the report came in, and on which server. */
export interface EvidenceParty {
  account: string;
  characterId: string;
  name: string;
  server: string | null;
  position: [number, number, number] | null;
  zone: string | null;
}

/** Everything gathered for one report. */
export interface EvidenceBundle {
  id: string;
  at: number;
  minutes: number;
  reporter: EvidenceParty;
  target: EvidenceParty;
  /** Game servers asked, and whether each answered in time. */
  servers: Array<{ id: string; answered: boolean }>;
  /** Lines either character spoke, from the servers and main's bridged buffer, oldest first. */
  lines: EvidenceLine[];
}

/** The `moderation` record of one account: reports received, with their evidence. */
export interface ModerationRecord {
  reports: Report[];
  evidence: Record<string, EvidenceBundle>;
  /** Anything else (sanctions, name status — step 3) is carried through untouched. */
  [key: string]: unknown;
}

export function normalizeModeration(data: unknown): ModerationRecord {
  const d = (data ?? {}) as Partial<ModerationRecord>;
  return {
    ...d,
    reports: Array.isArray(d.reports) ? d.reports : [],
    evidence: d.evidence && typeof d.evidence === "object" ? d.evidence : {},
  };
}

/** Drop evidence past its time and reports beyond the cap (closed ones first). */
export function pruneModeration(record: ModerationRecord, now: number): void {
  for (const [id, bundle] of Object.entries(record.evidence)) {
    if (!bundle || typeof bundle.at !== "number" || now - bundle.at > EVIDENCE_TTL_MS) delete record.evidence[id];
  }
  if (record.reports.length > MAX_REPORTS) {
    const excess = record.reports.length - MAX_REPORTS;
    const closed = record.reports.filter((r) => r.status !== "open").slice(0, excess);
    const drop = new Set(closed.map((r) => r.id));
    let kept = record.reports.filter((r) => !drop.has(r.id));
    if (kept.length > MAX_REPORTS) kept = kept.slice(kept.length - MAX_REPORTS);
    record.reports = kept;
  }
}

/** A refusal with an HTTP status; the message is shown to the player as-is. */
export class ReportError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export class ReportStore {
  constructor(
    private readonly backend: PlayerDataBackend,
    private readonly experienceId: string,
    private readonly now: () => number = Date.now,
  ) {}

  async load(account: string): Promise<ModerationRecord> {
    const record = await this.backend.load({ playerId: account, experienceId: this.experienceId }, MODERATION_NAMESPACE);
    return normalizeModeration(record?.data);
  }

  /** Read-modify-write with compare-and-swap; the mutation runs again on a conflict. Prunes on every write. */
  async mutate(account: string, fn: (record: ModerationRecord) => void): Promise<ModerationRecord> {
    const scope = { playerId: account, experienceId: this.experienceId };
    for (let attempt = 0; attempt < 6; attempt++) {
      const current = await this.backend.load(scope, MODERATION_NAMESPACE);
      const record = normalizeModeration(current ? structuredClone(current.data) : undefined);
      fn(record);
      pruneModeration(record, this.now());
      const next: PlayerDataRecord = {
        schemaVersion: current?.schemaVersion ?? 1,
        revision: (current?.revision ?? -1) + 1,
        updatedAt: new Date(this.now()).toISOString(),
        data: record as unknown as Record<string, unknown>,
      };
      const outcome = await this.backend.store(scope, MODERATION_NAMESPACE, next, current?.revision ?? null);
      if (outcome === "ok") return record;
    }
    throw new ReportError("moderation record: too many concurrent writes — try again", 503);
  }

  /** Reports against an account that no audit has closed yet, oldest first (step 3's input). */
  async openReports(account: string): Promise<Report[]> {
    const record = await this.load(account);
    return record.reports.filter((r) => r.status === "open").sort((a, b) => a.at - b.at);
  }

  /** The evidence bundle stored with a report, or null once pruned. */
  async evidence(account: string, evidenceId: string): Promise<EvidenceBundle | null> {
    const record = await this.load(account);
    return record.evidence[evidenceId] ?? null;
  }
}

/** List the open reports against an account — the entry point step 3's audit rule calls. */
export function listOpenReports(store: ReportStore, account: string): Promise<Report[]> {
  return store.openReports(account);
}

/**
 * `evidence.request` round trips: main sends the request down a layer's
 * socket, the layer answers with rpc `evidence.result`, `resolve` hands it
 * back. A server that does not answer in time gives null — the report is
 * still filed, with whatever main itself saw.
 */
export class EvidenceRequests {
  private readonly waiting = new Map<string, { resolve: (e: ChatEvidence | null) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly sendTo: (serverId: string, msg: MainToLayer) => boolean,
    private readonly timeoutMs = 3000,
  ) {}

  request(serverId: string, reporter: string, target: string, minutes: number): Promise<ChatEvidence | null> {
    return new Promise((resolve) => {
      const requestId = randomBytes(6).toString("hex");
      const timer = setTimeout(() => {
        this.waiting.delete(requestId);
        resolve(null);
      }, this.timeoutMs);
      this.waiting.set(requestId, { resolve, timer });
      if (!this.sendTo(serverId, { t: "evidence.request", requestId, reporter, target, minutes })) {
        clearTimeout(timer);
        this.waiting.delete(requestId);
        resolve(null);
      }
    });
  }

  /** A layer's `evidence.result`. Unknown or late ids are ignored. */
  resolve(requestId: string, evidence: ChatEvidence): void {
    const w = this.waiting.get(requestId);
    if (!w) return;
    this.waiting.delete(requestId);
    clearTimeout(w.timer);
    w.resolve(evidence);
  }

  dispose(): void {
    for (const w of this.waiting.values()) {
      clearTimeout(w.timer);
      w.resolve(null);
    }
    this.waiting.clear();
  }
}

/** A character as a report names it. */
export interface ReportParty {
  account: string;
  characterId: string;
  name: string;
}

export interface ReportIntakeOptions {
  store: ReportStore;
  /** Main's buffer of the lines it bridged between layers. */
  mainBuffer: ChatBuffer;
  requests: EvidenceRequests;
  /** The server a character stands on right now (registry.whereIs). */
  whereIs: (characterId: string) => string | undefined;
  /** Reports one account may file per hour (default 10). */
  perHour?: number;
  now?: () => number;
}

const HOUR_MS = 3600_000;

/** Control characters out, whitespace collapsed, capped — a reason is shown to staff and the judge as text. */
export function cleanReason(raw: unknown): string {
  if (typeof raw !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_REASON);
}

export function isReportKind(v: unknown): v is ReportKind {
  return typeof v === "string" && (REPORT_KINDS as readonly string[]).includes(v);
}

/**
 * Files reports: validates, rate-limits, gathers evidence, stores. The HTTP
 * route on main resolves the two characters and maps `ReportError` to a
 * response; everything else is here.
 */
export class ReportIntake {
  private readonly perHour: number;
  private readonly now: () => number;
  /** Filing times per reporter account in the last hour (memory: a restart forgives, the per-target rule is durable). */
  private readonly filed = new Map<string, number[]>();

  constructor(private readonly opts: ReportIntakeOptions) {
    this.perHour = opts.perHour ?? 10;
    this.now = opts.now ?? Date.now;
  }

  async file(input: { reporter: ReportParty; target: ReportParty; kind: unknown; reason: unknown }): Promise<{ report: Report; evidence: EvidenceBundle }> {
    const { reporter, target } = input;
    if (!isReportKind(input.kind)) throw new ReportError(`kind must be one of: ${REPORT_KINDS.join(", ")}`);
    const kind = input.kind;
    const reason = cleanReason(input.reason);
    if (!reason) throw new ReportError("say what happened — a report needs a reason");
    if (reporter.account === target.account) throw new ReportError("you cannot report yourself");

    const now = this.now();
    const recent = (this.filed.get(reporter.account) ?? []).filter((t) => now - t < HOUR_MS);
    if (recent.length >= this.perHour) throw new ReportError(`you have sent ${this.perHour} reports in the last hour — try again later`, 429);
    const already = (record: { reports: Report[] }): boolean =>
      record.reports.some((r) => r.reporterAccount === reporter.account && r.status === "open" && now - r.at < HOUR_MS);
    if (already(await this.opts.store.load(target.account))) throw new ReportError(`you already reported ${target.name} in the last hour`, 429);

    const evidence = await this.gather(reporter, target, now);
    const report: Report = {
      id: `rep-${randomBytes(6).toString("hex")}`,
      reporterAccount: reporter.account,
      reporterCharacter: reporter.characterId,
      reporterName: reporter.name,
      targetCharacter: target.characterId,
      targetName: target.name,
      kind,
      reason,
      at: now,
      evidenceId: evidence.id,
      status: "open",
    };
    await this.opts.store.mutate(target.account, (record) => {
      // checked again under compare-and-swap: two quick reports cannot both land
      if (already(record)) throw new ReportError(`you already reported ${target.name} in the last hour`, 429);
      record.reports.push(report);
      record.evidence[evidence.id] = evidence;
    });
    recent.push(now);
    this.filed.set(reporter.account, recent);
    return { report, evidence };
  }

  /** Ask the reporter's server (and the reported's, when different), merge main's bridged lines. */
  private async gather(reporter: ReportParty, target: ReportParty, now: number): Promise<EvidenceBundle> {
    const minutes = Math.min(EVIDENCE_MINUTES, this.opts.mainBuffer.windowMs / 60_000);
    const reporterServer = this.opts.whereIs(reporter.characterId) ?? null;
    const targetServer = this.opts.whereIs(target.characterId) ?? null;
    const servers = [...new Set([reporterServer, targetServer].filter((s): s is string => s !== null))];
    const answers = await Promise.all(servers.map((s) => this.opts.requests.request(s, reporter.characterId, target.characterId, minutes)));
    const fromMain = this.opts.mainBuffer.involving(reporter.characterId, target.characterId, minutes).map((l) => toEvidenceLine(l, reporter.characterId, target.characterId, "main"));
    const lines = mergeEvidenceLines(...answers.map((a) => a?.lines ?? []), fromMain);
    for (const line of lines) {
      if (line.account) continue;
      if (line.from === reporter.characterId) line.account = reporter.account;
      else if (line.from === target.characterId) line.account = target.account;
    }
    const placeOf = (who: ReportParty, server: string | null): EvidenceParty => {
      const answer = answers.find((a) => a && a.server === server);
      const place = answer ? (answer.reporter.characterId === who.characterId ? answer.reporter : answer.target) : null;
      return { account: who.account, characterId: who.characterId, name: who.name, server, position: place?.position ?? null, zone: place?.zone ?? null };
    };
    return {
      id: `ev-${randomBytes(6).toString("hex")}`,
      at: now,
      minutes,
      reporter: placeOf(reporter, reporterServer),
      target: placeOf(target, targetServer),
      servers: servers.map((id, i) => ({ id, answered: answers[i] !== null })),
      lines,
    };
  }
}
