import { z } from "zod";
import type { ValidationResult } from "./components/registry.js";

/** Event names are lowercase dotted/kebab identifiers: "trigger.enter", "wave-cleared". */
const EVENT_NAME = /^[a-z][a-z0-9-.]*$/;

/**
 * Every gameplay event type is registered here with its Zod schema — the
 * mirror of ComponentRegistry for the event channel. The schema validates
 * every emitted payload (AI-authored scripts included) and exports as JSON
 * Schema for the AI's machine-readable spec.
 */
/**
 * How an event type crosses the network in a multiplayer session.
 * - "none": local-only (the default) — never leaves the machine.
 * - "to-peers": emitted on the AUTHORITY, delivered into every peer's bus
 *   reliable-ordered (announcements: "round.started", "chest.opened").
 * - "to-authority": emitted on a PEER, sent UP as a command — validated on
 *   the authority and delivered there with the sender's peerId (requests:
 *   "npc.hit", "interaction.requested"). Never delivered locally on the
 *   peer; results come back via snapshots or to-peers events. On the
 *   authority (and in single-player) it just delivers locally.
 */
export type EventReplication = "none" | "to-peers" | "to-authority";

export interface EventRegistrationOptions {
  /** Network direction. `true` is shorthand for "to-peers". */
  replicate?: boolean | EventReplication;
}

export class EventRegistry {
  private schemas = new Map<string, { schema: z.ZodType; replication: EventReplication }>();

  register(name: string, schema: z.ZodType, options: EventRegistrationOptions = {}): void {
    if (!EVENT_NAME.test(name)) {
      throw new Error(
        `event name "${name}" is invalid — must match ${EVENT_NAME} (e.g. "trigger.enter")`,
      );
    }
    if (this.schemas.has(name)) {
      throw new Error(`event "${name}" is already registered`);
    }
    const r = options.replicate;
    const replication: EventReplication = r === true ? "to-peers" : r === false || r === undefined ? "none" : r;
    this.schemas.set(name, { schema, replication });
  }

  has(name: string): boolean {
    return this.schemas.has(name);
  }

  /** Network direction of an event type ("none" for unregistered). */
  replicationOf(name: string): EventReplication {
    return this.schemas.get(name)?.replication ?? "none";
  }

  /** Does this event type replicate authority → peers? */
  replicates(name: string): boolean {
    return this.replicationOf(name) === "to-peers";
  }

  names(): string[] {
    return [...this.schemas.keys()];
  }

  /** Validate and normalize (defaults applied) an event payload. */
  validate(name: string, payload: unknown): ValidationResult {
    const entry = this.schemas.get(name);
    if (!entry) {
      return { ok: false, error: `unknown event type "${name}"` };
    }
    const result = entry.schema.safeParse(payload);
    if (!result.success) {
      return { ok: false, error: z.prettifyError(result.error) };
    }
    return { ok: true, data: result.data };
  }

  /** JSON Schema per event — handed to the AI as its spec of what it can emit/listen to. */
  jsonSchemas(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, entry] of this.schemas) {
      out[name] = z.toJSONSchema(entry.schema, { io: "input" });
    }
    return out;
  }
}

/**
 * The engine's built-in event contracts.
 *
 * - "entity.spawned" fires for runtime entities added AFTER the play session
 *   started (chunk/subscene streaming, script-spawned content). Entities that
 *   exist when play begins are NOT "spawned" — play start is session setup,
 *   not spawning.
 * - "entity.destroyed" fires when a runtime entity is removed mid-session
 *   (chunk unload, subscene unload).
 * - "collision" fires once per contact-started pair of non-sensor colliders.
 * - "trigger.enter"/"trigger.exit" fire when a pair involving a sensor
 *   collider starts/stops overlapping; `trigger` is the sensor entity (if
 *   both are sensors, the event fires both ways).
 * - "player.joined"/"player.left" fire on the session authority when a
 *   remote player joins/leaves the room, and REPLICATE to every peer —
 *   every tab hears the same roster changes through the same bus.
 *
 * Physics events stay local-only: each machine's sim emits its own (a
 * peer's partial sim only collides with what it simulates).
 */
export function registerCoreEvents(registry: EventRegistry): void {
  registry.register("entity.spawned", z.object({ entityId: z.string() }));
  registry.register("entity.destroyed", z.object({ entityId: z.string() }));
  registry.register("collision", z.object({ a: z.string(), b: z.string() }));
  registry.register("trigger.enter", z.object({ trigger: z.string(), other: z.string() }));
  registry.register("trigger.exit", z.object({ trigger: z.string(), other: z.string() }));
  registry.register("player.joined", z.object({ peerId: z.string(), name: z.string() }), {
    replicate: true,
  });
  registry.register("player.left", z.object({ peerId: z.string() }), { replicate: true });
}
