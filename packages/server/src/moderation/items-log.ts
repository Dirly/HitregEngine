/**
 * The item log (docs/moderation.md §4): what a character HAS and LOSES, never
 * what drops. "If they don't get it, they don't get it" (ruling) — an item
 * enters the log the moment it is on a character (sheet or vault) and leaves
 * it the moment it is not.
 *
 * Three parts, one file:
 *
 *  - `ItemsLogCollector` (every game server). Detection is GENERIC: it watches
 *    the netState the authority already writes — `character/<bodyId>` (the
 *    sheet) and `vault/<bodyId>` — and diffs each tracked character's
 *    holdings. No game script calls anything; any game whose inventory is the
 *    core sheet gets the log. Unique items (item `stack` 1: every piece of
 *    gear) are followed by INSTANCE: the collector stamps a cluster-wide id
 *    (`iid`, core `itemStackSchema`) on any unique stack that lacks one, and
 *    the id then travels with the instance like its wear and twists. Stackable
 *    goods are followed by count per item id (`instanceId: null`).
 *    Where an item went or came from is read off the same state in the same
 *    pass: into the character's own corpse = `lost` "death", into a dropped bag
 *    = `lost` "dropped", onto another tracked character = "to/from <id>".
 *
 *  - The batches ride the cluster link as their own small RPC (`items.log`),
 *    sent from inside the layer's commit (serve.ts wraps the persistence hook),
 *    so they go out with every periodic save, every leave and BEFORE a transfer
 *    ticket is minted (one socket, in order: main has a character's last entries
 *    before the next layer can report them). A failed send is kept and re-sent
 *    with the next flush; each batch has an id, so a resend after a lost answer
 *    is applied once.
 *
 *  - `ItemsLogMain` (main): the append-only store per CHARACTER (player data
 *    scope `{ playerId: <characterId> }`, namespace `items-log`, rotated), the
 *    dupe flag (an in-memory, bounded index instanceId → character), the staff
 *    list and the lookup for claims. It never punishes: a dupe opens a case.
 */

import type { PlayerDataBackend, PlayerDataRecord, PlayerDataScope } from "@hitreg/core";

// -- the entry --------------------------------------------------------------------------------------------

/**
 * What happened to an item, from the character's side. Arrivals: `pickup`, `trade_in`, `restored` (staff or a
 * claim gave it back). Leaves: `lost` (death, dropped, sold/consumed/destroyed — `detail` says which when the
 * server could see it), `trade_out`. Moves that keep it: `equip`, `unequip`, `vault_in`, `vault_out`.
 * `trade_in`/`trade_out` are defined for a trade window; nothing emits them yet (the engine has no trade —
 * looting a body is `lost` / `pickup` with the other character in `detail`).
 */
export const ITEM_LOG_EVENTS = ["equip", "unequip", "pickup", "lost", "vault_in", "vault_out", "trade_in", "trade_out", "restored"] as const;
export type ItemLogEvent = (typeof ITEM_LOG_EVENTS)[number];

const ARRIVALS: ReadonlySet<ItemLogEvent> = new Set(["pickup", "trade_in", "restored"]);
const LEAVES: ReadonlySet<ItemLogEvent> = new Set(["lost", "trade_out"]);

export interface ItemLogEntry {
  t: ItemLogEvent;
  /** The unique item's `iid`; null for stackable goods (followed by count). */
  instanceId: string | null;
  itemId: string;
  count: number;
  /** The server that saw it (`main` for a restore). */
  server: string;
  /** Wall-clock ms. */
  at: number;
  /** Where it went / came from when the server could tell: "death", "dropped", "to <characterId>", "from <characterId>", "worn", … */
  detail?: string;
}

/** One character's entries in one flush. `holding` (first sight on a server) lists every iid it holds right now. */
export interface ItemLogBatch {
  characterId: string;
  entries: ItemLogEntry[];
  holding?: string[];
}

/** The `items.log` RPC body: a layer's flush. `batchId` makes a resend idempotent. */
export interface ItemLogFlush {
  batchId: string;
  batches: ItemLogBatch[];
}

// -- the collector (game servers) ------------------------------------------------------------------------------

/** The part of a NetStateStore the collector reads and writes. */
export interface ItemsLogNetState {
  get(key: string): unknown;
  set(key: string, value: unknown): boolean;
  keys(prefix?: string): string[];
  onChange(cb: (key: string, value: unknown) => void): () => void;
}

export interface ItemsLogCollectorOptions {
  netState: ItemsLogNetState;
  /** Item definition by id; only `stack` is read (1 = unique). Unknown items are followed as goods and never stamped. */
  catalog: (itemId: string) => { stack?: number } | undefined;
  /** This server's id (written on every entry). */
  server: string;
  /** Send one flush to main (`link.rpc({ op: "items.log", ...flush })`). A rejection keeps the entries for the next flush. */
  send: (flush: ItemLogFlush) => Promise<unknown>;
  /** Wall clock (tests replace it). */
  clock?: () => number;
  /** Mint an iid (default: random, 16 hex chars prefixed by the server id). */
  mintId?: () => string;
  /** Entries held while main is unreachable before the oldest are dropped (loudly). Default 20000. */
  maxPending?: number;
  log?: (line: string) => void;
}

interface Holdings {
  /** iid → copies (1, unless something duplicated it) and whether worn. */
  unique: Map<string, { itemId: string; count: number; worn: boolean }>;
  /** itemId → total quantity of stacks without an iid. */
  goods: Map<string, number>;
}

interface Tracked {
  bodyId: string;
  characterId: string;
  sheet: unknown;
  vault: unknown;
  prevSheet: Holdings | null;
  prevVault: Holdings | null;
}

const emptyHoldings = (): Holdings => ({ unique: new Map(), goods: new Map() });

type Stackish = { itemId?: unknown; qty?: unknown; iid?: unknown; container?: unknown };

function holdingsOf(stacks: Iterable<Stackish | null | undefined>, wornOf: (s: Stackish) => boolean): Holdings {
  const h = emptyHoldings();
  for (const s of stacks) {
    if (!s || typeof s.itemId !== "string") continue;
    const qty = typeof s.qty === "number" && s.qty > 0 ? s.qty : 1;
    if (typeof s.iid === "string" && s.iid.length > 0) {
      const cur = h.unique.get(s.iid);
      if (cur) cur.count += 1;
      else h.unique.set(s.iid, { itemId: s.itemId, count: 1, worn: wornOf(s) });
    } else {
      h.goods.set(s.itemId, (h.goods.get(s.itemId) ?? 0) + qty);
    }
  }
  return h;
}

function sheetItems(sheet: unknown): Record<string, Stackish> | null {
  if (!sheet || typeof sheet !== "object") return null;
  const items = (sheet as { items?: unknown }).items;
  return items && typeof items === "object" ? (items as Record<string, Stackish>) : null;
}

function vaultItems(vault: unknown): Stackish[] {
  const items = vault && typeof vault === "object" ? (vault as { items?: unknown }).items : undefined;
  return Array.isArray(items) ? (items as Stackish[]) : [];
}

/** A pending per-character entry before the cross-character pass fills `detail`. */
interface Draft {
  characterId: string;
  bodyId: string;
  entry: ItemLogEntry;
}

/**
 * Watches the sheets and vaults of the characters it is told to track and turns
 * every change into log entries. Changes are processed once per synchronous run
 * (a microtask), so a reducer that writes the sheet and then the vault (a
 * deposit) is seen as one move, and two sheets written by one hand-over are
 * matched to each other.
 */
export class ItemsLogCollector {
  private readonly tracked = new Map<string, Tracked>();
  private readonly dirty = new Set<string>();
  private scheduled = false;
  private readonly pending = new Map<string, ItemLogEntry[]>();
  private readonly holding = new Map<string, string[]>();
  private outbox: ItemLogFlush[] = [];
  private batchSeq = 0;
  private readonly off: () => void;
  private readonly clock: () => number;
  private readonly mintId: () => string;
  private readonly log: (line: string) => void;
  private stampWarned = false;

  constructor(private readonly opts: ItemsLogCollectorOptions) {
    this.clock = opts.clock ?? Date.now;
    this.mintId = opts.mintId ?? (() => `${opts.server.slice(0, 24)}-${randomHex(16)}`);
    this.log = opts.log ?? ((line) => console.warn(line));
    this.off = opts.netState.onChange((key, value) => this.changed(key, value));
  }

  /** Start following a character's body. Its current holdings are the baseline (no entries); main gets them as `holding`. */
  track(bodyId: string, characterId: string): void {
    const t: Tracked = {
      bodyId,
      characterId,
      sheet: this.opts.netState.get(`character/${bodyId}`),
      vault: this.opts.netState.get(`vault/${bodyId}`),
      prevSheet: null,
      prevVault: null,
    };
    this.tracked.set(bodyId, t);
    this.markDirty(bodyId);
  }

  /** Stop following a body (it left or transferred): its last changes are processed and flushed first. */
  untrack(bodyId: string): void {
    this.process();
    this.tracked.delete(bodyId);
    void this.flush();
  }

  /** Characters currently followed (diagnostics). */
  get size(): number {
    return this.tracked.size;
  }

  /** Entries waiting to be sent, all characters (diagnostics, tests). */
  pendingEntries(characterId?: string): ItemLogEntry[] {
    if (characterId !== undefined) return [...(this.pending.get(characterId) ?? [])];
    return [...this.pending.values()].flat();
  }

  dispose(): void {
    this.off();
    this.tracked.clear();
  }

  private changed(key: string, value: unknown): void {
    const slash = key.indexOf("/");
    if (slash < 0) return;
    const ns = key.slice(0, slash);
    if (ns !== "character" && ns !== "vault") return;
    const t = this.tracked.get(key.slice(slash + 1));
    // a delete is the body being cleared away (leave), never a loss: keep the last value seen
    if (!t || value === undefined) return;
    if (ns === "character") t.sheet = value;
    else t.vault = value;
    this.markDirty(t.bodyId);
  }

  private markDirty(bodyId: string): void {
    this.dirty.add(bodyId);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.process();
    });
  }

  /** Stamp an iid on every unique stack that has none; writes the sheet back once. Returns the sheet to diff. */
  private stamp(t: Tracked): unknown {
    const items = sheetItems(t.sheet);
    if (!items) return t.sheet;
    let next: Record<string, Stackish> | null = null;
    for (const [uid, s] of Object.entries(items)) {
      if (typeof s.itemId !== "string" || (typeof s.iid === "string" && s.iid)) continue;
      const def = this.opts.catalog(s.itemId);
      if (!def || (def.stack ?? 1) > 1) continue;
      next ??= { ...items };
      next[uid] = { ...s, iid: this.mintId() };
    }
    if (!next) return t.sheet;
    const sheet = { ...(t.sheet as object), items: next };
    if (this.opts.netState.set(`character/${t.bodyId}`, sheet)) {
      // the store keeps its own parsed copy; read it back so the next diff starts from what is really there
      t.sheet = this.opts.netState.get(`character/${t.bodyId}`) ?? sheet;
    } else if (!this.stampWarned) {
      this.stampWarned = true;
      this.log(`[items-log] could not stamp instance ids on ${t.characterId}'s sheet — unique items followed by count only`);
    }
    return t.sheet;
  }

  /** Diff every dirty body now (also run by `flush`). */
  process(): void {
    if (this.dirty.size === 0) return;
    const bodies = [...this.dirty];
    this.dirty.clear();
    const drafts: Draft[] = [];
    for (const bodyId of bodies) {
      const t = this.tracked.get(bodyId);
      if (!t) continue;
      const sheet = this.stamp(t);
      const items = sheetItems(sheet);
      if (!items) continue;
      const nowSheet = holdingsOf(Object.values(items), (s) => s.container === undefined);
      const nowVault = holdingsOf(vaultItems(t.vault), () => false);
      if (!t.prevSheet || !t.prevVault) {
        t.prevSheet = nowSheet;
        t.prevVault = nowVault;
        this.holding.set(t.characterId, [...new Set([...nowSheet.unique.keys(), ...nowVault.unique.keys()])]);
        continue;
      }
      this.diff(t, t.prevSheet, t.prevVault, nowSheet, nowVault, drafts);
      t.prevSheet = nowSheet;
      t.prevVault = nowVault;
    }
    this.annotate(drafts);
    for (const d of drafts) {
      const list = this.pending.get(d.characterId) ?? [];
      list.push(d.entry);
      this.pending.set(d.characterId, list);
    }
  }

  private diff(t: Tracked, s0: Holdings, v0: Holdings, s1: Holdings, v1: Holdings, out: Draft[]): void {
    const at = this.clock();
    const server = this.opts.server;
    const push = (e: Omit<ItemLogEntry, "server" | "at">): void => {
      out.push({ characterId: t.characterId, bodyId: t.bodyId, entry: { ...e, server, at } });
    };
    // unique items, by instance
    const iids = new Set([...s0.unique.keys(), ...v0.unique.keys(), ...s1.unique.keys(), ...v1.unique.keys()]);
    for (const iid of iids) {
      const a = s0.unique.get(iid), b = s1.unique.get(iid), va = v0.unique.get(iid), vb = v1.unique.get(iid);
      const itemId = (b ?? vb ?? a ?? va)!.itemId;
      let inS0 = a?.count ?? 0, inV0 = va?.count ?? 0;
      const inS1 = b?.count ?? 0, inV1 = vb?.count ?? 0;
      // moves between the sheet and the vault keep the item
      if (inS0 > inS1 && inV1 > inV0) {
        const n = Math.min(inS0 - inS1, inV1 - inV0);
        for (let i = 0; i < n; i++) push({ t: "vault_in", instanceId: iid, itemId, count: 1 });
        inS0 -= n;
        inV0 += n;
      } else if (inV0 > inV1 && inS1 > inS0) {
        const n = Math.min(inV0 - inV1, inS1 - inS0);
        for (let i = 0; i < n; i++) push({ t: "vault_out", instanceId: iid, itemId, count: 1 });
        inV0 -= n;
        inS0 += n;
      }
      const was = inS0 + inV0, now = inS1 + inV1;
      for (let i = was; i < now; i++) push({ t: "pickup", instanceId: iid, itemId, count: 1, ...(b?.worn && !a ? { detail: "worn" } : inS1 === 0 ? { detail: "into the vault" } : {}) });
      for (let i = now; i < was; i++) push({ t: "lost", instanceId: iid, itemId, count: 1, ...(inS0 === 0 ? { detail: "from the vault" } : {}) });
      if (a && b && a.worn !== b.worn) push({ t: b.worn ? "equip" : "unequip", instanceId: iid, itemId, count: 1 });
    }
    // stackable goods, by count
    const goods = new Set([...s0.goods.keys(), ...v0.goods.keys(), ...s1.goods.keys(), ...v1.goods.keys()]);
    for (const itemId of goods) {
      let dS = (s1.goods.get(itemId) ?? 0) - (s0.goods.get(itemId) ?? 0);
      let dV = (v1.goods.get(itemId) ?? 0) - (v0.goods.get(itemId) ?? 0);
      if (dS < 0 && dV > 0) {
        const n = Math.min(-dS, dV);
        push({ t: "vault_in", instanceId: null, itemId, count: n });
        dS += n;
        dV -= n;
      } else if (dS > 0 && dV < 0) {
        const n = Math.min(dS, -dV);
        push({ t: "vault_out", instanceId: null, itemId, count: n });
        dS -= n;
        dV += n;
      }
      if (dS > 0) push({ t: "pickup", instanceId: null, itemId, count: dS });
      if (dS < 0) push({ t: "lost", instanceId: null, itemId, count: -dS });
      if (dV > 0) push({ t: "pickup", instanceId: null, itemId, count: dV, detail: "into the vault" });
      if (dV < 0) push({ t: "lost", instanceId: null, itemId, count: -dV, detail: "from the vault" });
    }
  }

  /**
   * Fill `detail` from what the same pass can see: a unique item that left one
   * tracked character and reached another names the other side; a loss that
   * lies in the character's own corpse is "death", in their dropped bag "dropped".
   */
  private annotate(drafts: Draft[]): void {
    const arrived = new Map<string, Draft>();
    const left = new Map<string, Draft>();
    for (const d of drafts) {
      if (d.entry.instanceId === null) continue;
      if (d.entry.t === "pickup") arrived.set(d.entry.instanceId, d);
      if (d.entry.t === "lost") left.set(d.entry.instanceId, d);
    }
    for (const [iid, l] of left) {
      const a = arrived.get(iid);
      if (!a || a.characterId === l.characterId) continue;
      l.entry.detail = `to ${a.characterId}`;
      a.entry.detail = `from ${l.characterId}`;
    }
    const losses = drafts.filter((d) => d.entry.t === "lost" && d.entry.detail === undefined);
    if (losses.length === 0) return;
    const bags = this.opts.netState.keys("lootbag/").map((k) => this.opts.netState.get(k) as { owner?: string; corpse?: string; dropped?: boolean; items?: Stackish[] } | undefined);
    for (const d of losses) {
      for (const bag of bags) {
        if (!bag || !Array.isArray(bag.items)) continue;
        const where = bag.corpse === d.bodyId ? "death" : bag.dropped && bag.owner === d.bodyId ? "dropped" : null;
        if (!where) continue;
        const match = bag.items.some((s) => (d.entry.instanceId !== null ? s.iid === d.entry.instanceId : s.itemId === d.entry.itemId && typeof s.iid !== "string"));
        if (match) {
          d.entry.detail = where;
          break;
        }
      }
    }
  }

  /**
   * Send everything waiting (every character, plus earlier sends that failed) as one `items.log` RPC. Called from
   * the layer's commit, so it rides every periodic save, leave and transfer. The RPC is written to the socket
   * synchronously, before this returns its promise.
   */
  flush(): Promise<void> {
    this.process();
    const batches: ItemLogBatch[] = [];
    const characters = new Set([...this.pending.keys(), ...this.holding.keys()]);
    for (const characterId of characters) {
      const entries = this.pending.get(characterId) ?? [];
      const holding = this.holding.get(characterId);
      if (entries.length === 0 && !holding) continue;
      batches.push({ characterId, entries, ...(holding ? { holding } : {}) });
    }
    this.pending.clear();
    this.holding.clear();
    if (batches.length > 0) this.outbox.push({ batchId: `${this.opts.server}:${Date.now().toString(36)}:${++this.batchSeq}`, batches });
    if (this.outbox.length === 0) return Promise.resolve();
    const sending = this.outbox;
    this.outbox = [];
    const sends = sending.map((flush) =>
      this.opts.send(flush).then(
        () => true,
        () => false,
      ),
    );
    return Promise.all(sends).then((ok) => {
      const failed = sending.filter((_, i) => !ok[i]);
      if (failed.length === 0) return;
      this.outbox = [...failed, ...this.outbox];
      this.capOutbox();
    });
  }

  private capOutbox(): void {
    const max = this.opts.maxPending ?? 20000;
    let count = this.outbox.reduce((n, f) => n + f.batches.reduce((m, b) => m + b.entries.length, 0), 0);
    while (count > max && this.outbox.length > 1) {
      const dropped = this.outbox.shift()!;
      const n = dropped.batches.reduce((m, b) => m + b.entries.length, 0);
      count -= n;
      this.log(`[items-log] DROPPED ${n} item-log entries — main has been unreachable too long`);
    }
  }

  /** Flushes waiting to be re-sent (main unreachable). */
  get unsent(): number {
    return this.outbox.length;
  }
}

/**
 * A layer's collector, wired to its world and its cluster link (serve.ts). The caller tracks a body on join,
 * untracks it on leave, and calls `flush()` from its commit.
 */
export function mountItemsLog(o: {
  netState: ItemsLogNetState;
  assets: { getDataAsset(id: string): { type: string; data: unknown } | undefined };
  link: { rpc(call: { op: "items.log" } & ItemLogFlush): Promise<unknown> };
  serverId: string;
  log?: (line: string) => void;
}): ItemsLogCollector {
  return new ItemsLogCollector({
    netState: o.netState,
    catalog: (itemId) => {
      const asset = o.assets.getDataAsset(itemId);
      return asset?.type === "item" ? (asset.data as { stack?: number }) : undefined;
    },
    server: o.serverId,
    send: (flush) => o.link.rpc({ op: "items.log", ...flush }),
    ...(o.log ? { log: o.log } : {}),
  });
}

function randomHex(n: number): string {
  let s = "";
  while (s.length < n) s += Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0");
  return s.slice(0, n);
}

// -- the store (main) -----------------------------------------------------------------------------------------

export const ITEMS_LOG_NAMESPACE = "items-log";

export interface ItemsLogStoreOptions {
  /** Entries kept in the hot record before the oldest half moves to an archive. Default 500. */
  hotMax?: number;
  /** Archive records kept per character (a ring: the oldest is overwritten). Default 40 → ~10k entries in all. */
  archives?: number;
}

/**
 * Append-only log per character. Player data scope `{ playerId: <characterId> }` (like a guild's record), so a
 * lookup needs only the character id. The hot record `items-log` holds the newest entries; past `hotMax` the
 * oldest half moves to `items-log.<slot>` (`{ seq, entries }`), a ring of `archives` slots — the oldest archive is
 * overwritten, which is the rotation: a character keeps roughly `hotMax + archives × hotMax/2` entries.
 */
export class ItemsLogStore {
  private readonly hotMax: number;
  private readonly archives: number;
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly backend: PlayerDataBackend,
    private readonly experienceId: string,
    opts: ItemsLogStoreOptions = {},
  ) {
    this.hotMax = Math.max(2, opts.hotMax ?? 500);
    this.archives = Math.max(1, opts.archives ?? 40);
  }

  private scope(characterId: string): PlayerDataScope {
    return { playerId: characterId, experienceId: this.experienceId };
  }

  /** Append in order. Appends for one character are serialized; the write is compare-and-swap with retries. */
  append(characterId: string, entries: readonly ItemLogEntry[]): Promise<void> {
    if (entries.length === 0) return Promise.resolve();
    const prev = this.chains.get(characterId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.write(characterId, entries));
    this.chains.set(characterId, next);
    void next.finally(() => {
      if (this.chains.get(characterId) === next) this.chains.delete(characterId);
    }).catch(() => undefined);
    return next;
  }

  private async write(characterId: string, add: readonly ItemLogEntry[]): Promise<void> {
    const scope = this.scope(characterId);
    for (let attempt = 0; attempt < 6; attempt++) {
      const current = await this.backend.load(scope, ITEMS_LOG_NAMESPACE);
      const data = current?.data as { entries?: ItemLogEntry[]; archived?: number } | undefined;
      let entries = [...(Array.isArray(data?.entries) ? data!.entries : []), ...add];
      let archived = typeof data?.archived === "number" ? data.archived : 0;
      while (entries.length > this.hotMax) {
        const cut = Math.max(1, Math.floor(this.hotMax / 2));
        const seq = archived + 1;
        await this.storeOver(scope, `${ITEMS_LOG_NAMESPACE}.${((seq - 1) % this.archives) + 1}`, { seq, entries: entries.slice(0, cut) });
        entries = entries.slice(cut);
        archived = seq;
      }
      const record: PlayerDataRecord = {
        schemaVersion: current?.schemaVersion ?? 1,
        revision: (current?.revision ?? -1) + 1,
        updatedAt: new Date().toISOString(),
        data: { entries, archived } as unknown as Record<string, unknown>,
      };
      if ((await this.backend.store(scope, ITEMS_LOG_NAMESPACE, record, current?.revision ?? null)) === "ok") return;
    }
    throw new Error(`items-log for ${characterId} kept conflicting`);
  }

  /** Overwrite a record whatever its revision (an archive slot is written by one appender at a time). */
  private async storeOver(scope: PlayerDataScope, namespace: string, data: object): Promise<void> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const current = await this.backend.load(scope, namespace);
      const record: PlayerDataRecord = {
        schemaVersion: 1,
        revision: (current?.revision ?? -1) + 1,
        updatedAt: new Date().toISOString(),
        data: JSON.parse(JSON.stringify(data)) as Record<string, unknown>,
      };
      if ((await this.backend.store(scope, namespace, record, current?.revision ?? null)) === "ok") return;
    }
    throw new Error(`items-log archive ${namespace} kept conflicting`);
  }

  /**
   * A character's entries, oldest first. `item` keeps entries whose item id OR instance id equals it; `since`
   * (wall ms) drops older ones; `limit` keeps the newest N (default 1000). Reads archives only as far as needed.
   */
  async read(characterId: string, q: { item?: string; since?: number; limit?: number } = {}): Promise<ItemLogEntry[]> {
    await this.chains.get(characterId)?.catch(() => undefined);
    const limit = Math.max(1, q.limit ?? 1000);
    const scope = this.scope(characterId);
    const keep = (e: ItemLogEntry): boolean =>
      (q.item === undefined || e.itemId === q.item || e.instanceId === q.item) && (q.since === undefined || e.at >= q.since);
    const hot = await this.backend.load(scope, ITEMS_LOG_NAMESPACE);
    const data = hot?.data as { entries?: ItemLogEntry[]; archived?: number } | undefined;
    let out = (Array.isArray(data?.entries) ? data!.entries : []).filter(keep);
    const archived = typeof data?.archived === "number" ? data.archived : 0;
    for (let seq = archived; seq > Math.max(0, archived - this.archives) && out.length < limit; seq--) {
      const rec = await this.backend.load(scope, `${ITEMS_LOG_NAMESPACE}.${((seq - 1) % this.archives) + 1}`);
      const chunk = rec?.data as { seq?: number; entries?: ItemLogEntry[] } | undefined;
      if (!chunk || chunk.seq !== seq || !Array.isArray(chunk.entries)) break;
      const older = chunk.entries.filter(keep);
      if (q.since !== undefined && chunk.entries.length > 0 && chunk.entries[chunk.entries.length - 1]!.at < q.since) break;
      out = [...older, ...out];
    }
    return out.slice(-limit);
  }
}

// -- the dupe flag + main's surface -------------------------------------------------------------------------

export interface DupeCase {
  id: string;
  instanceId: string;
  itemId: string;
  /** `arrived-twice`: reached a character that already held it, with no leave in between. `two-characters`: held by two at once. */
  kind: "arrived-twice" | "two-characters";
  characters: string[];
  servers: string[];
  openedAt: number;
  status: "open" | "closed";
  /** The entry (or holding snapshot) that tripped it. */
  evidence: { entry?: ItemLogEntry; heldBy?: string; since?: number };
}

const DUPES_SCOPE = "moderation-items";
const DUPES_NAMESPACE = "items-dupes";

export interface ItemsLogMainOptions {
  backend: PlayerDataBackend;
  experienceId: string;
  store?: ItemsLogStoreOptions;
  /**
   * How long an instance may sit on two characters before it is a case (ms; default 120 000). Two layers flush on
   * their own clocks, so a legitimate hand-over can arrive arrival-first; the leave has this long to catch up.
   */
  graceMs?: number;
  /** Instance ids the index remembers (oldest forgotten first). Default 200 000. */
  indexMax?: number;
  /** Cases kept (newest). Default 1000. */
  casesMax?: number;
  clock?: () => number;
  log?: (line: string) => void;
}

interface Holder {
  characterId: string;
  itemId: string;
  at: number;
  /** Learned from a holding snapshot, not an arrival: the arrival may still be on its way from the last server. */
  adopted: boolean;
}

/**
 * Main's half: ingest flushes, keep the log, flag dupes, answer lookups and claims.
 *
 * The index (instanceId → the character holding it) lives in memory and is bounded; after a main restart it is
 * rebuilt from the `holding` snapshot each character's next server sends on arrival, so a dupe whose two
 * characters have not both been online since a restart is caught when they are.
 */
export class ItemsLogMain {
  readonly store: ItemsLogStore;
  private readonly index = new Map<string, Holder>();
  private readonly byCharacter = new Map<string, Set<string>>();
  private readonly suspects = new Map<string, { holder: string; claimant: string; until: number; entry?: ItemLogEntry; server: string }>();
  private readonly seen = new Map<string, "pending" | "ok" | "failed">();
  private readonly failedEntries = new Map<string, ItemLogBatch[]>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  /** `<kind>:<instanceId>` of every open case, so one dupe opens one case however often it is seen. */
  private readonly openKeys = new Set<string>();
  private cases: DupeCase[] | null = null;
  private casesLoad: Promise<DupeCase[]> | null = null;
  private caseWrite: Promise<unknown> = Promise.resolve();
  private readonly clock: () => number;
  private readonly graceMs: number;
  private readonly indexMax: number;
  private readonly casesMax: number;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: ItemsLogMainOptions) {
    this.store = new ItemsLogStore(opts.backend, opts.experienceId, opts.store);
    this.clock = opts.clock ?? Date.now;
    this.graceMs = opts.graceMs ?? 120_000;
    this.indexMax = opts.indexMax ?? 200_000;
    this.casesMax = opts.casesMax ?? 1000;
    this.log = opts.log ?? ((line) => console.log(line));
  }

  /**
   * One layer flush (`items.log` RPC). The index is updated synchronously in arrival order — before any await —
   * so two flushes are judged in the order main received them; the entries are then appended. A resend of a batch
   * already applied only retries the write that failed.
   */
  async ingest(server: string, flush: ItemLogFlush): Promise<{ ok: true; cases: number }> {
    const state = this.seen.get(flush.batchId);
    if (state === "ok") return { ok: true, cases: 0 };
    if (state === "pending") {
      await this.inflight.get(flush.batchId);
      return { ok: true, cases: 0 };
    }
    let opened = 0;
    let batches = flush.batches;
    if (state === "failed") {
      batches = this.failedEntries.get(flush.batchId) ?? [];
    } else {
      for (const b of flush.batches) opened += this.judge(server, b);
      opened += this.sweep();
    }
    this.remember(flush.batchId, "pending");
    const write = Promise.all(batches.map((b) => this.store.append(b.characterId, b.entries)));
    this.inflight.set(flush.batchId, write.catch(() => undefined));
    try {
      await write;
      this.remember(flush.batchId, "ok");
      this.failedEntries.delete(flush.batchId);
    } catch (error) {
      this.remember(flush.batchId, "failed");
      this.failedEntries.set(flush.batchId, batches);
      throw error;
    } finally {
      this.inflight.delete(flush.batchId);
    }
    return { ok: true, cases: opened };
  }

  private remember(batchId: string, state: "pending" | "ok" | "failed"): void {
    this.seen.delete(batchId);
    this.seen.set(batchId, state);
    while (this.seen.size > 10_000) {
      const oldest = this.seen.keys().next().value as string;
      this.seen.delete(oldest);
      this.failedEntries.delete(oldest);
    }
  }

  private hold(iid: string, h: Holder): void {
    const prev = this.index.get(iid);
    if (prev) this.byCharacter.get(prev.characterId)?.delete(iid);
    this.index.delete(iid); // re-insert: Map order is the eviction order
    this.index.set(iid, h);
    let set = this.byCharacter.get(h.characterId);
    if (!set) this.byCharacter.set(h.characterId, (set = new Set()));
    set.add(iid);
    while (this.index.size > this.indexMax) {
      const [oldest, holder] = this.index.entries().next().value as [string, Holder];
      this.index.delete(oldest);
      this.byCharacter.get(holder.characterId)?.delete(oldest);
    }
  }

  private release(iid: string): void {
    const prev = this.index.get(iid);
    if (!prev) return;
    this.index.delete(iid);
    this.byCharacter.get(prev.characterId)?.delete(iid);
  }

  /** Who holds an instance, as main knows it (null = nobody / forgotten). */
  holderOf(instanceId: string): string | null {
    return this.index.get(instanceId)?.characterId ?? null;
  }

  /** Apply one character's batch to the index; returns cases opened. */
  private judge(server: string, b: ItemLogBatch): number {
    const now = this.clock();
    const c = b.characterId;
    let opened = 0;
    if (b.holding) {
      const held = new Set(b.holding);
      // what main thought this character held but its save no longer does (a rolled-back save): forgotten quietly
      for (const iid of [...(this.byCharacter.get(c) ?? [])]) if (!held.has(iid)) this.release(iid);
      for (const iid of held) {
        const h = this.index.get(iid);
        if (!h) this.hold(iid, { characterId: c, itemId: "", at: now, adopted: true });
        else if (h.characterId !== c) this.suspect(iid, h.characterId, c, server, now);
      }
    }
    for (const e of b.entries) {
      const iid = e.instanceId;
      if (iid === null) continue;
      const h = this.index.get(iid);
      if (ARRIVALS.has(e.t)) {
        if (!h) this.hold(iid, { characterId: c, itemId: e.itemId, at: e.at, adopted: false });
        else if (h.characterId === c) {
          if (h.adopted) this.hold(iid, { ...h, itemId: e.itemId, adopted: false });
          else opened += this.open({ kind: "arrived-twice", instanceId: iid, itemId: e.itemId, characters: [c], servers: [server], evidence: { entry: e, since: h.at } });
        } else this.suspect(iid, h.characterId, c, server, now, e);
      } else if (LEAVES.has(e.t)) {
        const s = this.suspects.get(iid);
        if (s && s.holder === c) {
          // the earlier holder let go: the hand-over completes
          this.suspects.delete(iid);
          this.hold(iid, { characterId: s.claimant, itemId: e.itemId, at: e.at, adopted: false });
        } else if (s && s.claimant === c) {
          this.suspects.delete(iid);
        } else if (h?.characterId === c) {
          this.release(iid);
        }
      } else if (!h) {
        // an equip / vault move of something main has not seen (a restart forgot it): it is theirs
        this.hold(iid, { characterId: c, itemId: e.itemId, at: e.at, adopted: true });
      } else if (h.characterId !== c) {
        this.suspect(iid, h.characterId, c, server, now, e);
      } else if (!h.itemId) {
        this.hold(iid, { ...h, itemId: e.itemId });
      }
    }
    return opened;
  }

  private suspect(iid: string, holder: string, claimant: string, server: string, now: number, entry?: ItemLogEntry): void {
    if (this.suspects.has(iid)) return;
    this.suspects.set(iid, { holder, claimant, until: now + this.graceMs, server, ...(entry ? { entry } : {}) });
  }

  /** Open a case for every instance still on two characters past the grace. Returns cases opened. */
  sweep(): number {
    const now = this.clock();
    let opened = 0;
    for (const [iid, s] of [...this.suspects]) {
      if (s.until > now) continue;
      this.suspects.delete(iid);
      const itemId = s.entry?.itemId || this.index.get(iid)?.itemId || "";
      opened += this.open({ kind: "two-characters", instanceId: iid, itemId, characters: [s.holder, s.claimant], servers: [s.server], evidence: { heldBy: s.holder, ...(s.entry ? { entry: s.entry } : {}) } });
    }
    return opened;
  }

  private open(c: Omit<DupeCase, "id" | "openedAt" | "status">): number {
    const key = `${c.kind}:${c.instanceId}`;
    if (this.openKeys.has(key)) return 0;
    this.openKeys.add(key);
    const full: DupeCase = { ...c, id: `dupe-${this.clock().toString(36)}-${randomHex(6)}`, openedAt: this.clock(), status: "open" };
    this.log(`[items-log] DUPE case ${full.id}: ${c.kind} — ${c.itemId || "item"} ${c.instanceId} on ${c.characters.join(", ")}`);
    this.caseWrite = this.caseWrite
      .catch(() => undefined)
      .then(async () => {
        const all = await this.loadCases();
        if (all.some((x) => x.status === "open" && x.instanceId === full.instanceId && x.kind === full.kind)) return;
        all.push(full);
        while (all.length > this.casesMax) all.shift();
        await this.saveCases(all);
      })
      .catch((error: unknown) => this.log(`[items-log] could not save dupe case ${full.id}: ${error instanceof Error ? error.message : String(error)}`));
    return 1;
  }

  private loadCases(): Promise<DupeCase[]> {
    if (this.cases) return Promise.resolve(this.cases);
    this.casesLoad ??= this.opts.backend
      .load({ playerId: DUPES_SCOPE, experienceId: this.opts.experienceId }, DUPES_NAMESPACE)
      .then((r) => {
        const list = (r?.data as { cases?: DupeCase[] } | undefined)?.cases;
        this.cases ??= Array.isArray(list) ? list : [];
        for (const c of this.cases) if (c.status === "open") this.openKeys.add(`${c.kind}:${c.instanceId}`);
        return this.cases;
      });
    return this.casesLoad;
  }

  private async saveCases(all: DupeCase[]): Promise<void> {
    const scope = { playerId: DUPES_SCOPE, experienceId: this.opts.experienceId };
    for (let attempt = 0; attempt < 6; attempt++) {
      const current = await this.opts.backend.load(scope, DUPES_NAMESPACE);
      const record: PlayerDataRecord = {
        schemaVersion: 1,
        revision: (current?.revision ?? -1) + 1,
        updatedAt: new Date().toISOString(),
        data: { cases: JSON.parse(JSON.stringify(all)) as unknown[] },
      };
      if ((await this.opts.backend.store(scope, DUPES_NAMESPACE, record, current?.revision ?? null)) === "ok") return;
    }
    throw new Error("items-dupes kept conflicting");
  }

  /** The staff list (`GET /admin/moderation/dupes`), newest first. Open cases only unless `all`. */
  async dupes(opts: { all?: boolean } = {}): Promise<DupeCase[]> {
    this.sweep();
    await this.caseWrite.catch(() => undefined);
    const all = await this.loadCases();
    return all.filter((c) => opts.all || c.status === "open").slice().reverse();
  }

  /** Staff closed a case (looked into it; any action is a separate staff decision). */
  async closeDupe(id: string): Promise<boolean> {
    await this.caseWrite.catch(() => undefined);
    const all = await this.loadCases();
    const c = all.find((x) => x.id === id);
    if (!c || c.status === "closed") return false;
    c.status = "closed";
    this.openKeys.delete(`${c.kind}:${c.instanceId}`);
    this.caseWrite = this.saveCases(all);
    await this.caseWrite;
    return true;
  }

  /** `GET /admin/items-log/:characterId?item=…` — the log, oldest first. */
  lookup(characterId: string, q: { item?: string; since?: number; limit?: number } = {}): Promise<ItemLogEntry[]> {
    return this.store.read(characterId, q);
  }

  /** The evidence an "item-claim" judge question carries (docs/moderation.md §4, §5). */
  async claimEvidence(characterId: string, item: string): Promise<ItemClaimEvidence> {
    const entries = await this.store.read(characterId, { item, limit: 200 });
    const open = (await this.dupes()).filter((c) => c.instanceId === item || c.itemId === item);
    return itemClaimEvidenceFrom(characterId, item, entries, open);
  }

  /** A claim (or staff) gave an item back: written as `restored` on the character's log, and the index follows. */
  async restore(characterId: string, item: { instanceId: string | null; itemId: string; count?: number; detail?: string }): Promise<ItemLogEntry> {
    const entry: ItemLogEntry = { t: "restored", instanceId: item.instanceId, itemId: item.itemId, count: item.count ?? 1, server: "main", at: this.clock(), ...(item.detail ? { detail: item.detail } : {}) };
    if (item.instanceId) this.hold(item.instanceId, { characterId, itemId: item.itemId, at: entry.at, adopted: true });
    await this.store.append(characterId, [entry]);
    return entry;
  }

  /**
   * Main's admin routes for the item log; null = not one of them. `GET /admin/items-log/:characterId?item=&since=&limit=`,
   * `GET /admin/moderation/dupes[?all=1]`, `POST /admin/moderation/dupes/:id/close`. The caller has checked the bearer.
   */
  async admin(method: string, path: string, params: URLSearchParams): Promise<{ status: number; body: unknown } | null> {
    if (path === "/admin/moderation/dupes" && method === "GET") {
      return { status: 200, body: { cases: await this.dupes({ all: params.get("all") === "1" }) } };
    }
    const close = /^\/admin\/moderation\/dupes\/([^/]+)\/close$/.exec(path);
    if (close && method === "POST") {
      const ok = await this.closeDupe(decodeURIComponent(close[1]!));
      return ok ? { status: 200, body: { ok: true } } : { status: 404, body: { error: "no such open case" } };
    }
    const log = /^\/admin\/items-log\/([^/]+)$/.exec(path);
    if (log && method === "GET") {
      const characterId = decodeURIComponent(log[1]!);
      const item = params.get("item") ?? undefined;
      const since = params.get("since");
      const limit = params.get("limit");
      const entries = await this.lookup(characterId, {
        ...(item ? { item } : {}),
        ...(since && Number.isFinite(Number(since)) ? { since: Number(since) } : {}),
        ...(limit && Number.isFinite(Number(limit)) ? { limit: Number(limit) } : {}),
      });
      return { status: 200, body: { characterId, entries, ...(item ? { claim: itemClaimEvidenceFrom(characterId, item, entries, []) } : {}) } };
    }
    return null;
  }
}

// -- claims ------------------------------------------------------------------------------------------------------

/** What an "item-claim" judge question is given: the log slice for one item, and what it says now. */
export interface ItemClaimEvidence {
  characterId: string;
  /** What was asked about: an item id or an instance id. */
  item: string;
  /** Matching entries, oldest first. */
  entries: ItemLogEntry[];
  /** The last arrival and the last leave the log shows (null = none). */
  lastArrived: ItemLogEntry | null;
  lastLeft: ItemLogEntry | null;
  /**
   * For an instance id: whether the log says the character still holds it (arrived and not left since).
   * For an item id (goods): the net count the log has seen arrive minus leave. Null = the log knows nothing.
   */
  holds: boolean | number | null;
  /** Open dupe cases on the item: a claim on a duplicated item is never restored without staff. */
  dupeCases: DupeCase[];
}

/** Build claim evidence from a log slice (exported for step 3's judge and for tests). */
export function itemClaimEvidenceFrom(characterId: string, item: string, entries: readonly ItemLogEntry[], dupeCases: readonly DupeCase[] = []): ItemClaimEvidence {
  const mine = entries.filter((e) => e.itemId === item || e.instanceId === item);
  let lastArrived: ItemLogEntry | null = null;
  let lastLeft: ItemLogEntry | null = null;
  let net = 0;
  for (const e of mine) {
    if (ARRIVALS.has(e.t)) {
      lastArrived = e;
      net += e.count;
    } else if (LEAVES.has(e.t)) {
      lastLeft = e;
      net -= e.count;
    }
  }
  let held: boolean | null = null;
  for (const e of mine) {
    if (ARRIVALS.has(e.t)) held = true;
    else if (LEAVES.has(e.t)) held = false;
    else held ??= true; // an equip or a vault move of something that arrived before the log began
  }
  const byInstance = mine.some((e) => e.instanceId === item);
  const holds: boolean | number | null = mine.length === 0 ? null : byInstance ? held : net;
  return { characterId, item, entries: [...mine], lastArrived, lastLeft, holds, dupeCases: [...dupeCases] };
}

/** The same, read from a store (the judge's entry point when it holds only an `ItemsLogStore`). */
export async function itemClaimEvidence(store: ItemsLogStore, characterId: string, item: string, dupeCases: readonly DupeCase[] = []): Promise<ItemClaimEvidence> {
  return itemClaimEvidenceFrom(characterId, item, await store.read(characterId, { item, limit: 200 }), dupeCases);
}
