/**
 * zonegen manifest <world> --project <p> --zone <id> — write assets.json: everything the plan needs that the
 * library lacks. A generator, not a lint; it still writes a gate report so `status` can tell when it went stale.
 *
 * `have` is decided by looking at the disk, never by a catalogue flag alone. Conventions it looks for (paths under
 * projects/<p>/): mob model/atlas = the catalogue's own asset paths under assets/ (art in tools/atlas/out/<family>/<theme>/ or a
 * needs-install source = an `install` row, a command); mob template = a prefab file, or the id quoted in any scene/prefab, not just
 * assets/prefabs/<template>.json; dungeon textures = assets/textures/dungeons/<theme>/ holding the eleven role PNGs
 * (docs/dungeon-materials.md); dungeon key map and concept art = a *key*.png / *concept*.png in the dungeon's own
 * project (projects/<dungeon id>/authoring/); town palette = assets/materials/<palette>(.json or folder); building
 * set = an assets/wfc/<set>*.tileset.json; building model = a <model>.glb anywhere under assets/models; quest item
 * = assets/items/<id>.json, its icon = the item's `icon` under assets/textures/.
 */
import fs from "node:fs";
import path from "node:path";
import { exists, finish, load, readJson, writeJson, type Ctx, type Finding } from "../lib.mts";
import { assetManifestSchema, bestiarySchema, castSchema, questGraphSchema, zoneBestiarySchema, zoneBriefSchema, type AssetManifest } from "../schemas.mts";
import { buildingSetKnown, buildingSets, err, requireZone, townNames, warn } from "./_shared.mts";

type Row = AssetManifest["rows"][number];

/** Which of these template ids appear in the project's prefabs (file or id) or scenes (as a quoted id). Reads each file once. */
/**
 * What the game actually holds: entity ids, and the creatures (`creature:<id>` tags) that can spawn, across the world's
 * scene and the zone's dungeon scenes. A creature populate spawned (one template per creature/theme/tier, its body a
 * themed prefab) or a boss placed in its dungeon has its template, whatever the catalogue's `template` field says.
 */
function sceneIndex(files: string[]): { ids: Set<string>; creatures: Set<string> } {
  const ids = new Set<string>(), creatures = new Set<string>();
  for (const file of files) {
    if (!exists(file)) continue;
    const doc = readJson(file) as { entities?: Record<string, { tags?: string[] }> };
    for (const [id, e] of Object.entries(doc.entities ?? {})) {
      ids.add(id);
      for (const t of e.tags ?? []) if (t.startsWith("creature:")) creatures.add(t.slice(9));
    }
  }
  return { ids, creatures };
}

function templateIndex(assets: string, ids: string[]): Set<string> {
  const want = [...new Set(ids.filter(Boolean))];
  const found = new Set<string>();
  if (!want.length) return found;
  for (const id of want) if (exists(path.join(assets, "prefabs", `${id}.json`))) found.add(id);
  for (const dir of [path.join(assets, "scenes"), path.join(assets, "prefabs")]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json") || found.size === want.length) continue;
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      for (const id of want) if (!found.has(id) && text.includes(`"${id}"`)) found.add(id);
    }
  }
  return found;
}

function filesUnder(dir: string, test: (name: string) => boolean, limit = 1): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (out.length >= limit) return;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (test(e.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** The manifest rows for a zone, decided against the disk now. Shared with `status` (the art lane re-checks it). */
export function manifestRows(ctx: Ctx, zone: string, f: Finding[]): { rows: Row[]; inputs: string[] } {
  const p = ctx.paths;
  const inputs = [p.bestiary, p.cast, p.brief(zone), p.zoneBestiary(zone), p.quests(zone)];
  const cat = load(p.bestiary, bestiarySchema, f, "creature catalogue");
  const cast = load(p.cast, castSchema, f, "cast");
  const brief = load(p.brief(zone), zoneBriefSchema, f, "zone brief");
  const zb = load(p.zoneBestiary(zone), zoneBestiarySchema, f, "zone bestiary");
  const g = load(p.quests(zone), questGraphSchema, f, "quest graph");
  const rows: Row[] = [];
  if (!cat || !cast || !brief || !zb || !g) return { rows, inputs };
  const assets = path.join(p.projectDir, "assets");
  const asset = (rel: string): boolean => !!rel && exists(path.join(assets, rel));
  const add = (r: Omit<Row, "how" | "note"> & { how?: string; note?: string }): void => {
    if (!rows.some((x) => x.id === r.id && x.kind === r.kind)) rows.push({ how: "", note: "", ...r });
  };
  const creature = new Map(cat.creatures.map((c) => [c.id, c]));
  const row = cast.rows.find((r) => r.zone === zone);

  // creatures: body, template, every theme the zone uses (rares and bosses usually bring a NEW theme)
  const uses: { creature: string; theme: string; for: string }[] = [
    ...zb.wildlife.map((w) => ({ creature: w.creature, theme: creature.get(w.creature)?.themes[0]?.id ?? "", for: w.creature })),
    ...zb.faction.map((x) => ({ creature: x.creature, theme: x.theme, for: x.creature })),
    ...zb.minor.map((x) => ({ creature: x.creature, theme: x.theme, for: x.creature })),
    ...zb.groups.flatMap((gr) => gr.members.map((m) => ({ creature: m.creature, theme: m.theme || (creature.get(m.creature)?.themes[0]?.id ?? ""), for: `group ${gr.id}` }))),
    ...zb.rares.map((r) => ({ creature: r.base, theme: r.theme, for: `rare ${r.id}` })),
    ...zb.bosses.map((b) => ({ creature: b.base, theme: b.theme, for: `boss ${b.id}` })),
  ];
  // the art lane's raw material may already exist outside assets/ (the atlas tool's output): installing it is a command
  const engineRoot = path.resolve(p.projectDir, "..", "..", "..", "..");
  const atlasOut = (family: string, theme: string): string => path.join(engineRoot, "tools", "atlas", "out", family, theme);
  const templates = templateIndex(assets, [
    ...uses.map((u) => creature.get(u.creature)?.template ?? ""),
    ...zb.rares.map((r) => r.id),
    ...zb.bosses.map((b) => b.id),
  ]);
  const projects = path.dirname(p.projectDir);
  const live = sceneIndex([
    path.join(assets, "scenes", `${ctx.world}.scene.json`),
    ...g.dungeons.map((d) => path.join(projects, d.id, "assets", "scenes", `${d.id}.scene.json`)),
  ]);
  for (const u of uses) {
    const c = creature.get(u.creature);
    if (!c) continue;
    const bodyHave = c.body.status === "ready" && asset(c.body.model);
    const install = c.body.status === "needs-install";
    add({
      id: `${c.family}-body`, kind: "mob-body", for: c.id,
      status: bodyHave ? "have" : install ? "install" : c.body.status === "needs-body" ? "blocked" : "request",
      by: install ? "procedural" : "human",
      how: install ? `copy ${c.body.source || "(source not recorded)"} into assets/models and mark it ready in the catalogue` : c.body.status === "needs-body" ? "a human models the body (Blockbench), then the weapon-unwrap skill" : "rig it (docs/character-animation.md)",
      note: bodyHave ? c.body.model : c.body.status === "ready" ? `catalogue says ready but ${c.body.model || "(no path)"} is not on disk` : `${c.body.status}${c.notes ? `: ${c.notes.slice(0, 160)}` : ""}`,
    });
    const tplHave = (!!c.template && templates.has(c.template)) || live.creatures.has(c.id);
    add({
      id: `${c.id}-template`, kind: "mob-template", for: c.id,
      status: tplHave ? "have" : bodyHave ? "request" : "blocked",
      by: "opus", how: "mob template + mob-brain (docs/agent-workflow.md, mobs)",
      note: c.template ? (tplHave ? `template "${c.template}" found in a scene or prefab` : `template "${c.template}" named but found in no scene or prefab`) : "no template named",
    });
    if (!u.theme) continue;
    const th = c.themes.find((t) => t.id === u.theme);
    const atlasHave = !!th && th.status === "ready" && asset(th.atlas);
    const out = atlasOut(c.family, u.theme);
    const installable = !atlasHave && (th?.status === "needs-install" || fs.existsSync(out));
    add({
      id: `${c.family}/${u.theme}`, kind: "mob-atlas", for: u.for,
      status: atlasHave ? "have" : installable ? "install" : bodyHave ? "request" : "blocked",
      by: installable ? "procedural" : "gpt",
      how: installable ? `install the finished atlas (${th?.source || path.relative(engineRoot, out).replaceAll("\\", "/")}) under assets/ and mark the theme ready` : "weapon-unwrap skill (docs/mob-atlas.md)",
      note: atlasHave ? th!.atlas : installable ? "art exists, not installed" : th ? "theme in catalogue, no art yet" : "new theme: add it to the catalogue when drawn",
    });
  }
  // rares and bosses spawn from templates of their own
  for (const x of [...zb.rares.map((r) => ({ id: r.id, base: r.base })), ...zb.bosses.map((b) => ({ id: b.id, base: b.base }))]) {
    add({
      id: `${x.id}-template`, kind: "mob-template", for: x.id,
      status: templates.has(x.id) || live.creatures.has(x.id) ? "have" : "request",
      by: "opus", how: `mob template on the ${x.base} body with its own theme and abilities`,
      note: templates.has(x.id) || live.creatures.has(x.id) ? "found in a scene or prefab" : `no template "${x.id}" in any scene or prefab`,
    });
  }

  // dungeons
  for (const d of g.dungeons) {
    const theme = row?.dungeonTheme || d.id;
    const texDir = path.join(assets, "textures", "dungeons", theme);
    const pngs = fs.existsSync(texDir) ? fs.readdirSync(texDir).filter((x) => x.endsWith(".png")).length : 0;
    // or the dungeon project's own materials stage passed (11+ roles at the project density, reused or drawn)
    const matRep = path.join(path.dirname(p.projectDir), d.id, "reports", "materials.json");
    const mat = exists(matRep) ? (readJson(matRep) as { passed?: boolean; roles?: unknown[] }) : null;
    const ownRoles = mat?.passed ? (mat.roles?.length ?? 0) : 0;
    add({ id: theme, kind: "dungeon-textures", for: d.id, status: pngs >= 11 || ownRoles >= 11 ? "have" : "request", by: "gpt", how: "docs/dungeon-materials.md + tools/image-request.mjs gen", note: ownRoles >= 11 ? `${ownRoles} roles in projects/${d.id}/reports/materials.json` : `${pngs}/11 role textures in assets/textures/dungeons/${theme}/` });
    const dproj = path.join(path.dirname(p.projectDir), d.id, "authoring");
    // a dungeon modelled in Blender (docs/blender-dc-authoring.md: a mesh stamp) is built from its plan, not a key map
    const blender = filesUnder(dproj, (n) => n.endsWith(".mesh-stamp.json")).length > 0;
    add({ id: `${d.id}-key`, kind: "dungeon-key", for: d.id, status: blender || filesUnder(dproj, (n) => /key.*\.png$/i.test(n)).length ? "have" : "request", by: "opus", how: "hitreg-dungeon-authoring skill (key map)", note: `projects/${d.id}/authoring/*key*.png` });
    add({ id: `${d.id}-concept`, kind: "concept", for: d.id, status: filesUnder(dproj, (n) => /concept.*\.png$/i.test(n)).length ? "have" : "request", by: "gpt", how: "docs/image-generation.md (plan, section, concept references)", note: `projects/${d.id}/authoring/*concept*.png` });
  }

  // towns: palette, building set; a lot needs its own model only when the plan names one (a unique building) or no
  // WFC kit can build it
  let setHave = false;
  if (row) {
    const mat = path.join(assets, "materials", row.palette);
    add({ id: row.palette, kind: "town-palette", for: zone, status: exists(mat) || exists(`${mat}.json`) ? "have" : "request", by: "gpt", how: "docs/image-generation.md texture tiles + material asset", note: `assets/materials/${row.palette} (palette ids are not registered anywhere: unverified)` });
    setHave = buildingSetKnown(buildingSets(p), row.buildingSet);
    add({ id: row.buildingSet, kind: "building-model", for: zone, status: setHave ? "have" : "request", by: "opus", how: "WFC kit pipeline (tools/wfc-3d/kit.mjs)", note: `building set: assets/wfc/${row.buildingSet}*.tileset.json` });
  }
  const names = townNames(p, ctx.world);
  for (const t of brief.towns) {
    const name = names.get(t.id);
    if (!name || !exists(p.townPlan(name))) continue;
    inputs.push(p.townPlan(name));
    const plan = readJson(p.townPlan(name)) as { buildings?: { id: string; model?: string; unique?: boolean }[]; residents?: { id: string }[] };
    for (const b of plan.buildings ?? []) {
      if (setHave && !b.model && !b.unique) continue;
      const model = b.model ?? b.id;
      const have = filesUnder(path.join(assets, "models"), (n) => n === `${model}.glb`).length > 0;
      add({ id: model, kind: "building-model", for: `${t.id}/${b.id}`, status: have ? "have" : "request", by: "opus", how: "building-constructor skill (town-planner hands over the lot)", note: `${model}.glb under assets/models${b.unique ? " (unique building)" : ""}` });
    }
    // outfits: every planned resident dressed in the town doc
    const doc = exists(p.townDoc(name)) ? (readJson(p.townDoc(name)) as { residents?: { id: string; appearance?: unknown }[] }) : {};
    const dressed = new Set((doc.residents ?? []).filter((r) => r.appearance).map((r) => r.id));
    const bare = (plan.residents ?? []).filter((r) => !dressed.has(r.id));
    add({ id: `${name}-outfits`, kind: "outfit", for: t.id, status: bare.length ? "request" : "have", by: "sonnet", how: "town-npcs skill (climate + class outfits)", note: bare.length ? `${bare.length} of ${plan.residents?.length ?? 0} residents not dressed in the town doc` : "every resident dressed" });
  }

  // what each location must physically hold, and the quest entities: the POI owner builds them, the prop catalogue keeps them
  // a POI owner's job at stage "installed" has built and catalogued its location's needs (its handoff is the record);
  // a town's or a wild stretch's needs are exterior dressing and stay open until someone dresses them
  const built = (loc: string): boolean => {
    // a town's needs are its quest props (a deliver point, a chest): placed when every quest entity there is in the scene
    if (g.locations.find((l) => l.id === loc)?.kind === "town") {
      const here = g.entities.filter((e) => e.location === loc);
      return here.length > 0 && here.every((e) => live.ids.has(e.id));
    }
    const pr =path.join(p.zoneDir(zone), "pois", loc, "progress.json");
    return exists(pr) && (readJson(pr) as { stage?: string }).stage === "installed";
  };
  for (const l of g.locations)
    l.needs.forEach((need, i) => add({ id: `${l.id}#${i + 1}`, kind: "prop", for: l.id, status: built(l.id) ? "have" : "request", by: "opus", how: "the location's POI owner (poi-creator) builds it and catalogues it (docs/prop-cataloging.md)", note: need }));
  for (const e of g.entities) add({ id: e.id, kind: "entity", for: e.location, status: live.ids.has(e.id) ? "have" : "request", by: "opus", how: `POI owner places a ${e.kind} entity (npc builtin${e.kind === "readable" ? ", readable: true" : e.kind === "presence" ? " + presence" : ", face: false"})`, note: e.what });

  // audio: a zone bed, and one per dungeon (docs/audio.md: template + catalog entry, never a one-off prompt)
  const audioDir = path.join(assets, "audio");
  const audioHas = (key: string): boolean => filesUnder(audioDir, (n) => n.includes(key)).length > 0;
  add({ id: `${ctx.world}-${zone}-ambience`, kind: "audio", for: zone, status: audioHas(`${ctx.world}-${zone}`) ? "have" : "request", by: "elevenlabs", how: "docs/audio.md: catalog entry, then tools/sfx-request.mjs", note: `an ambience bed named for ${ctx.world}-${zone}` });
  for (const d of g.dungeons) add({ id: `${d.id}-ambience`, kind: "audio", for: d.id, status: audioHas(d.id) ? "have" : "request", by: "elevenlabs", how: "docs/audio.md: catalog entry, then tools/sfx-request.mjs", note: `dungeon bed named for ${d.id}` });

  // quest items and their icons
  for (const it of g.items) {
    const file = path.join(assets, "items", `${it.id}.json`);
    const item = exists(file) ? (readJson(file) as { icon?: string }) : null;
    add({ id: it.id, kind: "item", for: `quest item (${it.kind})`, status: item ? "have" : "request", by: "sonnet", how: "item asset (docs/character-progression.md)", note: `assets/items/${it.id}.json` });
    const iconHave = !!item?.icon && asset(path.join("textures", item.icon));
    add({ id: it.id, kind: "item-icon", for: it.id, status: iconHave ? "have" : item ? "request" : "blocked", by: "gpt", how: "item-icons skill", note: item?.icon ? `assets/textures/${item.icon}` : "no icon yet" });
  }
  return { rows, inputs };
}

export async function run(ctx: Ctx): Promise<number> {
  const bad = requireZone(ctx.zone, "manifest");
  if (bad !== null) return bad;
  const f: Finding[] = [];
  const { rows, inputs } = manifestRows(ctx, ctx.zone, f);
  if (f.some((x) => x.level === "error")) return finish(ctx, "manifest", inputs, f);
  if (rows.length === 0) err(f, "empty", "the plan needs nothing at all — suspicious; is the zone bestiary empty?");
  const manifest = assetManifestSchema.parse({ zone: ctx.zone, rows });
  writeJson(ctx.paths.assets(ctx.zone), manifest);
  for (const r of rows.filter((x) => x.status === "blocked" && x.by === "human")) warn(f, "human", `${r.kind} ${r.id} (for ${r.for}) waits on a human: ${r.how}`, r.id);
  const by = (s: string): number => rows.filter((r) => r.status === s).length;
  console.log(`manifest ${ctx.zone}: ${rows.length} rows — have ${by("have")}, install ${by("install")}, request ${by("request")}, blocked ${by("blocked")}`);
  for (const r of rows.filter((x) => x.status !== "have")) console.log(`  ${r.status.padEnd(8)} ${r.kind.padEnd(16)} ${r.id.padEnd(28)} ${r.by.padEnd(7)} ${r.how}`);
  return finish(ctx, "manifest", inputs, f);
}
