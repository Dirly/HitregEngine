/**
 * The dungeon pipeline's FIRST stage, `exterior` (Derek 2026-11-10, Rustgut: the interior was built before its world door
 * had a location or a concept). A dungeon is built only after the place that holds its WORLD DOOR has a complete exterior
 * chain (tools/poi-review/exterior-chain.mjs: location -> unedited grab -> concepts painted from it -> concept check), or
 * that place is grandfathered. Every later stage reads BLOCKED until it passes. It cannot be dropped by `override`.
 *
 * The door: `standardStages({ door: { world, poi, project? } })`, else `authoring/exterior.json` `door`, else FOUND: the
 * `portal` script whose `scene` is this dungeon in a zoned world's scene (projects with a stages file first), and the
 * `poi:<id>` tag on it or an ancestor. `authoring/exterior.json` `grandfather: { ruling }` (dated) passes a dungeon that
 * shipped before the chain and has no door place at all.
 */
import fs from "node:fs";
import path from "node:path";
import { exteriorVerdict, isDatedRuling, zonedWorlds } from "../poi-review/exterior-chain.mjs";

const tryJson = (f) => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, "")) : null; } catch { return null; } };

/** The world door of dungeon `id` (root = projects/<id>): { project, world, poi, how } or null. */
export function dungeonDoor(root, id, door) {
  const projects = path.dirname(root);
  const cfg = tryJson(path.join(root, "authoring", "exterior.json"));
  const declared = door ?? cfg?.door;
  const projectOfWorld = (world) => !fs.existsSync(projects) ? undefined : fs.readdirSync(projects).find((p) => fs.existsSync(path.join(projects, p, "authoring", "stages", `${world}.json`)))
    ?? fs.readdirSync(projects).find((p) => zonedWorlds(path.join(projects, p)).includes(world));
  if (declared?.world && declared?.poi) return { project: declared.project ?? projectOfWorld(declared.world) ?? null, world: declared.world, poi: declared.poi, how: "declared" };
  const isDir = (p) => { try { return fs.statSync(path.join(projects, p)).isDirectory(); } catch { return false; } };
  if (path.basename(projects) !== "projects") return null; // a dungeon lives in projects/<id>: nothing else is searched
  const names = fs.readdirSync(projects).filter((p) => p !== id && isDir(p));
  names.sort((a, b) => Number(fs.existsSync(path.join(projects, b, "authoring", "stages"))) - Number(fs.existsSync(path.join(projects, a, "authoring", "stages"))) || a.localeCompare(b));
  for (const p of names) {
    for (const w of zonedWorlds(path.join(projects, p))) {
      const scene = tryJson(path.join(projects, p, "assets", "scenes", `${w}.scene.json`));
      const ents = scene?.entities ?? {};
      for (const [eid, e] of Object.entries(ents)) {
        const sc = e?.components?.script;
        if (sc?.name !== "portal" || sc?.params?.scene !== id) continue;
        let cur = eid, poi = null;
        for (let i = 0; cur && i < 64 && !poi; i++) { poi = (ents[cur]?.tags ?? []).find((t) => typeof t === "string" && t.startsWith("poi:"))?.slice(4) ?? null; cur = ents[cur]?.parent; }
        if (poi) return { project: p, world: w, poi, how: `found: portal ${eid} in projects/${p}/assets/scenes/${w}.scene.json` };
      }
    }
  }
  return null;
}

/** The `exterior` row: { status: ok | MISSING | STALE, why, run }. */
export function dungeonExterior(root, id, door) {
  const cfg = tryJson(path.join(root, "authoring", "exterior.json"));
  const d = dungeonDoor(root, id, door);
  if (!d || !d.project) {
    if (isDatedRuling(cfg?.grandfather?.ruling ?? "")) return { status: "ok", why: `no world door place; grandfathered (${cfg.grandfather.ruling})`, run: "" };
    return { status: "MISSING", why: `no world door place for ${id}: site the door's place first (reservation + bare render + concepts + concept check), then declare it — standardStages({ id, door: { world, poi } }) in authoring/pipeline.mjs or authoring/exterior.json { "door": { "world": ..., "poi": ... } }`,
      run: "(pg) site the door place (site-finder / poi-creator skills), then npx tsx tools/zonegen.mts exterior <world> --project <p> --poi <door place>" };
  }
  const projectDir = path.join(path.dirname(root), d.project);
  const v = exteriorVerdict(projectDir, d.world, d.poi);
  const at = `door place ${d.poi} (${d.project}/${d.world}, ${d.how})`;
  if (v.ok) return { status: "ok", why: `${at}: ${v.via}`, run: `(pg) npx tsx tools/zonegen.mts exterior ${d.world} --project ${d.project} --poi ${d.poi}` };
  const n = v.chain.next;
  return { status: n.state === "STALE" ? "STALE" : "MISSING", why: `${at}: ${n.step} ${n.state}${n.why ? ` — ${n.why}` : ""}`, run: `(pg) ${n.how}` };
}

/** The stage record the standard list starts with. */
export function exteriorStage(id, door) {
  return { name: "exterior", exterior: { id, door }, out: "(the world door's exterior chain)", inputs: [], run: "",
    note: "FIRST: the world door's place has its exterior chain — location, unedited grab, concepts painted from it, concept check (zonegen exterior) — or a grandfather ruling. Until then every later stage is BLOCKED (Derek 2026-11-10, Rustgut)" };
}
