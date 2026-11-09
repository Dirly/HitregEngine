import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOps, ComponentRegistry, registerCoreComponents, type SceneDoc } from "@hitreg/core";
import { baseOutline } from "../tools/_place-quality.mts";
import { columnBottom } from "../tools/_wall-seated.mts";
import { coverCells, isDressing, skirtClashes, SKIRT_PROUD_TRY, structureRows, townPieces, townSkirts, type TownLook } from "../tools/town-seated.mts";

type V3 = [number, number, number];
/** A closed box's triangles from (x0,y0,z0) to (x1,y1,z1). */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): { a: V3; b: V3; c: V3 }[] {
  const v = (i: number): V3 => [i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0];
  const faces = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  return faces.flatMap(([a, b, c, d]) => [{ a: v(a!), b: v(b!), c: v(c!) }, { a: v(a!), b: v(c!), c: v(d!) }]);
}
const lookOf = (models: Record<string, ReturnType<typeof box>>): TownLook => ({
  base: (p) => (models[p] ? baseOutline(models[p]!) : null),
  bottom: (p) => { const t = models[p]; if (!t) return null; const pos: number[] = [], idx: number[] = []; for (const x of t) for (const q of [x.a, x.b, x.c]) { idx.push(pos.length / 3); pos.push(...q); } return columnBottom(pos, idx); },
  hung: () => null,
  size: (p) => (p === "anvil" ? [1, 1, 0.7] : [4, 3, 4]),
});
const piece = (prefab: string, tags: string[], y = 0.6) => ({ name: prefab, parent: "root", tags: ["town:t", ...tags], components: { transform: { position: [10, y, 10] }, prefab: { prefabId: prefab, props: {}, overrides: [] } } });
const docOf = (ents: Record<string, unknown>): SceneDoc => ({ version: 1, name: "t", entities: { root: { name: "root", parent: null, tags: ["town:t"], components: { transform: {} } }, ...ents } } as never);
const flat = () => 0;

test("a slab standing 0.4 m over the ground fails; a plinth that runs into the ground passes (the chapel case)", () => {
  // slab: floor 0, underside -0.2, origin 0.6 over the ground -> 0.4 m daylight. plinth: the floor band at -0.2 but a
  // box down to -1.2 under it (a footing storey): its true bottom is in the ground
  const look = lookOf({ slab: box(-2, -0.2, -2, 2, 0, 2), plinth: [...box(-2, -0.2, -2, 2, 0, 2), ...box(-2, -1.2, -2, 2, -0.21, 2)] });
  const doc = docOf({ a: piece("slab", ["lot:a"]), b: piece("plinth", ["lot:b"]) });
  const rows = structureRows(doc, ["a", "b"], [], look, flat);
  assert.equal(rows.find((r) => r.id === "a")!.ok, false);
  assert.ok(Math.abs(rows.find((r) => r.id === "a")!.gap! - 0.4) < 0.01);
  assert.equal(rows.find((r) => r.id === "b")!.ok, true);
});

test("the skirts close the daylight by construction and are judged on their own bottom", () => {
  const look = lookOf({ slab: box(-2, -0.2, -2, 2, 0, 2) });
  const doc = docOf({ a: piece("slab", ["lot:a"]) });
  const { ops, rows } = townSkirts(doc, ["a"], look, flat, () => ({ material: "foundations/rubble", tile: 3.2, depth: 0.3 }));
  assert.equal(rows[0]!.skirts, 1);
  const reg = new ComponentRegistry(); registerCoreComponents(reg);
  const after = applyOps(structuredClone(doc), ops, reg).doc as SceneDoc;
  const parts = townPieces(after, "t", look);
  assert.deepEqual(parts.skirts, ["a--foundation"]);
  const r = structureRows(after, parts.structures, parts.skirts, look, flat);
  assert.ok(r.every((x) => x.ok), JSON.stringify(r));
  // a re-run replaces the skirt, never stacks a second
  const again = townSkirts(after, ["a"], look, flat, () => ({ material: "foundations/rubble", tile: 3.2, depth: 0.3 }));
  assert.equal(again.ops.filter((o) => o.op === "remove-entity").length, 1);
});

test("dressing goes to the float rule; lots and curtain pieces are structures", () => {
  assert.equal(isDressing(["square-dressing"], [6, 2, 2]), true);
  assert.equal(isDressing([], [1, 1, 0.7]), true);
  assert.equal(isDressing(["wall", "town-wall:t"], [1.7, 6, 2.5]), false);
  assert.equal(isDressing(["lot:a"], [1, 1, 1]), false);
});

test("coverCells covers a cell set with few rectangles and no cell twice", () => {
  const cells: [number, number][] = [];
  for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) cells.push([i * 0.5, j * 0.5]);
  cells.push([0, 2]); // a porch cell
  const r = coverCells(cells);
  assert.equal(r.length, 2);
  const area = r.reduce((n, q) => n + ((q.x1 - q.x0) / 0.5 + 1) * ((q.z1 - q.z0) / 0.5 + 1), 0);
  assert.equal(area, cells.length);
});

test("a skirt side never lies within 2.5 cm of a parallel wall face of its structure (k-town6 barracks plinth)", () => {
  // a plinth face at x = 1.17 (the default skirt side for cells to x = 1.0) clashes; the next offset clears it
  const walls = [{ axis: 0 as const, at: 1.17, s0: -2, s1: 2, y0: -0.6, y1: 0.2 }];
  assert.equal(skirtClashes([0, 0], [1 + SKIRT_PROUD_TRY[0]!, 1 + SKIRT_PROUD_TRY[0]!], -1, 0.05, walls), true);
  const ok = SKIRT_PROUD_TRY.find((p) => !skirtClashes([0, 0], [1 + p, 1 + p], -1, 0.05, walls));
  assert.equal(ok, 0.13);
  // a face above the skirt's band or beside its span is no clash
  assert.equal(skirtClashes([0, 0], [1.17, 1.17], -1, 0.05, [{ axis: 0, at: 1.17, s0: -2, s1: 2, y0: 0.5, y1: 2 }]), false);
  assert.equal(skirtClashes([0, 0], [1.17, 1.17], -1, 0.05, [{ axis: 0, at: 1.17, s0: 3, s1: 5, y0: -1, y1: 1 }]), false);
});
