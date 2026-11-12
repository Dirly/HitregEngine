// Upsert cover layers and scatter rules into a world recipe by id, leaving every other one as it is.
//   npx tsx tools/cover-upsert.mts <recipe.json> <rules.json>   (run from apps/playground)
// rules.json: an array of cover layers, or { layers?: [...cover], scatter?: [...scatter rules] }.
// `worldgen cover --apply` REPLACES recipe.cover; this adds or updates a world's own extras (e.g. sea-bed
// cover, reef rocks, coral) without re-applying the shared set. The result is schema-validated BEFORE it is
// written, under the recipe's lock: a running editor live-loads the recipe, and an invalid one unloads the world.
// Audit after with `worldgen cover <world>`.
import fs from "node:fs";
import { worldRecipeSchema } from "@hitreg/core";
import { updateJsonFile } from "./_scene-write.mts";
const [recipeFile, rulesFile] = process.argv.slice(2);
if (!recipeFile || !rulesFile) { console.error("usage: cover-upsert.mts <recipe.json> <rules.json>"); process.exit(2); }
const raw = JSON.parse(fs.readFileSync(rulesFile, "utf8"));
const lists: [string, { id: string }[]][] = [["cover", Array.isArray(raw) ? raw : raw.layers ?? []], ["scatter", Array.isArray(raw) ? [] : raw.scatter ?? []]];
const log: string[] = [];
updateJsonFile(recipeFile, (recipe: any) => {
  if (!recipe) throw Error(`no recipe ${recipeFile}`);
  for (const [key, items] of lists) {
    if (!items.length) continue;
    recipe[key] ??= [];
    for (const item of items) {
      const i = recipe[key].findIndex((c: { id?: string }) => c.id === item.id);
      if (i >= 0) recipe[key][i] = item; else recipe[key].push(item);
      log.push(`${i >= 0 ? "updated" : "added"} ${key} ${item.id}`);
    }
  }
  const checked = worldRecipeSchema.safeParse(recipe);
  if (!checked.success) throw Error("NOT written, the recipe would be invalid:\n" + JSON.stringify(checked.error.issues, null, 1));
  return { doc: recipe };
}, { label: "cover-upsert" });
console.log(log.join("\n"));
