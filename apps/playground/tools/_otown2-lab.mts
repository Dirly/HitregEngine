// o-town2 scratch (deleted when the round ends): the CROPPED town lab for Bell Strand (town-1): project otown2-lab, world
// otown2lab (recipe name redstrand, so the design's world matches), the live redstrand world + scene cropped to the
// town's box (tools/_lab-crop.mts proves the ground identical to live inside it), town-1's old grey box left out.
//   npx tsx tools/_otown2-lab.mts
import fs from "node:fs";
import path from "node:path";
import { createWorldField, worldRecipeSchema } from "@hitreg/core";
import { cropRecipe, cropScene, labBox, type V2 } from "./_lab-crop.mts";

const LIVE = "projects/redstrand", LAB = "projects/otown2-lab", WID = "otown2lab";
const C: V2 = [640, -368];
// the town, its gate yard and strand, and the shot cameras (gate road out to ~200 m, the far frame across the lake)
const pts: V2[] = [[C[0] - 150, C[1] - 150], [C[0] + 150, C[1] + 150], [C[0] + 170, C[1] + 170]];
const box = labBox(pts, 96);
const read = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));
const write = (f: string, j: unknown) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(j, null, 1) + "\n"); };
const pj = read(`${LIVE}/project.json`);
write(`${LAB}/project.json`, { version: 1, name: "otown2-lab", title: "o-town2 lab: Bell Strand (scratch)", description: `Scratch crop [${box.min}]..[${box.max}] of the redstrand world + scene for the town-1 rebuild (o-town2). Never installed; delete when done.`, group: "Worlds", menuOrder: 99,
  scenes: [{ id: WID, label: "o-town2 lab: Bell Strand", variants: [] }], engine: pj.engine ?? "^0.1", multiplayer: pj.multiplayer ?? "server", tools: [], dependsOn: [...new Set([...(pj.dependsOn ?? []), "redstrand"])] });
const full = read(`${LIVE}/assets/worlds/redstrand.json`);
const c = cropRecipe(full, box, { log: (s) => console.log(s) });
if (!c.proof.ok) throw new Error(`crop proof failed: ${c.proof.worst}`);
write(`${LAB}/assets/worlds/${WID}.json`, c.recipe);
write(`${LAB}/lab-box.json`, { min: box.min, max: box.max, source: `${LIVE}/assets/worlds/redstrand.json` });
// terrain materials the recipe names, renamed to the lab world id
const tdir = `${LIVE}/assets/materials/terrain`, tout = `${LAB}/assets/materials/terrain`;
fs.rmSync(tout, { recursive: true, force: true }); fs.mkdirSync(tout, { recursive: true });
const named = new Set(JSON.stringify(c.recipe).match(/terrain\/redstrand[a-z0-9-]*/g) ?? []);
for (const f of fs.readdirSync(tdir).filter((f) => f === "redstrand.json" || (f.startsWith("redstrand-") && named.has(`terrain/${f.replace(/\.json$/, "")}`)))) fs.copyFileSync(path.join(tdir, f), path.join(tout, WID + f.slice("redstrand".length)));
const field = createWorldField(worldRecipeSchema.parse(c.recipe));
const s0 = read(`${LIVE}/assets/scenes/redstrand.scene.json`);
const fx = 679, fz = -329; // the player starts at the gate
const cs = cropScene(s0, box, { x: fx, z: fz, groundY: field.height(fx, fz) });
const s = cs.scene;
// the old grey box of town-1 goes (the lab installs the new town); populated creatures stay out of the lab's walks
const drop = new Set(Object.entries(s.entities).filter(([, e]: any) => (e.tags ?? []).some((t: string) => t === "town-building:town-1" || t === "populate")).map(([id]) => id));
for (let grew = true; grew;) { grew = false; for (const [k, e] of Object.entries(s.entities) as any) if (e.parent && drop.has(e.parent) && !drop.has(k)) { drop.add(k); grew = true; } }
for (const id of drop) delete s.entities[id];
for (const e of Object.values(s.entities) as any) if (e.components?.voxelWorld) e.components.voxelWorld.world = WID;
s.name = "o-town2 lab: Bell Strand";
write(`${LAB}/assets/scenes/${WID}.scene.json`, s);
console.log(`lab ${LAB}: box [${box.min}]..[${box.max}]; dropped ${Object.entries(c.dropped).map(([k, n]) => `${n} ${k}`).join(", ") || "nothing"}; proof ${c.proof.samples} samples + ${c.proof.cells} cells; scene kept ${cs.kept}, ${drop.size} town-1 grey-box / populate entities left out`);
