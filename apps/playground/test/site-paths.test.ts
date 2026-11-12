import { test } from "node:test";
import assert from "node:assert/strict";
import { keepSitePaths, pathEnds, strandedSitePaths } from "../tools/_site-paths.mts";

// t2-town 2026-11-12: a plain `worldgen paths` run for a new town (town-2) deleted the seven site links an earlier
// `--to` run had cut (red-dial / weeping-sun), and every place on them went STALE. The stage keeps them now.

const towns = ["town-1", "town-2"];

test("path ids split into their two ends: towns by recipe id, sites as site-<name>, piece suffixes ignored", () => {
  assert.deepEqual(pathEnds("path-town-1-site-red-dial", towns), ["town-1", "site-red-dial"]);
  assert.deepEqual(pathEnds("path-town-1-site-red-dial-north.s2", towns), ["town-1", "site-red-dial-north"]);
  assert.deepEqual(pathEnds("path-site-red-dial-site-weeping-sun.s3", towns), ["site-red-dial", "site-weeping-sun"]);
  assert.deepEqual(pathEnds("path-town-1-town-2", towns), ["town-1", "town-2"]);
  assert.equal(pathEnds("road-moon", towns), null);
});

const road = (id: string, pts: number[][] = [[0, 0], [100, 0]]) => ({ id, points: pts });

test("a plain run keeps every site path and re-cuts the town links", () => {
  const roads = [road("path-town-1-site-red-dial"), road("path-site-red-dial-site-weeping-sun.s2"), road("path-town-1-town-2")];
  const pick = keepSitePaths(roads, towns, new Set());
  assert.deepEqual(pick.keep.map((r) => r.id), ["path-town-1-site-red-dial", "path-site-red-dial-site-weeping-sun.s2"]);
  assert.equal(pick.drop.length, 0);
});

test("a site named again by --to is re-cut; a site path whose town left the recipe goes", () => {
  const roads = [road("path-town-1-site-red-dial"), road("path-town-1-site-red-dial-north"), road("path-town-9-site-old")];
  const pick = keepSitePaths(roads, towns, new Set(["site-red-dial"]));
  assert.deepEqual(pick.keep.map((r) => r.id), ["path-town-1-site-red-dial-north"]);
  assert.deepEqual(pick.drop.map((d) => d.id).sort(), ["path-town-1-site-red-dial", "path-town-9-site-old"]);
});

test("after routing a kept path that meets nothing at either end (its gate moved) is dropped; one on the network stays", () => {
  const onNet = road("path-town-1-site-a", [[100, 0], [500, 300]]); // starts on the network road below
  const piece = road("path-town-1-site-a.s2", [[500, 300], [900, 300]]); // a piece of the same link
  const lost = road("path-town-1-site-b", [[2000, 2000], [2400, 2000]]); // its gate end was at a gate that moved
  const network = [road("path-town-1-town-2", [[0, 0], [300, 0]]), onNet, piece, lost];
  const res = strandedSitePaths([onNet, piece, lost], network, [[0, 0]]);
  assert.deepEqual(res.keep.map((r) => r.id), ["path-town-1-site-a", "path-town-1-site-a.s2"]);
  assert.deepEqual(res.drop.map((d) => d.id), ["path-town-1-site-b"]);
});
