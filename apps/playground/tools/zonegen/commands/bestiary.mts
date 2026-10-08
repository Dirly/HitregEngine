/**
 * zonegen bestiary <world> --project <p>               lint the creature catalogue (world-independent)
 * zonegen bestiary <world> --project <p> --zone <id>   lint the zone's pick from it [--overlap 0.34]
 *
 * The zone lint is where "neighbours differ on purpose" is enforced for monsters: the main line-up belongs to the
 * cast row's faction, minorities spill over from a real neighbour, and two adjacent zones may not field the same
 * non-wildlife creatures beyond the overlap cap (Jaccard on creature ids).
 */
import path from "node:path";
import { exists, finish, load, type Ctx, type Finding } from "../lib.mts";
import { bestiarySchema, castSchema, factionMembers, zoneBestiarySchema, zoneBriefSchema, type Bestiary, type Cast, type Creature, type ZoneBestiary } from "../schemas.mts";
import { err, levelFit, MELEE_ROLES, jaccard, neighboursOf, readAdjacency, warn } from "./_shared.mts";

/** An asset path in the catalogue is relative to the project's assets/ folder. */
export const assetExists = (ctx: Ctx, rel: string): boolean => !!rel && exists(path.join(ctx.paths.projectDir, "assets", rel));

function lintCatalogue(ctx: Ctx, cat: Bestiary, f: Finding[]): void {
  if (cat.creatures.length === 0 || cat.factions.length === 0) err(f, "empty", "the catalogue has no creatures or no factions: nothing for a zone to select");
  for (const c of cat.creatures) {
    if (c.body.status === "needs-body") warn(f, "needs-body", `${c.id}: no body yet — a HUMAN must model it; the longest lead in the pipeline`, c.id);
    if (c.body.status === "ready" && !assetExists(ctx, c.body.model)) err(f, "body-missing", `${c.id}: body says ready but the model "${c.body.model}" is not under assets/`, c.id);
    if (c.body.status === "needs-install" && !c.body.source) warn(f, "install-source", `${c.id}: body needs-install but names no source`, c.id);
    for (const t of c.themes) if (t.status === "needs-install" && !t.source) warn(f, "install-source", `${c.id}/${t.id}: needs-install but names no source`, c.id);
    for (const t of c.themes) if (t.status === "ready" && !assetExists(ctx, t.atlas)) err(f, "atlas-missing", `${c.id}/${t.id}: theme says ready but the atlas "${t.atlas}" is not under assets/`, c.id);
  }
  const byId = new Map(cat.creatures.map((c) => [c.id, c]));
  for (const fa of cat.factions) {
    const members = factionMembers(fa).map((m) => byId.get(m.creature)).filter((c): c is Creature => !!c);
    for (const m of factionMembers(fa)) {
      const c = byId.get(m.creature);
      if (c && m.theme && !c.themes.some((t) => t.id === m.theme)) err(f, "faction-theme", `${fa.id}: ${c.id} is dressed in "${m.theme}", which is not one of its themes`, fa.id);
    }
    if (fa.draft) warn(f, "draft-faction", `${fa.id} is a DRAFT faction (${factionMembers(fa).map((m) => m.creature).join(", ")}): awaiting the owner's approval`, fa.id);
    for (const c of members) if (c.kind === "wildlife") warn(f, "wildlife-in-faction", `${fa.id}: ${c.id} is wildlife; wildlife lives by habitat, not allegiance`, fa.id);
    const roles = new Set(members.flatMap((c) => c.roles));
    if (fa.scope === "story" && (![...roles].some((r) => MELEE_ROLES.has(r)) || !(roles.has("ranged") || roles.has("caster")))) err(f, "faction-roles", `${fa.id}: cannot field a fight — needs a melee AND a ranged or caster creature`, fa.id);
    if (fa.scope === "story" && !roles.has("elite") && !roles.has("boss")) warn(f, "faction-no-elite", `${fa.id}: no creature can be an elite or boss; zones will need new themes for their rares`, fa.id);
  }
}

function lintZone(ctx: Ctx, cat: Bestiary, zb: ZoneBestiary, cast: Cast, f: Finding[], inputs: string[]): void {
  const zone = ctx.zone;
  if (zb.zone !== zone) err(f, "wrong-zone", `the file says zone "${zb.zone}", not "${zone}"`);
  const row = cast.rows.find((r) => r.zone === zone);
  if (!row) return err(f, "no-cast-row", `zone ${zone} has no cast row; cast the world first`);
  const briefFile = ctx.paths.brief(zone);
  const brief = exists(briefFile) ? load(briefFile, zoneBriefSchema, f, "zone brief") : null;
  if (brief) inputs.push(briefFile);
  const band = brief?.level ?? row.level;
  const creature = new Map(cat.creatures.map((c) => [c.id, c]));
  const faction = new Map(cat.factions.map((x) => [x.id, x]));
  const main = faction.get(row.faction);
  if (!main) err(f, "unknown-faction", `cast faction "${row.faction}" is not in the catalogue`);

  const known = (id: string, where: string): Creature | null => {
    const c = creature.get(id);
    if (!c) err(f, "unknown-creature", `${where}: "${id}" is not in the catalogue — zones select, they never invent`, id);
    return c ?? null;
  };
  const theme = (c: Creature, t: string, where: string): void => {
    const th = c.themes.find((x) => x.id === t);
    if (!th) warn(f, "art-request", `${where}: theme "${t}" is new on ${c.id} — an atlas request in the manifest`, `${c.id}/${t}`);
    else if (th.status === "needs-art") warn(f, "art-request", `${where}: theme ${c.id}/${t} still needs art`, `${c.id}/${t}`);
  };
  const inBand = (c: Creature, where: string): void => {
    const k = levelFit(c.level, band);
    if (k === "none") err(f, "level-band", `${where}: ${c.id} is level ${c.level.join("-")}, outside the zone's ${band.join("-")}`, c.id);
    else if (k === "thin") warn(f, "level-fit", `${where}: ${c.id} (level ${c.level.join("-")}) overlaps under half of the zone's ${band.join("-")}`, c.id);
    if (c.body.status !== "ready") warn(f, "not-ready", `${where}: ${c.id} body is ${c.body.status}${c.body.status === "needs-body" ? " — a HUMAN must model it" : c.body.status === "needs-rig" ? " — it must be rigged before it can spawn" : " — exists, waits for install"}`, c.id);
  };

  for (const w of zb.wildlife) {
    const c = known(w.creature, "wildlife");
    if (!c) continue;
    if (c.kind !== "wildlife") err(f, "not-wildlife", `wildlife: ${c.id} is ${c.kind}, not wildlife`, c.id);
    const off = w.habitats.filter((h) => !c.habitats.includes(h));
    if (off.length) warn(f, "habitat", `wildlife: ${c.id} does not live in ${off.join(", ")}`, c.id);
    inBand(c, "wildlife");
  }
  for (const id of row.wildlife) if (!zb.wildlife.some((w) => w.creature === id)) warn(f, "cast-wildlife", `the cast row names wildlife ${id}, which the zone bestiary leaves out`, id);

  const roles = new Set<string>();
  for (const e of zb.faction) {
    const c = known(e.creature, "faction");
    if (!c) continue;
    const member = main ? factionMembers(main).find((m) => m.creature === c.id) : undefined;
    if (member?.theme && member.theme !== e.theme) warn(f, "faction-theme", `faction: ${main!.id} dresses ${c.id} in "${member.theme}", the zone picks "${e.theme}"`, c.id);
    if (main && !member) err(f, "wrong-faction", `faction: ${c.id} is not one of ${main.id}'s creatures (the cast row's main faction)`, c.id);
    if (!c.roles.includes(e.role)) warn(f, "role", `faction: ${c.id} is cast as ${e.role}, which it has no kit for (${c.roles.join(", ")})`, c.id);
    roles.add(e.role);
    theme(c, e.theme, "faction");
    inBand(c, "faction");
  }
  const missing = [
    ![...roles].some((r) => MELEE_ROLES.has(r)) && "melee (melee, brute or skirmisher)",
    !(roles.has("ranged") || roles.has("caster")) && "ranged or caster",
    !roles.has("elite") && zb.rares.length === 0 && "elite (or a rare)",
  ].filter(Boolean);
  if (missing.length) err(f, "role-coverage", `the main line-up has no ${missing.join(", no ")}`);

  const adjacency = readAdjacency(ctx.paths, f);
  const neighbours = adjacency ? neighboursOf(adjacency, zone) : [];
  for (const m of zb.minor) {
    const c = known(m.creature, "minor");
    if (!c) continue;
    if (!neighbours.includes(m.from)) {
      err(f, "minor-not-adjacent", `minor: ${c.id} comes "from" ${m.from}, which does not border ${zone}`, c.id);
      continue;
    }
    const theirs = cast.rows.find((r) => r.zone === m.from);
    const theirFaction = theirs ? faction.get(theirs.faction) : undefined;
    if (!theirFaction || !factionMembers(theirFaction).some((m) => m.creature === c.id)) err(f, "minor-faction", `minor: ${c.id} is not a creature of ${m.from}'s main faction (${theirs?.faction ?? "uncast"})`, c.id);
    else if (!row.minor.some((x) => x.from === m.from && x.faction === theirFaction.id)) warn(f, "minor-uncast", `minor: ${m.from}'s ${theirFaction.id} spill is not in the cast row's minor list`, c.id);
    theme(c, m.theme, "minor");
    inBand(c, "minor");
  }
  for (const r of zb.rares) {
    const c = known(r.base, `rare ${r.id}`);
    if (c) theme(c, r.theme, `rare ${r.id}`);
    if (r.level < band[0] || r.level > band[1]) err(f, "level-band", `rare ${r.id}: level ${r.level} outside ${band.join("-")}`, r.id);
    if (creature.has(r.id)) err(f, "id-clash", `rare ${r.id} reuses a catalogue creature id`, r.id);
  }
  for (const b of zb.bosses) {
    const c = known(b.base, `boss ${b.id}`);
    if (c) theme(c, b.theme, `boss ${b.id}`);
    if (creature.has(b.id)) err(f, "id-clash", `boss ${b.id} reuses a catalogue creature id`, b.id);
  }

  // occupant groups: one story faction, but an ecosystem of groups with their own small reasons to be here
  const allowed = new Set([row.faction, ...row.minor.map((m) => m.faction), ...row.others.map((o) => o.group)]);
  const seenGroups = new Set<string>();
  for (const gr of zb.groups) {
    const where = `group ${gr.id}`;
    if (seenGroups.has(gr.id) || zb.rares.some((r) => r.id === gr.id) || zb.bosses.some((b) => b.id === gr.id)) err(f, "id-clash", `${where}: id used twice in this bestiary`, gr.id);
    seenGroups.add(gr.id);
    const fa = gr.faction ? faction.get(gr.faction) : undefined;
    if (gr.faction && !allowed.has(gr.faction)) err(f, "group-faction", `${where}: faction ${gr.faction} is not this zone's main faction, a cast minor or one of its cast others (${[...allowed].join(", ")})`, gr.id);
    if (gr.faction && !fa) err(f, "unknown-faction", `${where}: faction "${gr.faction}" is not in the catalogue`, gr.id);
    for (const m of gr.members) {
      const c = known(m.creature, where);
      if (!c) continue;
      if (fa && !factionMembers(fa).some((x) => x.creature === c.id)) warn(f, "group-member", `${where}: ${c.id} is not a member of ${fa.id}`, gr.id);
      if (!gr.faction && c.kind !== "wildlife") warn(f, "group-member", `${where}: a wildlife group (no faction) fielding ${c.kind} creature ${c.id}`, gr.id);
      if (!c.roles.includes(m.role)) warn(f, "role", `${where}: ${c.id} is cast as ${m.role}, which it has no kit for (${c.roles.join(", ")})`, gr.id);
      if (m.theme) theme(c, m.theme, where);
      inBand(c, where);
    }
  }
  const minGroups = brief?.variety.minGroups ?? 4;
  if (zb.groups.length < minGroups) warn(f, "few-groups", `${zb.groups.length} occupant group(s); a zone wants at least ${minGroups} (bandits, a cult, a nest, a pack) besides its one big story`);
  const memberOf = (gr: ZoneBestiary["groups"][number]): Creature[] => gr.members.map((m) => creature.get(m.creature)).filter((c): c is Creature => !!c);
  const offersHuman = cat.creatures.some((c) => c.family === "human");
  const offersBeast = cat.creatures.some((c) => c.kind === "wildlife");
  if (offersHuman && !zb.groups.some((gr) => memberOf(gr).some((c) => c.family === "human"))) warn(f, "no-human-group", "no occupant group of human-kit creatures (bandits, cultists, a necromancer's circle), though the catalogue has them");
  if (offersBeast && !zb.groups.some((gr) => memberOf(gr).some((c) => c.kind === "wildlife"))) warn(f, "no-beast-group", "no occupant group of beasts (a wolf pack, a spider nest), though the catalogue has them");

  const cap = Number(ctx.opt("overlap", "0.34"));
  const lineup = (b: ZoneBestiary): Set<string> => new Set([...b.faction.map((x) => x.creature), ...b.minor.map((x) => x.creature)]);
  const mine = lineup(zb);
  for (const n of neighbours) {
    const file = ctx.paths.zoneBestiary(n);
    if (!exists(file)) continue;
    const theirs = load(file, zoneBestiarySchema, [], n);
    if (!theirs) continue;
    inputs.push(file);
    const other = lineup(theirs);
    const j = jaccard(mine, other);
    if (j > cap) err(f, "overlap", `non-wildlife line-up overlaps ${n}'s by ${j.toFixed(2)} (cap ${cap}): shared ${[...mine].filter((x) => other.has(x)).join(", ")}`, n);
  }
}

export async function run(ctx: Ctx): Promise<number> {
  const f: Finding[] = [];
  const inputs = [ctx.paths.bestiary];
  const cat = load(ctx.paths.bestiary, bestiarySchema, f, "creature catalogue");
  if (!ctx.zone) {
    if (cat) {
      lintCatalogue(ctx, cat, f);
      console.log(`catalogue: ${cat.creatures.length} creatures, ${cat.factions.length} factions`);
    }
    return finish(ctx, "bestiary", inputs, f);
  }
  inputs.push(ctx.paths.zoneBestiary(ctx.zone), ctx.paths.cast, ctx.paths.adjacency);
  const zb = load(ctx.paths.zoneBestiary(ctx.zone), zoneBestiarySchema, f, "zone bestiary");
  const cast = load(ctx.paths.cast, castSchema, f, "cast");
  if (cat && zb && cast) lintZone(ctx, cat, zb, cast, f, inputs);
  return finish(ctx, "bestiary", inputs, f);
}
