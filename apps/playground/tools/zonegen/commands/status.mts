/**
 * zonegen status <world> --project <p> [--zone <id>] [--next] — the plan. What is done, stale, missing, next.
 *
 * Without --zone: the world stages and one line per zone. With --zone: the world stages, then the zone's full list
 * (planning, freeze, build). --next prints only the next thing to do (rows with no machine gate yet are skipped).
 * The list itself lives in ../stages.mts.
 */
import type { Ctx } from "../lib.mts";
import { PLANNING, playable, worldRows, zoneRows, zonesOf, type Row } from "../stages.mts";

const mark = (r: Row): string => (r.gap ? "MISSING" : r.state).padEnd(8);
function print(rows: Row[], indent = "  "): void {
  const w = Math.max(14, ...rows.map((r) => r.stage.length)) + 1;
  for (const r of rows) {
    console.log(`${indent}${mark(r)} ${r.stage.padEnd(w)} ${r.who.padEnd(10)}${r.why ? ` — ${r.why}` : ""}`);
    if (r.state !== "ok" && !r.gap) console.log(`${indent}${" ".repeat(9 + w + 11)}how: ${r.how}`);
  }
}
const firstOpen = (rows: Row[]): Row | undefined => rows.find((r) => r.state !== "ok" && !r.gap);

export async function run(ctx: Ctx): Promise<number> {
  const world = worldRows(ctx);
  if (ctx.zone) {
    if (!zonesOf(ctx).some((z) => z.id === ctx.zone) && zonesOf(ctx).length) {
      console.error(`status: ${ctx.zone} is not a zone in adjacency.json`);
      return 2;
    }
    const zone = zoneRows(ctx, ctx.zone);
    const next = firstOpen([...world, ...zone]);
    if (ctx.flag("next")) {
      console.log(next ? `${next.stage} (${next.who}): ${next.how}` : "(nothing to do)");
      return 0;
    }
    console.log(`${ctx.world} world: ${world.filter((r) => r.state === "ok").length}/${world.length} ok`);
    print(world);
    const plan = zone.slice(0, PLANNING.length);
    const build = zone.slice(PLANNING.length);
    console.log(`\n${ctx.zone} planning: ${plan.filter((r) => r.state === "ok").length}/${plan.length} ok`);
    print(plan);
    console.log(`\n${ctx.zone} build: ${build.filter((r) => r.state === "ok").length}/${build.length} ok, ${build.filter((r) => r.gap).length} with no gate yet`);
    if (plan[plan.length - 1]!.state === "MISSING") console.log(`  waits for the freeze: ${build.map((r) => r.stage + (r.gap ? " (no gate yet)" : "")).join(", ")}`);
    else print(build);
    const pl = playable(ctx, ctx.zone);
    console.log(`\n${ctx.zone} playable now: ${pl.bound} quests bound, ${pl.played} played (of ${pl.planned} planned)`);
    console.log(next ? `\nnext: ${next.stage} (${next.who}) — ${next.how}` : "\nevery gated stage ok");
    return 0;
  }

  const zones = zonesOf(ctx).map((z) => ({ ...z, rows: zoneRows(ctx, z.id) }));
  const worldNext = firstOpen(world);
  const zoneNext = zones.map((z) => ({ z, r: firstOpen(z.rows) })).find((x) => x.r);
  if (ctx.flag("next")) {
    if (worldNext) console.log(`${worldNext.stage} (${worldNext.who}): ${worldNext.how}`);
    else if (zoneNext) console.log(`${zoneNext.z.id} ${zoneNext.r!.stage} (${zoneNext.r!.who}): ${zoneNext.r!.how}`);
    else console.log("(nothing to do)");
    return 0;
  }
  console.log(`${ctx.world} world: ${world.filter((r) => r.state === "ok").length}/${world.length} ok`);
  print(world);
  if (zones.length === 0) console.log("\n(no zones listed until `zonegen adjacency` has run)");
  else console.log(`\nzones (planning ok/${PLANNING.length}, build ok/total, first open row):`);
  for (const z of zones) {
    const plan = z.rows.slice(0, PLANNING.length);
    const build = z.rows.slice(PLANNING.length).filter((r) => !r.gap);
    const open = firstOpen(z.rows);
    const pl = playable(ctx, z.id);
    console.log(`  ${z.id.padEnd(12)} ${z.name.slice(0, 22).padEnd(22)} plan ${plan.filter((r) => r.state === "ok").length}/${plan.length}  build ${build.filter((r) => r.state === "ok").length}/${build.length}  playable ${pl.bound} bound/${pl.played} played  ${open ? `${open.state} ${open.stage}${open.why ? ` — ${open.why}` : ""}` : "done"}`);
  }
  const next = worldNext ?? zoneNext?.r;
  console.log(next ? `\nnext: ${zoneNext && !worldNext ? `${zoneNext.z.id} ` : ""}${next.stage} (${next.who}) — ${next.how}` : "\nevery gated stage ok");
  return 0;
}
