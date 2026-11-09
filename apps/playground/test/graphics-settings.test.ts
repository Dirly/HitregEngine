import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AutoTier, DEFAULT_GRAPHICS, GRAPHICS_STORAGE_KEY, GraphicsController, PRESETS, PRESET_TIERS, RENDER_SCALES, applyPreset, changeField, createGraphics,
  foliageLodDistance, grassReach, graphicsFromSearch, loadGraphics, normalizeGraphics, saveGraphics, scaleRings, shadowQualityOf,
  type GraphicsTargets,
} from "../src/graphics-settings.js";

const memory = (seed: Record<string, string> = {}) => {
  const data = new Map(Object.entries(seed));
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};

function fakes() {
  const log: string[] = [];
  const state = { scale: 1, adaptiveNext: null as number | null, adaptiveFrames: 0, adaptiveResets: 0 };
  const targets: GraphicsTargets = {
    renderer: {
      get renderScale() { return state.scale; },
      setRenderScale(s) { state.scale = s; log.push(`scale ${s}`); },
      skinnedShadowDistance: 60,
    },
    adaptive: { scale: 1, frame() { state.adaptiveFrames++; return state.adaptiveNext; }, reset() { state.adaptiveResets++; } },
    urlRenderScale: null,
    setSunShadows: (q) => log.push(`sun ${q.enabled} ${q.mapScale} ${q.reach}`),
    setWeatherScale: (s) => log.push(`weather ${s}`),
    grass: { setQuality: (a, r) => log.push(`grass ${a} ${r}`) },
    foliageLod: { setLodDistance: (m) => log.push(`lod ${m}`), setNearDistance: () => {}, setScreenError: () => {} },
    chunks: { setRings: (r) => log.push(`rings ${r.fullRender} ${r.hlod} ${r.farTerrain}`) },
    culling: { minScreenScale: 1 },
    horizon: () => ({ setRing: (m) => log.push(`horizon ${m}`) }),
  };
  return { log, state, targets };
}

test("High is the game as authored, and is where a new player starts", () => {
  assert.equal(DEFAULT_GRAPHICS.preset, "high");
  assert.deepEqual({ ...PRESETS.high }, { renderScale: "auto", shadows: "high", grass: 1, weather: 1, lod: 1, drawDistance: 1, ao: true });
  assert.deepEqual(shadowQualityOf("high"), { enabled: true, mapScale: 1, reach: 1 });
  for (const tier of PRESET_TIERS) assert.deepEqual(normalizeGraphics({ ...PRESETS[tier], preset: tier }), { ...DEFAULT_GRAPHICS, ...PRESETS[tier], preset: tier });
});

test("every preset's render scale is one the panel lists", () => {
  for (const tier of PRESET_TIERS) assert.ok((RENDER_SCALES as readonly unknown[]).includes(PRESETS[tier].renderScale), tier);
});

test("presets step in one direction: lower never costs more", () => {
  const levels = ["off", "low", "medium", "high", "ultra"];
  for (let i = 1; i < PRESET_TIERS.length; i++) {
    const a = PRESETS[PRESET_TIERS[i - 1]!], b = PRESETS[PRESET_TIERS[i]!];
    assert.ok(a.grass <= b.grass && a.weather <= b.weather && a.lod <= b.lod && a.drawDistance <= b.drawDistance);
    assert.ok(levels.indexOf(a.shadows) < levels.indexOf(b.shadows));
  }
});

test("garbage in storage never reaches the engine", () => {
  const out = normalizeGraphics({ preset: "epic", renderScale: 4, shadows: "rtx", grass: "lots", weather: -3, lod: 99, drawDistance: Number.NaN, junk: 1 });
  assert.deepEqual(out, { ...DEFAULT_GRAPHICS, weather: 0, lod: 1.25 });
  assert.deepEqual(loadGraphics(memory({ [GRAPHICS_STORAGE_KEY]: "{not json" })), DEFAULT_GRAPHICS);
  assert.deepEqual(loadGraphics(null), DEFAULT_GRAPHICS);
});

test("settings survive a save and load, and a storage that throws costs nothing", () => {
  const storage = memory();
  const settings = changeField(applyPreset(DEFAULT_GRAPHICS, "low"), { grass: 0 });
  saveGraphics(storage, settings);
  assert.deepEqual(loadGraphics(storage), settings);
  const blocked = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
  assert.doesNotThrow(() => saveGraphics(blocked, settings));
  assert.deepEqual(loadGraphics(blocked), DEFAULT_GRAPHICS);
});

test("changing one field makes the setup custom; a preset replaces everything", () => {
  const custom = changeField(DEFAULT_GRAPHICS, { shadows: "off" });
  assert.equal(custom.preset, "custom");
  assert.equal(custom.grass, 1);
  assert.deepEqual(applyPreset(custom, "low"), { ...custom, ...PRESETS.low, preset: "low" });
  assert.equal(applyPreset({ ...custom, autoTier: "medium" }, "auto").grass, PRESETS.medium.grass);
});

test("?gfx= is a preset then field overrides, and absent means no override", () => {
  assert.equal(graphicsFromSearch("?scene=x", DEFAULT_GRAPHICS), null);
  assert.equal(graphicsFromSearch("?gfx=low", DEFAULT_GRAPHICS)?.grass, PRESETS.low.grass);
  const mix = graphicsFromSearch("?gfx=high,shadows:off,grass:0.2", DEFAULT_GRAPHICS);
  assert.equal(mix?.shadows, "off");
  assert.equal(mix?.grass, 0.2);
  assert.equal(mix?.drawDistance, 1);
});

test("a ?gfx= run leaves the saved settings alone", () => {
  const { targets } = fakes();
  const storage = memory();
  const run = createGraphics(targets, "?gfx=low", storage);
  assert.equal(run.settings.preset, "low");
  run.change({ grass: 0 });
  assert.equal(storage.data.size, 0);
  const normal = createGraphics(fakes().targets, "", storage);
  normal.change({ grass: 0 });
  assert.equal(storage.data.size, 1);
});

test("draw distance never moves the simulation ring and keeps the rings ordered", () => {
  const rings = { simulation: 2, fullRender: 3, hlod: 10, farTerrain: 32 };
  assert.equal(scaleRings(rings, 1), rings);
  assert.deepEqual(scaleRings(rings, 0.5), { simulation: 2, fullRender: 2, hlod: 5, farTerrain: 16 });
  assert.deepEqual(scaleRings(rings, 1.25), { simulation: 2, fullRender: 4, hlod: 13, farTerrain: 40 });
  const tight = scaleRings({ simulation: 4, fullRender: 4, hlod: 4, farTerrain: 5 }, 0.5);
  assert.deepEqual(tight, { simulation: 4, fullRender: 4, hlod: 4, farTerrain: 4 });
});

test("the foliage switch sits inside full detail, scaled by the LOD setting", () => {
  const rings = { simulation: 2, fullRender: 3, hlod: 10, farTerrain: 32 };
  const reach = 3 * 48 - 48 / Math.SQRT2;
  assert.equal(foliageLodDistance(rings, 48, 1), reach);
  assert.equal(foliageLodDistance(rings, 48, 0.5), reach / 2);
  assert.equal(foliageLodDistance(undefined, 0, 1), 170);
});

test("grass reach shrinks with amount, never to nothing while any grass remains", () => {
  assert.equal(grassReach(1), 1);
  assert.ok(grassReach(0.35) < 1 && grassReach(0.35) > 0.5);
});

test("a change reaches only the systems it concerns", () => {
  const { log, targets } = fakes();
  const g = new GraphicsController(targets, null, normalizeGraphics(null), { persist: false });
  log.length = 0;
  g.change({ weather: 0.5 });
  assert.deepEqual(log, ["weather 0.5"]);
  log.length = 0;
  g.change({ shadows: "off" });
  assert.deepEqual(log, ["sun false 0.5 0.4"]);
  assert.equal(targets.renderer.skinnedShadowDistance, 24);
  log.length = 0;
  g.change({ grass: 0 });
  assert.deepEqual(log, ["grass 0 0.6"]);
});

test("shadow sharpness waits for a load, and asks only when the map scale really differs", () => {
  const { targets } = fakes();
  const g = new GraphicsController(targets, null, normalizeGraphics(null), { persist: false });
  assert.equal(g.shadowMapNeedsReload, false);
  g.change({ shadows: "medium" }); // same map, shorter reach
  assert.equal(g.shadowMapNeedsReload, false);
  g.change({ shadows: "off" }); // no map on screen at all
  assert.equal(g.shadowMapNeedsReload, false);
  g.change({ shadows: "ultra" });
  assert.equal(g.shadowMapNeedsReload, true);
  g.change({ shadows: "high" });
  assert.equal(g.shadowMapNeedsReload, false);
});

test("draw distance moves the rings and the horizon's hole together, from the authored rings", () => {
  const { log, targets } = fakes();
  const g = new GraphicsController(targets, null, normalizeGraphics(null), { persist: false });
  const authored = { source: "w", cellSize: 48, radius: 2, keepPadding: 1, hlodSupercellFactor: 4, rings: { simulation: 2, fullRender: 3, hlod: 10, farTerrain: 32 } };
  g.scaleStreamer(authored as never);
  log.length = 0;
  g.change({ drawDistance: 0.5 });
  assert.ok(log.includes("rings 2 5 16"));
  assert.ok(log.includes(`horizon ${16 * 48}`));
  log.length = 0;
  g.change({ drawDistance: 1 });
  assert.ok(log.includes("rings 3 10 32"), "back to authored, not a scale of a scale");
});

test("a boot at a low draw distance hands the host smaller rings", () => {
  const { targets } = fakes();
  const g = new GraphicsController(targets, null, applyPreset(DEFAULT_GRAPHICS, "low"), { persist: false });
  const rings = { simulation: 2, fullRender: 3, hlod: 10, farTerrain: 32 };
  const out = g.scaleStreamer({ source: "w", cellSize: 48, radius: 2, keepPadding: 1, hlodSupercellFactor: 4, rings } as never) as { rings: typeof rings };
  assert.deepEqual(out.rings, { simulation: 2, fullRender: 2, hlod: 6, farTerrain: 19 });
  assert.equal(g.scaleStreamer(null), null);
});

test("render scale: a pin holds in play, the editor draws full, the URL wins over all", () => {
  const { state, targets } = fakes();
  const g = new GraphicsController(targets, null, changeField(DEFAULT_GRAPHICS, { renderScale: 0.5 }), { persist: false });
  g.frame(16, 1, false, true);
  assert.equal(state.scale, 0.5);
  assert.equal(state.adaptiveFrames, 0);
  g.frame(32, 1, false, false);
  assert.equal(state.scale, 1);
  const url = fakes();
  url.targets.urlRenderScale = 1;
  const pinned = new GraphicsController(url.targets, null, changeField(DEFAULT_GRAPHICS, { renderScale: 0.5 }), { persist: false });
  pinned.frame(16, 1, false, true);
  assert.equal(url.state.scale, 1);
});

test("render scale: back to auto hands steering to the adaptive scale from full", () => {
  const { state, targets } = fakes();
  const g = new GraphicsController(targets, null, changeField(DEFAULT_GRAPHICS, { renderScale: 0.5 }), { persist: false });
  g.frame(16, 1, false, true);
  g.change({ renderScale: "auto" });
  assert.equal(state.scale, 1);
  state.adaptiveNext = 0.9;
  g.frame(32, 1, false, true);
  assert.equal(state.scale, 0.9);
  state.adaptiveNext = 0.8;
  g.frame(48, 1, true, true); // loading: no sampling
  assert.equal(state.scale, 0.9);
});

test("Auto steps down on sustained slow frames, and only then", () => {
  const auto = new AutoTier("high", { window: 4, slowWindows: 2 });
  let t = 0;
  const run = (ms: number, frames: number) => { const hits = []; for (let i = 0; i < frames; i++) { t += ms; const r = auto.frame(t); if (r) hits.push(r); } return hits; };
  assert.deepEqual(run(50, 5), []); // one slow window is not enough
  assert.deepEqual(run(16, 4), []); // a good window clears it
  assert.deepEqual(run(50, 12), ["medium"]);
  assert.equal(auto.tier, "medium");
});

test("Auto never goes below Low or climbs past High, and a failed raise waits longer", () => {
  const auto = new AutoTier("low", { window: 2, slowWindows: 1, fastWindows: 2 });
  let t = 0;
  const run = (ms: number, frames: number) => { const hits = []; for (let i = 0; i < frames; i++) { t += ms; const r = auto.frame(t); if (r) hits.push(r); } return hits; };
  assert.deepEqual(run(50, 10), []);
  assert.deepEqual(run(10, 40), ["medium", "high"]);
  assert.equal(auto.tier, "high");
  auto.reset();
  assert.deepEqual(run(50, 3), ["medium"]);
  auto.reset();
  assert.deepEqual(run(10, 7), [], "the wait doubled after the raise fell back");
  assert.deepEqual(run(10, 4), ["high"]);
});

test("Auto ignores a stalled frame and restarts after a reset", () => {
  const auto = new AutoTier("high", { window: 2, slowWindows: 1 });
  assert.equal(auto.frame(0), null);
  assert.equal(auto.frame(5000), null);
  assert.equal(auto.frame(5050), null);
  auto.reset();
  assert.equal(auto.frame(6000), null);
  assert.equal(auto.frame(6050), null);
  assert.equal(auto.frame(6100), "medium");
});

test("the Auto preset commits and remembers its tier, and leaves a chosen preset alone", () => {
  const { targets } = fakes();
  const storage = memory();
  const g = new GraphicsController(targets, storage, applyPreset(DEFAULT_GRAPHICS, "auto"), { persist: true });
  let t = 0;
  for (let i = 0; i < 2000 && g.settings.autoTier === "high"; i++) { t += 50; g.frame(t, 1, false, true); }
  assert.equal(g.settings.autoTier, "medium");
  assert.equal(g.settings.preset, "auto");
  assert.equal(g.settings.grass, PRESETS.medium.grass);
  assert.equal(loadGraphics(storage).autoTier, "medium");
  g.choosePreset("ultra");
  for (let i = 0; i < 2000; i++) { t += 50; g.frame(t, 1, false, true); }
  assert.equal(g.settings.preset, "ultra");
  assert.equal(g.settings.grass, PRESETS.ultra.grass);
});
