/**
 * zonegen items <world> --project <p> --zone <z> [--dry]
 *
 * Writes the item asset (assets/items/<id>.json) of every item the zone's quest plan declares and the project does not
 * have yet, so `bind` stops reporting `no-item-asset`. An existing asset is never touched. What it writes is the
 * mechanical part only: kind `quest`, a stack and weight from the plan's item kind, value 0 (a vendor will not buy it),
 * the nearest existing loot icon by name, and the tag `placeholder-icon` (the art stage replaces it: docs/item-icons.md).
 * The description stays empty: quest text is written after placement, by the bind task of the quest that uses the item.
 */
import fs from "node:fs";
import { assetDirs, findAsset } from "../../_closure.mjs";
import path from "node:path";
import { exists, readJson, writeJson, type Ctx } from "../lib.mts";
import { requireZone } from "./_shared.mts";

interface PlanItem { id: string; name: string; kind: string }
const SYNONYMS: Record<string, string[]> = {
  fleece: ["wool"], flask: ["hipflask", "waterskin", "canteen"], water: ["waterskin", "canteen"], crate: ["crate"], sacks: ["sack"], sack: ["sack"],
  staff: ["timber"], goods: ["locket", "ring"], grave: ["skull", "bone"], letter: ["letter", "envelope"], deeds: ["deed"], log: ["journal", "notebook"],
  ledger: ["ledger"], book: ["book", "tome"], hymnal: ["book", "tome"], slate: ["stone"], peat: ["coal", "moss"], salt: ["salt"], fish: ["fish"],
};
const STACK: Record<string, [number, number]> = { delivery: [10, 4], evidence: [20, 0.5], trophy: [1, 2], key: [1, 0.2] };

function pickIcon(item: PlanItem, icons: string[]): string {
  const words = `${item.id} ${item.name}`.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2);
  const want = new Set(words.flatMap((w) => [w, w.replace(/s$/, ""), ...(SYNONYMS[w] ?? [])]));
  let best = "pouch-small";
  let score = 0;
  for (const icon of icons) {
    const tokens = icon.split("-");
    const s = tokens.filter((t) => want.has(t)).length / tokens.length + (want.has(tokens[0]!) ? 0.5 : 0);
    if (s > score) { score = s; best = icon; }
  }
  return best;
}

export async function run(ctx: Ctx): Promise<number> {
  const bad = requireZone(ctx.zone, "items");
  if (bad !== null) return bad;
  const p = ctx.paths;
  if (!exists(p.quests(ctx.zone))) { console.error("items: the zone has no quests.json"); return 1; }
  const plan = readJson(p.quests(ctx.zone)) as { items?: PlanItem[] };
  const dir = path.join(p.projectDir, "assets", "items");
  // loot icons are shared game art (foundation): list them across the dependsOn closure
  const icons = [...new Set(assetDirs(p.projectDir, "textures/icons/loot").flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith(".png")).map((f) => f.replace(/\.png$/, ""))))];
  let wrote = 0;
  for (const item of plan.items ?? []) {
    const file = path.join(dir, `${item.id}.json`);
    // a zone quest item is world content and is written here; skip ids any project in the closure already has
    if (exists(file) || findAsset(p.projectDir, `items/${item.id}.json`)) continue;
    const [stack, weight] = STACK[item.kind] ?? [10, 1];
    const name = item.name.replace(/^(a|an)\s+/i, "");
    const icon = pickIcon(item, icons);
    const asset = { name: name[0]!.toUpperCase() + name.slice(1), kind: "quest", stack, weight, value: 0, rarity: "common", icon: `icons/loot/${icon}.png`, description: "", tags: ["quest", ctx.zone, "placeholder-icon"] };
    console.log(`  ${ctx.flag("dry") ? "would write" : "wrote"} items/${item.id}.json  "${asset.name}"  icon ${icon} (placeholder)`);
    if (!ctx.flag("dry")) writeJson(file, asset);
    wrote++;
  }
  console.log(`items: ${wrote} written, ${(plan.items ?? []).length - wrote} already present`);
  return 0;
}
