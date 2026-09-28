/* scratch: the crafting context for one fall site — grids of ground, natural ground and water, plus the local rules */
import fs from "node:fs";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
const recipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync("projects/voxel-demo/assets/worlds/mmo.json", "utf8")));
const field = createWorldField(recipe);
const river = process.argv[2] ?? "river-15";
const siteId = process.argv[3] ?? "site-river-15-21";
const N = 40, STEP = 2.5;
const falls = field.falls.filter((f) => f.river === river).sort((a, b) => b.top - a.top);
const top = falls[0]!, bot = falls[falls.length - 1]!;
const dx = bot.dirX, dz = bot.dirZ;
// centre: between 25 m upstream of the top lip and 35 m past the foot
const ax = top.x - dx * 28, az = top.z - dz * 28, bx = bot.x + dx * 35, bz = bot.z + dz * 35;
const cx = Math.round((ax + bx) / 2), cz = Math.round((az + bz) / 2);
const ref = top.top;
const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake" as "lake" | "river", floor: 0 };
const g: string[] = [], nat: string[] = [], wat: string[] = [];
for (let r = 0; r < N; r++) {
  const a: string[] = [], b: string[] = [], c: string[] = [];
  for (let col = 0; col < N; col++) {
    const x = cx + (col - (N - 1) / 2) * STEP, z = cz + (r - (N - 1) / 2) * STEP;
    const h = field.height(x, z);
    a.push(String(Math.round(h - ref)));
    b.push(String(Math.round(field.naturalHeight(x, z) - ref)));
    if (field.waterSurface(x, z, ws) && ws.y + 0.35 > h) c.push(ws.kind === "lake" ? "L" : String(Math.round(ws.y - ref)));
    else c.push(".");
  }
  g.push(a.join(" ")); nat.push(b.join(" ")); wat.push(c.join(" "));
}
const biome = field.biome(cx, cz);
const rules = recipe.scatter.filter((s) => /rock|stone|boulder/i.test(s.id)).map((s) => ({ id: s.id, biomes: (s as { biomes?: string[] }).biomes ?? [], size: (s as { colliderSize?: number[] }).colliderSize }));
const allowed = rules.filter((r) => r.biomes.length === 0 || r.biomes.includes(biome.id));
const site = (recipe.features.fallSites ?? []).find((s: { id: string }) => s.id === siteId);
const blobs = recipe.features.blobs.filter((b) => b.id.startsWith(siteId));
console.log(`SITE ${siteId} on ${river}; heights are metres relative to the TOP lip water (${ref.toFixed(1)}).`);
console.log(`flow direction (x,z) = (${dx.toFixed(2)}, ${dz.toFixed(2)}); biome here: ${biome.id}`);
console.log(`falls (top to bottom): ${falls.map((f) => `foot [${f.x.toFixed(0)},${f.z.toFixed(0)}] water ${(f.top - ref).toFixed(1)} -> ${(f.bottom - ref).toFixed(1)}, channel ${f.width.toFixed(1)} m`).join("; ")}`);
console.log(`grid ${N} x ${N}, ${STEP} m per cell, centre [${cx},${cz}]; world x = ${cx} + (col - ${(N - 1) / 2}) * ${STEP}, z = ${cz} + (row - ${(N - 1) / 2}) * ${STEP}; row 0 = north (-z), col 0 = west (-x).`);
console.log(`rock rules allowed in this biome (ONLY use these): ${allowed.map((r) => `${r.id} (collider ${r.size?.map((v) => v.toFixed(1)).join("x")} m at scale 1)`).join(", ") || "none"}`);
console.log(`\nCURRENT SITE DOC:\n${JSON.stringify(site)}`);
console.log(`\nCURRENT SITE BLOBS (${blobs.length}):\n${JSON.stringify(blobs)}`);
console.log(`\nGROUND (as built now):\n${g.join("\n")}`);
console.log(`\nNATURAL GROUND (before any river/lake/site carving):\n${nat.join("\n")}`);
console.log(`\nWATER ('.' none, 'L' lake, else river water level relative to top lip):\n${wat.join("\n")}`);
