/**
 * zonegen stories <world> --project <p> [--dry] [--undo]
 *
 * Writes each zone's story from its zonegen brief (zones/<z>/brief.json `story`, else `premise`) into the world
 * recipe's region of the same id (`regions[].story`), so worldgen's `zone-stories` row and everything reading region
 * stories see it. Idempotent (a region already telling the brief's story is left alone). The stories it replaced are
 * kept in <worldDir>/stories-inverse.json; `--undo` puts them back (only where the region still tells the brief's story).
 * Writes the recipe under its lock (tools/_scene-write.mts).
 */
import fs from "node:fs";
import path from "node:path";
import type { Ctx } from "../lib.mts";
import { updateJsonFile } from "../../_scene-write.mts";
import { briefStories, storiesIntoRegions } from "../../_zone-sources.mts";

export async function run(ctx: Ctx): Promise<number> {
  const inverseFile = path.join(ctx.paths.worldDir, "stories-inverse.json");
  const briefs = briefStories(ctx.paths.projectDir, ctx.world);
  if (ctx.flag("undo")) {
    if (!fs.existsSync(inverseFile)) { console.error(`no ${path.relative(ctx.paths.projectDir, inverseFile)}: nothing to undo`); return 1; }
    const inv = JSON.parse(fs.readFileSync(inverseFile, "utf8")) as { stories: Record<string, string> };
    const back: string[] = [];
    updateJsonFile(ctx.paths.recipe, (r: any) => {
      for (const g of r.regions ?? []) if (g.id in inv.stories && g.story === briefs.get(g.id)) { g.story = inv.stories[g.id]; back.push(g.id); }
      return { doc: r };
    }, { label: "zonegen stories --undo" });
    console.log(`stories undone: ${back.join(", ") || "none"}`);
    return 0;
  }
  let res = { changed: [] as string[], inverse: {} as Record<string, string> };
  if (ctx.flag("dry")) {
    const r = JSON.parse(fs.readFileSync(ctx.paths.recipe, "utf8"));
    res = storiesIntoRegions(r.regions ?? [], briefs);
  } else {
    updateJsonFile(ctx.paths.recipe, (r: any) => { res = storiesIntoRegions(r.regions ?? [], briefs); return { doc: r }; }, { label: "zonegen stories" });
    if (res.changed.length) {
      const prev = fs.existsSync(inverseFile) ? (JSON.parse(fs.readFileSync(inverseFile, "utf8")).stories as Record<string, string>) : {};
      fs.writeFileSync(inverseFile, JSON.stringify({ why: "zonegen stories: the region stories before the brief stories were written (zonegen stories --undo)", stories: { ...res.inverse, ...prev } }, null, 1) + "\n");
    }
  }
  console.log(`${ctx.world}: ${briefs.size} brief stor${briefs.size === 1 ? "y" : "ies"}; ${res.changed.length ? `wrote ${res.changed.join(", ")}` : "every region already tells its brief's story"}${ctx.flag("dry") ? " (dry)" : ""}`);
  return 0;
}
