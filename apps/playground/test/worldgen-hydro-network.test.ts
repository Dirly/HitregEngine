import { test } from "node:test";
import assert from "node:assert/strict";
import { adoptDroppedParents, joinParentHeadLake, loopsBackToLake, runGradeNeed, splitClearOfLakes, type Channel } from "../tools/worldgen-hydrology.mts";

/**
 * The rivers stage's network rules from the 2026-10-29 hydrology round (w2-hydro, redstrand dogfood), on small
 * fixtures: a lake's river joining a channel the lake-head rule drops carries on down it instead of dangling; the
 * water grade is measured from every lake on the river, not only as the whole length's average.
 */

test("a lake's river adopts the dropped channel it joins, down to the sea", () => {
  // channel 0: the main stem to the sea (cells 0..9, mouth 9 = sea), no lake on it -> dropped by the lake-head rule
  // channel 1: a lake's outlet (cells 20..24, lake cell 20) joining channel 0 at cell 4
  // channel 2: another lake's outlet (cells 30..33, lake cell 30) joining channel 0 at cell 6 (below channel 1's join)
  const channels: Channel[] = [
    { cells: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], size: 100, joins: -1 },
    { cells: [20, 21, 22, 23, 4], size: 40, joins: 0 },
    { cells: [30, 31, 32, 6], size: 30, joins: 0 },
  ];
  const lake = new Set([20, 30]);
  const n = adoptDroppedParents(channels, (c) => lake.has(c));
  assert.equal(n, 1);
  // the bigger outlet carries on to the sea
  assert.deepEqual(channels[1]!.cells, [20, 21, 22, 23, 4, 5, 6, 7, 8, 9]);
  assert.equal(channels[1]!.joins, -1);
  // the second already ends on an adopted cell: it joins the adopter there
  assert.deepEqual(channels[2]!.cells, [30, 31, 32, 6]);
  assert.equal(channels[2]!.joins, 1);
});

test("a channel joining a KEPT channel is left alone", () => {
  const channels: Channel[] = [
    { cells: [0, 1, 2, 3], size: 100, joins: -1 },
    { cells: [10, 11, 2], size: 20, joins: 0 },
  ];
  const lake = new Set([1, 10]);
  assert.equal(adoptDroppedParents(channels, (c) => lake.has(c)), 0);
  assert.deepEqual(channels[1]!.cells, [10, 11, 2]);
  assert.equal(channels[1]!.joins, 0);
});

test("the run grade is measured from the lake, not only averaged over the river", () => {
  // a lake reach at 48 (points 0-2), then 9 m lost in 120 m below it, a gentle lowland, and the river's one fall
  // (15 m in 30 m) far downstream
  const along = [0, 20, 40, 70, 100, 130, 160, 400, 700, 730, 1000, 1300];
  const level = [48, 48, 48, 46, 43, 41, 39, 33, 28, 13, 9, 5];
  const anchor = level.map((_, j) => j <= 2);
  const need = runGradeNeed(level, along, anchor, 60, 60);
  // the whole-length average outside the fall is (43 - 15) / 1300 = 2.2 %; the run below the lake needs
  // (48 - 43) / 60 = 8.3 % over its steepest 60 m (the fall is not between them, so no credit)
  assert.ok(Math.abs(need - 5 / 60) < 1e-9, `need ${need}`);
});

test("a split-fall branch keeps two banks clear of every lake (2026-10-29 w3-hydro)", () => {
  const lake = { center: [0, 0] as [number, number], radius: 50, bank: 16, polygon: [[-50, -50], [50, -50], [50, 50], [-50, 50]] as [number, number][] };
  // redstrand 2029: the branch left its river at the lake's shore (the head 5 m off the outline) and hung the sheet
  const atShore: [number, number][] = [[55, 0], [80, 10], [120, 20], [160, 0]];
  assert.equal(splitClearOfLakes(atShore, [lake]), false);
  // inside the outline too
  assert.equal(splitClearOfLakes([[10, 0], [120, 0], [200, 0]], [lake]), false);
  // the mouth may rejoin below anywhere; the rest 2 banks (32 m) off is clear
  assert.equal(splitClearOfLakes([[90, 0], [150, 10], [55, 0]], [lake]), true);
  assert.equal(splitClearOfLakes([[80, 0], [150, 10], [200, 0]], [lake]), false);
  assert.equal(splitClearOfLakes([[83, 0], [150, 10], [200, 0]], [lake]), true);
});

test("a lake's river joining a kept river ABOVE that river's first lake ends in that lake (2026-10-29 w3-hydro)", () => {
  // channel 0: the parent, cells 0..9 to the sea; its first lake is cells 6..7 (the rivers stage starts it at 6)
  // channel 1: a tributary through its own lake (cell 21), joining the parent at cell 3 — above the parent's lake
  const lakeCells = new Set([6, 7, 21]);
  const channels: Channel[] = [
    { cells: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], size: 100, joins: -1 },
    { cells: [20, 21, 22, 3], size: 30, joins: 0 },
    // one joining BELOW the parent's lake is left alone
    { cells: [30, 31, 21, 8], size: 10, joins: 0 },
  ];
  const n = joinParentHeadLake(channels, (c) => lakeCells.has(c));
  assert.equal(n, 1);
  assert.deepEqual(channels[1]!.cells, [20, 21, 22, 3, 4, 5, 6]);
  assert.deepEqual(channels[2]!.cells, [30, 31, 21, 8]);
});

test("a river out of a lake and back into it is the lake's arm, not a river (2026-10-29 w3-hydro)", () => {
  // basin 4: water cells 1, 2; its dry bowl cell 9. Basin 5: water cell 7.
  const wet = new Map([[1, 4], [2, 4], [7, 5]]);
  const bowl = new Map([[1, 4], [2, 4], [9, 4], [7, 5]]);
  const wetOf = (c: number): number => wet.get(c) ?? -1;
  const bowlOf = (c: number): number => bowl.get(c) ?? -1;
  // redstrand 3241 river-5: out of lake-1, round a headland, back to its shore (here its dry bowl)
  assert.equal(loopsBackToLake([1, 30, 31, 32, 9], wetOf, bowlOf), true);
  assert.equal(loopsBackToLake([1, 30, 31, 2], wetOf, bowlOf), true);
  // into ANOTHER lake, or on to the sea: a river
  assert.equal(loopsBackToLake([1, 30, 31, 7], wetOf, bowlOf), false);
  assert.equal(loopsBackToLake([1, 30, 31, 40], wetOf, bowlOf), false);
  // not from a lake at all: not this rule's
  assert.equal(loopsBackToLake([30, 31, 2], wetOf, bowlOf), false);
});
