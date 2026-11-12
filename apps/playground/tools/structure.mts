/**
 * STRUCTURE: every structural piece touches what it must, measured against the REAL colliders (baked rock shell,
 * terrain bakes, every other placed object). Place = fit (docs/place-builder.md "Structural fit").
 *
 *   npx tsx tools/structure.mts scene <project> [--scene <id|file>] [--out f.json] [--list]
 *       the GATE: re-checks every placed structural piece against the current colliders (run it after any shell
 *       rebuild: rock that moved leaves a contact unmet). Exit 1 on any piece with an unmet contact.
 *   npx tsx tools/structure.mts fit <project> --spots <spots.json> [--scene <id|file>] [--apply <tag>] [--out f.json]
 *       PLACE = FIT: each spot { id, piece, at: [x, y, z], yaw (deg), search?, width?, height? } is fitted (piece
 *       "shoring": measured by ray-casting and rebuilt by the kit fitter; any catalogue piece with job.contacts: tried
 *       at the spot and a small search of offsets and headings). A spot whose contacts do not ALL land is rejected with
 *       the contact that missed. --apply <tag> writes the placements as one applyOps batch, replacing the entities that
 *       carry <tag> (idempotent); without it, nothing is written.
 *
 * What is structural: a catalogue row whose job.kind is one of carries-roof, braces-wall, spans, leans-on-wall,
 * cantilevers, hangs; its job.contacts (local points: floor, roof, rock-face, wall, ledge-top, support, support-edge,
 * roof-or-beam) are proved by tools/_contact.mts (the solver the spider-web planners share): each within 5 cm short of a
 * surface or 10 cm into it. A piece with no catalogue job but `dressing.structure` or the tag `structure:support|span`
 * (catalogue-exempt set pieces) is checked by its geometry: a support's top and feet bands, a span's two ends.
 */
import fs from "node:fs";
import path from "node:path";
import { applyOps, ComponentRegistry, registerChunkComponents, registerCoreComponents } from "@hitreg/core";
import { prefabFile, prefabGeometry, readJson, sceneGeometry } from "./_prop-geometry.mts";
import { PROJECTS } from "./_closure.mjs";
import { applyM4, surfaces, trisFromWorld, type SurfaceTri, type V3 } from "./_contact.mts";
import { fitSpots, jobsFor, kitFitter, STRUCTURAL_JOBS, worldContacts, type Spot } from "./_structure-fit.mts";
import { applyOpsToSceneFile } from "./_scene-write.mts";

const argv = process.argv.slice(2);
const opt = (n: string): string | undefined => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const fail = (m: string): never => { console.error(m); process.exit(2); };
const mode = argv[0];
if (!(mode === "scene" || mode === "fit") || !argv[1]) fail("usage: structure.mts scene <project> [--scene <id|file>] [--out f.json] [--list]\n       structure.mts fit <project> --spots <spots.json> [--apply <tag>] [--out f.json]");
const project = argv[1]!, assets = path.join(PROJECTS, project, "assets");
const s = opt("scene"), file = s && fs.existsSync(s) ? s : path.join(assets, "scenes", `${s ?? project}.scene.json`);
if (!fs.existsSync(file)) fail(`no scene ${file}`);
const doc = readJson(file);
const jobs = jobsFor(project);
const applyTag = opt("apply");

// ---- the colliders: every drawn triangle of the scene (the fit leaves out what it is about to replace) -----------------
const skipEnt = (id: string, e: any) => mode === "fit" && !!applyTag && (e?.tags ?? []).includes(applyTag);
const geo = sceneGeometry(assets, doc, skipEnt);
const tris: SurfaceTri[] = []; geo.forEach((g) => { for (const t of trisFromWorld(g.world, g.id)) tris.push(t); });
const S = surfaces(tris);

if (mode === "fit") {
  const spotsFile = opt("spots") ?? fail("fit needs --spots <file.json>");
  const spots: Spot[] = JSON.parse(fs.readFileSync(spotsFile, "utf8"));
  const res = fitSpots(S, spots, jobs, kitFitter(project));
  const report = { at: new Date().toISOString(), scene: path.relative(PROJECTS, file).replace(/\\/g, "/"), spots: spots.length, placed: res.placed, rejected: res.rejected };
  if (applyTag) {
    const reg = new ComponentRegistry(); registerCoreComponents(reg); registerChunkComponents(reg);
    const fresh = readJson(file), old = Object.entries(fresh.entities as Record<string, any>).filter(([, e]) => e.tags?.includes(applyTag)).map(([id]) => id);
    const ops: any[] = old.map((id) => ({ op: "remove-entity", id }));
    for (const p of res.placed) ops.push({ op: "add-entity", id: `fit-${p.id}`, entity: { name: `${p.prefabId}: ${p.spot.why ?? "fitted"}`.slice(0, 120), parent: null,
      tags: [applyTag, "static", ...(p.spot.room ? [`space:${p.spot.room}`] : [])], components: { transform: { position: p.position, rotation: p.rotation, scale: [1, 1, 1] }, prefab: { prefabId: p.prefabId, props: {}, overrides: [] } } } });
    applyOpsToSceneFile(file, ops, (d, o) => applyOps(d, o, reg), { label: `structure fit ${applyTag}` });
  }
  const out = opt("out"); if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 1) + "\n"); }
  console.log(`structure fit: ${res.placed.length} placed, ${res.rejected.length} rejected of ${spots.length} spots${applyTag ? ` (applied as ${applyTag})` : " (not written: --apply <tag>)"}`);
  for (const p of res.placed) console.log(`  ok   ${p.id} ${p.prefabId} at ${p.position.join(",")}${p.note ? ` (${p.note})` : ""}: ${p.proof.contacts.length} contacts, worst ${Math.max(...p.proof.contacts.map((c) => c.d)).toFixed(3)} m`);
  for (const r of res.rejected) console.log(`  REJECTED ${r.id}: ${r.why}`);
  process.exit(0);
}

// ---- the gate --------------------------------------------------------------------------------------------------------
const tagKind = (prefabId: string): string | null => {
  try { const p = readJson(prefabFile(assets, prefabId)); const root = p.entities?.[p.root ?? "root"];
    return root?.components?.dressing?.structure ?? (root?.tags ?? []).find((t: string) => /^structure:(support|span)$/.test(t))?.slice(10) ?? null; } catch { return null; }
};
const tagCache = new Map<string, string | null>();
type Row = { id: string; name?: string; prefab: string; structure: string; by: "contacts" | "bands"; contacts: Array<{ id: string; ok: boolean; d: number | null; at: V3; why?: string }>; ok: boolean };
const rows: Row[] = [];
const local = new Map<string, V3[]>();
const r2 = (v: number) => Math.round(v * 100) / 100;
for (const g of geo) {
  if (!g.prefabId) continue;
  const job = jobs.get(g.prefabId), self = (t: SurfaceTri) => t.owner === g.id;
  if (job && STRUCTURAL_JOBS.has(job.kind) && job.contacts?.length) {
    const proof = S.prove(worldContacts(job, g.m), {}, self);
    const contacts = [...proof.contacts.map((c) => ({ id: c.id, ok: true, d: Math.round(c.d * 1000) / 1000, at: c.at.map(r2) as V3 })), ...proof.missed.map((m) => ({ id: m.id, ok: false, d: m.d, at: m.at.map(r2) as V3, why: m.why }))];
    rows.push({ id: g.id, name: g.name, prefab: g.prefabId, structure: job.kind, by: "contacts", contacts, ok: proof.ok });
    continue;
  }
  if (!tagCache.has(g.prefabId)) tagCache.set(g.prefabId, tagKind(g.prefabId));
  const kind = tagCache.get(g.prefabId); if (!kind) continue;
  // no declared contacts: the geometry's bands (a support's top + feet; a span's two ends of its longest axis)
  let verts = local.get(g.prefabId);
  if (!verts) { verts = []; for (const t of prefabGeometry(assets, g.prefabId).tris) verts.push(t.a, t.b, t.c); local.set(g.prefabId, verts); }
  const min = [0, 1, 2].map((a) => Math.min(...verts!.map((v) => v[a]!))), max = [0, 1, 2].map((a) => Math.max(...verts!.map((v) => v[a]!)));
  const band = (axis: number, hi: boolean): V3[] => { const ext = max[axis]! - min[axis]!, lim = hi ? max[axis]! - ext * 0.04 : min[axis]! + ext * 0.04;
    const sel = verts!.filter((v) => (hi ? v[axis]! >= lim : v[axis]! <= lim)); return sel.filter((_, i) => i % Math.max(1, Math.floor(sel.length / 160)) === 0); };
  const probe = (name: string, pts: V3[]) => { let best = Infinity, at: V3 = [0, 0, 0];
    for (const v of pts) { const w = applyM4(g.m, v), n = S.nearest(w, 1, self); const d = n ? n.d : Infinity; if (d < best) { best = d; at = w; } }
    return { id: name, ok: best <= 0.05, d: best === Infinity ? null : Math.round(best * 1000) / 1000, at: at.map(r2) as V3, ...(best > 0.05 ? { why: best === Infinity ? "nothing within 1 m" : `${best.toFixed(3)} m clear` } : {}) }; };
  const axis = [0, 1, 2].reduce((b, a) => (max[a]! - min[a]! > max[b]! - min[b]! ? a : b), 0);
  const contacts = kind === "support" ? [probe("top", band(1, true)), probe("feet", band(1, false))] : [probe(`end ${"xyz"[axis]}-`, band(axis, false)), probe(`end ${"xyz"[axis]}+`, band(axis, true))];
  rows.push({ id: g.id, name: g.name, prefab: g.prefabId, structure: kind, by: "bands", contacts, ok: contacts.every((c) => c.ok) });
}
const faults = rows.filter((r) => !r.ok);
const report = { gate: "structure", passed: faults.length === 0, at: new Date().toISOString(), scene: path.relative(PROJECTS, file).replace(/\\/g, "/"),
  rule: "every structural piece's declared contacts (catalogue job.contacts) land on a collider: <= 5 cm short, <= 10 cm in; pieces with only dressing.structure / a structure tag: top + feet or both ends within 5 cm",
  checked: rows.length, faults: faults.length, rows };
const out = opt("out"); if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 1) + "\n"); }
console.log(`structure ${report.passed ? "PASSED" : "FAILED"}: ${rows.length} structural pieces, ${faults.length} with an unmet contact`);
for (const r of argv.includes("--list") ? rows : faults) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.id} ${r.prefab} (${r.structure}, ${r.by}): ${r.contacts.filter((c) => argv.includes("--list") || !c.ok).map((c) => `${c.id} ${c.ok ? `${c.d} m` : c.why} at ${c.at}`).join("; ")}`);
process.exit(report.passed ? 0 : 1);
