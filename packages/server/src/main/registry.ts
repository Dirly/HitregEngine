/**
 * Layer registry + placement — pure bookkeeping, no sockets, so the rules
 * that decide where a player lands are unit-testable.
 *
 * Placement (docs/hosting.md → "Layers"):
 *   1. a party member's layer, if it has room — parties always land together
 *   2. affinity: the layer this character was on most recently, if it still
 *      exists and has room — walking back into the world you left
 *   3. the FULLEST layer with room — towns feel populated, empty wilderness
 *      stays cheap, and the sparse layer drains so it can be retired
 *   4. nothing has room → the caller starts another layer (or refuses)
 *
 * `cap` is the hard limit; `headroom` is how many free slots the pool keeps
 * so a party of five never splits across a boot.
 */

import type { HostedZones, PlayerPresence, ServerKind } from "../cluster/protocol.js";

export interface ServerEntry {
  id: string;
  kind: ServerKind;
  url: string;
  scene: string;
  cap: number;
  instanceOf?: string;
  players: Map<string, PlayerPresence>;
  tickMs: number;
  entities: number;
  accepting: boolean;
  registeredAt: number;
  lastStatusAt: number;
  /** Set when main asked it to drain. */
  draining: boolean;
  /** Last time it was empty, for retirement. */
  emptySince: number | null;
  /** Zones main places players into this server for. "all" = every zone. */
  hosted: HostedZones;
  /** Zone of each present player, from the last status (computed by main with `zoneAt`). */
  zoneOfPlayer: Map<string, string | null>;
}

export type ZoneAt = (x: number, z: number) => string | null;

export interface PlacementOptions {
  scene: string;
  characterId: string;
  partyMembers?: readonly string[];
  now?: number;
}

export interface Placement {
  server: ServerEntry;
  why: "party" | "affinity" | "fullest";
}

export class ServerRegistry {
  readonly servers = new Map<string, ServerEntry>();
  /** characterId → { layerId, at } — where they were last, for affinity. */
  private readonly affinity = new Map<string, { layerId: string; at: number }>();
  /** characterId → server id they are on right now. */
  readonly whereIs = new Map<string, string>();

  /** Zone of a world point (from the recipe regions); null = the world has no zones. */
  zoneAt: ZoneAt = () => null;

  constructor(private readonly affinityTtlMs = 30 * 60 * 1000) {}

  private zoneOf(p: PlayerPresence): string | null {
    return p.position ? this.zoneAt(p.position[0], p.position[2]) : null;
  }

  register(entry: Omit<ServerEntry, "players" | "tickMs" | "entities" | "accepting" | "registeredAt" | "lastStatusAt" | "draining" | "emptySince" | "hosted" | "zoneOfPlayer"> & { hosted?: HostedZones }, now = Date.now()): ServerEntry {
    const existing = this.servers.get(entry.id);
    const server: ServerEntry = {
      ...entry,
      players: existing?.players ?? new Map(),
      tickMs: existing?.tickMs ?? 0,
      entities: existing?.entities ?? 0,
      accepting: true,
      registeredAt: existing?.registeredAt ?? now,
      lastStatusAt: now,
      draining: existing?.draining ?? false,
      emptySince: existing?.emptySince ?? now,
      hosted: entry.hosted ?? existing?.hosted ?? "all",
      zoneOfPlayer: existing?.zoneOfPlayer ?? new Map(),
    };
    this.servers.set(entry.id, server);
    return server;
  }

  unregister(id: string, now = Date.now()): void {
    const server = this.servers.get(id);
    if (!server) return;
    for (const characterId of server.players.keys()) {
      this.whereIs.delete(characterId);
      if (server.kind === "layer") this.affinity.set(characterId, { layerId: id, at: now });
    }
    this.servers.delete(id);
    this.reservations.delete(id);
    this.zoneReservations.delete(id);
  }

  status(id: string, players: PlayerPresence[], tickMs: number, entities: number, accepting: boolean, now = Date.now()): void {
    const server = this.servers.get(id);
    if (!server) return;
    server.players = new Map(players.map((p) => [p.characterId, p]));
    server.zoneOfPlayer = new Map(players.map((p) => [p.characterId, this.zoneOf(p)]));
    server.tickMs = tickMs;
    server.entities = entities;
    server.accepting = accepting && !server.draining;
    server.lastStatusAt = now;
    for (const p of players) {
      this.whereIs.set(p.characterId, id);
      this.reservations.get(id)?.delete(p.characterId); // arrived
      this.zoneReservations.get(id)?.delete(p.characterId);
    }
    this.expireReservations(id, now);
    server.emptySince = players.length === 0 && this.reservedCount(id) === 0 ? (server.emptySince ?? now) : null;
  }

  joined(id: string, player: PlayerPresence, now = Date.now()): void {
    const server = this.servers.get(id);
    if (!server) return;
    server.players.set(player.characterId, player);
    // the join carries a position: count them in their zone now, not at the next status report
    server.zoneOfPlayer.set(player.characterId, this.zoneOf(player) ?? this.zoneReservations.get(id)?.get(player.characterId) ?? null);
    this.reservations.get(id)?.delete(player.characterId);
    this.zoneReservations.get(id)?.delete(player.characterId);
    server.emptySince = null;
    this.whereIs.set(player.characterId, id);
    if (server.kind === "layer") this.affinity.set(player.characterId, { layerId: id, at: now });
  }

  /**
   * Slots promised to characters who have not arrived yet (a `/play` grant,
   * a transfer ticket). Kept apart from the layer's own player reports so a
   * status message cannot wipe them, and so an empty layer that someone is
   * on their way to is not retired under them. Expire after `reserveMs`.
   */
  private readonly reservations = new Map<string, Map<string, number>>();
  /** serverId → characterId → zone the reservation was made for (zone density counts it). */
  private readonly zoneReservations = new Map<string, Map<string, string | null>>();
  private readonly reserveMs = 45_000;

  private expireReservations(id: string, now: number): void {
    const map = this.reservations.get(id);
    if (!map) return;
    for (const [characterId, until] of map) {
      if (until <= now) {
        map.delete(characterId);
        this.zoneReservations.get(id)?.delete(characterId);
      }
    }
  }

  private reservedCount(id: string): number {
    const map = this.reservations.get(id);
    if (!map) return 0;
    const server = this.servers.get(id);
    let n = 0;
    for (const characterId of map.keys()) if (!server?.players.has(characterId)) n++;
    return n;
  }

  left(id: string, characterId: string, now = Date.now()): void {
    const server = this.servers.get(id);
    if (!server) return;
    server.players.delete(characterId);
    server.zoneOfPlayer.delete(characterId);
    if (server.players.size === 0) server.emptySince = now;
    if (this.whereIs.get(characterId) === id) this.whereIs.delete(characterId);
    if (server.kind === "layer") this.affinity.set(characterId, { layerId: id, at: now });
  }

  /** Reserve a slot so a burst of logins cannot overfill a layer between status reports. */
  reserve(id: string, characterId: string, _playerId: string, _name: string, now = Date.now(), zone: string | null = null): void {
    const server = this.servers.get(id);
    if (!server || server.players.has(characterId)) return;
    let zmap = this.zoneReservations.get(id);
    if (!zmap) {
      zmap = new Map();
      this.zoneReservations.set(id, zmap);
    }
    zmap.set(characterId, zone);
    let map = this.reservations.get(id);
    if (!map) {
      map = new Map();
      this.reservations.set(id, map);
    }
    map.set(characterId, now + this.reserveMs);
    server.emptySince = null;
  }

  /** Does this server take players for the zone? */
  hosts(server: ServerEntry, zone: string | null): boolean {
    return server.hosted === "all" || (zone !== null && server.hosted.includes(zone));
  }

  setHosted(id: string, hosted: HostedZones): void {
    const server = this.servers.get(id);
    if (server) server.hosted = hosted;
  }

  /** Players standing in the zone on this server (plus reservations made for that zone). */
  playersInZone(server: ServerEntry, zone: string | null): number {
    let n = 0;
    for (const z of server.zoneOfPlayer.values()) if (z === zone) n++;
    const reserved = this.zoneReservations.get(server.id);
    if (reserved) for (const [characterId, z] of reserved) if (z === zone && !server.players.has(characterId)) n++;
    return n;
  }

  /**
   * Zone-scoped placement: among the layers that host the zone (or all
   * zones) with room in that zone AND in the process, party first, affinity
   * second, fullest-in-zone third — the copy where the most of your
   * neighbours are. Null = every copy of the zone is full (open another).
   */
  placeInZone(opts: PlacementOptions & { zone: string | null; zoneCap: number; exclude?: string }): Placement | null {
    const now = opts.now ?? Date.now();
    const candidates = this.layersFor(opts.scene).filter(
      (s) => s.id !== opts.exclude && s.accepting && !s.draining && this.free(s) > 0 && this.hosts(s, opts.zone) && this.playersInZone(s, opts.zone) < opts.zoneCap,
    );
    const has = (id: string): ServerEntry | undefined => candidates.find((s) => s.id === id);
    for (const member of opts.partyMembers ?? []) {
      if (member === opts.characterId) continue;
      const on = this.whereIs.get(member);
      const server = on ? has(on) : undefined;
      if (server) return { server, why: "party" };
    }
    const aff = this.affinity.get(opts.characterId);
    if (aff && now - aff.at <= this.affinityTtlMs) {
      const server = has(aff.layerId);
      if (server) return { server, why: "affinity" };
    }
    if (candidates.length === 0) return null;
    candidates.sort(
      (a, b) => this.playersInZone(b, opts.zone) - this.playersInZone(a, opts.zone) || b.players.size - a.players.size || a.registeredAt - b.registeredAt,
    );
    return { server: candidates[0]!, why: "fullest" };
  }

  /** Dedicated copies of a zone: layers hosting exactly it (not the "all" hosts). */
  copiesOf(scene: string, zone: string): ServerEntry[] {
    return this.layersFor(scene).filter((s) => s.hosted !== "all" && s.hosted.includes(zone));
  }

  free(server: ServerEntry): number {
    return Math.max(0, server.cap - server.players.size - this.reservedCount(server.id));
  }

  layersFor(scene: string): ServerEntry[] {
    return [...this.servers.values()].filter((s) => s.kind === "layer" && s.scene === scene);
  }

  place(opts: PlacementOptions): Placement | null {
    const now = opts.now ?? Date.now();
    const candidates = this.layersFor(opts.scene).filter((s) => s.accepting && !s.draining && this.free(s) > 0);
    const has = (id: string): ServerEntry | undefined => candidates.find((s) => s.id === id);
    for (const member of opts.partyMembers ?? []) {
      if (member === opts.characterId) continue;
      const on = this.whereIs.get(member);
      const server = on ? has(on) : undefined;
      if (server) return { server, why: "party" };
    }
    const aff = this.affinity.get(opts.characterId);
    if (aff && now - aff.at <= this.affinityTtlMs) {
      const server = has(aff.layerId);
      if (server) return { server, why: "affinity" };
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.players.size - a.players.size || a.registeredAt - b.registeredAt);
    return { server: candidates[0]!, why: "fullest" };
  }

  /** Free slots across every accepting layer for a scene. */
  freeSlots(scene: string): number {
    return this.layersFor(scene)
      .filter((s) => s.accepting && !s.draining)
      .reduce((n, s) => n + this.free(s), 0);
  }

  /** A layer that has sat empty long enough to retire (never the last one). */
  retirable(scene: string, idleMs: number, min: number, now = Date.now()): ServerEntry | null {
    const layers = this.layersFor(scene);
    if (layers.length <= min) return null;
    for (const s of layers) this.expireReservations(s.id, now);
    const idle = layers.filter(
      (s) => s.players.size === 0 && this.reservedCount(s.id) === 0 && s.emptySince !== null && now - s.emptySince >= idleMs && !s.draining,
    );
    idle.sort((a, b) => b.registeredAt - a.registeredAt); // newest first — keep the primary
    return idle[0] ?? null;
  }

  summary(): Array<Record<string, unknown>> {
    return [...this.servers.values()].map((s) => ({
      id: s.id,
      kind: s.kind,
      scene: s.scene,
      url: s.url,
      players: s.players.size,
      cap: s.cap,
      tickMs: s.tickMs,
      accepting: s.accepting,
      draining: s.draining,
      hosted: s.hosted,
      zones: Object.fromEntries([...new Set(s.zoneOfPlayer.values())].map((z) => [z ?? "(none)", this.playersInZone(s, z)])),
      ...(s.instanceOf ? { instanceOf: s.instanceOf } : {}),
    }));
  }
}
