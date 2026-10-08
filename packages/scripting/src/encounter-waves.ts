/**
 * encounter-waves — the first BOSS MECHANIC builtin (docs/mob-ai.md, "Boss mechanics"): adds that join a fight at the
 * boss's health thresholds (a brood-mother's litters, a lich's risen guard, a warlord's reinforcements).
 *
 * Put it on an entity standing where the fight happens. Parameters only: which boss, which NPC template, named spawn
 * mouths (metres, relative to this entity, world axes) and waves `{ atHp, count, mouths }`. On the authority it reads
 * the boss's health from netState (`combat/<boss>.hp` / `.maxHp` / `.dead`, the combat convention), fires each wave
 * once when the health fraction first falls to its `atHp` (1 = on the first hit), deals the adds round-robin over the
 * wave's mouths, keeps at most `maxAlive` alive (the rest queue) and asks the server to spawn them with the
 * `npc.spawn` event (and to remove each corpse after `corpseSeconds` with `npc.despawn`, so adds never respawn like a
 * pack). When the boss dies, or is whole again with no adds left (it leashed home), the encounter re-arms: a farmed
 * boss replays its waves.
 *
 * The decisions live in {@link WaveTracker} (pure, tested); the script is the netState + event wrapper.
 */
import * as THREE from "three";
import { z } from "zod";
import { Script, type ScriptEventDecl } from "./script.js";

export interface WaveDef { atHp: number; count: number; mouths: string[] }
export interface WaveTrackerConfig { waves: WaveDef[]; maxAlive: number; corpseTicks: number }
export interface WaveTrackerInput {
  /** Boss health fraction 0..1, or null while it has no health (not spawned, asleep). */
  fraction: number | null;
  bossDead: boolean;
  tick: number;
  isDead(addId: string): boolean;
  exists(addId: string): boolean;
}
export interface WaveTrackerOutput { spawn: Array<{ mouth: string; wave: number }>; despawn: string[] }

/** Pure wave bookkeeping: which waves fired, the queue, live adds and their corpses. */
export class WaveTracker {
  readonly fired = new Set<number>();
  readonly queue: Array<{ mouth: string; wave: number }> = [];
  /** live add id -> tick first seen dead (-1 while alive) */
  readonly adds = new Map<string, number>();
  low = 1;
  constructor(readonly cfg: WaveTrackerConfig) {}

  alive(): number { let n = 0; for (const d of this.adds.values()) if (d < 0) n++; return n; }

  /** Register an add the caller spawned. */
  added(id: string): void { this.adds.set(id, -1); }

  update(s: WaveTrackerInput): WaveTrackerOutput {
    const out: WaveTrackerOutput = { spawn: [], despawn: [] };
    for (const [id, deadAt] of this.adds) {
      if (!s.exists(id)) { this.adds.delete(id); continue; }
      if (s.isDead(id)) {
        if (deadAt < 0) this.adds.set(id, s.tick);
        else if (s.tick - deadAt >= this.cfg.corpseTicks) { out.despawn.push(id); this.adds.delete(id); }
      }
    }
    if (s.bossDead) this.queue.length = 0;
    const alive = this.alive();
    // re-arm: the boss died, or is whole again (it leashed home), and its adds are gone
    if (this.fired.size > 0 && alive === 0 && this.queue.length === 0 && (s.bossDead || s.fraction === 1)) { this.fired.clear(); this.low = 1; }
    if (s.fraction === null || s.bossDead) return out;
    this.low = Math.min(this.low, s.fraction);
    this.cfg.waves.forEach((w, i) => {
      if (this.fired.has(i)) return;
      if (!(w.atHp >= 1 ? this.low < 1 : this.low <= w.atHp)) return;
      this.fired.add(i);
      for (let k = 0; k < w.count; k++) this.queue.push({ mouth: w.mouths[k % w.mouths.length]!, wave: i });
    });
    let free = this.cfg.maxAlive - alive;
    while (free-- > 0 && this.queue.length) out.spawn.push(this.queue.shift()!);
    return out;
  }
}

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
/** Asks the authority's NPC manager to spawn a template (the server answers; clients ignore it). */
export const npcSpawnEventSchema = z.object({
  template: z.string().min(1).describe("NPC template: an npc-tagged scene subtree id, a server-registered name, or `prefab:<prefabId>` (a prefab asset, e.g. prefab:mobs/wolf-timber)."),
  id: z.string().min(1).describe("Root id for the new NPC (unique)."),
  at: vec3.describe("World position, metres."),
  yaw: z.number().default(0).describe("Facing, radians."),
  params: z.record(z.string(), z.unknown()).default({}).describe("Merged into every script of the spawned subtree (home, leash, roam, ...)."),
  props: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("A `prefab:<prefabId>` template's prop values (faction, level, ...); its `actor` prop is bound to `id` automatically."),
  respawn: z
    .boolean()
    .optional()
    .describe("false = never respawned when it dies (a pet, a summon): whoever asked for it removes it with npc.despawn."),
});
export const npcDespawnEventSchema = z.object({ id: z.string().min(1).describe("Root id of an NPC to remove (no respawn).") });

export class EncounterWavesScript extends Script {
  static override scriptName = "encounter-waves";
  static override params = {
    boss: { default: "", description: "Entity id of the boss whose health drives the waves (its combat netState key)." },
    template: { default: "", description: "NPC template every wave spawns (an npc-tagged scene subtree id or a server-registered name)." },
    mouths: { default: {} as Record<string, number[]>, description: "Named spawn points { name: [x, y, z] } in metres relative to this entity (world axes): holes, doors, graves." },
    waves: { default: [] as WaveDef[], description: "[{ atHp, count, mouths }]: each fires once when the boss's health fraction first falls to atHp (1 = the first hit); its adds come out of the named mouths round-robin." },
    maxAlive: { default: 8, min: 1, max: 100, description: "Cap on this encounter's live adds; the rest wait until one dies (the sight-budget lever)." },
    leash: { default: 30, min: 1, max: 500, description: "Each add's leash; its home is the boss's position when it spawns, so it fights where the boss fights." },
    corpseSeconds: { default: 8, min: 0, max: 600, description: "Seconds a dead add stays (loot, death pose) before it is removed. Adds never respawn." },
  };
  static override events: ScriptEventDecl[] = [
    { name: "npc.spawn", schema: npcSpawnEventSchema },
    { name: "npc.despawn", schema: npcDespawnEventSchema },
  ];

  private tracker: WaveTracker | null = null;
  private count = 0;
  private tick = 0;
  private readonly v = new THREE.Vector3();

  override onStart(): void { this.rebuild(); }
  override onParamsChanged(): void { this.rebuild(); }

  private rebuild(): void {
    const waves = (this.param<WaveDef[]>("waves") ?? []).filter((w) => w && Array.isArray(w.mouths) && w.mouths.length > 0 && w.count > 0);
    this.tracker = new WaveTracker({ waves, maxAlive: this.param<number>("maxAlive"), corpseTicks: Math.round(this.param<number>("corpseSeconds") * 60) });
  }

  private worldPos(id: string): [number, number, number] | null {
    const o = this.ctx.getObject(id);
    if (!o) return null;
    o.updateWorldMatrix(true, false);
    const w = o.getWorldPosition(this.v);
    return [w.x, w.y, w.z];
  }

  override onFixedUpdate(): void {
    const ns = this.ctx.netState, ev = this.ctx.events, t = this.tracker;
    if (!ns || !ev || !t || !ns.isAuthority()) return;
    this.tick++;
    const boss = this.param<string>("boss");
    const hp = ns.get(`combat/${boss}.hp`), max = ns.get(`combat/${boss}.maxHp`);
    const fraction = typeof hp === "number" && typeof max === "number" && max > 0 ? Math.max(0, Math.min(1, hp / max)) : null;
    const out = t.update({
      fraction, bossDead: ns.get(`combat/${boss}.dead`) === true, tick: this.tick,
      isDead: (id) => ns.get(`combat/${id}.dead`) === true,
      exists: (id) => this.ctx.getEntity(id) !== undefined,
    });
    for (const id of out.despawn) ev.emit("npc.despawn", { id });
    if (!out.spawn.length) return;
    const origin = this.worldPos(this.entityId) ?? [0, 0, 0];
    const mouths = this.param<Record<string, number[]>>("mouths") ?? {};
    for (const s of out.spawn) {
      const rel = mouths[s.mouth];
      if (!rel) continue;
      const at: [number, number, number] = [origin[0] + rel[0]!, origin[1] + rel[1]!, origin[2] + rel[2]!];
      const home = this.worldPos(boss) ?? at;
      const id = `${this.entityId}#add#${++this.count}`;
      ev.emit("npc.spawn", { template: this.param<string>("template"), id, at, yaw: Math.atan2(home[0] - at[0], home[2] - at[2]), params: { home, leash: this.param<number>("leash"), roam: 0, encounter: this.entityId } });
      t.added(id);
    }
  }
}
