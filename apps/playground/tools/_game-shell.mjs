/**
 * The game shell of a world scene, as data: `assets/game-shell.json`, found through the project's dependsOn closure
 * (foundation owns it for the MMO). Plain JS so foundation's lab generators (foundation/tools/_roster.mjs, run with
 * node) build their VFX pools from the same table and the same builder as `tools/game-shell.mts` and `worldgen init`.
 *
 *   loadShell(project)            -> { shell, file, ownerDir } | null
 *   poolEntities(pools, parent?)  -> { id: entity } the pooled flipbooks / particles / meshes, parked under the fx dispatcher
 *   systemEntities(loaded)        -> { id: entity } the root system entities with `paramsFrom` resolved
 *   planShell(loaded, doc, opts)  -> { ops, added, skipped, findings } one ops batch that brings `doc` up to the shell
 *
 * Nothing here writes a file.
 */
import fs from "node:fs";
import path from "node:path";
import { findAsset, projectsRoot } from "./_closure.mjs";

export { findAsset, projectsRoot };

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
const clone = (v) => structuredClone(v);
const scriptOf = (e) => e?.components?.script?.name ?? "";
/** Every field of `want` is in `have` with the same value (schema defaults `have` gained on validation do not count). */
const covers = (have, want) => {
  if (want === null || typeof want !== "object") return have === want;
  if (Array.isArray(want)) return Array.isArray(have) && have.length === want.length && want.every((w, i) => covers(have[i], w));
  return have !== null && typeof have === "object" && Object.entries(want).every(([k, w]) => covers(have[k], w));
};

/** The shell the project's closure supplies (its own first), or null when no project in it owns one. */
export function loadShell(project) {
  const file = findAsset(project, "game-shell.json");
  if (!file) return null;
  return { shell: readJson(file), file, ownerDir: path.dirname(path.dirname(file)) };
}

/** Pooled VFX entities (ids `fx-<sheet>-<i>`, `pfx-<kind>-<i>`, `<mesh id>-<i>`), parked below the world. */
export function poolEntities(pools, parent = pools.parent ?? "fx") {
  const out = {};
  const park = { position: [0, pools.parkY ?? -50, 0] };
  const fps = pools.fps ?? 22;
  for (const m of pools.meshes ?? []) {
    for (let i = 0; i < m.count; i++) {
      out[`${m.id}-${i}`] = { name: `${m.name ?? m.id} ${i}`, parent, tags: [...(m.tags ?? ["fx"])], components: { transform: clone(park), mesh: clone(m.mesh) } };
    }
  }
  for (const p of pools.particles ?? []) {
    for (let i = 0; i < p.count; i++) {
      out[`pfx-${p.kind}-${i}`] = { name: `pfx ${p.kind} ${i}`, parent, tags: ["fx", `pfx:${p.kind}`], components: { transform: clone(park), particles: { emitting: false, ...clone(p.data) } } };
    }
  }
  for (const f of pools.flipbooks ?? []) {
    const lifetime = f.lifetime ?? Math.max(0.35, f.frames / fps + 0.15);
    for (let i = 0; i < f.count; i++) {
      out[`fx-${f.name}-${i}`] = {
        name: `fx ${f.name} ${i}`,
        parent,
        tags: ["fx"],
        components: {
          transform: clone(park),
          // UNIT size: fx-pool scales the entity, so `scale` is world metres
          billboard: { kind: "sprite", offset: [0, 0, 0], size: [1, 1], sheet: f.name, flipbook: { row: 0, fps, loop: !!f.loop, playing: false, blending: "additive", hideOnEnd: !f.loop }, visible: false },
          script: { name: "fx-emitter", params: { fx: f.name, lifetime } },
        },
      };
    }
  }
  return out;
}

/** "a.b.c" of a JSON file (relative to the shell owner's project folder), `file#a.b` picks a field. */
function resolveFrom(ownerDir, ref) {
  const [rel, pointer] = ref.split("#");
  const file = path.join(ownerDir, rel);
  if (!fs.existsSync(file)) throw new Error(`game-shell: paramsFrom ${ref}: no ${file}`);
  let v = readJson(file);
  for (const k of pointer ? pointer.split(".") : []) v = v?.[k];
  if (v === undefined) throw new Error(`game-shell: paramsFrom ${ref}: no such field`);
  return v;
}

/** The root system entities, ready to add (paramsFrom resolved, $-keys dropped). */
export function systemEntities(loaded) {
  const out = {};
  for (const [id, raw] of Object.entries(loaded.shell.systems ?? {})) {
    const e = { name: raw.name ?? id, parent: null, tags: [...(raw.tags ?? [])], components: clone(raw.components ?? {}) };
    if (raw.paramsFrom) {
      const script = e.components.script;
      if (!script) throw new Error(`game-shell: system ${id} has paramsFrom but no script`);
      script.params = { ...(script.params ?? {}) };
      for (const [k, ref] of Object.entries(raw.paramsFrom)) script.params[k] = clone(resolveFrom(loaded.ownerDir, ref));
    }
    out[id] = e;
  }
  return out;
}

/** Ids of `root` and its whole subtree in `entities`. */
function subtree(entities, root) {
  const ids = new Set([root]);
  let grew = true;
  while (grew) { grew = false; for (const [id, e] of Object.entries(entities)) if (!ids.has(id) && e?.parent && ids.has(e.parent)) { ids.add(id); grew = true; } }
  return ids;
}

/**
 * The ops batch that brings `doc` up to the shell, and what it found. Never doubles anything:
 *  - player: the `player`-tagged root. Already the shell's prefab -> kept. A dev capsule running a script in
 *    `player.replaces` (worldgen init's player-controller) -> replaced in place (same id, same position). Anything else
 *    -> a finding, kept unless opts.replacePlayer. No player -> added at the `spawn` entity.
 *  - camera: the active camera's `camera` component set to the shell's (transform kept) unless opts.keepCamera.
 *  - systems: skipped when the id exists or ANY entity already runs that script (a world may own its own soundscape).
 *  - pools: under the scene's fx dispatcher (whatever its id); each pooled id skipped when present.
 *  - doubles: an entity outside the player whose tag is one the player prefab owns as a singleton marker
 *    (weather-rain, ambient-fireflies, ...: the tag equals its id in the prefab) is reported: the weather and
 *    ambient-particles scripts would drive both.
 * opts.prefabDoc: the player prefab JSON (for the doubles check); omitted -> that check is skipped.
 */
export function planShell(loaded, doc, opts = {}) {
  const { shell } = loaded;
  const E = doc.entities;
  const ops = [], added = [], skipped = [], findings = [];
  const runs = (name) => Object.entries(E).find(([, e]) => scriptOf(e) === name)?.[0] ?? null;

  // ---- player
  const sp = shell.player;
  const players = Object.entries(E).filter(([, e]) => !e.parent && (e.tags ?? []).includes("player"));
  let playerIds = new Set();
  if (players.length > 1) findings.push(`${players.length} player-tagged roots (${players.map(([i]) => i).join(", ")}): the server takes the first`);
  const ws = opts.spawn ?? null; // the world's spawn from its data (tools/_world-spawn.mts): { position, rotation, from }
  const instance = (id, from) => {
    const t = from?.components?.transform ?? {};
    const spawn = Object.values(E).find((e) => (e.tags ?? []).includes("spawn"))?.components?.transform?.position;
    const transform = ws
      ? { position: [...ws.position], rotation: [...ws.rotation] }
      : { position: t.position ?? (spawn ? [spawn[0], spawn[1] + 1.1, spawn[2]] : [0, 2, 0]), ...(t.rotation ? { rotation: t.rotation } : {}) };
    return { name: sp.name ?? id, parent: null, tags: [...new Set([...(sp.tags ?? ["player"]), ...((from?.tags ?? []).filter((t) => t !== "player"))])], components: { transform, prefab: { prefabId: sp.prefab, props: {}, overrides: [] } } };
  };
  if (players.length === 0) {
    ops.push({ op: "add-entity", id: sp.id, entity: instance(sp.id, null) });
    added.push(`${sp.id} (prefab ${sp.prefab}, at the spawn)`);
  } else {
    const [pid, p] = players[0];
    playerIds = subtree(E, pid);
    const prefabId = p.components?.prefab?.prefabId;
    if (prefabId === sp.prefab) skipped.push(`${pid}: already prefab ${sp.prefab}`);
    else if ((!prefabId && (sp.replaces ?? []).includes(scriptOf(p))) || opts.replacePlayer) {
      ops.push({ op: "remove-entity", id: pid }, { op: "add-entity", id: pid, entity: instance(pid, p) });
      added.push(`${pid}: ${prefabId ? `prefab ${prefabId}` : `${scriptOf(p) || "bare"} capsule`} -> prefab ${sp.prefab} (same position)`);
    } else findings.push(`player ${pid} is ${prefabId ? `prefab ${prefabId}` : `a custom body running ${scriptOf(p) || "no script"}`}, not ${sp.prefab}: kept (--replace-player to replace it)`);
    // a kept player stands at the world's spawn too (the server spreads joiners up to 3.5 m round it: 4 m tolerance)
    const replaced = ops.some((o) => o.op === "add-entity" && o.id === pid);
    const at = p.components?.transform?.position;
    if (ws && !replaced && (!at || Math.hypot(at[0] - ws.position[0], at[2] - ws.position[2]) > 4)) {
      ops.push({ op: "set-component", id: pid, component: "transform", data: { ...(p.components?.transform ?? {}), position: [...ws.position], rotation: [...ws.rotation] } });
      added.push(`${pid}: moved to the world spawn (${ws.from})`);
    } else if (ws && replaced) added[added.length - 1] = added[added.length - 1].replace("(same position)", `at the world spawn (${ws.from})`);
  }
  // the `spawn` marker follows the world spawn (on the ground, 1.1 m under the body's root)
  if (ws) {
    const [sid, s] = Object.entries(E).find(([, e]) => !e.parent && (e.tags ?? []).includes("spawn")) ?? [];
    const ground = [ws.position[0], +(ws.position[1] - 1.1).toFixed(2), ws.position[2]];
    if (!sid) {
      ops.push({ op: "add-entity", id: "spawn", entity: { name: "Spawn", parent: null, tags: ["spawn"], components: { transform: { position: ground, rotation: [...ws.rotation] } } } });
      added.push("spawn marker at the world spawn");
    } else {
      const sp0 = s.components?.transform?.position;
      if (!sp0 || Math.hypot(sp0[0] - ground[0], sp0[2] - ground[2]) > 4) {
        ops.push({ op: "set-component", id: sid, component: "transform", data: { ...(s.components?.transform ?? {}), position: ground, rotation: [...ws.rotation] } });
        added.push(`${sid}: spawn marker moved to the world spawn`);
      }
    }
  }

  // ---- camera
  if (shell.camera) {
    const cams = Object.entries(E).filter(([, e]) => e.components?.camera);
    const [cid, cam] = cams.find(([, e]) => e.components.camera.active) ?? cams[0] ?? [];
    if (!cid) {
      ops.push({ op: "add-entity", id: shell.camera.id ?? "camera", entity: { name: "Camera", parent: null, tags: [], components: { transform: {}, camera: clone(shell.camera.camera) } } });
      added.push(`${shell.camera.id ?? "camera"} (third-person rig)`);
    } else if (covers(cam.components.camera, shell.camera.camera)) skipped.push(`${cid}: camera rig already the shell's`);
    else if (opts.keepCamera) findings.push(`${cid}: camera differs from the shell's rig, kept (--keep-camera)`);
    else {
      ops.push({ op: "set-component", id: cid, component: "camera", data: clone(shell.camera.camera) });
      added.push(`${cid}: camera -> the shell's third-person rig`);
    }
    // the first frame looks up the street with the player: the camera starts behind it (the rig takes over from there)
    const cpos = cam?.components?.transform?.position;
    if (cid && ws && (!cpos || Math.hypot(cpos[0] - ws.position[0], cpos[2] - ws.position[2]) > 30)) {
      const th = 2 * Math.atan2(ws.rotation[1], ws.rotation[3]); // yaw from the Y quaternion; forward = (sin, cos)
      const back = [+(ws.position[0] - Math.sin(th) * 7).toFixed(2), +(ws.position[1] + 2.5).toFixed(2), +(ws.position[2] - Math.cos(th) * 7).toFixed(2)];
      ops.push({ op: "set-component", id: cid, component: "transform", data: { ...(cam.components.transform ?? {}), position: back } });
      added.push(`${cid}: starts behind the player at the world spawn`);
    }
  }

  // ---- systems
  let fxId = null;
  const fxScript = "fx-pool";
  for (const [id, e] of Object.entries(systemEntities(loaded))) {
    const name = scriptOf(e);
    const owner = name ? runs(name) : null;
    if (owner) { skipped.push(`${id}: ${name} already runs on ${owner}`); if (name === fxScript) fxId = owner; continue; }
    if (E[id]) { findings.push(`${id}: the id is taken by "${E[id].name}" (${scriptOf(E[id]) || "no script"}), ${name} not added`); continue; }
    ops.push({ op: "add-entity", id, entity: e });
    added.push(`${id} (${name || "entity"})`);
    if (name === fxScript) fxId = id;
  }

  // ---- pools
  if (shell.pools) {
    if (!fxId) findings.push("no fx dispatcher in the scene or the shell: VFX pools not added");
    else {
      let n = 0, have = 0;
      for (const [id, e] of Object.entries(poolEntities(shell.pools, fxId))) {
        if (E[id]) { have++; continue; }
        ops.push({ op: "add-entity", id, entity: e });
        n++;
      }
      if (n) added.push(`${n} pooled VFX under ${fxId}`);
      if (have) skipped.push(`${have} pooled VFX already under ${fxId}`);
    }
  }

  // ---- doubles the player prefab would bring
  if (opts.prefabDoc?.entities) {
    const markers = new Set(Object.entries(opts.prefabDoc.entities).filter(([id, e]) => (e.tags ?? []).includes(id)).map(([id]) => id));
    for (const [id, e] of Object.entries(E)) {
      if (playerIds.has(id)) continue;
      const hit = (e.tags ?? []).filter((t) => markers.has(t));
      if (hit.length) findings.push(`${id} carries ${hit.join(", ")}, which the player prefab owns: the weather / ambient scripts would drive both`);
    }
  }
  return { ops, added, skipped, findings };
}

/** What a scene still lacks of the shell (for status rows): [] = complete. */
export function shellGaps(loaded, doc, opts = {}) {
  const plan = planShell(loaded, doc, opts);
  return [...plan.added.map((a) => `missing ${a}`), ...plan.findings];
}
