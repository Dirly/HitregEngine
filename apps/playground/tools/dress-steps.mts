/**
 * Step gate for `dress sockets` (see dress-sockets.mts): the riser/tread profile a player crosses at a building's
 * outside door and up each stair flight, judged against the REAL player controller.
 *
 * Which controller: the player is the `third-person-controller` builtin on a DYNAMIC capsule
 * (packages/scripting/src/builtin.ts + locomotion.ts). It does NOT use Rapier's kinematic autostep
 * (packages/physics/src/queries.ts DEFAULT_CHARACTER.autostep 0.4 m / 0.2 m, only for `moveCharacter` bodies).
 * Its step-up is a ray cast `radius + STEP_LOOK` ahead of the body: the ground there is compared with the plane
 * under the feet, and a rise in (STEP_MIN, stepHeight] is lifted at min(STEP_RATE_MAX, 2*rise*speed/reach) m/s.
 * A rise over stepHeight gets no help at all: the capsule runs into it and stops (jump required). Because the ray
 * measures the TOTAL rise one reach ahead, narrow treads stack: two 0.2 m risers inside 0.6 m read as one 0.4 m lip.
 * Ground following climbs ramps up to UPHILL_RATIO (rise/run).
 *
 * The numbers are read from those sources and the project's player prefab every run, so the gate follows the
 * controller; the defaults below are only used when a source cannot be read.
 *
 * CALIBRATED against the real server player body (PlayerDriver on HeadlessWorld, walk 3 / run 6.5 / sprint 9.5 m/s,
 * no jumping; MMO/WFC/Generated/steps-test/body-walk*.json, 2026-10-01). The code reading above predicted more
 * trouble than the body has:
 *   - a single riser of 0.15 m, and five 0.135 m risers on 0.40 m treads (also approached at 30 degrees), are climbed
 *     at every speed with no slowdown: the old sprint-lift warning (rise*sprint/STEP_LOOK > STEP_RATE_MAX) is wrong,
 *     contact plus the pop cap finish what the step ray does not;
 *   - risers of 0.37 and 0.40 m stop the body dead at every speed (over stepHeight: no step ray, contact cannot lift);
 *   - a flight of 16 x 0.20 m risers on 0.16 m treads, whose look-ahead rise far exceeds stepHeight, is NOT a wall:
 *     the body climbs the whole 3.2 m at every speed, slowly (walk 3.12 s vs 2.20, run 1.47 vs 1.02, sprint 1.13 vs
 *     0.69 ideal over the 6.6 m probe);
 *   - a 0.15 m door step can still stop the body dead when something crosses the doorway 0.50-0.58 m up
 *     (varro-house): the lane sweep below checks the capsule's whole volume, not just the floor profile.
 * Verdicts: riser <= PROVEN_RISER with look-ahead <= PROVEN_LOOK: PASS. A stacked flight no steeper than the measured
 * one: WARN "passable but slow" with the expected delay. A riser over stepHeight: FAIL. Everything in between (risers
 * 0.15-0.35 m, look-ahead 0.27-0.35 m, stacked flights steeper than the measured one): WARN unproven, never PASS.
 * The lane sweep FAILs anything in the capsule standing more than stepHeight above the floor, WARNs an unproven lip.
 */
import fs from "node:fs";
import path from "node:path";

export interface ControllerLimits {
  stepHeight: number; radius: number; /** capsule total height (collider size[1]) */ height: number; stepLook: number; reach: number; stepMin: number; stepRateMax: number;
  uphillRatio: number; uphillDeg: number; runSpeed: number; sprintSpeed: number; source: string[];
  kinematicAutostep?: { maxHeight: number; minWidth: number; note: string };
}

const num = (text: string, re: RegExp): number | null => { const m = re.exec(text); return m ? Number(m[1]) : null; };

/** Read the live limits: controller sources under packages/, the player prefab under the project (read-only). */
export function controllerLimits(engineRoot: string, projDir: string): ControllerLimits {
  const src: string[] = [], read = (p: string) => { try { const t = fs.readFileSync(p, "utf8"); src.push(path.relative(engineRoot, p).split(path.sep).join("/")); return t; } catch { return ""; } };
  const builtin = read(path.join(engineRoot, "packages/scripting/src/builtin.ts")), loco = read(path.join(engineRoot, "packages/scripting/src/locomotion.ts")), queries = read(path.join(engineRoot, "packages/physics/src/queries.ts"));
  let stepHeight = num(builtin, /stepHeight:\s*\{\s*default:\s*([\d.]+)/) ?? 0.35, runSpeed = num(builtin, /\n\s*speed:\s*\{\s*default:\s*([\d.]+)/) ?? 6.5, sprintSpeed = num(builtin, /sprintSpeed:\s*\{\s*default:\s*([\d.]+)/) ?? 9.5;
  const stepLook = num(loco, /const STEP_LOOK\s*=\s*([\d.]+)/) ?? 0.2, stepMin = num(loco, /const STEP_MIN\s*=\s*([\d.]+)/) ?? 0.04, stepRateMax = num(loco, /STEP_RATE_MAX\s*=\s*([\d.]+)/) ?? 5, uphillRatio = num(loco, /UPHILL_RATIO\s*=\s*([\d.]+)/) ?? 1.5;
  let radius = 0.4, height = 1.8;
  const prefab = path.join(projDir, "assets/prefabs/characters/player.json");
  const pt = read(prefab);
  if (pt) {
    try {
      const walk = (o: any): any => { if (!o || typeof o !== "object") return null; if (o.collider && o.script?.name === "third-person-controller") return o; for (const v of Object.values(o)) { const r = walk(v); if (r) return r; } return null; };
      const c = walk(JSON.parse(pt));
      if (c) {
        const size = c.collider.size as number[] | undefined; if (size) { radius = Math.min(size[0] ?? 0.8, size[2] ?? size[0] ?? 0.8) / 2; height = Math.max(2 * radius, size[1] ?? 1.8); }
        const p = c.script.params ?? {}; if (typeof p.stepHeight === "number") stepHeight = p.stepHeight; if (typeof p.speed === "number") runSpeed = p.speed; if (typeof p.sprintSpeed === "number") sprintSpeed = p.sprintSpeed;
      }
    } catch { /* defaults */ }
  }
  const auto = /autostep:\s*\{\s*maxHeight:\s*([\d.]+),\s*minWidth:\s*([\d.]+)/.exec(queries);
  return {
    stepHeight, radius, height, stepLook, reach: radius + stepLook, stepMin, stepRateMax, uphillRatio, uphillDeg: (Math.atan(uphillRatio) * 180) / Math.PI, runSpeed, sprintSpeed, source: src,
    ...(auto ? { kinematicAutostep: { maxHeight: Number(auto[1]), minWidth: Number(auto[2]), note: "Rapier autostep (DEFAULT_CHARACTER) applies to kinematic moveCharacter bodies; the player is a dynamic body and does not use it" } } : {}),
  };
}

/** Up-facing surface heights over (x, z) in the map's local frame. */
export type Surfaces = (x: number, z: number) => number[];
export interface ProbeLine { id: string; kind: "entry" | "flight"; level: number; start: [number, number]; dir: [number, number]; length: number; startY: number; /** entry only: walking OUTWARD, so the profile is reversed */ outward?: boolean; /** distance along the WALKING profile of the outer face / doorway centre (lane sweep reference) */ face?: number }

export interface StepProfile {
  id: string; kind: "entry" | "flight"; level: number;
  risers: number[]; treads: number[]; steps: number; maxRiser: number; minTread: number | null; maxLookRise: number; maxRampDeg: number; totalRise: number;
  ground: string; samples: [number, number][];
  verdict: "PASS" | "WARN" | "FAIL"; reasons: string[];
}

const SAMPLE = 0.02;
/** Tallest single riser (and look-ahead rise) the real body climbed at walk, run and sprint with no slowdown. */
export const PROVEN_RISER = 0.15;
/**
 * Tallest look-ahead rise (as {@link analyse} measures it) the body climbed without stalling. Proven by the Tidewell kit
 * stair (24 risers of 0.133 m on 0.18 m treads, 3.2 m; corran-house and every tidewell-* map), which reads 0.267 m here:
 * the real player body climbed exactly that flight at walk, run and sprint, 4-16% slower than level ground, no stall
 * (2026-10-01). Earlier proof: drowned-lantern's door, a 0.15 m riser with the terrain falling 26 degrees outside (0.25 m).
 * Beyond this, up to stepHeight, stays UNPROVEN.
 */
export const PROVEN_LOOK = 0.27;
/** The one measured stacked flight (corran-house): riser and rise/tread; flights within it are passable but slow. */
const FLIGHT_PROVEN = { riser: 0.2, steep: 0.2 / 0.16 };
/** Extra seconds per metre of rise on such a flight, measured over 3.2 m: walk +0.92 s, run +0.45 s, sprint +0.44 s. */
const SLOW_PER_M = { walk: 0.92 / 3.2, run: 0.45 / 3.2, sprint: 0.44 / 3.2 };

/**
 * Walk a line sampling the walking surface: at each sample the highest up-facing surface in a window around the
 * current height (so a slab overhead or a floor below is ignored). Where the ground stands above the model's surface (or the model has none), the ground is the walking surface.
 */
export function profileLine(surf: Surfaces, line: ProbeLine, ground: (x: number, z: number) => number | null, groundLabel: string, up = 0.6): { s: number[]; h: number[]; ground: string } {
  const s: number[] = [], h: number[] = []; let cur = line.startY, usedGround = false, lost = false;
  for (let d = 0; d <= line.length + 1e-9; d += SAMPLE) {
    const x = line.start[0] + line.dir[0] * d, z = line.start[1] + line.dir[1] * d;
    const lo = cur - (line.outward ? 1.5 : 0.6), hi = cur + up; let best = -Infinity;
    for (const y of surf(x, z)) if (y >= lo && y <= hi && y > best) best = y;
    // the ground (terrain) is walked on wherever it stands above the model: it buries a pad's lower steps
    const g = ground(x, z); if (g !== null && Number.isFinite(g) && g >= lo && g <= hi && g >= best) { best = g; usedGround = true; }
    if (!Number.isFinite(best)) { lost = true; break; }
    cur = best; s.push(d); h.push(best);
  }
  if (line.outward) { const L = s[s.length - 1] ?? 0; s.reverse(); h.reverse(); for (let i = 0; i < s.length; i++) s[i] = L - s[i]!; }
  return { s, h, ground: usedGround ? groundLabel : lost ? "model ends, no ground (profile stops at the model's edge)" : "model surfaces only" };
}

export function analyse(line: ProbeLine, prof: { s: number[]; h: number[]; ground: string }, L: ControllerLimits): StepProfile {
  const { s, h } = prof, n = s.length;
  // risers: rises over a sample too steep for any walkable ramp, merged while consecutive
  const risers: number[] = [], riserAt: number[] = [], rampTan = Math.tan((60 * Math.PI) / 180) * SAMPLE * 1.05;
  for (let i = 0; i + 1 < n; i++) {
    const dh = h[i + 1]! - h[i]!;
    if (dh > Math.max(L.stepMin, rampTan)) { if (riserAt.length && riserAt[riserAt.length - 1]! >= s[i]! - SAMPLE * 1.5) { risers[risers.length - 1]! += dh; riserAt[riserAt.length - 1] = s[i + 1]!; } else { risers.push(dh); riserAt.push(s[i + 1]!); } }
  }
  const treads: number[] = []; for (let i = 1; i < riserAt.length; i++) treads.push(riserAt[i]! - riserAt[i - 1]!);
  // ramps: slope over 0.1 m windows containing no riser
  let maxRamp = 0; const W = Math.round(0.1 / SAMPLE);
  for (let i = 0; i + W < n; i++) { let jump = false; for (let k = i; k < i + W; k++) if (Math.abs(h[k + 1]! - h[k]!) > rampTan) jump = true; if (jump) continue; const g = (h[i + W]! - h[i]!) / (s[i + W]! - s[i]!); maxRamp = Math.max(maxRamp, (Math.atan(Math.max(0, g)) * 180) / Math.PI); }
  // the controller's own measurement: ground one reach ahead against the plane under the feet (ring radius 0.75 r)
  const at = (d: number) => { const i = Math.min(n - 1, Math.max(0, Math.round(d / SAMPLE))); return h[i]!; };
  let maxLook = 0; const ring = L.radius * 0.75;
  for (let i = 0; i < n; i++) {
    const x = s[i]!; if (x + L.reach > s[n - 1]!) break;
    let under = -Infinity; for (let d = x - ring; d <= x + ring + 1e-9; d += SAMPLE) under = Math.max(under, at(d));
    const g0 = at(x - 0.05), g1 = at(x + 0.05), slope = Math.abs(g1 - g0) <= rampTan * 5 ? (g1 - g0) / 0.1 : 0;
    maxLook = Math.max(maxLook, at(x + L.reach) - (under + Math.max(0, slope) * L.reach));
  }
  const maxRiser = risers.length ? Math.max(...risers) : 0, minTread = treads.length ? Math.min(...treads) : null;
  const reasons: string[] = []; let verdict = "PASS" as StepProfile["verdict"];
  const fail = (r: string) => { verdict = "FAIL"; reasons.push(r); }, warn = (r: string) => { if (verdict === "PASS") verdict = "WARN"; reasons.push(r); };
  const sh = L.stepHeight, P = PROVEN_RISER + 0.005;
  const steep = minTread !== null && minTread > 0 ? maxRiser / minTread : 0, total = (h[n - 1] ?? 0) - (h[0] ?? 0);
  const within = maxRiser <= FLIGHT_PROVEN.riser + 0.005 && steep <= FLIGHT_PROVEN.steep + 0.02, slowFlight = maxLook > sh;
  if (maxRiser > sh) fail(`riser ${maxRiser.toFixed(2)} m > stepHeight ${sh} m: no step-ray lift and contact cannot climb it, the body stops dead at every speed (measured: 0.37 and 0.40 m risers stopped the real body; jump needed)`);
  if (maxRamp > L.uphillDeg) fail(`ramp ${maxRamp.toFixed(0)}° > ground-following limit ${L.uphillDeg.toFixed(0)}° (UPHILL_RATIO ${L.uphillRatio})`);
  if (verdict !== "FAIL") {
    const PL = PROVEN_LOOK + 0.005;
    if (slowFlight) {
      // the look-ahead sees more than stepHeight: the step ray gives NO lift and contact (clipped to the pop cap) has to climb
      const slowRun = total * SLOW_PER_M.run, slowSprint = total * SLOW_PER_M.sprint, slowWalk = total * SLOW_PER_M.walk;
      if (minTread !== null && within)
        warn(`PASSABLE BUT SLOW: treads of ${minTread.toFixed(2)} m stack ${maxLook.toFixed(2)} m inside the ${L.reach.toFixed(2)} m look-ahead (> stepHeight ${sh} m), so the step ray gives no lift and contact climbs it: expect about +${slowWalk.toFixed(2)} s walking, +${slowRun.toFixed(2)} s running, +${slowSprint.toFixed(2)} s sprinting over this ${total.toFixed(2)} m rise (scaled from the measured corran-house flight, 16 x 0.20 m on 0.16 m treads: run 1.47 s vs 1.02 s ideal, sprint 1.13 vs 0.69)`);
      else
        warn(`UNPROVEN, may stop dead: ${minTread === null ? "the riser and the ground or lip around it" : `treads of ${minTread.toFixed(2)} m`} add up to ${maxLook.toFixed(2)} m inside the ${L.reach.toFixed(2)} m look-ahead (> stepHeight ${sh} m), so the step ray gives no lift and contact alone must climb a ${maxRiser.toFixed(2)} m riser${minTread !== null ? ` (rise/tread ${steep.toFixed(2)})` : ""}; measured, contact climbed 0.20 m risers on 0.16 m treads (slowly) and never a 0.37 m riser. If it goes, expect at least +${slowRun.toFixed(2)} s running`);
    } else if (maxRiser > P) warn(`riser ${maxRiser.toFixed(2)} m is in the UNPROVEN range ${PROVEN_RISER}-${sh} m: under stepHeight, so the step ray should lift it, but no body walk has covered it (proven: <= ${PROVEN_RISER} m climbs at every speed, >= 0.37 m stops dead)`);
    else if (maxLook > PL) warn(`look-ahead rise ${maxLook.toFixed(2)} m is in the UNPROVEN range ${PROVEN_LOOK}-${sh} m (treads or the ground stack inside the reach; under stepHeight so the step ray should lift it, not yet walked)`);
    if (maxRamp > 0.8 * L.uphillDeg) warn(`ramp ${maxRamp.toFixed(0)}° is within 20% of the ${L.uphillDeg.toFixed(0)}° climb limit`);
  }
  // keep a light trace: every 5th sample
  const samples: [number, number][] = []; for (let i = 0; i < n; i += 5) samples.push([Math.round(s[i]! * 100) / 100, Math.round(h[i]! * 1000) / 1000]);
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return { id: line.id, kind: line.kind, level: line.level, risers: risers.map(r3), treads: treads.map(r3), steps: risers.length, maxRiser: r3(maxRiser), minTread: minTread === null ? null : r3(minTread), maxLookRise: r3(maxLook), maxRampDeg: Math.round(maxRamp * 10) / 10, totalRise: r3((h[n - 1] ?? 0) - (h[0] ?? 0)), ground: prof.ground, samples, verdict, reasons };
}

export function stepTable(id: string, profiles: StepProfile[]): string {
  const rows = profiles.map((p) => `  ${p.id.padEnd(10)} ${String(p.steps).padStart(5)}  ${p.maxRiser.toFixed(2).padStart(7)}  ${(p.minTread === null ? "-" : p.minTread.toFixed(2)).padStart(7)}  ${p.maxLookRise.toFixed(2).padStart(6)}  ${p.maxRampDeg.toFixed(0).padStart(4)}°  ${p.verdict}`);
  return `${id} steps\n  ${"where".padEnd(10)} steps  riser^  tread_  look^  ramp^  verdict\n${rows.join("\n")}`;
}

// ---------------------------------------------------------------- doorway lane sweep

/** Triangles in the map's local frame (9 floats each), with optional per-triangle source names. */
export interface LaneSoup { pos: Float32Array; node?: Uint16Array; names?: string[] }
export interface LaneObstruction {
  /** block: reaches above stepHeight, the capsule stops against it; lip: no higher than PROVEN_RISER, climbed like a riser;
   *  unproven-lip: a low edge between the two, judged like an unproven riser */
  kind: "block" | "lip" | "unproven-lip"; mesh: string; tris: number;
  /** along the walk, metres relative to the doorway (outer face for the entry): negative = before it (outside) */
  along: [number, number];
  /** across the lane, metres from its centre line (+ = left of the walking direction) */
  across: [number, number];
  /** height above the floor the body stands on there, metres */
  above: [number, number];
  /** model-space y */
  y: [number, number];
}
export interface LaneSweep {
  id: string; kind: "entry-lane" | "doorway-lane" | "flight-lane"; level: number;
  /** model-space XZ of the doorway reference point, and the walking direction */
  at: [number, number]; dir: [number, number];
  /** swept capsule centres, metres relative to the reference (negative = before it) */
  span: [number, number]; radius: number; height: number; floor: string;
  verdict: "PASS" | "WARN" | "FAIL"; reasons: string[]; obstructions: LaneObstruction[];
}

/**
 * Sweep the player's capsule (radius, total height from the prefab collider) along a probe line, standing on the
 * walking surface the floor profile found, and report every piece of geometry inside it that is not that surface
 * (the floor, the treads, the risers). Anything else in the lane — a beam, a sill, a jamb narrower than the body, a
 * lintel under head height — stops the real body regardless of how gentle the steps are.
 * `from`/`to` are capsule-centre distances along the WALKING profile.
 */
export function sweepLane(soup: LaneSoup, line: ProbeLine, prof: { s: number[]; h: number[]; ground: string }, L: ControllerLimits,
  o: { id: string; kind: LaneSweep["kind"]; from: number; to: number; ref: number }): LaneSweep {
  const r = L.radius, H = L.height, { s: ps, h: ph } = prof, n = ps.length;
  const w: [number, number] = line.outward ? [-line.dir[0], -line.dir[1]] : [line.dir[0], line.dir[1]], lat: [number, number] = [-w[1], w[0]];
  const origin: [number, number] = line.outward ? [line.start[0] + line.dir[0] * (ps[n - 1] ?? line.length), line.start[1] + line.dir[1] * (ps[n - 1] ?? line.length)] : [line.start[0], line.start[1]];
  const idx = (x: number) => Math.min(n - 1, Math.max(0, Math.round((x - (ps[0] ?? 0)) / SAMPLE)));
  const floorAt = (x: number) => ph[idx(x)]!;
  const support = (x: number) => { let m = -Infinity; for (let i = idx(x - 0.04); i <= idx(x + 0.04); i++) m = Math.max(m, ph[i]!); return m; };
  const from = Math.max(o.from, ps[0] ?? 0), to = Math.min(o.to, ps[n - 1] ?? 0);
  let yLo = Infinity, yHi = -Infinity; for (let i = idx(from - r); i <= idx(to + r); i++) { yLo = Math.min(yLo, ph[i]!); yHi = Math.max(yHi, ph[i]!); }
  const P = soup.pos, T = P.length / 9, hits: { s: number; t: number; y: number; above: number; node: number; tri: number }[] = [];
  const pt = (k: number): [number, number, number] => { const dx = P[k]! - origin[0], dz = P[k + 2]! - origin[1]; return [dx * w[0] + dz * w[1], dx * lat[0] + dz * lat[1], P[k + 1]!]; };
  for (let t = 0; t < T; t++) {
    const A = pt(t * 9), B = pt(t * 9 + 3), C = pt(t * 9 + 6);
    if (Math.max(A[0], B[0], C[0]) < from - r || Math.min(A[0], B[0], C[0]) > to + r) continue;
    if (Math.max(A[1], B[1], C[1]) < -r || Math.min(A[1], B[1], C[1]) > r) continue;
    if (Math.max(A[2], B[2], C[2]) < yLo || Math.min(A[2], B[2], C[2]) > yHi + H) continue;
    const edge = Math.max(Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]), Math.hypot(B[0] - C[0], B[1] - C[1], B[2] - C[2]), Math.hypot(C[0] - A[0], C[1] - A[1], C[2] - A[2]));
    const m = Math.max(1, Math.min(400, Math.ceil(edge / 0.03)));
    let found = 0;
    for (let i = 0; i <= m && found < 400; i++) for (let j = 0; i + j <= m && found < 400; j++) {
      const a = i / m, b = j / m, c = 1 - a - b, s = a * A[0] + b * B[0] + c * C[0], q = a * A[1] + b * B[1] + c * C[1], y = a * A[2] + b * B[2] + c * C[2];
      if (Math.abs(q) >= r - 0.02 || s < from - r || s > to + r) continue;
      if (y <= support(s) + 0.03) continue; // the walking surface itself: floor, tread, riser
      for (let cc = Math.max(from, s - r); cc <= Math.min(to, s + r) + 1e-9; cc += 0.02) {
        const rho2 = (s - cc) ** 2 + q * q, rr = (r - 0.02) ** 2; if (rho2 >= rr) continue;
        const k = Math.sqrt(rr - rho2), base = floorAt(cc);
        if (y > base + r - k + 0.01 && y < base + H - r + k - 0.01) { hits.push({ s, t: q, y, above: y - floorAt(s), node: soup.node?.[t] ?? 0, tri: t }); found++; break; }
      }
    }
  }
  // group by source name, split along the walk where hits are more than 0.2 m apart
  const groups = new Map<number, typeof hits>(); for (const h of hits) { const g = groups.get(h.node) ?? []; g.push(h); groups.set(h.node, g); }
  const obstructions: LaneObstruction[] = [], r2 = (v: number) => Math.round(v * 100) / 100;
  for (const [node, list] of groups) {
    list.sort((a, b) => a.s - b.s);
    let cur: typeof hits = [];
    const flush = () => { if (!cur.length) return; const ext = (f: (h: (typeof hits)[number]) => number): [number, number] => [r2(Math.min(...cur.map(f))), r2(Math.max(...cur.map(f)))];
      const above = ext((h) => h.above); obstructions.push({ kind: above[1] > L.stepHeight ? "block" : above[1] > PROVEN_RISER + 0.005 ? "unproven-lip" : "lip", mesh: soup.names?.[node] ?? `#${node}`, tris: new Set(cur.map((h) => h.tri)).size, along: ext((h) => h.s - o.ref), across: ext((h) => h.t), above, y: ext((h) => h.y) }); cur = []; };
    for (const h of list) { if (cur.length && h.s - cur[cur.length - 1]!.s > 0.2) flush(); cur.push(h); }
    flush();
  }
  obstructions.sort((a, b) => a.along[0] - b.along[0]);
  const blocks = obstructions.filter((b) => b.kind === "block");
  const at: [number, number] = [origin[0] + w[0] * o.ref, origin[1] + w[1] * o.ref], reasons = obstructions.map((b) =>
    `${b.kind === "lip" ? "(lip, climbable: under the proven riser) " : b.kind === "unproven-lip" ? `(UNPROVEN lip, ${PROVEN_RISER}-${L.stepHeight} m: a low edge the floor profile missed) ` : ""}${b.mesh} intrudes into the ${(2 * r).toFixed(2)} m x ${H.toFixed(2)} m player lane ${b.above[0].toFixed(2)}-${b.above[1].toFixed(2)} m above the floor, ${b.along[0].toFixed(2)} to ${b.along[1].toFixed(2)} m ${o.kind === "entry-lane" ? "from the outer face (negative = outside)" : o.kind === "flight-lane" ? "from the foot of the flight" : "from the doorway centre"}, ${b.across[0].toFixed(2)} to ${b.across[1].toFixed(2)} m across the lane${b.kind === "block" ? ": the capsule stops against it" : ""}`);
  return { id: o.id, kind: o.kind, level: line.level, at: [r2(at[0]), r2(at[1])], dir: [r2(w[0]), r2(w[1])], span: [r2(from - o.ref), r2(to - o.ref)], radius: r, height: H, floor: prof.ground,
    verdict: blocks.length ? "FAIL" : obstructions.some((b) => b.kind === "unproven-lip") ? "WARN" : "PASS", reasons, obstructions };
}

export function laneTable(lanes: LaneSweep[]): string {
  return lanes.map((l) => `  ${l.id.padEnd(16)} ${l.verdict}${l.obstructions.length ? "  " + l.obstructions.map((b) => `${b.kind} ${b.mesh} +${b.above[0].toFixed(2)}..${b.above[1].toFixed(2)} m at ${b.along[0].toFixed(2)}..${b.along[1].toFixed(2)}`).join("; ") : ""}`).join("\n");
}
