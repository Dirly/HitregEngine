/**
 * The player's Graphics settings: one shared module for both hosts (main.ts and play.ts), so a machine that cannot keep
 * up can trade looks for speed. This file is the logic and carries no DOM and no three: presets, what a stored value
 * may be, what each setting asks of the engine, the Auto preset's stepping, and the binding that pushes settings into
 * the render systems. `graphics-panel.ts` is the panel.
 *
 * High is the game as authored, so a player who never opens the panel sees what the world's authors saw.
 *
 *   ?gfx=low                     one run at a preset, nothing saved (A/B through town-perf --query)
 *   ?gfx=high,shadows:off        a preset with fields changed, same format as the stored fields
 *   ?renderScale=0.75            still pins the render scale, over any setting
 */
import type { ChunkStreamerData } from "@hitreg/core";

export const SHADOW_LEVELS = ["off", "low", "medium", "high", "ultra"] as const;
export type ShadowLevel = (typeof SHADOW_LEVELS)[number];
export const PRESET_TIERS = ["low", "medium", "high", "ultra"] as const;
export type PresetTier = (typeof PRESET_TIERS)[number];
export type GraphicsPreset = PresetTier | "auto" | "custom";
/** Render scale choices: "auto" follows the frame (adaptive-resolution.ts), a number pins that share of the pixels. */
export const RENDER_SCALES = ["auto", 1, 0.85, 0.7, 0.5] as const;
export type RenderScaleChoice = "auto" | number;

/** The fields a preset decides. */
export interface GraphicsValues {
  renderScale: RenderScaleChoice;
  shadows: ShadowLevel;
  /** Share of the authored ground cover, 0..1 (0 = none). */
  grass: number;
  /** Share of the falling weather's particles, 0..1 (0 = none; the sky still turns). */
  weather: number;
  /** Detail held at distance, 0.5..1.25. Lower: trees turn to billboards sooner and small clutter drops sooner. */
  lod: number;
  /** Streamed world reach, 0.5..1.25 of the authored rings. Past it the one-mesh horizon carries the land. */
  drawDistance: number;
  /** Ambient occlusion: contact shading in every creased corner of the world. On unless a player needs the frames. */
  ao: boolean;
}

export interface GraphicsSettings extends GraphicsValues {
  preset: GraphicsPreset;
  /** The tier the Auto preset last settled on: kept so a next session starts where this one ended. */
  autoTier: PresetTier;
}

export const PRESETS: Record<PresetTier, GraphicsValues> = {
  low: { renderScale: 0.7, shadows: "off", grass: 0.35, weather: 0.35, lod: 0.6, drawDistance: 0.6, ao: false },
  medium: { renderScale: 0.85, shadows: "medium", grass: 0.65, weather: 0.65, lod: 0.8, drawDistance: 0.8, ao: true },
  high: { renderScale: "auto", shadows: "high", grass: 1, weather: 1, lod: 1, drawDistance: 1, ao: true },
  ultra: { renderScale: 1, shadows: "ultra", grass: 1, weather: 1, lod: 1.25, drawDistance: 1.25, ao: true },
};

/** High, not Auto: Auto would quietly change the picture of every headless shot and dev session on a busy machine. */
export const DEFAULT_GRAPHICS: GraphicsSettings = { preset: "high", autoTier: "high", ...PRESETS.high };

const LOD_RANGE = [0.5, 1.25] as const;
const DRAW_RANGE = [0.5, 1.25] as const;

const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));
const finite = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

function renderScaleOf(value: unknown, fallback: RenderScaleChoice): RenderScaleChoice {
  if (value === "auto") return "auto";
  return typeof value === "number" && value > 0 && value <= 1 ? value : fallback;
}

/** Any stored or hand-typed object as valid settings: unknown fields go, bad fields fall back to the default. */
export function normalizeGraphics(raw: unknown): GraphicsSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof GraphicsSettings, unknown>>;
  const d = DEFAULT_GRAPHICS;
  const preset = r.preset === "auto" || r.preset === "custom" || PRESET_TIERS.includes(r.preset as PresetTier) ? (r.preset as GraphicsPreset) : d.preset;
  const autoTier = PRESET_TIERS.includes(r.autoTier as PresetTier) ? (r.autoTier as PresetTier) : d.autoTier;
  // A named preset is its CURRENT values: stored fields from an older build would otherwise keep running under the
  // preset's name after the preset changed (Derek 2026-11-09: "High" in the menu, old values on screen, a shadow pop
  // that stopped once he re-picked High). Only "custom" keeps its own fields.
  if (preset !== "custom") return { preset, autoTier, ...PRESETS[preset === "auto" ? autoTier : preset] };
  return {
    preset,
    autoTier,
    renderScale: renderScaleOf(r.renderScale, d.renderScale),
    shadows: SHADOW_LEVELS.includes(r.shadows as ShadowLevel) ? (r.shadows as ShadowLevel) : d.shadows,
    grass: clamp(finite(r.grass, d.grass), 0, 1),
    weather: clamp(finite(r.weather, d.weather), 0, 1),
    lod: clamp(finite(r.lod, d.lod), LOD_RANGE[0], LOD_RANGE[1]),
    drawDistance: clamp(finite(r.drawDistance, d.drawDistance), DRAW_RANGE[0], DRAW_RANGE[1]),
    // `?gfx=high,ao:0` arrives as a number
    ao: r.ao === 0 || r.ao === "off" ? false : r.ao === 1 || r.ao === "on" ? true : typeof r.ao === "boolean" ? r.ao : d.ao,
  };
}

/** Choosing a preset: its values land on every field. Auto starts from the tier it last settled on. */
export function applyPreset(settings: GraphicsSettings, preset: GraphicsPreset): GraphicsSettings {
  if (preset === "custom") return { ...settings, preset };
  return { ...settings, ...PRESETS[preset === "auto" ? settings.autoTier : preset], preset };
}

/** Changing one field by hand: that is a custom setup from here on, and Auto stops moving things. */
export function changeField(settings: GraphicsSettings, change: Partial<GraphicsValues>): GraphicsSettings {
  return normalizeGraphics({ ...settings, ...change, preset: "custom" });
}

/** `?gfx=<preset>[,<field>:<value>...]` over `base`, or null with no `gfx`. For one run: the caller does not save it. */
export function graphicsFromSearch(search: string, base: GraphicsSettings): GraphicsSettings | null {
  const raw = new URLSearchParams(search).get("gfx");
  if (raw === null) return null;
  let out = base;
  for (const part of raw.split(",")) {
    const [key, value] = part.split(":") as [string, string | undefined];
    if (value === undefined) {
      if (key === "auto" || PRESET_TIERS.includes(key as PresetTier)) out = applyPreset(out, key as GraphicsPreset);
      continue;
    }
    const parsed = value !== "" && Number.isFinite(Number(value)) ? Number(value) : value;
    out = changeField(out, { [key]: parsed });
  }
  return out;
}

export const GRAPHICS_STORAGE_KEY = "hitreg:graphics";
export type SettingsStorage = Pick<Storage, "getItem" | "setItem">;

/** The saved settings; defaults when storage is missing, blocked or holds garbage. */
export function loadGraphics(storage: SettingsStorage | null | undefined): GraphicsSettings {
  try {
    const stored = storage?.getItem(GRAPHICS_STORAGE_KEY);
    return normalizeGraphics(stored ? JSON.parse(stored) : null);
  } catch {
    return normalizeGraphics(null);
  }
}

export function saveGraphics(storage: SettingsStorage | null | undefined, settings: GraphicsSettings): void {
  try {
    storage?.setItem(GRAPHICS_STORAGE_KEY, JSON.stringify(settings));
  } catch { /* private window or a full store: the settings just last this session */ }
}

/** What a shadow level asks of the sun, as multiples of the authored map size and distance. */
export function shadowQualityOf(level: ShadowLevel): { enabled: boolean; mapScale: number; reach: number } {
  switch (level) {
    case "off": return { enabled: false, mapScale: 0.5, reach: 0.4 };
    case "low": return { enabled: true, mapScale: 0.5, reach: 0.4 };
    case "medium": return { enabled: true, mapScale: 1, reach: 0.8 };
    case "high": return { enabled: true, mapScale: 1, reach: 1 };
    case "ultra": return { enabled: true, mapScale: 2, reach: 1.5 };
  }
}

/** Metres out that animated bodies cast a shadow, given the renderer's authored range. */
export function skinnedShadowReach(level: ShadowLevel, authored: number): number {
  return authored * shadowQualityOf(level).reach;
}

/** Grass reach follows its amount, gently: a sparse field also stops sooner, an empty one stops everything. */
export function grassReach(amount: number): number {
  return 0.6 + 0.4 * clamp(amount, 0, 1);
}

type Rings = NonNullable<ChunkStreamerData["rings"]>;

/**
 * The rings at a draw distance. `simulation` never moves: it is where physics and scripts run, so draw distance must not
 * change what the game does. Everything rendered beyond it scales, and full detail cannot fall inside it.
 */
export function scaleRings(rings: Rings, scale: number): Rings {
  if (scale === 1) return rings;
  const fullRender = Math.max(rings.simulation, Math.round(rings.fullRender * scale));
  const hlod = Math.max(fullRender, Math.round(rings.hlod * scale));
  return { simulation: rings.simulation, fullRender, hlod, farTerrain: Math.max(hlod, Math.round(rings.farTerrain * scale)) };
}

/** Where instanced trees go to impostors: inside full detail's guaranteed reach (see main.ts), times the LOD setting. */
export const FOLIAGE_LOD_MAX_M = 170;
export function foliageLodDistance(rings: Rings | undefined, cellSize: number, lod: number): number {
  const reach = rings ? Math.min(FOLIAGE_LOD_MAX_M, Math.max(40, rings.fullRender * cellSize - cellSize / Math.SQRT2)) : FOLIAGE_LOD_MAX_M;
  return reach * lod;
}

/** The foliage system's own defaults (foliage-lod.ts constructor), which the LOD setting scales. */
const FOLIAGE_NEAR_M = 40;
const FOLIAGE_SCREEN_ERROR_PX = 2;

/**
 * The Auto preset: start where it last settled, step down a tier when frames stay slow, step back up when they have been
 * fast for a long while. A tier change moves the streamed rings and the grass, so it is slow on purpose: a step needs
 * several windows of agreement, a raise that had to be undone doubles the wait before the next, and frames during a
 * load say nothing and are skipped by the caller.
 */
export interface AutoTierOptions {
  /** Frames per decision. */
  window?: number;
  /** Median frame slower than this is a slow window (default 1000/40). */
  slowMs?: number;
  /** Median frame faster than this is a fast window (default 1000/58). */
  fastMs?: number;
  /** Slow windows in a row before a step down. */
  slowWindows?: number;
  /** Fast windows in a row before a step up. */
  fastWindows?: number;
}

/** A frame longer than this is a hidden tab or a stall, not a reading. */
const AUTO_MAX_SAMPLE_MS = 250;
const AUTO_MAX_FAST_WINDOWS = 640;

export class AutoTier {
  private readonly window: number;
  private readonly slowMs: number;
  private readonly fastMs: number;
  private readonly slowWindows: number;
  private fastWindows: number;
  private frames: number[] = [];
  private last: number | null = null;
  private slow = 0;
  private fast = 0;
  private justRaised = false;

  constructor(public tier: PresetTier, options: AutoTierOptions = {}) {
    this.window = options.window ?? 120;
    this.slowMs = options.slowMs ?? 1000 / 40;
    this.fastMs = options.fastMs ?? 1000 / 58;
    this.slowWindows = options.slowWindows ?? 4;
    this.fastWindows = options.fastWindows ?? 40;
  }

  /** Feed one frame's rAF time. Returns the tier when it changed, else null. */
  frame(time: number): PresetTier | null {
    const last = this.last;
    this.last = time;
    if (last === null) return null;
    const frameMs = time - last;
    if (!(frameMs > 0) || frameMs > AUTO_MAX_SAMPLE_MS) return null;
    this.frames.push(frameMs);
    if (this.frames.length < this.window) return null;
    this.frames.sort((a, b) => a - b);
    const median = this.frames[this.frames.length >> 1]!;
    this.frames = [];
    const index = PRESET_TIERS.indexOf(this.tier);
    if (median > this.slowMs) {
      this.fast = 0;
      if (++this.slow < this.slowWindows) return null;
      this.slow = 0;
      if (this.justRaised) this.fastWindows = Math.min(AUTO_MAX_FAST_WINDOWS, this.fastWindows * 2);
      this.justRaised = false;
      if (index <= 0) return null;
      this.tier = PRESET_TIERS[index - 1]!;
      return this.tier;
    }
    this.slow = 0;
    if (median > this.fastMs) {
      this.fast = 0;
      return null;
    }
    // Auto tops out at High: Ultra is a choice, never something a fast window spends for the player
    if (++this.fast < this.fastWindows || index >= PRESET_TIERS.indexOf("high")) {
      if (this.fast >= this.fastWindows) this.fast = 0;
      return null;
    }
    this.fast = 0;
    this.justRaised = true;
    this.tier = PRESET_TIERS[index + 1]!;
    return this.tier;
  }

  /** Forget timing history (a load, a preset change): the next frame starts a fresh window. */
  reset(): void {
    this.frames = [];
    this.last = null;
    this.slow = 0;
    this.fast = 0;
  }
}

/** The render systems the settings reach, as narrow as each use. Both hosts hand theirs over once at boot. */
export interface GraphicsTargets {
  renderer: { renderScale: number; setRenderScale(scale: number): void; skinnedShadowDistance: number; ambientOcclusion: boolean };
  adaptive: { scale: number; frame(time: number, busyMs: number): number | null; reset(): void };
  /** `?renderScale=`: wins over any setting. */
  urlRenderScale: number | null;
  setSunShadows(quality: { enabled: boolean; mapScale: number; reach: number }): void;
  setWeatherScale(scale: number): void;
  grass: { setQuality(amount: number, reach: number): void };
  foliageLod: { setLodDistance(metres: number): void; setNearDistance(metres: number): void; setScreenError(pixels: number): void };
  chunks: { setRings(rings: Rings): void };
  /** Absent in the published host, which has no culling system. */
  culling?: { minScreenScale: number };
  horizon(): { setRing(metres: number): void } | null;
}

/** Live settings for one host: holds them, saves them, pushes them into the engine, and runs the per-frame half. */
export class GraphicsController {
  private readonly listeners = new Set<() => void>();
  private readonly auto: AutoTier;
  private readonly authoredSkinnedShadows: number;
  /** The streamer as authored (scoped, not yet scaled), for draw distance to scale from. */
  private streamer: ChunkStreamerData | null = null;
  /** The map scale the sun was built with: the one in force at boot, whichever host order got there. */
  private readonly builtShadowMapScale: number;
  /** Saved settings stay untouched by a `?gfx=` run. */
  private readonly persist: boolean;

  constructor(
    private readonly targets: GraphicsTargets,
    private readonly storage: SettingsStorage | null,
    private current: GraphicsSettings,
    options: { persist: boolean },
  ) {
    this.persist = options.persist;
    this.auto = new AutoTier(current.autoTier);
    this.authoredSkinnedShadows = targets.renderer.skinnedShadowDistance;
    this.builtShadowMapScale = shadowQualityOf(current.shadows).mapScale;
    this.applyAll();
  }

  get settings(): GraphicsSettings {
    return this.current;
  }

  /** Shadow sharpness is fixed when the world's sun is built: true when the current level wants a load to reach it. */
  get shadowMapNeedsReload(): boolean {
    return this.current.shadows !== "off" && shadowQualityOf(this.current.shadows).mapScale !== this.builtShadowMapScale;
  }

  /** The tier Auto is on right now, for the panel to say so. */
  get autoTier(): PresetTier {
    return this.auto.tier;
  }

  /** Whether `?renderScale=` is overriding the render scale setting. */
  get renderScalePinnedByUrl(): boolean {
    return this.targets.urlRenderScale !== null;
  }

  /** Called on any change, for the panel. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  choosePreset(preset: GraphicsPreset): void {
    this.commit(applyPreset(this.current, preset));
    this.auto.reset();
  }

  change(field: Partial<GraphicsValues>): void {
    this.commit(changeField(this.current, field));
  }

  /**
   * The host's streamer as it stands after the scene's own scoping: remembers it and returns it with the rings at the
   * player's draw distance, so a boot at Low never loads the far rings just to drop them.
   */
  scaleStreamer<T extends ChunkStreamerData | null>(streamer: T): T {
    this.streamer = streamer;
    this.applyLod();
    if (!streamer?.rings) return streamer;
    return { ...streamer, rings: scaleRings(streamer.rings, this.current.drawDistance) };
  }

  /**
   * Once per frame after the loop ticks. `busyMs` is main-thread time inside the frame, `loading` skips sampling while
   * content arrives, `playing` is false in the editor, which always draws at full resolution.
   */
  frame(time: number, busyMs: number, loading: boolean, playing: boolean): void {
    const { renderer, adaptive, urlRenderScale } = this.targets;
    if (urlRenderScale !== null) return;
    if (!playing) {
      if (renderer.renderScale !== 1) {
        adaptive.scale = 1;
        adaptive.reset();
        renderer.setRenderScale(1);
      }
      return;
    }
    if (this.current.preset === "auto") {
      if (loading) this.auto.reset();
      else {
        const tier = this.auto.frame(time);
        if (tier) this.commit({ ...this.current, ...PRESETS[tier], autoTier: tier });
      }
    }
    const pinned = this.current.renderScale;
    if (pinned !== "auto") {
      renderer.setRenderScale(pinned);
      return;
    }
    if (loading) adaptive.reset();
    else {
      const scale = adaptive.frame(time, busyMs);
      if (scale !== null) renderer.setRenderScale(scale);
    }
  }

  private commit(next: GraphicsSettings): void {
    const before = this.current;
    this.current = next;
    if (this.persist) saveGraphics(this.storage, next);
    if (before.renderScale !== next.renderScale && next.renderScale === "auto") {
      // adaptive picks up from full scale: it was not steering while a number was pinned
      this.targets.adaptive.scale = 1;
      this.targets.adaptive.reset();
      if (this.targets.urlRenderScale === null) this.targets.renderer.setRenderScale(1);
    }
    if (before.ao !== next.ao) this.targets.renderer.ambientOcclusion = next.ao;
    if (before.shadows !== next.shadows) this.applyShadows();
    if (before.grass !== next.grass) this.applyGrass();
    if (before.weather !== next.weather) this.targets.setWeatherScale(next.weather);
    if (before.lod !== next.lod) this.applyLod();
    if (before.drawDistance !== next.drawDistance) this.applyDrawDistance();
    for (const listener of this.listeners) listener();
  }

  private applyAll(): void {
    this.targets.renderer.ambientOcclusion = this.current.ao;
    this.applyShadows();
    this.applyGrass();
    this.targets.setWeatherScale(this.current.weather);
    this.applyLod();
  }

  private applyShadows(): void {
    const level = this.current.shadows;
    this.targets.setSunShadows(shadowQualityOf(level));
    this.targets.renderer.skinnedShadowDistance = skinnedShadowReach(level, this.authoredSkinnedShadows);
  }

  private applyGrass(): void {
    const amount = this.current.grass;
    this.targets.grass.setQuality(amount, grassReach(amount));
  }

  private applyLod(): void {
    const { lod, drawDistance } = this.current;
    const s = this.streamer;
    const { foliageLod, culling } = this.targets;
    foliageLod.setLodDistance(foliageLodDistance(s?.rings ? scaleRings(s.rings, drawDistance) : undefined, s?.cellSize ?? 0, lod));
    foliageLod.setNearDistance(FOLIAGE_NEAR_M * lod);
    foliageLod.setScreenError(FOLIAGE_SCREEN_ERROR_PX / lod);
    if (culling) culling.minScreenScale = 1 / lod;
  }

  private applyDrawDistance(): void {
    const s = this.streamer;
    if (!s?.rings) return;
    const rings = scaleRings(s.rings, this.current.drawDistance);
    this.targets.chunks.setRings(rings);
    this.targets.horizon()?.setRing(rings.farTerrain * s.cellSize);
    this.applyLod();
  }
}

/** The controller for a host: saved settings, or a one-run `?gfx=` over them. */
export function createGraphics(targets: GraphicsTargets, search: string, storage: SettingsStorage | null): GraphicsController {
  const saved = loadGraphics(storage);
  const oneRun = graphicsFromSearch(search, saved);
  return new GraphicsController(targets, storage, oneRun ?? saved, { persist: oneRun === null });
}

/** The settings this page will run with, before anything is built: the sun's cascades read their map size when built. */
export function bootSettings(search: string, storage: SettingsStorage | null): GraphicsSettings {
  const saved = loadGraphics(storage);
  return graphicsFromSearch(search, saved) ?? saved;
}

/** `localStorage`, or null where touching it throws. */
export function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
