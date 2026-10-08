/**
 * MAIN — login, placement, persistence, and the cluster's coordinator.
 *
 * One HTTP+WebSocket process (docs/hosting.md). It never simulates anything:
 *
 *   gateway HTTP   accounts, characters, `/play` (which hands the client a
 *                  layer url + a signed ticket), parties, a public /status
 *   cluster WS     layers and instances register here and do every durable
 *                  thing through it: player-data load/store, ticket minting,
 *                  transfer requests, recipe fan-out
 *   placement      a Diablo-style pool of whole-world layers: party first,
 *                  affinity second, fullest-with-room third; autoscale by
 *                  free slots, retire idle layers, spawn instances on demand
 *   writer of record  the world recipe file — a layer that terraforms sends
 *                  the recipe here, main saves it and pushes it to the rest
 *   admin HTTP     move a character, start an instance, drain a layer,
 *                  terraform, read the whole picture — bearer token
 *
 * With a `Supervisor`, layers are child processes of this box. Without one,
 * something else starts them (a compose file, a systemd template) and they
 * register themselves; every rule below is the same either way.
 */

import fs from "node:fs";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { characterBuildSchema, regionAt, validateBuild, type CharacterBuild, type CharacterCreation, type PlayerDataBackend, type RegionDoc, type WorldRecipe } from "@hitreg/core";
import { ServerRegistry, type ServerEntry } from "./registry.js";
import { SocialError, SocialStore, isBlocked, type FriendRef } from "./social.js";
import { GuildStore, rankAbove, type GuildRank, type GuildRecord } from "./guilds.js";
import { ChatBuffer, MAIN_CHAT_BUFFER_LINES } from "../moderation/chat-buffer.js";
import { EvidenceRequests, ReportError, ReportIntake, ReportStore } from "../moderation/reports.js";
import type { Supervisor } from "./supervisor.js";
import { NameModeration } from "../moderation/names.js";
import { judgeFromEnv, type ModerationJudge } from "../moderation/judge.js";
import { ModerationDesk, ModerationError, type AuditRule, type Enforce, type VerdictThresholds } from "../moderation/audit.js";
import { AUDIT_ACTIONS, ModerationQueue, SANCTION_KINDS, activeSanctions, banLine, muteLine, renameLine, warnLine, type AuditAction, type SanctionKind } from "../moderation/sanctions.js";
import { ItemsLogMain } from "../moderation/items-log.js";
import { signSession, signTicket, verifySession } from "../cluster/ticket.js";
import {
  ACCOUNT_NAME,
  CHARACTER_NAME,
  MAX_CHARACTERS,
  DELETE_GRACE_DAYS,
  liveCharacters,
  worldOf,
  purgeDeleted,
  restorableCharacters,
  checkPassword,
  hashPassword,
  newId,
  type AccountRecord,
  type AccountStore,
  type CharacterRecord,
} from "../persistence/accounts.js";
import {
  CLUSTER_PATH,
  parseClusterMessage,
  type LayerRpc,
  type HostedZones,
  type LayerToMain,
  type MainToLayer,
  type TransferAnswer,
  type PortalHop,
  type TransferTarget,
  type SocialEvent,
} from "../cluster/protocol.js";

export interface MainOptions {
  port?: number;
  host?: string;
  /** Shared cluster secret: signs tickets, admits layers. */
  secret: string;
  /** Bearer token for /admin/* (default: the secret). */
  adminToken?: string;
  /** Persistence scope (ARCHITECTURE §3c) — usually the game's name. */
  experienceId: string;
  accounts: AccountStore;
  playerData: PlayerDataBackend;
  world: {
    scene: string;
    /** This world's id: characters are bound to it (one per account). Default: experienceId. */
    id?: string;
    /** This world's display name on the server-select screen. Default: the id, title-cased. */
    name?: string;
    /**
     * Other worlds to list on the server-select screen (each its own main, sharing the account database): their id,
     * name and gateway URL. This main serves only its own world; a player picking another is sent to its gateway.
     */
    others?: Array<{ id: string; name: string; url: string }>;
    /** Players per layer (default 40). */
    cap?: number;
    /** Free slots to keep across the pool before starting another layer (default 5). */
    headroom?: number;
    /** Layers to keep running (default 1). */
    min?: number;
    /** Layers at most (default 4). */
    max?: number;
    /** Retire a layer that has been empty this long (default 300 s). */
    retireAfterSeconds?: number;
  };
  instances?: {
    /** An instance exits after being empty this long (default 90 s). */
    idleExitSeconds?: number;
    /** Instances at most (default 8). */
    max?: number;
    /** Scenes that may be instanced (default: any). */
    scenes?: string[];
  };
  /** Starts layers/instances on this box; null = they are started externally and register. */
  supervisor?: Supervisor | null;
  /**
   * Character-creation rules (a `creation` data asset). With them, a new
   * character's build is validated here and a bad one refused with the reason;
   * without them the build is only shape-checked and the layer's sheet
   * authority is the one that validates it (it always re-checks).
   */
  creation?: CharacterCreation;
  /** Recipe files by world id, so main can persist a terraformed recipe (from `loadContent().worldFiles`). */
  worldFiles?: Map<string, string>;
  /**
   * Zone-scoped placement (docs/hosting.md → "Zones"). With regions, a layer
   * hosts a SET of zones: at low population one process hosts all of them;
   * when a zone's players on a copy reach its cap main opens a dedicated copy
   * of that zone, and a player who walks into a zone their layer does not
   * host is handed to a copy that does. Without regions every layer is
   * whole-world and this is inert.
   */
  zones?: {
    regions: ReadonlyArray<RegionDoc>;
    /** Players per copy of a zone (a region's own `cap` wins). Default: the process cap. */
    zoneCap?: number;
    /** Zone a character with no save starts in (the spawn point's zone). */
    spawnZone?: string | null;
    /** Metres inside the far zone before a crossing counts (the layers' `zoneBand`; informational here). */
    band?: number;
  };
  ticketTtlSeconds?: number;
  sessionTtlSeconds?: number;
  /** Told to layers: seconds between periodic saves (default 30). */
  commitEverySeconds?: number;
  /** How long to wait for a spawned child to register (default 45 s). */
  bootTimeoutSeconds?: number;
  /** Autoscale/retire loop period (default 5 s; tests shorten). */
  scaleEverySeconds?: number;
  log?: (line: string) => void;
  /**
   * Moderation (docs/moderation.md). Names: the word list + the judge at
   * `POST /characters`; low-confidence rejects are accepted and listed at
   * `GET /admin/moderation/names`. Default judge: `judgeFromEnv()` (Jev with
   * JEV_API_KEY, else the rules); `judge: null` = word list only, and every
   * audit goes to staff. Reports → audits → sanctions: moderation/audit.ts.
   */
  moderation?: {
    judge?: ModerationJudge | null;
    /** A judge's name reject is enforced only above this probability (default 0.80). */
    nameThreshold?: number;
    /** The game's reserved names — its NPCs and bosses (`reservedNamesFromEntities`). */
    reservedNames?: Iterable<string>;
    /** When reports open an audit (default: weighted reporters >= 3 within 24 h; new or blocked reporters count 0.5). */
    audit?: Partial<AuditRule>;
    /** Probability a judge's audit answer must clear to be applied (default warn 0.70, mutes 0.85, bans 0.95, no_action 0.70). */
    thresholds?: Partial<VerdictThresholds>;
  };
}

export interface MainHandle {
  port: number;
  url: string;
  registry: ServerRegistry;
  /** The item log: store, dupe flag, claims (docs/moderation.md §4). */
  itemsLog: ItemsLogMain;
  /** Audits, verdicts and sanctions (docs/moderation.md §3). */
  moderation: ModerationDesk;
  /** Public gateway base url (http://host:port). */
  close(): Promise<void>;
}

interface Party {
  code: string;
  leader: string;
  members: Set<string>;
}

interface LayerSocket {
  socket: WebSocket;
  id: string;
}

interface Waiter<T> {
  resolve: (v: T) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 2_000_000) reject(new Error("body too large"));
      else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length === 0 ? null : JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("access-control-allow-origin", "*");
  res.end(JSON.stringify(body));
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const PARTY_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function partyCode(): string {
  const bytes = randomBytes(6);
  let out = "";
  for (const b of bytes) out += PARTY_CODE_ALPHABET[b % PARTY_CODE_ALPHABET.length];
  return out;
}

export async function startMain(opts: MainOptions): Promise<MainHandle> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const judge = opts.moderation?.judge !== undefined ? opts.moderation.judge : judgeFromEnv({ log, ...(opts.moderation?.reservedNames ? { reservedNames: opts.moderation.reservedNames } : {}) });
  // escalations + the name review list: one cluster-level record staff read (docs/moderation.md §3)
  const moderationQueue = new ModerationQueue(opts.playerData, opts.experienceId);
  const names = new NameModeration({
    judge,
    ...(opts.moderation?.nameThreshold !== undefined ? { threshold: opts.moderation.nameThreshold } : {}),
    ...(opts.moderation?.reservedNames ? { reserved: opts.moderation.reservedNames } : {}),
    onReview: (review) => moderationQueue.addName(review).then(() => undefined),
    log,
  });
  const registry = new ServerRegistry();
  const regions: ReadonlyArray<RegionDoc> = opts.zones?.regions ?? [];
  const zoned = regions.length > 0;
  registry.zoneAt = (x, z) => regionAt(regions, x, z)?.id ?? null;
  const zoneCapOf = (zone: string | null): number => {
    const region = zone ? regions.find((r) => r.id === zone) : undefined;
    return region?.cap ?? opts.zones?.zoneCap ?? opts.world.cap ?? 40;
  };
  /** Hosted set to hand a child when it registers (a dedicated copy of one zone). */
  const pendingHosted = new Map<string, HostedZones>();
  const arrivalWaiters = new Map<string, Waiter<boolean>>();
  const sockets = new Map<string, LayerSocket>();
  const parties = new Map<string, Party>();
  const partyOf = new Map<string, Party>();
  /** characterId → owner, learned from /play (a ticket needs the account id). */
  const owners = new Map<string, { playerId: string; name: string; saveId?: string }>();
  const recipes = new Map<string, WorldRecipe>();
  const booting = new Map<string, Waiter<ServerEntry>>();
  const terraformWaiters = new Map<string, Waiter<unknown>>();
  const worldId = opts.world.id ?? opts.experienceId;
  const worldName = opts.world.name ?? worldId.replace(/[-_]+/g, " ").split(" ").map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
  const world = {
    scene: opts.world.scene,
    cap: opts.world.cap ?? 40,
    headroom: opts.world.headroom ?? 5,
    min: opts.world.min ?? 1,
    max: opts.world.max ?? 4,
    retireAfterMs: (opts.world.retireAfterSeconds ?? 300) * 1000,
  };
  const instances = {
    idleExitSeconds: opts.instances?.idleExitSeconds ?? 90,
    max: opts.instances?.max ?? 8,
    scenes: opts.instances?.scenes ?? null,
  };
  const supervisor = opts.supervisor ?? null;
  const ticketTtl = opts.ticketTtlSeconds ?? 120;
  const sessionTtl = opts.sessionTtlSeconds ?? 24 * 3600;
  const adminToken = opts.adminToken ?? opts.secret;
  const bootTimeoutMs = (opts.bootTimeoutSeconds ?? 45) * 1000;
  let layerCounter = 0;
  let closed = false;

  // -- cluster socket ---------------------------------------------------------------

  const sendTo = (id: string, msg: MainToLayer): boolean => {
    const entry = sockets.get(id);
    if (!entry || entry.socket.readyState !== entry.socket.OPEN) return false;
    entry.socket.send(JSON.stringify(msg));
    return true;
  };

  const waitForRegister = (id: string): Promise<ServerEntry> =>
    new Promise<ServerEntry>((resolve, reject) => {
      const existing = registry.servers.get(id);
      if (existing) {
        resolve(existing);
        return;
      }
      const timer = setTimeout(() => {
        booting.delete(id);
        reject(new Error(`"${id}" did not register within ${bootTimeoutMs / 1000}s`));
      }, bootTimeoutMs);
      booting.set(id, { resolve, reject, timer });
    });

  /** Layers started as dedicated zone copies: they loaded only their zones, so they never inherit "all". */
  const zoneLoaded = new Set<string>();
  const spawnLayer = (hosted: HostedZones = "all"): Promise<ServerEntry> => {
    if (!supervisor) return Promise.reject(new Error("no supervisor: start another layer externally"));
    const id = `layer-${++layerCounter}`;
    pendingHosted.set(id, hosted);
    const wait = waitForRegister(id);
    log(`[main] starting ${id} for zones ${hosted === "all" ? "all" : hosted.join(", ")}`);
    // a dedicated copy loads only its zones (and a band): it cannot later be asked to host the rest
    if (hosted !== "all") zoneLoaded.add(id);
    supervisor.spawn("layer", world.scene, id, { cap: world.cap, persist: false, ...(hosted !== "all" ? { zones: hosted } : {}) });
    return wait;
  };

  /** The zone a character will stand in when placed: their saved position's, else the spawn zone. */
  const zoneForCharacter = async (playerId: string): Promise<string | null> => {
    if (!zoned) return null;
    try {
      const record = await opts.playerData.load({ playerId, experienceId: opts.experienceId }, "world");
      const pos = record?.data[`pos:${world.scene}`] as { position?: number[] } | undefined;
      if (pos && Array.isArray(pos.position) && pos.position.length === 3) return registry.zoneAt(pos.position[0]!, pos.position[2]!);
    } catch {
      // no save yet
    }
    return opts.zones?.spawnZone ?? null;
  };

  /** Ask the destination whether a spot is quiet (no awake pack in range). Unreachable = assume clear. */
  const arrivalClear = (dest: ServerEntry, position: [number, number, number]): Promise<boolean> =>
    new Promise((resolve) => {
      const requestId = randomBytes(4).toString("hex");
      const timer = setTimeout(() => {
        arrivalWaiters.delete(requestId);
        resolve(true);
      }, 3000);
      arrivalWaiters.set(requestId, { resolve, reject: () => resolve(true), timer });
      if (!sendTo(dest.id, { t: "arrival.check", requestId, position })) {
        clearTimeout(timer);
        arrivalWaiters.delete(requestId);
        resolve(true);
      }
    });

  const ensureInstance = async (scene: string, key: string): Promise<ServerEntry> => {
    if (instances.scenes && !instances.scenes.includes(scene)) throw new HttpError(400, `scene "${scene}" is not instanceable`);
    const existing = [...registry.servers.values()].find((s) => s.kind === "instance" && s.scene === scene && s.instanceOf === key && s.accepting);
    if (existing) return existing;
    if (!supervisor) throw new HttpError(503, "no supervisor: instances cannot be started");
    const running = [...registry.servers.values()].filter((s) => s.kind === "instance").length + [...booting.keys()].filter((id) => id.startsWith("inst-")).length;
    if (running >= instances.max) throw new HttpError(503, "instance limit reached");
    const id = `inst-${randomBytes(3).toString("hex")}`;
    const wait = waitForRegister(id);
    supervisor.spawn("instance", scene, id, { instanceOf: key, idleExitSeconds: instances.idleExitSeconds, persist: false });
    return wait;
  };

  const partyMembersOf = (characterId: string): string[] => {
    const party = partyOf.get(characterId);
    return party ? [...party.members] : [];
  };
  /** Tell the layer a character stands on which party they are in (party chat routes on the layer from that). */
  const pushParty = (characterId: string, srv = registry.whereIs.get(characterId)): void => {
    if (srv) sendTo(srv, { t: "party", characterId, party: partyOf.get(characterId)?.code ?? null });
  };

  // -- friends and party events (docs/hosting.md → "Parties and friends") --------------
  const social = new SocialStore(opts.playerData, opts.experienceId);
  // -- the item log (docs/moderation.md §4): per-character log, dupe flag, claims -----
  const itemsLog = new ItemsLogMain({ backend: opts.playerData, experienceId: opts.experienceId, log });
  // -- reports (docs/moderation.md §2): main's buffer of bridged lines + intake ------
  const bridgedChat = new ChatBuffer({ maxLines: MAIN_CHAT_BUFFER_LINES });
  const evidenceRequests = new EvidenceRequests(sendTo);
  const reports = new ReportStore(opts.playerData, opts.experienceId);
  const reportIntake = new ReportIntake({ store: reports, mainBuffer: bridgedChat, requests: evidenceRequests, whereIs: (characterId) => registry.whereIs.get(characterId) });
  /** Party invitations waiting on a character — session state, like parties. */
  const invites = new Map<string, Array<{ code: string; from: FriendRef; at: number }>>();
  /** Where a character is right now, as a party list shows it. */
  const presenceOf = (characterId: string): { online: boolean; server: string | null; zone: string | null } => {
    const srv = registry.whereIs.get(characterId) ?? null;
    const server = srv ? registry.servers.get(srv) : undefined;
    return { online: srv !== null, server: srv, zone: server?.zoneOfPlayer.get(characterId) ?? null };
  };
  /** The characters of an account that are online right now (every one of them passed /play on this main). */
  const onlineCharactersOf = (playerId: string): Array<{ characterId: string; name: string }> => {
    const out: Array<{ characterId: string; name: string }> = [];
    for (const characterId of registry.whereIs.keys()) {
      const owner = owners.get(characterId);
      if (owner?.playerId === playerId) out.push({ characterId, name: owner.name });
    }
    return out;
  };
  /** A friend as the list shows them: the character they are playing, else the one the link was made through. */
  const friendView = (f: FriendRef): { playerId: string; characterId: string; name: string; online: boolean; server: string | null; zone: string | null } => {
    const playing = onlineCharactersOf(f.playerId)[0];
    if (!playing) return { playerId: f.playerId, characterId: f.characterId, name: f.characterName, online: false, server: null, zone: null };
    return { playerId: f.playerId, characterId: playing.characterId, name: playing.name, ...presenceOf(playing.characterId) };
  };
  /** A character reference by id — from this session's owners, else the account store. */
  const refOf = async (characterId: string): Promise<FriendRef | null> => {
    const known = owners.get(characterId);
    if (known) return { playerId: known.playerId, characterId, characterName: known.name };
    const found = await opts.accounts.findCharacterById(characterId);
    return found ? { playerId: found.account.id, characterId, characterName: found.character.name } : null;
  };
  const refByName = async (name: string): Promise<FriendRef> => {
    const found = name ? await opts.accounts.findCharacter(name) : null;
    if (!found) throw new HttpError(404, `no character called "${name}"`);
    return { playerId: found.account.id, characterId: found.character.id, characterName: found.character.name };
  };
  /** Hand a social event to the layer a character stands on (nothing if offline — the list catches up on read). */
  const notify = (characterId: string, event: SocialEvent): void => {
    const srv = registry.whereIs.get(characterId);
    if (srv) sendTo(srv, { t: "social", characterId, event });
  };
  /** The same, to every character of an account that is online. */
  const notifyAccount = (playerId: string, event: SocialEvent): void => {
    for (const c of onlineCharactersOf(playerId)) notify(c.characterId, event);
  };
  /** Tell a character's layer which characters it must not hear (every character of every account it blocked). */
  const pushBlocks = async (characterId: string, srv = registry.whereIs.get(characterId)): Promise<void> => {
    const owner = owners.get(characterId);
    if (!srv || !owner) return;
    const mine = await social.load(owner.playerId);
    const blocked: string[] = [];
    for (const b of mine.blocked) {
      const account = await opts.accounts.get(b.playerId);
      for (const c of account?.characters ?? []) blocked.push(c.id);
    }
    sendTo(srv, { t: "blocks", characterId, blocked });
  };
  // -- audits, verdicts and sanctions (docs/moderation.md §3) ---------------------------
  /** A banned player's old ticket may still be in hand: the layer that removed them refuses it this long (new ones need /play). */
  const refuseMs = (ticketTtl + 30) * 1000;
  const kickText = (until: number | undefined, reason: string): string => `${banLine(until, reason)} You have been disconnected.`;
  /** Tell one character's layer their mute state (and show `notices`); false when they are not on a layer. */
  const pushSanctionTo = async (playerId: string, characterId: string, srv = registry.whereIs.get(characterId), notices: string[] = []): Promise<boolean> => {
    if (!srv) return false;
    const active = activeSanctions(await reports.load(playerId), Date.now());
    if (active.ban) return sendTo(srv, { t: "kick", characterId, text: kickText(active.ban.until, active.ban.reason), refuseUntil: Math.min(active.ban.until ?? Infinity, Date.now() + refuseMs) });
    return sendTo(srv, { t: "sanction", characterId, muteUntil: active.mute?.until ?? null, ...(active.mute ? { reason: active.mute.reason } : {}), ...(notices.length > 0 ? { notice: notices.join(" ") } : {}) });
  };
  /** On every arrival (join, transfer): the mute state, a ban that slipped through, and warns never shown. */
  const pushSanctions = async (characterId: string, srv: string): Promise<void> => {
    const owner = owners.get(characterId);
    if (!owner) return;
    const active = activeSanctions(await reports.load(owner.playerId), Date.now());
    const notices = active.undeliveredWarns.map((w) => warnLine(w.reason));
    if ((await pushSanctionTo(owner.playerId, characterId, srv, notices)) && notices.length > 0) await moderation.delivered(owner.playerId, active.undeliveredWarns.map((w) => w.id));
  };
  /** A sanction was given or lifted: make it true wherever the account's characters stand. */
  const enforce: Enforce = async (account, { sanction, lifted }) => {
    const online = onlineCharactersOf(account);
    if (sanction.kind === "ban") {
      if (lifted) return; // /play lets them in again; the layer's refusal outlives no ticket
      for (const c of online) {
        const srv = registry.whereIs.get(c.characterId);
        if (srv) sendTo(srv, { t: "kick", characterId: c.characterId, text: kickText(sanction.until, sanction.reason), refuseUntil: Math.min(sanction.until ?? Infinity, Date.now() + refuseMs) });
      }
      return;
    }
    let shown = false;
    for (const c of online) {
      const notice =
        sanction.kind === "mute"
          ? lifted
            ? "Your mute was lifted."
            : muteLine(sanction.until, sanction.reason)
          : sanction.kind === "warn"
            ? lifted
              ? null
              : warnLine(sanction.reason)
            : !lifted && sanction.characterId === c.characterId
              ? renameLine(sanction.name ?? c.name)
              : null;
      if (sanction.kind === "rename" && !notice) continue;
      if (await pushSanctionTo(account, c.characterId, undefined, notice ? [notice] : [])) shown = true;
    }
    if (shown && sanction.kind === "warn" && !lifted) await moderation.delivered(account, [sanction.id]);
  };
  const moderation = new ModerationDesk({
    store: reports,
    queue: moderationQueue,
    judge,
    names,
    accountCreatedAt: async (account) => {
      const created = Date.parse((await opts.accounts.get(account))?.createdAt ?? "");
      return Number.isFinite(created) ? created : null;
    },
    hasBlocked: async (account, other) => isBlocked(await social.load(account), other),
    enforce,
    ...(opts.moderation?.audit ? { rule: opts.moderation.audit } : {}),
    ...(opts.moderation?.thresholds ? { thresholds: opts.moderation.thresholds } : {}),
    log,
  });
  /** Staff routes answer a ModerationError with its status. */
  const staff = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ModerationError) throw new HttpError(error.status, error.message);
      throw error;
    }
  };
  const lastOnline = new Map<string, boolean>();
  /** Friends learn a character came or went (not on a transfer — they never left). */
  const announcePresence = async (characterId: string, online: boolean): Promise<void> => {
    if (lastOnline.get(characterId) === online) return;
    lastOnline.set(characterId, online);
    const me = await refOf(characterId);
    if (!me) return;
    const mine = await social.load(me.playerId);
    const zone = presenceOf(characterId).zone;
    for (const f of mine.friends) notifyAccount(f.playerId, { kind: online ? "friend.online" : "friend.offline", characterId, name: me.characterName, zone });
  };
  // -- guilds: durable on the same store; membership mirrored in memory for chat routing and lookups
  const guilds = new GuildStore(opts.playerData, opts.experienceId, social);
  const guildOf = new Map<string, { id: string; name: string }>();
  const guildInvites = new Map<string, Array<{ guild: string; guildName: string; from: FriendRef; at: number }>>();
  /** Tell a character's layer which guild they are in, so guild chat routes there. */
  const pushGuild = (characterId: string, srv = registry.whereIs.get(characterId)): void => {
    if (srv) sendTo(srv, { t: "guild", characterId, guild: guildOf.get(characterId)?.id ?? null });
  };
  const setGuildOf = (characterId: string, guild: { id: string; name: string } | null): void => {
    if (guild) guildOf.set(characterId, guild);
    else guildOf.delete(characterId);
    pushGuild(characterId);
  };
  /** On arrival: the character's own record says which guild they are in. */
  const loadGuildOf = async (characterId: string, srv: string): Promise<void> => {
    const owner = owners.get(characterId);
    if (!owner) return;
    const mine = await social.load(owner.playerId);
    const g = mine.guilds?.[characterId];
    if (g) guildOf.set(characterId, { id: g.id, name: g.name });
    else guildOf.delete(characterId);
    pushGuild(characterId, srv);
  };
  const tellGuild = (g: GuildRecord, event: SocialEvent, except?: string): void => {
    for (const m of Object.values(g.members)) if (m.characterId !== except) notify(m.characterId, event);
  };
  const partyView = async (party: Party | undefined): Promise<unknown> =>
    party
      ? {
          code: party.code,
          leader: party.leader,
          members: await Promise.all([...party.members].map(async (id) => ({ characterId: id, name: (await refOf(id))?.characterName ?? id, ...presenceOf(id) }))),
        }
      : null;
  const tellParty = (party: Party, event: SocialEvent, except?: string): void => {
    for (const m of party.members) if (m !== except) notify(m, event);
  };
  /** Take a character out of their party (leave, kick); the party dissolves when empty, the leadership moves when the leader goes. */
  const removeFromParty = (characterId: string, name: string): Party | null => {
    const party = partyOf.get(characterId);
    if (!party) return null;
    party.members.delete(characterId);
    partyOf.delete(characterId);
    pushParty(characterId);
    if (party.members.size === 0) parties.delete(party.code);
    else {
      if (party.leader === characterId) {
        party.leader = [...party.members][0]!;
        tellParty(party, { kind: "party.leader", characterId: party.leader, name: owners.get(party.leader)?.name ?? party.leader });
      }
      tellParty(party, { kind: "party.left", characterId, name });
    }
    return party;
  };

  /** Tell the server a character is on to hand it to `dest`. */
  const moveCharacter = (characterId: string, dest: ServerEntry, reason: string, portal?: PortalHop): boolean => {
    const on = registry.whereIs.get(characterId);
    if (!on || on === dest.id) return false;
    return sendTo(on, { t: "transfer.begin", characterId, srv: dest.id, url: dest.url, reason, scene: dest.scene, ...(portal ? { portal } : {}) });
  };

  /**
   * Where a character goes: with zones, the copy of THEIR zone with the most
   * neighbours below the zone cap (party/affinity first); without, the
   * fullest layer with room. Nothing has room → open another layer: a
   * dedicated copy of that zone when zoned, a whole-world one otherwise.
   */
  const placeOrGrow = async (characterId: string, zone: string | null = null, exclude?: string): Promise<ServerEntry> => {
    const attempt = (): ServerEntry | null => {
      const partyMembers = partyMembersOf(characterId);
      if (zoned) {
        const p = registry.placeInZone({ scene: world.scene, characterId, partyMembers, zone, zoneCap: zoneCapOf(zone), ...(exclude ? { exclude } : {}) });
        return p?.server ?? null;
      }
      const p = registry.place({ scene: world.scene, characterId, partyMembers });
      if (p && p.server.id !== exclude) return p.server;
      if (exclude) {
        const others = registry
          .layersFor(world.scene)
          .filter((s) => s.id !== exclude && s.accepting && !s.draining && registry.free(s) > 0)
          .sort((a, b) => b.players.size - a.players.size);
        return others[0] ?? null;
      }
      return null;
    };
    let server = attempt();
    if (server) return server;
    const layers = registry.layersFor(world.scene).length + [...booting.keys()].filter((id) => id.startsWith("layer-")).length;
    if (layers < world.max && supervisor) {
      await spawnLayer(zoned && zone ? [zone] : "all").catch((error: unknown) => log(`[main] layer boot failed: ${error instanceof Error ? error.message : String(error)}`));
      server = attempt();
      if (server) return server;
    }
    // a layer may already be booting: wait for it
    const pending = [...booting.entries()].find(([id]) => id.startsWith("layer-"));
    if (pending) {
      await new Promise<void>((resolve) => {
        const original = pending[1];
        pending[1].resolve = (v) => {
          original.resolve(v);
          resolve();
        };
        pending[1].reject = (e) => {
          original.reject(e);
          resolve();
        };
      });
      server = attempt();
      if (server) return server;
    }
    throw new HttpError(503, "the world is full — try again in a moment");
  };

  const resolveTarget = async (characterId: string, target: TransferTarget): Promise<ServerEntry> => {
    if (target.kind === "instance") {
      const key = target.party ? (partyOf.get(characterId)?.code ?? characterId) : characterId;
      return ensureInstance(target.scene, key);
    }
    if (target.kind === "layer" && target.layerId) {
      const s = registry.servers.get(target.layerId);
      if (!s) throw new HttpError(404, `no server "${target.layerId}"`);
      return s;
    }
    // somewhere else that takes them: with zones, a copy of the zone they stand in
    const on = registry.whereIs.get(characterId);
    const presence = on ? registry.servers.get(on)?.players.get(characterId) : undefined;
    const zone = presence?.position ? registry.zoneAt(presence.position[0], presence.position[2]) : await zoneForCharacter(owners.get(characterId)?.saveId ?? owners.get(characterId)?.playerId ?? "");
    return placeOrGrow(characterId, zone, on);
  };

  const persistRecipe = (id: string, recipe: WorldRecipe): void => {
    const file = opts.worldFiles?.get(id);
    if (!file) return;
    const tmp = `${file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(recipe, null, 2) + "\n");
      fs.renameSync(tmp, file);
      log(`[main] recipe "${id}" saved (${file})`);
    } catch (error) {
      log(`[main] could not save recipe "${id}": ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handleRpc = async (layerId: string, call: LayerRpc): Promise<unknown> => {
    switch (call.op) {
      case "data.load":
        if (call.scope.experienceId !== opts.experienceId) throw new Error("wrong experience");
        return opts.playerData.load(call.scope, call.namespace);
      case "data.store":
        if (call.scope.experienceId !== opts.experienceId) throw new Error("wrong experience");
        return opts.playerData.store(call.scope, call.namespace, call.record, call.expectedRevision);
      case "ticket.mint": {
        const dest = registry.servers.get(call.srv);
        if (!dest) throw new Error(`no server "${call.srv}"`);
        const account = await opts.accounts.get(call.playerId);
        const character = account?.characters.find((c) => c.id === call.characterId && !c.deletedAt);
        if (!character || worldOf(character, worldId) !== worldId) throw new Error("character does not belong to this world");
        registry.reserve(dest.id, call.characterId, call.playerId, call.name);
        return {
          ticket: signTicket(opts.secret, { sub: call.playerId, chr: call.characterId, saveId: character.saveId ?? call.playerId, name: call.name, srv: call.srv, rev: call.rev, reason: call.reason, ttlSeconds: ticketTtl }),
        };
      }
      case "transfer.request": {
        if (call.target.kind === "zone") {
          // a border crossing: a copy of that zone (never the layer asking),
          // and only once the far side says the spot is quiet — unless the
          // layer has waited long enough and says force
          const origin = registry.whereIs.get(call.characterId) ?? layerId;
          const dest = await placeOrGrow(call.characterId, call.target.zone, origin);
          if (!call.target.force && !(await arrivalClear(dest, call.target.position))) {
            return { wait: true, retryMs: 2000 } satisfies TransferAnswer;
          }
          registry.reserve(dest.id, call.characterId, "", "", Date.now(), call.target.zone);
          return { srv: dest.id, url: dest.url } satisfies TransferAnswer;
        }
        const dest = await resolveTarget(call.characterId, call.target);
        if (call.target.party) {
          // a portal trip pulls the party into the SAME instance; each member's
          // layer records that member's own arrival and way back (PortalHop)
          for (const member of partyMembersOf(call.characterId)) {
            if (member !== call.characterId) moveCharacter(member, dest, "party", call.target.portal);
          }
        }
        return { srv: dest.id, url: dest.url, scene: dest.scene } satisfies TransferAnswer;
      }
      case "recipe.changed": {
        recipes.set(call.id, call.recipe);
        persistRecipe(call.id, call.recipe);
        for (const id of sockets.keys()) if (id !== layerId) sendTo(id, { t: "recipe", id: call.id, recipe: call.recipe });
        return { fanned: sockets.size - 1 };
      }
      case "evidence.result":
        evidenceRequests.resolve(call.requestId, call.evidence);
        return null;
      case "items.log":
        return itemsLog.ingest(layerId, { batchId: call.batchId, batches: call.batches });
      case "arrival.result": {
        const w = arrivalWaiters.get(call.requestId);
        if (w) {
          arrivalWaiters.delete(call.requestId);
          clearTimeout(w.timer);
          w.resolve(call.clear);
        }
        return null;
      }
      case "terraform.result": {
        const w = terraformWaiters.get(call.requestId);
        if (w) {
          terraformWaiters.delete(call.requestId);
          clearTimeout(w.timer);
          if (call.ok) w.resolve(call.result);
          else w.reject(new Error(call.error ?? "terraform failed"));
        }
        return null;
      }
    }
  };

  const onLayerMessage = (state: { id: string | null }, socket: WebSocket, msg: LayerToMain): void => {
    if (msg.t === "register") {
      if (msg.secret !== opts.secret) {
        socket.send(JSON.stringify({ t: "rejected", reason: "bad secret" } satisfies MainToLayer));
        socket.close(4003, "bad secret");
        return;
      }
      const previous = sockets.get(msg.id);
      if (previous && previous.socket !== socket) {
        try {
          previous.socket.close(1000, "replaced");
        } catch {
          // ignore
        }
      }
      state.id = msg.id;
      sockets.set(msg.id, { socket, id: msg.id });
      // hosted zones: what main asked this child to be (a dedicated copy), what it
      // was before a reconnect, else everything — the first layer is always "all"
      const hosted: HostedZones = pendingHosted.get(msg.id) ?? registry.servers.get(msg.id)?.hosted ?? "all";
      pendingHosted.delete(msg.id);
      const entry = registry.register({ id: msg.id, kind: msg.kind, url: msg.url, scene: msg.scene, cap: msg.cap, hosted, ...(msg.instanceOf ? { instanceOf: msg.instanceOf } : {}) });
      const primary = registry.layersFor(world.scene).sort((a, b) => a.registeredAt - b.registeredAt)[0]?.id === msg.id;
      socket.send(JSON.stringify({ t: "registered", id: msg.id, experienceId: opts.experienceId, primary, commitEverySeconds: opts.commitEverySeconds ?? 30 } satisfies MainToLayer));
      if (msg.kind === "layer" && zoned) sendTo(msg.id, { t: "zones", hosted });
      for (const [id, recipe] of recipes) sendTo(msg.id, { t: "recipe", id, recipe });
      log(`[main] ${msg.kind} "${msg.id}" registered (${msg.scene}, cap ${msg.cap}, ${msg.url})`);
      const waiter = booting.get(msg.id);
      if (waiter) {
        booting.delete(msg.id);
        clearTimeout(waiter.timer);
        waiter.resolve(entry);
      }
      return;
    }
    const id = state.id;
    if (!id) return; // not registered: ignore
    switch (msg.t) {
      case "status":
        registry.status(id, msg.players, msg.tickMs, msg.entities, msg.accepting);
        return;
      case "player.joined":
        registry.joined(id, msg.player);
        pushParty(msg.player.characterId, id);
        void pushBlocks(msg.player.characterId, id).catch(() => undefined);
        void pushSanctions(msg.player.characterId, id).catch((error: unknown) => log(`[main] sanctions push: ${error instanceof Error ? error.message : String(error)}`));
        void loadGuildOf(msg.player.characterId, id).catch(() => undefined);
        void announcePresence(msg.player.characterId, true).catch((error: unknown) => log(`[main] presence: ${error instanceof Error ? error.message : String(error)}`));
        return;
      case "player.left":
        registry.left(id, msg.characterId);
        // a transfer is not a departure: they are dialling the next layer
        if (msg.reason !== "transfer") void announcePresence(msg.characterId, false).catch(() => undefined);
        return;
      case "transfer.failed":
        log(`[main] transfer of ${msg.characterId} from "${id}" failed: ${msg.reason}`);
        return;
      case "chat": {
        // zone/global/party lines cross layers: every other copy of the world
        // hears what this one said (the origin already delivered it locally).
        // A party line carries the party MAIN knows, never the layer's guess.
        const line =
          msg.line.channel === "party"
            ? { ...msg.line, party: partyOf.get(msg.line.from)?.code ?? null }
            : msg.line.channel === "guild"
              ? { ...msg.line, guild: guildOf.get(msg.line.from)?.id ?? null }
              : msg.line;
        // kept 15 minutes for reports (docs/moderation.md §2), never written down on its own
        bridgedChat.push({ id: line.id, channel: line.channel, from: line.from, account: owners.get(line.from)?.playerId ?? null, name: line.name, text: line.text, at: line.at, position: null, zone: line.zone, origin: id, to: null });
        if (line.channel === "party" && line.party === null) return;
        if (line.channel === "guild" && line.guild === null) return;
        for (const other of sockets.keys()) if (other !== id) sendTo(other, { t: "chat", line, origin: id });
        return;
      }
      case "rpc":
        void handleRpc(id, msg.call).then(
          (result) => sendTo(id, { t: "rpc.result", id: msg.id, ok: true, result }),
          (error: unknown) => sendTo(id, { t: "rpc.result", id: msg.id, ok: false, error: error instanceof Error ? error.message : String(error) }),
        );
        return;
    }
  };

  // -- gateway HTTP -------------------------------------------------------------------

  const bearer = (req: http.IncomingMessage): string | null => {
    const h = req.headers.authorization;
    if (!h || !h.startsWith("Bearer ")) return null;
    return h.slice(7).trim();
  };

  const accountVersions = new WeakMap<AccountRecord, AccountRecord>();
  const saveAccount = async (account: AccountRecord): Promise<void> => {
    if (!(await opts.accounts.update(account, accountVersions.get(account)))) throw new HttpError(409, "Your characters changed on another world. Refresh and try again.");
    accountVersions.set(account, structuredClone(account));
  };
  const bindLegacyWorld = async (account: AccountRecord): Promise<AccountRecord> => {
    accountVersions.set(account, structuredClone(account));
    let changed = false;
    for (const character of account.characters) {
      if (!character.world) { character.world = worldId; character.saveId = account.id; changed = true; }
    }
    if (changed) await saveAccount(account);
    return account;
  };

  const requireAccount = async (req: http.IncomingMessage): Promise<AccountRecord> => {
    const token = bearer(req);
    if (!token) throw new HttpError(401, "sign in first");
    const v = verifySession(opts.secret, token);
    if (!v.ok) throw new HttpError(401, v.reason);
    const account = await opts.accounts.get(v.sub);
    if (!account) throw new HttpError(401, "unknown account");
    return bindLegacyWorld(account);
  };

  const requireAdmin = (req: http.IncomingMessage): void => {
    if (bearer(req) !== adminToken) throw new HttpError(401, "admin token required");
  };

  const characterOf = (account: AccountRecord, characterId: unknown): CharacterRecord => {
    if (typeof characterId !== "string") throw new HttpError(400, "characterId required");
    const c = account.characters.find((x) => x.id === characterId && !x.deletedAt);
    if (!c) throw new HttpError(404, "no such character on this account");
    if (worldOf(c, worldId) !== worldId) throw new HttpError(409, `${c.name} lives on another world`);
    return c;
  };

  /** Characters on THIS world (an account's others live on theirs). */
  const here = (list: CharacterRecord[]): CharacterRecord[] => list.filter((c) => worldOf(c, worldId) === worldId).map((c) => ({ ...c, world: worldOf(c, worldId) }));
  const sessionFor = (account: AccountRecord): unknown => ({
    session: signSession(opts.secret, account.id, sessionTtl),
    account: { id: account.id, name: account.name },
    world: { id: worldId, name: worldName },
    characters: here(liveCharacters(account)),
    deleted: here(restorableCharacters(account)),
  });
  /** The roster a client draws: playable characters, and the deleted ones it may still restore. */
  const rosterOf = (account: AccountRecord): unknown => ({ world: { id: worldId, name: worldName }, characters: here(liveCharacters(account)), deleted: here(restorableCharacters(account)), graceDays: DELETE_GRACE_DAYS });

  const publicStatus = (): unknown => ({
    scene: world.scene,
    players: [...registry.servers.values()].reduce((n, s) => n + s.players.size, 0),
    layers: registry.layersFor(world.scene).map((s) => ({ id: s.id, players: s.players.size, cap: s.cap })),
    instances: [...registry.servers.values()].filter((s) => s.kind === "instance").length,
  });

  const route = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://x");
    const p = url.pathname;
    const method = req.method ?? "GET";
    if (method === "OPTIONS") {
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
      res.setHeader("access-control-allow-headers", "content-type,authorization");
      res.statusCode = 204;
      res.end();
      return;
    }
    if (p === "/health") return send(res, 200, { ok: true, ...(publicStatus() as object) });
    if (p === "/status" && method === "GET") return send(res, 200, publicStatus());

    if (p === "/auth/register" && method === "POST") {
      const body = (await readJson(req)) as { name?: unknown; password?: unknown } | null;
      const name = typeof body?.name === "string" ? body.name.trim() : "";
      const password = typeof body?.password === "string" ? body.password : "";
      if (!ACCOUNT_NAME.test(name)) throw new HttpError(400, "name: 3-24 letters, digits, spaces, _ or -");
      if (password.length < 6) throw new HttpError(400, "password: at least 6 characters");
      const { salt, hash } = await hashPassword(password);
      const record: AccountRecord = { id: newId("acct"), name, nameLower: name.toLowerCase(), salt, hash, createdAt: new Date().toISOString(), characters: [] };
      if ((await opts.accounts.create(record)) === "taken") throw new HttpError(409, "that name is taken");
      return send(res, 200, sessionFor(record));
    }
    if (p === "/auth/login" && method === "POST") {
      const body = (await readJson(req)) as { name?: unknown; password?: unknown } | null;
      const name = typeof body?.name === "string" ? body.name.trim() : "";
      const password = typeof body?.password === "string" ? body.password : "";
      const account = await opts.accounts.find(name);
      if (!account || !(await checkPassword(account, password))) throw new HttpError(401, "wrong name or password");
      return send(res, 200, sessionFor(await bindLegacyWorld(account)));
    }
    // the rules the creation screen draws and /characters validates against — one source for both
    if (p === "/creation" && method === "GET") return send(res, 200, { creation: opts.creation ?? null });
    // the server-select screen: this world (its population, the caller's character on it) and any others listed
    if (p === "/worlds" && method === "GET") {
      const account = await requireAccount(req);
      const mine = (id: string): unknown => {
        const c = liveCharacters(account).find((x) => worldOf(x, worldId) === id);
        return c ? { id: c.id, name: c.name, ...(c.build ? { archetype: c.build.archetype } : {}) } : null;
      };
      const layers = registry.layersFor(world.scene);
      const players = layers.reduce((n, s) => n + s.players.size, 0);
      const capacity = Math.max(world.cap, layers.reduce((n, s) => n + s.cap, 0));
      return send(res, 200, {
        current: worldId,
        worlds: [
          { id: worldId, name: worldName, url: null, status: "online", players, capacity, character: mine(worldId) },
          ...(opts.world.others ?? []).map((o) => ({ id: o.id, name: o.name, url: o.url, status: "unknown", players: null, capacity: null, character: mine(o.id) })),
        ],
      });
    }
    if (p === "/characters" && method === "GET") {
      const account = await requireAccount(req);
      if (purgeDeleted(account)) await saveAccount(account);
      return send(res, 200, rosterOf(account));
    }
    // is a name free for a new character? (the creation screen asks as you type; POST /characters decides)
    if (p === "/characters/name" && method === "GET") {
      await requireAccount(req);
      const name = (url.searchParams.get("name") ?? "").trim();
      if (!CHARACTER_NAME.test(name)) return send(res, 200, { ok: false, reason: "3-20 letters (spaces, ' and - inside)" });
      if (await opts.accounts.findCharacter(name)) return send(res, 200, { ok: false, reason: "taken" });
      const listed = names.checkList(name); // the cheap stage only; POST /characters also asks the judge
      if (listed) return send(res, 200, { ok: false, reason: listed.message });
      return send(res, 200, { ok: true });
    }
    // delete (restorable for DELETE_GRACE_DAYS; the name stays reserved meanwhile) and restore
    const charRoute = /^\/characters\/([A-Za-z0-9_-]{3,64})(\/restore)?$/.exec(p);
    if (charRoute && method === "DELETE" && !charRoute[2]) {
      const account = await requireAccount(req);
      const character = characterOf(account, charRoute[1]);
      const body = (await readJson(req)) as { confirm?: unknown } | null;
      if (typeof body?.confirm !== "string" || body.confirm.trim().toLowerCase() !== character.name.toLowerCase()) {
        throw new HttpError(400, `type the character's name (${character.name}) to delete it`);
      }
      if (registry.whereIs.has(character.id)) throw new HttpError(409, "Camp and leave the world before deleting this character. A disconnected body may remain for 60 seconds.");
      character.deletedAt = new Date().toISOString();
      await saveAccount(account);
      return send(res, 200, rosterOf(account));
    }
    if (charRoute && method === "POST" && charRoute[2]) {
      const account = await requireAccount(req);
      const character = restorableCharacters(account).find((c) => c.id === charRoute[1]);
      if (!character) throw new HttpError(404, "no deleted character to restore (past the grace period?)");
      if (worldOf(character, worldId) !== worldId) throw new HttpError(409, `${character.name} lives on another world`);
      if (liveCharacters(account).length >= MAX_CHARACTERS) throw new HttpError(400, `at most ${MAX_CHARACTERS} characters — delete one first`);
      if (worldOf(character, worldId) === worldId && liveCharacters(account).some((c) => worldOf(c, worldId) === worldId)) {
        throw new HttpError(409, `you already have a character on ${worldName} — delete it before restoring this one`);
      }
      delete character.deletedAt;
      await saveAccount(account);
      return send(res, 200, rosterOf(account));
    }
    // a refused name (a `rename` sanction) is cleared by choosing a new one — the full name check, as at creation
    const renameRoute = /^\/characters\/([A-Za-z0-9_-]{3,64})\/rename$/.exec(p);
    if (renameRoute && method === "POST") {
      const account = await requireAccount(req);
      const character = characterOf(account, renameRoute[1]);
      if (!(await moderation.active(account.id)).renames.some((s) => s.characterId === character.id)) throw new HttpError(400, `${character.name} does not need a new name`);
      const body = (await readJson(req)) as { name?: unknown } | null;
      const name = typeof body?.name === "string" ? body.name.trim() : "";
      if (!CHARACTER_NAME.test(name)) throw new HttpError(400, "character name: 3-20 letters");
      if (await opts.accounts.findCharacter(name)) throw new HttpError(409, `a character called "${name}" already exists — pick another name`);
      const verdict = await names.check(name, { accountId: account.id, characterId: character.id });
      if (!verdict.ok) throw new HttpError(400, verdict.message);
      character.name = name;
      await saveAccount(account);
      await moderation.renamed(account.id, character.id, name);
      if (owners.has(character.id)) owners.set(character.id, { playerId: account.id, name, saveId: character.saveId ?? account.id });
      return send(res, 200, { character, ...(rosterOf(account) as object) });
    }
    if (p === "/characters" && method === "POST") {
      const account = await requireAccount(req);
      const body = (await readJson(req)) as { name?: unknown; build?: unknown } | null;
      const name = typeof body?.name === "string" ? body.name.trim() : "";
      if (!CHARACTER_NAME.test(name)) throw new HttpError(400, "character name: 3-20 letters");
      let build: CharacterBuild | undefined;
      if (body?.build !== undefined) {
        if (opts.creation) {
          const v = validateBuild(opts.creation, body.build);
          if (!v.ok) throw new HttpError(400, v.error);
          build = v.build;
        } else {
          const v = characterBuildSchema.safeParse(body.build);
          if (!v.success) throw new HttpError(400, `build: ${v.error.issues[0]?.message ?? "invalid"}`);
          build = v.data;
        }
      } else if (opts.creation) {
        throw new HttpError(400, "choose an archetype, a birth trait and a look first");
      }
      if (liveCharacters(account).length >= MAX_CHARACTERS) throw new HttpError(400, `at most ${MAX_CHARACTERS} characters`);
      // one character per account per world: start over by deleting the one here
      const already = liveCharacters(account).find((c) => worldOf(c, worldId) === worldId);
      if (already) throw new HttpError(409, `you already have a character on ${worldName} (${already.name}) — delete it to start over`);
      // names are how players find each other (/friend, /invite): one character per name, world-wide
      if (await opts.accounts.findCharacter(name)) throw new HttpError(409, `a character called "${name}" already exists — pick another name`);
      const verdict = await names.check(name, { accountId: account.id });
      if (!verdict.ok) throw new HttpError(400, verdict.message);
      const characterId = newId("chr");
      const character: CharacterRecord = { id: characterId, saveId: characterId, name, createdAt: new Date().toISOString(), world: worldId, ...(build ? { build } : {}) };
      account.characters.push(character);
      await saveAccount(account);
      return send(res, 200, { character, characters: here(liveCharacters(account)), deleted: here(restorableCharacters(account)) });
    }
    if (p === "/play" && method === "POST") {
      const account = await requireAccount(req);
      const body = (await readJson(req)) as { characterId?: unknown } | null;
      const character = characterOf(account, body?.characterId);
      // moderation (docs/moderation.md §3): a ban keeps the account out; a refused name must be changed first
      const sanctions = await moderation.active(account.id);
      if (sanctions.ban) throw new HttpError(403, banLine(sanctions.ban.until, sanctions.ban.reason));
      const rename = sanctions.renames.find((s) => s.characterId === character.id);
      if (rename) {
        return send(res, 409, {
          ok: false,
          code: "rename_required",
          renameRequired: true,
          characterId: character.id,
          name: character.name,
          error: `The name "${character.name}" was refused: ${rename.reason}. Choose a new name to keep playing.`,
        });
      }
      owners.set(character.id, { playerId: account.id, name: character.name, saveId: character.saveId ?? account.id });
      const zone = await zoneForCharacter(character.saveId ?? account.id);
      // still standing on a layer (a reconnect grace, or a body held while it is being looted): back to THAT body,
      // never a second one elsewhere spawned from an older save
      const held = registry.whereIs.get(character.id);
      const heldOn = held ? registry.servers.get(held) : undefined;
      const server = heldOn && heldOn.accepting ? heldOn : await placeOrGrow(character.id, zone);
      registry.reserve(server.id, character.id, account.id, character.name, Date.now(), zone);
      const ticket = signTicket(opts.secret, { sub: account.id, chr: character.id, saveId: character.saveId ?? account.id, name: character.name, srv: server.id, reason: "join", ...(character.build ? { build: character.build } : {}), ttlSeconds: ticketTtl });
      return send(res, 200, { url: server.url, ticket, server: server.id, scene: server.scene });
    }
    // a player reports another (docs/moderation.md §2): evidence gathered now, stored with the report
    if (p === "/reports" && method === "POST") {
      const account = await requireAccount(req);
      const body = (await readJson(req)) as Record<string, unknown> | null;
      const character = characterOf(account, body?.["characterId"]);
      const name = typeof body?.["target"] === "string" ? body["target"].trim() : "";
      if (!name) throw new HttpError(400, "who are you reporting? give their character name");
      const target = await refByName(name);
      try {
        const { report } = await reportIntake.file({
          reporter: { account: account.id, characterId: character.id, name: character.name },
          target: { account: target.playerId, characterId: target.characterId, name: target.characterName },
          kind: body?.["kind"] ?? "other",
          reason: body?.["reason"],
        });
        // the audit rule (or, for a name, the name check) runs after the reply: a judge may take seconds
        void moderation.afterReport(report, target.playerId).catch((error: unknown) => log(`[main] audit of ${target.playerId} failed: ${error instanceof Error ? error.message : String(error)}`));
        return send(res, 200, { ok: true, id: report.id, name: target.characterName });
      } catch (error) {
        if (error instanceof ReportError) throw new HttpError(error.status, error.message);
        throw error;
      }
    }
    if (p.startsWith("/party") || p.startsWith("/social") || p.startsWith("/guild")) {
      const account = await requireAccount(req);
      const body = method === "POST" ? ((await readJson(req)) as Record<string, unknown> | null) : null;
      const characterId = method === "POST" ? body?.["characterId"] : url.searchParams.get("characterId");
      const character = characterOf(account, characterId);
      const me: FriendRef = { playerId: account.id, characterId: character.id, characterName: character.name };
      owners.set(me.characterId, { playerId: account.id, name: character.name, saveId: character.saveId ?? account.id });
      const str = (key: string): string => (typeof body?.[key] === "string" ? (body[key] as string).trim() : "");
      /** The other character named in the request: by `name`, or by an id field. */
      const other = async (...keys: string[]): Promise<FriendRef> => {
        for (const key of keys) {
          const v = str(key);
          if (!v) continue;
          if (key === "name") return refByName(v);
          const ref = await refOf(v);
          if (ref) return ref;
        }
        throw new HttpError(400, `expected ${keys.join(" or ")}`);
      };
      const asFriendView = (list: FriendRef[]) => list.map(friendView);
      const joinParty = (party: Party): boolean => {
        if (party.members.size >= 8) throw new HttpError(400, "party is full");
        const previous = partyOf.get(me.characterId);
        if (previous && previous !== party) removeFromParty(me.characterId, me.characterName);
        party.members.add(me.characterId);
        partyOf.set(me.characterId, party);
        pushParty(me.characterId);
        invites.delete(me.characterId);
        tellParty(party, { kind: "party.joined", characterId: me.characterId, name: me.characterName }, me.characterId);
        // playing already, somewhere else than the leader: pull them over
        const leaderOn = registry.whereIs.get(party.leader);
        const leaderServer = leaderOn ? registry.servers.get(leaderOn) : undefined;
        return leaderServer && registry.free(leaderServer) > 0 ? moveCharacter(me.characterId, leaderServer, "party") : false;
      };
      const myParty = (): Party => {
        const party = partyOf.get(me.characterId);
        if (!party) throw new HttpError(400, "you are not in a party");
        return party;
      };
      const asLeader = (): Party => {
        const party = myParty();
        if (party.leader !== me.characterId) throw new HttpError(403, "only the party leader can do that");
        return party;
      };
      /** A block either way makes the other account unreachable, without saying which way. */
      const reachable = async (target: FriendRef): Promise<boolean> => {
        const mine = await social.load(account.id);
        if (isBlocked(mine, target.playerId)) return false;
        const theirs = await social.load(target.playerId);
        return !isBlocked(theirs, account.id);
      };
      try {
        // -- parties (session state) --
        if (p === "/party" && method === "GET") return send(res, 200, { party: await partyView(partyOf.get(me.characterId)), invites: (invites.get(me.characterId) ?? []).map((i) => ({ code: i.code, from: i.from.characterId, name: i.from.characterName })) });
        if (p === "/party/create" && method === "POST") {
          const existing = partyOf.get(me.characterId);
          if (existing) return send(res, 200, { party: await partyView(existing) });
          const party: Party = { code: partyCode(), leader: me.characterId, members: new Set([me.characterId]) };
          parties.set(party.code, party);
          partyOf.set(me.characterId, party);
          pushParty(me.characterId);
          return send(res, 200, { party: await partyView(party) });
        }
        if (p === "/party/join" && method === "POST") {
          const code = str("code").toUpperCase();
          const party = parties.get(code);
          if (!party) throw new HttpError(404, "no party with that code");
          const pulled = joinParty(party);
          return send(res, 200, { party: await partyView(party), pulled });
        }
        if (p === "/party/invite" && method === "POST") {
          const target = await other("name", "target");
          if (target.playerId === me.playerId) throw new HttpError(400, "that is you");
          if (!(await reachable(target))) throw new HttpError(400, `${target.characterName} cannot be invited`);
          let party = partyOf.get(me.characterId);
          if (!party) {
            party = { code: partyCode(), leader: me.characterId, members: new Set([me.characterId]) };
            parties.set(party.code, party);
            partyOf.set(me.characterId, party);
            pushParty(me.characterId);
          }
          if (party.leader !== me.characterId) throw new HttpError(403, "only the party leader can invite");
          if (party.members.has(target.characterId)) throw new HttpError(400, `${target.characterName} is already in the party`);
          if (party.members.size >= 8) throw new HttpError(400, "party is full");
          const list = invites.get(target.characterId) ?? [];
          if (!list.some((i) => i.code === party!.code)) list.push({ code: party.code, from: me, at: Date.now() });
          invites.set(target.characterId, list.slice(-8));
          notify(target.characterId, { kind: "party.invite", code: party.code, characterId: me.characterId, name: me.characterName });
          return send(res, 200, { party: await partyView(party), invited: target.characterName, online: presenceOf(target.characterId).online });
        }
        if (p === "/party/accept" && method === "POST") {
          const list = invites.get(me.characterId) ?? [];
          const code = str("code").toUpperCase();
          const invite = code ? list.find((i) => i.code === code) : list[list.length - 1];
          if (!invite) throw new HttpError(404, "no party invitation waiting");
          const party = parties.get(invite.code);
          if (!party) {
            invites.set(me.characterId, list.filter((i) => i !== invite));
            throw new HttpError(404, "that party is gone");
          }
          const pulled = joinParty(party);
          return send(res, 200, { party: await partyView(party), pulled });
        }
        if (p === "/party/decline" && method === "POST") {
          const list = invites.get(me.characterId) ?? [];
          const code = str("code").toUpperCase();
          const invite = code ? list.find((i) => i.code === code) : list[list.length - 1];
          if (!invite) throw new HttpError(404, "no party invitation waiting");
          invites.set(me.characterId, list.filter((i) => i !== invite));
          notify(invite.from.characterId, { kind: "party.declined", characterId: me.characterId, name: me.characterName });
          return send(res, 200, { declined: invite.code });
        }
        if (p === "/party/leave" && method === "POST") {
          removeFromParty(me.characterId, me.characterName);
          return send(res, 200, { party: null });
        }
        if (p === "/party/kick" && method === "POST") {
          const party = asLeader();
          const target = await other("name", "target");
          if (!party.members.has(target.characterId) || target.characterId === me.characterId) throw new HttpError(400, `${target.characterName} is not in your party`);
          removeFromParty(target.characterId, target.characterName);
          notify(target.characterId, { kind: "party.kicked", code: party.code });
          return send(res, 200, { party: await partyView(party) });
        }
        if (p === "/party/leader" && method === "POST") {
          const party = asLeader();
          const target = await other("name", "target");
          if (!party.members.has(target.characterId)) throw new HttpError(400, `${target.characterName} is not in your party`);
          party.leader = target.characterId;
          tellParty(party, { kind: "party.leader", characterId: target.characterId, name: target.characterName });
          return send(res, 200, { party: await partyView(party) });
        }
        // -- guilds (durable, per character) --
        const guildView = async (g: GuildRecord): Promise<unknown> => ({
          id: g.id,
          name: g.name,
          leader: g.leader,
          motd: g.motd,
          members: Object.values(g.members)
            .sort((a, b) => (a.rank === b.rank ? a.name.localeCompare(b.name) : a.rank === "leader" ? -1 : b.rank === "leader" ? 1 : a.rank === "officer" ? -1 : 1))
            .map((m) => ({ characterId: m.characterId, name: m.name, rank: m.rank, joinedAt: m.joinedAt, ...presenceOf(m.characterId) })),
        });
        const myGuild = async (): Promise<GuildRecord> => {
          const membership = guildOf.get(me.characterId);
          const g = membership ? await guilds.load(membership.id) : null;
          if (!g || !g.members[me.characterId]) {
            guildOf.delete(me.characterId);
            throw new HttpError(400, "you are not in a guild");
          }
          return g;
        };
        const myRank = (g: GuildRecord): GuildRank => g.members[me.characterId]?.rank ?? "member";
        const asOfficer = async (): Promise<GuildRecord> => {
          const g = await myGuild();
          if (myRank(g) === "member") throw new HttpError(403, "officers and the leader can do that");
          return g;
        };
        const asGuildLeader = async (): Promise<GuildRecord> => {
          const g = await myGuild();
          if (g.leader !== me.characterId) throw new HttpError(403, "only the guild leader can do that");
          return g;
        };
        if (p === "/guild" && method === "GET") {
          const membership = guildOf.get(me.characterId);
          const g = membership ? await guilds.load(membership.id) : null;
          return send(res, 200, { guild: g && g.members[me.characterId] ? await guildView(g) : null, invites: (guildInvites.get(me.characterId) ?? []).map((i) => ({ guild: i.guild, name: i.guildName, from: i.from.characterName })) });
        }
        if (p === "/guild/create" && method === "POST") {
          if (guildOf.has(me.characterId)) throw new HttpError(400, "leave your guild first");
          const g = await guilds.create(str("name"), me);
          setGuildOf(me.characterId, { id: g.id, name: g.name });
          return send(res, 200, { guild: await guildView(g) });
        }
        if (p === "/guild/invite" && method === "POST") {
          const g = await asOfficer();
          const target = await other("name", "target");
          if (g.members[target.characterId]) throw new HttpError(400, `${target.characterName} is already in the guild`);
          if (guildOf.has(target.characterId)) throw new HttpError(400, `${target.characterName} is in another guild`);
          if (!(await reachable(target))) throw new HttpError(400, `${target.characterName} cannot be invited`);
          const list = guildInvites.get(target.characterId) ?? [];
          if (!list.some((i) => i.guild === g.id)) list.push({ guild: g.id, guildName: g.name, from: me, at: Date.now() });
          guildInvites.set(target.characterId, list.slice(-8));
          notify(target.characterId, { kind: "guild.invite", guild: g.id, guildName: g.name, characterId: me.characterId, name: me.characterName });
          return send(res, 200, { invited: target.characterName, online: presenceOf(target.characterId).online });
        }
        if ((p === "/guild/accept" || p === "/guild/decline") && method === "POST") {
          const list = guildInvites.get(me.characterId) ?? [];
          const wanted = str("guild") || str("name");
          const invite = wanted ? list.find((i) => i.guild === wanted || i.guildName.toLowerCase() === wanted.toLowerCase()) : list[list.length - 1];
          if (!invite) throw new HttpError(404, "no guild invitation waiting");
          guildInvites.set(me.characterId, list.filter((i) => i !== invite));
          if (p === "/guild/decline") {
            notify(invite.from.characterId, { kind: "guild.declined", guild: invite.guild, guildName: invite.guildName, characterId: me.characterId, name: me.characterName });
            return send(res, 200, { declined: invite.guildName });
          }
          if (guildOf.has(me.characterId)) throw new HttpError(400, "leave your guild first");
          const g = await guilds.addMember(invite.guild, me);
          setGuildOf(me.characterId, { id: g.id, name: g.name });
          tellGuild(g, { kind: "guild.joined", guild: g.id, guildName: g.name, characterId: me.characterId, name: me.characterName }, me.characterId);
          return send(res, 200, { guild: await guildView(g) });
        }
        if (p === "/guild/leave" && method === "POST") {
          const g = await myGuild();
          const { guild, newLeader, disbanded } = await guilds.removeMember(g.id, me.characterId);
          setGuildOf(me.characterId, null);
          if (!disbanded) {
            tellGuild(guild, { kind: "guild.left", guild: g.id, guildName: g.name, characterId: me.characterId, name: me.characterName });
            if (newLeader) tellGuild(guild, { kind: "guild.leader", guild: g.id, guildName: g.name, characterId: newLeader.characterId, name: newLeader.name });
          }
          return send(res, 200, { guild: null, disbanded });
        }
        if (p === "/guild/kick" && method === "POST") {
          const g = await asOfficer();
          const target = await other("name", "target");
          const m = g.members[target.characterId];
          if (!m || target.characterId === me.characterId) throw new HttpError(400, `${target.characterName} is not in your guild`);
          if (!rankAbove(myRank(g), m.rank)) throw new HttpError(403, `you cannot remove ${m.name} (${m.rank})`);
          const { guild } = await guilds.removeMember(g.id, target.characterId);
          setGuildOf(target.characterId, null);
          notify(target.characterId, { kind: "guild.kicked", guild: g.id, guildName: g.name, characterId: me.characterId, name: me.characterName });
          tellGuild(guild, { kind: "guild.left", guild: g.id, guildName: g.name, characterId: target.characterId, name: m.name });
          return send(res, 200, { guild: await guildView(guild) });
        }
        if ((p === "/guild/promote" || p === "/guild/demote") && method === "POST") {
          const g = await asGuildLeader();
          const target = await other("name", "target");
          const m = g.members[target.characterId];
          if (!m || m.rank === "leader") throw new HttpError(400, `${target.characterName} is not a member you can change`);
          const rank = p === "/guild/promote" ? "officer" : "member";
          const guild = await guilds.setRank(g.id, target.characterId, rank);
          tellGuild(guild, { kind: rank === "officer" ? "guild.promoted" : "guild.demoted", guild: g.id, guildName: g.name, characterId: target.characterId, name: m.name });
          return send(res, 200, { guild: await guildView(guild) });
        }
        if (p === "/guild/leader" && method === "POST") {
          const g = await asGuildLeader();
          const target = await other("name", "target");
          const m = g.members[target.characterId];
          if (!m || target.characterId === me.characterId) throw new HttpError(400, `${target.characterName} is not in your guild`);
          const { guild } = await guilds.setLeader(g.id, target.characterId);
          tellGuild(guild, { kind: "guild.leader", guild: g.id, guildName: g.name, characterId: target.characterId, name: m.name });
          return send(res, 200, { guild: await guildView(guild) });
        }
        if (p === "/guild/motd" && method === "POST") {
          const g = await asOfficer();
          const guild = await guilds.setMotd(g.id, str("text"));
          tellGuild(guild, { kind: "guild.motd", guild: g.id, guildName: g.name, text: guild.motd });
          return send(res, 200, { guild: await guildView(guild) });
        }
        if (p === "/guild/disband" && method === "POST") {
          const g = await asGuildLeader();
          const guild = await guilds.disband(g.id);
          for (const m of Object.values(guild.members)) setGuildOf(m.characterId, null);
          tellGuild(guild, { kind: "guild.disbanded", guild: g.id, guildName: g.name });
          return send(res, 200, { guild: null });
        }
        // -- friends and blocks (durable, per account) --
        if (p === "/social" && method === "GET") {
          const mine = await social.load(account.id);
          return send(res, 200, {
            friends: asFriendView(mine.friends),
            incoming: mine.incoming.map((f) => ({ playerId: f.playerId, characterId: f.characterId, name: f.characterName })),
            outgoing: mine.outgoing.map((f) => ({ playerId: f.playerId, characterId: f.characterId, name: f.characterName })),
            blocked: mine.blocked.map((f) => ({ playerId: f.playerId, characterId: f.characterId, name: f.characterName })),
            party: await partyView(partyOf.get(me.characterId)),
            invites: (invites.get(me.characterId) ?? []).map((i) => ({ code: i.code, from: i.from.characterId, name: i.from.characterName })),
          });
        }
        if (p === "/social/friend/request" && method === "POST") {
          const target = await other("name", "friend");
          const outcome = await social.request(me, target);
          if (outcome === "sent") notifyAccount(target.playerId, { kind: "friend.request", characterId: me.characterId, name: me.characterName });
          if (outcome === "accepted") notifyAccount(target.playerId, { kind: "friend.accepted", characterId: me.characterId, name: me.characterName });
          return send(res, 200, { outcome, name: target.characterName });
        }
        if (p === "/social/friend/accept" && method === "POST") {
          const mine = await social.load(account.id);
          const from = str("name") || str("from") ? await other("name", "from") : mine.incoming[mine.incoming.length - 1];
          if (!from) throw new HttpError(404, "no friend request waiting");
          await social.accept(me, from);
          notifyAccount(from.playerId, { kind: "friend.accepted", characterId: me.characterId, name: me.characterName });
          return send(res, 200, { friend: from.characterName });
        }
        if (p === "/social/friend/decline" && method === "POST") {
          const mine = await social.load(account.id);
          const from = str("name") || str("from") ? await other("name", "from") : mine.incoming[mine.incoming.length - 1];
          if (!from) throw new HttpError(404, "no friend request waiting");
          await social.decline(me, from);
          return send(res, 200, { declined: from.characterName });
        }
        if (p === "/social/friend/remove" && method === "POST") {
          const friend = await other("name", "friend");
          await social.remove(me, friend);
          notifyAccount(friend.playerId, { kind: "friend.removed", characterId: me.characterId, name: me.characterName });
          return send(res, 200, { removed: friend.characterName });
        }
        if (p === "/social/block" && method === "POST") {
          const target = await other("name", "target");
          await social.block(me, target);
          // they are out of my party too, whichever of us leads
          const party = partyOf.get(me.characterId);
          if (party && party.members.has(target.characterId)) {
            if (party.leader === me.characterId) {
              removeFromParty(target.characterId, target.characterName);
              notify(target.characterId, { kind: "party.kicked", code: party.code });
            } else removeFromParty(me.characterId, me.characterName);
          }
          for (const c of onlineCharactersOf(account.id)) void pushBlocks(c.characterId);
          return send(res, 200, { blocked: target.characterName });
        }
        if (p === "/social/unblock" && method === "POST") {
          const target = await other("name", "target");
          const was = await social.unblock(me, target);
          for (const c of onlineCharactersOf(account.id)) void pushBlocks(c.characterId);
          return send(res, 200, { unblocked: was ? target.characterName : null });
        }
        if (p === "/social/travel" && method === "POST") {
          // go where a friend is: the layer they stand on, if it has room and is not an instance
          const friend = await other("name", "friend");
          const mine = await social.load(account.id);
          if (!mine.friends.some((f) => f.playerId === friend.playerId)) throw new HttpError(403, `${friend.characterName} is not your friend`);
          const where = friendView(mine.friends.find((f) => f.playerId === friend.playerId)!);
          if (!where.server) throw new HttpError(400, `${where.name} is not online`);
          const dest = registry.servers.get(where.server);
          if (!dest || dest.kind !== "layer") throw new HttpError(400, `${where.name} is somewhere you cannot follow`);
          if (registry.whereIs.get(me.characterId) === dest.id) return send(res, 200, { moved: false, server: dest.id, reason: "already there" });
          if (registry.free(dest) <= 0) throw new HttpError(400, "no room where they are");
          return send(res, 200, { moved: moveCharacter(me.characterId, dest, "friend"), server: dest.id });
        }
      } catch (error) {
        if (error instanceof SocialError) throw new HttpError(error.status, error.message);
        throw error;
      }
      throw new HttpError(404, "no such party, social or guild route");
    }

    if (p.startsWith("/admin/")) {
      requireAdmin(req);
      // names the judge leaned against below the threshold, or could not judge — accepted, for staff to look at
      if (p === "/admin/moderation/names" && method === "GET") return send(res, 200, { threshold: names.threshold, names: (await moderationQueue.load()).names });
      // -- the staff surface (docs/moderation.md §3) --
      if (p === "/admin/moderation/queue" && method === "GET") {
        const q = await moderationQueue.load();
        return send(res, 200, { escalations: q.escalations, names: q.names, nameThreshold: names.threshold, thresholds: moderation.thresholds, audit: moderation.rule });
      }
      if (p === "/admin/moderation/decide" && method === "POST") {
        const body = (await readJson(req)) as { auditId?: unknown; action?: unknown } | null;
        if (typeof body?.auditId !== "string") throw new HttpError(400, "auditId required");
        if (typeof body.action !== "string" || !(AUDIT_ACTIONS as readonly string[]).includes(body.action)) throw new HttpError(400, `action must be one of: ${AUDIT_ACTIONS.join(", ")}`);
        const { audit, sanction } = await staff(() => moderation.decide(body.auditId as string, body.action as AuditAction));
        return send(res, 200, { ok: true, audit, sanction });
      }
      if (p === "/admin/moderation/sanction" && (method === "POST" || method === "DELETE")) {
        const body = (await readJson(req)) as { account?: unknown; character?: unknown; characterId?: unknown; kind?: unknown; minutes?: unknown; reason?: unknown } | null;
        // the account by id, or through one of its characters (by id or name)
        let accountId = typeof body?.account === "string" ? body.account : "";
        let target: CharacterRecord | null = null;
        const who = typeof body?.characterId === "string" ? body.characterId : typeof body?.character === "string" ? body.character : "";
        if (who) {
          const found = (await opts.accounts.findCharacterById(who)) ?? (await opts.accounts.findCharacter(who));
          if (!found) throw new HttpError(404, `no character "${who}"`);
          accountId ||= found.account.id;
          if (found.account.id !== accountId) throw new HttpError(400, `${found.character.name} is not on account ${accountId}`);
          target = found.character;
        }
        if (!accountId || !(await opts.accounts.get(accountId))) throw new HttpError(404, "no such account (give account, or characterId / character)");
        const kind = body?.kind;
        if (typeof kind !== "string" || !(SANCTION_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, `kind must be one of: ${SANCTION_KINDS.join(", ")}`);
        if (method === "DELETE") return send(res, 200, { ok: true, lifted: await staff(() => moderation.lift(accountId, kind as SanctionKind)) });
        const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
        if (!reason) throw new HttpError(400, "reason required (the player reads it)");
        const sanction = await staff(() =>
          moderation.sanction(accountId, {
            kind: kind as SanctionKind,
            reason,
            ...(typeof body?.minutes === "number" ? { minutes: body.minutes } : {}),
            ...(target ? { characterId: target.id, name: target.name } : {}),
          }),
        );
        return send(res, 200, { ok: true, sanction });
      }
      const accountRoute = /^\/admin\/moderation\/account\/([A-Za-z0-9_.-]{1,64})$/.exec(p);
      if (accountRoute && method === "GET") {
        const account = await opts.accounts.get(accountRoute[1]!);
        if (!account) throw new HttpError(404, "no such account");
        const record = await reports.load(account.id);
        return send(res, 200, {
          account: { id: account.id, name: account.name, createdAt: account.createdAt, characters: account.characters.map((c) => ({ id: c.id, name: c.name, ...(c.deletedAt ? { deletedAt: c.deletedAt } : {}) })) },
          active: activeSanctions(record, Date.now()),
          online: onlineCharactersOf(account.id),
          record,
        });
      }
      if (p === "/admin/status" && method === "GET") {
        return send(res, 200, {
          scene: world.scene,
          experienceId: opts.experienceId,
          servers: registry.summary(),
          booting: [...booting.keys()],
          children: supervisor?.list() ?? [],
          parties: [...parties.values()].map((x) => ({ code: x.code, leader: x.leader, members: [...x.members] })),
          characters: Object.fromEntries([...registry.whereIs]),
          recipes: [...recipes.keys()],
          zones: zoned
            ? {
                count: regions.length,
                spawnZone: opts.zones?.spawnZone ?? null,
                caps: Object.fromEntries(regions.map((r) => [r.id, zoneCapOf(r.id)])),
                population: Object.fromEntries(
                  regions.map((r) => [r.id, registry.layersFor(world.scene).reduce((n, s) => n + registry.playersInZone(s, r.id), 0)]),
                ),
              }
            : null,
        });
      }
      if (p === "/admin/zones" && method === "POST") {
        // hand a layer a hosted set by hand: {"id":"layer-2","hosted":["fenrun-vale"]} or "all"
        const body = (await readJson(req)) as { id?: unknown; hosted?: unknown } | null;
        const server = typeof body?.id === "string" ? registry.servers.get(body.id) : undefined;
        if (!server) throw new HttpError(404, "no such server");
        const hosted: HostedZones =
          body!.hosted === "all" ? "all" : Array.isArray(body!.hosted) ? body!.hosted.filter((z): z is string => typeof z === "string" && regions.some((r) => r.id === z)) : [];
        if (hosted !== "all" && hosted.length === 0) throw new HttpError(400, "hosted: \"all\" or a list of known zone ids");
        registry.setHosted(server.id, hosted);
        return send(res, 200, { ok: sendTo(server.id, { t: "zones", hosted }), id: server.id, hosted });
      }
      if (p === "/admin/transfer" && method === "POST") {
        const body = (await readJson(req)) as { characterId?: unknown; srv?: unknown; scene?: unknown; party?: unknown } | null;
        if (typeof body?.characterId !== "string") throw new HttpError(400, "characterId required");
        const target: TransferTarget =
          typeof body.scene === "string"
            ? { kind: "instance", scene: body.scene, ...(body.party === true ? { party: true } : {}) }
            : { kind: "layer", ...(typeof body.srv === "string" ? { layerId: body.srv } : {}), ...(body.party === true ? { party: true } : {}) };
        const dest = await resolveTarget(body.characterId, target);
        const sent = moveCharacter(body.characterId, dest, "admin");
        if (target.party) for (const m of partyMembersOf(body.characterId)) if (m !== body.characterId) moveCharacter(m, dest, "party");
        return send(res, 200, { ok: sent, srv: dest.id, url: dest.url });
      }
      if (p === "/admin/instance" && method === "POST") {
        const body = (await readJson(req)) as { scene?: unknown; characterIds?: unknown; key?: unknown } | null;
        if (typeof body?.scene !== "string") throw new HttpError(400, "scene required");
        const ids = Array.isArray(body.characterIds) ? body.characterIds.filter((x): x is string => typeof x === "string") : [];
        const key = typeof body.key === "string" ? body.key : (ids[0] ?? `admin-${Date.now()}`);
        const dest = await ensureInstance(body.scene, key);
        const moved = ids.filter((id) => moveCharacter(id, dest, "instance"));
        return send(res, 200, { ok: true, srv: dest.id, url: dest.url, moved });
      }
      if (p === "/admin/drain" && method === "POST") {
        const body = (await readJson(req)) as { id?: unknown } | null;
        const server = typeof body?.id === "string" ? registry.servers.get(body.id) : undefined;
        if (!server) throw new HttpError(404, "no such server");
        server.draining = true;
        server.accepting = false;
        return send(res, 200, { ok: sendTo(server.id, { t: "drain" }) });
      }
      if (p === "/admin/scale" && method === "POST") {
        const body = (await readJson(req)) as { layers?: unknown } | null;
        const want = typeof body?.layers === "number" ? Math.floor(body.layers) : NaN;
        if (!Number.isFinite(want) || want < 1) throw new HttpError(400, "layers: a positive number");
        const have = registry.layersFor(world.scene).length + [...booting.keys()].filter((id) => id.startsWith("layer-")).length;
        const started: string[] = [];
        for (let i = have; i < Math.min(want, world.max); i++) {
          const id = `layer-${++layerCounter}`;
          if (!supervisor) break;
          void waitForRegister(id).catch(() => undefined);
          supervisor.spawn("layer", world.scene, id, { cap: world.cap, persist: false });
          started.push(id);
        }
        return send(res, 200, { ok: true, started, have: have + started.length, max: world.max });
      }
      if (p === "/admin/terraform" && method === "POST") {
        const body = (await readJson(req)) as { edits?: unknown } | null;
        if (!body || !Array.isArray(body.edits) || body.edits.length === 0) throw new HttpError(400, "expected { edits: RecipeEdit[] }");
        const primary = registry.layersFor(world.scene).sort((a, b) => a.registeredAt - b.registeredAt)[0];
        if (!primary) throw new HttpError(503, "no layer is running");
        const requestId = randomBytes(4).toString("hex");
        const result = await new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => {
            terraformWaiters.delete(requestId);
            reject(new HttpError(504, "the layer did not answer"));
          }, 30_000);
          terraformWaiters.set(requestId, { resolve, reject, timer });
          if (!sendTo(primary.id, { t: "terraform", requestId, edits: body.edits as unknown[] })) {
            clearTimeout(timer);
            terraformWaiters.delete(requestId);
            reject(new HttpError(503, "the primary layer is not connected"));
          }
        });
        return send(res, 200, { ok: true, via: primary.id, ...(result as object) });
      }
      if (p === "/admin/recipe" && method === "POST") {
        const body = (await readJson(req)) as { id?: unknown; recipe?: unknown } | null;
        if (typeof body?.id !== "string" || !body.recipe || typeof body.recipe !== "object") throw new HttpError(400, "expected { id, recipe }");
        const recipe = body.recipe as WorldRecipe;
        recipes.set(body.id, recipe);
        persistRecipe(body.id, recipe);
        let fanned = 0;
        for (const id of sockets.keys()) if (sendTo(id, { t: "recipe", id: body.id, recipe })) fanned++;
        return send(res, 200, { ok: true, fanned });
      }
      // the item log: GET /admin/items-log/:characterId?item=…, GET /admin/moderation/dupes, POST …/dupes/:id/close
      const itemsAnswer = await itemsLog.admin(method, p, url.searchParams);
      if (itemsAnswer) return send(res, itemsAnswer.status, itemsAnswer.body);
      throw new HttpError(404, `no such admin route: ${method} ${p}`);
    }
    throw new HttpError(404, "not found");
  };

  const httpServer = http.createServer((req, res) => {
    void route(req, res).catch((error: unknown) => {
      if (error instanceof HttpError) send(res, error.status, { ok: false, error: error.message });
      else {
        log(`[main] ${req.method} ${req.url} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== CLUSTER_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const state: { id: string | null } = { id: null };
      ws.on("message", (raw) => {
        const msg = parseClusterMessage<LayerToMain>(raw.toString());
        if (msg) {
          try {
            onLayerMessage(state, ws, msg);
          } catch (error) {
            log(`[main] cluster message from "${state.id ?? "?"}" failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      });
      ws.on("close", () => {
        if (state.id && sockets.get(state.id)?.socket === ws) {
          sockets.delete(state.id);
          registry.unregister(state.id);
          log(`[main] "${state.id}" disconnected`);
        }
      });
      ws.on("error", () => undefined);
    });
  });

  // -- autoscale + retire ------------------------------------------------------------------

  const scaleTick = (): void => {
    if (closed || !supervisor) return;
    const layers = registry.layersFor(world.scene);
    const bootingLayers = [...booting.keys()].filter((id) => id.startsWith("layer-")).length;
    const total = layers.length + bootingLayers;
    if (total < world.min) {
      void spawnLayer().catch((error: unknown) => log(`[main] layer boot failed: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    if (bootingLayers === 0 && total < world.max && registry.freeSlots(world.scene) < world.headroom) {
      void spawnLayer().catch((error: unknown) => log(`[main] layer boot failed: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    const idle = registry.retirable(world.scene, world.retireAfterMs, world.min);
    if (idle) {
      // never retire the only whole-world host: somebody has to take the quiet zones
      if (idle.hosted === "all" && !layers.some((s) => s.id !== idle.id && s.hosted === "all" && !s.draining)) {
        const heir = layers.filter((s) => s.id !== idle.id && !s.draining && !zoneLoaded.has(s.id)).sort((a, b) => a.registeredAt - b.registeredAt)[0];
        if (!heir) return; // only zone copies left: the whole-world layer stays
        registry.setHosted(heir.id, "all");
        sendTo(heir.id, { t: "zones", hosted: "all" });
        log(`[main] "${heir.id}" now hosts all zones (taking over from idle "${idle.id}")`);
      }
      idle.draining = true;
      idle.accepting = false;
      log(`[main] retiring idle layer "${idle.id}"`);
      sendTo(idle.id, { t: "drain" });
    }
  };
  const scaleTimer = setInterval(scaleTick, (opts.scaleEverySeconds ?? 5) * 1000);

  const host = opts.host ?? "0.0.0.0";
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port ?? 8780, host, () => resolve());
  });
  const address = httpServer.address();
  const port = typeof address === "object" && address !== null ? address.port : (opts.port ?? 8780);
  log(`[main] listening on http://${host}:${port}  (cluster: ws://${host}:${port}${CLUSTER_PATH}, admin: /admin/status)`);
  setTimeout(scaleTick, 10); // bring the pool to `min` right away

  return {
    port,
    url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`,
    registry,
    itemsLog,
    moderation,
    close: async () => {
      closed = true;
      clearInterval(scaleTimer);
      evidenceRequests.dispose();
      for (const w of booting.values()) {
        clearTimeout(w.timer);
        w.reject(new Error("main closing"));
      }
      booting.clear();
      for (const { socket } of sockets.values()) {
        try {
          socket.close(1001, "main closing");
        } catch {
          // ignore
        }
      }
      wss.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
