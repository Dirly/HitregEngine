#!/usr/bin/env node
/**
 * Dungeon room kit CLI: a room plan (outline, height, style, doorways) in -> crafted architecture out.
 *
 *   node tools/dungeon-room-kit/roomkit.mjs build <rooms.json> [--out dir] [--blend]   Blender headless: rooms -> tagged solids -> mesh stamp + source audit + markers
 *   node tools/dungeon-room-kit/roomkit.mjs bake  <stamp.json> [--out dir] [--voxel .12] [--group id]   offline DC extraction + mesh audit per room
 *   node tools/dungeon-room-kit/roomkit.mjs all   <rooms.json> [--out dir] [--voxel .12]   build then bake, timed (the plan-edit -> baked-room loop)
 *   node tools/dungeon-room-kit/roomkit.mjs counts <source-audit.json>                    built detail per room, counted the way the recipe gate counts it
 *   node tools/dungeon-room-kit/roomkit.mjs styles | parts                              what is available
 *
 * Blender: $BLENDER, else the standard install path. Default out dir: <rooms dir>/kit-out.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const KIT = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.resolve(KIT, "../..");
const BLENDER = process.env.BLENDER || "P:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe";
const [cmd, input, ...rest] = process.argv.slice(2);
const opt = (k, d) => (rest.includes(`--${k}`) ? rest[rest.indexOf(`--${k}`) + 1] : d);

function build(rooms, out) {
  const t0 = Date.now();
  const r = spawnSync(BLENDER, ["--background", "--factory-startup", "--python-exit-code", "1", "--python", path.join(KIT, "kit/blender_build.py"), "--", path.resolve(rooms), path.resolve(out), ...(rest.includes("--blend") ? ["--blend"] : [])], { encoding: "utf8", maxBuffer: 64 << 20 });
  const log = (r.stdout || "") + (r.stderr || "");
  for (const line of log.split(/\r?\n/)) if (/^(ROOM|KIT|Traceback|  File|\w*Error)/.test(line)) console.log(line);
  if (r.status !== 0) { console.error(log.slice(-3000)); process.exit(1); }
  return (Date.now() - t0) / 1000;
}

/** Role noise protection (docs/blender-dc-authoring.md "DC role noise" step 3): a box over every doorway the kit
 * built and capsules along the plan's route, embedded with the noise table in the stamp, so the bake and the
 * registered Blender to DC import apply the same noise. */
async function protect(planFile, stampFile, out) {
  const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  const stamp = JSON.parse(fs.readFileSync(stampFile, "utf8"));
  if (!stamp.noise) return null;
  const { routeProtect, openingProtect, normaliseNoiseTable } = await import(pathToFileURL(path.join(ENGINE, "tools/mesh-dc/noise.mjs")).href);
  const [ax, ay, az] = plan.anchor ?? [0, 0, 0];
  const toStamp = ([x, y, z = az]) => [x - ax, z - az, -(y - ay)];
  const markers = JSON.parse(fs.readFileSync(path.join(out, "markers.json"), "utf8")).markers;
  const doors = markers.filter((m) => m.kind === "doorway").map((m) => openingProtect(toStamp(m.center), m.width, m.height, plan.protectDoors ?? {}));
  const lane = plan.route ? routeProtect(stamp, plan.route.map((p) => { const q = toStamp(p); return [q[0], q[2]]; }), { startY: 0, ...(plan.protectRoute ?? {}) }) : [];
  const roles = stamp.noise.roles ?? stamp.noise;
  const resolved = { version: 1, roles, protect: [...lane, ...doors] };
  normaliseNoiseTable(resolved);
  stamp.noise = resolved;
  fs.writeFileSync(stampFile, JSON.stringify(stamp));
  console.log(`NOISE embedded: ${Object.values(roles).filter(Boolean).length} noised keys, ${doors.length} doorway boxes, ${lane.length} lane capsules`);
  return resolved;
}

function bake(stamp, out) {
  const t0 = Date.now();
  const args = ["--dir", path.join(ENGINE, "apps/playground"), "exec", "tsx", path.join(KIT, "bake.mts"), path.resolve(stamp), "--out", path.resolve(out), "--voxel", opt("voxel", ".12")];
  if (opt("group")) args.push("--group", opt("group"));
  const r = spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, { encoding: "utf8", shell: process.platform === "win32", maxBuffer: 64 << 20 });
  process.stdout.write(r.stdout || "");
  if (r.status !== 0) { console.error((r.stderr || "").slice(-3000)); process.exit(1); }
  return (Date.now() - t0) / 1000;
}

function counts(auditFile) {
  const th = JSON.parse(fs.readFileSync(path.join(ENGINE, "tools/dungeon-pipeline/thresholds.json"), "utf8")).recipe;
  const structural = new Set(th.structuralKinds);
  const audit = JSON.parse(fs.readFileSync(auditFile, "utf8"));
  const rooms = {};
  for (const o of audit.objects) {
    const [sid, kind = ""] = o.object.split(".");
    const r = (rooms[sid] ??= { detail: 0, structural: 0, kinds: {} });
    if (structural.has(kind)) r.structural += o.sourceSolids ?? 1;
    else { r.detail += o.sourceSolids ?? 1; r.kinds[kind] = (r.kinds[kind] ?? 0) + (o.sourceSolids ?? 1); }
  }
  for (const [id, r] of Object.entries(rooms))
    console.log(`${id.padEnd(18)} detail=${String(r.detail).padStart(4)} (recipe min ${th.room.detailMin}, masonry ${th.room.detailMinMasonry})  ${Object.entries(r.kinds).map(([k, n]) => `${k}:${n}`).join(" ")}`);
  return rooms;
}

if (cmd === "build" || cmd === "all") {
  const out = opt("out", path.join(path.dirname(path.resolve(input)), "kit-out"));
  const plan = JSON.parse(fs.readFileSync(input, "utf8"));
  const tb = build(input, out);
  const stamp = path.join(out, `${plan.id ?? "rooms"}.mesh-stamp.json`);
  await protect(input, stamp, out);
  let tk = 0;
  if (cmd === "all") tk = bake(stamp, out);
  counts(path.join(out, "source-audit.json"));
  const timing = { at: new Date().toISOString(), rooms: path.resolve(input), buildSeconds: tb, bakeSeconds: cmd === "all" ? tk : undefined, totalSeconds: +(tb + tk).toFixed(2) };
  fs.writeFileSync(path.join(out, "timing.json"), JSON.stringify(timing, null, 2) + "\n");
  console.log(`TIME plan -> stamp ${tb.toFixed(1)}s${cmd === "all" ? `, stamp -> baked + audited ${tk.toFixed(1)}s, total ${(tb + tk).toFixed(1)}s` : ""}`);
} else if (cmd === "bake") {
  bake(input, opt("out", path.dirname(path.resolve(input))));
} else if (cmd === "counts") {
  counts(input);
} else if (cmd === "styles") {
  for (const f of fs.readdirSync(path.join(KIT, "styles")).filter((f) => f.endsWith(".json"))) {
    const s = JSON.parse(fs.readFileSync(path.join(KIT, "styles", f), "utf8"));
    console.log(`${s.id.padEnd(16)} ${(s.construction ?? `extends ${s.extends}`).padEnd(20)} ${s.about}`);
  }
} else if (cmd === "parts") {
  console.log(fs.readFileSync(path.join(KIT, "README.md"), "utf8").split("## Parts")[1]?.split("\n## ")[0] ?? "see README.md");
} else {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
  process.exit(cmd ? 1 : 0);
}
