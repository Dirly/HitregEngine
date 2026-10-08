/**
 * zonegen cast <world> --project <p> — lint the world casting (one row per wilderness zone, decided all at once).
 *
 * Neighbours must differ on purpose: no shared main faction or palette across a border, minorities only from a real
 * neighbour, no faction ruling more than its share of the map, no cliff in level across a border a player can walk.
 */
import { finish, load, type Ctx, type Finding } from "../lib.mts";
import { bestiarySchema, castSchema, factionMembers, type Creature } from "../schemas.mts";
import { borderOf, buildingSetKnown, buildingSets, levelFit, err, jaccard, levelStep, readAdjacency, tokens, warn } from "./_shared.mts";

export async function run(ctx: Ctx): Promise<number> {
  const f: Finding[] = [];
  const p = ctx.paths;
  const cast = load(p.cast, castSchema, f, "cast");
  const cat = load(p.bestiary, bestiarySchema, f, "creature catalogue");
  const adj = readAdjacency(p, f);
  if (cast && cat && adj) {
    if (cast.world !== ctx.world) err(f, "wrong-world", `cast.world is "${cast.world}", not "${ctx.world}"`);
    const zones = new Set(adj.zones.map((z) => z.id));
    const row = new Map(cast.rows.map((r) => [r.zone, r]));
    for (const z of adj.zones) if (!row.has(z.id)) err(f, "uncast", `zone ${z.id} (${z.name}) has no cast row`, z.id);
    const factions = new Map(cat.factions.map((x) => [x.id, x]));
    const creatures = new Map(cat.creatures.map((c) => [c.id, c]));
    const sets = buildingSets(p);

    for (const r of cast.rows) {
      if (!zones.has(r.zone)) err(f, "unknown-zone", `row ${r.zone} is not a wilderness zone of ${ctx.world} (town zones are not cast)`, r.zone);
      if (!factions.has(r.faction)) err(f, "unknown-faction", `${r.zone}: faction "${r.faction}" is not in the catalogue`, r.zone);
      else if (factions.get(r.faction)!.scope === "local") err(f, "local-as-main", `${r.zone}: ${r.faction} is a LOCAL group; a zone's main threat must be a story faction`, r.zone);
      for (const m of r.minor) if (factions.get(m.faction)?.scope === "local") err(f, "local-as-minor", `${r.zone}: minor ${m.faction} is a LOCAL group; list it under others`, r.zone);
      for (const o of r.others) {
        const g = factions.get(o.group);
        if (!g) err(f, "unknown-faction", `${r.zone}: other group "${o.group}" is not in the catalogue`, r.zone);
        else if (g.scope !== "local") err(f, "story-as-other", `${r.zone}: ${o.group} is a STORY faction; others are local groups only (a neighbour's story faction goes in minor)`, r.zone);
        else for (const c of factionMembers(g).map((m) => creatures.get(m.creature)).filter((c): c is Creature => !!c)) if (levelFit(c.level, r.level) === "none") err(f, "level-fit", `${r.zone}: ${o.group} member ${c.id} (level ${c.level.join("-")}) cannot appear at ${r.level.join("-")}`, r.zone);
      }
      if (new Set(r.others.map((o) => o.group)).size < 2) warn(f, "few-others", `${r.zone}: ${r.others.length} other occupant group(s); a zone is an ecosystem, give it at least 2 besides ${r.faction}`, r.zone);
      const fit = (c: Creature, what: string): void => {
        const k = levelFit(c.level, r.level);
        if (k === "none") err(f, "level-fit", `${r.zone}: ${what} ${c.id} is level ${c.level.join("-")}, no overlap with the zone's ${r.level.join("-")}`, r.zone);
        else if (k === "thin") warn(f, "level-fit", `${r.zone}: ${what} ${c.id} (level ${c.level.join("-")}) overlaps under half of the zone's ${r.level.join("-")}`, r.zone);
        if (c.body.status !== "ready") warn(f, "not-ready", `${r.zone}: ${what} ${c.id} has body status ${c.body.status}${c.body.status === "needs-body" ? " (a HUMAN must model it)" : c.body.status === "needs-rig" ? " (needs rigging before it can fight)" : " (exists, not installed)"}`, c.id);
      };
      for (const w of r.wildlife) {
        const c = creatures.get(w);
        if (!c) err(f, "unknown-creature", `${r.zone}: wildlife "${w}" is not in the catalogue`, r.zone);
        else if (c.kind !== "wildlife") err(f, "not-wildlife", `${r.zone}: ${w} is ${c.kind}, not wildlife`, r.zone);
        else fit(c, "wildlife");
      }
      const main = factions.get(r.faction);
      if (main) {
        const members = factionMembers(main).map((m) => creatures.get(m.creature)).filter((c): c is Creature => !!c);
        for (const c of members) fit(c, `${main.id} member`);
        if (main.draft) warn(f, "draft-faction", `${r.zone}: main faction ${main.id} is a DRAFT awaiting the owner's approval`, main.id);
      }
      if (sets.length && !buildingSetKnown(sets, r.buildingSet)) err(f, "building-set", `${r.zone}: building set "${r.buildingSet}" is not a WFC kit in assets/wfc (${[...new Set(sets.map((x) => x.split("-")[0]))].join(", ")})`, r.zone);
      if (r.minor.length > 2) warn(f, "many-minors", `${r.zone}: ${r.minor.length} minor factions; one or two keep the zone's identity`, r.zone);
      for (const m of r.minor) {
        if (!borderOf(adj, r.zone, m.from)) err(f, "minor-not-adjacent", `${r.zone}: minor ${m.faction} comes from ${m.from}, which does not border it`, r.zone);
        else if (row.get(m.from)?.faction !== m.faction) err(f, "minor-faction", `${r.zone}: minor ${m.faction} from ${m.from}, but ${m.from}'s main faction is ${row.get(m.from)?.faction ?? "uncast"}`, r.zone);
        if (m.faction === r.faction) err(f, "minor-is-main", `${r.zone}: minor ${m.faction} is its own main faction`, r.zone);
      }
    }

    for (const b of adj.borders) {
      const A = row.get(b.a);
      const B = row.get(b.b);
      if (!A || !B) continue;
      if (A.faction === B.faction) err(f, "shared-faction", `${b.a} and ${b.b} border each other and both have ${A.faction} as their main faction`, `${b.a}|${b.b}`);
      for (const oa of A.others) {
        const ob = B.others.find((x) => x.group === oa.group);
        if (ob && jaccard(tokens(oa.flavour), tokens(ob.flavour)) >= 0.5) warn(f, "same-flavour", `${oa.group} appears in neighbours ${b.a} and ${b.b} with near-identical flavour: make it a different crew in each`, `${b.a}|${b.b}`);
      }
      if (A.palette === B.palette) err(f, "shared-palette", `${b.a} and ${b.b} border each other and share palette ${A.palette}`, `${b.a}|${b.b}`);
      const open = !b.short && b.passes.length + b.paths.length > 0;
      const step = levelStep(A.level, B.level);
      if (open && step > cast.rules.maxLevelStep)
        err(f, "level-step", `${b.a} (${A.level.join("-")}) -> ${b.b} (${B.level.join("-")}): a ${step}-level step across a walkable border (max ${cast.rules.maxLevelStep})`, `${b.a}|${b.b}`);
    }

    const n = cast.rows.length;
    const allowed = Math.max(2, Math.ceil(cast.rules.maxFactionShare * n));
    const share = new Map<string, number>();
    for (const r of cast.rows) share.set(r.faction, (share.get(r.faction) ?? 0) + 1);
    for (const [fa, count] of share) if (count > allowed) err(f, "faction-share", `${fa} is the main faction of ${count} of ${n} zones (cap max(2, ceil(${cast.rules.maxFactionShare} x ${n} zones)) = ${allowed})`, fa);

    warn(f, "palette-unverified", `palette ids (${[...new Set(cast.rows.map((r) => r.palette))].join(", ")}) are unverified: the project keeps no palette list, so only "neighbours differ" is checked`);
    if (!sets.length) warn(f, "building-set-unverified", "no WFC kits under assets/wfc: building sets are unverified");
    if (!cast.rows.some((r) => r.starter)) err(f, "no-starter", "no zone is a starter zone: new characters have nowhere to begin");

    const words = cast.rows.map((r) => ({ zone: r.zone, t: tokens(r.premise) }));
    for (let i = 0; i < words.length; i++)
      for (let j = i + 1; j < words.length; j++) {
        const s = jaccard(words[i]!.t, words[j]!.t);
        if (s >= 0.5) warn(f, "premise-dup", `premises of ${words[i]!.zone} and ${words[j]!.zone} read alike (${Math.round(s * 100)}% shared words)`, `${words[i]!.zone}|${words[j]!.zone}`);
      }
    console.log(`cast: ${n} rows, ${share.size} main factions, ${cast.rows.filter((r) => r.starter).length} starter zone(s)`);
  }
  return finish({ ...ctx, zone: "" }, "cast", [p.cast, p.bestiary, p.adjacency], f);
}
