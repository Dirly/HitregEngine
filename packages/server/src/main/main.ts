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
import type { PlayerDataBackend, WorldRecipe } from "@hitreg/core";
import { ServerRegistry, type ServerEntry } from "./registry.js";
import type { Supervisor } from "./supervisor.js";
import { signSession, signTicket, verifySession } from "../cluster/ticket.js";
import {
  ACCOUNT_NAME,
  CHARACTER_NAME,
  MAX_CHARACTERS,
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
  type LayerToMain,
  type MainToLayer,
  type TransferTarget,
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
  /** Recipe files by world id, so main can persist a terraformed recipe (from `loadContent().worldFiles`). */
  worldFiles?: Map<string, string>;
  ticketTtlSeconds?: number;
  sessionTtlSeconds?: number;
  /** Told to layers: seconds between periodic saves (default 30). */
  commitEverySeconds?: number;
  /** How long to wait for a spawned child to register (default 45 s). */
  bootTimeoutSeconds?: number;
  /** Autoscale/retire loop period (default 5 s; tests shorten). */
  scaleEverySeconds?: number;
  log?: (line: string) => void;
}

export interface MainHandle {
  port: number;
  url: string;
  registry: ServerRegistry;
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
  const registry = new ServerRegistry();
  const sockets = new Map<string, LayerSocket>();
  const parties = new Map<string, Party>();
  const partyOf = new Map<string, Party>();
  /** characterId → owner, learned from /play (a ticket needs the account id). */
  const owners = new Map<string, { playerId: string; name: string }>();
  const recipes = new Map<string, WorldRecipe>();
  const booting = new Map<string, Waiter<ServerEntry>>();
  const terraformWaiters = new Map<string, Waiter<unknown>>();
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

  const spawnLayer = (): Promise<ServerEntry> => {
    if (!supervisor) return Promise.reject(new Error("no supervisor: start another layer externally"));
    const id = `layer-${++layerCounter}`;
    const wait = waitForRegister(id);
    supervisor.spawn("layer", world.scene, id, { cap: world.cap, persist: false });
    return wait;
  };

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

  /** Tell the server a character is on to hand it to `dest`. */
  const moveCharacter = (characterId: string, dest: ServerEntry, reason: string): boolean => {
    const on = registry.whereIs.get(characterId);
    if (!on || on === dest.id) return false;
    return sendTo(on, { t: "transfer.begin", characterId, srv: dest.id, url: dest.url, reason });
  };

  const placeOrGrow = async (characterId: string, exclude?: string): Promise<ServerEntry> => {
    const attempt = (): ServerEntry | null => {
      const p = registry.place({ scene: world.scene, characterId, partyMembers: partyMembersOf(characterId) });
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
      await spawnLayer().catch((error: unknown) => log(`[main] layer boot failed: ${error instanceof Error ? error.message : String(error)}`));
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
    if (target.layerId) {
      const s = registry.servers.get(target.layerId);
      if (!s) throw new HttpError(404, `no server "${target.layerId}"`);
      return s;
    }
    return placeOrGrow(characterId, registry.whereIs.get(characterId));
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
        registry.reserve(dest.id, call.characterId, call.playerId, call.name);
        return {
          ticket: signTicket(opts.secret, { sub: call.playerId, chr: call.characterId, name: call.name, srv: call.srv, rev: call.rev, reason: call.reason, ttlSeconds: ticketTtl }),
        };
      }
      case "transfer.request": {
        const dest = await resolveTarget(call.characterId, call.target);
        if (call.target.party) {
          for (const member of partyMembersOf(call.characterId)) {
            if (member !== call.characterId) moveCharacter(member, dest, "party");
          }
        }
        return { srv: dest.id, url: dest.url };
      }
      case "recipe.changed": {
        recipes.set(call.id, call.recipe);
        persistRecipe(call.id, call.recipe);
        for (const id of sockets.keys()) if (id !== layerId) sendTo(id, { t: "recipe", id: call.id, recipe: call.recipe });
        return { fanned: sockets.size - 1 };
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
      const entry = registry.register({ id: msg.id, kind: msg.kind, url: msg.url, scene: msg.scene, cap: msg.cap, ...(msg.instanceOf ? { instanceOf: msg.instanceOf } : {}) });
      const primary = registry.layersFor(world.scene).sort((a, b) => a.registeredAt - b.registeredAt)[0]?.id === msg.id;
      socket.send(JSON.stringify({ t: "registered", id: msg.id, experienceId: opts.experienceId, primary, commitEverySeconds: opts.commitEverySeconds ?? 30 } satisfies MainToLayer));
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
        return;
      case "player.left":
        registry.left(id, msg.characterId);
        return;
      case "transfer.failed":
        log(`[main] transfer of ${msg.characterId} from "${id}" failed: ${msg.reason}`);
        return;
      case "chat":
        // zone/global lines cross layers: every other copy of the world hears
        // what this one said (the origin already delivered it locally)
        for (const other of sockets.keys()) if (other !== id) sendTo(other, { t: "chat", line: msg.line, origin: id });
        return;
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

  const requireAccount = async (req: http.IncomingMessage): Promise<AccountRecord> => {
    const token = bearer(req);
    if (!token) throw new HttpError(401, "sign in first");
    const v = verifySession(opts.secret, token);
    if (!v.ok) throw new HttpError(401, v.reason);
    const account = await opts.accounts.get(v.sub);
    if (!account) throw new HttpError(401, "unknown account");
    return account;
  };

  const requireAdmin = (req: http.IncomingMessage): void => {
    if (bearer(req) !== adminToken) throw new HttpError(401, "admin token required");
  };

  const characterOf = (account: AccountRecord, characterId: unknown): CharacterRecord => {
    if (typeof characterId !== "string") throw new HttpError(400, "characterId required");
    const c = account.characters.find((x) => x.id === characterId);
    if (!c) throw new HttpError(404, "no such character on this account");
    return c;
  };

  const sessionFor = (account: AccountRecord): unknown => ({
    session: signSession(opts.secret, account.id, sessionTtl),
    account: { id: account.id, name: account.name },
    characters: account.characters,
  });

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
      res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
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
      return send(res, 200, sessionFor(account));
    }
    if (p === "/characters" && method === "GET") {
      const account = await requireAccount(req);
      return send(res, 200, { characters: account.characters });
    }
    if (p === "/characters" && method === "POST") {
      const account = await requireAccount(req);
      const body = (await readJson(req)) as { name?: unknown } | null;
      const name = typeof body?.name === "string" ? body.name.trim() : "";
      if (!CHARACTER_NAME.test(name)) throw new HttpError(400, "character name: 3-20 letters");
      if (account.characters.length >= MAX_CHARACTERS) throw new HttpError(400, `at most ${MAX_CHARACTERS} characters`);
      const character: CharacterRecord = { id: newId("chr"), name, createdAt: new Date().toISOString() };
      account.characters.push(character);
      await opts.accounts.update(account);
      return send(res, 200, { character, characters: account.characters });
    }
    if (p === "/play" && method === "POST") {
      const account = await requireAccount(req);
      const body = (await readJson(req)) as { characterId?: unknown } | null;
      const character = characterOf(account, body?.characterId);
      owners.set(character.id, { playerId: account.id, name: character.name });
      const server = await placeOrGrow(character.id);
      registry.reserve(server.id, character.id, account.id, character.name);
      const ticket = signTicket(opts.secret, { sub: account.id, chr: character.id, name: character.name, srv: server.id, reason: "join", ttlSeconds: ticketTtl });
      return send(res, 200, { url: server.url, ticket, server: server.id, scene: server.scene });
    }
    if (p.startsWith("/party")) {
      const account = await requireAccount(req);
      const body = method === "POST" ? ((await readJson(req)) as { characterId?: unknown; code?: unknown } | null) : null;
      const characterId = method === "POST" ? body?.characterId : url.searchParams.get("characterId");
      const character = characterOf(account, characterId);
      const view = (party: Party | undefined): unknown =>
        party ? { code: party.code, leader: party.leader, members: [...party.members].map((id) => ({ characterId: id, server: registry.whereIs.get(id) ?? null })) } : null;
      if (p === "/party" && method === "GET") return send(res, 200, { party: view(partyOf.get(character.id)) });
      if (p === "/party/create" && method === "POST") {
        const existing = partyOf.get(character.id);
        if (existing) return send(res, 200, { party: view(existing) });
        const party: Party = { code: partyCode(), leader: character.id, members: new Set([character.id]) };
        parties.set(party.code, party);
        partyOf.set(character.id, party);
        return send(res, 200, { party: view(party) });
      }
      if (p === "/party/join" && method === "POST") {
        const code = typeof body?.code === "string" ? body.code.toUpperCase().trim() : "";
        const party = parties.get(code);
        if (!party) throw new HttpError(404, "no party with that code");
        if (party.members.size >= 8) throw new HttpError(400, "party is full");
        const previous = partyOf.get(character.id);
        if (previous && previous !== party) {
          previous.members.delete(character.id);
          if (previous.members.size === 0) parties.delete(previous.code);
        }
        party.members.add(character.id);
        partyOf.set(character.id, party);
        // playing already, somewhere else than the leader: pull them over
        const leaderOn = registry.whereIs.get(party.leader);
        const leaderServer = leaderOn ? registry.servers.get(leaderOn) : undefined;
        let pulled = false;
        if (leaderServer && registry.free(leaderServer) > 0) pulled = moveCharacter(character.id, leaderServer, "party");
        return send(res, 200, { party: view(party), pulled });
      }
      if (p === "/party/leave" && method === "POST") {
        const party = partyOf.get(character.id);
        if (party) {
          party.members.delete(character.id);
          partyOf.delete(character.id);
          if (party.members.size === 0) parties.delete(party.code);
          else if (party.leader === character.id) party.leader = [...party.members][0]!;
        }
        return send(res, 200, { party: null });
      }
      throw new HttpError(404, "no such party route");
    }

    if (p.startsWith("/admin/")) {
      requireAdmin(req);
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
        });
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
    close: async () => {
      closed = true;
      clearInterval(scaleTimer);
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
