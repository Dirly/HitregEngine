/**
 * Dungeon quality gates: machine checks of the bar in docs/world-standards/dungeons.md ("Quality recipe"), each
 * writing reports/quality/<gate>.json { passed, metrics, failures, excepted }. The shared pipeline
 * (pipeline.mjs) runs them as stages, so a FAILED gate blocks `--next` like any other stage.
 *
 *   node ../../../../tools/dungeon-pipeline/quality.mjs <gate|all> [--project <dir>] [--build] [--print]
 *     (from projects/<id>; --project defaults to the working directory)
 *
 * Gates: noise, originality, atlas, matte, recipe, culling, stairs, readability, compare (README.md). Numbers: thresholds.json. A dungeon that must
 * differ writes authoring/quality-exceptions.json:
 *   { "version": 1, "exceptions": [ { "gate": "recipe", "check": "decalsMin", "space": "drowned" | "*", "why": "..." } ] }
 * An exception needs a `why`; it turns the matching failures into `excepted` lines (still printed).
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const T = JSON.parse(fs.readFileSync(path.join(HERE, "thresholds.json"), "utf8"));
const readJson = (full) => { try { return JSON.parse(fs.readFileSync(full, "utf8")); } catch { return null; } };
const exists = (f) => fs.existsSync(f);

// ---------------------------------------------------------------- shared context

export function ctxOf(root) {
  root = path.resolve(root);
  const id = path.basename(root);
  const projects = path.dirname(root);
  const f = (rel) => path.join(root, rel);
  return { root, id, projects, f, plan: readJson(f("authoring/plan.json")), stampRel: `authoring/${id}.mesh-stamp.json` };
}

const COMMON_INPUTS = (root) => [path.join(HERE, "thresholds.json"), path.join(HERE, "quality.mjs"), path.join(root, "authoring/quality-exceptions.json")];

function listFiles(dir, filter = () => true, skip = []) {
  const out = [];
  if (!exists(dir)) return out;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const full = path.join(d, e.name); if (e.isDirectory()) { if (!skip.includes(e.name)) walk(full); } else if (filter(e.name, full)) out.push(full); } };
  walk(dir);
  return out;
}

function palettes(c) { return listFiles(c.f("assets/materials"), (n) => n === "dc-palette.json"); }
export function sceneFile(c) {
  const p = c.f(`assets/scenes/${c.id}.scene.json`);
  if (exists(p)) return p;
  const sb = readJson(c.f("reports/scene-build.json"));
  return sb?.scene ? path.resolve(c.root, sb.scene) : p;
}
export function ownSheet(c) {
  for (const rel of ["reports/views/sheet.png", "authoring/views/sheet.png"]) if (exists(c.f(rel))) return c.f(rel);
  return c.f("reports/views/sheet.png");
}
function referenceSheets(c) {
  return Object.entries(T.references).filter(([k]) => k !== "about" && k !== c.id).map(([k, rel]) => ({ id: k, file: path.join(c.projects, k, rel) }));
}

/** Builder files of one project (originality). */
function builderFiles(projectRoot) {
  const pats = T.originality.builderFiles.map((r) => new RegExp(r));
  return listFiles(path.join(projectRoot, "authoring"), (n) => pats.some((r) => r.test(n)), T.originality.skipDirs);
}
function otherDungeons(c) {
  const ignore = Object.keys(T.originality.ignoreProjects);
  return fs.readdirSync(c.projects, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== c.id && !ignore.includes(e.name))
    .map((e) => path.join(c.projects, e.name))
    .filter((d) => exists(path.join(d, "authoring/plan.json")) && exists(path.join(d, "authoring/pipeline.mjs")));
}

export const GATES = {
  noise: { note: "natural roles carry geometry noise: authoring/noise.json exists, the stamp embeds it, natural solids are noised, no box lumps, no flat natural ceilings" },
  originality: { note: "no set-piece builder or build script shared with another dungeon (function + file hashes across projects/*/authoring; lib/ primitives allowed)" },
  atlas: { note: "ONE atlas page; every role mapped into it; one stone / wood / metal colouring (hue + saturation bands); tints only darken" },
  recipe: { note: "per room: built detail, props via dressing plans (count, kinds), bone cap, 2-5 visible light sources with fixtures, 6-12 decals (>= 3 textures), a set piece" },
  readability: { note: "shipped-light views read dim, never black: per-view near-black share, the median view's near-black share, mean luminance band and flat-fill floor (thresholds.json readability)" },
  matte: { note: "every surface matte unless intended: atlas roles, own material assets and own models roughness >= 0.9 (metal roles >= 0.6), metalness 0 except metal" },
  culling: { note: "interior pop-in along the route: every room's dressing is shown when the walker enters the room (scene cullingProfile; docs/culling.md 'Interior scenes')" },
  stairs: { note: "stair ceilings follow the stair: along every stair/ramp line the clear height above the walking surface stays >= 2.6 m and within a band (no flat ceiling pinch, no stepped roof), cast from the shipped GLBs" },
  arrival: { note: "arrival safe zone: no pack, patrol point, named or boss within safeM (thresholds.json arrival) of any arrival or exit portal anchor, so a player who arrives or leaves is never pulled into the fight lock" },
  compare: { note: "reports/compare.png: this dungeon's shipped-light sheet beside fieldfast-barrow and fieldfast-hall, newer than the views (--build makes it)" },
};

/** The files a gate reads (its stage is STALE when any is newer than its report). */
export function gateInputs(name, root) {
  const c = ctxOf(root);
  const base = COMMON_INPUTS(c.root);
  switch (name) {
    case "noise": return [...base, c.f("authoring/noise.json"), c.f(c.stampRel), c.f("reports/source-audit.json"), c.f("authoring/plan.json")];
    // own builders only: a later copy is judged on the copier's side, so edits elsewhere never re-stale this gate
    case "originality": return [...base, ...builderFiles(c.root)];
    case "atlas": return [...base, c.f("reports/materials.json"), ...palettes(c)];
    case "recipe": return [...base, c.f("authoring/plan.json"), c.f("reports/source-audit.json"), sceneFile(c), c.f("authoring/dressing/plans"), c.f("authoring/room-sheet.json")];
    case "compare": return [...base, ownSheet(c), ...referenceSheets(c).map((r) => r.file)];
    case "readability": return [...base, ownSheet(c)];
    case "matte": return [...base, c.f("reports/materials.json"), c.f("assets/materials"), c.f("assets/models")];
    case "culling": return [...base, sceneFile(c), c.f("authoring/plan.json")];
    case "arrival": return [...base, c.f("authoring/plan.json")];
    case "stairs": return [...base, c.f("authoring/plan.json"), c.f("authoring/rooms.json"), c.f("reports/kit/markers.json"), c.f("assets/models")];
    default: return base;
  }
}

let DRY = false;
/** Measure only: gates return their report without writing reports/quality (the CLI flag --dry). */
export function setDry(on) { DRY = !!on; }

function exceptionsOf(c) {
  const j = readJson(c.f("authoring/quality-exceptions.json"));
  return (j?.exceptions ?? []).filter((e) => e && typeof e.why === "string" && e.why.trim().length >= 8);
}

/** Write reports/quality/<gate>.json from raw failures {space?, check, what}. */
export function gateReport(c, gate, failures, metrics) {
  const ex = exceptionsOf(c).filter((e) => e.gate === gate);
  const match = (f) => ex.find((e) => e.check === f.check && (e.space === "*" || e.space === undefined || e.space === f.space));
  const failing = [], excepted = [];
  for (const f of failures) { const e = match(f); if (e) excepted.push({ ...f, why: e.why }); else failing.push(f); }
  const report = { gate, passed: failing.length === 0, at: new Date().toISOString(), rule: GATES[gate].note, thresholds: "tools/dungeon-pipeline/thresholds.json", failures: failing, excepted, metrics };
  if (DRY) return report; // --dry: measure without writing (calibrating on dungeons this session must not touch)
  fs.mkdirSync(c.f("reports/quality"), { recursive: true });
  fs.writeFileSync(c.f(`reports/quality/${gate}.json`), JSON.stringify(report, null, 1) + "\n");
  return report;
}

// ---------------------------------------------------------------- plan spaces (footprints in plan x/y, z up)

const kindsOf = () => T.spaces;
export function spaceClass(sp) {
  if (kindsOf().roomKinds.includes(sp.kind)) return "room";
  if (kindsOf().passageKinds.includes(sp.kind)) return "passage";
  return "other";
}
function isNatural(sp) {
  const S = kindsOf();
  return S.naturalKinds.includes(sp.kind) || S.naturalRoles.includes(sp.wallRole) || S.naturalRoles.includes(sp.roofRole);
}
export function footprint(sp) {
  const num = (v) => typeof v === "number" && Number.isFinite(v);
  let zs = [];
  if (num(sp.floor)) zs.push(sp.floor);
  if (Array.isArray(sp.profile)) for (const e of sp.profile) if (e[0] === "flat" && num(e[3])) zs.push(e[3]);
  if (Array.isArray(sp.floorProfile)) for (const e of sp.floorProfile) if (num(e[1])) zs.push(e[1]);
  const top = sp.wallH ?? sp.height ?? sp.clear ?? 4;
  const z = zs.length ? [Math.min(...zs) - 1.5, Math.max(...zs) + top + 3] : null;
  if (Array.isArray(sp.x) && Array.isArray(sp.y)) return { type: "rect", x: sp.x, y: sp.y, z, length: Math.max(sp.x[1] - sp.x[0], sp.y[1] - sp.y[0]) };
  if (sp.axis && Array.isArray(sp.s) && Array.isArray(sp.cross)) {
    const s = [Math.min(...sp.s), Math.max(...sp.s)];
    const r = sp.axis === "x" ? { x: s, y: sp.cross } : { x: sp.cross, y: s };
    return { type: "rect", ...r, z, length: s[1] - s[0] };
  }
  if (Array.isArray(sp.poly)) return { type: "poly", poly: sp.poly, z, length: 0 };
  if (Array.isArray(sp.path)) {
    let L = 0; for (let i = 1; i < sp.path.length; i++) L += Math.hypot(sp.path[i][0] - sp.path[i - 1][0], sp.path[i][1] - sp.path[i - 1][1]);
    return { type: "path", path: sp.path, z, length: L };
  }
  return null;
}
function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function segDist(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1]; const L = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / L));
  return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
}
export function contains(fp, x, y, z, pad = 0.6) {
  if (!fp) return false;
  if (fp.z && (z < fp.z[0] || z > fp.z[1])) return false;
  if (fp.type === "rect") return x >= fp.x[0] - pad && x <= fp.x[1] + pad && y >= fp.y[0] - pad && y <= fp.y[1] + pad;
  if (fp.type === "poly") return inPoly(x, y, fp.poly) || fp.poly.some((p, i) => segDist(x, y, p, fp.poly[(i + 1) % fp.poly.length]) < pad);
  for (let i = 1; i < fp.path.length; i++) if (segDist(x, y, fp.path[i - 1], fp.path[i]) <= (fp.path[i][2] ?? 2.4) / 2 + pad) return true;
  return false;
}
/** engine position [x, y_up, z] -> the space that holds it (rooms win over passages; nearest floor wins). */
function spaceAt(spaces, pos) {
  const x = pos[0], y = -pos[2], z = pos[1];
  const hits = spaces.filter((s) => contains(s.fp, x, y, z));
  if (!hits.length) return null;
  hits.sort((a, b) => (a.cls === "room" ? 0 : 1) - (b.cls === "room" ? 0 : 1) || Math.abs((a.sp.floor ?? z) - z) - Math.abs((b.sp.floor ?? z) - z));
  return hits[0].sp.id;
}

// ---------------------------------------------------------------- scene helpers

function qmul(a, b) { return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]]; }
function qrot(q, v) { const [x, y, z, w] = q; const ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2], iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2]; return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x]; }
export function worldPositions(entities) {
  const memo = new Map();
  const get = (id) => {
    if (memo.has(id)) return memo.get(id);
    const e = entities[id]; const t = e?.components?.transform ?? {};
    const lp = t.position ?? [0, 0, 0], lr = t.rotation ?? [0, 0, 0, 1], ls = t.scale ?? [1, 1, 1];
    let r = { p: lp, q: lr, s: ls };
    if (e?.parent && entities[e.parent] && e.parent !== id) {
      const P = get(e.parent); const sp = [lp[0] * P.s[0], lp[1] * P.s[1], lp[2] * P.s[2]]; const rp = qrot(P.q, sp);
      r = { p: [P.p[0] + rp[0], P.p[1] + rp[1], P.p[2] + rp[2]], q: qmul(P.q, lr), s: [P.s[0] * ls[0], P.s[1] * ls[1], P.s[2] * ls[2]] };
    }
    memo.set(id, r); return r;
  };
  return (id) => get(id).p;
}
/** Does a prefab emit light? (its JSON holds a light component, directly or in a nested prefab) */
function prefabEmits(c, prefabId, seen = new Set()) {
  if (seen.has(prefabId)) return false; seen.add(prefabId);
  const cands = [path.join(c.root, "assets/prefabs", prefabId + ".json"), path.join(c.projects, "voxel-demo/assets/prefabs", prefabId + ".json"), path.join(c.projects, "foundation/assets/prefabs", prefabId + ".json"), path.join(c.projects, "..", "assets/prefabs", prefabId + ".json")];
  const file = cands.find(exists);
  if (!file) return false;
  const text = fs.readFileSync(file, "utf8");
  if (/"light"\s*:\s*\{/.test(text)) return true;
  for (const m of text.matchAll(/"prefabId"\s*:\s*"([^"]+)"/g)) if (prefabEmits(c, m[1], seen)) return true;
  return false;
}
function bucketFixtures(c) {
  const files = [c.f("authoring/light-buckets.json"), path.join(c.projects, "..", "tools/light-buckets.json")];
  const set = new Set();
  for (const f of files) { const j = readJson(f); for (const b of Object.values(j?.buckets ?? {})) for (const u of b.use ?? []) set.add(u); }
  return set;
}

// ---------------------------------------------------------------- PNG stats

let _png = null;
async function png() { if (!_png) _png = await import(pathToFileURL(path.join(HERE, "../texture-intake/png.mjs")).href); return _png; }
async function meanColour(file, alphaMin = 128) {
  const { decodePng } = await png();
  const img = decodePng(fs.readFileSync(file));
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < img.data.length; i += 4) { if (img.data[i + 3] < alphaMin) continue; r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++; }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
}
function hsv([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 0) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: mx ? d / mx : 0, v: mx / 255 };
}
const hex = (s) => { const m = /^#?([0-9a-f]{6})$/i.exec(s ?? "#ffffff"); const n = parseInt(m ? m[1] : "ffffff", 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const luma = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
const hueDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

// ---------------------------------------------------------------- gate: noise

async function gateNoise(c) {
  const N = T.noise, failures = [], metrics = {};
  const spaces = (c.plan?.spaces ?? []);
  const natural = spaces.filter(isNatural);
  metrics.naturalSpaces = natural.map((s) => s.id);
  const stamp = readJson(c.f(c.stampRel));
  if (!stamp) failures.push({ check: "stamp", what: `no exported stamp ${c.stampRel}` });
  const palette = (stamp?.palette ?? []).map((p) => p.id);
  const naturalRole = (r) => T.spaces.naturalRoles.includes(r);
  let allTris = 0, natAll = 0;
  for (const m of stamp?.meshes ?? []) for (const i of m.triangleMaterials ?? []) { allTris++; if (naturalRole(palette[i])) natAll++; }
  metrics.naturalRoleShare = allTris ? +(natAll / allTris).toFixed(4) : 0;
  if (!natural.length && natAll <= N.minNaturalShare * allTris) { metrics.verdict = `no natural spaces and natural-role solids are ${(100 * metrics.naturalRoleShare).toFixed(1)}% of the stamp (<= ${100 * N.minNaturalShare}%): nothing to roughen`; return gateReport(c, "noise", failures, metrics); }

  const tableFile = c.f(N.table);
  let table = null;
  const { normaliseNoiseTable } = await import(pathToFileURL(path.join(HERE, "../mesh-dc/noise.mjs")).href);
  if (!exists(tableFile)) failures.push({ check: "table", what: `natural spaces (${natural.length}) but no role noise table ${N.table} (docs/blender-dc-authoring.md "DC role noise")` });
  else { try { table = normaliseNoiseTable(readJson(tableFile)); } catch (e) { failures.push({ check: "table", what: `${N.table}: ${e.message}` }); } }
  let embedded = null;
  if (stamp && !stamp.noise) failures.push({ check: "embedded", what: `the stamp ${c.stampRel} carries no noise table (export_mesh_stamp(noise=...)); re-export` });
  else if (stamp) { try { embedded = normaliseNoiseTable(stamp.noise); } catch (e) { failures.push({ check: "embedded", what: `stamp noise: ${e.message}` }); } }
  if (table && embedded && JSON.stringify(table.roles) !== JSON.stringify(embedded.roles)) failures.push({ check: "embedded", what: `the stamp's noise roles differ from ${N.table}: re-export` });
  const use = embedded ?? table;

  // natural-role solids: noised share (by triangles), and flat downward faces (a slab ceiling) per group
  let natTris = 0, noisedTris = 0; const flat = {};
  for (const m of stamp?.meshes ?? []) {
    const counts = m.solidTriangleCounts ?? []; const mats = m.triangleMaterials ?? []; const P = m.positions ?? []; const I = m.indices ?? [];
    let t0 = 0; let down = 0, downFlat = 0;
    counts.forEach((cnt, si) => {
      const roles = new Set(); for (let t = t0; t < t0 + cnt; t++) roles.add(palette[mats[t]]);
      const nat = [...roles].every(naturalRole);
      if (nat) {
        natTris += cnt;
        const key = m.solidNoise?.[si];
        const noised = !!use && (key ? !!use.roles[key] : [...roles].every((r) => !!use.roles[r]));
        if (noised) noisedTris += cnt;
        for (let t = t0; t < t0 + cnt; t++) {
          const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, d = I[t * 3 + 2] * 3;
          const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[d] - P[a], vy = P[d + 1] - P[a + 1], vz = P[d + 2] - P[a + 2];
          const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const area = Math.hypot(nx, ny, nz) / 2;
          if (!area) continue; const y = ny / (2 * area);
          if (y < -0.3) { down += area; if (y < -N.flatNormalY) downFlat += area; }
        }
      }
      t0 += cnt;
    });
    if (down >= N.minDownAreaM2) flat[m.name] = +(downFlat / down).toFixed(3);
  }
  metrics.naturalTriangles = natTris; metrics.noisedShare = natTris ? +(noisedTris / natTris).toFixed(3) : null;
  metrics.flatDownShareByGroup = flat;
  if (natTris && noisedTris / natTris < N.minNoisedShare) failures.push({ check: "noisedShare", what: `${Math.round((100 * noisedTris) / natTris)}% of natural-role triangles carry noise (min ${Math.round(100 * N.minNoisedShare)}%)` });
  for (const [g, s] of Object.entries(flat)) if (s > N.flatDownShare) failures.push({ space: g, check: "flatCeiling", what: `group ${g}: ${Math.round(100 * s)}% of the natural rock's downward faces are flat slabs (max ${Math.round(100 * N.flatDownShare)}%): shape the ceiling (dome, loft, vault ring), not a prism roof` });
  // box lumps standing in for rough rock (source-audit `<space>.rock.n`)
  const sa = readJson(c.f("reports/source-audit.json"));
  const lumps = {};
  for (const o of sa?.objects ?? []) { const [sp, kind] = o.object.split("."); if (kind === "rock") lumps[sp] = (lumps[sp] ?? 0) + (o.sourceSolids ?? 1); }
  metrics.rockLumps = lumps;
  for (const [sp, n] of Object.entries(lumps)) if (n > N.maxRockLumps) failures.push({ space: sp, check: "rockLumps", what: `${sp}: ${n} box "rock" lumps; roughen with role noise or place rock props through a dressing plan` });
  // plan hint: natural caves with no ceiling shape at all
  metrics.flatRoofedCaves = natural.filter((s) => s.kind === "cave" && !T.spaces.ceilingShapeKeys.some((k) => k in s)).map((s) => s.id);
  return gateReport(c, "noise", failures, metrics);
}

// ---------------------------------------------------------------- gate: originality

function pyFunctions(text) {
  const lines = text.split(/\r?\n/); const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)def\s+([A-Za-z_][\w]*)\s*\(/.exec(lines[i]);
    if (!m) continue;
    const ind = m[1].length; const body = [lines[i].replace(m[2], "_")];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]; if (!l.trim()) continue;
      if (l.length - l.trimStart().length <= ind) break;
      body.push(l);
    }
    const norm = body.map((l) => l.replace(/#.*$/, "").trim()).filter(Boolean);
    out.push({ name: m[2], lines: norm.length, hash: createHash("sha1").update(norm.join("\n")).digest("hex").slice(0, 16) });
  }
  return out;
}
const lineSet = (text) => new Set(text.split(/\r?\n/).map((l) => l.replace(/#.*$|\/\/.*$/, "").trim()).filter((l) => l.length > 8));
function jaccard(a, b) { let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i || 1); }

async function gateOriginality(c) {
  const O = T.originality, failures = [], metrics = { compared: [], shared: [] };
  const mine = builderFiles(c.root).map((f) => ({ f, rel: path.relative(c.root, f).replace(/\\/g, "/"), text: fs.readFileSync(f, "utf8") }));
  metrics.builders = mine.map((m) => m.rel);
  const myFns = new Map();
  for (const m of mine) if (m.f.endsWith(".py")) for (const fn of pyFunctions(m.text)) if (fn.lines >= O.minFunctionLines && !O.sharedPrimitives.includes(fn.name)) myFns.set(fn.hash, { ...fn, file: m.rel });
  const refs = Object.keys(T.references).filter((k) => k !== "about");
  const iAmRef = refs.includes(c.id);
  metrics.maxJaccard = {};
  for (const other of otherDungeons(c)) {
    const oid = path.basename(other); metrics.compared.push(oid);
    // the references are the originals: a copy of their code fails the copier, not them
    if (iAmRef && !refs.includes(oid)) { metrics.compared[metrics.compared.length - 1] += " (copier: judged on its side)"; continue; }
    for (const of of builderFiles(other)) {
      const text = fs.readFileSync(of, "utf8"); const orel = `${oid}/${path.relative(other, of).replace(/\\/g, "/")}`;
      for (const m of mine) {
        const j = jaccard(lineSet(m.text), lineSet(text));
        if (j > (metrics.maxJaccard[m.rel]?.j ?? 0)) metrics.maxJaccard[m.rel] = { j: +j.toFixed(3), with: orel };
        if (j > O.fileJaccardMax) failures.push({ space: m.rel, check: "copiedFile", what: `${m.rel} is ${Math.round(100 * j)}% the same lines as ${orel} (max ${Math.round(100 * O.fileJaccardMax)}%): write this dungeon's own builder` });
      }
      if (of.endsWith(".py")) for (const fn of pyFunctions(text)) {
        const hit = myFns.get(fn.hash);
        if (hit && !O.sharedPrimitives.includes(fn.name)) { metrics.shared.push(`${hit.file}:${hit.name} = ${orel}:${fn.name}`); failures.push({ space: hit.file, check: "sharedBuilder", what: `${hit.file} ${hit.name}() is the same function as ${orel} ${fn.name}() (${hit.lines} lines): a set-piece builder must be this dungeon's own; a true primitive belongs in lib/` }); }
      }
    }
  }
  return gateReport(c, "originality", failures, metrics);
}

// ---------------------------------------------------------------- gate: atlas

async function gateAtlas(c) {
  const A = T.atlas, failures = [], metrics = {};
  const pals = palettes(c);
  metrics.pages = pals.map((p) => path.relative(c.root, p).replace(/\\/g, "/"));
  if (pals.length !== 1) failures.push({ check: "pages", what: `${pals.length} DC palettes (atlas pages) in assets/materials; a dungeon has exactly one` });
  const mat = readJson(c.f("reports/materials.json"));
  if (!mat) failures.push({ check: "materials", what: "no reports/materials.json" });
  const pal = pals[0] ? readJson(pals[0]) : null;
  const layers = pal?.splat?.layers ?? [];
  const folders = new Set(layers.filter((l) => l.map).map((l) => l.map.split("/")[0]));
  metrics.folders = [...folders];
  if (folders.size > 1) failures.push({ check: "pages", what: `palette maps come from ${folders.size} texture folders (${[...folders].join(", ")}); one page = one folder` });
  const texFile = (map) => [c.f(`assets/textures/${map}`), path.join(c.projects, "voxel-demo/assets/textures", map), path.join(c.projects, "foundation/assets/textures", map)].find(exists);
  const roles = mat?.roles ?? [];
  const rows = [];
  const seen = new Map();
  for (const r of roles) {
    const layer = layers[r.slot];
    if (r.painted === false) { rows.push({ role: r.role, painted: false }); continue; }
    if (!layer?.map) { failures.push({ space: r.role, check: "unmapped", what: `role ${r.role} (slot ${r.slot}) has no map on the atlas page` }); continue; }
    const file = texFile(layer.map);
    if (!file) { failures.push({ space: r.role, check: "unmapped", what: `role ${r.role}: ${layer.map} not found` }); continue; }
    const sha = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    if (seen.has(sha)) failures.push({ space: r.role, check: "sharedImage", what: `roles ${seen.get(sha)} and ${r.role} are one image` }); else seen.set(sha, r.role);
    const tint = hex(layer.color ?? r.tint);
    const tv = hsv(tint);
    if (tv.s > A.tintChroma) failures.push({ space: r.role, check: "tint", what: `role ${r.role} tint ${layer.color} shifts hue (chroma ${tv.s.toFixed(2)} > ${A.tintChroma}); give it its own tile` });
    if (tv.v < A.tintMinValue) failures.push({ space: r.role, check: "tint", what: `role ${r.role} tint ${layer.color} darkens to ${Math.round(100 * tv.v)}% (min ${Math.round(100 * A.tintMinValue)}%)` });
    const mc = (await meanColour(file)).map((v, i) => (v * tint[i]) / 255);
    const h = hsv(mc);
    const family = Object.entries(A.families).find(([, list]) => list.includes(r.role))?.[0] ?? null;
    rows.push({ role: r.role, family, map: layer.map, mean: "#" + mc.map((v) => Math.round(v).toString(16).padStart(2, "0")).join(""), hue: Math.round(h.h), sat: +h.s.toFixed(3), luma: Math.round(luma(mc)) });
  }
  metrics.tiles = rows;
  for (const fam of Object.keys(A.families)) {
    const members = rows.filter((r) => r.family === fam);
    if (members.length < 2) continue;
    const hued = members.filter((r) => r.sat >= A.minSatForHue);
    let meanHue = null;
    if (hued.length) { let x = 0, y = 0; for (const r of hued) { x += Math.cos((r.hue * Math.PI) / 180) * r.sat; y += Math.sin((r.hue * Math.PI) / 180) * r.sat; } meanHue = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360; }
    const meanSat = members.reduce((a, r) => a + r.sat, 0) / members.length;
    metrics[`${fam}Band`] = { hue: meanHue === null ? null : Math.round(meanHue), sat: +meanSat.toFixed(3), tiles: members.length };
    for (const r of members) {
      if (meanHue !== null && r.sat >= A.minSatForHue && hueDiff(r.hue, meanHue) > A.hueBandDeg) failures.push({ space: r.role, check: "hue", what: `${fam} tile ${r.role} hue ${r.hue} is ${Math.round(hueDiff(r.hue, meanHue))} deg off the ${fam} colouring (${Math.round(meanHue)}, band ${A.hueBandDeg}): one ${fam} colouring per dungeon` });
      if (Math.abs(r.sat - meanSat) > A.satBand) failures.push({ space: r.role, check: "saturation", what: `${fam} tile ${r.role} saturation ${r.sat} vs the ${fam} mean ${meanSat.toFixed(2)} (band ${A.satBand})` });
    }
  }
  return gateReport(c, "atlas", failures, metrics);
}

// ---------------------------------------------------------------- gate: recipe

async function gateRecipe(c) {
  const R = T.recipe, failures = [], metrics = {};
  const plan = c.plan;
  if (!plan) return gateReport(c, "recipe", [{ check: "plan", what: "no authoring/plan.json" }], metrics);
  const spaces = plan.spaces.map((sp) => ({ sp, cls: spaceClass(sp), fp: footprint(sp) }));
  const byId = new Map(spaces.map((s) => [s.sp.id, s]));
  const scenePath = sceneFile(c);
  const scene = readJson(scenePath);
  if (!scene) return gateReport(c, "recipe", [{ check: "scene", what: `no scene ${path.relative(c.root, scenePath)}` }], metrics);
  const E = scene.entities; const pos = worldPositions(E);
  const bone = new RegExp(R.bonePattern, "i"), mob = new RegExp(R.mobPattern), loose = R.allowedLoosePrefabs.map((r) => new RegExp(r));
  const fixtures = bucketFixtures(c); const emits = new Map();
  const isFixture = (pid) => { if (!emits.has(pid)) emits.set(pid, fixtures.has(pid) || prefabEmits(c, pid)); return emits.get(pid); };
  const per = new Map(spaces.map((s) => [s.sp.id, { props: [], bones: 0, fixtures: [], decals: 0, detail: 0, uniqueKinds: [], setPiece: [] }]));
  const unplaced = { props: 0, decals: 0 };

  // dressing (scene entities tagged dressing, grouped by their plan) and loose prefabs
  const planIds = new Set(); const ownPrefabs = new Set(listFiles(c.f("assets/prefabs"), (n) => n.endsWith(".json")).map((f) => path.relative(c.f("assets/prefabs"), f).replace(/\\/g, "/").replace(/\.json$/, "")));
  const looseList = [];
  for (const [id, e] of Object.entries(E)) {
    const pf = e.components?.prefab;
    if (!pf) continue;
    const pid = pf.prefabId;
    if (!e.tags?.includes("dressing")) {
      if (!e.tags?.includes("npc") && !loose.some((r) => r.test(pid))) looseList.push(`${id} (${pid})`);
      continue;
    }
    const planTag = e.tags.find((t) => t.startsWith("dress:"))?.slice(6) ?? "";
    planIds.add(planTag);
    const suffix = planTag.startsWith(c.id + "-") ? planTag.slice(c.id.length + 1) : planTag;
    const sid = byId.has(suffix) ? suffix : spaceAt(spaces, pos(id));
    const bucket = sid && per.get(sid);
    if (!bucket) { unplaced.props++; continue; }
    if (mob.test(pid)) continue;
    if (isFixture(pid)) bucket.fixtures.push(pos(id));
    else if (bone.test(pid)) bucket.bones++;
    else bucket.props.push(pid);
    if (ownPrefabs.has(pid)) bucket.setPiece.push(`own prop ${pid}`);
  }
  if (looseList.length) failures.push({ check: "loose", what: `${looseList.length} prefab(s) placed by transform outside a dressing plan: ${looseList.slice(0, 6).join(", ")}` });
  // every dressing plan in the scene has a passing check report on disk
  const plansDir = c.f("authoring/dressing/plans");
  for (const pid of planIds) {
    const rep = readJson(path.join(plansDir, `${pid}.report.json`));
    if (!rep) failures.push({ check: "planCheck", what: `dressing plan ${pid} has no dress check report in authoring/dressing/plans` });
    else if (rep.ok !== true) failures.push({ check: "planCheck", what: `dress check of ${pid} did not pass` });
  }
  // lights: every point/spot light has a fixture prop beside it; fill
  const allFixtures = [...per.values()].flatMap((b) => b.fixtures);
  const sourceless = [];
  let fill = 0;
  for (const [id, e] of Object.entries(E)) {
    const L = e.components?.light; if (!L) continue;
    if (L.kind === "ambient" || L.kind === "hemisphere") { fill = Math.max(fill, L.intensity ?? 0); continue; }
    if (L.kind !== "point" && L.kind !== "spot") continue;
    const p = pos(id);
    if (!allFixtures.some((f) => Math.hypot(f[0] - p[0], f[1] - p[1], f[2] - p[2]) <= R.sourceRadiusM)) sourceless.push(id);
  }
  metrics.fill = fill; metrics.sourcelessLights = sourceless.length;
  if (fill > R.dungeon.fillMax) failures.push({ check: "fill", what: `ambient fill ${fill} > ${R.dungeon.fillMax} (thresholds recipe.dungeon.fillNote; the fill comes from lighting.json)` });
  if (sourceless.length) failures.push({ check: "sourceless", what: `${sourceless.length} light(s) with no fixture prop within ${R.sourceRadiusM} m: ${sourceless.slice(0, 5).join(", ")}` });
  // decals
  const decalTex = new Map();
  for (const [id, e] of Object.entries(E)) {
    const d = e.components?.decal; if (!d) continue;
    decalTex.set(d.texture, (decalTex.get(d.texture) ?? 0) + 1);
    const sid = spaceAt(spaces, pos(id));
    if (sid) per.get(sid).decals++; else unplaced.decals++;
  }
  metrics.decalTextures = Object.fromEntries(decalTex);
  if (decalTex.size < R.dungeon.decalTexturesMin) failures.push({ check: "decalTextures", what: `${decalTex.size} decal texture(s) in the dungeon (min ${R.dungeon.decalTexturesMin})` });
  if (decalTex.size) {
    let mid = false;
    for (const t of decalTex.keys()) { const f = [c.f(`assets/textures/${t}`), path.join(c.projects, "voxel-demo/assets/textures", t), path.join(c.projects, "foundation/assets/textures", t)].find(exists); if (f && luma(await meanColour(f)) >= R.dungeon.decalMidLuma) mid = true; }
    if (!mid) failures.push({ check: "decalMid", what: `every decal tile is dark (none with mean luma >= ${R.dungeon.decalMidLuma}): add a light or mid-value one (frost, salt, soot halo, water stain)` });
  }
  // built detail from source-audit objects named <space>.<kind>.n
  const sa = readJson(c.f("reports/source-audit.json"));
  const structural = new Set(R.structuralKinds), common = new Set(R.commonDetailKinds), commonPat = R.commonDetailPatterns.map((r) => new RegExp(r));
  const kindSpaces = new Map(); const orphan = {}, adopted = {};
  // a set-piece object named after its plan feature, not its space (`tally-stone.3` <- chamber.tallyStones): the
  // one space whose plan carries that feature key owns it
  const camel = (s) => s.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
  const owner = (prefix) => {
    const words = prefix.split("-"); const keys = [camel(prefix), camel(prefix) + "s", words[words.length - 1], words[words.length - 1] + "s", prefix];
    const hits = plan.spaces.filter((sp) => keys.some((k) => k in sp));
    return hits.length === 1 ? hits[0].id : null;
  };
  for (const o of sa?.objects ?? []) {
    let [sid, kind = ""] = o.object.split(".");
    if (!per.has(sid)) {
      const own = owner(sid);
      if (!own) { orphan[sid] = (orphan[sid] ?? 0) + (o.sourceSolids ?? 1); continue; }
      adopted[sid] = own; kind = sid; sid = own;
    }
    if (structural.has(kind)) continue;
    per.get(sid).detail += o.sourceSolids ?? 1;
    if (!common.has(kind) && !commonPat.some((r) => r.test(kind))) { if (!kindSpaces.has(kind)) kindSpaces.set(kind, new Set()); kindSpaces.get(kind).add(sid); }
  }
  if (!sa) failures.push({ check: "sourceAudit", what: "no reports/source-audit.json (written by the export)" });
  metrics.unassignedSourceObjects = orphan; metrics.adoptedSourceObjects = adopted;
  // a catalogue piece no other room has (the dining table, the reeve's chair): furniture as the set piece
  const propRooms = new Map();
  for (const [sid, b] of per) for (const k of new Set(b.props)) { if (!propRooms.has(k)) propRooms.set(k, new Set()); propRooms.get(k).add(sid); }
  for (const [k, set] of propRooms) if (set.size === 1) per.get([...set][0]).setPiece.push(`only prop ${k}`);
  for (const [kind, set] of kindSpaces) if (set.size === 1) per.get([...set][0]).setPiece.push(`built ${kind}`);
  // plan feature keys only one space has (a builder made for that room)
  const generic = new Set(["id", "group", "kind", "name", "note", "x", "y", "floor", "wallH", "height", "clear", "doors", "recesses", "axis", "dir", "cross", "s", "cap", "capStart", "capEnd", "profile", "floorProfile", "poly", "path", "level", "wallRole", "roofRole", "floorRole", "ceilRole", "wallT", "rough", "roughDepth", "necks", "ceiling", "roofRise", "lights"]);
  const keySpaces = new Map();
  for (const { sp } of spaces) for (const k of Object.keys(sp)) if (!generic.has(k)) { if (!keySpaces.has(k)) keySpaces.set(k, []); keySpaces.get(k).push(sp.id); }
  for (const [k, ids] of keySpaces) if (ids.length === 1) per.get(ids[0]).setPiece.push(`plan ${k}`);
  const sheet = readJson(c.f("authoring/room-sheet.json"));
  for (const r of sheet?.rooms ?? []) if (per.has(r.id) && Array.isArray(r.setPieceObjects) && r.setPieceObjects.length) per.get(r.id).setPiece.push(`room-sheet ${r.setPieceObjects.join("+")}`);

  // light sources = fixture clusters
  const clusters = (pts) => { const left = [...pts]; let n = 0; while (left.length) { n++; const seed = [left.pop()]; for (let i = 0; i < seed.length; i++) for (let j = left.length - 1; j >= 0; j--) if (Math.hypot(left[j][0] - seed[i][0], left[j][1] - seed[i][1], left[j][2] - seed[i][2]) <= R.lightClusterM) seed.push(left.splice(j, 1)[0]); } return n; };

  // per-space verdicts
  const rows = [];
  const allKinds = new Set();
  for (const { sp, cls, fp } of spaces) {
    const b = per.get(sp.id);
    const kinds = new Set(b.props); for (const k of kinds) allKinds.add(k);
    const lights = clusters(b.fixtures);
    const row = { space: sp.id, class: cls, natural: isNatural(sp), detail: b.detail, props: b.props.length, propKinds: kinds.size, bones: b.bones, lights, fixtures: b.fixtures.length, decals: b.decals, setPiece: b.setPiece.slice(0, 4) };
    rows.push(row);
    const fail = (check, what) => failures.push({ space: sp.id, check, what: `${sp.id}: ${what}` });
    if (cls === "room") {
      const Q = R.room; const masonry = !row.natural && (sp.wallRole === undefined || R.masonryRoles.includes(sp.wallRole)); const dMin = masonry ? Q.detailMinMasonry : Q.detailMin;
      if (b.detail < dMin) fail("detail", `${b.detail} built detail pieces (min ${dMin}${masonry ? ", masonry" : ""})`);
      if (row.props < Q.propsMin) fail("props", `${row.props} props through dressing plans, bones/lights/mobs aside (min ${Q.propsMin})`);
      if (row.propKinds < Q.propKindsMin) fail("propKinds", `${row.propKinds} prop kinds (min ${Q.propKindsMin})`);
      if (b.bones > Q.bonesMax) fail("bones", `${b.bones} bone piles (max ${Q.bonesMax})`);
      if (b.bones && b.bones / (b.bones + row.props) > Q.boneShareMax) fail("boneShare", `bones are ${Math.round((100 * b.bones) / (b.bones + row.props))}% of its props (max ${Math.round(100 * Q.boneShareMax)}%)`);
      if (lights < Q.lightsMin) fail("lightsMin", `${lights} visible light source(s) (min ${Q.lightsMin})`);
      if (lights > Q.lightsMax) fail("lightsMax", `${lights} visible light sources from ${b.fixtures.length} fixtures (max ${Q.lightsMax})`);
      if (b.decals < Q.decalsMin) fail("decalsMin", `${b.decals} decals (min ${Q.decalsMin})`);
      if (b.decals > Q.decalsMax) fail("decalsMax", `${b.decals} decals (max ${Q.decalsMax})`);
      if (Q.setPiece && !b.setPiece.length) fail("setPiece", "no set piece made for it (a built kind or plan feature only this room has, an own-project prop, or room-sheet setPieceObjects)");
    } else if (cls === "passage") {
      const Q = R.passage; const unlit = /\bunlit\b/i.test(`${sp.name ?? ""} ${sp.note ?? ""}`);
      if (b.bones > Q.bonesMax) fail("bones", `${b.bones} bone piles (max ${Q.bonesMax})`);
      if (!unlit && (fp?.length ?? 0) > Q.lightEveryM && lights < 1) fail("passageLight", `${Math.round(fp.length)} m long and no light source (one per ${Q.lightEveryM} m segment, or say "unlit" in the plan)`);
      if (b.decals > Q.decalsMax) fail("decalsMax", `${b.decals} decals (max ${Q.decalsMax})`);
    }
  }
  if (allKinds.size < R.dungeon.propKindsMin) failures.push({ check: "dungeonPropKinds", what: `${allKinds.size} prop kinds across the dungeon (min ${R.dungeon.propKindsMin})` });
  metrics.dungeonPropKinds = allKinds.size; metrics.unplaced = unplaced; metrics.spaces = rows;
  return gateReport(c, "recipe", failures, metrics);
}

// ---------------------------------------------------------------- gate: compare

async function buildCompare(c) {
  const { decodePng, encodePng } = await png();
  const sheets = [ownSheet(c), ...referenceSheets(c).map((r) => r.file)].filter(exists);
  const colW = Math.floor(T.compare.width / sheets.length), gap = 8;
  const imgs = sheets.map((f) => { const im = decodePng(fs.readFileSync(f)); const k = colW / im.width; return { im, k, h: Math.round(im.height * k) }; });
  const W = colW * imgs.length + gap * (imgs.length - 1), H = Math.max(...imgs.map((i) => i.h));
  const out = new Uint8Array(W * H * 4);
  for (let i = 0; i < out.length; i += 4) { out[i] = out[i + 1] = out[i + 2] = 16; out[i + 3] = 255; }
  imgs.forEach(({ im, k, h }, n) => {
    const x0 = n * (colW + gap);
    for (let y = 0; y < h; y++) for (let x = 0; x < colW; x++) {
      const sx = Math.min(im.width - 1, Math.floor(x / k)), sy = Math.min(im.height - 1, Math.floor(y / k));
      const s = (sy * im.width + sx) * 4, d = (y * W + x0 + x) * 4;
      out[d] = im.data[s]; out[d + 1] = im.data[s + 1]; out[d + 2] = im.data[s + 2]; out[d + 3] = 255;
    }
  });
  fs.writeFileSync(c.f(T.compare.sheet), encodePng(W, H, out));
  return sheets;
}
async function gateCompare(c, { build }) {
  const failures = [], metrics = {};
  const own = ownSheet(c);
  if (!exists(own)) failures.push({ check: "views", what: `no shipped-light view sheet (${path.relative(c.root, own)}): run the views stage` });
  const refs = referenceSheets(c);
  for (const r of refs) if (!exists(r.file)) failures.push({ check: "reference", what: `reference sheet missing: ${r.id} (${r.file})` });
  if (build && !failures.length) metrics.columns = (await buildCompare(c)).map((f) => path.relative(c.projects, f).replace(/\\/g, "/"));
  const sheet = c.f(T.compare.sheet);
  if (!exists(sheet)) failures.push({ check: "sheet", what: `no ${T.compare.sheet} (run this gate with --build)` });
  else if (exists(own) && fs.statSync(sheet).mtimeMs < fs.statSync(own).mtimeMs) failures.push({ check: "sheet", what: `${T.compare.sheet} is older than the views; rebuild it (--build)` });
  metrics.order = "columns: this dungeon, then " + refs.map((r) => r.id).join(", ");
  metrics.judge = "judge at the shipped light: architecture readable in silhouette, pools of light, one colouring, rooms that read as places";
  return gateReport(c, "compare", failures, metrics);
}

// ---------------------------------------------------------------- gate: readability

/** The shipped-light view pictures (reports/views/*.png, the sheet left out). */
export function viewFiles(c) {
  const dir = path.dirname(ownSheet(c));
  const skip = new RegExp(T.readability.skipPattern);
  return exists(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".png") && !skip.test(n)).sort().map((n) => path.join(dir, n)) : [];
}
/** Luminance distribution of one picture: mean, near-black share and percentiles (sRGB 0-255, Rec.709 weights). */
export async function viewLuminance(file) {
  const { decodePng } = await png();
  const Rd = T.readability, img = decodePng(fs.readFileSync(file)), [wr, wg, wb] = Rd.lumaWeights;
  const hist = new Uint32Array(256); let n = 0, sum = 0;
  for (let i = 0; i < img.data.length; i += 4 * Rd.sampleStep) { const l = Math.round(wr * img.data[i] + wg * img.data[i + 1] + wb * img.data[i + 2]); hist[l]++; n++; sum += l; }
  const pct = (p) => { let k = 0; for (let i = 0; i < 256; i++) { k += hist[i]; if (k >= p * n) return i; } return 255; };
  let dark = 0; for (let i = 0; i < Rd.nearBlack; i++) dark += hist[i];
  return { mean: +(sum / n).toFixed(1), darkShare: +(dark / n).toFixed(3), p10: pct(0.1), p50: pct(0.5), p90: pct(0.9) };
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };

async function gateReadability(c) {
  const Rd = T.readability, failures = [], metrics = {};
  const files = viewFiles(c);
  if (!files.length) return gateReport(c, "readability", [{ check: "views", what: `no shipped-light views in ${path.relative(c.root, path.dirname(ownSheet(c)))}: run the views stage` }], metrics);
  const rows = [];
  for (const f of files) {
    const L = await viewLuminance(f); const view = path.basename(f, ".png");
    rows.push({ view, ...L });
    if (L.darkShare > Rd.view.darkShareMax) failures.push({ space: view, check: "blackView", what: `${view}: ${Math.round(100 * L.darkShare)}% of the picture is near black (luma < ${Rd.nearBlack}; max ${Math.round(100 * Rd.view.darkShareMax)}%): nothing reads` });
  }
  const med = { mean: median(rows.map((r) => r.mean)), darkShare: median(rows.map((r) => r.darkShare)), p10: median(rows.map((r) => r.p10)), p90: median(rows.map((r) => r.p90)) };
  metrics.median = med; metrics.views = rows;
  const D = Rd.dungeon;
  if (med.darkShare > D.darkShareMedianMax) failures.push({ check: "lightsOnBlack", what: `the median view is ${Math.round(100 * med.darkShare)}% near black (max ${Math.round(100 * D.darkShareMedianMax)}%): pools of light on black. Raise the readability fill and lift the fog colour (tools/dungeon-pipeline/lighting.json), not the fixtures` });
  if (med.mean < D.meanMin) failures.push({ check: "tooDark", what: `median view luminance ${med.mean} < ${D.meanMin}` });
  if (med.mean > D.meanMax) failures.push({ check: "tooBright", what: `median view luminance ${med.mean} > ${D.meanMax}: a dungeon reads dim` });
  if (med.p10 > D.p10Max) failures.push({ check: "flat", what: `the darkest tenth of the median view is luma ${med.p10} (max ${D.p10Max}): a flat bright fill, no pools of light; lower the fill and let the fixtures carry the light` });
  return gateReport(c, "readability", failures, metrics);
}

// ---------------------------------------------------------------- gate: matte

function glbMaterials(file) {
  try {
    const b = fs.readFileSync(file); if (b.readUInt32LE(0) !== 0x46546c67) return [];
    const j = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString("utf8"));
    return (j.materials ?? []).map((m, i) => ({ name: m.name ?? `#${i}`, roughness: m.pbrMetallicRoughness?.roughnessFactor ?? 1, metalness: m.pbrMetallicRoughness?.metallicFactor ?? 1, mrTexture: !!m.pbrMetallicRoughness?.metallicRoughnessTexture }));
  } catch { return []; }
}

async function gateMatte(c) {
  const M = T.matte, failures = [], metrics = { surfaces: [] };
  const isMetal = (name) => M.metalRoles.some((r) => new RegExp(`(^|[/_.:-])${r}([/_.:-]|$)`, "i").test(name));
  const judge = (kind, name, roughness, metalness, src) => {
    const metal = isMetal(name);
    metrics.surfaces.push({ kind, name, roughness, metalness, metal });
    const rMin = metal ? M.metalRoughnessMin : M.roughnessMin;
    if (roughness < rMin) failures.push({ space: name, check: "roughness", what: `${kind} ${name}: roughness ${roughness} < ${rMin}${metal ? " (metal)" : ""}, a sheen (${src}). Matte unless intended; an intended shine (ice, water) is a quality exception with a why` });
    if (!metal && metalness > M.metalnessMax) failures.push({ space: name, check: "metalness", what: `${kind} ${name}: metalness ${metalness} on a non-metal surface (${src})` });
  };
  // the atlas page: every painted role's layer, plus the palette's own base
  const mat = readJson(c.f("reports/materials.json"));
  for (const p of palettes(c)) {
    const pal = readJson(p); const rel = path.relative(c.root, p).replace(/\\/g, "/");
    judge("palette", rel, pal?.roughness ?? M.schemaDefault.roughness, pal?.metalness ?? M.schemaDefault.metalness, rel);
    const layers = pal?.splat?.layers ?? [];
    for (const r of mat?.roles ?? []) {
      if (r.painted === false) continue;
      const l = layers[r.slot]; if (!l) continue;
      judge("role", r.role, l.roughness ?? 1, l.metalness ?? r.metalness ?? 0, `${rel} layer ${r.slot}`);
    }
  }
  // every other material asset this project owns (schema defaults when a field is left out)
  for (const f of listFiles(c.f("assets/materials"), (n) => n.endsWith(".json") && n !== "dc-palette.json")) {
    const m = readJson(f); if (!m || typeof m !== "object" || M.skipShaders.includes(m.shader)) continue;
    const rel = path.relative(c.f("assets/materials"), f).replace(/\\/g, "/").replace(/\.json$/, "");
    judge("material", rel, m.roughness ?? M.schemaDefault.roughness, m.metalness ?? M.schemaDefault.metalness, `assets/materials/${rel}.json`);
  }
  // the project's own models (glTF: a factor left out is 1)
  for (const f of listFiles(c.f("assets/models"), (n) => n.endsWith(".glb"))) {
    const rel = path.relative(c.f("assets/models"), f).replace(/\\/g, "/");
    for (const m of glbMaterials(f)) if (!m.mrTexture) judge("model", `${rel}:${m.name}`, +m.roughness.toFixed(3), +m.metalness.toFixed(3), rel);
  }
  return gateReport(c, "matte", failures, metrics);
}

// ---------------------------------------------------------------- gate: culling (interior pop-in)

/** The route as plan-space points (x, y), every array of points in plan.route in order, densified to 1 m steps. */
function routePoints(plan) {
  const pts = [];
  for (const v of Object.values(plan?.route ?? {})) {
    if (Array.isArray(v) && Array.isArray(v[0])) for (const p of v) pts.push(p);
    else if (Array.isArray(v) && typeof v[0] === "number") pts.push(v);
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    if (i === 0) { out.push(pts[0]); continue; }
    const a = pts[i - 1], b = pts[i], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])));
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

/**
 * Pop-in along the route: for every interior culling unit that sits in a ROOM (a room's dressing group), where the
 * walker first enters that room, how far the unit's bounds are from there, and how many metres they walk inside the
 * room before it is revealed, with the scene's cullingProfile applied as packages/render/src/culling.ts applies it.
 * Bounds are the members' origins padded by culling.propPadM (horizontal; a slight over-estimate of the distance).
 */
export function measurePopin(c) {
  const C = T.culling;
  const scene = readJson(sceneFile(c)); const plan = c.plan;
  if (!scene || !plan) return null;
  const E = scene.entities, pos = worldPositions(E);
  const profile = Object.values(E).map((e) => e.components?.cullingProfile).find(Boolean) ?? null;
  const spaces = plan.spaces.map((sp) => ({ sp, cls: spaceClass(sp), fp: footprint(sp) }));
  const kids = new Map(); for (const [id, e] of Object.entries(E)) { const l = kids.get(e.parent) ?? []; l.push(id); kids.set(e.parent, l); }
  const route = routePoints(plan);
  const rows = [];
  for (const [id, e] of Object.entries(E)) {
    const cu = e.components?.culling; if (!cu?.interior) continue;
    const members = []; const walk = (k) => { for (const ch of kids.get(k) ?? []) { members.push(ch); walk(ch); } }; walk(id);
    const ps = members.filter((m) => E[m].components?.prefab || E[m].components?.mesh).map(pos);
    if (!ps.length) continue;
    const pad = C.propPadM;
    const box = { x0: Math.min(...ps.map((p) => p[0])) - pad, x1: Math.max(...ps.map((p) => p[0])) + pad, y0: Math.min(...ps.map((p) => -p[2])) - pad, y1: Math.max(...ps.map((p) => -p[2])) + pad, z: ps.reduce((a, p) => a + p[1], 0) / ps.length };
    const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
    const room = spaces.find((s) => contains(s.fp, cx, cy, box.z)) ?? spaces.find((s) => contains(s.fp, cx, cy, undefined));
    if (!room || room.cls !== "room") continue; // sections and passage groups: the walker is already inside them
    let reveal = cu.reveal ?? 12;
    if (profile?.interiorReveal !== undefined) reveal = Math.max(reveal, profile.interiorReveal);
    const dist = (p) => Math.hypot(Math.max(box.x0 - p[0], 0, p[0] - box.x1), Math.max(box.y0 - p[1], 0, p[1] - box.y1));
    const entry = route.findIndex((p) => contains(room.fp, p[0], p[1], undefined, 0));
    if (entry < 0) { rows.push({ unit: id, room: room.sp.id, reveal, routed: false }); continue; }
    const atEntry = dist(route[entry]);
    let walked = 0, shown = atEntry <= reveal;
    for (let i = entry + 1; i < route.length && !shown; i++) { walked += Math.hypot(route[i][0] - route[i - 1][0], route[i][1] - route[i - 1][1]); if (dist(route[i]) <= reveal) shown = true; }
    rows.push({ unit: id, room: room.sp.id, reveal, routed: true, atEntryM: +atEntry.toFixed(1), popinM: shown ? +walked.toFixed(1) : null });
  }
  return { profile, rows };
}

async function gateCulling(c) {
  const C = T.culling, failures = [], metrics = {};
  const m = measurePopin(c);
  if (!m) return gateReport(c, "culling", [{ check: "scene", what: "no scene or plan" }], metrics);
  const routed = m.rows.filter((r) => r.routed);
  metrics.profile = m.profile;
  metrics.worstPopinM = routed.reduce((a, r) => Math.max(a, r.popinM ?? Infinity), 0);
  metrics.worstAtEntryM = routed.reduce((a, r) => Math.max(a, r.atEntryM), 0);
  metrics.units = m.rows;
  if (!m.profile && C.requireProfile) failures.push({ check: "profile", what: `no cullingProfile in the scene: an instanced dungeon is all interior; put { interiorReveal >= ${Math.ceil(metrics.worstAtEntryM)}, maxMinScreenPx: 0, occlusion: false } on its root (lighting.mts applies lighting.json's)` });
  for (const r of routed) if (r.popinM === null || r.popinM > C.popinMaxM) failures.push({ space: r.room, check: "popin", what: `${r.room}: ${r.unit} appears ${r.popinM === null ? "nowhere on the route" : `${r.popinM} m`} after the walker enters the room (${r.atEntryM} m from the door, reveal ${r.reveal} m; max pop-in ${C.popinMaxM} m)` });
  return gateReport(c, "culling", failures, metrics);
}

// ---------------------------------------------------------------- CLI

// ---------------------------------------------------------------- gate: stairs

/** Triangles of the shipped (or derived) GLBs, engine frame, with a 1 m column grid for vertical rays. */
function glbTriangles(file) {
  const b = fs.readFileSync(file); if (b.readUInt32LE(0) !== 0x46546c67) return null;
  const jl = b.readUInt32LE(12), j = JSON.parse(b.subarray(20, 20 + jl).toString("utf8"));
  const binAt = 20 + jl + 8;
  const view = (acc) => { const a = j.accessors[acc], v = j.bufferViews[a.bufferView]; return { a, off: binAt + (v.byteOffset ?? 0) + (a.byteOffset ?? 0), stride: v.byteStride }; };
  const out = [];
  const mat = (n) => {
    if (n.matrix) return n.matrix;
    const [tx, ty, tz] = n.translation ?? [0, 0, 0], [x, y, z, w] = n.rotation ?? [0, 0, 0, 1], [sx, sy, sz] = n.scale ?? [1, 1, 1];
    return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0, 2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
      2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, tx, ty, tz, 1];
  };
  const mul = (A, B) => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += A[k * 4 + r] * B[c * 4 + k]; return o; };
  const visit = (ni, parent) => {
    const n = j.nodes[ni], M = mul(parent, mat(n));
    if (n.mesh !== undefined) for (const p of j.meshes[n.mesh].primitives) {
      if ((p.mode ?? 4) !== 4) continue;
      const P = view(p.attributes.POSITION); if (P.a.componentType !== 5126) continue;
      const ps = P.stride ?? 12, cnt = P.a.count, pos = new Float64Array(cnt * 3);
      for (let i = 0; i < cnt; i++) {
        const x = b.readFloatLE(P.off + i * ps), y = b.readFloatLE(P.off + i * ps + 4), z = b.readFloatLE(P.off + i * ps + 8);
        pos[i * 3] = M[0] * x + M[4] * y + M[8] * z + M[12]; pos[i * 3 + 1] = M[1] * x + M[5] * y + M[9] * z + M[13]; pos[i * 3 + 2] = M[2] * x + M[6] * y + M[10] * z + M[14];
      }
      let idx;
      if (p.indices !== undefined) {
        const I = view(p.indices), sz = I.a.componentType === 5125 ? 4 : I.a.componentType === 5123 ? 2 : 1;
        idx = new Uint32Array(I.a.count);
        for (let i = 0; i < I.a.count; i++) idx[i] = sz === 4 ? b.readUInt32LE(I.off + i * 4) : sz === 2 ? b.readUInt16LE(I.off + i * 2) : b[I.off + i];
      } else idx = Uint32Array.from({ length: cnt }, (_, i) => i);
      out.push({ pos, idx });
    }
    for (const ch of n.children ?? []) visit(ch, M);
  };
  const I4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const r of (j.scenes?.[j.scene ?? 0]?.nodes ?? j.nodes.map((_, i) => i))) visit(r, I4);
  return out;
}

export function columnCaster(files) {
  const grid = new Map(); // "ix,iz" -> [tri...]: tri = [ax, ay, az, bx, by, bz, cx, cy, cz, up]
  for (const f of files) {
    const prims = glbTriangles(f); if (!prims) continue;
    for (const { pos, idx } of prims) for (let t = 0; t + 2 < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const T = [pos[a], pos[a + 1], pos[a + 2], pos[b], pos[b + 1], pos[b + 2], pos[c], pos[c + 1], pos[c + 2]];
      // normal y (CCW front): (b - a) x (c - a), y component
      const ny = (T[5] - T[2]) * (T[6] - T[0]) - (T[3] - T[0]) * (T[8] - T[2]);
      if (Math.abs(ny) < 1e-9) continue; // vertical: a column ray never hits it
      T.push(ny > 0 ? 1 : -1);
      const x0 = Math.floor(Math.min(T[0], T[3], T[6])), x1 = Math.floor(Math.max(T[0], T[3], T[6]));
      const z0 = Math.floor(Math.min(T[2], T[5], T[8])), z1 = Math.floor(Math.max(T[2], T[5], T[8]));
      for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) { const k = ix + "," + iz; let l = grid.get(k); if (!l) grid.set(k, (l = [])); l.push(T); }
    }
  }
  /** Every surface crossing the vertical line at (x, z): [{ y, up }] sorted by y. */
  return (x, z) => {
    const l = grid.get(Math.floor(x) + "," + Math.floor(z)) ?? [], hits = [];
    for (const T of l) {
      const d = (T[3] - T[0]) * (T[8] - T[2]) - (T[6] - T[0]) * (T[5] - T[2]);
      const u = ((x - T[0]) * (T[8] - T[2]) - (T[6] - T[0]) * (z - T[2])) / d, v = ((T[3] - T[0]) * (z - T[2]) - (x - T[0]) * (T[5] - T[2])) / d;
      if (u < -1e-7 || v < -1e-7 || u + v > 1 + 1e-7) continue;
      hits.push({ y: T[1] + u * (T[4] - T[1]) + v * (T[7] - T[1]), up: T[9] > 0 });
    }
    return hits.sort((p, q) => p.y - q.y);
  };
}

/** Piecewise-linear z along a stair line: [[d, z]...] (d metres from the line start). */
const zAt = (prof, d) => { if (d <= prof[0][0]) return prof[0][1]; for (let i = 1; i < prof.length; i++) if (d <= prof[i][0]) { const [d0, z0] = prof[i - 1], [d1, z1] = prof[i]; return d1 === d0 ? z1 : z0 + ((z1 - z0) * (d - d0)) / (d1 - d0); } return prof[prof.length - 1][1]; };
function polyAt(path, d) { let acc = 0; for (let i = 1; i < path.length; i++) { const L = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]); if (d <= acc + L || i === path.length - 1) { const t = L ? Math.min(1, (d - acc) / L) : 0; return { p: [path[i - 1][0] + (path[i][0] - path[i - 1][0]) * t, path[i - 1][1] + (path[i][1] - path[i - 1][1]) * t], dir: [(path[i][0] - path[i - 1][0]) / (L || 1), (path[i][1] - path[i - 1][1]) / (L || 1)] }; } acc += L; } return { p: path[0], dir: [0, 1] }; }
const pathLen = (path) => { let L = 0; for (let i = 1; i < path.length; i++) L += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]); return L; };

/**
 * Every stair / ramp of a dungeon as a walk line in plan metres: { id, source, path [[x, y]...], prof [[d, z]...] (the pitch
 * line: nosings on a stair, the surface on a ramp), flight [d0, d1] (where it changes height), width, anchor }.
 */
export function stairLines(c) {
  const out = [];
  for (const sp of c.plan?.spaces ?? []) {
    if (sp.axis && Array.isArray(sp.s) && Array.isArray(sp.cross) && Array.isArray(sp.profile) && sp.profile.some((e) => e[0] === "steps")) {
      const dir = Math.sign(sp.s[1] - sp.s[0]) || 1, cx = (sp.cross[0] + sp.cross[1]) / 2;
      const P = (s) => (sp.axis === "x" ? [s, cx] : [cx, s]);
      const prof = [], flight = [Infinity, -Infinity];
      sp.profile.forEach((e, i) => {
        if (e[0] === "flat") { prof.push([(e[1] - sp.s[0]) * dir, e[3]], [(e[2] - sp.s[0]) * dir, e[3]]); return; }
        const prev = sp.profile.slice(0, i).reverse().find((q) => q[0] === "flat"), next = sp.profile.slice(i + 1).find((q) => q[0] === "flat");
        const d0 = (e[1] - sp.s[0]) * dir, d1 = d0 + e[2] * e[4];
        if (prev && next) { prof.push([d0, prev[3]], [d1, next[3]]); flight[0] = Math.min(flight[0], d0); flight[1] = Math.max(flight[1], d1); }
      });
      prof.sort((a, b) => a[0] - b[0]);
      out.push({ id: sp.id, source: "plan run", natural: isNatural(sp), path: [P(sp.s[0]), P(sp.s[1])], prof, flight, width: Math.abs(sp.cross[1] - sp.cross[0]), anchor: [0, 0, 0] });
    } else if (Array.isArray(sp.path) && Array.isArray(sp.floorProfile)) {
      const fp = sp.floorProfile.filter((e) => e[0] < 900 || true).map(([d, z]) => [Math.min(d, pathLen(sp.path)), z]);
      const z0 = fp[0][1]; const moving = fp.map((e, i) => ({ e, i })).filter(({ e }, k) => k > 0 && Math.abs(e[1] - fp[k - 1][1]) > 0.05);
      if (!moving.length) continue;
      const flight = [fp[moving[0].i - 1][0], moving[moving.length - 1].e[0]];
      const width = Math.min(...sp.path.map((p) => p[2] ?? 3));
      out.push({ id: sp.id, source: "plan burrow", natural: isNatural(sp), path: sp.path.map((p) => [p[0], p[1]]), prof: fp, flight, width, anchor: [0, 0, 0], z0 });
    }
    if (sp.stair && Array.isArray(sp.stair.x) && typeof sp.stair.s === "number") {
      const st = sp.stair, L = st.risers * st.tread, cx = (st.x[0] + st.x[1]) / 2, lo = sp.floor ?? 0, hi = sp.deck?.top ?? lo + st.risers * st.riser;
      // which way it climbs is not in the plan: both directions are listed, the gate keeps the one whose floors it finds
      for (const sg of [1, -1]) out.push({ id: `${sp.id}.stair`, source: "plan stair", path: [[cx, st.s - sg * 1.5], [cx, st.s + sg * (L + 1.5)]], prof: [[0, lo], [1.5, lo], [1.5 + L, hi], [3 + L, hi]], flight: [1.5, 1.5 + L], width: Math.abs(st.x[1] - st.x[0]), anchor: [0, 0, 0], ambiguous: true });
    }
  }
  // room kit stairs: markers.json "stair" (rooms.json anchor)
  const rooms = readJson(c.f("authoring/rooms.json"));
  for (const mf of [c.f("reports/kit/markers.json"), ...listFiles(c.f("authoring"), (n) => n.endsWith(".markers.json"))]) {
    for (const m of readJson(mf)?.markers ?? []) if (m.kind === "stair") out.push({ id: m.room, source: "room kit", path: m.path, prof: m.prof, flight: m.flight, width: m.width, anchor: rooms?.anchor ?? [0, 0, 0], style: m.ceiling, headroom: m.headroom, natural: m.ceiling === "natural" });
  }
  return out;
}

function modelFiles(c) {
  const all = listFiles(c.f("assets/models"), (n) => n.endsWith(".glb"));
  const split = all.filter((f) => /-(floor|shell)\.glb$/.test(f));
  const whole = all.filter((f) => !/-(floor|shell)\.glb$/.test(f) && !split.some((s) => s.replace(/-(floor|shell)\.glb$/, ".glb") === f));
  return [...split, ...whole];
}

/** Measure every stair line against the shipped geometry. */
export function measureStairs(c, lines = stairLines(c)) {
  const S = T.stairs;
  const cast = columnCaster(modelFiles(c));
  const rows = [];
  for (const L of lines) {
    const [ax, ay, az] = L.anchor;
    const W = (x, y) => [x - ax, -(y - ay)];
    const total = pathLen(L.path);
    const d0 = Math.max(0, L.flight[0] - S.landingM), d1 = Math.min(total, L.flight[1] + S.landingM);
    const half = Math.max(0, L.width / 2 - S.bodyEdgeM);
    const offsets = half > 0.05 ? [0, -half, half] : [0];
    const perLine = offsets.map((o) => ({ offset: +o.toFixed(2), samples: [] }));
    let misses = 0;
    for (let d = d0; d <= d1 + 1e-6; d += S.sampleM) {
      const { p, dir } = polyAt(L.path, d), zExp = zAt(L.prof, d) - az;
      offsets.forEach((o, k) => {
        const q = [p[0] - dir[1] * o, p[1] + dir[0] * o], [ex, ez] = W(q[0], q[1]);
        const hits = cast(ex, ez);
        const floor = hits.filter((h) => h.up && h.y <= zExp + 0.45 && h.y >= zExp - 1.2).pop();
        if (!floor) { misses++; return; }
        const ceil = hits.find((h) => !h.up && h.y > floor.y + 0.5);
        perLine[k].samples.push({ d: +d.toFixed(2), floor: +floor.y.toFixed(3), ceil: ceil ? +ceil.y.toFixed(3) : null });
      });
    }
    const n = perLine[0].samples.length + perLine.slice(1).reduce((a, l) => a + l.samples.length, 0);
    const expected = offsets.length * (Math.floor((d1 - d0) / S.sampleM) + 1);
    rows.push({ id: L.id, source: L.source, prof: L.prof, anchorZ: L.anchor[2], natural: !!L.natural, ambiguous: !!L.ambiguous, length: +(d1 - d0).toFixed(2), rise: +(Math.max(...L.prof.map((e) => e[1])) - Math.min(...L.prof.map((e) => e[1]))).toFixed(2), width: L.width, found: n / Math.max(1, expected), lines: perLine, misses });
  }
  // an ambiguous plan stair keeps the direction whose floors were found
  const keep = [];
  for (const r of rows) {
    if (!r.ambiguous) { keep.push(r); continue; }
    const twin = rows.filter((q) => q.id === r.id);
    if (twin.indexOf(r) === twin.reduce((bi, q, i, a) => (q.found > a[bi].found ? i : bi), 0)) keep.push(r);
  }
  for (const r of keep) {
    for (const l of r.lines) {
      const cl = l.samples.filter((s) => s.ceil !== null).map((s) => s.ceil - s.floor);
      const sorted = [...cl].sort((a, b) => a - b);
      l.min = cl.length ? +sorted[0].toFixed(2) : null; l.max = cl.length ? +sorted[sorted.length - 1].toFixed(2) : null;
      l.median = cl.length ? +sorted[sorted.length >> 1].toFixed(2) : null; l.spread = cl.length ? +(l.max - l.min).toFixed(2) : null;
      l.open = l.samples.filter((s) => s.ceil === null).length;
      // stepped roof: the ceiling jumping over jumpM more than the walk's own pitch explains (a riser-scale step in the roof)
      // ribs and arches hang narrow drops from a ceiling that still follows the stair: a max filter over ribM removes
      // drops narrower than that before the jump test (a stepped roof's steps survive it)
      const rk = Math.max(0, Math.round(S.ribM / 2 / S.sampleM));
      // (on the ceiling height above the pitch line, so a rising ceiling is not dragged forward by the filter)
      const e = l.samples.map((s) => (s.ceil === null ? null : s.ceil - (zAt(r.prof, s.d) - r.anchorZ)));
      const cf = e.map((v, i) => { if (v === null) return null; let m = v; for (let j = Math.max(0, i - rk); j <= Math.min(e.length - 1, i + rk); j++) if (e[j] !== null) m = Math.max(m, e[j]); return m; });
      let worst = 0, at = null; const k = Math.max(1, Math.round(S.jumpM / S.sampleM));
      for (let i = k; i < l.samples.length; i++) {
        const a = l.samples[i - k], b = l.samples[i]; if (cf[i - k] === null || cf[i] === null) continue;
        const j = Math.abs(cf[i] - cf[i - k]); if (j > worst) { worst = j; at = b.d; }
      }
      l.ceilingJump = +worst.toFixed(2); l.ceilingJumpAt = at;
      // the ceiling's slope against the walk's own slope: a flat ceiling over a rising walk reads as ~-1 x the walk
      l.pinchAt = l.samples.length ? l.samples.reduce((m, s) => (s.ceil !== null && s.ceil - s.floor < m.c ? { c: s.ceil - s.floor, d: s.d } : m), { c: Infinity, d: null }).d : null;
    }
  }
  return keep;
}

async function gateStairs(c) {
  const S = T.stairs;
  const rows = measureStairs(c);
  const failures = [];
  for (const r of rows) {
    if (r.found < 0.6) { failures.push({ space: r.id, check: "stairFound", what: `${r.id}: the walking surface was found under only ${(r.found * 100).toFixed(0)}% of the samples (plan and bake disagree, or the models are missing)` }); continue; }
    const centre = r.lines[0];
    const med = centre.median ?? 0;
    const band = Math.max(S.spreadM, S.spreadRel * med);
    for (const l of r.lines) {
      if (l.min === null) continue;
      const where = l.offset ? ` (${l.offset > 0 ? "right" : "left"} lane edge ${Math.abs(l.offset)} m)` : "";
      if (l.min < S.minClearM) failures.push({ space: r.id, check: "stairHeadroom", what: `${r.id}${where}: clear height ${l.min} m at d=${l.pinchAt} (< ${S.minClearM} m)` });
      if (r.natural && l.offset) continue; // rough rock: the lane edges are judged for headroom only, the crown for the band
      if (l.spread > band) failures.push({ space: r.id, check: "stairBand", what: `${r.id}${where}: clear height varies ${l.min}..${l.max} m along the flight (band ${band.toFixed(2)} m): the ceiling does not follow the stair` });
      if (l.ceilingJump > S.maxJumpM) failures.push({ space: r.id, check: "stairStepRoof", what: `${r.id}${where}: the ceiling steps ${l.ceilingJump} m within ${S.jumpM} m at d=${l.ceilingJumpAt} (beyond the walk's pitch): a stepped roof` });
    }
  }
  const metrics = { stairs: rows.map((r) => ({ id: r.id, source: r.source, natural: r.natural, length: r.length, rise: r.rise, width: r.width, found: +r.found.toFixed(2),
    lines: r.lines.map((l) => ({ offset: l.offset, min: l.min, max: l.max, median: l.median, spread: l.spread, ceilingJump: l.ceilingJump, open: l.open })),
    profile: r.lines[0].samples.filter((_, i) => i % 4 === 0).map((s) => [s.d, s.floor, s.ceil === null ? null : +(s.ceil - s.floor).toFixed(2)]) })) };
  if (!rows.length) metrics.note = "no stair or ramp spaces found";
  return gateReport(c, "stairs", failures, metrics);
}

/**
 * The plan route as a walk graph: every route array is a polyline, nodes closer than 0.5 m are one node (the route
 * doubles back over itself), a lone point joins its nearest node. `to(from, p)` is the shortest walk from the source to
 * any route node within offM of p plus p's offset from it; null when p lies more than offM off the route (not on it: measure
 * straight) or the route does not join them.
 */
export function routeGraph(plan, offM = 6) {
  const nodes = [];
  const adj = [];
  const key = new Map();
  const node = (p) => {
    const k = `${Math.round(p[0] * 2)},${Math.round(p[1] * 2)}`;
    if (key.has(k)) return key.get(k);
    nodes.push([p[0], p[1]]); adj.push([]); key.set(k, nodes.length - 1);
    return nodes.length - 1;
  };
  const edge = (a, b) => { if (a === b) return; const d = Math.hypot(nodes[a][0] - nodes[b][0], nodes[a][1] - nodes[b][1]); adj[a].push([b, d]); adj[b].push([a, d]); };
  const lone = [];
  for (const v of Object.values(plan?.route ?? {})) {
    if (Array.isArray(v) && Array.isArray(v[0])) { let prev = -1; for (const p of v) { const n = node(p); if (prev >= 0) edge(prev, n); prev = n; } }
    else if (Array.isArray(v) && typeof v[0] === "number") lone.push(v);
  }
  const nearestNode = (p) => { let best = -1, bd = Infinity; for (let i = 0; i < nodes.length; i++) { const d = Math.hypot(nodes[i][0] - p[0], nodes[i][1] - p[1]); if (d < bd) (bd = d), (best = i); } return { i: best, d: bd }; };
  for (const p of lone) { const n = nearestNode(p); const m = node(p); if (n.i >= 0 && n.i !== m) edge(m, n.i); }
  const distancesFrom = (p) => {
    const s = nearestNode(p);
    if (s.i < 0 || s.d > offM) return null;
    const dist = new Float64Array(nodes.length).fill(Infinity);
    dist[s.i] = s.d;
    const done = new Uint8Array(nodes.length);
    for (;;) {
      let u = -1;
      for (let i = 0; i < nodes.length; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
      if (u < 0) break;
      done[u] = 1;
      for (const [v, w] of adj[u]) if (dist[u] + w < dist[v]) dist[v] = dist[u] + w;
    }
    return dist;
  };
  // the shortest walk over every route node within offM of p (a stair landing overhead shares x/y with the floor below)
  const to = (dist, p) => { let best = Infinity; for (let i = 0; i < nodes.length; i++) { const o = Math.hypot(nodes[i][0] - p[0], nodes[i][1] - p[1]); if (o <= offM && dist[i] + o < best) best = dist[i] + o; } return best === Infinity ? null : best; };
  return { nodes: nodes.length, distancesFrom, to };
}

/**
 * The arrival safe zone, measured on the plan's own data: every hostile that stands (a pack's centre less its
 * spread, a named, a miniboss, the boss) or walks (each patrol point) within safeM of an arrival/exit anchor.
 * Plan points are [x, y, z] with z up; distance is straight-line 3D (never longer than the walk).
 */
export function measureArrival(plan, { safeM = T.arrival.safeM, anchorPattern = T.arrival.anchorPattern } = {}) {
  const re = new RegExp(anchorPattern);
  const anchors = Object.entries(plan?.anchors ?? {}).filter(([k, a]) => re.test(k) && Array.isArray(a?.at));
  const hostiles = [];
  const p3 = (p) => [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
  for (const pk of plan?.packs ?? []) {
    if (Array.isArray(pk.at)) hostiles.push({ id: pk.id, kind: "pack", at: p3(pk.at), pad: pk.spread ?? 0 });
    for (const [i, q] of (Array.isArray(pk.patrol) ? pk.patrol : []).entries()) if (Array.isArray(q)) hostiles.push({ id: pk.id, kind: `patrol point ${i}`, at: p3(q), pad: 0 });
  }
  for (const key of ["named", "minibosses"]) for (const n of plan?.[key] ?? []) if (Array.isArray(n?.at)) {
    hostiles.push({ id: n.id, kind: key === "named" ? (n.rank ?? "named") : "miniboss", at: p3(n.at), pad: 0 });
    for (const [i, q] of (Array.isArray(n.patrol) ? n.patrol : []).entries()) if (Array.isArray(q)) hostiles.push({ id: n.id, kind: `patrol point ${i}`, at: p3(q), pad: 0 });
  }
  if (plan?.boss && Array.isArray(plan.boss.at)) hostiles.push({ id: plan.boss.id ?? "boss", kind: "boss", at: p3(plan.boss.at), pad: 0 });
  const walk = routeGraph(plan);
  const hits = [];
  const nearest = {};
  for (const [name, a] of anchors) {
    const at = p3(a.at);
    const from = walk.distancesFrom(at);
    for (const h of hostiles) {
      const line = Math.hypot(h.at[0] - at[0], h.at[1] - at[1], h.at[2] - at[2]);
      // along the plan route when both ends lie on it (walls between rooms are not walked through), else straight
      const w = from ? walk.to(from, h.at) : null;
      const how = w === null ? "straight line" : "walked along the route";
      const d = Math.max(0, Math.max(line, w ?? 0) - h.pad);
      if (nearest[name] === undefined || d < nearest[name].d) nearest[name] = { id: h.id, kind: h.kind, d: +d.toFixed(1), how };
      if (d < safeM) hits.push({ anchor: name, id: h.id, kind: h.kind, d: +d.toFixed(1), line: +line.toFixed(1), how });
    }
  }
  // one row per (anchor, hostile): its closest point
  const worst = new Map();
  for (const h of hits) { const k = h.anchor + "|" + h.id; if (!worst.has(k) || worst.get(k).d > h.d) worst.set(k, h); }
  return { safeM, anchors: anchors.map(([k]) => k), hostiles: hostiles.length, hits: [...worst.values()].sort((a, b) => a.d - b.d), nearest };
}

async function gateArrival(c) {
  const m = measureArrival(c.plan);
  const failures = m.hits.map((h) => ({ space: h.anchor, check: "arrivalSafe", what: `${h.anchor}: ${h.kind} ${h.id} is ${h.d} m away (${h.how}${h.how === "straight line" ? "" : `, ${h.line} m straight`}; keep ${m.safeM} m): a player arriving or leaving is pulled into the fight lock` }));
  if (!m.anchors.length) failures.push({ space: "*", check: "arrivalAnchor", what: `no arrival/exit anchor in plan.anchors (names matching /${T.arrival.anchorPattern}/)` });
  return gateReport(c, "arrival", failures, { safeM: m.safeM, anchors: m.anchors, hostiles: m.hostiles, nearest: m.nearest });
}

export async function runGate(name, root, opts = {}) {
  const c = ctxOf(root);
  switch (name) {
    case "noise": return gateNoise(c);
    case "originality": return gateOriginality(c);
    case "atlas": return gateAtlas(c);
    case "recipe": return gateRecipe(c);
    case "compare": return gateCompare(c, opts);
    case "readability": return gateReadability(c);
    case "matte": return gateMatte(c);
    case "culling": return gateCulling(c);
    case "stairs": return gateStairs(c);
    case "arrival": return gateArrival(c);
    default: throw new Error(`unknown gate ${name} (${Object.keys(GATES).join(", ")})`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--project");
  const root = at >= 0 ? path.resolve(args[at + 1]) : process.cwd();
  const names = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--project");
  const list = !names.length || names[0] === "all" ? Object.keys(GATES) : names;
  let bad = 0;
  if (args.includes("--dry")) setDry(true);
  for (const g of list) {
    const r = await runGate(g, root, { build: args.includes("--build") });
    console.log(`${g.padEnd(12)} ${r.passed ? "PASSED" : "FAILED"}  ${r.failures.length} failure(s), ${r.excepted.length} excepted  -> ${DRY ? "(dry run, not written)" : `reports/quality/${g}.json`}`);
    if (args.includes("--metrics")) console.log("   metrics:", JSON.stringify(r.metrics.median ?? (r.metrics.worstPopinM !== undefined ? { worstPopinM: r.metrics.worstPopinM, worstAtEntryM: r.metrics.worstAtEntryM, profile: r.metrics.profile } : {})));
    for (const f of r.failures.slice(0, args.includes("--print") ? 999 : 8)) console.log(`   - ${f.what}`);
    if (!args.includes("--print") && r.failures.length > 8) console.log(`   ... ${r.failures.length - 8} more (--print)`);
    if (!r.passed) bad++;
  }
  process.exitCode = bad ? 1 : 0;
}
