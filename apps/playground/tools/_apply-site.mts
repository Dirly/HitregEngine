/* scratch: install a crafted site doc + its blobs into the world, with guard rails */
import fs from "node:fs";
import { worldRecipeSchema } from "@hitreg/core";
const [sitePath, blobsPath] = process.argv.slice(2) as [string, string];
const file = "projects/voxel-demo/assets/worlds/mmo.json";
const raw = JSON.parse(fs.readFileSync(file, "utf8"));
const site = JSON.parse(fs.readFileSync(sitePath, "utf8"));
const blobs = JSON.parse(fs.readFileSync(blobsPath, "utf8")) as { id: string; center: number[]; radius: number }[];
const [sx, sz] = site.at as [number, number];
const kept = blobs.filter((b, i) => {
  const d = Math.hypot(b.center[0]! - sx, b.center[2]! - sz);
  const ok = d <= 60 && b.radius <= 12 && i < 40;
  if (!ok) console.log(`dropped blob ${b.id} (distance ${d.toFixed(0)} m, radius ${b.radius})`);
  b.id = b.id.startsWith(site.id) ? b.id : `${site.id}-${i}`;
  return ok;
});
raw.features.fallSites = [...(raw.features.fallSites ?? []).filter((s: { id: string }) => s.id !== site.id), site];
raw.features.blobs = [...raw.features.blobs.filter((b: { id: string }) => !b.id.startsWith(site.id)), ...kept];
worldRecipeSchema.parse(raw);
fs.writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
console.log(`installed ${site.id}: ${site.template}, ${site.tiers?.length ?? 0} tiers, ${site.rocks?.length ?? 0} rocks, ${kept.length} blobs`);
