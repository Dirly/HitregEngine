/**
 * Place = fit, for structural pieces (tools/structure.mts `fit`, the `scene` gate, docs/place-builder.md "Structural
 * fit"). Every structural catalogue row declares `job.contacts`: local points with what each must touch (floor, roof,
 * rock-face, wall, ledge-top, support, support-edge, roof-or-beam). A placement is accepted only when EVERY contact lands
 * on a real collider surface (tools/_contact.mts, the solver the spider-web planners share): at most 5 cm short of it
 * or 10 cm into it. A stretch fitter (shoring today) measures the site by ray-casting the colliders and rebuilds the
 * piece to those measures through the kit fitter (world-kit desert-ogre-kit build.mjs `fit`), inside the piece's
 * allowed range; a fixed piece is tried at the spot and a small search of offsets and headings. Anything that still
 * misses a contact, or would stretch out of range, is REJECTED with the contact that missed and where.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { closure, projectsRoot } from "./_closure.mjs";
import { applyM4, surfaces, type Anchor, type Proof, type Surfaces, type V3 } from "./_contact.mts";

/** job kinds that hold something up or hang between things: their contacts are proved (the gate and the fitter) */
export const STRUCTURAL_JOBS = new Set(["carries-roof", "braces-wall", "spans", "leans-on-wall", "cantilevers", "hangs"]);
export interface Job { kind: string; note?: string; contacts?: Array<{ what: string; at: V3 }>; [k: string]: unknown }

/** prefab id -> catalogue job, over the project's dependency closure (authoring/prop-catalogs.json of each project) */
export function jobsFor(project: string): Map<string, Job> {
  const out = new Map<string, Job>();
  for (const p of closure(project)) {
    const idx = path.join(projectsRoot(), p, "authoring", "prop-catalogs.json");
    if (!fs.existsSync(idx)) continue;
    for (const c of JSON.parse(fs.readFileSync(idx, "utf8")).catalogs ?? []) {
      try { const rows = JSON.parse(fs.readFileSync(path.join(projectsRoot(), p, c.path), "utf8"))[c.entries];
        for (const r of Array.isArray(rows) ? rows : []) if (r?.id && r.job && !out.has(r.id)) out.set(r.id, r.job); } catch { /* an unreadable catalogue: props status reports it */ }
    }
  }
  return out;
}

/** a placed instance's contacts in world space */
export function worldContacts(job: Job, m: number[]): Anchor[] {
  return (job.contacts ?? []).map((c, i) => ({ id: `${c.what}#${i}`, what: c.what, at: applyM4(m, c.at) }));
}

const quatY = (yaw: number) => [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
const m4 = (pos: V3, yaw: number): number[] => { const c = Math.cos(yaw), s = Math.sin(yaw); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, pos[0], pos[1], pos[2], 1]; };
const rotY = (v: V3, yaw: number): V3 => [v[0] * Math.cos(yaw) + v[2] * Math.sin(yaw), v[1], -v[0] * Math.sin(yaw) + v[2] * Math.cos(yaw)];
const r3 = (v: number) => Math.round(v * 1000) / 1000;

export interface Spot { id: string; piece: string; at: V3; yaw?: number; search?: boolean; room?: string; why?: string; girth?: number;
  /** head-tree: the wall it stands against, across the spot's heading (default left) */ side?: "left" | "right";
  /** shoring: allowed clear width and height (defaults 3.6..10 m wide, 4..13 m high) */ width?: [number, number]; height?: [number, number] }
export interface Placement { id: string; prefabId: string; position: V3; rotation: number[]; proof: Proof; measured?: Record<string, unknown>; spot: Spot; note?: string }
export interface Rejection { id: string; spot: Spot; why: string; missed?: Proof["missed"]; measured?: Record<string, unknown> }

/** fit every spot against the solids; `kitFit(kind, id, args)` builds a stretched piece and returns its prefab id + job */
export function fitSpots(S: Surfaces, spots: Spot[], jobs: Map<string, Job>, kitFit: (kind: string, id: string, args: string[]) => { prefabId: string; job: Job; shift: V3 }): { placed: Placement[]; rejected: Rejection[] } {
  const placed: Placement[] = [], rejected: Rejection[] = [];
  const SEARCH: Array<[number, number, number]> = [[0, 0, 0]];
  for (const d of [0.4, 0.8, 1.2]) for (const [dx, dz] of [[d, 0], [-d, 0], [0, d], [0, -d]]) SEARCH.push([dx!, dz!, 0]);
  for (const a of [10, -10, 20, -20]) SEARCH.push([0, 0, a]);
  for (const spot of spots) {
    const yaw0 = ((spot.yaw ?? 0) * Math.PI) / 180;
    if (spot.piece === "shoring" || spot.piece === "head-tree") { // ---- stretched: measured by ray-casting, rebuilt by the kit fitter ----
      let last: Rejection | null = null, ok = false;
      for (const [dx, dz, da] of spot.search === false ? [SEARCH[0]!] : SEARCH) {
        const yaw = yaw0 + (da * Math.PI) / 180, c: V3 = [spot.at[0] + dx, spot.at[1], spot.at[2] + dz];
        const m = spot.piece === "head-tree" ? measureHeadTree(S, c, yaw, spot) : measureShoring(S, c, yaw, spot);
        if ("why" in m) { last = { id: spot.id, spot, why: m.why, measured: m.measured }; continue; }
        let built: ReturnType<typeof kitFit>;
        // the kit fitter refuses a site it cannot build to (roof too low for posts, ...): that is a rejection, not a crash
        try { built = kitFit(spot.piece, spot.id, m.args); }
        catch (e: any) { const msg = String(e?.stderr || e?.message || e).split(/\r?\n/).find((l) => /^Error: /.test(l))?.replace(/^Error: /, "") ?? "the kit fitter failed";
          last = { id: spot.id, spot, why: `the kit cannot build it: ${msg}`, measured: m.measured }; continue; }
        const pyaw = (m as any).yaw ?? yaw;
        // the kit centres the fitted piece's bounds on its origin (centredBy): the frame's own centre is local +shift
        const off = rotY(built.shift, pyaw), position: V3 = [r3(m.origin[0] - off[0]), r3(m.origin[1] - off[1]), r3(m.origin[2] - off[2])];
        const proof = S.prove(worldContacts(built.job, m4(position, pyaw)));
        if (!proof.ok) { last = { id: spot.id, spot, why: `contact missed after the fit: ${proof.missed.map((x) => `${x.id} ${x.why}`).join("; ")}`, missed: proof.missed, measured: m.measured }; continue; }
        placed.push({ id: spot.id, prefabId: built.prefabId, position, rotation: quatY(pyaw).map(r3), proof, measured: m.measured, spot, note: dx || dz || da ? `slid ${dx}, ${dz} m / ${da} deg` : undefined });
        ok = true; break;
      }
      if (!ok) rejected.push(last ?? { id: spot.id, spot, why: "no fit" });
      continue;
    }
    // ---- a fixed catalogue piece: the spot, then a small search of offsets and headings ----
    const job = jobs.get(spot.piece);
    if (!job?.contacts?.length) { rejected.push({ id: spot.id, spot, why: `${spot.piece} declares no job.contacts in its catalogue row` }); continue; }
    let best: { proof: Proof; position: V3; yaw: number; note?: string } | null = null;
    for (const [dx, dz, da] of spot.search === false ? [SEARCH[0]!] : SEARCH) {
      const yaw = yaw0 + (da * Math.PI) / 180, x = spot.at[0] + dx, z = spot.at[2] + dz;
      // a hanging piece is seated by what it hangs from: the rock over the spot, less its top contact's height
      const hung = job.kind === "hangs" ? job.contacts.find((c) => /roof|beam/.test(c.what)) : undefined;
      const up = hung ? S.ray([x + rotY(hung.at, yaw)[0], spot.at[1] + 1.5, z + rotY(hung.at, yaw)[2]], [0, 1, 0], 30) : null;
      const down = hung ? null : S.ray([x, spot.at[1] + 1.5, z], [0, -1, 0], 4); const y = up ? up.p[1] - hung!.at[1] : down ? down.p[1] : spot.at[1];
      const position: V3 = [r3(x), r3(y), r3(z)], proof = S.prove(worldContacts(job, m4(position, yaw)));
      if (!best || proof.missed.length < best.proof.missed.length) best = { proof, position, yaw, note: dx || dz || da ? `slid ${dx}, ${dz} m / ${da} deg` : undefined };
      if (proof.ok) break;
    }
    if (best?.proof.ok) placed.push({ id: spot.id, prefabId: spot.piece, position: best.position, rotation: quatY(best.yaw).map(r3), proof: best.proof, spot, note: best.note });
    else rejected.push({ id: spot.id, spot, why: `contact missed: ${best!.proof.missed.map((x) => `${x.id} ${x.why}`).join("; ")}`, missed: best!.proof.missed });
  }
  return { placed, rejected };
}

/**
 * Shoring measured at centre c (floor level), frame plane along local X at heading yaw: walls left/right at 1.6 m up
 * set the clear width (posts 0.15 m off the rock), the floor under each post, the roof over the span sampled every
 * 0.5 m (the cribbing is cut to it). In range or rejected.
 */
export function measureShoring(S: Surfaces, c: V3, yaw: number, spot: Spot): { args: string[]; origin: V3; measured: Record<string, unknown> } | { why: string; measured?: Record<string, unknown> } {
  const [wMin, wMax] = spot.width ?? [3.6, 10], [hMin, hMax] = spot.height ?? [4, 13];
  const ax = rotY([1, 0, 0], yaw), floor0 = S.ray([c[0], c[1] + 2, c[2]], [0, -1, 0], 6);
  if (!floor0) return { why: "no floor under the spot (within 4 m)" };
  const fy = floor0.p[1], eye: V3 = [c[0], fy + 1.6, c[2]];
  const L = S.ray(eye, [-ax[0], 0, -ax[2]], 12), R = S.ray(eye, ax, 12);
  if (!L || !R) return { why: `no rock wall within 12 m on the ${!L ? "left" : "right"} at 1.6 m up: a frame here would carry nothing at its sides`, measured: { floor: r3(fy) } };
  const clear = L.t + R.t, W = Math.min(wMax, clear - 2 * (0.15 + 0.4)), mid = (R.t - L.t) / 2; // posts 0.15 m off the rock: no slot a player fits behind
  if (W < wMin) return { why: `the passage is ${r3(clear)} m wall to wall: too narrow for a ${wMin} m frame`, measured: { clear: r3(clear) } };
  const o: V3 = [c[0] + ax[0] * mid, fy, c[2] + ax[2] * mid], X = W / 2 + 0.4;
  const floorAt = (x: number) => { const p = S.ray([o[0] + ax[0] * x, fy + 2, o[2] + ax[2] * x], [0, -1, 0], 5); return p ? p.p[1] : null; };
  const yL = floorAt(-X), yR = floorAt(X);
  if (yL === null || yR === null) return { why: `no floor under the ${yL === null ? "left" : "right"} post`, measured: { W: r3(W) } };
  const base = Math.min(yL, yR), roof: string[] = [], hs: number[] = [];
  for (let x = -X - 1; x <= X + 1 + 1e-9; x += 0.5) {
    const up = S.ray([o[0] + ax[0] * x, base + 1.5, o[2] + ax[2] * x], [0, 1, 0], hMax + 2);
    if (!up) { if (Math.abs(x) <= X) return { why: `no rock roof within ${hMax} m over x ${r3(x)} of the frame: nothing to carry`, measured: { W: r3(W) } }; continue; }
    const h = up.p[1] - base; hs.push(h); roof.push(`${r3(x)}:${r3(h)}`);
  }
  const hLow = Math.min(...hs), hHigh = Math.max(...hs);
  if (hLow < hMin || hHigh > hMax) return { why: `roof ${r3(hLow)}..${r3(hHigh)} m over the floor: outside the frame's ${hMin}..${hMax} m`, measured: { W: r3(W), roof: [r3(hLow), r3(hHigh)] } };
  return { args: ["--width", String(r3(W)), "--roof", roof.join(","), "--floor-left", String(r3(yL - base)), "--floor-right", String(r3(yR - base)), "--capped", "--girth", String(spot.girth ?? 1.3)], origin: [r3(o[0]), r3(base), r3(o[2])],
    measured: { W: r3(W), clear: r3(clear), roof: [r3(hLow), r3(hHigh)], floor: [r3(yL), r3(yR)] } };
}

/**
 * A head-tree (one trunk under a short cap) against a wall: across the heading the nearest rock wall on `side`, the trunk
 * 1.3 m off it, the cap turned to run ALONG the wall (so nothing juts into the passage); roof sampled under the cap.
 */
export function measureHeadTree(S: Surfaces, c: V3, yaw: number, spot: Spot): { args: string[]; origin: V3; yaw: number; measured: Record<string, unknown> } | { why: string; measured?: Record<string, unknown> } {
  const [hMin, hMax] = spot.height ?? [4, 13], across = rotY([1, 0, 0], yaw), sgn = spot.side === "right" ? 1 : -1;
  const f0 = S.ray([c[0], c[1] + 2, c[2]], [0, -1, 0], 6); if (!f0) return { why: "no floor under the spot (within 4 m)" };
  const w = S.ray([c[0], f0.p[1] + 1.6, c[2]], [across[0] * sgn, 0, across[2] * sgn], 12);
  if (!w) return { why: `no rock wall within 12 m on the ${spot.side ?? "left"}: a head-tree stands against one` };
  const d = w.t - (1.3 * 0.55 + 0.6), o: V3 = [c[0] + across[0] * sgn * d, 0, c[2] + across[2] * sgn * d];
  const fl = S.ray([o[0], f0.p[1] + 2, o[2]], [0, -1, 0], 5); if (!fl) return { why: "no floor under the trunk" };
  const base = fl.p[1], along = rotY([0, 0, 1], yaw), roof: string[] = [], hs: number[] = [];
  for (let x = -2.2; x <= 2.2 + 1e-9; x += 0.4) { const up = S.ray([o[0] + along[0] * x, base + 1.5, o[2] + along[2] * x], [0, 1, 0], hMax + 2);
    if (!up) return { why: `no rock roof within ${hMax} m over the cap` }; const h = up.p[1] - base; hs.push(h); roof.push(`${r3(-x)}:${r3(h)}`); }
  const lo = Math.min(...hs), hi = Math.max(...hs);
  if (lo < hMin || hi > hMax) return { why: `roof ${r3(lo)}..${r3(hi)} m over the floor: outside the head-tree's ${hMin}..${hMax} m` };
  // the piece's local X runs along the wall: its heading is the spot's turned 90 deg
  return { args: ["--roof", roof.reverse().join(","), "--floor-left", "0", "--capped", "--girth", String(spot.girth ?? 1.3)], origin: [r3(o[0]), r3(base), r3(o[2])], yaw: yaw + Math.PI / 2,
    measured: { wall: r3(w.t), roof: [r3(lo), r3(hi)] } };
}

/** the world-kit kit fitter as a function: writes the fitted piece into the project, returns its prefab id + job */
export function kitFitter(project: string) {
  const KIT = path.join(projectsRoot(), "world-kit", "authoring", "desert-ogre-kit", "build.mjs");
  return (kind: string, id: string, args: string[]) => {
    const out = execFileSync(process.execPath, [KIT, "fit", kind, "--project", project, "--id", id, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const meta = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
    const cat = JSON.parse(fs.readFileSync(path.join(projectsRoot(), project, "authoring", "desert-ogre-kit-fit", "catalog.json"), "utf8"));
    const row = cat.props.find((r: any) => r.id === meta.id);
    const job: Job = row?.job ?? meta.job;
    if (!job?.contacts) throw new Error(`kit fit ${kind} ${id}: no job.contacts in its catalogue row`);
    return { prefabId: meta.id as string, job, shift: ((row?.centredBy ?? meta.centredBy ?? [0, 0, 0]) as V3) };
  };
}

export { surfaces };
