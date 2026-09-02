/**
 * Text chat — host-authoritative routing over the room's module channel.
 *
 * A peer never sends a message to other peers; it sends a REQUEST
 * (`{k:"say"}`) to the host, which sanitizes, rate-limits, resolves the
 * recipients for the channel (`recipientsFor` — the same rule voice uses),
 * and delivers a stamped `ChatMessage` to exactly those peers. Team and
 * proximity messages therefore never reach a tab that shouldn't see them —
 * a client-side filter would be one devtools call away from a leak.
 *
 * Runs unchanged in single-player (`localLink`): messages echo locally, so a
 * game's chat UI and its script hooks behave identically alone or online.
 */

import { z } from "zod";
import type { EventRegistry } from "@hitreg/core";
import {
  isCommsChannel,
  recipientsFor,
  type CommsChannel,
  type RoutingContext,
} from "./channels.js";
import type { CommsLink } from "./link.js";
import { isValidGroupName, type MembershipSource } from "./membership.js";

export const CHAT_MODULE = "chat";

export interface ChatMessage {
  /** Unique within the session: "<sender>:<seq>" (system lines: "sys:<seq>"). */
  id: string;
  /** "system" marks lines nobody typed (join/leave, errors, script announcements). */
  channel: CommsChannel | "system";
  /** Sending peer id, or "system". */
  from: string;
  name: string;
  text: string;
  /** Wall-clock ms on the machine that stamped it (host for routed messages). */
  at: number;
}

export interface ChatConfig {
  /** Meters. "say" reaches players within this distance (default 25). */
  proximityRadius?: number;
  /** Longest accepted message after trimming (default 240). */
  maxLength?: number;
  /** Sustained messages/second per peer (default 2) and the burst allowance (default 5). */
  ratePerSecond?: number;
  burst?: number;
  /** Messages kept in `history()` (default 200). */
  historyLimit?: number;
  /**
   * Accept "/team x" and "/party x" from players (default true — right for
   * prototypes and social games; a game whose teams are assigned by rules
   * turns it off and assigns membership from a script instead).
   */
  allowSelfAssign?: boolean;
}

export interface ChatDeps {
  link: CommsLink;
  membership: MembershipSource;
  /** World position of a participant, or null when not in the world. */
  positionOf(peerId: string): readonly [number, number, number] | null;
  /**
   * Authority side: apply a membership change ("/team red"). Return false
   * to refuse. Absent = self-assignment is unavailable. Typically writes
   * `comms.team/<peerId>` into netState.
   */
  assign?(peerId: string, kind: "team" | "party", value: string | null): boolean;
  /** Every locally delivered message is also emitted as a "chat.message" gameplay event. */
  emitEvent?(name: string, payload: unknown): void;
  now?(): number;
  config?: ChatConfig;
}

export type ChatSendResult = { ok: true } | { ok: false; reason: string };

// -- wire format (module "chat") ------------------------------------------------

type ChatUp =
  | { k: "say"; channel: CommsChannel; text: string }
  | { k: "assign"; kind: "team" | "party"; value: string | null };
type ChatDown = { k: "msg"; msg: ChatMessage } | { k: "err"; text: string };

function parseUp(data: unknown): ChatUp | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.k === "say") {
    return isCommsChannel(m.channel) && typeof m.text === "string"
      ? { k: "say", channel: m.channel, text: m.text }
      : null;
  }
  if (m.k === "assign") {
    if (m.kind !== "team" && m.kind !== "party") return null;
    if (m.value !== null && typeof m.value !== "string") return null;
    return { k: "assign", kind: m.kind, value: m.value };
  }
  return null;
}

function parseMessage(raw: unknown): ChatMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (
    typeof m.id !== "string" ||
    !(isCommsChannel(m.channel) || m.channel === "system") ||
    typeof m.from !== "string" ||
    typeof m.name !== "string" ||
    typeof m.text !== "string" ||
    typeof m.at !== "number"
  ) {
    return null;
  }
  return { id: m.id, channel: m.channel, from: m.from, name: m.name, text: m.text, at: m.at };
}

function parseDown(data: unknown): ChatDown | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.k === "msg") {
    const msg = parseMessage(m.msg);
    return msg ? { k: "msg", msg } : null;
  }
  if (m.k === "err") return typeof m.text === "string" ? { k: "err", text: m.text } : null;
  return null;
}

// -- router (authority-side policy, pure) ----------------------------------------

interface RouterConfig {
  proximityRadius: number;
  maxLength: number;
  ratePerSecond: number;
  burst: number;
}

/**
 * The host's chat policy: sanitize, rate-limit, resolve recipients. Pure
 * apart from the per-peer token buckets; `now` is injected for tests.
 */
export class ChatRouter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly config: RouterConfig,
    private readonly ctx: RoutingContext,
    private readonly now: () => number,
  ) {}

  /** Trim, strip control characters, clamp length. Null = nothing left to say. */
  sanitize(text: string): string | null {
    // eslint-disable-next-line no-control-regex
    const clean = text
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (clean.length === 0) return null;
    return clean.length > this.config.maxLength ? clean.slice(0, this.config.maxLength) : clean;
  }

  /** Token bucket per peer: `burst` messages at once, `ratePerSecond` sustained. */
  allow(peerId: string): boolean {
    const now = this.now();
    let b = this.buckets.get(peerId);
    if (!b) {
      b = { tokens: this.config.burst, at: now };
      this.buckets.set(peerId, b);
    }
    const elapsed = Math.max(0, now - b.at) / 1000;
    b.tokens = Math.min(this.config.burst, b.tokens + elapsed * this.config.ratePerSecond);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  forget(peerId: string): void {
    this.buckets.delete(peerId);
  }

  route(
    sender: string,
    channel: CommsChannel,
    rawText: string,
    participants: readonly string[],
  ): { ok: true; text: string; recipients: string[] } | { ok: false; reason: string } {
    const text = this.sanitize(rawText);
    if (text === null) return { ok: false, reason: "empty message" };
    if (!this.allow(sender)) return { ok: false, reason: "you are sending messages too fast" };
    const routed = recipientsFor(sender, channel, participants, this.ctx, this.config.proximityRadius);
    if (!routed.ok) return routed;
    return { ok: true, text, recipients: routed.recipients };
  }
}

// -- service (one per tab; host runs the router too) --------------------------------

export class ChatService {
  private link: CommsLink;
  private readonly config: Required<ChatConfig>;
  private readonly router: ChatRouter;
  private readonly history_: ChatMessage[] = [];
  private readonly handlers = new Set<(msg: ChatMessage) => void>();
  private readonly linkUnsubs: Array<() => void> = [];
  private seq = 0;
  private disposed = false;

  constructor(private readonly deps: ChatDeps) {
    const c = deps.config ?? {};
    this.config = {
      proximityRadius: c.proximityRadius ?? 25,
      maxLength: c.maxLength ?? 240,
      ratePerSecond: c.ratePerSecond ?? 2,
      burst: c.burst ?? 5,
      historyLimit: c.historyLimit ?? 200,
      allowSelfAssign: c.allowSelfAssign ?? true,
    };
    const ctx: RoutingContext = {
      teamOf: (id) => deps.membership.teamOf(id),
      partyOf: (id) => deps.membership.partyOf(id),
      positionOf: (id) => deps.positionOf(id),
    };
    this.router = new ChatRouter(this.config, ctx, deps.now ?? (() => Date.now()));
    this.link = deps.link;
    this.bind(deps.link);
  }

  get role(): CommsLink["role"] {
    return this.link.role;
  }

  get selfId(): string {
    return this.link.selfId;
  }

  /** Session changed (joined a room, became host, went solo): rebind. */
  setLink(link: CommsLink): void {
    if (this.disposed) return;
    for (const off of this.linkUnsubs.splice(0)) off();
    this.link = link;
    this.bind(link);
  }

  currentLink(): CommsLink {
    return this.link;
  }

  /** Everything delivered to THIS tab, oldest first. */
  history(): readonly ChatMessage[] {
    return this.history_;
  }

  onMessage(cb: (msg: ChatMessage) => void): () => void {
    this.handlers.add(cb);
    return () => {
      this.handlers.delete(cb);
    };
  }

  /**
   * Say something on a channel. On the host / alone it routes immediately
   * (a refusal is returned); on a peer the host decides and a refusal comes
   * back as a system line, so the result only reflects that it was sent.
   */
  send(channel: CommsChannel, text: string): ChatSendResult {
    if (this.disposed) return { ok: false, reason: "chat is closed" };
    if (this.link.role === "peer") {
      const clean = this.router.sanitize(text);
      if (clean === null) return { ok: false, reason: "empty message" };
      this.link.send(CHAT_MODULE, this.link.hostId, { k: "say", channel, text: clean } satisfies ChatUp);
      return { ok: true };
    }
    const result = this.routeFrom(this.link.selfId, channel, text);
    if (!result.ok) this.system(result.reason);
    return result;
  }

  /** A local-only line (errors, hints). Never leaves this tab. */
  system(text: string): void {
    this.deliver(this.stamp("system", "system", "system", text));
  }

  /**
   * Authority-side announcement to every participant ("round starts in 10s").
   * Scripts call this from the authority; on a peer it is a local line only
   * (the authoritative copy of the script announces for everyone).
   */
  announce(text: string): void {
    if (this.disposed) return;
    const msg = this.stamp("system", "system", "system", text);
    if (this.link.role === "host") {
      for (const peer of this.link.peers()) {
        this.link.send(CHAT_MODULE, peer, { k: "msg", msg } satisfies ChatDown);
      }
    }
    this.deliver(msg);
  }

  /** "/team red" — applied here on the authority, requested from a peer. */
  requestTeam(team: string | null): void {
    this.requestAssign("team", team);
  }

  requestParty(party: string | null): void {
    this.requestAssign("party", party);
  }

  /** Participants for routing: self plus everyone the host has joined. */
  participants(): string[] {
    return this.link.role === "host" ? [this.link.selfId, ...this.link.peers()] : [this.link.selfId];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.linkUnsubs.splice(0)) off();
    this.handlers.clear();
  }

  // -- internals -----------------------------------------------------------------

  private bind(link: CommsLink): void {
    this.linkUnsubs.push(
      link.onMessage(CHAT_MODULE, (from, data) => {
        try {
          if (link.role === "host") this.handleUp(from, data);
          else if (link.role === "peer") this.handleDown(data);
        } catch (error) {
          console.warn("[chat] message handling failed:", error);
        }
      }),
    );
  }

  private handleUp(from: string, data: unknown): void {
    const msg = parseUp(data);
    if (!msg) return; // malformed request — drop
    if (msg.k === "say") {
      const result = this.routeFrom(from, msg.channel, msg.text);
      if (!result.ok) this.link.send(CHAT_MODULE, from, { k: "err", text: result.reason } satisfies ChatDown);
      return;
    }
    const outcome = this.applyAssign(from, msg.kind, msg.value);
    this.link.send(CHAT_MODULE, from, { k: "err", text: outcome } satisfies ChatDown);
  }

  private handleDown(data: unknown): void {
    const msg = parseDown(data);
    if (!msg) return;
    if (msg.k === "msg") this.deliver(msg.msg);
    else this.system(msg.text);
  }

  /** Authority: route a message from `sender` and deliver to each recipient. */
  private routeFrom(sender: string, channel: CommsChannel, text: string): ChatSendResult {
    const routed = this.router.route(sender, channel, text, this.participants());
    if (!routed.ok) return routed;
    const msg = this.stamp(channel, sender, this.link.nameOf(sender), routed.text);
    for (const recipient of routed.recipients) {
      if (recipient === this.link.selfId) this.deliver(msg);
      else this.link.send(CHAT_MODULE, recipient, { k: "msg", msg } satisfies ChatDown);
    }
    return { ok: true };
  }

  private requestAssign(kind: "team" | "party", value: string | null): void {
    if (this.disposed) return;
    if (this.link.role === "peer") {
      this.link.send(CHAT_MODULE, this.link.hostId, { k: "assign", kind, value } satisfies ChatUp);
      return;
    }
    this.system(this.applyAssign(this.link.selfId, kind, value));
  }

  /** Authority: validate and apply a membership request; returns the line to show the requester. */
  private applyAssign(peerId: string, kind: "team" | "party", value: string | null): string {
    if (!this.config.allowSelfAssign || !this.deps.assign) {
      return `${kind} assignment is controlled by the game`;
    }
    if (value !== null && !isValidGroupName(value)) {
      return `invalid ${kind} name (letters, digits, space, _ or -; max 32)`;
    }
    if (!this.deps.assign(peerId, kind, value)) return `${kind} change refused`;
    return value === null ? `left ${kind}` : `joined ${kind} "${value}"`;
  }

  private stamp(channel: ChatMessage["channel"], from: string, name: string, text: string): ChatMessage {
    this.seq += 1;
    const prefix = from === "system" ? `sys.${this.link.selfId}` : from;
    return {
      id: `${prefix}:${this.seq}`,
      channel,
      from,
      name,
      text,
      at: (this.deps.now ?? Date.now)(),
    };
  }

  private deliver(msg: ChatMessage): void {
    this.history_.push(msg);
    if (this.history_.length > this.config.historyLimit) {
      this.history_.splice(0, this.history_.length - this.config.historyLimit);
    }
    for (const cb of [...this.handlers]) cb(msg);
    if (msg.channel !== "system") {
      this.deps.emitEvent?.("chat.message", {
        channel: msg.channel,
        from: msg.from,
        name: msg.name,
        text: msg.text,
      });
    }
  }
}

// -- gameplay event contract ----------------------------------------------------------

/**
 * Register the chat event(s) on an EventRegistry so scripts can listen
 * (`ctx.events.on("chat.message", …)`) with a validated payload and the
 * contract shows in the AI-facing spec. Local-only: each tab's bus hears
 * exactly the messages that tab was allowed to receive.
 */
export function registerCommsEvents(registry: EventRegistry): void {
  registry.register(
    "chat.message",
    z
      .object({
        channel: z.enum(["proximity", "global", "team", "party"]),
        from: z.string().describe("Sending peer id."),
        name: z.string(),
        text: z.string(),
      })
      .describe(
        "A chat line THIS tab received (proximity/global/team/party). Local-only by construction: the host routes each message to the peers allowed to see it, so listening here never leaks another team's chat. Emitted on the session event bus after delivery; scripts use it for chat commands ('!ready'), bots, or reactions.",
      ),
  );
}
