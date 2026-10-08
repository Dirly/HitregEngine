import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LAYERS, LAYERS, PIN_LABEL_MAX, PLAYER_LAYERS } from "../src/map-layers.js";
import { cleanPins, loadPins, PIN_LIMIT, pinStorageKey, savePins } from "../src/map-pins.js";

test("a player's map is towns, roads and zones only; the review default keeps every non-dev layer", () => {
  assert.deepEqual([...PLAYER_LAYERS].sort(), ["labels", "roads", "towns", "zones"]);
  for (const hidden of ["places", "dungeons", "quests", "spawns", "packs", "reservations", "sites"] as const) assert.ok(!PLAYER_LAYERS.has(hidden), hidden);
  // zonegen map (agents judging placement) is not reduced
  for (const l of LAYERS.filter((l) => !l.dev)) assert.ok(DEFAULT_LAYERS.has(l.id), l.id);
});

test("stored pins are cleaned: bad positions dropped, unknown shapes become pins, labels trimmed and capped", () => {
  const pins = cleanPins([
    { id: "a", x: 1, z: 2, shape: "star", label: "  Ore vein  " },
    { id: "b", x: Number.NaN, z: 0, shape: "pin", label: "" },
    { id: "a", x: 5, z: 6, shape: "skull", label: "x".repeat(80) + "\u0007" },
    "junk",
    { x: 9, z: 9 },
  ]);
  assert.equal(pins.length, 3);
  assert.deepEqual(pins[0], { id: "a", x: 1, z: 2, shape: "star", label: "Ore vein" });
  assert.notEqual(pins[1]!.id, "a", "duplicate id gets a fresh one");
  assert.equal(pins[1]!.shape, "pin");
  assert.equal(pins[1]!.label.length, PIN_LABEL_MAX);
  assert.equal(pins[2]!.label, "");
  assert.equal(cleanPins({ not: "an array" }).length, 0);
  assert.equal(cleanPins(Array.from({ length: PIN_LIMIT + 20 }, (_, i) => ({ x: i, z: i }))).length, PIN_LIMIT);
});

test("pins persist per character and world, and survive storage that throws", () => {
  const store = new Map<string, string>();
  const g = globalThis as { localStorage?: unknown };
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  try {
    savePins("char-1", "mmo", [{ id: "p", x: 1, z: 2, shape: "flag", label: "Meet" },
      ...(["dungeon", "mob", "camp", "resource"] as const).map((shape, i) => ({ id: shape, x: i + 10, z: -(i + 1), shape, label: `${shape} landmark` })),
    ]);
    assert.ok(store.has(pinStorageKey("char-1", "mmo")));
    const restored = loadPins("char-1", "mmo");
    assert.equal(restored[0]!.label, "Meet", "legacy markers remain compatible");
    assert.deepEqual(restored.slice(1).map(({ shape, label, x, z }) => ({ shape, label, x, z })),
      ["dungeon", "mob", "camp", "resource"].map((shape, i) => ({ shape, label: `${shape} landmark`, x: i + 10, z: -(i + 1) })));
    assert.equal(loadPins("char-2", "mmo").length, 0, "another character has its own markers");
    assert.equal(loadPins("char-1", "other").length, 0, "another world has its own markers");
    savePins("char-1", "mmo", []);
    assert.ok(!store.has(pinStorageKey("char-1", "mmo")));
    g.localStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    assert.deepEqual(loadPins("char-1", "mmo"), []);
    savePins("char-1", "mmo", [{ id: "p", x: 1, z: 2, shape: "pin", label: "" }]);
  } finally {
    delete g.localStorage;
  }
});
