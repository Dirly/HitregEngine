import type { EventRegistry } from "@hitreg/core";

/** One delivered event, as recorded in the trace ring buffer. */
export interface TraceEntry {
  tick: number;
  name: string;
  payload: unknown;
}

/**
 * `meta.from` is the sending peer's id when the event arrived as a
 * peer→authority request ("who asked?") — undefined for local emissions
 * and authority→peer broadcasts.
 */
export type EventHandler = (payload: unknown, meta?: { from?: string }) => void;

/** Where this bus sits in a multiplayer session (default "local"). */
export type NetRole = "local" | "authority" | "peer";

const TRACE_CAPACITY = 64;
const MAX_CASCADE_PASSES = 8;

/**
 * Deterministic gameplay event bus. `emit` NEVER dispatches synchronously —
 * events append to a FIFO queue that the runtime drains at one fixed point per
 * tick (after scripts' onFixedUpdate), so delivery order is identical across
 * clients/replays regardless of who emitted from where.
 *
 * Payload validation: events registered in the injected EventRegistry are
 * schema-validated on emit — invalid payloads warn and are DROPPED (nothing
 * partial ever reaches a handler). Unregistered names warn once but still
 * deliver: velocity now, strictness later — register a schema to opt in.
 */
export class EventBus {
  private queue: Array<{ name: string; payload: unknown; remote?: boolean; from?: string }> = [];
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private readonly warnedUnregistered = new Set<string>();
  private readonly traceBuffer: TraceEntry[] = [];
  private outboxBuffer: Array<{ name: string; payload: unknown }> = [];
  private commandBuffer: Array<{ name: string; payload: unknown }> = [];
  private role: NetRole = "local";
  private tick = 0;

  constructor(private readonly registry?: EventRegistry) {}

  /**
   * Where this bus sits in the session. On a "peer", emitting a
   * "to-authority" event routes it UP as a request instead of delivering
   * locally; "local" and "authority" deliver it here (they ARE the
   * authority). Set by the net layer whenever the role changes.
   */
  setNetRole(role: NetRole): void {
    this.role = role;
  }

  /** Queue an event for the next drain. Never dispatches synchronously. */
  emit(name: string, payload: unknown): void {
    // peer emitting a request: validate, ship to the authority, done — the
    // authoritative handler runs THERE; results come back via snapshots or
    // to-peers events. No local delivery (that would run unauthorized logic).
    if (this.role === "peer" && this.registry?.replicationOf(name) === "to-authority") {
      const result = this.registry.validate(name, payload);
      if (!result.ok) {
        console.warn(`[events] "${name}" payload invalid — not sent:`, result.error);
        return;
      }
      this.commandBuffer.push({ name, payload: result.data });
      return;
    }
    this.enqueue(name, payload, false);
  }

  /**
   * Queue events that arrived over the network (already emitted on the
   * authority). Delivered like any local event at the next drain, but never
   * re-enter the outbox — no replication echo.
   */
  injectRemote(events: Array<{ name: string; payload: unknown }>): void {
    for (const { name, payload } of events) this.enqueue(name, payload, true);
  }

  /**
   * Authority side: a peer's request arrived. Only "to-authority"
   * registered events are accepted (a peer must never inject broadcast or
   * local events — that would bypass the trust boundary); payloads pass
   * the same schema gate, and handlers receive `meta.from` = the sender.
   */
  injectFromPeer(from: string, events: Array<{ name: string; payload: unknown }>): void {
    for (const { name, payload } of events) {
      if (this.registry?.replicationOf(name) !== "to-authority") {
        console.warn(`[events] peer "${from}" sent non-request event "${name}" — dropped`);
        continue;
      }
      this.enqueue(name, payload, true, from);
    }
  }

  /**
   * Drain replicate-flagged events delivered since the last take (the
   * authority sends these to peers each net tick). Empty for non-authority
   * sessions — remote-injected events never land here.
   */
  takeOutbox(): Array<{ name: string; payload: unknown }> {
    const out = this.outboxBuffer;
    this.outboxBuffer = [];
    return out;
  }

  /** Drain pending peer→authority requests (peer side; the net layer ships them). */
  takeCommandOutbox(): Array<{ name: string; payload: unknown }> {
    const out = this.commandBuffer;
    this.commandBuffer = [];
    return out;
  }

  private enqueue(name: string, payload: unknown, remote: boolean, from?: string): void {
    if (this.registry) {
      if (this.registry.has(name)) {
        const result = this.registry.validate(name, payload);
        if (!result.ok) {
          console.warn(`[events] "${name}" payload invalid — dropped:`, result.error);
          return;
        }
        payload = result.data; // normalized (defaults applied)
      } else if (!this.warnedUnregistered.has(name)) {
        this.warnedUnregistered.add(name);
        console.warn(
          `[events] "${name}" is not registered — delivered unvalidated (register a schema in the EventRegistry)`,
        );
      }
    }
    this.queue.push({ name, payload, remote, from });
  }

  /** Subscribe. Returns the unsubscribe function. */
  on(name: string, cb: EventHandler): () => void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  /** Subscribe for a single delivery. Returns the unsubscribe function. */
  once(name: string, cb: EventHandler): () => void {
    const off = this.on(name, (payload, meta) => {
      off();
      cb(payload, meta);
    });
    return off;
  }

  /** Simulation tick recorded in trace entries (or pass it into drain). */
  setTick(n: number): void {
    this.tick = n;
  }

  /**
   * Deliver every queued event in FIFO order. Called by the runtime at a fixed
   * point each tick. Handlers may emit more events — those cascade same-tick,
   * capped at MAX_CASCADE_PASSES passes; beyond that the remainder is dropped
   * with a warning (a feedback loop, not a game mechanic). Handler exceptions
   * are caught and warned — one broken listener never breaks the loop.
   */
  drain(tick?: number): void {
    if (tick !== undefined) this.tick = tick;
    let passes = 0;
    while (this.queue.length > 0) {
      if (passes >= MAX_CASCADE_PASSES) {
        console.warn(
          `[events] event cascade exceeded depth ${MAX_CASCADE_PASSES} — ${this.queue.length} queued event(s) dropped`,
        );
        this.queue = [];
        return;
      }
      passes++;
      const batch = this.queue;
      this.queue = []; // handler emissions form the next pass
      for (const { name, payload, remote, from } of batch) {
        this.traceBuffer.push({ tick: this.tick, name, payload });
        if (this.traceBuffer.length > TRACE_CAPACITY) this.traceBuffer.shift();
        // locally-emitted replicate-flagged events go out to peers
        if (!remote && this.registry?.replicates(name)) {
          this.outboxBuffer.push({ name, payload });
        }
        const set = this.handlers.get(name);
        if (!set) continue;
        const meta = from !== undefined ? { from } : undefined;
        for (const cb of [...set]) {
          try {
            cb(payload, meta);
          } catch (error) {
            console.warn(`[events] handler for "${name}" failed:`, error);
          }
        }
      }
    }
  }

  /** Last delivered events (ring buffer) — context bridge / replay debugging. */
  trace(): readonly TraceEntry[] {
    return this.traceBuffer;
  }
}
