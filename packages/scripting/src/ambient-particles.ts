import { WORLD_WEATHER_KEY } from "@hitreg/core";
import { Script, type BiomeAt, type RegionAt, type ScriptCommandDecl } from "./script.js";

/**
 * One ambient layer: which emitter it drives and where/when it lives.
 *
 * Plain data (the script's `layers` param), so a scene retunes or adds a layer
 * without code. Lists are comma strings, matched case-insensitively.
 */
export interface AmbientLayer {
  /** Layer id; the emitter it drives is the local player's child tagged `ambient-<id>`. */
  id: string;
  /** Biome ids it lives in. Empty = any biome. */
  biomes: string;
  /** day | night | always — eased across dusk and dawn by the day-night script's daylight. */
  when: "day" | "night" | "always";
  /** Region ids, names or tags (`town`) it lives in. Empty = anywhere. */
  zones: string;
  /** all = needs BOTH its biomes and its zones; any = either one is enough (ash in a volcanic zone OR blight). */
  match: "all" | "any";
  /** never | only | any — town zones (region tag `town`). */
  town: "any" | "only" | "never";
  /** Water within `waterRadius`: true = the layer exists only there (sea spray). */
  needWater: boolean;
  /** Extra rate near water: 1.5 = two and a half times as many fireflies at the water's edge. */
  waterBoost: number;
  /** Particles per second at full strength. Live count ≈ rate × lifetime, always capped by the emitter's `max`. */
  rate: number;
  /** Extra rate at the height of a storm (leaves torn loose): rate × (1 + storm × this). */
  storm: number;
  /** Metres/second the wind carries it at full gust; 0 leaves the emitter's own aim alone. */
  wind: number;
  /** Vertical drift m/s added to the wind aim: negative falls (leaves, ash), positive rises (spray, spores). */
  rise: number;
  /** Brightness floor at night: 1 = self-lit (fireflies), 0.2 = only what the moon gives it (leaves). */
  glow: number;
}

/** What a layer is judged against — one sample of the world around the local player. */
export interface AmbientSample {
  /** Biome share (0..1) of the land around the player, by lowercase biome id. */
  biomes: Record<string, number>;
  region: Pick<RegionAt, "id" | "name" | "tags"> | null;
  /** 0..1 daylight. */
  daylight: number;
  /** 0..1 how close water is (1 = at the edge, 0 = none within range). */
  water: number;
  /** 0..1 storm × precipitation. */
  storm: number;
}

const DEFAULT_LAYERS: AmbientLayer[] = [
  { id: "fireflies", biomes: "grassland,forest,swamp,fen,jungle,moor,savanna", when: "night", zones: "", match: "all", town: "never", needWater: false, waterBoost: 1.5, rate: 6, storm: -1, wind: 0, rise: 0, glow: 1 },
  { id: "leaves", biomes: "forest,taiga,jungle", when: "always", zones: "", match: "all", town: "any", needWater: false, waterBoost: 0, rate: 5, storm: 2, wind: 3, rise: -0.7, glow: 0.22 },
  { id: "dust", biomes: "desert,badlands,savanna,crag", when: "day", zones: "", match: "all", town: "any", needWater: false, waterBoost: 0, rate: 5, storm: 1, wind: 1.5, rise: 0.05, glow: 0.2 },
  { id: "moths", biomes: "", when: "night", zones: "town", match: "all", town: "only", needWater: false, waterBoost: 0, rate: 1.2, storm: -1, wind: 0, rise: 0, glow: 0.6 },
  { id: "spray", biomes: "beach,seabed", when: "always", zones: "", match: "all", town: "any", needWater: true, waterBoost: 0, rate: 8, storm: 2, wind: 2.5, rise: 0.9, glow: 0.25 },
  { id: "spores", biomes: "swamp,fen", when: "always", zones: "", match: "any", town: "never", needWater: false, waterBoost: 0.5, rate: 4, storm: -0.7, wind: 0.4, rise: 0.12, glow: 0.5 },
  { id: "ash", biomes: "blight", when: "always", zones: "", match: "any", town: "any", needWater: false, waterBoost: 0, rate: 5, storm: 1, wind: 1.2, rise: -0.35, glow: 0.3 },
];

function list(value: unknown): string[] {
  return String(value ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function smooth01(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** A layer from scene JSON, with every field defaulted — a half-written layer still runs. */
export function normalizeLayer(raw: Partial<AmbientLayer> & { id: string }): AmbientLayer {
  const when = raw.when === "day" || raw.when === "night" ? raw.when : "always";
  return {
    id: String(raw.id),
    biomes: String(raw.biomes ?? ""),
    when,
    zones: String(raw.zones ?? ""),
    match: raw.match === "any" ? "any" : "all",
    town: raw.town === "only" || raw.town === "never" ? raw.town : "any",
    needWater: raw.needWater === true,
    waterBoost: Math.max(0, num(raw.waterBoost, 0)),
    rate: Math.max(0, num(raw.rate, 4)),
    storm: num(raw.storm, 0),
    wind: Math.max(0, num(raw.wind, 0)),
    rise: num(raw.rise, 0),
    glow: Math.min(1, Math.max(0, num(raw.glow, 0.25))),
  };
}

/** How much of the day a `when` is awake: eased so a layer fades through dusk rather than switching at it. */
export function timeWeight(when: AmbientLayer["when"], daylight: number): number {
  if (when === "always") return 1;
  const day = smooth01((daylight - 0.2) / 0.5);
  return when === "day" ? day : 1 - day;
}

/**
 * A layer's strength, 0..1+, for one world sample — the whole rule, pure, so
 * it is testable without a renderer. `majority` is the biome share at which a
 * layer starts to appear (full at twice that), the same guard the weather uses
 * against a sliver of forest dressing a meadow in leaves.
 */
export function layerStrength(layer: AmbientLayer, s: AmbientSample, majority = 0.3): number {
  const tags = s.region?.tags ?? [];
  const town = tags.includes("town");
  if (layer.town === "only" && !town) return 0;
  if (layer.town === "never" && town) return 0;
  if (layer.needWater && !(s.water > 0)) return 0;
  const biomes = list(layer.biomes);
  const zones = list(layer.zones);
  let biome = 1;
  if (biomes.length > 0) {
    let share = 0;
    for (const id of biomes) share += s.biomes[id] ?? 0;
    const m = Math.max(0.001, majority);
    biome = smooth01((share - m) / m);
  }
  let zone = 1;
  if (zones.length > 0) {
    const r = s.region;
    zone = r && zones.some((z) => z === r.id.toLowerCase() || z === r.name.toLowerCase() || tags.includes(z)) ? 1 : 0;
  }
  let place: number;
  if (layer.match === "any" && biomes.length > 0 && zones.length > 0) place = Math.max(biome, zone);
  else place = biome * zone;
  if (!(place > 0)) return 0;
  const time = timeWeight(layer.when, s.daylight);
  const water = 1 + layer.waterBoost * s.water;
  const storm = Math.max(0, 1 + layer.storm * s.storm);
  return place * time * water * storm;
}

const RING: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [0.71, 0.71], [-0.71, 0.71], [0.71, -0.71], [-0.71, -0.71],
];

interface LayerState {
  layer: AmbientLayer;
  emitter: string | null;
  target: number;
  current: number;
  /** What was last sent, so an unchanged layer costs no call at all. */
  sentRate: number;
  sentScale: number;
  sentAngle: number;
  /** Reused for every setParticles call on this layer — the tick allocates nothing. */
  readonly msg: { emitting: boolean; rate: number; colorScale: number; direction?: [number, number, number]; speed?: [number, number] };
  readonly dir: [number, number, number];
  readonly spd: [number, number];
}

/**
 * Ambient particles around the local player — fireflies at night, leaves in a
 * forest, ash in a burned zone, marsh spores, dust in dry country, moths in a
 * town after dark, spray on the shore.
 *
 * Each LAYER (the `layers` param) names one emitter hung off the player body
 * (tag `ambient-<id>`, like the weather's) and the rule for when it lives: a
 * biome share around the player, a time of day, zones, water. The script only
 * dials RATE, colour scale and wind aim; the look is the emitter's own data.
 *
 * Built to cost nothing when idle: presentation only (onLateUpdate — never on
 * a dedicated server), the world is sampled `sampleHz` times a second, a call
 * is made only when a layer's value actually changed, and every message object
 * is preallocated. An emitter at rate 0 with nothing alive skips its
 * simulation entirely. All layers share ONE sprite sheet (`fx/ambient-motes.png`,
 * a row strip per layer) so every ambient particle draws in one batch.
 */
export class AmbientParticles extends Script {
  static override scriptName = "ambient-particles";
  static override params = {
    layers: {
      default: DEFAULT_LAYERS,
      description:
        "Array of layers. Each: { id (drives the player child tagged `ambient-<id>`), biomes (comma list; empty = any), " +
        "when (day|night|always, eased across dusk/dawn), zones (comma list of region ids, names or tags; empty = anywhere), " +
        "match (all = biome AND zone; any = either — ash in a volcanic zone or in blight), town (any|only|never), " +
        "needWater (bool: only near water), waterBoost (extra rate × closeness to water), rate (particles/s at full), " +
        "storm (extra rate per unit storm; negative thins it out), wind (m/s the wind carries it at full gust; 0 = authored aim), " +
        "rise (vertical drift m/s, negative falls), glow (night brightness floor: 1 = self-lit) }. Missing fields default.",
    },
    sampleHz: { default: 2, min: 0.2, max: 10, description: "World samples per second (biome disc, zone, water, weather). Rates ease between samples." },
    fadeSeconds: { default: 4, min: 0.1, max: 60, description: "Seconds a layer takes to fade in or out when where/when you are changes." },
    biomeRadius: { default: 20, min: 0, max: 200, description: "Metres around the player the biome blend is averaged over (eight ring samples plus the centre)." },
    biomeMajority: { default: 0.3, min: 0, max: 1, description: "Biome share at which a layer starts to appear; full at about twice this." },
    waterRadius: { default: 22, min: 1, max: 200, description: "Metres within which water counts as near (sampled at the centre and four points at this distance)." },
    headHeight: { default: 1.6, min: 0, max: 4, description: "Metres from the body origin to the eyes: with the head under water every layer stops." },
  };
  static override commands: ScriptCommandDecl[] = [
    { name: "ambient", args: "[layer on|off|auto]", description: "Report the ambient particle layers around you, or force one on/off for testing." },
  ];

  private layers: LayerState[] = [];
  private layersSource: unknown = null;
  private sampleTimer = 0;
  private forced = new Map<string, number>();
  private sample: AmbientSample = { biomes: {}, region: null, daylight: 1, water: 0, storm: 0 };
  private windAngle = 0;
  private gust = 0;
  private underwater = false;
  private readonly blend: Record<string, number> = {};

  /** The tagged emitter on THIS tab's player (a server clones the body per joiner — see weather's ownEmitter). */
  private ownEmitter(tag: string): string | null {
    const found = this.ctx.findByTag(tag);
    if (found.length <= 1) return found[0] ?? null;
    const self = this.ctx.localPlayer?.() ?? null;
    if (self) {
      const mine = found.find((id) => id === self || id.startsWith(`${self}/`));
      if (mine) return mine;
    }
    return found[0] ?? null;
  }

  private rebuildLayers(): void {
    const raw = this.param<unknown>("layers");
    this.layersSource = raw;
    const arr = Array.isArray(raw) ? raw : [];
    const prev = new Map(this.layers.map((l) => [l.layer.id, l]));
    this.layers = [];
    for (const entry of arr) {
      if (!entry || typeof entry !== "object" || typeof (entry as { id?: unknown }).id !== "string") continue;
      const layer = normalizeLayer(entry as AmbientLayer);
      const old = prev.get(layer.id);
      this.layers.push({
        layer,
        emitter: old?.emitter ?? null,
        target: 0,
        current: old?.current ?? 0,
        sentRate: -1,
        sentScale: -1,
        sentAngle: Number.NaN,
        msg: { emitting: false, rate: 0, colorScale: 1 },
        dir: [0, 0, 0],
        spd: [0, 0],
      });
    }
  }

  override onStart(): void {
    this.rebuildLayers();
  }

  override onParamsChanged(): void {
    if (this.param<unknown>("layers") !== this.layersSource) this.rebuildLayers();
  }

  override onDispose(): void {
    for (const s of this.layers) if (s.emitter) this.ctx.setParticles?.(s.emitter, { emitting: false, rate: 0 });
  }

  override onLateUpdate(dt: number): void {
    if (!this.ctx.setParticles) return;
    this.sampleTimer -= dt;
    if (this.sampleTimer > 0) return;
    const step = 1 / Math.max(0.2, this.param<number>("sampleHz"));
    this.sampleTimer = step;
    this.takeSample();
    const k = Math.min(1, step / Math.max(0.1, this.param<number>("fadeSeconds")));
    const majority = this.param<number>("biomeMajority");
    for (const s of this.layers) {
      if (!s.emitter) s.emitter = this.ownEmitter(`ambient-${s.layer.id}`);
      const force = this.forced.get(s.layer.id);
      s.target = this.underwater ? 0 : force !== undefined ? force : layerStrength(s.layer, this.sample, majority);
      s.current += (s.target - s.current) * k;
      if (s.current < 0.01 && s.target === 0) s.current = 0;
      this.drive(s);
    }
  }

  private drive(s: LayerState): void {
    const id = s.emitter;
    if (!id) return;
    const L = s.layer;
    const rate = Math.round(L.rate * s.current * 100) / 100;
    const light = this.sample.daylight;
    const scale = Math.round((L.glow + (1 - L.glow) * light) * 50) / 50;
    const aimed = L.wind > 0 && rate > 0;
    const angleMoved = aimed && !(Math.abs(this.windAngle - s.sentAngle) < 0.05);
    if (rate === s.sentRate && scale === s.sentScale && !angleMoved) return;
    const msg = s.msg;
    msg.emitting = rate > 0;
    msg.rate = rate;
    msg.colorScale = scale;
    if (aimed) {
      const blow = L.wind * (0.35 + 0.65 * this.gust);
      s.dir[0] = Math.sin(this.windAngle) * blow;
      s.dir[1] = L.rise;
      s.dir[2] = Math.cos(this.windAngle) * blow;
      const speed = Math.hypot(s.dir[0], s.dir[1], s.dir[2]) || 1;
      s.spd[0] = speed * 0.6;
      s.spd[1] = speed * 1.3;
      msg.direction = s.dir;
      msg.speed = s.spd;
      s.sentAngle = this.windAngle;
    } else {
      msg.direction = undefined;
      msg.speed = undefined;
    }
    s.sentRate = rate;
    s.sentScale = scale;
    this.ctx.setParticles!(id, msg);
  }

  private takeSample(): void {
    const ctx = this.ctx;
    const s = this.sample;
    s.daylight = ctx.daylight?.() ?? 1;
    const w = ctx.netState?.get(WORLD_WEATHER_KEY) as { storm?: number; precipitation?: number; wind?: number; windAngle?: number } | undefined;
    s.storm = Math.min(1, Math.max(0, num(w?.storm, 0) * num(w?.precipitation, 0)));
    this.windAngle = num(w?.windAngle, this.windAngle);
    this.gust = Math.min(1, Math.max(0, num(w?.wind, 0.3)));
    const playerId = ctx.localPlayer?.() ?? ctx.findByTag("player")[0];
    const object = playerId ? ctx.getObject(playerId) : null;
    if (!object) {
      s.region = null;
      s.water = 0;
      for (const key in this.blend) delete this.blend[key];
      s.biomes = this.blend;
      return;
    }
    const { x, y, z } = object.position;
    s.region = ctx.regionAt?.(x, z) ?? null;
    // biome share over a disc (a clearing is not a new biome); reuses one record
    const blend = this.blend;
    for (const key in blend) blend[key] = 0;
    let total = 0;
    const add = (at: BiomeAt | null): void => {
      if (!at) return;
      for (const key in at.weights) {
        const v = at.weights[key]!;
        if (!(v > 0)) continue;
        const id = key.toLowerCase();
        blend[id] = (blend[id] ?? 0) + v;
        total += v;
      }
    };
    const biomeAt = ctx.biomeAt;
    if (biomeAt) {
      add(biomeAt(x, z));
      const r = this.param<number>("biomeRadius");
      if (r > 0) for (const [dx, dz] of RING) add(biomeAt(x + dx * r, z + dz * r));
    }
    if (total > 0) for (const key in blend) blend[key] = blend[key]! / total;
    s.biomes = blend;
    // water: under it stops everything; near it is a closeness 0..1
    s.water = 0;
    this.underwater = false;
    const waterAt = ctx.waterAt;
    if (waterAt) {
      const head = waterAt(x, y + this.param<number>("headHeight"), z);
      if (head && head.depth > 0) this.underwater = true;
      if (head) s.water = 1;
      else {
        const R = this.param<number>("waterRadius");
        for (let i = 0; i < 4; i++) {
          const [dx, dz] = RING[i]!;
          if (waterAt(x + dx * R, y + 40, z + dz * R)) {
            s.water = 0.5;
            break;
          }
        }
      }
    }
  }

  override onCommand(_name: string, args: string[]): string | null {
    const [which, mode] = [args[0]?.toLowerCase(), args[1]?.toLowerCase()];
    if (which && mode) {
      const targets = which === "all" ? this.layers.map((l) => l.layer.id) : [which];
      if (!targets.every((t) => this.layers.some((l) => l.layer.id === t))) throw new Error(`/ambient: no layer '${which}'`);
      for (const t of targets) {
        if (mode === "auto") this.forced.delete(t);
        else if (mode === "on") this.forced.set(t, 1);
        else if (mode === "off") this.forced.set(t, 0);
        else throw new Error("/ambient <layer|all> on|off|auto");
      }
      this.sampleTimer = 0;
    }
    const s = this.sample;
    const top = Object.entries(s.biomes)
      .filter(([, v]) => v > 0.05)
      .sort((a, b) => b[1] - a[1])
      .map(([id, v]) => `${id} ${Math.round(v * 100)}%`)
      .join(", ");
    const layers = this.layers
      .map((l) => `${l.layer.id} ${l.current.toFixed(2)}${this.forced.has(l.layer.id) ? "*" : ""}${l.emitter ? "" : " (no emitter)"}`)
      .join(" | ");
    return [
      `biomes: ${top || "none"} · zone: ${s.region?.name ?? "-"} · daylight ${s.daylight.toFixed(2)} · water ${s.water} · storm ${s.storm.toFixed(2)}${this.underwater ? " · UNDERWATER" : ""}`,
      `layers: ${layers || "none"}`,
    ].join("\n");
  }
}
