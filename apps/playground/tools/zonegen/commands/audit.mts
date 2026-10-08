/**
 * zonegen audit <world> --project <p> --zone <z>
 *
 * The zone audit, from data only (no world field, no renders): what a reviewer checks before calling a zone done.
 *   - variety for this zone AND each neighbour that has a plan: groups holding places, the main faction's share of the
 *     hostile places, distinct quest signatures, the share of quests with no kill, quest sources by kind;
 *   - sameness between neighbours: a local group present on both sides with the same flavour (cast `others`), and
 *     quest signatures repeated across the border beyond the brief's maxRepeatNeighbourhood;
 *   - every reservation whose walkable approach is not proven (the POI owner's handoff carries no real-player walk);
 *   - every status row of the zone that is not ok (rows with no gate are listed as such).
 * Errors only on rules the planning lints already treat as errors (the main faction holding more than its share of the
 * hostile places, too few groups holding them); everything else is a warning a human reads. Writes reports/audit.json.
 */
import path from "node:path";
import { exists, finish, readJson, type Ctx, type Finding } from "../lib.mts";
import { castSchema, questGraphSchema, zoneBestiarySchema, zoneBriefSchema, type Cast, type QuestGraph, type ZoneBestiary, type ZoneBrief } from "../schemas.mts";
import { zoneRows } from "../stages.mts";
import { questSignature } from "./quests.mts";
import { poiJob } from "./_zone.mts";
import { err, jaccard, neighboursOf, requireZone, tokens, warn, type Adjacency } from "./_shared.mts";

interface ZoneData { id: string; brief: ZoneBrief; graph: QuestGraph; zb: ZoneBestiary | null; main: string }
interface Variety { holders: number; hostile: number; mainShare: number; signatures: number; quests: number; noKillShare: number; sources: Record<string, number> }

function loadZone(ctx: Ctx, zone: string, cast: Cast | null): ZoneData | null {
  const p = ctx.paths;
  if (!exists(p.quests(zone)) || !exists(p.brief(zone))) return null;
  const g = questGraphSchema.safeParse(readJson(p.quests(zone)));
  const b = zoneBriefSchema.safeParse(readJson(p.brief(zone)));
  if (!g.success || !b.success) return null;
  const zb = exists(p.zoneBestiary(zone)) ? zoneBestiarySchema.safeParse(readJson(p.zoneBestiary(zone))) : null;
  return { id: zone, brief: b.data, graph: g.data, zb: zb?.success ? zb.data : null, main: cast?.rows.find((r) => r.zone === zone)?.faction ?? "" };
}

function variety(z: ZoneData): Variety {
  const groups = new Map((z.zb?.groups ?? []).map((g) => [g.id, g]));
  const holders = new Map<string, string>();
  for (const l of z.graph.locations) if (l.hostile) holders.set(l.id, groups.get(l.hostile)?.faction ?? l.hostile);
  const keys = new Set([...z.graph.locations].filter((l) => l.hostile).map((l) => l.hostile));
  const mainHeld = [...holders.values()].filter((f) => z.main && f === z.main).length;
  const n = z.graph.quests.length;
  const sources: Record<string, number> = {};
  for (const q of z.graph.quests) sources[q.giver.type] = (sources[q.giver.type] ?? 0) + 1;
  return {
    holders: keys.size,
    hostile: holders.size,
    mainShare: holders.size ? mainHeld / holders.size : 0,
    signatures: new Set(z.graph.quests.map(questSignature)).size,
    quests: n,
    noKillShare: n ? z.graph.quests.filter((q) => !q.objectives.some((o) => o.action === "kill")).length / n : 0,
    sources,
  };
}
const pct = (x: number): string => `${Math.round(x * 100)}%`;

export async function run(ctx: Ctx): Promise<number> {
  const bad = requireZone(ctx.zone, "audit");
  if (bad !== null) return bad;
  const f: Finding[] = [];
  const p = ctx.paths;
  const zone = ctx.zone;
  const inputs = [p.brief(zone), p.quests(zone), p.zoneBestiary(zone), p.reservations(zone), p.cast];
  const castParsed = exists(p.cast) ? castSchema.safeParse(readJson(p.cast)) : null;
  const cast = castParsed?.success ? castParsed.data : null;
  const me = loadZone(ctx, zone, cast);
  if (!me) {
    err(f, "no-plan", `${zone} has no readable brief + quest graph`);
    return finish(ctx, "audit", inputs, f);
  }
  const adj = exists(p.adjacency) ? (readJson(p.adjacency) as Adjacency) : null;
  const neighbourIds = adj ? neighboursOf(adj, zone) : me.brief.neighbours.map((n) => n.zone);
  const neighbours = neighbourIds.map((id) => loadZone(ctx, id, cast)).filter((x): x is ZoneData => !!x);
  for (const n of neighbours) inputs.push(p.quests(n.id), p.brief(n.id));

  // variety, here and next door
  console.log(`audit ${zone}: variety (holders = groups holding hostile places)`);
  console.log(`  zone       quests  holders  main-share  signatures  no-kill  sources`);
  for (const z of [me, ...neighbours]) {
    const v = variety(z);
    console.log(`  ${z.id.padEnd(10)} ${String(v.quests).padStart(6)}  ${String(v.holders).padStart(7)}  ${pct(v.mainShare).padStart(10)}  ${String(v.signatures).padStart(10)}  ${pct(v.noKillShare).padStart(7)}  ${Object.entries(v.sources).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  }
  const unplanned = neighbourIds.filter((id) => !neighbours.some((n) => n.id === id));
  if (unplanned.length) console.log(`  (no plan yet: ${unplanned.join(", ")})`);
  const v = variety(me);
  const rules = me.brief.variety;
  if (v.hostile && v.mainShare > rules.maxMainHostileShare) err(f, "main-holds-all", `the main faction ${me.main} holds ${pct(v.mainShare)} of the hostile places (at most ${pct(rules.maxMainHostileShare)})`);
  if (v.hostile >= rules.minHostileGroups && v.holders < rules.minHostileGroups) err(f, "few-holders", `${v.hostile} hostile places held by ${v.holders} group(s) (at least ${rules.minHostileGroups})`);
  if (v.noKillShare < rules.minNoKillShare) warn(f, "floor-no-kill", `${pct(v.noKillShare)} of quests have no kill (floor ${pct(rules.minNoKillShare)})`);

  // sameness across the border
  const myOthers = cast?.rows.find((r) => r.zone === zone)?.others ?? [];
  for (const n of neighbours) {
    const theirs = cast?.rows.find((r) => r.zone === n.id)?.others ?? [];
    for (const o of myOthers) {
      const t = theirs.find((x) => x.group === o.group);
      if (!t) continue;
      const sim = jaccard(tokens(o.flavour), tokens(t.flavour));
      if (sim >= 0.5) warn(f, "same-flavour", `group ${o.group} appears in ${zone} and ${n.id} with nearly the same flavour (${Math.round(sim * 100)}% shared words)`, o.group);
    }
    if (me.main && me.main === n.main) warn(f, "same-main", `${zone} and ${n.id} share the main faction ${me.main}`);
  }
  const counts = new Map<string, { here: number; there: number }>();
  for (const q of me.graph.quests) { const s = questSignature(q); counts.set(s, { here: (counts.get(s)?.here ?? 0) + 1, there: counts.get(s)?.there ?? 0 }); }
  for (const n of neighbours) for (const q of n.graph.quests) { const s = questSignature(q); const c = counts.get(s); if (c) c.there++; }
  for (const [s, c] of counts) if (c.there > 0 && c.here + c.there > rules.maxRepeatNeighbourhood) warn(f, "repeat-across", `signature ${s}: ${c.here} here + ${c.there} next door (at most ${rules.maxRepeatNeighbourhood})`);
  const shared = [...counts].filter(([, c]) => c.there > 0).length;
  console.log(`  signatures shared with a neighbour: ${shared} of ${counts.size}`);

  // walkable approach proven: the POI owner's handoff records a real-player walk
  let unproven = 0;
  const resFile = p.reservations(zone);
  const res = exists(resFile) ? ((readJson(resFile) as { reservations?: { location: string; approach: { from: string } }[] }).reservations ?? []) : [];
  // a location no POI owner builds (wild) proves its approach with tools/approach-walk.mts -> reports/approach-walk.json
  const awFile = path.join(path.dirname(resFile), "reports", "approach-walk.json");
  const aw = exists(awFile) ? ((readJson(awFile) as { locations?: Record<string, { ok?: boolean }> }).locations ?? {}) : {};
  for (const r of res) {
    const job = poiJob(ctx, zone, r.location);
    const walked = (job?.handoff as { review?: { realPlayer?: unknown } } | null)?.review?.realPlayer ?? (!job && aw[r.location]?.ok ? "approach-walk" : undefined);
    if (!walked) {
      unproven++;
      warn(f, "approach-unproven", `${r.location}: no walk from ${r.approach.from} proven (${job ? `POI job at "${job.stage}", handoff review.realPlayer empty` : "no POI job: npx tsx tools/approach-walk.mts --scene <world> --reservations <zone>/reservations.json"})`, r.location);
    }
  }
  console.log(`  reservations with a proven walkable approach: ${res.length - unproven} of ${res.length}`);

  // every status row that is not ok
  const rows = zoneRows(ctx, zone).filter((r) => r.stage !== "audit");
  const open = rows.filter((r) => r.state !== "ok");
  for (const r of open) warn(f, "row-open", `${r.gap ? "no gate yet" : r.state} ${r.stage}${r.why ? `: ${r.why}` : ""}`, r.stage);
  console.log(`  status rows: ${rows.length - open.length} of ${rows.length} ok`);
  return finish(ctx, "audit", inputs, f);
}
