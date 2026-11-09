/**
 * ISO OVERVIEW views for place-build (Derek 2026-10-31: "For your review you do a lot from the perspective of the player
 * but it doesn't give a good overview. I honestly think an isometric view may help the most.").
 *
 * Two fixed cameras on opposite diagonals (iso-ne, iso-sw), ISO_ELEVATION_DEG above the horizon, looking down at the
 * place through a narrow vertical FOV (ISO_FOV_DEG: near-isometric, light-shots has no orthographic camera), framed so the
 * place's measured footprint (its dressing-area discs, built pieces, operators, fields and pockets) plus ISO_MARGIN_M fills
 * the frame. Shot at noon only (`times` [12]) and REVIEW-ONLY (`review: true`): first on the place sheet, never judged
 * by the wash / far-fire / missing-view checks (tools/_light-wash.mts isReviewShot), never widening the lab crop past
 * the framed ground.
 */
import fs from "node:fs";
import path from "node:path";
import { featureExtent } from "./_lab-crop.mts";

type V2 = [number, number];
type V3 = [number, number, number];

export const ISO_ELEVATION_DEG = 35;
export const ISO_FOV_DEG = 22;
export const ISO_MARGIN_M = 15;
export const ISO_HOUR = 12;
/** The light-shots / browser viewport aspect (1280 x 720). */
export const ISO_ASPECT = 16 / 9;
/** Height allowance over the pad for roofs and towers (the top of the frame keeps them). */
export const ISO_TALL_M = 12;
/** Compass directions FROM the place TO the camera (north = -Z, east = +X). iso-ne and iso-sw are always made. */
export const ISO_DIRS: Record<string, V2> = { "iso-ne": [Math.SQRT1_2, -Math.SQRT1_2], "iso-sw": [-Math.SQRT1_2, Math.SQRT1_2], "iso-nw": [-Math.SQRT1_2, -Math.SQRT1_2], "iso-se": [Math.SQRT1_2, Math.SQRT1_2] };
export const ISO_DEFAULT = ["iso-ne", "iso-sw"] as const;

export type IsoView = { name: string; x: number; z: number; camera: V3; target: V3; fov: number; times: number[]; review: true; footprint: { centre: V2; halfWidth: number; nearM: number; farM: number } };

const r2 = (v: number) => Math.round(v * 100) / 100;
/** The footprint + margin fills this share of the frame's half extent (a thin border round it). */
export const ISO_FILL = 0.95;

/** A world point through a lookAt camera (vertical FOV `fov` deg, `aspect`) -> NDC [x, y]; |v| <= 1 is in frame. */
export function project(cam: V3, target: V3, fov: number, aspect: number, p: V3): [number, number] {
  const F = [target[0] - cam[0], target[1] - cam[1], target[2] - cam[2]], fl = Math.hypot(F[0]!, F[1]!, F[2]!); for (let i = 0; i < 3; i++) F[i]! /= fl;
  const rl = Math.hypot(F[0]!, F[2]!) || 1, R = [-F[2]! / rl, 0, F[0]! / rl]; // right = forward x up
  const U = [R[1]! * F[2]! - R[2]! * F[1]!, R[2]! * F[0]! - R[0]! * F[2]!, R[0]! * F[1]! - R[1]! * F[0]!];
  const d = [p[0] - cam[0], p[1] - cam[1], p[2] - cam[2]], z = d[0]! * F[0]! + d[1]! * F[1]! + d[2]! * F[2]!, tv = Math.tan(((fov / 2) * Math.PI) / 180);
  return [(d[0]! * R[0]! + d[1]! * R[1]! + d[2]! * R[2]!) / z / (tv * aspect), (d[0]! * U[0]! + d[1]! * U[1]! + d[2]! * U[2]!) / z / tv];
}

/**
 * The iso cameras over `points` (world [x, z] of the footprint), ground at `groundY`. Orthographic fit (the FOV is narrow
 * enough): across the view the footprint's half width + margin must fit the horizontal half-FOV; along it the ground's
 * depth (foreshortened by sin elevation) plus the tall allowance (cos elevation) must fit the vertical half-FOV. The
 * target is shifted along the view so the footprint sits centred in the frame. `body` = where light-shots stands the
 * (hidden) player: the streaming centre, default the footprint centre.
 */
export function isoViews(points: readonly V2[], groundY: number, o: { names?: readonly string[]; body?: V2; margin?: number; tall?: number; fov?: number; elevation?: number; aspect?: number } = {}): IsoView[] {
  if (!points.length) return [];
  const margin = o.margin ?? ISO_MARGIN_M, tall = o.tall ?? ISO_TALL_M, fov = o.fov ?? ISO_FOV_DEG, e = ((o.elevation ?? ISO_ELEVATION_DEG) * Math.PI) / 180, aspect = o.aspect ?? ISO_ASPECT;
  const xs = points.map((p) => p[0]), zs = points.map((p) => p[1]);
  const c: V2 = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...zs) + Math.max(...zs)) / 2];
  const tv = Math.tan(((fov / 2) * Math.PI) / 180), th = tv * aspect;
  const out: IsoView[] = [];
  for (const name of o.names ?? ISO_DEFAULT) {
    const u = ISO_DIRS[name]; if (!u) continue;
    const f: V2 = [-u[0], -u[1]], r: V2 = [-f[1], f[0]]; // view forward (horizontal), its right
    let w = 0, near = Infinity, far = -Infinity;
    for (const p of points) { const dx = p[0] - c[0], dz = p[1] - c[1], a = dx * f[0] + dz * f[1], s = dx * r[0] + dz * r[1]; w = Math.max(w, Math.abs(s)); near = Math.min(near, a); far = Math.max(far, a); }
    w += margin; near -= margin; far += margin;
    const top = far * Math.sin(e) + tall * Math.cos(e), bottom = near * Math.sin(e), half = (top - bottom) / 2;
    let a0 = (top + bottom) / 2 / Math.sin(e); // the ground point at the frame's middle
    let D = Math.max(w / th, half / tv); // the orthographic fit, then corrected through the real perspective below
    // every footprint point pushed out by the margin (8 ways), on the ground and at the tall allowance
    const ring: V3[] = points.flatMap((p) => Array.from({ length: 8 }, (_, i) => [p[0] + margin * Math.cos((i * Math.PI) / 4), p[1] + margin * Math.sin((i * Math.PI) / 4)] as V2)).flatMap((p) => [[p[0], groundY, p[1]], [p[0], groundY + tall, p[1]]] as V3[]);
    const place = () => { const t: V3 = [c[0] + f[0] * a0, groundY, c[1] + f[1] * a0]; return { t, cam: [t[0] + u[0] * D * Math.cos(e), groundY + D * Math.sin(e), t[2] + u[1] * D * Math.cos(e)] as V3 }; };
    for (let k = 0; k < 40; k++) {
      const { t, cam } = place(); let mx = 0, lo = Infinity, hi = -Infinity;
      for (const p of ring) { const [nx, ny] = project(cam, t, fov, aspect, p); mx = Math.max(mx, Math.abs(nx)); lo = Math.min(lo, ny); hi = Math.max(hi, ny); }
      const need = Math.max(mx, (hi - lo) / 2) / ISO_FILL, mid = (hi + lo) / 2;
      if (Math.abs(need - 1) < 0.01 && Math.abs(mid) < 0.01) break;
      a0 += (mid * tv * D) / Math.sin(e); // re-centre: NDC y offset -> ground metres along the view
      D *= need;
    }
    const { t, cam } = place();
    const body = o.body ?? c;
    out.push({ name, x: r2(body[0]), z: r2(body[1]), camera: cam.map(r2) as V3, target: t.map(r2) as V3, fov, times: [ISO_HOUR], review: true, footprint: { centre: [r2(c[0]), r2(c[1])], halfWidth: r2(w), nearM: r2(near), farM: r2(far) } });
  }
  return out;
}

/** A place job's footprint (world [x, z]): its dressing-area discs (handoff siteDressing.areas), built entities
 *  (ops.json, parents' positions added), operators, field polygons and planned pockets. Never the approach routes or
 *  the views (they reach far outside the place). */
export function jobFootprint(job: string): V2[] {
  const j = (f: string) => { const p = path.join(job, f); try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null; } catch { return null; } };
  const pts: V2[] = [];
  for (const a of (j("handoff.json")?.siteDressing?.areas ?? []) as any[]) if (Array.isArray(a?.centre) && Number.isFinite(a.radius)) for (let i = 0; i < 12; i++) pts.push([a.centre[0] + a.radius * Math.cos((i * Math.PI) / 6), a.centre[1] + a.radius * Math.sin((i * Math.PI) / 6)]);
  const at = new Map<string, any>();
  for (const o of (j("ops.json") ?? []) as any[]) if (o?.op === "add-entity") at.set(o.id, o.entity);
  const worldAt = (id: string, guard = 0): V2 => { const e = at.get(id), q = e?.components?.transform?.position ?? [0, 0, 0], up: V2 = e?.parent && at.has(e.parent) && guard < 16 ? worldAt(e.parent, guard + 1) : [0, 0]; return [up[0] + q[0], up[1] + q[2]]; };
  for (const id of at.keys()) if (at.get(id)?.components?.transform) pts.push(worldAt(id));
  for (const f of [...((j("operators.json") ?? []) as any[]), ...((j("fields.json") ?? []) as any[])]) { const b = featureExtent(f); if (b) pts.push(b.min, b.max); }
  for (const k of (j("reports/plan.json")?.pockets ?? []) as any[]) if (Array.isArray(k?.at)) pts.push([k.at[0], k.at[1]]);
  return pts.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
}

/** The job's iso views: framed to jobFootprint, ground at the plan's pad (else the root entity's height), the body where
 *  the aerial view's body stands (built-clear), else the footprint centre. [] when the job has no footprint yet. */
export function jobIsoViews(job: string, names: readonly string[] = ISO_DEFAULT): IsoView[] {
  const j = (f: string) => { const p = path.join(job, f); try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null; } catch { return null; } };
  const pts = jobFootprint(job); if (!pts.length) return [];
  const plan = j("reports/plan.json"), root = ((j("ops.json") ?? []) as any[]).find((o) => o?.op === "add-entity" && !o.entity?.parent);
  const y = Number.isFinite(plan?.padY) ? plan.padY : root?.entity?.components?.transform?.position?.[1] ?? 0;
  const aerial = ((j("views.json") ?? []) as any[]).find((v) => v?.name === "aerial-150");
  return isoViews(pts, y, { names, ...(aerial && Number.isFinite(aerial.x) ? { body: [aerial.x, aerial.z] as V2 } : {}) });
}

/** views.json with the iso views FIRST (any older iso-* replaced). Returns the new list and whether it changed. */
export function withIsoViews(views: readonly any[], iso: readonly IsoView[]): { views: any[]; changed: boolean } {
  const rest = views.filter((v) => !/^iso-/.test(String(v?.name ?? "")));
  const next = iso.length ? [...iso, ...rest] : [...views];
  return { views: next, changed: JSON.stringify(next) !== JSON.stringify(views) };
}

// CLI (a LIVE sheet is shot with plain light-shots, not place-build shots): the job's iso spots, framed the same way,
//   npx tsx tools/_iso-views.mts <job dir> [--out <spots.json>] [--names iso-ne,iso-sw]
// then: light-shots --scene <world> --spots <spots.json> --times 12 --no-refs --scope 250 ... (light-shots keeps a review
// spot's body at the place and draws it with the fog off)
if (process.argv[1] && /_iso-views\.mts$/.test(process.argv[1])) {
  const a = process.argv.slice(2), opt = (n: string) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : undefined; };
  const job = a[0]; if (!job || job.startsWith("--")) { console.error("usage: _iso-views.mts <job dir> [--out <spots.json>] [--names iso-ne,iso-sw]"); process.exit(2); }
  const v = jobIsoViews(path.resolve(job), opt("names")?.split(",") ?? ISO_DEFAULT);
  if (!v.length) { console.error(`${job}: no footprint (handoff areas / ops / operators / plan)`); process.exit(1); }
  const out = opt("out"); if (out) { fs.writeFileSync(out, JSON.stringify(v, null, 1) + "\n"); console.log(`${v.length} iso spot(s) -> ${out}`); } else console.log(JSON.stringify(v, null, 1));
}
