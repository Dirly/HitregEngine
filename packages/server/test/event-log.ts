/**
 * Every delivered event of a name, for tests that wait for "the next one".
 *
 * Never read `eventBus.trace()` for that: it is a 64-entry ring. On a busy
 * scene (the field's heroes fighting) it slides, and "the events after index
 * `seen`" can stay empty while the awaited event sits right there in the ring,
 * which is how the guard tests timed out in 2026-10. This log only grows.
 *
 * A name is subscribed on its first read and backfilled from the ring at that
 * moment, so a log read for the first time mid-test still holds what came just
 * before it (delivery is single-threaded: nothing lands between the two).
 */
export interface EventLogBus {
  on(name: string, cb: (payload: unknown) => void): () => void;
  trace(): ReadonlyArray<{ name: string; payload: unknown }>;
}

export interface LoggedEvent {
  name: string;
  payload: unknown;
}

export function eventLog(bus: () => EventLogBus): {
  /** Every delivered event of `name`, oldest first (the live array: read it, do not mutate it). */
  entries(name: string): readonly LoggedEvent[];
  /** Their payloads. */
  payloads<T = Record<string, unknown>>(name: string): T[];
} {
  const logs = new Map<string, LoggedEvent[]>();
  const entries = (name: string): LoggedEvent[] => {
    let log = logs.get(name);
    if (!log) {
      const b = bus();
      log = b.trace().filter((e) => e.name === name).map((e) => ({ name, payload: e.payload }));
      logs.set(name, log);
      const target = log;
      b.on(name, (payload) => target.push({ name, payload }));
    }
    return log;
  };
  return {
    entries,
    payloads: <T,>(name: string) => entries(name).map((e) => e.payload as T),
  };
}
