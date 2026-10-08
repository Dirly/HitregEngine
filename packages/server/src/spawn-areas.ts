/**
 * SpawnAreaManager — the population exists only where players are.
 *
 * A `spawnArea` component (core schema) marks a place with a pack of NPC
 * templates. Nothing is spawned at boot. A player inside `showRadius` (past
 * the interest radius, so out of sight) has the pack PLACED: spawned, a couple
 * of seconds to settle on the ground, then paused standing in its idle — a
 * creature is already there when it comes into view. The first player inside
 * `radius` wakes the area: its NPCs simulate; when no player has
 * been inside `sleepRadius` for `idleSeconds`, the pack is PAUSED in place
 * — scripts suspended, bodies pulled out of the physics world, the ground
 * under them free to unload — and resumed exactly where it stood when
 * someone comes back. A layer's cost therefore scales with its players,
 * not with the size of the world, which is what makes whole-world layers
 * affordable (docs/hosting.md).
 *
 * The pack's home, leash and roam radius are handed to each NPC's root
 * script as params (`home`, `leash`, `roam`, `spawnArea`) for the brain to
 * honour; the manager fences at 1.5× the leash as a backstop so a bug in a
 * brain cannot drag a pack into a transfer band.
 *
 * `clearToTransfer(peerId)` is the layer's default transfer gate: nobody
 * is moved between layers within sight of an awake pack, so a swap never
 * shows enemies blinking.
 */

import { polygonEdgeDistance, regionAt, spawnAreaSchema, type EntityDoc, type MobTemperament, type SpawnAreaData, type SpawnRare } from "@hitreg/core";
import type { GameServer } from "./server.js";
import { nearestOnRoute } from "@hitreg/scripting";
import type { NpcManager, NpcRecord } from "./npcs.js";
import { SIGHT_MAX, sightRadius } from "./sight.js";

export interface SpawnAreaRecord {
  id: string;
  position: [number, number, number];
  data: SpawnAreaData;
  awake: boolean;
  /** Root ids of the NPCs this area owns (empty until first woken). */
  npcIds: string[];
  /** Last tick a player was inside the sleep radius. */
  lastNearTick: number;
  wokeCount: number;
  /** Placed before anyone woke it: settling on the ground until this tick, then paused. */
  settleUntil?: number;
  /** `anywhere` / `route` areas: the area keeps its own population (spawns, deaths, out-of-sight respawns). */
  roaming?: RoamingState;
  /** Ids handed to slots re-filled by a placeholder roll (a rare in, or the placeholder back). */
  slotCounter?: number;
}

/** One placeholder rare's live state, shared by every area naming the same `id`. */
export interface RareState {
  /** The rare's NPC id while it is alive (a corpse counts as dead), else null. */
  alive: string | null;
  /** Tick before which no slot may roll it (its lockout after a death). */
  lockedUntil: number;
  /** The lockout of the copy alive now, rolled when it dies. */
  lockout: [number, number];
}

/** The key one-alive and the lockout are kept under: the rare's `id`, else its area and template. */
export function rareKey(areaId: string, rare: Pick<SpawnRare, "id" | "template">): string {
  return rare.id ?? `${areaId}/${rare.template}`;
}

/**
 * The placeholder roll for one slot of a placeholder template: the first rare of the list that may sit behind it, is
 * neither alive nor locked out, and wins its `chance` — or null (the slot spawns its placeholder).
 */
export function rollRare(
  rares: readonly SpawnRare[],
  placeholder: string,
  stateOf: (rare: SpawnRare) => RareState | undefined,
  tick: number,
  rand: () => number = Math.random,
): SpawnRare | null {
  for (const r of rares) {
    if (r.placeholders?.length && !r.placeholders.includes(placeholder)) continue;
    const st = stateOf(r);
    if (st && (st.alive !== null || tick < st.lockedUntil)) continue;
    if (rand() < r.chance) return r;
  }
  return null;
}

/** One row of the resolved spawn table (a `mix` row, or a `spawns` entry read as one). */
export interface MixRow {
  template: string;
  weight: number;
  count: [number, number];
  temperament?: MobTemperament;
  near: number;
}

/** A roaming area's own bookkeeping. */
export interface RoamingState {
  /** Per creature: its own home and leash (the fence's anchor), and the tick it was first seen dead. */
  members: Map<string, { home: [number, number, number]; leash: number; deadAt?: number }>;
  /** Corpses waiting out their respawn delay: at `due` the corpse is cleared and its slot refilled out of sight. */
  timers: Array<{ due: number; corpse: string }>;
  /** The roll waiting for room (a pair needs two free slots) or for its spot's ground. */
  next?: { row: MixRow; count: number; at?: [number, number, number] };
  counter: number;
}

/** A spawnArea's data with every default filled (a raw component from a hand-written doc may lack them). */
export function resolveSpawnArea(raw: unknown): SpawnAreaData {
  const parsed = spawnAreaSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  console.warn(`[server:spawn-areas] invalid spawnArea (${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message}); using it as written`);
  return raw as SpawnAreaData;
}

/** What one roll draws from: `mix`, else the `spawns` read as rows weighted by their counts (one creature a roll). */
export function spawnTable(data: SpawnAreaData): MixRow[] {
  if (data.mix?.length) return data.mix.map((m) => ({ template: m.template, weight: m.weight ?? 1, count: [Math.min(m.count[0], m.count[1]), Math.max(m.count[0], m.count[1])] as [number, number], ...(m.temperament ? { temperament: m.temperament } : {}), near: m.near ?? 4 }));
  return (data.spawns ?? []).map((sp) => ({ template: sp.template, weight: sp.count ?? 1, count: [1, 1] as [number, number], near: 4 }));
}

/** Creatures alive at once: `unique` 1; else `population`, else the default the schema states for the placement. */
export function populationOf(data: SpawnAreaData): number {
  const placement = data.placement ?? "pack";
  const counted = (data.spawns ?? []).reduce((n, sp) => n + (sp.count ?? 1), 0);
  if (placement === "route") return data.unique ? 1 : (data.population ?? 1);
  if (placement === "anywhere") return data.population ?? (data.mix?.length ? 6 : counted);
  return counted + (data.mix?.length ? (data.population ?? data.mix.length) : 0);
}

/** Pick a row by weight and a member count inside its [min, max] (clipped to `cap`). */
export function rollMix(table: readonly MixRow[], rand: () => number = Math.random, cap = Infinity): { row: MixRow; count: number } | null {
  const total = table.reduce((n, r) => n + Math.max(0, r.weight), 0);
  if (!table.length || total <= 0) return null;
  let pick = rand() * total;
  let row = table[table.length - 1]!;
  for (const r of table) {
    pick -= Math.max(0, r.weight);
    if (pick < 0) { row = r; break; }
  }
  const [lo, hi] = row.count;
  const count = Math.max(1, Math.min(cap, lo + Math.floor(rand() * (hi - lo + 1))));
  return { row, count };
}

/** Is a point at least `hiddenFrom` metres (x, z) from every player? */
export function hiddenFromAll(x: number, z: number, players: ReadonlyArray<readonly [number, number, number]>, hiddenFrom: number): boolean {
  for (const p of players) if (Math.hypot(p[0] - x, p[2] - z) < hiddenFrom) return false;
  return true;
}

/**
 * A random walkable point inside the disc, out of every player's `hiddenFrom`: `ground` answers a height or null
 * (no ground, water, too steep). null after `tries` misses — the caller waits for a later pass.
 */
export function pickHiddenPoint(
  center: readonly [number, number, number],
  radius: number,
  players: ReadonlyArray<readonly [number, number, number]>,
  hiddenFrom: number,
  ground: (x: number, z: number) => number | null,
  rand: () => number = Math.random,
  tries = 24,
): [number, number, number] | null {
  for (let i = 0; i < tries; i++) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * radius;
    const x = center[0] + Math.cos(a) * r;
    const z = center[2] + Math.sin(a) * r;
    if (!hiddenFromAll(x, z, players, hiddenFrom)) continue;
    const y = ground(x, z);
    if (y !== null) return [x, y, z];
  }
  return null;
}

/** The point a fraction `u` (0..1) of the way along a polyline, by length (x, z; y interpolated). */
export function pointOnRoute(route: ReadonlyArray<readonly [number, number, number]>, u: number): [number, number, number] {
  if (route.length === 1) return [route[0]![0], route[0]![1], route[0]![2]];
  const lens: number[] = [];
  let total = 0;
  for (let i = 0; i < route.length - 1; i++) {
    const l = Math.hypot(route[i + 1]![0] - route[i]![0], route[i + 1]![2] - route[i]![2]);
    lens.push(l);
    total += l;
  }
  let left = Math.max(0, Math.min(1, u)) * total;
  for (let i = 0; i < lens.length; i++) {
    if (left <= lens[i]! || i === lens.length - 1) {
      const t = lens[i]! === 0 ? 0 : Math.min(1, left / lens[i]!);
      const a = route[i]!, b = route[i + 1]!;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    }
    left -= lens[i]!;
  }
  const last = route[route.length - 1]!;
  return [last[0], last[1], last[2]];
}

/** A route-placed creature's spawn point: anywhere along the route but its first 10 %, out of sight. */
export function pickRoutePoint(
  route: ReadonlyArray<readonly [number, number, number]>,
  players: ReadonlyArray<readonly [number, number, number]>,
  hiddenFrom: number,
  ground: (x: number, z: number, y: number) => number | null,
  rand: () => number = Math.random,
  tries = 24,
): [number, number, number] | null {
  for (let i = 0; i < tries; i++) {
    const q = pointOnRoute(route, route.length === 1 ? 0 : 0.1 + rand() * 0.9);
    if (!hiddenFromAll(q[0], q[2], players, hiddenFrom)) continue;
    const y = ground(q[0], q[2], q[1]);
    if (y !== null) return [q[0], y, q[2]];
  }
  return null;
}

/** The params a temperament adds: passive creatures never shout (alertRadius 0). */
function temperamentParams(t: MobTemperament | undefined, territory: number | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (t) out["temperament"] = t;
  if (t === "passive") out["alertRadius"] = 0;
  if (territory !== undefined) out["territory"] = territory;
  return out;
}

/** A slot's params with the rare's own temperament / territory over the slot's. */
function rareParams(slot: Record<string, unknown>, rare: SpawnRare, territory: number | undefined): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...slot };
  const temperament = rest["temperament"] as MobTemperament | undefined;
  delete rest["temperament"];
  delete rest["alertRadius"];
  delete rest["territory"];
  return { ...rest, ...temperamentParams(rare.temperament ?? temperament, rare.territory ?? territory) };
}

export interface SpawnAreaManagerOptions {
  /** Ticks between residency checks (default 20 → 3 Hz at 60 Hz). */
  every?: number;
  /** Extra metres beyond `radius` a transfer is refused within (default 20). */
  transferMargin?: number;
  /** Seconds a placed pack simulates (drops onto the ground) before it is paused (default 2). */
  settleSeconds?: number;
  /** Random source for rolls, spots and delays (default Math.random) — a test's seeded stream. */
  random?: () => number;
}

export class SpawnAreaManager {
  readonly areas = new Map<string, SpawnAreaRecord>();
  private readonly every: number;
  private readonly transferMargin: number;
  private readonly settleTicks: number;
  private readonly fenced = new Set<string>();
  private readonly rand: () => number;
  private readonly unknownTemplates = new Set<string>();
  /** Placeholder rares by {@link rareKey}: alive or not, locked out until when. */
  readonly rareStates = new Map<string, RareState>();
  /** Pack slots of areas with rares, by the NPC filling them: its placeholder template, spawn params and the rare it holds. */
  private readonly slots = new Map<string, { area: string; ph: string; params: Record<string, unknown>; rare?: string }>();

  constructor(
    readonly server: GameServer,
    readonly npcs: NpcManager,
    opts: SpawnAreaManagerOptions = {},
  ) {
    this.every = opts.every ?? 20;
    this.transferMargin = opts.transferMargin ?? 20;
    this.settleTicks = Math.round((opts.settleSeconds ?? 2) / server.world.fixedDt);
    this.rand = opts.random ?? Math.random;
    for (const [id, e] of [...server.world.entities]) this.adopt(id, e);
    server.world.afterStep.add(this.afterStep);
    npcs.respawnHook = this.onRespawnDue;
  }

  /** Register an entity carrying `spawnArea` (authored, or added at runtime). */
  adopt(id: string, entity: EntityDoc): SpawnAreaRecord | null {
    const raw = entity.components["spawnArea"];
    if (!raw) return null;
    const data = resolveSpawnArea(raw);
    const p = this.server.world.positionOf(id) ?? [0, 0, 0];
    const record: SpawnAreaRecord = { id, position: p, data, awake: false, npcIds: [], lastNearTick: -1, wokeCount: 0 };
    if (SpawnAreaManager.roams(data)) record.roaming = { members: new Map(), timers: [], counter: 0 };
    this.areas.set(id, record);
    // a rare exists only when a placeholder rolls it: a scene template named as one never stands at its authored spot
    for (const r of data.rares ?? []) {
      if (this.npcs.npcs.get(r.template)?.authored) this.npcs.despawn(r.template);
    }
    return record;
  }

  dispose(): void {
    this.server.world.afterStep.delete(this.afterStep);
    if (this.npcs.respawnHook === this.onRespawnDue) this.npcs.respawnHook = null;
  }

  /** The placeholder roll for a slot of `placeholder` in this area (null: no rares, or none won). */
  private pickRare(area: SpawnAreaRecord, placeholder: string, tick: number): SpawnRare | null {
    if (!area.data.rares?.length) return null;
    return rollRare(area.data.rares, placeholder, (r) => this.rareStates.get(rareKey(area.id, r)), tick, this.rand);
  }

  /** A rare just spawned as `id`: it is the one alive. */
  private rareUp(area: SpawnAreaRecord, rare: SpawnRare, id: string): void {
    const key = rareKey(area.id, rare);
    const lockout: [number, number] = [rare.lockout?.[0] ?? 0, rare.lockout?.[1] ?? 0];
    const st = this.rareStates.get(key);
    if (st) {
      st.alive = id;
      st.lockout = lockout;
    } else this.rareStates.set(key, { alive: id, lockedUntil: 0, lockout });
  }

  /** A rare died (or was removed): nobody holds it, and its lockout runs from now. */
  private rareDown(st: RareState, tick: number): void {
    st.alive = null;
    const [lo, hi] = st.lockout;
    const seconds = Math.min(lo, hi) + this.rand() * Math.abs(hi - lo);
    st.lockedUntil = seconds > 0 ? tick + Math.round(seconds / this.server.world.fixedDt) : 0;
  }

  /** Notice dead or vanished rares (a corpse is not alive: another slot may roll it once its lockout is over). */
  private noteRareDeaths(tick: number): void {
    const world = this.server.world;
    for (const st of this.rareStates.values()) {
      if (st.alive === null) continue;
      if (this.npcs.npcs.has(st.alive) && world.netState.get(`combat/${st.alive}.dead`) !== true) continue;
      this.rareDown(st, tick);
    }
  }

  /**
   * NpcManager's respawn of a pack slot of an area with rares: the slot rolls; a win puts the rare in it, a rare's
   * death puts its placeholder back. False = an ordinary respawn in place.
   */
  private onRespawnDue = (record: NpcRecord): boolean => {
    const slot = this.slots.get(record.id);
    if (!slot) return false;
    const area = this.areas.get(slot.area);
    if (!area || area.roaming) return false;
    const tick = this.server.world.tick;
    if (slot.rare) {
      const st = this.rareStates.get(slot.rare);
      if (st && st.alive === record.id) this.rareDown(st, tick);
    }
    const rare = this.pickRare(area, slot.ph, tick);
    if (!rare && !slot.rare) return false;
    const template = rare ? rare.template : slot.ph;
    const id = `${area.id}#${template}#x${(area.slotCounter = (area.slotCounter ?? 0) + 1)}`;
    const params = rare ? rareParams(slot.params, rare, area.data.territory) : slot.params;
    const fresh = this.npcs.spawn(template, record.spawnAt, { id, yaw: record.yaw, params, ...(rare?.props ? { props: rare.props } : {}) });
    if (!fresh) {
      if (!this.unknownTemplates.has(template)) console.warn(`[server:spawn-areas] ${area.id}: unknown template "${template}"`);
      this.unknownTemplates.add(template);
      return false;
    }
    this.fenced.delete(record.id);
    this.npcs.despawn(record.id);
    this.slots.delete(record.id);
    this.slots.set(fresh.id, { area: area.id, ph: slot.ph, params: slot.params, ...(rare ? { rare: rareKey(area.id, rare) } : {}) });
    const at = area.npcIds.indexOf(record.id);
    if (at >= 0) area.npcIds[at] = fresh.id;
    else area.npcIds.push(fresh.id);
    if (rare) this.rareUp(area, rare, fresh.id);
    return true;
  };

  private playerPositions(): Array<[number, number, number]> {
    const out: Array<[number, number, number]> = [];
    for (const player of this.server.players.values()) {
      if (player.disconnectedAt !== null) continue;
      const p = this.server.world.positionOf(player.bodyId);
      if (p) out.push(p);
    }
    return out;
  }

  private static nearest(from: [number, number, number], points: Array<[number, number, number]>): number {
    let best = Infinity;
    for (const p of points) {
      const d = Math.hypot(p[0] - from[0], p[2] - from[2]);
      if (d < best) best = d;
    }
    return best;
  }

  private afterStep = (): void => {
    const world = this.server.world;
    const tick = world.tick;
    if (tick % this.every !== 0) return;
    if (this.rareStates.size) this.noteRareDeaths(tick);
    const players = this.playerPositions();
    for (const area of this.areas.values()) {
      const d = SpawnAreaManager.nearest(area.position, players);
      if (area.roaming) {
        this.stepRoaming(area, d, players, tick);
        continue;
      }
      if (!area.awake) {
        if (d <= area.data.radius) {
          if (this.wake(area)) delete area.settleUntil;
        } else if (area.npcIds.length === 0) {
          if (d <= this.showRadius(area)) this.place(area, tick);
        } else if (area.settleUntil !== undefined && tick >= area.settleUntil) {
          delete area.settleUntil;
          this.sleep(area);
        }
        continue;
      }
      if (d <= Math.max(area.data.sleepRadius, area.data.radius)) area.lastNearTick = tick;
      else if (tick - area.lastNearTick >= Math.round(area.data.idleSeconds / world.fixedDt)) this.sleep(area);
      if (area.awake) this.fence(area);
    }
  };

  /**
   * Spawn the pack the first time; resume it in place afterwards. Not until the ground under every body is
   * resident: the cells are asked of the generation workers and the area stays asleep (false) until a later
   * pass finds them landed — generating them here, on the tick, cost ~60 ms a cell.
   */
  wake(area: SpawnAreaRecord): boolean {
    const world = this.server.world;
    if (!this.groundReady(area)) return false;
    area.awake = true;
    area.lastNearTick = world.tick;
    area.wokeCount++;
    if (area.npcIds.length === 0) {
      if (!area.roaming) this.spawnPack(area); // a roaming area fills itself, out of sight (maintain)
      return true;
    }
    // resume: bodies back into the sim where they stood, scripts restarted (a pack still settling is already live)
    for (const rootId of area.npcIds) this.server.resumeRoot(rootId);
    return true;
  }

  /**
   * Where packs are placed: beyond what a client is sent (the server's interest radius), so a creature is
   * already standing on the ground when it comes into view — spawned in sight, a pack appeared out of nothing
   * and dropped onto the terrain in front of the player.
   */
  showRadius(area: SpawnAreaRecord): number {
    if (area.data.showRadius !== undefined) return Math.max(area.data.radius, area.data.showRadius);
    const interest = this.server.interestRadius;
    if (interest <= 0) return Math.max(area.data.radius, 280);
    // beyond the furthest any of its creatures is seen from (sight.ts: a giant's pack is placed further out)
    let sight = interest;
    for (const spawn of [...area.data.spawns, ...(area.data.mix ?? []), ...(area.data.rares ?? [])]) {
      const root = this.npcs.templateRoot(spawn.template);
      if (root) sight = Math.max(sight, Math.min(SIGHT_MAX, sightRadius(root, interest)));
    }
    return Math.max(area.data.radius, sight + 30);
  }

  /** Spawn the pack before anyone woke it; afterStep pauses it once it has settled on the ground. */
  place(area: SpawnAreaRecord, tick: number): boolean {
    if (!this.groundReady(area)) return false;
    this.spawnPack(area);
    area.settleUntil = tick + this.settleTicks;
    return true;
  }

  private spawnPack(area: SpawnAreaRecord): void {
    let n = 0;
    const route = SpawnAreaManager.route(area);
    // a `mix` in a pack adds its rolls to the authored spawns, scattered like a default spawn (6 m)
    const rolled: Array<{ template: string; count: number; spread: number; temperament?: MobTemperament }> = [];
    if (area.data.mix?.length) {
      const table = spawnTable(area.data);
      let left = populationOf(area.data) - area.data.spawns.reduce((m, s) => m + s.count, 0);
      while (left > 0) {
        const roll = rollMix(table, this.rand, left);
        if (!roll) break;
        rolled.push({ template: roll.row.template, count: roll.count, spread: 6, ...(roll.row.temperament ? { temperament: roll.row.temperament } : {}) });
        left -= roll.count;
      }
    }
    for (const spawn of [...area.data.spawns, ...rolled]) {
      const mood = temperamentParams((spawn as { temperament?: MobTemperament }).temperament ?? area.data.temperament, area.data.territory);
      for (let i = 0; i < spawn.count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * spawn.spread;
        const x = area.position[0] + Math.cos(angle) * r;
        const z = area.position[2] + Math.sin(angle) * r;
        // the area's own height says which floor it is on: an area in a cave spawns on the cave floor, not on the
        // mountain above it; a spot past the cave wall falls back to the area's centre
        const g = this.server.terrain ? this.server.terrain.groundNear(x, z, area.position[1]) : null;
        const at: [number, number, number] = !this.server.terrain ? [x, area.position[1], z] : g === null ? [area.position[0], area.position[1] + 1.2, area.position[2]] : [x, g + 1.2, z];
        const params: Record<string, unknown> = { home: area.position, leash: area.data.leash, roam: area.data.roam, spawnArea: area.id, ...(route.length ? { patrol: route } : {}), ...mood };
        // the slot's first fill rolls too: a rare is never guaranteed up when its camp is first placed
        const rare = this.pickRare(area, spawn.template, this.server.world.tick);
        const template = rare ? rare.template : spawn.template;
        const id = `${area.id}#${template}#${++n}`;
        const record = this.npcs.spawn(template, at, {
          id,
          yaw: Math.random() * Math.PI * 2,
          params: rare ? rareParams(params, rare, area.data.territory) : params,
          ...(rare?.props ? { props: rare.props } : {}),
        });
        if (record) {
          area.npcIds.push(record.id);
          if (area.data.rares?.length) this.slots.set(record.id, { area: area.id, ph: spawn.template, params, ...(rare ? { rare: rareKey(area.id, rare) } : {}) });
          if (rare) this.rareUp(area, rare, record.id);
        } else console.warn(`[server:spawn-areas] ${area.id}: unknown template "${template}"`);
      }
    }
  }

  /** Does this area keep its own population (spawns anywhere / along its route, respawns out of sight)? */
  static roams(data: SpawnAreaData): boolean {
    const placement = data.placement ?? "pack";
    return placement === "anywhere" || (placement === "route" && (data.patrol?.length ?? 0) > 0);
  }

  /**
   * A roaming area's residency pass: the same wake / place / sleep rules as a pack, but nothing is spawned in one
   * go — {@link maintain} fills it a creature (or a pair) at a time, wherever no player can see the spot.
   */
  private stepRoaming(area: SpawnAreaRecord, d: number, players: Array<[number, number, number]>, tick: number): void {
    const world = this.server.world;
    if (!area.awake) {
      if (d <= area.data.radius) {
        if (this.wake(area)) delete area.settleUntil;
      } else if (area.settleUntil === undefined && area.npcIds.length === 0) {
        if (d <= this.showRadius(area)) area.settleUntil = tick + this.settleTicks;
      } else if (area.settleUntil !== undefined && tick >= area.settleUntil) {
        delete area.settleUntil;
        this.sleep(area);
        return;
      }
      if (area.awake || area.settleUntil !== undefined) this.maintain(area, players, tick);
      return;
    }
    if (d <= Math.max(area.data.sleepRadius, area.data.radius)) area.lastNearTick = tick;
    else if (tick - area.lastNearTick >= Math.round(area.data.idleSeconds / world.fixedDt)) {
      this.sleep(area);
      return;
    }
    this.maintain(area, players, tick);
    this.fence(area);
  }

  /**
   * Keep a roaming area at its population: note deaths (each starts a jittered `respawn` timer), clear the corpse when
   * its timer runs out, and spawn rolls from the table into free slots at spots no player is within `hiddenFrom` of.
   */
  maintain(area: SpawnAreaRecord, players: ReadonlyArray<readonly [number, number, number]>, tick: number): void {
    const st = area.roaming;
    if (!st) return;
    const world = this.server.world;
    // gone some other way (an admin despawn): forget it, its slot is free
    area.npcIds = area.npcIds.filter((id) => {
      if (this.npcs.npcs.has(id)) return true;
      st.members.delete(id);
      st.timers = st.timers.filter((t) => t.corpse !== id);
      return false;
    });
    for (const id of area.npcIds) {
      const m = st.members.get(id);
      if (!m || m.deadAt !== undefined) continue;
      if (world.netState.get(`combat/${id}.dead`) !== true) continue;
      m.deadAt = tick;
      const [lo, hi] = area.data.respawn ?? [60, 150];
      const seconds = Math.min(lo, hi) + this.rand() * Math.abs(hi - lo);
      st.timers.push({ due: tick + Math.round(seconds / world.fixedDt), corpse: id });
    }
    for (const t of [...st.timers]) {
      if (tick < t.due) continue;
      st.timers.splice(st.timers.indexOf(t), 1);
      st.members.delete(t.corpse);
      area.npcIds = area.npcIds.filter((id) => id !== t.corpse);
      this.fenced.delete(t.corpse);
      this.npcs.despawn(t.corpse);
    }
    const target = populationOf(area.data);
    const table = spawnTable(area.data);
    const hiddenFrom = area.data.hiddenFrom ?? 60;
    for (let guard = 0; guard < 8; guard++) {
      const free = target - area.npcIds.length;
      if (free <= 0) return;
      if (!st.next) {
        const roll = rollMix(table, this.rand, target);
        if (!roll) return;
        st.next = roll;
      }
      const next = st.next;
      if (next.count > free) {
        if (st.timers.length) return; // a pair waits for a corpse's slot to free up as well
        next.count = free; // nothing else will free a slot: the last one is a single, never a population stuck short
      }
      if (next.at && !hiddenFromAll(next.at[0], next.at[2], players, hiddenFrom)) delete next.at; // someone walked up to it
      if (!next.at) {
        const at = this.pickSpot(area, players);
        if (!at) return; // nowhere out of sight right now: a later pass tries again
        next.at = at;
      }
      const terrain = this.server.terrain;
      if (terrain && !terrain.prefetch(next.at[0], next.at[2], terrain.resolved.streamer.cellSize)) return; // its cells are on their way
      this.spawnRoll(area, next.row, next.count, next.at);
      delete st.next;
    }
  }

  /** A spot for the next roll: anywhere in the disc, or along the route, out of every player's sight. */
  private pickSpot(area: SpawnAreaRecord, players: ReadonlyArray<readonly [number, number, number]>): [number, number, number] | null {
    const hiddenFrom = area.data.hiddenFrom ?? 60;
    if ((area.data.placement ?? "pack") === "route") {
      return pickRoutePoint(SpawnAreaManager.route(area), players, hiddenFrom, (x, z, y) => this.walkable(x, z, y, false), this.rand);
    }
    return pickHiddenPoint(area.position, area.data.radius, players, hiddenFrom, (x, z) => this.walkable(x, z, area.position[1], true), this.rand);
  }

  /**
   * Ground a creature may stand on at (x, z), or null: no ground there, standing water over 0.4 m, or a grade over
   * ~40°. `openAir` samples the surface (an `anywhere` area); otherwise the floor near `y` (a route through a cave).
   * With no terrain the area's own height is the ground.
   */
  private walkable(x: number, z: number, y: number, openAir: boolean): number | null {
    const terrain = this.server.terrain;
    if (!terrain) return y;
    const at = (px: number, pz: number): number | null => (openAir ? terrain.groundHeight(px, pz) : terrain.groundNear(px, pz, y));
    const g = at(x, z);
    if (g === null) return null;
    const water = terrain.resolved.field.waterY(x, z);
    if (water !== null && water - g > 0.4) return null;
    for (const [dx, dz] of [[1.5, 0], [0, 1.5], [-1.5, 0], [0, -1.5]] as const) {
      const h = at(x + dx, z + dz);
      if (h === null || Math.abs(h - g) > 1.3) return null;
    }
    return g;
  }

  /** Spawn one roll: the first member on the spot, the rest within the row's `near`, each with its own home and roam. */
  private spawnRoll(area: SpawnAreaRecord, row: MixRow, count: number, at: [number, number, number]): void {
    const st = area.roaming!;
    const route = (area.data.placement ?? "pack") === "route" ? SpawnAreaManager.route(area) : [];
    const [rlo, rhi] = area.data.roamRange ?? [40, 80];
    const mood = temperamentParams(row.temperament ?? area.data.temperament, area.data.territory);
    for (let i = 0; i < count; i++) {
      let p: [number, number, number] = at;
      if (i > 0) {
        const a = this.rand() * Math.PI * 2;
        const r = 1 + this.rand() * Math.max(0, row.near - 1);
        const x = at[0] + Math.cos(a) * r;
        const z = at[2] + Math.sin(a) * r;
        const y = route.length ? this.walkable(x, z, at[1], false) : this.walkable(x, z, area.position[1], true);
        if (y !== null) p = [x, y, z];
      }
      const home: [number, number, number] = [p[0], p[1], p[2]];
      let params: Record<string, unknown>;
      let leash: number;
      if (route.length) {
        leash = area.data.leash;
        params = { home, leash, roam: area.data.roam, spawnArea: area.id, patrol: route, patrolDir: this.rand() < 0.5 ? -1 : 1, ...mood };
      } else {
        const roam = Math.min(rlo, rhi) + this.rand() * Math.abs(rhi - rlo);
        leash = Math.max(area.data.leash, roam + 20);
        params = { home, leash, roam, spawnArea: area.id, ...mood };
      }
      // every spawn of a slot is a placeholder roll: the rare comes up in this member's place
      const rare = this.pickRare(area, row.template, this.server.world.tick);
      const template = rare ? rare.template : row.template;
      const id = `${area.id}#${template}#${++st.counter}`;
      const record = this.npcs.spawn(template, [p[0], p[1] + (this.server.terrain ? 1.2 : 0), p[2]], {
        id,
        yaw: this.rand() * Math.PI * 2,
        params: rare ? rareParams(params, rare, area.data.territory) : params,
        respawn: false,
        ...(rare?.props ? { props: rare.props } : {}),
      });
      if (!record) {
        if (!this.unknownTemplates.has(template)) console.warn(`[server:spawn-areas] ${area.id}: unknown template "${template}"`);
        this.unknownTemplates.add(template);
        continue;
      }
      area.npcIds.push(record.id);
      st.members.set(record.id, { home, leash });
      if (rare) this.rareUp(area, rare, record.id);
    }
  }

  /** Ground resident (or asked for) under the pack: around the area for a first spawn, around each body for a resume. */
  private groundReady(area: SpawnAreaRecord): boolean {
    const terrain = this.server.terrain;
    if (!terrain) return true;
    const size = terrain.resolved.streamer.cellSize;
    if (area.npcIds.length === 0) {
      if (area.roaming) return true; // each spot is asked for as it is picked (maintain)
      const spread = Math.max(area.data.mix?.length ? 6 : 0, area.data.spawns.reduce((m, s) => Math.max(m, s.spread), 0));
      return terrain.prefetch(area.position[0], area.position[2], spread + size);
    }
    let ready = true;
    for (const rootId of area.npcIds) {
      const p = this.server.world.positionOf(rootId);
      if (p && !terrain.prefetch(p[0], p[2], size)) ready = false; // keep asking for every body's cells
    }
    return ready;
  }

  /** Pause in place: scripts off, bodies out of the physics world, positions kept on the objects. */
  sleep(area: SpawnAreaRecord): void {
    area.awake = false;
    for (const rootId of area.npcIds) this.server.pauseRoot(rootId);
  }

  /** Backstop leash: a body 1.5× past its leash is put back home. */
  /** The area's patrol route in world coordinates (empty = none). */
  static route(area: SpawnAreaRecord): Array<[number, number, number]> {
    return (area.data.patrol ?? []).map((p) => [area.position[0] + p[0], area.position[1] + p[1], area.position[2] + p[2]] as [number, number, number]);
  }

  private fence(area: SpawnAreaRecord): void {
    const world = this.server.world;
    const limit = area.data.leash * 1.5;
    const route = SpawnAreaManager.route(area);
    for (const rootId of area.npcIds) {
      if (this.server.paused.has(rootId)) continue;
      const p = world.positionOf(rootId);
      if (!p) continue;
      // a patrolling pack is fenced from the nearest point of its route, not from the area's origin; a roamer from its own home
      const own = route.length ? undefined : area.roaming?.members.get(rootId);
      const anchor = route.length ? nearestOnRoute(route, p) : (own?.home ?? area.position);
      const d = Math.hypot(p[0] - anchor[0], p[2] - anchor[2]);
      if (d <= (own ? own.leash * 1.5 : limit)) continue;
      if (!this.fenced.has(rootId)) {
        this.fenced.add(rootId);
        console.warn(`[server:spawn-areas] ${rootId} strayed ${d.toFixed(0)} m from ${area.id} (leash ${area.data.leash}) — fenced back home; the brain should honour its \`leash\` param`);
      }
      const home = anchor;
      const y = this.server.terrain ? (this.server.terrain.groundNear(home[0], home[2], home[1]) ?? home[1]) + 1.2 : home[1];
      world.sim.setPosition(rootId, [home[0], y, home[2]]);
    }
  }

  /** No awake pack within radius + margin of this player's body. */
  clearToTransfer(peerId: string): boolean {
    const player = this.server.players.get(peerId);
    if (!player) return false;
    const p = this.server.world.positionOf(player.bodyId);
    if (!p) return true;
    return this.clearAt(p);
  }

  /** Is this spot quiet: no awake pack within radius + margin of it? (The destination's answer to `arrival.check`.) */
  clearAt(p: readonly [number, number, number]): boolean {
    for (const area of this.areas.values()) {
      if (!area.awake) continue;
      const d = Math.hypot(area.position[0] - p[0], area.position[2] - p[2]);
      if (d <= area.data.radius + this.transferMargin) return false;
    }
    return true;
  }

  /**
   * Spawn areas whose reach (spread + leash + roam, plus the transfer band)
   * crosses a zone border — where a swap could happen in sight of a pack.
   * The audit the playbook asks for; warned at boot, listed on /admin.
   */
  borderWarnings(regions: ReadonlyArray<{ id: string; polygon: ReadonlyArray<readonly [number, number]> }>, band: number): Array<{ id: string; zone: string; distance: number; reach: number }> {
    if (regions.length === 0) return [];
    const out: Array<{ id: string; zone: string; distance: number; reach: number }> = [];
    for (const area of this.areas.values()) {
      const [x, , z] = area.position;
      const reach = SpawnAreaManager.reach(area) + band;
      const home = regionAt(regions as never, x, z);
      if (!home) continue;
      const distance = polygonEdgeDistance(x, z, home.polygon);
      if (distance < reach) out.push({ id: area.id, zone: home.id, distance: Math.round(distance), reach: Math.round(reach) });
    }
    return out;
  }

  /**
   * How far from the area's origin its creatures can get: a pack's spread + leash + roam; a roamer's radius + its
   * largest leash (roam + 20 at least); a route's furthest point + leash.
   */
  static reach(area: SpawnAreaRecord): number {
    const data = area.data;
    const placement = data.placement ?? "pack";
    if (placement === "anywhere") return data.radius + Math.max(data.leash, Math.max(...(data.roamRange ?? [40, 80])) + 20);
    if (placement === "route" && data.patrol?.length) return Math.max(...data.patrol.map((p) => Math.hypot(p[0], p[2]))) + data.leash;
    const spread = Math.max(data.mix?.length ? 6 : 0, data.spawns.reduce((m, s) => Math.max(m, s.spread), 0));
    return spread + data.leash + data.roam;
  }

  /** Placeholder rares for /admin: who holds each, and seconds of lockout left. */
  rares(): Array<{ key: string; alive: string | null; lockedFor: number }> {
    const tick = this.server.world.tick;
    return [...this.rareStates].map(([key, st]) => ({ key, alive: st.alive, lockedFor: Math.max(0, Math.round((st.lockedUntil - tick) * this.server.world.fixedDt)) }));
  }

  list(): Array<{ id: string; position: [number, number, number]; awake: boolean; npcs: number; woke: number }> {
    return [...this.areas.values()].map((a) => ({ id: a.id, position: a.position, awake: a.awake, npcs: a.npcIds.length, woke: a.wokeCount }));
  }
}
