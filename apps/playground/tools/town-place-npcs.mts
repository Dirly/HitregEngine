/**
 * town-place-npcs — stand every resident at the door of where they work (else where they live), facing the street,
 * from the town's layout; a few spread out sideways when several share a door. Named structures (plan.structures,
 * e.g. a DC gate tower or the quay) take their spot from `spots`. Writes the town doc's `place` for each resident; run
 * tools/town-npcs.mts afterwards to regenerate the scene NPCs.
 *
 *   npx tsx tools/town-place-npcs.mts --project proving --town brinehold --spots "gate-tower=4110.8,-2178.4,4105,-2172;quay=4064,-2153,4040,-2160"
 * A spot is "id=x,z,faceX,faceZ".
 */
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const opt = (n: string, f: string): string => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1]! : f; };
const dir = path.resolve("projects", opt("project", ""), "authoring/towns");
const town = opt("town", "");
const docFile = path.join(dir, `${town}.json`);
const doc = JSON.parse(fs.readFileSync(docFile, "utf8"));
const plan = JSON.parse(fs.readFileSync(path.join(dir, `${town}-plan.json`), "utf8"));
const layout = JSON.parse(fs.readFileSync(path.join(dir, `${town}-layout.json`), "utf8"));
type P = [number, number];
const spots = new Map<string, { at: P; face: P }>();
for (const spec of opt("spots", "").split(";").filter(Boolean)) {
  const [id, rest] = spec.split("=");
  const [x, z, fx, fz] = rest!.split(",").map(Number);
  spots.set(id!, { at: [x!, z!], face: [fx!, fz!] });
}
for (const b of layout.buildings) {
  const f = b.facing as P;
  spots.set(b.id, { at: b.door, face: [b.door[0] + f[0] * 6, b.door[1] + f[1] * 6] });
}
const used = new Map<string, number>();
let placed = 0;
const missing: string[] = [];
for (const r of doc.residents) {
  const pr = plan.residents.find((q: { id: string }) => q.id === r.id);
  const where = [pr?.work, pr?.home].find((k) => k && spots.has(k));
  if (!where) { missing.push(r.id); continue; }
  const s = spots.get(where)!;
  const n = used.get(where) ?? 0;
  used.set(where, n + 1);
  // fan out along the front: 0, +1.6, -1.6, +3.2, ...
  const off = n === 0 ? 0 : (n % 2 ? 1 : -1) * 1.6 * Math.ceil(n / 2);
  const fx = s.face[0] - s.at[0], fz = s.face[1] - s.at[1], l = Math.hypot(fx, fz) || 1;
  const side: P = [-fz / l, fx / l];
  const at: P = [Math.round((s.at[0] + side[0] * off) * 100) / 100, Math.round((s.at[1] + side[1] * off) * 100) / 100];
  const face: P = [Math.round((at[0] + fx) * 100) / 100, Math.round((at[1] + fz) * 100) / 100];
  r.place = { at, face };
  placed++;
}
fs.writeFileSync(docFile, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`placed ${placed} residents at their doors${missing.length ? `; no spot for: ${missing.join(", ")}` : ""}`);
