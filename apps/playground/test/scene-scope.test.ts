import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSceneScope, playerFraming, scopeStreamer } from "../src/scene-scope.ts";

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

test("the editor opens behind the player, looking along its facing; no player = null", () => {
  const s = Math.SQRT1_2;
  // facing +X (yaw 90 deg about Y): the eye 8 m to -X, 4 m up; looking at the player + 1 m
  const f = playerFraming({ entities: { p: { parent: null, tags: ["player"], components: { transform: { position: [10, 50, 20], rotation: [0, s, 0, s] } } } } })!;
  assert.ok(Math.abs(f.eye.x - 2) < 1e-9 && Math.abs(f.eye.z - 20) < 1e-9 && f.eye.y === 54, JSON.stringify(f));
  assert.deepEqual(f.target, { x: 10, y: 51, z: 20 });
  // no rotation: facing +Z
  assert.deepEqual(playerFraming({ entities: { p: { tags: ["player"], components: { transform: { position: [0, 0, 0] } } } } })!.eye, { x: 0, y: 4, z: -8 });
  // a child tagged player (a prefab part) or no transform does not count
  assert.equal(playerFraming({ entities: { p: { parent: "x", tags: ["player"], components: { transform: { position: [1, 2, 3] } } } } }), null);
  assert.equal(playerFraming({ entities: { p: { parent: null, tags: ["player"], components: {} } } }), null);
});
