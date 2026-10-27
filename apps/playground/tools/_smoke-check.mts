/**
 * SMOKE gate (Derek 2026-10-22: "that smoke from the castle needs to be turned down by a lot; there is also smoke in
 * other places and it's too large"). Every smoke emitter a project's scene places is measured against the smoke
 * standard (core vfx/smoke.ts: SMOKE_CLASSES, measurePlume, checkSmoke) — from the effect's numbers and its SOURCE
 * (the nearest prefab entity carrying `dressing.size`: the pyre, the campfire, the kiln), no renderer:
 *
 *   height   the plume's visible top above the source's ground <= the class cap (topX x source height, minTop..maxTop)
 *   width    widest the plume gets <= 2 x the source's width (class maxWidth)
 *   opacity  peak per-particle opacity <= the class cap
 *   colour   start/end colour (resolved through the vfx material: color = primary, emissive = glow) not near-black
 *   night    `nightDim` >= 0.5 (particles draw unlit: pale smoke glows at night without it)
 *   wind     `windDrift` > 0 in world space (smoke leans with the live wind, never pools)
 *
 * plus the chimney batch (render chimney-smoke.ts, numbers from core CHIMNEY_SMOKE) as a chimney-class plume over a
 * 4 m and a 10 m chimney. Per-place overrides of a smoke emitter (an instance prop/override touching a vfx path) are
 * listed, so a hand tweak never hides from the preset.
 */
import fs from "node:fs";
import path from "node:path";
import { CHIMNEY_SMOKE, SMOKE_CLASSES, checkSmoke, chimneyPlume, measurePlume, paletteFromMaterial, parseVfxEffect, resolveColor, smokeCaps, smokeLayers, type SmokeClass, type SmokeFault, type VfxEffect } from "@hitreg/core";
// @ts-expect-error plain JS module
import { PROJECTS, closure } from "./_closure.mjs";

type V3 = [number, number, number];
type Q = [number, number, number, number];
type Ent = { name?: string; parent?: string | null; components?: Record<string, any> };

const readJson = (f: string) => JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));

export interface SmokeEmitterRow {
  /** The place: the scene entity path's first two names. */
  place: string;
  entity: string;
  /** The prefab chain to the emitter (outer first), and the emitter entity in the innermost prefab. */
  via: string;
  effect: string;
  material: string;
  klass: SmokeClass;
  source: { height: number; width: number; emitterY: number; from: string };
  plume: { top: number; width: number; opacity: number; seconds: number };
  caps: { top: number; width: number; opacity: number };
  at: [number, number];
  overrides: string[];
  faults: SmokeFault[];
}

export interface SmokeReport {
  ok: boolean;
  project: string;
  scene: string;
  zone: string | null;
  standard: typeof SMOKE_CLASSES;
  chimney: { numbers: typeof CHIMNEY_SMOKE; at4m: ReturnType<typeof chimneyPlume>; at10m: ReturnType<typeof chimneyPlume> };
  counts: { emitters: number; failing: number; places: number; overrides: number };
  /** Every smoke-bearing effect in the closure, measured at its anchor (no source). */
  presets: { effect: string; klass: SmokeClass; layers: { id: string; top: number; width: number; opacity: number; seconds: number; windDrift: number; nightDim: number }[] }[];
  rows: SmokeEmitterRow[];
}

class Assets {
  readonly roots: string[];
  private cache = new Map<string, any>();
  constructor(project: string) {
    this.roots = (closure(project) as string[]).map((p) => path.join(PROJECTS, p, "assets"));
  }
  file(kind: string, id: string): string | null {
    for (const r of this.roots) {
      const f = path.join(r, kind, `${id}.json`);
      if (fs.existsSync(f)) return f;
    }
    return null;
  }
  get(kind: string, id: string): any {
    const key = `${kind}:${id}`;
    if (!this.cache.has(key)) {
      const f = this.file(kind, id);
      let v: any = null;
      try { v = f ? readJson(f) : null; } catch { v = null; }
      this.cache.set(key, v);
    }
    return this.cache.get(key);
  }
  effect(id: string): VfxEffect | null {
    const raw = this.get("vfx", id);
    if (!raw) return null;
    try { return parseVfxEffect(raw); } catch { return null; }
  }
  /** Every vfx id in the closure (nested folders: `env/fire-torch`). */
  vfxIds(): string[] {
    const ids = new Set<string>();
    for (const r of this.roots) {
      const base = path.join(r, "vfx");
      const walk = (d: string) => {
        if (!fs.existsSync(d)) return;
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
          if (f.isDirectory()) walk(path.join(d, f.name));
          else if (f.name.endsWith(".json")) ids.add(path.relative(base, path.join(d, f.name)).replace(/\\/g, "/").slice(0, -5));
        }
      };
      walk(base);
    }
    return [...ids].sort();
  }
}

/* ---------- transforms ---------- */
const qmul = (a: Q, b: Q): Q => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qrot = (q: Q, v: V3): V3 => {
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2], iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2];
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
};
interface Xf { p: V3; q: Q; s: V3 }
const ID: Xf = { p: [0, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] };
const local = (e: Ent): Xf => {
  const t = e.components?.transform ?? {};
  return { p: (t.position ?? [0, 0, 0]) as V3, q: (t.rotation ?? [0, 0, 0, 1]) as Q, s: (t.scale ?? [1, 1, 1]) as V3 };
};
const compose = (a: Xf, b: Xf): Xf => {
  const sp: V3 = [b.p[0] * a.s[0], b.p[1] * a.s[1], b.p[2] * a.s[2]];
  const r = qrot(a.q, sp);
  return { p: [a.p[0] + r[0], a.p[1] + r[1], a.p[2] + r[2]], q: qmul(a.q, b.q), s: [a.s[0] * b.s[0], a.s[1] * b.s[1], a.s[2] * b.s[2]] };
};

/* ---------- prefab expansion (props, overrides) ---------- */
function setPath(ents: Record<string, Ent>, p: string, value: unknown): void {
  const [id, ...rest] = p.split("/");
  let o: any = ents[id!];
  if (!o || !rest.length) return;
  for (let i = 0; i < rest.length - 1; i++) {
    o[rest[i]!] ??= {};
    o = o[rest[i]!];
  }
  o[rest[rest.length - 1]!] = value;
}

interface Emit {
  effect: string;
  material: string;
  /** The emitter's transform relative to the outermost prefab root. */
  xf: Xf;
  /** The source: nearest ancestor with dressing.size, and the emitter's height above that source's origin. */
  source: { height: number; width: number; emitterY: number; from: string };
  via: string[];
  overrides: string[];
  /** The outermost entity id (in the scene: the placed instance). */
  top: string;
}

function expandPrefab(assets: Assets, id: string, props: Record<string, unknown>, overrides: { path: string; value: unknown }[], depth = 0): Emit[] {
  const doc = assets.get("prefabs", id);
  if (!doc?.entities || depth > 8) return [];
  const ents: Record<string, Ent> = JSON.parse(JSON.stringify(doc.entities));
  for (const [name, def] of Object.entries((doc.props ?? {}) as Record<string, any>)) {
    const v = name in props ? props[name] : def?.default;
    if (v === undefined) continue;
    for (const b of def?.bindings ?? []) setPath(ents, String(b), v);
  }
  for (const o of overrides ?? []) setPath(ents, o.path, o.value);
  const touched = [...Object.keys(props).filter((k) => /smoke|vfx|effect/i.test(k)), ...(overrides ?? []).map((o) => o.path).filter((p) => /\/vfx\//.test(p) && !/cullDistance|playing$/.test(p))];
  return expandEntities(assets, ents, id, depth, touched);
}

function expandEntities(assets: Assets, ents: Record<string, Ent>, label: string, depth: number, touched: string[]): Emit[] {
  const out: Emit[] = [];
  const xfOf = new Map<string, Xf>();
  const xf = (eid: string): Xf => {
    if (xfOf.has(eid)) return xfOf.get(eid)!;
    const e = ents[eid]!;
    const v = e.parent && ents[e.parent] ? compose(xf(e.parent), local(e)) : local(e);
    xfOf.set(eid, v);
    return v;
  };
  const sourceOf = (eid: string) => {
    for (let c: string | null | undefined = eid; c && ents[c]; c = ents[c]!.parent) {
      const size = ents[c]!.components?.dressing?.size as V3 | undefined;
      if (size) return { height: size[1], width: Math.max(size[0], size[2]), y: xf(c).p[1], from: `${label}:${ents[c]!.name ?? c}` };
    }
    return null;
  };
  for (const [eid, e] of Object.entries(ents)) {
    const c = e.components ?? {};
    if (c.vfx?.effect) {
      const src = sourceOf(eid);
      const at = xf(eid);
      out.push({
        effect: String(c.vfx.effect),
        material: String(c.vfx.material ?? ""),
        xf: at,
        source: src ? { height: src.height, width: src.width, emitterY: at.p[1] - src.y, from: src.from } : { height: 0, width: 0, emitterY: at.p[1], from: "" },
        via: [`${label}:${e.name ?? eid}`],
        overrides: touched,
        top: eid,
      });
    }
    if (c.prefab?.prefabId) {
      const inner = expandPrefab(assets, String(c.prefab.prefabId), c.prefab.props ?? {}, c.prefab.overrides ?? [], depth + 1);
      const here = xf(eid);
      const outerSrc = sourceOf(eid);
      for (const m of inner) {
        const src = m.source.from ? m.source : outerSrc ? { height: outerSrc.height, width: outerSrc.width, emitterY: compose(here, m.xf).p[1] - outerSrc.y, from: outerSrc.from } : m.source;
        out.push({ ...m, xf: compose(here, m.xf), source: src, via: [`${label}:${e.name ?? eid}`, ...m.via], overrides: [...touched, ...m.overrides], top: eid });
      }
    }
  }
  return out;
}

/* ---------- the report ---------- */
const r2 = (v: number) => Math.round(v * 100) / 100;

function inPoly(x: number, z: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]!, [xj, zj] = poly[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function smokeReport(project: string, opts: { scene?: string; zone?: string } = {}): SmokeReport {
  const assets = new Assets(project);
  const sceneId = opts.scene ?? project;
  const sceneFile = assets.file("scenes", `${sceneId}.scene`);
  if (!sceneFile) throw new Error(`no scene ${sceneId}.scene.json in the ${project} closure`);
  const scene = readJson(sceneFile);
  let poly: [number, number][] | null = null;
  if (opts.zone) {
    const recipe = assets.get("worlds", sceneId) ?? assets.get("worlds", project);
    poly = recipe?.regions?.find((r: any) => r.id === opts.zone)?.polygon ?? null;
    if (!poly) throw new Error(`zone ${opts.zone} has no polygon in the recipe regions`);
  }
  const ents: Record<string, Ent> = scene.entities ?? {};
  const placeOf = (eid: string): string => {
    const names: string[] = [];
    for (let c: string | null | undefined = eid; c && ents[c]; c = ents[c]!.parent) names.unshift(ents[c]!.name ?? c);
    return names.slice(0, 2).join(" / ");
  };
  const colourCache = new Map<string, (slot: string) => string | undefined>();
  const coloursFor = (material: string) => {
    if (!colourCache.has(material)) {
      const mat = material ? assets.get("materials", material) : null;
      const pal = mat ? paletteFromMaterial(mat) : null;
      colourCache.set(material, (slot) => (pal ? resolveColor(slot, pal) : undefined));
    }
    return colourCache.get(material)!;
  };

  const rows: SmokeEmitterRow[] = [];
  const emits = expandEntities(assets, ents, "scene", 0, []);
  for (const m of emits) {
    const effect = assets.effect(m.effect);
    if (!effect || smokeLayers(effect).length === 0) continue;
    if (poly && !inPoly(m.xf.p[0], m.xf.p[2], poly)) continue;
    const klass: SmokeClass = effect.smoke ?? "fire";
    const src = { height: m.source.height, width: m.source.width, emitterY: m.source.emitterY };
    const faults = checkSmoke(effect, src, coloursFor(m.material), klass);
    let top = 0, width = 0, opacity = 0, seconds = 0;
    for (const L of smokeLayers(effect)) {
      const p = measurePlume(L.module.emitter, (L.module.anchor?.offset?.[1] ?? 0) + src.emitterY);
      top = Math.max(top, p.top); width = Math.max(width, p.width); opacity = Math.max(opacity, p.opacity); seconds = Math.max(seconds, p.visibleSeconds);
    }
    const caps = smokeCaps(klass, src);
    const eid = m.top, sceneEnt = ents[eid]?.name ?? eid;
    if (!m.source.from) faults.push({ layer: "*", rule: "height", detail: "no source: no ancestor carries dressing.size (the plume cannot be judged against what burns)" });
    rows.push({
      place: placeOf(eid), entity: sceneEnt, via: m.via.slice(1).join(" > "), effect: m.effect, material: m.material, klass,
      source: { height: r2(src.height), width: r2(src.width), emitterY: r2(src.emitterY), from: m.source.from },
      plume: { top: r2(top), width: r2(width), opacity: r2(opacity), seconds: r2(seconds) },
      caps: { top: r2(caps.top), width: r2(caps.width), opacity: SMOKE_CLASSES[klass].opacity },
      at: [r2(m.xf.p[0]), r2(m.xf.p[2])], overrides: [...new Set(m.overrides)], faults,
    });
  }
  const presets = assets.vfxIds().flatMap((id) => {
    const e = assets.effect(id);
    const layers = e ? smokeLayers(e) : [];
    if (!e || !layers.length) return [];
    return [{
      effect: id, klass: (e.smoke ?? "fire") as SmokeClass,
      layers: layers.map((L) => {
        const p = measurePlume(L.module.emitter, L.module.anchor?.offset?.[1] ?? 0);
        return { id: L.id, top: r2(p.top), width: r2(p.width), opacity: r2(p.opacity), seconds: r2(p.visibleSeconds), windDrift: L.module.emitter.windDrift ?? 0, nightDim: L.module.emitter.nightDim ?? 0 };
      }),
    }];
  });
  const at4m = chimneyPlume(4), at10m = chimneyPlume(10);
  const failing = rows.filter((r) => r.faults.length).length;
  return {
    ok: failing === 0 && at4m.faults.length === 0 && at10m.faults.length === 0,
    project, scene: sceneId, zone: opts.zone ?? null, standard: SMOKE_CLASSES,
    chimney: { numbers: CHIMNEY_SMOKE, at4m, at10m },
    counts: { emitters: rows.length, failing, places: new Set(rows.map((r) => r.place)).size, overrides: rows.filter((r) => r.overrides.length).length },
    presets, rows,
  };
}
