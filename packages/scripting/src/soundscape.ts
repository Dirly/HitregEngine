import { Script, type BiomeAt, type ScriptCommandDecl } from "./script.js";

/**
 * The hour the `daynight` script last showed, shared in-process so audio can
 * follow the same clock offline (where there is no replicated world.hour).
 * NaN until a clock runs.
 */
export const worldClock = { hour: Number.NaN };

/**
 * "Has the world around the player finished loading yet?" — latched: true
 * once streaming has been quiet for `need` seconds (or `maxWait` has passed,
 * so a world that never goes fully quiet still gets its sound). Later
 * streaming, as the player walks into new terrain, never un-latches it.
 * Shared by everything that must stay silent through a fresh spawn: the
 * soundscape, and footsteps from a body settling onto ground as it arrives.
 */
export class SettleLatch {
  ready = false;
  private quiet = 0;
  private waited = 0;
  tick(loading: boolean | undefined, dt: number, need = 2, maxWait = 45): boolean {
    if (this.ready) return true;
    // a host that cannot say (no worldLoading hook) has nothing streaming to wait for
    if (loading === undefined) return (this.ready = true);
    this.waited += dt;
    this.quiet = loading ? 0 : this.quiet + dt;
    if (this.quiet >= need || this.waited >= maxWait) this.ready = true;
    return this.ready;
  }
}

/** The world clock as audio hears it: the replicated hour, else the local day-night script's, else noon. */
function currentHour(ctx: { netState?: { get(key: string): unknown } }): number {
  const published = ctx.netState?.get("world.hour");
  if (typeof published === "number") return published;
  return Number.isFinite(worldClock.hour) ? worldClock.hour : 12;
}

/** Whether `hour` falls in "from-to" (24 h, wrapping midnight: "22-6"); an empty range is never. */
export function inHours(hour: number, range: string): boolean {
  const m = /^\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*$/.exec(range);
  if (!m) return false;
  const from = Number(m[1]), to = Number(m[2]);
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}

type Band = "dawn" | "day" | "dusk" | "night";
const BANDS: readonly Band[] = ["dawn", "day", "dusk", "night"];
/** [hour, band before, band after] — the same edges as the daynight script's bands (evening counts as night). */
const BAND_EDGES: ReadonlyArray<readonly [number, Band, Band]> = [
  [5, "night", "dawn"],
  [7.5, "dawn", "day"],
  [16.5, "day", "dusk"],
  [19.5, "dusk", "night"],
];
const RING: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [0.71, 0.71], [-0.71, 0.71], [0.71, -0.71], [-0.71, -0.71],
];

/** A `sound-zone` currently in the scene: tavern rooms, caves, crypts, forges. */
interface SoundZoneState {
  position(): { x: number; y: number; z: number } | null;
  radius: number;
  fade: number;
  priority: number;
  ambience: string;
  ambienceVolume: number;
  music: string;
  outdoorMix: number;
  spots: string;
}
const soundZones = new Set<SoundZoneState>();

/**
 * Default spot-emitter lists: biome → band → comma list of sound ids. An id
 * without an extension is a variant family (`spot/owl-hoot` = owl-hoot.mp3,
 * owl-hoot-2.mp3 …). `*` is any biome; `town` is used inside town zones.
 */
const DEFAULT_SPOTS: Record<string, Partial<Record<Band | "*", string>>> = {
  "*": {
    dawn: "spot/songbird-chirp,spot/blackbird-song",
    day: "spot/songbird-chirp,spot/crow-caw,spot/leaves-gust",
    dusk: "spot/blackbird-song,spot/crow-caw",
    night: "spot/owl-hoot,spot/cricket-burst,spot/twig-snap",
  },
  forest: {
    dawn: "spot/songbird-chirp,spot/blackbird-song,spot/woodpecker",
    day: "spot/songbird-chirp,spot/woodpecker,spot/crow-caw,spot/tree-creak,spot/twig-snap,spot/bee-buzz-pass",
    dusk: "spot/blackbird-song,spot/crow-caw,spot/tree-creak,spot/fox-bark",
    night: "spot/owl-hoot,spot/wolf-howl-distant,spot/cricket-burst,spot/twig-snap,spot/nightjar,spot/tree-creak",
  },
  taiga: {
    dawn: "spot/songbird-chirp,spot/woodpecker,spot/raven-croak",
    day: "spot/woodpecker,spot/raven-croak,spot/tree-creak,spot/branch-fall,spot/elk-bugle-distant",
    dusk: "spot/raven-croak,spot/elk-bugle-distant,spot/tree-creak",
    night: "spot/wolf-howl-distant,spot/wolf-pack-distant,spot/owl-hoot,spot/tree-creak,spot/snow-slump",
  },
  grassland: {
    dawn: "spot/songbird-chirp,spot/blackbird-song,spot/rooster",
    day: "spot/songbird-chirp,spot/bee-buzz-pass,spot/leaves-gust,spot/fly-buzz",
    dusk: "spot/blackbird-song,spot/cricket-burst,spot/fox-bark",
    night: "spot/cricket-burst,spot/owl-hoot,spot/wolf-howl-distant",
  },
  foothills: {
    day: "spot/songbird-chirp,spot/rock-fall-small",
    night: "spot/wolf-howl-distant,spot/owl-hoot,spot/cricket-burst",
  },
  moor: {
    day: "spot/crow-caw,spot/raven-croak,spot/leaves-gust",
    dusk: "spot/raven-croak,spot/heron-call",
    night: "spot/owl-hoot,spot/nightjar,spot/wolf-howl-distant",
  },
  fen: {
    dawn: "spot/heron-call,spot/frog-croak,spot/songbird-chirp",
    day: "spot/frog-croak,spot/heron-call,spot/fly-buzz,spot/bubble-pop-swamp",
    dusk: "spot/toad-chorus-burst,spot/heron-call,spot/frog-croak",
    night: "spot/toad-chorus-burst,spot/frog-croak,spot/loon-call,spot/owl-hoot",
  },
  swamp: {
    day: "spot/frog-croak,spot/fly-buzz,spot/bubble-pop-swamp,spot/heron-call",
    dusk: "spot/toad-chorus-burst,spot/bubble-pop-swamp,spot/crow-caw",
    night: "spot/toad-chorus-burst,spot/frog-croak,spot/bubble-pop-swamp,spot/owl-hoot",
  },
  jungle: {
    dawn: "spot/jungle-bird-exotic,spot/monkey-call-distant,spot/parrot-squawk",
    day: "spot/jungle-bird-exotic,spot/parrot-squawk,spot/monkey-call-distant,spot/cicada-swell,spot/fly-buzz",
    dusk: "spot/monkey-call-distant,spot/cicada-swell,spot/jungle-bird-exotic",
    night: "spot/cicada-swell,spot/frog-croak,spot/jungle-bird-exotic,spot/twig-snap",
  },
  savanna: {
    day: "spot/cicada-swell,spot/fly-buzz,spot/leaves-gust",
    dusk: "spot/cicada-swell,spot/cricket-burst",
    night: "spot/cricket-burst,spot/wolf-howl-distant,spot/owl-hoot",
  },
  desert: {
    day: "spot/sand-hiss-gust",
    dusk: "spot/sand-hiss-gust",
    night: "spot/sand-hiss-gust,spot/cricket-burst",
  },
  badlands: {
    day: "spot/sand-hiss-gust,spot/rock-fall-small,spot/raven-croak",
    night: "spot/wolf-howl-distant,spot/rock-fall-small,spot/sand-hiss-gust",
  },
  blight: {
    day: "spot/raven-croak,spot/eerie-whisper-wind,spot/bone-rattle,spot/crow-caw",
    dusk: "spot/eerie-whisper-wind,spot/distant-groan,spot/raven-croak",
    night: "spot/distant-groan,spot/eerie-whisper-wind,spot/bone-rattle,spot/owl-hoot",
    dawn: "spot/raven-croak,spot/eerie-whisper-wind",
  },
  beach: {
    "*": "spot/seagull,spot/gull-flock",
    night: "spot/loon-call,spot/cricket-burst",
  },
  tundra: {
    "*": "spot/ice-crack,spot/snow-slump,spot/raven-croak",
    night: "spot/wolf-howl-distant,spot/wolf-pack-distant,spot/ice-crack",
  },
  highland: {
    day: "spot/sheep-bleat,spot/raven-croak,spot/leaves-gust",
    night: "spot/wolf-howl-distant,spot/owl-hoot",
  },
  montane: {
    day: "spot/eagle-cry,spot/rock-fall-small,spot/tree-creak",
    night: "spot/wolf-howl-distant,spot/rock-fall-small,spot/owl-hoot",
  },
  alpine: {
    "*": "spot/eagle-cry,spot/rock-fall-small,spot/snow-slump,spot/ice-crack",
    night: "spot/rock-slide-distant,spot/snow-slump,spot/ice-crack",
  },
  crag: {
    "*": "spot/eagle-cry,spot/rock-fall-small,spot/rock-slide-distant,spot/raven-croak",
  },
  // Towns: a dog barks now and then far off; the bell is the CLOCK (clockBell,
  // on the hour), never a random spot. Nothing that MOVES near the player
  // (hooves, carts, footsteps, doors) — in a town that reads as somebody
  // being there who is not. (Derek, 2026-09-27)
  town: {
    dawn: "spot/dog-bark",
    day: "spot/dog-bark",
    dusk: "spot/dog-bark",
    night: "spot/owl-hoot",
  },
};

const DEFAULT_BIOME_ALIAS: Record<string, string> = { seabed: "beach", mountains: "montane" };
const COASTAL = ["beach", "seabed"];
const MOUNTAIN = ["montane", "alpine", "crag", "highland"];
const DRY = ["desert", "badlands", "savanna"];

interface Voice {
  slot: string;
  id: string;
  volume: number;
  target: number;
  /** Seconds per full-scale change: fast into combat, slow out of it. */
  fade: number;
}

/**
 * Soundscape — the world's background audio, WoW-style, for the local player:
 *
 *  - **Ambient beds**: the biome blend around the player × the time of day
 *    (dawn/day/dusk/night, crossfaded over `bandFadeHours`), a town layer in
 *    town zones, water beds near rivers/lakes/sea, altitude wind, an
 *    underwater bed with everything else ducked. Every bed is a looping
 *    sound id built from a pattern, so new art is a file drop, not code.
 *  - **Spot emitters**: positional one-shots (a crow, an owl, a wolf) placed
 *    around the player at random from per-biome, per-band lists.
 *  - **Music**: exploration tracks per biome (day/night) or per town, played
 *    ONCE and followed by silence (`musicGap`), the way long MMO sessions stay
 *    listenable; combat music cuts in fast while the local player's
 *    `userData.combatUntil` is in the future, and leaves slowly.
 *  - **Sound zones** (`sound-zone` script on an entity): taverns, caves,
 *    crypts — override the beds, the music and the spots within a radius.
 *
 * Presentation only, local to each client; absent audio hooks (a dedicated
 * server) make it a no-op.
 */
export class Soundscape extends Script {
  static override scriptName = "soundscape";
  static override params = {
    masterVolume: { default: 1, min: 0, max: 2, description: "Scales everything this script plays." },
    ambienceVolume: { default: 0.25, min: 0, max: 2, description: "Ambient beds (biome, town, water, wind)." },
    musicVolume: { default: 0.45, min: 0, max: 2, description: "Background music." },
    spotVolume: { default: 0.25, min: 0, max: 2, description: "Positional one-shot spot emitters." },
    bedPattern: {
      default: "ambience/biome/{biome}-{band}.ogg",
      description: "Biome bed sound id; {biome} = recipe biome id, {band} = dawn|day|dusk|night. A missing file falls back via biomeAlias, then fallbackBiome.",
    },
    fallbackBiome: { default: "grassland", description: "Biome whose beds stand in when a biome has none." },
    biomeAlias: { default: DEFAULT_BIOME_ALIAS, description: "Biome id → biome id whose sounds it borrows (beds, music, spots)." },
    biomeRadius: { default: 30, min: 0, max: 200, description: "Metres around the player the biome blend is averaged over (a clearing is not a new biome)." },
    biomeMinShare: { default: 0.2, min: 0, max: 1, description: "Share of the surrounding land a biome needs before its bed is heard; the top two survive." },
    bandFadeHours: { default: 1, min: 0.05, max: 4, description: "Game hours a dawn/day/dusk/night bed takes to hand over to the next." },
    settleSeconds: { default: 2, min: 0, max: 30, description: "Seconds the world must have finished loading before anything plays: no beds, spots or music while terrain streams in around a fresh spawn." },
    bedFadeSeconds: { default: 4, min: 0.1, max: 30, description: "Seconds a bed takes to fade in or out when what is around the player changes." },
    townBed: { default: "ambience/town/{daynight}.ogg", description: "Town layer in a zone tagged town; {daynight} = day|night." },
    townBedMix: { default: 0.4, min: 0, max: 2, description: "Town layer gain." },
    townBiomeMix: { default: 0.45, min: 0, max: 1, description: "How much of the biome bed is left under the town layer." },
    riverBed: { default: "ambience/water/river-medium.ogg", description: "Bed near flowing water." },
    lakeBed: { default: "ambience/water/lake-shore-lapping.ogg", description: "Bed near still inland water." },
    oceanBed: { default: "ambience/water/ocean-shore-calm.ogg", description: "Bed near the sea (water in beach/seabed country)." },
    waterRadius: { default: 28, min: 1, max: 120, description: "Metres at which a water bed starts to be heard; full at the water's edge." },
    waterMix: { default: 0.9, min: 0, max: 2, description: "Water bed gain at the edge." },
    underwaterBed: { default: "ambience/water/underwater.ogg", description: "Bed while the player's head is under water; everything else ducks." },
    headHeight: { default: 1.6, min: 0, max: 4, description: "Metres from the body origin to the ears, for the underwater test." },
    windBed: { default: "ambience/wind/mountain-howl.ogg", description: "High-altitude wind layer." },
    windStartY: { default: 160, min: -1000, max: 5000, description: "World Y the altitude wind starts to be heard." },
    windFullY: { default: 380, min: -1000, max: 5000, description: "World Y the altitude wind is at full gain." },
    windMix: { default: 0.6, min: 0, max: 2, description: "Altitude wind gain at full height." },
    musicPattern: { default: "music/biome/{biome}-{daynight}.ogg", description: "Exploration track per biome; {daynight} = day|night." },
    townMusic: {
      default: "",
      description:
        "Comma list of town tracks for every town zone ({daynight} allowed). Empty = pick by the town's country: " +
        "music/town/coastal-town, mountain-town, desert-town, else village-{daynight}.",
    },
    townMusicById: { default: {}, description: "Region id → comma list of tracks for that town (a capital's own theme)." },
    combatMusic: { default: "music/combat/normal-1.ogg,music/combat/normal-2.ogg", description: "Comma list, one picked per fight." },
    musicFade: { default: 5, min: 0.1, max: 30, description: "Seconds a track takes to crossfade to the next place's track." },
    combatFadeIn: { default: 1.2, min: 0.05, max: 10, description: "Seconds combat music takes to come in." },
    combatFadeOut: { default: 5, min: 0.1, max: 30, description: "Seconds combat music takes to leave once the fight is over." },
    musicGapMin: { default: 40, min: 0, max: 1800, description: "Least silence (s) after an exploration track before the next." },
    musicGapMax: { default: 150, min: 0, max: 1800, description: "Most silence (s) after an exploration track before the next." },
    spots: { default: DEFAULT_SPOTS, description: "Biome (or * or town) → band (or *) → comma list of spot sound ids; an id without extension is a variant family." },
    spotEveryMin: { default: 3, min: 0.2, max: 120, description: "Least seconds between spot emitters." },
    spotEveryMax: { default: 9, min: 0.2, max: 300, description: "Most seconds between spot emitters." },
    spotNear: { default: 10, min: 0, max: 200, description: "Nearest a spot sound is placed (m)." },
    spotFar: { default: 45, min: 1, max: 400, description: "Farthest a spot sound is placed (m)." },
    townSpotChance: { default: 0.12, min: 0, max: 1, description: "Share of spot turns that actually play inside a town zone: a town's own bed already carries its life, and a dog every few seconds is a barnyard." },
    clockBell: { default: "spot/clock-bell-strike", description: "Town clock: this bell (a variant family, one strike per file) tolls the hour in a town zone — once per hour, from the zone's hub. Empty = no clock." },
    clockBellVolume: { default: 0.45, min: 0, max: 2, description: "Gain of each clock strike." },
    clockBellQuiet: { default: "22-6", description: "Hours the clock keeps silent (from-to on the 24 h clock, wrapping midnight); empty tolls round the clock." },
    clockBellSpacing: { default: 2.4, min: 0.5, max: 10, description: "Seconds between strikes of one hour's toll." },
    clockBellRefDistance: { default: 45, min: 1, max: 400, description: "Distance (m) the clock is heard at full volume — a tower is heard across the whole town." },
    spotRefDistance: { default: 12, min: 0.5, max: 100, description: "Distance (m) a spot sound is heard at full volume." },
  };
  static override commands: ScriptCommandDecl[] = [
    { name: "music", args: "[next | off | on]", description: "Skip to the next track, mute or unmute music, or (bare) say what is playing." },
    { name: "soundscape", args: "", description: "What the soundscape hears around you: biomes, band, zone, beds and volumes." },
  ];

  private beds = new Map<string, Voice>();
  private music: Voice[] = [];
  private slotCounter = 0;
  private sampleTimer = 0;
  private musicContext = "";
  private musicList: string[] = [];
  private musicLastId = "";
  private musicElapsed = 0;
  /** Silence left before the next exploration track; < 0 = not waiting. */
  private musicGap = -1;
  private musicMuted = false;
  private spotTimer = 2;
  private settle = new SettleLatch();
  /** The clock: last whole hour seen, strikes still to ring, seconds to the next. */
  private lastHour: number | null = null;
  private strikesLeft = 0;
  private strikeIn = 0;
  private bellAt: [number, number, number] | null = null;
  private variantCache = new Map<string, string[]>();
  private status = { biomes: {} as Record<string, number>, bands: {} as Record<string, number>, region: "", zone: "", combat: false, underwater: false };

  override onStart(): void {
    // a scene without audio hooks (a dedicated server) never plays anything
  }

  override onDispose(): void {
    for (const v of this.beds.values()) this.ctx.setSoundLoop?.(v.slot);
    for (const v of this.music) this.ctx.setSoundLoop?.(v.slot);
    this.beds.clear();
    this.music = [];
  }

  override onLateUpdate(dt: number): void {
    if (!this.ctx.setSoundLoop) return;
    const player = this.playerObject();
    if (!player) return;
    if (!this.settle.ready) {
      // wait out the initial stream-in: a world loading around you is not a place yet
      if (!this.settle.tick(this.ctx.worldLoading?.(), dt, this.param<number>("settleSeconds"))) return;
      this.spotTimer = this.param<number>("spotEveryMin");
    }
    this.sampleTimer -= dt;
    if (this.sampleTimer <= 0) {
      this.sampleTimer = 0.25;
      this.sample(player);
    }
    this.fadeBeds(dt);
    this.driveClock(dt, player);
    this.driveMusic(dt);
    this.driveSpots(dt, player);
  }

  override onCommand(name: string, args: string[]): string | null {
    if (name === "soundscape" && !this.settle.ready) return "waiting for the world around you to finish loading";
    if (name === "soundscape") {
      const beds = [...this.beds.values()].filter((v) => v.volume > 0.01).map((v) => `${v.id} ${v.volume.toFixed(2)}`);
      const pct = (r: Record<string, number>) => Object.entries(r).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(", ");
      return [
        `biomes: ${pct(this.status.biomes) || "none"} · band: ${pct(this.status.bands)}`,
        `zone: ${this.status.region || "-"}${this.status.zone ? ` · sound zone ${this.status.zone}` : ""}${this.status.combat ? " · IN COMBAT" : ""}${this.status.underwater ? " · underwater" : ""}`,
        `beds: ${beds.join(" | ") || "none"}`,
        `music: ${this.musicLine()}`,
      ].join("\n");
    }
    const arg = (args[0] ?? "").toLowerCase();
    if (arg === "off") {
      this.musicMuted = true;
      for (const v of this.music) v.target = 0;
      return "music off";
    }
    if (arg === "on") {
      this.musicMuted = false;
      this.musicGap = 0;
      return "music on";
    }
    if (arg === "next") {
      this.startTrack(this.fadeFor(this.musicContext));
      return `music: ${this.musicLine()}`;
    }
    return `music: ${this.musicLine()}`;
  }

  // ------------------------------------------------------------------ sampling

  private playerObject(): { position: { x: number; y: number; z: number }; userData: Record<string, unknown> } | null {
    const id = this.ctx.localPlayer?.() ?? this.ctx.findByTag("player")[0];
    return (id ? this.ctx.getObject(id) : null) as { position: { x: number; y: number; z: number }; userData: Record<string, unknown> } | null;
  }

  private hour(): number {
    return currentHour(this.ctx);
  }

  /** Band weights for an hour, summing to 1, handing over across `bandFadeHours`. */
  private bandWeights(hour: number): Record<Band, number> {
    const w: Record<Band, number> = { dawn: 0, day: 0, dusk: 0, night: 0 };
    const half = this.param<number>("bandFadeHours") / 2;
    let band: Band = "night";
    for (const [edge, , after] of BAND_EDGES) if (hour >= edge) band = after;
    for (const [edge, before, after] of BAND_EDGES) {
      const d = hour - edge;
      if (Math.abs(d) < half) {
        const t = (d + half) / (2 * half);
        const s = t * t * (3 - 2 * t);
        w[before] = 1 - s;
        w[after] = s;
        return w;
      }
    }
    w[band] = 1;
    return w;
  }

  private biomeBlend(x: number, z: number): Record<string, number> {
    const biomeAt = this.ctx.biomeAt;
    if (!biomeAt) return {};
    const blend: Record<string, number> = {};
    let total = 0;
    const add = (at: BiomeAt | null): void => {
      if (!at) return;
      for (const [id, w] of Object.entries(at.weights)) {
        if (!(w > 0)) continue;
        blend[id] = (blend[id] ?? 0) + w;
        total += w;
      }
    };
    add(biomeAt(x, z));
    const r = this.param<number>("biomeRadius");
    if (r > 0) for (const [dx, dz] of RING) add(biomeAt(x + dx * r, z + dz * r));
    if (total <= 0) return {};
    const min = this.param<number>("biomeMinShare");
    const top = Object.entries(blend)
      .map(([id, w]) => [id, w / total] as const)
      .filter(([, s]) => s >= min)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2);
    const sum = top.reduce((a, [, s]) => a + s, 0);
    return Object.fromEntries(top.map(([id, s]) => [id, s / sum]));
  }

  private activeZone(p: { x: number; y: number; z: number }): { zone: SoundZoneState; weight: number } | null {
    let best: { zone: SoundZoneState; weight: number } | null = null;
    for (const zone of soundZones) {
      const at = zone.position();
      if (!at) continue;
      const d = Math.hypot(p.x - at.x, p.y - at.y, p.z - at.z);
      if (d > zone.radius) continue;
      const weight = zone.fade > 0 ? Math.min(1, (zone.radius - d) / zone.fade) : 1;
      if (!best || zone.priority > best.zone.priority || (zone.priority === best.zone.priority && weight > best.weight)) best = { zone, weight };
    }
    return best;
  }

  private sample(player: { position: { x: number; y: number; z: number }; userData: Record<string, unknown> }): void {
    const { x, y, z } = player.position;
    const targets = new Map<string, number>();
    const add = (id: string | undefined, v: number): void => {
      if (!id || !(v > 0.001) || !this.exists(id)) return;
      targets.set(id, (targets.get(id) ?? 0) + v);
    };
    const bands = this.bandWeights(this.hour());
    const biomes = this.biomeBlend(x, z);
    const region = this.ctx.regionAt?.(x, z) ?? null;
    const town = !!region?.tags.includes("town");
    const zoneHit = this.activeZone(player.position);
    const water = this.ctx.waterAt?.(x, y + this.param<number>("headHeight"), z) ?? null;
    const underwater = !!water && water.depth > 0;
    const combat = typeof player.userData["combatUntil"] === "number" && (player.userData["combatUntil"] as number) > this.ctx.now() / 1000;
    this.status = { biomes, bands: Object.fromEntries(Object.entries(bands).filter(([, w]) => w > 0)), region: region?.name ?? "", zone: zoneHit ? (zoneHit.zone.ambience || "zone") : "", combat, underwater };

    const amb = this.param<number>("ambienceVolume");
    // an interior swallows most of the outdoors
    const outdoor = zoneHit ? 1 - zoneHit.weight * (1 - zoneHit.zone.outdoorMix) : 1;
    const biomeGain = amb * outdoor * (town ? this.param<number>("townBiomeMix") : 1);
    for (const [biome, share] of Object.entries(biomes)) {
      for (const band of BANDS) {
        if (bands[band] > 0) add(this.bedFor(biome, band), share * bands[band] * biomeGain);
      }
    }
    const day = bands.day + bands.dawn * 0.5 + bands.dusk * 0.5;
    if (town) {
      const pattern = this.param<string>("townBed");
      const g = amb * outdoor * this.param<number>("townBedMix");
      add(pattern.replace("{daynight}", "day"), g * day);
      add(pattern.replace("{daynight}", "night"), g * (1 - day));
    }
    // water: the nearest wet sample on two rings decides how loud; what kind by its current and the country
    if (this.ctx.waterAt) {
      const R = this.param<number>("waterRadius");
      let near = Infinity;
      let flowing = false;
      for (const scale of [0, 0.35, 1]) {
        for (const [dx, dz] of scale === 0 ? [[0, 0] as const] : RING) {
          const wx = x + dx * R * scale, wz = z + dz * R * scale;
          const w = this.ctx.waterAt(wx, y + 50, wz);
          if (!w) continue;
          const d = Math.hypot(wx - x, wz - z);
          if (d < near) near = d;
          if (Math.hypot(w.current[0], w.current[1]) > 0.08) flowing = true;
        }
        if (near < Infinity) break;
      }
      if (near < Infinity) {
        const coastal = COASTAL.reduce((a, b) => a + (biomes[b] ?? 0), 0) > 0.15;
        const bed = flowing ? this.param<string>("riverBed") : coastal ? this.param<string>("oceanBed") : this.param<string>("lakeBed");
        add(bed, amb * outdoor * this.param<number>("waterMix") * Math.max(0.25, 1 - near / R));
      }
    }
    const wy0 = this.param<number>("windStartY"), wy1 = this.param<number>("windFullY");
    if (y > wy0) add(this.param<string>("windBed"), amb * outdoor * this.param<number>("windMix") * Math.min(1, (y - wy0) / Math.max(1, wy1 - wy0)));
    if (zoneHit?.zone.ambience) add(zoneHit.zone.ambience, zoneHit.weight * zoneHit.zone.ambienceVolume * amb);
    if (underwater) {
      for (const [id, v] of targets) targets.set(id, v * 0.08);
      add(this.param<string>("underwaterBed"), amb);
    }

    const master = this.param<number>("masterVolume");
    for (const v of this.beds.values()) v.target = 0;
    for (const [id, v] of targets) {
      let voice = this.beds.get(id);
      if (!voice) {
        voice = { slot: `bed:${id}`, id, volume: 0, target: 0, fade: this.param<number>("bedFadeSeconds") };
        this.beds.set(id, voice);
      }
      voice.target = Math.min(1.5, v * master);
    }

    // music context: combat > sound zone > town > biome
    const dominant = Object.entries(biomes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
    const daynight = day >= 0.5 ? "day" : "night";
    let context: string;
    let list: string[];
    if (combat) {
      context = "combat";
      list = this.split(this.param<string>("combatMusic"));
    } else if (zoneHit && zoneHit.weight > 0.5 && zoneHit.zone.music) {
      context = `zone:${zoneHit.zone.music}`;
      list = this.split(zoneHit.zone.music.replace(/\{daynight\}/g, daynight));
    } else if (town && region) {
      context = `town:${region.id}:${daynight}`;
      list = this.townTracks(region.id, biomes, daynight);
    } else if (underwater) {
      context = this.musicContext; // keep whatever was playing
      list = this.musicList;
    } else {
      context = `biome:${dominant}:${daynight}`;
      list = this.biomeTracks(dominant, daynight);
    }
    this.musicList = list.filter((id) => this.exists(id));
    if (context !== this.musicContext) {
      const leavingCombat = this.musicContext === "combat";
      this.musicContext = context;
      if (context === "combat") this.startTrack(this.param<number>("combatFadeIn"));
      else if (leavingCombat) {
        for (const v of this.music) v.fade = this.param<number>("combatFadeOut");
        for (const v of this.music) v.target = 0;
        this.musicGap = this.param<number>("combatFadeOut") + 4;
      } else this.startTrack(this.param<number>("musicFade"));
    }
  }

  private fadeFor(context: string): number {
    return context === "combat" ? this.param<number>("combatFadeIn") : this.param<number>("musicFade");
  }

  private bedFor(biome: string, band: Band): string | undefined {
    const pattern = this.param<string>("bedPattern");
    const alias = this.param<Record<string, string>>("biomeAlias") ?? {};
    for (const b of [biome, alias[biome], this.param<string>("fallbackBiome")]) {
      if (!b) continue;
      const id = pattern.replace("{biome}", b).replace("{band}", band);
      if (this.exists(id)) return id;
    }
    return undefined;
  }

  private biomeTracks(biome: string, daynight: string): string[] {
    const pattern = this.param<string>("musicPattern");
    const alias = this.param<Record<string, string>>("biomeAlias") ?? {};
    for (const b of [biome, alias[biome], this.param<string>("fallbackBiome")]) {
      if (!b) continue;
      const id = pattern.replace("{biome}", b).replace("{daynight}", daynight);
      if (this.exists(id)) return [id];
    }
    return [];
  }

  private townTracks(regionId: string, biomes: Record<string, number>, daynight: string): string[] {
    const own = (this.param<Record<string, string>>("townMusicById") ?? {})[regionId];
    if (own) return this.split(own.replace(/\{daynight\}/g, daynight));
    const all = this.param<string>("townMusic");
    if (all) return this.split(all.replace(/\{daynight\}/g, daynight));
    const share = (ids: string[]) => ids.reduce((a, b) => a + (biomes[b] ?? 0), 0);
    if (share(COASTAL) > 0.2) return ["music/town/coastal-town.ogg"];
    if (share(MOUNTAIN) > 0.4) return ["music/town/mountain-town.ogg"];
    if (share(DRY) > 0.4) return ["music/town/desert-town.ogg"];
    return [`music/town/village-${daynight}.ogg`];
  }

  // ------------------------------------------------------------------ beds

  private fadeBeds(dt: number): void {
    for (const [id, v] of this.beds) {
      const step = dt / Math.max(0.05, v.fade);
      v.volume += Math.max(-step, Math.min(step, v.target - v.volume));
      if (v.volume <= 0.001 && v.target === 0) {
        this.ctx.setSoundLoop!(v.slot);
        this.beds.delete(id);
        continue;
      }
      this.ctx.setSoundLoop!(v.slot, v.id, { volume: v.volume, positional: false });
    }
  }

  // ------------------------------------------------------------------ music

  private startTrack(fade: number): void {
    for (const v of this.music) {
      v.fade = fade;
      v.target = 0;
    }
    this.musicGap = -1;
    if (this.musicMuted || this.musicList.length === 0) return;
    const pool = this.musicList.length > 1 ? this.musicList.filter((id) => id !== this.musicLastId) : this.musicList;
    const id = pool[Math.floor(Math.random() * pool.length)]!;
    this.musicLastId = id;
    this.musicElapsed = 0;
    // a fresh slot every time: a looping slot re-used with the same id would carry on instead of restarting
    this.music.push({ slot: `music:${this.slotCounter++}`, id, volume: 0, target: 1, fade });
  }

  private driveMusic(dt: number): void {
    const gain = this.param<number>("musicVolume") * this.param<number>("masterVolume") * (this.status.underwater ? 0.35 : 1);
    this.musicElapsed += dt;
    const current = this.music[this.music.length - 1];
    if (current && current.target > 0 && this.musicContext !== "combat") {
      // exploration plays once, then silence: fade out as the track runs out
      const length = this.ctx.soundDuration?.(current.id);
      const fade = this.param<number>("musicFade");
      if (length !== undefined && this.musicElapsed >= length - fade) {
        current.fade = fade;
        current.target = 0;
        const lo = this.param<number>("musicGapMin"), hi = Math.max(lo, this.param<number>("musicGapMax"));
        this.musicGap = fade + lo + Math.random() * (hi - lo);
      }
    }
    if (this.musicGap >= 0) {
      this.musicGap -= dt;
      if (this.musicGap < 0) this.startTrack(this.param<number>("musicFade"));
    } else if (!current && !this.musicMuted && this.musicList.length > 0) {
      this.startTrack(this.fadeFor(this.musicContext));
    }
    this.music = this.music.filter((v) => {
      const step = dt / Math.max(0.05, v.fade);
      v.volume += Math.max(-step, Math.min(step, v.target - v.volume));
      if (v.volume <= 0.001 && v.target === 0) {
        this.ctx.setSoundLoop!(v.slot);
        return false;
      }
      this.ctx.setSoundLoop!(v.slot, v.id, { volume: v.volume * gain, positional: false });
      return true;
    });
  }

  private musicLine(): string {
    const playing = this.music.filter((v) => v.target > 0).map((v) => v.id);
    if (this.musicMuted) return "muted";
    if (playing.length) return `${playing.join(", ")} (${this.musicContext})`;
    if (this.musicGap >= 0) return `silence for ${Math.round(this.musicGap)} s (${this.musicContext})`;
    return `nothing for ${this.musicContext || "this place"}`;
  }

  // ------------------------------------------------------------------ clock

  /** Toll the hour (1-12 strikes) from the town's hub, as the clock crosses it. */
  private driveClock(dt: number, player: { position: { x: number; y: number; z: number } }): void {
    const family = this.param<string>("clockBell");
    if (!family || !this.ctx.playSound) return;
    const hour = Math.floor(this.hour());
    // only the clock PASSING an hour strikes it: a /time jump or a spawn does not
    const crossed = this.lastHour !== null && (hour - this.lastHour + 24) % 24 === 1;
    this.lastHour = hour;
    if (crossed && !inHours(hour, this.param<string>("clockBellQuiet"))) {
      const region = this.ctx.regionAt?.(player.position.x, player.position.z) ?? null;
      if (region?.tags.includes("town")) {
        const [hx, hz] = region.hub ?? [player.position.x, player.position.z - 60];
        const ground = this.ctx.biomeAt?.(hx, hz)?.ground ?? player.position.y;
        this.bellAt = [hx, ground + 20, hz];
        this.strikesLeft = ((hour + 11) % 12) + 1;
        this.strikeIn = 0;
      }
    }
    if (this.strikesLeft <= 0 || !this.bellAt) return;
    this.strikeIn -= dt;
    if (this.strikeIn > 0) return;
    const files = this.variants(family);
    if (files.length) {
      this.ctx.playSound(files[Math.floor(Math.random() * files.length)]!, {
        at: this.bellAt,
        volume: this.param<number>("clockBellVolume") * this.param<number>("masterVolume"),
        refDistance: this.param<number>("clockBellRefDistance"),
        priority: 4,
      });
    }
    this.strikesLeft--;
    this.strikeIn = this.param<number>("clockBellSpacing");
  }

  // ------------------------------------------------------------------ spots

  private driveSpots(dt: number, player: { position: { x: number; y: number; z: number } }): void {
    if (!this.ctx.playSound) return;
    this.spotTimer -= dt;
    if (this.spotTimer > 0) return;
    const lo = this.param<number>("spotEveryMin"), hi = Math.max(lo, this.param<number>("spotEveryMax"));
    this.spotTimer = lo + Math.random() * (hi - lo);
    if (this.status.underwater) return;
    const zone = this.activeZone(player.position);
    let pool: string[];
    if (zone && zone.weight > 0.5) pool = this.split(zone.zone.spots);
    else {
      const band = (Object.entries(this.status.bands).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "day") as Band;
      const spots = this.param<Record<string, Partial<Record<Band | "*", string>>>>("spots") ?? {};
      const alias = this.param<Record<string, string>>("biomeAlias") ?? {};
      const biomes = Object.entries(this.status.biomes);
      // weighted pick of a biome, the town list standing in for it inside town
      let key = "*";
      if (this.status.region && this.ctx.regionAt?.(player.position.x, player.position.z)?.tags.includes("town")) {
        if (Math.random() > this.param<number>("townSpotChance")) return;
        key = "town";
      }
      else if (biomes.length) {
        let r = Math.random();
        for (const [id, s] of biomes) {
          key = spots[id] ? id : alias[id] && spots[alias[id]!] ? alias[id]! : "*";
          if ((r -= s) <= 0) break;
        }
      }
      const table = spots[key] ?? spots["*"] ?? {};
      pool = this.split(table[band] ?? table["*"] ?? spots["*"]?.[band] ?? "");
    }
    const files = pool.flatMap((id) => this.variants(id));
    if (!files.length) return;
    const id = files[Math.floor(Math.random() * files.length)]!;
    const near = this.param<number>("spotNear"), far = Math.max(near, this.param<number>("spotFar"));
    const angle = Math.random() * Math.PI * 2;
    const dist = near + Math.random() * (far - near);
    const px = player.position.x + Math.cos(angle) * dist;
    const pz = player.position.z + Math.sin(angle) * dist;
    const ground = this.ctx.biomeAt?.(px, pz)?.ground ?? player.position.y;
    this.ctx.playSound(id, {
      at: [px, Math.max(ground, player.position.y - 4) + 1 + Math.random() * 6, pz],
      volume: this.param<number>("spotVolume") * this.param<number>("masterVolume") * (0.6 + Math.random() * 0.4),
      refDistance: this.param<number>("spotRefDistance"),
      playbackRate: 0.94 + Math.random() * 0.12,
      priority: -1,
    });
  }

  // ------------------------------------------------------------------ ids

  private split(list: string): string[] {
    return list.split(",").map((s) => s.trim()).filter(Boolean);
  }

  private exists(id: string): boolean {
    return this.ctx.hasSound ? this.ctx.hasSound(id) : true;
  }

  /** `spot/owl-hoot` → every generated variant of it; an id with an extension is itself. */
  private variants(id: string): string[] {
    let files = this.variantCache.get(id);
    if (!files) {
      if (/\.(mp3|ogg|wav)$/.test(id)) files = this.exists(id) ? [id] : [];
      else {
        files = [];
        for (const ext of ["mp3", "ogg", "wav"]) {
          if (!this.exists(`${id}.${ext}`)) continue;
          files.push(`${id}.${ext}`);
          for (let n = 2; n <= 12 && this.exists(`${id}-${n}.${ext}`); n++) files.push(`${id}-${n}.${ext}`);
          break;
        }
      }
      this.variantCache.set(id, files);
    }
    return files;
  }
}

/**
 * Sound zone — a sphere that swaps the soundscape inside it: a tavern's crowd
 * and folk band, a cave's drips and its own music, a forge's roar. The
 * `soundscape` script (one per scene) reads every zone; the highest priority
 * containing the player wins, blended in over `fade` metres.
 */
export class SoundZone extends Script {
  static override scriptName = "sound-zone";
  static override params = {
    radius: { default: 10, min: 0.5, max: 500, description: "Sphere radius (m) around this entity." },
    fade: { default: 3, min: 0, max: 100, description: "Metres inside the edge over which the zone blends in." },
    priority: { default: 0, min: -100, max: 100, description: "Higher wins where zones overlap (a tavern cellar inside a town zone)." },
    ambience: { default: "", description: "Loop played inside, e.g. ambience/interior/tavern-busy.ogg." },
    ambienceVolume: { default: 1, min: 0, max: 2, description: "Gain of that loop." },
    music: { default: "", description: "Comma list of tracks inside ({daynight} allowed), e.g. music/tavern/jig.ogg,music/tavern/ballad.ogg. Empty keeps the outdoor music." },
    outdoorMix: { default: 0.15, min: 0, max: 1, description: "How much of the outdoor beds are still heard inside (0 = sealed room)." },
    spots: { default: "", description: "Comma list of spot sounds inside (variant families allowed). Empty = none." },
  };

  private state: SoundZoneState | null = null;

  override onStart(): void {
    const object = this.object;
    const at = { x: 0, y: 0, z: 0 };
    const self = this;
    this.state = {
      // world translation straight off the matrix: a zone parented under a building moves with it
      position: () => {
        if (!object) return null;
        const e = object.matrixWorld.elements;
        at.x = e[12]!;
        at.y = e[13]!;
        at.z = e[14]!;
        return at;
      },
      get radius() { return self.param<number>("radius"); },
      get fade() { return self.param<number>("fade"); },
      get priority() { return self.param<number>("priority"); },
      get ambience() { return self.param<string>("ambience"); },
      get ambienceVolume() { return self.param<number>("ambienceVolume"); },
      get music() { return self.param<string>("music"); },
      get outdoorMix() { return self.param<number>("outdoorMix"); },
      get spots() { return self.param<string>("spots"); },
    };
    soundZones.add(this.state);
  }

  override onDispose(): void {
    if (this.state) soundZones.delete(this.state);
    this.state = null;
  }
}

/** Ready-made workshops for `sound-emitter`: set `preset` and place the entity at the anvil / bench. */
const EMITTER_PRESETS: Record<string, { loop: string; shots: string; extras: string; hours: string }> = {
  blacksmith: {
    loop: "ambience/workshop/forge-bed.ogg",
    shots: "workshop/smith/anvil-strike@0.8,workshop/smith/anvil-strike@0.8,workshop/smith/hammer-hot-metal@0.9,workshop/smith/anvil-tap@0.45",
    extras: "workshop/smith/quench,workshop/smith/bellows,workshop/smith/bellows,workshop/smith/tongs,workshop/smith/grindstone,workshop/smith/metal-set-down",
    hours: "7-19",
  },
  carpenter: {
    loop: "ambience/workshop/carpentry-bed.ogg",
    shots: "workshop/wood/saw-stroke@0.72,workshop/wood/saw-stroke@0.72,workshop/wood/hand-plane@1.15,workshop/wood/chisel-mallet@0.8,workshop/wood/hammer-nail@0.6,workshop/wood/rasp@0.85",
    extras: "workshop/wood/saw-cut-through,workshop/wood/plank-set-down,workshop/wood/auger-drill",
    hours: "7-19",
  },
  woodcutter: {
    loop: "",
    shots: "workshop/wood/axe-split@2.2",
    extras: "workshop/wood/plank-set-down",
    hours: "7-18",
  },
};

/**
 * Sound emitter — a place that WORKS: a forge, a carpenter's bench, a
 * woodcutter's block. A quiet positional bed (`loop`) plus bursts of
 * one-shots at a working rhythm: a burst picks one activity from `shots`
 * (`family@beat` — sawing is saw strokes 0.72 s apart, a smith's anvil is
 * blows 0.8 s apart) and repeats it a few times, then a rest, sometimes
 * broken by an `extras` sound (the quench, the bellows, a plank set down).
 * Works only during `hours`; the bed stays. Presentation only, silent until
 * the world has loaded in (SettleLatch).
 */
export class SoundEmitter extends Script {
  static override scriptName = "sound-emitter";
  static override params = {
    preset: { default: "", description: "blacksmith | carpenter | woodcutter — fills loop/shots/extras/hours; any of those set here wins." },
    loop: { default: "", description: "Positional bed at this entity (e.g. ambience/workshop/forge-bed.ogg). Empty = none." },
    loopVolume: { default: 0.35, min: 0, max: 2, description: "Gain of the bed." },
    shots: { default: "", description: "Comma list of activities, each a variant family with an optional @beat (seconds between repeats), e.g. workshop/wood/saw-stroke@0.72. Repeat an entry to weight it." },
    shotVolume: { default: 0.6, min: 0, max: 2, description: "Gain of the working sounds." },
    burstMin: { default: 3, min: 1, max: 40, description: "Fewest repeats in one burst of work." },
    burstMax: { default: 8, min: 1, max: 40, description: "Most repeats in one burst of work." },
    restMin: { default: 3, min: 0, max: 300, description: "Least seconds of rest between bursts." },
    restMax: { default: 10, min: 0, max: 600, description: "Most seconds of rest between bursts." },
    extras: { default: "", description: "Comma list of occasional sounds played in a rest (variant families)." },
    extrasChance: { default: 0.4, min: 0, max: 1, description: "Chance a rest carries one of the extras." },
    hours: { default: "", description: "Working hours, from-to on the 24 h clock (e.g. 7-19); empty = always. Outside them only the bed plays." },
    refDistance: { default: 5, min: 0.5, max: 100, description: "Metres the sounds are at full volume; they fall off beyond." },
  };

  private settle = new SettleLatch();
  private left = 0;
  private family = "";
  private beat = 0.8;
  private next = 1;
  private files = new Map<string, string[]>();

  override onDispose(): void {
    this.ctx.setSoundLoop?.("emitter");
  }

  private p(key: "loop" | "shots" | "extras" | "hours"): string {
    const own = this.param<string>(key);
    if (own) return own;
    return EMITTER_PRESETS[this.param<string>("preset")]?.[key] ?? "";
  }

  override onLateUpdate(dt: number): void {
    if (!this.ctx.playSound) return;
    if (!this.settle.tick(this.ctx.worldLoading?.(), dt)) return;
    const loop = this.p("loop");
    if (loop && this.ctx.setSoundLoop) {
      this.ctx.setSoundLoop("emitter", loop, { volume: this.param<number>("loopVolume"), positional: true, refDistance: this.param<number>("refDistance") });
    }
    const hours = this.p("hours");
    if (hours && !inHours(currentHour(this.ctx), hours)) return;
    this.next -= dt;
    if (this.next > 0) return;
    if (this.left > 0) {
      this.play(this.family, this.param<number>("shotVolume"));
      this.left--;
      this.next = this.beat * (0.9 + Math.random() * 0.2);
      return;
    }
    // between bursts: rest, maybe with an extra, then choose the next activity
    const extras = split(this.p("extras"));
    if (extras.length && Math.random() < this.param<number>("extrasChance")) {
      this.play(extras[Math.floor(Math.random() * extras.length)]!, this.param<number>("shotVolume") * 0.8);
    }
    const shots = split(this.p("shots"));
    const pick = shots[Math.floor(Math.random() * shots.length)];
    if (!pick) {
      this.next = 5;
      return;
    }
    const [family, beat] = pick.split("@");
    this.family = family!.trim();
    this.beat = Math.max(0.1, Number(beat) || 0.8);
    const lo = this.param<number>("burstMin"), hi = Math.max(lo, this.param<number>("burstMax"));
    this.left = Math.round(lo + Math.random() * (hi - lo));
    const rlo = this.param<number>("restMin"), rhi = Math.max(rlo, this.param<number>("restMax"));
    this.next = rlo + Math.random() * (rhi - rlo);
  }

  private play(family: string, volume: number): void {
    let files = this.files.get(family);
    if (!files) {
      const has = (f: string) => (this.ctx.hasSound ? this.ctx.hasSound(f) : true);
      files = [];
      if (/\.(mp3|ogg|wav)$/.test(family)) files = has(family) ? [family] : [];
      else for (const ext of ["mp3", "ogg"]) {
        if (!has(`${family}.${ext}`)) continue;
        files.push(`${family}.${ext}`);
        for (let n = 2; n <= 12 && has(`${family}-${n}.${ext}`); n++) files.push(`${family}-${n}.${ext}`);
        break;
      }
      this.files.set(family, files);
    }
    if (!files.length) return;
    const e = this.object.matrixWorld.elements;
    this.ctx.playSound!(files[Math.floor(Math.random() * files.length)]!, {
      at: [e[12]!, e[13]! + 1, e[14]!],
      volume,
      refDistance: this.param<number>("refDistance"),
      playbackRate: 0.96 + Math.random() * 0.08,
      priority: 1,
    });
  }
}

function split(list: string): string[] {
  return list.split(",").map((s) => s.trim()).filter(Boolean);
}
