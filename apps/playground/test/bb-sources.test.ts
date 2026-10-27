import { test } from "node:test";
import assert from "node:assert/strict";
import { bbUnits, rowCoverage, uncutUnits } from "../tools/_bb-sources.mts";

// a Dungeon.bbmodel in miniature: the pike group holds a lone Skull; a lantern group is generic geometry only
const bb = {
  elements: [
    { uuid: "e1", name: "PikeSkull" }, { uuid: "e2", name: "Skull" }, { uuid: "e3", name: "mesh" },
    { uuid: "e4", name: "mesh" }, { uuid: "e5", name: "SkullCandle" }, { uuid: "e6", name: "StoneGroundBrazer" },
  ],
  groups: [{ uuid: "g1", name: "headOnPike" }, { uuid: "g2", name: "StreetLantern" }],
  outliner: [
    { uuid: "g1", children: ["e1", "e2", "e3"] },
    { uuid: "g2", children: ["e4"] },
    "e5", "e6",
  ],
};

test("a lone element inside a group whose sibling was cut is listed (the Skull case)", () => {
  const units = bbUnits(bb);
  const covered = new Set(["pikeskull", "stonegroundbrazer"]);
  const names = uncutUnits(units, covered).map((u) => u.name);
  assert.ok(names.includes("Skull"));
  assert.ok(names.includes("SkullCandle"));
  assert.ok(names.includes("StreetLantern"), "a generic-only group is one unit");
  assert.ok(!names.includes("headOnPike"), "a container group is not a unit");
  assert.ok(!names.includes("mesh"));
});

test("catalog rows cover by sourceElement and by the tool's --element", () => {
  const rows = [
    { id: "poi-props/skull", sourceModel: "source/blockbench/Dungeon.bbmodel", sourceElement: "Skull" },
    { id: "poi-props/skull-candle", tool: "node tools/bbmodel-export.mjs projects/world-kit/source/blockbench/Dungeon.bbmodel --element SkullCandle --out x.glb" },
    { id: "other", sourceModel: "Master.bbmodel", sourceElement: "StreetLantern" },
  ];
  const cov = new Set([...rowCoverage(rows, "Dungeon.bbmodel"), "pikeskull", "stonegroundbrazer"].map((n) => n.toLowerCase()));
  assert.deepEqual(uncutUnits(bbUnits(bb), cov).map((u) => u.name), ["StreetLantern"]);
});

test("a covered group covers everything inside it", () => {
  assert.deepEqual(uncutUnits(bbUnits(bb), new Set(["headonpike", "streetlantern", "skullcandle", "stonegroundbrazer"])), []);
});
