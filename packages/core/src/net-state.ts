import { z } from "zod";
import type { ValidationResult } from "./components/registry.js";

/**
 * NetStateStore — replicated session state (the NetworkVariables analog).
 *
 * The third leg of the net stack: `netObject` replicates transforms, events
 * replicate messages, and this replicates FACTS — enemy HP, "chest opened",
 * "crystal taken", round score. Any state a script keeps in a private
 * variable is invisible to the network; state kept here is:
 *
 * - authority-written: only the session authority (or single-player local)
 *   may mutate; peers read. Peers request changes through to-authority
 *   events — the authoritative handler decides and writes.
 * - read-replicated: every peer holds the full replica (deltas ride the
 *   reliable channel; joiners get a full sync).
 * - migration-proof: because every peer has the replica, a promoted host
 *   simply keeps the store's contents as its authoritative state — enemy
 *   HP and quest progress survive the handoff for free.
 *
 * Keys are `namespace/rest` strings ("enemyHp/wolf-1"). A namespace MAY
 * register a Zod value schema (`define`) — validated on write, exported as
 * JSON Schema for the AI spec; unregistered namespaces warn once and pass
 * through (same velocity/strictness split as events). Values are plain
 * JSON. This is SESSION state (persistence category 4): it dies with the
 * room — commit anything durable into playerData explicitly.
 */

const KEY_PATTERN = /^[a-z][a-zA-Z0-9-.]*\/.+$/;

export type NetStateChangeHandler = (key: string, value: unknown) => void;

export interface NetStateDelta {
  set: Record<string, unknown>;
  removed: string[];
}

export class NetStateStore {
  private readonly values = new Map<string, unknown>();
  private readonly schemas = new Map<string, z.ZodType>();
  private readonly handlers = new Set<NetStateChangeHandler>();
  private readonly warnedNamespaces = new Set<string>();
  private dirtySet = new Map<string, unknown>();
  private dirtyRemoved = new Set<string>();
  private authority = true;

  /** Register a value schema for a namespace ("enemyHp" validates "enemyHp/*"). */
  define(namespace: string, schema: z.ZodType): void {
    if (!/^[a-z][a-zA-Z0-9-.]*$/.test(namespace)) {
      throw new Error(`netState namespace "${namespace}" is invalid`);
    }
    if (this.schemas.has(namespace)) {
      throw new Error(`netState namespace "${namespace}" is already defined`);
    }
    this.schemas.set(namespace, schema);
  }

  /**
   * Whether this store may be written. The net layer flips it with the
   * session role: authority/local = writable, peer = read-only replica.
   */
  setAuthority(authority: boolean): void {
    this.authority = authority;
  }

  isAuthority(): boolean {
    return this.authority;
  }

  get(key: string): unknown {
    return this.values.get(key);
  }

  keys(prefix?: string): string[] {
    const all = [...this.values.keys()];
    return prefix === undefined ? all : all.filter((k) => k.startsWith(prefix));
  }

  /** Authority write. Returns false (with a warning) on a peer or bad value. */
  set(key: string, value: unknown): boolean {
    if (!this.authority) {
      console.warn(
        `[netState] set("${key}") ignored — this session is a peer (read-only replica); ` +
          `request the change through a to-authority event instead`,
      );
      return false;
    }
    if (!KEY_PATTERN.test(key)) {
      console.warn(`[netState] key "${key}" is invalid — use "namespace/rest"`);
      return false;
    }
    const checked = this.validate(key, value);
    if (!checked.ok) {
      console.warn(`[netState] set("${key}") rejected:`, checked.error);
      return false;
    }
    this.write(key, checked.data);
    this.dirtySet.set(key, checked.data);
    this.dirtyRemoved.delete(key);
    return true;
  }

  /** Authority numeric add (missing/non-number treated as 0). Null on a peer. */
  increment(key: string, delta = 1): number | null {
    const current = this.values.get(key);
    const base = typeof current === "number" && Number.isFinite(current) ? current : 0;
    const next = base + delta;
    return this.set(key, next) ? next : null;
  }

  /** Authority delete. */
  delete(key: string): boolean {
    if (!this.authority) {
      console.warn(`[netState] delete("${key}") ignored — this session is a peer`);
      return false;
    }
    if (!this.values.has(key)) return false;
    this.values.delete(key);
    this.dirtyRemoved.add(key);
    this.dirtySet.delete(key);
    this.dispatch(key, undefined);
    return true;
  }

  /** Subscribe to changes (local writes AND replicated ones). Returns unsubscribe. */
  onChange(cb: NetStateChangeHandler): () => void {
    this.handlers.add(cb);
    return () => {
      this.handlers.delete(cb);
    };
  }

  // -- replication surface (driven by the net layer) ---------------------------

  /** Changes since the last take (authority ships these each net tick). */
  takeDelta(): NetStateDelta | null {
    if (this.dirtySet.size === 0 && this.dirtyRemoved.size === 0) return null;
    const delta: NetStateDelta = {
      set: Object.fromEntries(this.dirtySet),
      removed: [...this.dirtyRemoved],
    };
    this.dirtySet = new Map();
    this.dirtyRemoved = new Set();
    return delta;
  }

  /** Everything, for joiner full-syncs and debugging. */
  snapshot(): Record<string, unknown> {
    return Object.fromEntries(this.values);
  }

  /** Peer side: apply a full sync (replaces the replica) or a delta. */
  applyRemote(payload: { full?: Record<string, unknown>; delta?: NetStateDelta }): void {
    if (payload.full) {
      const incoming = new Set(Object.keys(payload.full));
      for (const key of [...this.values.keys()]) {
        if (!incoming.has(key)) {
          this.values.delete(key);
          this.dispatch(key, undefined);
        }
      }
      for (const [key, value] of Object.entries(payload.full)) this.write(key, value);
    }
    if (payload.delta) {
      for (const [key, value] of Object.entries(payload.delta.set)) this.write(key, value);
      for (const key of payload.delta.removed) {
        if (this.values.delete(key)) this.dispatch(key, undefined);
      }
    }
  }

  /** New session/room: forget everything (no change events — nothing to react to). */
  clear(): void {
    this.values.clear();
    this.dirtySet = new Map();
    this.dirtyRemoved = new Set();
  }

  /** JSON Schema per defined namespace — the AI-facing spec. */
  jsonSchemas(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [namespace, schema] of this.schemas) {
      out[namespace] = z.toJSONSchema(schema, { io: "input" });
    }
    return out;
  }

  // -- internals ----------------------------------------------------------------

  private validate(key: string, value: unknown): ValidationResult {
    const namespace = key.slice(0, key.indexOf("/"));
    const schema = this.schemas.get(namespace);
    if (!schema) {
      if (!this.warnedNamespaces.has(namespace)) {
        this.warnedNamespaces.add(namespace);
        console.warn(
          `[netState] namespace "${namespace}" has no schema — values pass through unvalidated (define one)`,
        );
      }
      return { ok: true, data: value };
    }
    const result = schema.safeParse(value);
    if (!result.success) return { ok: false, error: z.prettifyError(result.error) };
    return { ok: true, data: result.data };
  }

  private write(key: string, value: unknown): void {
    const had = this.values.has(key);
    const prev = this.values.get(key);
    this.values.set(key, value);
    // skip no-op primitive rewrites (full syncs re-send everything); object
    // values compare by reference, so handlers must stay idempotent
    if (!had || prev !== value) this.dispatch(key, value);
  }

  private dispatch(key: string, value: unknown): void {
    for (const cb of [...this.handlers]) {
      try {
        cb(key, value);
      } catch (error) {
        console.warn(`[netState] onChange handler failed for "${key}":`, error);
      }
    }
  }
}
