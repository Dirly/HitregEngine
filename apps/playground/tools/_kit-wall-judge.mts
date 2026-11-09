/**
 * The kit curtain AS BUILT (o-town2, 2026-10-30; Derek walked Bell Strand's first grey box: "gaps between the towers").
 * `town-wall-line check` calls it when a town has a kit curtain record (`town-wall-line kit --project --town`):
 *   joins     the record's line re-laid with the kit (tools/_kit-wall.mts) has no gap over 5 cm and no overlap;
 *   scene     the scene holds EVERY placement (same prefab, x/z within 2 cm, yaw within 0.2 deg) as an entity tagged
 *             `town-wall:<town>`, and no other entity carries that tag (a hand-moved or extra piece is a finding);
 *   level     every piece stands at one y (2 cm): the pieces are flat, so a step between neighbours is a hole.
 * Returns the overlook screens (each piece's centreline at its placed top) and the run lines for the road gate.
 */
import fs from "node:fs";
import { kitWallFindings, layKitWall, type V2 } from "./_kit-wall.mts";
import type { Screen } from "./_town-wall-rules.mts";

type Rec = { line: V2[]; closed: boolean; towers: number[]; gates: number[]; placements: { prefab: string; kind: string; position: number[]; yaw: number }[] };
type Ent = { tags?: string[]; components?: { transform?: { position?: number[]; rotation?: number[] }; prefab?: { prefabId?: string } } };

export function judgeKitCurtain(rec: Rec, sceneFile: string, tag: string, top: (prefab: string) => number, failures: string[]): { screens: Screen[]; walls: { id: string; points: V2[] }[]; gates: V2[] } {
  const lay = layKitWall(rec.line, { closed: rec.closed, towers: rec.towers, gates: rec.gates });
  for (const f of kitWallFindings(lay, { closed: rec.closed })) failures.push(`kit-joins: ${f}`);
  if (lay.pieces.length !== rec.placements.length) failures.push(`kit-record: the line re-lays as ${lay.pieces.length} pieces, the record holds ${rec.placements.length} (re-run town-wall-line kit)`);
  const scene = fs.existsSync(sceneFile) ? (JSON.parse(fs.readFileSync(sceneFile, "utf8")) as { entities: Record<string, Ent> }) : null;
  if (!scene) { failures.push(`kit-scene: no scene ${sceneFile}`); return { screens: [], walls: [], gates: [] }; }
  const placed = Object.entries(scene.entities).filter(([, e]) => e.tags?.includes(tag));
  const yawOf = (q?: number[]) => (q ? (2 * Math.atan2(q[1] ?? 0, q[3] ?? 1) * 180) / Math.PI : 0);
  const used = new Set<string>();
  const ys: number[] = [];
  let missing = 0;
  for (const p of rec.placements) {
    const hit = placed.find(([id, e]) => {
      if (used.has(id) || e.components?.prefab?.prefabId !== p.prefab) return false;
      const q = e.components?.transform?.position ?? [0, 0, 0];
      if (Math.hypot(q[0]! - p.position[0]!, q[2]! - p.position[2]!) > 0.02) return false;
      const dy = ((yawOf(e.components?.transform?.rotation) - p.yaw) % 360 + 540) % 360 - 180;
      return Math.abs(dy) <= 0.2;
    });
    if (!hit) { missing++; continue; }
    used.add(hit[0]);
    ys.push(hit[1].components!.transform!.position![1]!);
  }
  if (missing) failures.push(`kit-scene: ${missing} of ${rec.placements.length} curtain pieces are not in the scene as placed (tag ${tag}): re-install the curtain from the record`);
  const extra = placed.filter(([id]) => !used.has(id)).map(([id]) => id);
  if (extra.length) failures.push(`kit-scene: ${extra.length} entit(ies) tagged ${tag} are not pieces of the record (${extra.slice(0, 3).join(", ")})`);
  const y0 = ys.length ? Math.min(...ys) : 0, y1 = ys.length ? Math.max(...ys) : 0;
  if (ys.length && y1 - y0 > 0.02) failures.push(`kit-level: the curtain's pieces stand at ${y0.toFixed(2)}..${y1.toFixed(2)} m: kit pieces are flat, a step between neighbours is a hole (one level, or a stepped kit piece)`);
  const y = ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 0;
  // screens: every piece's centreline (its footprint's long axis) at its top
  const screens: Screen[] = [], walls: { id: string; points: V2[] }[] = [], gates: V2[] = [];
  lay.pieces.forEach((p, i) => {
    const c = Math.cos((p.yaw * Math.PI) / 180), s = Math.sin((p.yaw * Math.PI) / 180);
    const half = p.kind === "run" || p.kind === "infill" ? p.len! / 2 : p.kind === "tower" ? 2.6 : p.kind === "gate" ? 4.8 : 0.6;
    const a: V2 = [p.at[0] - half * c, p.at[1] + half * s], b: V2 = [p.at[0] + half * c, p.at[1] - half * s];
    const t = y + top(p.prefab);
    screens.push({ id: `kit-${i}-${p.prefab.split("/").pop()}`, profile: [[a[0], a[1], t], [b[0], b[1], t]] });
    if (p.kind === "gate") gates.push(p.at);
    else walls.push({ id: `kit-${i}-${p.prefab.split("/").pop()}`, points: [a, b] });
  });
  return { screens, walls, gates };
}
