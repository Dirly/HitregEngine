import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSceneScope, scopeStreamer } from "../src/scene-scope.ts";

test("scene scope: ?at= and ?streamRadius= parse; malformed values are ignored", () => {
  assert.deepEqual(parseSceneScope("?scene=skelmorrow&at=-2405.5,-999&streamRadius=200"), { at: { x: -2405.5, z: -999, y: null }, streamRadius: 200 });
  assert.deepEqual(parseSceneScope("at=10,20,35").at, { x: 10, z: 20, y: 35 });
  assert.deepEqual(parseSceneScope("?scene=x"), { at: null, streamRadius: null });
  assert.deepEqual(parseSceneScope("at=10&streamRadius=-5"), { at: null, streamRadius: null });
  assert.deepEqual(parseSceneScope("at=a,b&streamRadius=abc"), { at: null, streamRadius: null });
});

test("scene scope: every ring clamped to the radius in cells, at least one; no radius = unchanged", () => {
  const s = { source: "w", cellSize: 48, radius: 2, keepPadding: 1, hlodSupercellFactor: 4, rings: { simulation: 2, fullRender: 3, hlod: 10, farTerrain: 32 } };
  assert.deepEqual(scopeStreamer(s, 200)!.rings, { simulation: 2, fullRender: 3, hlod: 5, farTerrain: 5 });
  assert.deepEqual(scopeStreamer(s, 10)!.rings, { simulation: 1, fullRender: 1, hlod: 1, farTerrain: 1 });
  assert.equal(scopeStreamer(s, null), s);
  assert.equal(scopeStreamer(null, 200), null);
  assert.equal(scopeStreamer({ ...s, rings: undefined }, 48)!.radius, 1);
});
