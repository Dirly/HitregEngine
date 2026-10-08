/**
 * net-session.ts — the networked session's LOGIC, shared by both hosts.
 *
 * Two programs join a dedicated server: the editor host (main.ts, `?server=`
 * / `?gateway=`) and the published runtime (play.ts, for a project whose
 * project.json says `multiplayer: "server"`). Everything they must agree on
 * lives here or in net-client.ts, so the two cannot drift:
 *
 * - here (pure: no DOM, no three, runs under `node --test`): where to connect
 *   (`resolveNetEndpoint`), what the server owns in the scene
 *   (`stripServerPlayers`), the server's `world` module (`NetRuntimeWorld`),
 *   which ids the local sim hands to the server (`planSuspension`), the
 *   local body's movement intent and its reconciliation, and the state of
 *   the link to the server (`linkAfter`).
 * - net-client.ts (browser glue): the NetPresence hooks built from those, the
 *   sign-in / character flow, chat + voice, and the connection overlay.
 *
 * NetPresence (net-presence.ts) stays the transport-level session — room,
 * snapshots, interpolation, netState replica.
 */
import type { SceneDoc } from "@hitreg/core";

type EntityDoc = SceneDoc["entities"][string];

// -- where to connect -------------------------------------------------------------------

/** How a tab joins a dedicated server, or does not. */
export type NetEndpoint =
  | { kind: "gateway"; url: string; source: string }
  | { kind: "server"; url: string; source: string }
  | { kind: "none"; reason: string };

export interface NetEndpointInput {
  /** The page's query string. */
  query: URLSearchParams;
  /**
   * "dev" = the editor host: query, then localStorage, exactly as it always
   * read them (`hitreg:gateway`, `hitreg:server`). "published" = a shipped
   * bundle: query, then the bundle's manifest, then the page's own origin as
   * the gateway — never localStorage, which a player's browser may hold from
   * some other build.
   */
  host: "dev" | "published";
  /** Dev: a localStorage reader (throws in private mode — handled). */
  storage?: { getItem(key: string): string | null } | null;
  /** Published: the project's multiplayer mode, from the manifest. */
  mode?: "solo" | "p2p" | "server";
  /** Published: `manifest.multiplayer.gateway` / `.server`, written by publish.mjs. */
  manifest?: { gateway?: string | undefined; server?: string | undefined };
  /** Published: `location.origin` — the default gateway (deploy/ serves client and gateway on one host). */
  origin?: string;
}

const trimSlash = (url: string): string => url.replace(/\/+$/, "");

function stored(storage: NetEndpointInput["storage"], key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/**
 * The ONE order both hosts read their server from.
 *
 * Dev (main.ts, unchanged behaviour): `?gateway=` → localStorage
 * `hitreg:gateway` → `?server=` → localStorage `hitreg:server` → none.
 *
 * Published (play.ts), only for a `multiplayer: "server"` project:
 * `?gateway=` → `?server=` → manifest `gateway` → manifest `server` → the
 * page's own origin as the gateway (http/https pages only). A gateway beats
 * an open server at every level, as in dev. Any other project: none (it plays
 * as it always did).
 */
export function resolveNetEndpoint(input: NetEndpointInput): NetEndpoint {
  const q = (k: string): string | null => {
    const v = input.query.get(k);
    return v && v.trim() ? v.trim() : null;
  };
  if (input.host === "dev") {
    const gateway = q("gateway") ?? stored(input.storage, "hitreg:gateway");
    if (gateway) return { kind: "gateway", url: trimSlash(gateway), source: q("gateway") ? "?gateway" : "localStorage" };
    const server = q("server") ?? stored(input.storage, "hitreg:server");
    if (server) return { kind: "server", url: server, source: q("server") ? "?server" : "localStorage" };
    return { kind: "none", reason: "no ?gateway or ?server" };
  }
  if (input.mode !== "server") return { kind: "none", reason: `project multiplayer is "${input.mode ?? "solo"}"` };
  const gq = q("gateway");
  if (gq) return { kind: "gateway", url: trimSlash(gq), source: "?gateway" };
  const sq = q("server");
  if (sq) return { kind: "server", url: sq, source: "?server" };
  if (input.manifest?.gateway) return { kind: "gateway", url: trimSlash(input.manifest.gateway), source: "manifest" };
  if (input.manifest?.server) return { kind: "server", url: input.manifest.server, source: "manifest" };
  if (input.origin && /^https?:\/\//.test(input.origin)) return { kind: "gateway", url: trimSlash(input.origin), source: "page origin" };
  return { kind: "none", reason: "no server configured (pass ?gateway=… or publish with --gateway)" };
}

// -- what the server owns -------------------------------------------------------------

/**
 * The server owns players: its per-joiner body replaces the authored one, so a
 * client never builds the scene's own `player`-tagged root or anything under
 * it. Mutates and returns the expanded doc.
 */
export function stripServerPlayers(expanded: SceneDoc): SceneDoc {
  const drop = new Set<string>();
  for (const [id, e] of Object.entries(expanded.entities)) {
    if (e.parent === null && e.tags.includes("player")) drop.add(id);
  }
  let grew = drop.size > 0;
  while (grew) {
    grew = false;
    for (const [id, e] of Object.entries(expanded.entities)) {
      if (!drop.has(id) && e.parent !== null && drop.has(e.parent)) {
        drop.add(id);
        grew = true;
      }
    }
  }
  for (const id of drop) delete expanded.entities[id];
  return expanded;
}

// -- the server's `world` module ----------------------------------------------------------

/** A `transfer` instruction from the layer: bye here, dial there. */
export interface NetTransfer {
  url: string;
  ticket: string;
  reason: string;
  srv: string | null;
  /** The destination's scene, when it is not this one (a portal into an instance). */
  scene: string | null;
}

/** What the host does with what the server sent. */
export interface NetWorldHooks {
  /** Build these docs into the live scene (fresh ids only). */
  build(docs: SceneDoc["entities"]): void;
  /** Attach freshly built ids to the play session: ours simulated, others suspended. */
  attach(ids: string[]): void;
  /** Tear these ids down (sim, scripts, objects, smoothing) — the registry already forgot them. */
  despawn(ids: string[]): void;
  /** Our own body arrived (the follow camera, the status line). */
  onSelf?(id: string): void;
  /** The server terraformed the world. */
  onRecipe?(id: string, recipe: unknown): void;
  /** The layer hands us to another server. */
  onTransfer?(transfer: NetTransfer): void;
}

/**
 * Entity docs the server spawned at runtime (every player's body, NPCs added
 * at runtime), by id, plus which one is ours. Hosts build them like streamed
 * content; this keeps the bookkeeping and reads the module's messages.
 */
export class NetRuntimeWorld {
  readonly docs = new Map<string, EntityDoc>();
  /** Our own body's id on the server, once the `world` module told us. */
  selfId: string | null = null;

  constructor(private readonly hooks: NetWorldHooks) {}

  /** An id and everything under it, among the runtime docs. */
  subtree(rootId: string): string[] {
    const out = [rootId];
    for (let i = 0; i < out.length; i++) {
      for (const [id, e] of this.docs) {
        if (e.parent === out[i] && !out.includes(id)) out.push(id);
      }
    }
    return out;
  }

  /** Our body and its children (empty before the server said which is ours). */
  ownSubtree(): Set<string> {
    return new Set(this.selfId ? this.subtree(this.selfId) : []);
  }

  /** Another player's server-spawned entity: never simulated here. */
  isForeign(id: string, own = this.ownSubtree()): boolean {
    return this.docs.has(id) && !own.has(id);
  }

  /** Forget these ids and have the host tear them down. Returns the ids that were known. */
  despawn(ids: Iterable<string>): string[] {
    const present = [...ids].filter((id) => this.docs.has(id));
    if (present.length === 0) return present;
    for (const id of present) {
      this.docs.delete(id);
      if (id === this.selfId) this.selfId = null;
    }
    this.hooks.despawn(present);
    return present;
  }

  /** The session ended: its entities go with it (they come back with the next welcome). */
  clear(): void {
    this.despawn([...this.docs.keys()]);
  }

  /** One `world` module message. */
  handle(data: unknown): void {
    const msg = data as { t?: unknown; entities?: unknown; ids?: unknown; self?: unknown } | null;
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "spawn" && msg.entities && typeof msg.entities === "object") {
      const fresh: SceneDoc["entities"] = {};
      for (const [id, doc] of Object.entries(msg.entities as SceneDoc["entities"])) {
        if (this.docs.has(id)) continue;
        this.docs.set(id, doc);
        fresh[id] = doc;
      }
      const self = typeof msg.self === "string" ? msg.self : null;
      if (self) this.selfId = self;
      const ids = Object.keys(fresh);
      if (ids.length > 0) {
        this.hooks.build(fresh);
        this.hooks.attach(ids);
      }
      if (self) this.hooks.onSelf?.(self);
      console.log(`[net] server spawned ${ids.length} entities${self ? ` (you are ${self})` : ""}`);
    } else if (msg.t === "despawn" && Array.isArray(msg.ids)) {
      this.despawn(msg.ids.filter((id): id is string => typeof id === "string"));
    } else if (msg.t === "recipe") {
      const m = msg as { id?: unknown; recipe?: unknown };
      if (typeof m.id === "string" && m.recipe && typeof m.recipe === "object") this.hooks.onRecipe?.(m.id, m.recipe);
    } else if (msg.t === "transfer") {
      const m = msg as { url?: unknown; ticket?: unknown; reason?: unknown; srv?: unknown; scene?: unknown };
      if (typeof m.url === "string" && typeof m.ticket === "string") {
        this.hooks.onTransfer?.({
          url: m.url,
          ticket: m.ticket,
          reason: typeof m.reason === "string" ? m.reason : "?",
          srv: typeof m.srv === "string" ? m.srv : null,
          scene: typeof m.scene === "string" ? m.scene : null,
        });
      }
    }
  }
}

// -- which ids the server simulates -------------------------------------------------------

/**
 * The managed set changed (snapshot `managed`): which ids to suspend here,
 * which to hand back to the local sim, and the new suspended set. Another
 * player's server-spawned subtree stays suspended whatever the managed set
 * says: the server only lists the BODY (the thing with a transform), but its
 * child scripts — a caster reading the keyboard, an actor — belong to that
 * player's tab, never to this one.
 */
export function planSuspension(
  target: Iterable<string>,
  suspended: ReadonlySet<string>,
  isForeign: (id: string) => boolean,
): { toSuspend: string[]; toResume: string[]; next: Set<string> } {
  const want = new Set(target);
  const toSuspend = [...want].filter((id) => !suspended.has(id));
  const toResume = [...suspended].filter((id) => !want.has(id) && !isForeign(id));
  const next = new Set(want);
  for (const id of suspended) if (isForeign(id)) next.add(id);
  return { toSuspend, toResume, next };
}

// -- the local body: intent up, verdict down ----------------------------------------------

/** The body's runtime flags the controller leaves in `object.userData`. */
export interface BodyFlags {
  speedMult?: number;
  frozen?: boolean;
  swimming?: string;
  swimVelocity?: [number, number, number];
  /** The controller's own stick velocity this tick (sprint/walk keys, strafe and wading slow-downs applied). */
  moveVelocity?: [number, number];
  advanceVel?: [number, number];
}

/** The controller params the intent mirrors (third-person-controller). */
export interface ControllerParams {
  speed?: number;
  swimSpeed?: number;
  swimDownKey?: string;
}

/**
 * Movement INTENT for the authority: camera-relative WASD → desired
 * horizontal velocity, the controller's own mapping. Peers send intentions,
 * never state.
 */
export function movementIntent(
  isDown: (code: string) => boolean,
  forward2d: [number, number],
  flags: BodyFlags,
  params: ControllerParams | undefined,
): { v: [number, number]; jump: boolean; vy: number } {
  if (flags.frozen) return { v: [0, 0], jump: false, vy: 0 };
  // Swimming: the controller already solved where this body is pointed
  // (camera pitch included), so relay THAT rather than re-deriving a flat
  // heading here — two derivations is two answers, and the authority's wins.
  if (flags.swimming === "swimming" && flags.swimVelocity) {
    const [sx, sy, sz] = flags.swimVelocity;
    return { v: [sx, sz], jump: isDown("Space"), vy: sy };
  }
  // On land the controller already decided the velocity (sprint, walk, the strafe and backpedal slow-down,
  // wading drag, speedMult): relay it, plus the clip advance it adds. Re-deriving it here missed the sprint
  // key, so the authority ran while the tab sprinted and every sprint rubber-banded.
  if (flags.moveVelocity) {
    const [mx, mz] = flags.moveVelocity;
    const adv = flags.advanceVel ?? [0, 0];
    return { v: [mx + adv[0], mz + adv[1]], jump: isDown("Space"), vy: 0 };
  }
  let forward = 0;
  let strafe = 0;
  if (isDown("KeyW") || isDown("ArrowUp")) forward += 1;
  if (isDown("KeyS") || isDown("ArrowDown")) forward -= 1;
  if (isDown("KeyA") || isDown("ArrowLeft")) strafe -= 1;
  if (isDown("KeyD") || isDown("ArrowRight")) strafe += 1;
  const [fx, fz] = forward2d;
  let x = fx * forward + -fz * strafe;
  let z = fz * forward + fx * strafe;
  const len = Math.hypot(x, z);
  // A swimmer asks for its swim speed, not its run speed: the authority
  // clamps what arrives, and a stroke sent as a sprint is a body the server
  // keeps overtaking.
  const swimming = flags.swimming === "swimming";
  const speed = (swimming ? (params?.swimSpeed ?? 3.2) : (params?.speed ?? 6.5)) * (flags.speedMult ?? 1);
  if (len > 0) {
    x = (x / len) * speed;
    z = (z / len) * speed;
  }
  // A swing that steps in moves the body with its feet (the controller's
  // clipAdvance). The authority only moves what is claimed, so the lunge is
  // part of the claim — without it the server pins the swinger in place.
  if (flags.advanceVel) {
    x += flags.advanceVel[0];
    z += flags.advanceVel[1];
  }
  // Vertical intent is only meaningful in water; out of it, Space is the jump
  // the authority already reads. The same comma-separated list the controller
  // reads — one key here and three there is a dive that works single-player
  // and not on a server.
  const diveKeys = (params?.swimDownKey ?? "ControlLeft,KeyC,KeyX").split(",");
  const diving = diveKeys.some((k) => k.trim() && isDown(k.trim()));
  const vy = (isDown("Space") ? 1 : 0) - (diving ? 1 : 0);
  return { v: [x, z], jump: isDown("Space"), vy };
}

/** Prediction drift beyond this eases toward authority… */
export const NET_NUDGE_DIST = 1.0;
/** …and beyond this teleports (velocity reset). */
export const NET_SNAP_DIST = 3.5;
/** Predicted motion since a snapshot's moment (m) past which reconcileShift stops trusting that moment. */
export const NET_SHIFT_TRUST = 12;
/** One-fifth of the error per snapshot ≈ an invisible glide. */
const NUDGE_GAIN = 0.2;

/**
 * Client-side prediction reconciliation: the local sim ran ahead; the
 * authority's verdict arrived. Small drift is normal (dead-band), medium drift
 * glides toward authority keeping velocity, huge drift snaps.
 */
export function reconcileCorrection(
  local: readonly [number, number, number] | readonly number[],
  authority: readonly [number, number, number] | readonly number[],
): { kind: "none" } | { kind: "nudge"; to: [number, number, number] } | { kind: "snap"; to: [number, number, number] } {
  const dx = authority[0]! - local[0]!;
  const dy = authority[1]! - local[1]!;
  const dz = authority[2]! - local[2]!;
  const err = Math.hypot(dx, dy, dz);
  if (err > NET_SNAP_DIST) return { kind: "snap", to: [authority[0]!, authority[1]!, authority[2]!] };
  if (err > NET_NUDGE_DIST) {
    return { kind: "nudge", to: [local[0]! + dx * NUDGE_GAIN, local[1]! + dy * NUDGE_GAIN, local[2]! + dz * NUDGE_GAIN] };
  }
  return { kind: "none" };
}

/**
 * Reconciliation against the moment the authority's position describes. `then` is where our prediction had
 * the body at that moment (NetPresence.predictedAt); the error is measured there and the SAME shift is applied
 * to where the body is now — the motion predicted since then stays. Comparing the present with a position a
 * round trip old instead reads speed × latency as error on every snapshot of a running body (1.2 m at a sprint
 * over 120 ms: past the nudge line, so the client was pulled back as it ran). Same thresholds as
 * {@link reconcileCorrection}; `err` is the measured gap, for the counters.
 */
export function reconcileShift(
  now: readonly number[],
  then: readonly number[],
  authority: readonly number[],
): { kind: "none" | "nudge" | "snap"; to: [number, number, number]; err: [number, number, number] } {
  const err: [number, number, number] = [authority[0]! - then[0]!, authority[1]! - then[1]!, authority[2]! - then[2]!];
  // `now - then` is what we predicted since that moment: a round trip of running, a few metres. Far more means
  // `then` is not where the body really was (a log entry from another frame of reference) and a shift built on it
  // throws the body somewhere new every snapshot — so judge the present against the authority outright instead
  if (Math.hypot(now[0]! - then[0]!, now[1]! - then[1]!, now[2]! - then[2]!) > NET_SHIFT_TRUST) {
    const flat = reconcileCorrection(now, authority);
    return { kind: flat.kind, to: flat.kind === "none" ? [now[0]!, now[1]!, now[2]!] : flat.to, err: [authority[0]! - now[0]!, authority[1]! - now[1]!, authority[2]! - now[2]!] };
  }
  const size = Math.hypot(err[0], err[1], err[2]);
  if (size > NET_SNAP_DIST) return { kind: "snap", to: [now[0]! + err[0], now[1]! + err[1], now[2]! + err[2]], err };
  if (size > NET_NUDGE_DIST) {
    return { kind: "nudge", to: [now[0]! + err[0] * NUDGE_GAIN, now[1]! + err[1] * NUDGE_GAIN, now[2]! + err[2] * NUDGE_GAIN], err };
  }
  return { kind: "none", to: [now[0]!, now[1]!, now[2]!], err };
}

/**
 * What reconciliation did this session, for a probe or the console (`window.__hitregReconcile`): snapshots
 * judged, corrections over 0.5 m, nudges and snaps, the largest gap, and the likeliest reason for each
 * correction — `late` (the snapshot came more than 150 ms after the one before: the server was behind),
 * `skill` (a dash, knockback, launch or stagger owned the body), `vertical` (mostly up/down: ground or a
 * collider one side has and the other not), `speed` (the two sides moved the same input differently),
 * `legacy` (the server sent no `sa`: compared with the present, round trip included).
 */
export interface ReconcileStats {
  snapshots: number;
  over05: number;
  nudges: number;
  snaps: number;
  maxM: number;
  reasons: Record<string, number>;
}

export function newReconcileStats(): ReconcileStats {
  return { snapshots: 0, over05: 0, nudges: 0, snaps: 0, maxM: 0, reasons: {} };
}

// -- the link to the server ---------------------------------------------------------------

/**
 * Where the link to a dedicated server stands, for the player to see.
 * idle (nothing to dial yet) → dialing → connected; a socket that closes
 * before or after the welcome → retrying (backoff, re-dial); the server's
 * refusal (a bad or expired ticket, a full layer) → refused, which does NOT
 * re-dial on its own — the same ticket would be refused again.
 */
export type ServerLinkPhase = "idle" | "dialing" | "connected" | "retrying" | "refused";

export interface ServerLink {
  phase: ServerLinkPhase;
  url: string | null;
  /** The refusal, or what closed the socket. */
  reason: string | null;
  /** Consecutive failed dials (0 once welcomed). */
  failures: number;
  /** performance.now() of the next automatic dial while retrying. */
  retryAt: number | null;
  /** Has this link EVER been welcomed since the last rehome (lost vs never reached). */
  everConnected: boolean;
}

export type ServerLinkEvent =
  | { kind: "rehome"; url: string }
  | { kind: "dial"; url: string }
  | { kind: "welcome" }
  | { kind: "refused"; reason: string }
  | { kind: "closed"; reason?: string; now: number }
  | { kind: "bye" };

export const INITIAL_LINK: ServerLink = { phase: "idle", url: null, reason: null, failures: 0, retryAt: null, everConnected: false };

/** Re-dial backoff: 1 s, 2 s, 4 s, 8 s, then every 10 s. */
export function redialDelayMs(failures: number): number {
  return Math.min(10_000, 1000 * 2 ** Math.max(0, failures - 1));
}

export function linkAfter(link: ServerLink, event: ServerLinkEvent): ServerLink {
  switch (event.kind) {
    case "rehome":
      return { ...INITIAL_LINK, url: event.url };
    case "dial":
      return { ...link, phase: "dialing", url: event.url, retryAt: null };
    case "welcome":
      return { ...link, phase: "connected", reason: null, failures: 0, retryAt: null, everConnected: true };
    case "refused":
      return { ...link, phase: "refused", reason: event.reason, retryAt: null };
    case "closed": {
      // the close that follows a refusal, or one after we said bye, changes nothing
      if (link.phase === "refused" || link.phase === "idle") return link;
      const failures = link.phase === "connected" ? 1 : link.failures + 1;
      return { ...link, phase: "retrying", reason: event.reason ?? link.reason, failures, retryAt: event.now + redialDelayMs(failures) };
    }
    case "bye":
      return { ...link, phase: "idle", retryAt: null };
  }
}

// -- what the player sees while the link is down ------------------------------------------

export interface ConnectionView {
  show: boolean;
  title: string;
  detail: string;
  /** retry = dial now; rejoin = ask main for a fresh ticket; signin = back to the card. */
  actions: Array<"retry" | "rejoin" | "signin">;
}

/**
 * The overlay's text for a link state. Pure, so the wording for every failure
 * is tested without a browser (test/net-session.test.ts).
 */
export function connectionView(
  link: ServerLink,
  ctx: { wanted: boolean; hasSelf: boolean; gateway: boolean; transferring: string | null; now: number },
): ConnectionView {
  const hidden: ConnectionView = { show: false, title: "", detail: "", actions: [] };
  if (!ctx.wanted) return hidden; // the sign-in card is up, or the editor is not playing
  const back: Array<"signin"> = ctx.gateway ? ["signin"] : [];
  if (link.phase === "refused") {
    return {
      show: true,
      title: "The server refused the connection",
      detail: `${link.reason ?? "no reason given"}.${ctx.gateway ? " A fresh ticket from the gateway usually fixes this." : ""}`,
      actions: ctx.gateway ? ["rejoin", "signin"] : ["retry"],
    };
  }
  if (link.phase === "connected") {
    if (ctx.hasSelf) return hidden;
    return { show: true, title: ctx.transferring ? `Arriving on ${ctx.transferring}…` : "Entering the world…", detail: "Waiting for the server to place your character.", actions: [] };
  }
  if (link.phase === "retrying") {
    const seconds = Math.max(0, Math.ceil(((link.retryAt ?? ctx.now) - ctx.now) / 1000));
    return {
      show: true,
      title: link.everConnected ? "Connection to the server lost" : "Cannot reach the server",
      detail: `${link.reason ?? "the connection closed"} — retrying ${seconds > 0 ? `in ${seconds} s` : "now"} (attempt ${link.failures + 1}).${link.url ? `\n${link.url}` : ""}`,
      actions: ["retry", ...back],
    };
  }
  // idle (granted, not dialed yet) or dialing
  if (ctx.transferring) return { show: true, title: `Travelling to ${ctx.transferring}…`, detail: "Handing your character to the next server.", actions: [] };
  return { show: true, title: "Connecting to the server…", detail: link.url ?? "", actions: link.failures > 0 ? ["retry", ...back] : [] };
}

// -- a scene change in a published build -------------------------------------------------

/**
 * A published bundle hosts one scene per page. When the server sends a
 * player into another scene (a grant for a different world, a portal into an
 * instance), the page reloads on that scene and picks the grant up here
 * instead of asking the player to sign in again. Tickets live 120 s.
 */
export const PENDING_GRANT_KEY = "hitreg:pending-grant";
const PENDING_GRANT_MAX_AGE_MS = 90_000;

export interface PendingGrant<G, C> {
  grant: G;
  character: C;
  at: number;
}

export function savePendingGrant<G, C>(storage: { setItem(k: string, v: string): void } | null, grant: G, character: C, now = Date.now()): boolean {
  try {
    storage?.setItem(PENDING_GRANT_KEY, JSON.stringify({ grant, character, at: now } satisfies PendingGrant<G, C>));
    return storage !== null;
  } catch {
    return false;
  }
}

/** Take (and remove) a pending grant younger than its ticket. */
export function takePendingGrant<G, C>(
  storage: { getItem(k: string): string | null; removeItem(k: string): void } | null,
  now = Date.now(),
): PendingGrant<G, C> | null {
  try {
    const raw = storage?.getItem(PENDING_GRANT_KEY);
    if (!raw) return null;
    storage!.removeItem(PENDING_GRANT_KEY);
    const parsed = JSON.parse(raw) as PendingGrant<G, C>;
    if (typeof parsed?.at !== "number" || now - parsed.at > PENDING_GRANT_MAX_AGE_MS || now < parsed.at) return null;
    return parsed;
  } catch {
    return null;
  }
}
