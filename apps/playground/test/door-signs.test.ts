import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { doorSignAnchors, postAnchors, POST_FROM_EDGE } from "../tools/_door-signs.mts";
import { kitDoor, applyMarkers } from "../tools/dress-sockets.mts";

test("a door-sign anchor is the building's own sign bracket carried into the world by its lot (yaw + preRot)", () => {
  const bracket = [{ kind: "door-side", position: [1, 1.9, 4] as [number, number, number], yaw: 0, mount: "wall" }, { kind: "sign-bracket", position: [0, 2.6, 4] as [number, number, number], yaw: 0, mount: "wall" }];
  const { anchors: all, skipped } = doorSignAnchors(
    [
      { id: "inn", model: "inn", centre: [10, 20], groundY: 5, yaw: 0 },
      { id: "forge", model: "inn", centre: [0, 0], groundY: 1, yaw: Math.PI / 2, preRot: Math.PI / 2 },
      { id: "shed", model: "shed", centre: [0, 0], groundY: 0 },
      { id: "hut", model: "hut", centre: [0, 0], groundY: 0 },
    ],
    (m) => (m === "inn" ? bracket : m === "hut" ? [] : undefined),
  );
  const anchors = all.filter((a) => a.kind !== "door-sign-post"); // the post anchors: their own test
  assert.deepEqual(anchors[0], { id: "door-sign-inn", kind: "door-sign", level: 0, position: [10, 7.6, 24], yaw: 0, mount: "wall", outdoor: true });
  // turned half way round: the bracket 4 m in front of the centre lands 4 m behind it, facing the other way
  assert.deepEqual(anchors[1]!.position, [0, 3.6, -4]);
  assert.equal(Math.abs(anchors[1]!.yaw), 180);
  assert.equal(anchors.length, 2);
  assert.deepEqual(skipped, ["shed (no socket map for shed)", "hut (its socket map has no sign-bracket anchor)"]);
});

test("the sign bracket's clear size and the building's windows ride into the exterior map", () => {
  const list = [
    { kind: "sign-bracket", position: [0, 2.6, 4] as [number, number, number], yaw: 0, mount: "wall", size: [1.2, 1.4, 1] as [number, number, number] },
    { id: "window-4", kind: "window", level: 1, position: [3, 5, 4] as [number, number, number], yaw: 0, mount: "wall", size: [1, 1.4, 0.1] as [number, number, number] },
  ];
  const { anchors } = doorSignAnchors([{ id: "inn", model: "inn", centre: [10, 20], groundY: 5, yaw: 0 }], () => list);
  assert.deepEqual(anchors[0]!.size, [1.2, 1.4, 1]);
  assert.deepEqual(anchors[1], { id: "window-inn-window-4", kind: "window", level: 0, position: [13, 10, 24], yaw: 0, mount: "wall", outdoor: true, size: [1, 1.4, 0.1] });
});

test("dress sockets takes the building's door from the kit manifest beside the model, not the widest wall gap", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kitdoor-"));
  try {
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ models: { inn: { door: { position: [-1.6, 0, 6.4], facing: [0, 1] } }, shed: {} } }));
    const k = kitDoor(path.join(dir, "inn.glb"));
    assert.deepEqual(k && { door: k.door, out: k.out }, { door: [-1.6, 6.4], out: [0, 1] });
    assert.equal(kitDoor(path.join(dir, "shed.glb")), null);
    assert.equal(kitDoor(path.join(os.tmpdir(), "no-such-dir-xyz", "inn.glb")), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("window markers become window anchors with the opening's [w, h, depth]", () => {
  const map = { id: "m", levels: [], anchors: [] } as unknown as Parameters<typeof applyMarkers>[0];
  applyMarkers(map, [{ id: "window-1", kind: "window", level: 0, position: [4.8, 1.8, 6.2], yaw: 0, size: [1, 0, 1.4] }]);
  assert.deepEqual(map.anchors[0], { id: "window-1", kind: "window", level: 0, position: [4.8, 1.8, 6.2], yaw: 0, mount: "wall", outdoor: true, size: [1, 1.4, 0.1] });
});

test("an open nave's high window belongs to its existing floor, while real upper-floor windows keep their level", () => {
  const map = { id: "nave", levels: [{ level: 0, floorY: 0 }], anchors: [] } as unknown as Parameters<typeof applyMarkers>[0];
  applyMarkers(map, [{ id: "lancet", kind: "window", level: 3, position: [6.2, 9.88, -2], yaw: 90, size: [1.4, 0, 4] }]);
  assert.equal(map.anchors[0]!.level, 0);
  assert.deepEqual(map.anchors[0]!.position, [6.2, 9.88, -2]);
  map.levels.push({ level: 1, floorY: 3.2 } as typeof map.levels[number]);
  applyMarkers(map, [{ id: "bedroom", kind: "window", level: 1, position: [3, 5, 4], yaw: 0 }]);
  assert.equal(map.anchors[1]!.level, 1);
});

test("beside-the-door brackets ride along as door-sign-<lot>-l / -r with their preferred height and clear size", () => {
  const list = [
    { kind: "sign-bracket", position: [0, 2.6, 4] as [number, number, number], yaw: 0, mount: "wall", size: [1.2, 0.2, 1] as [number, number, number] },
    { id: "sign-beside-l", kind: "sign-beside", position: [-1, 2.1, 4] as [number, number, number], yaw: 0, mount: "wall", prefer: 0.2, size: [0.2, 1.5, 1.3] as [number, number, number] },
  ];
  const { anchors } = doorSignAnchors([{ id: "forge", model: "forge", centre: [0, 0], groundY: 1, yaw: 0 }], () => list);
  assert.deepEqual(anchors[1], { id: "door-sign-forge-l", kind: "door-sign-beside", level: 0, position: [-1, 3.1, 4], yaw: 0, mount: "wall", outdoor: true, size: [0.2, 1.5, 1.3], prefer: 0.2 });
});

test("sign-post anchors stand 1.0-1.5 m beside the door edge on the floor, only on a window-free side", () => {
  const door = { position: [0, 2.6, 4] as [number, number, number], yaw: 0, size: [1.2, 1.4, 1] as [number, number, number] };
  const both = postAnchors("smithy", door, [], 0);
  assert.deepEqual(both.map((a) => a.id), ["door-sign-smithy-post-l", "door-sign-smithy-post-r"]);
  for (const a of both) {
    assert.equal(a.mount, "floor"); assert.equal(a.kind, "door-sign-post"); assert.equal(a.position[1], 0);
    const edge = Math.abs(a.position[0]) - 0.6;
    assert.ok(edge >= 1 && edge <= 1.5 && Math.abs(edge - POST_FROM_EDGE) < 0.01);
    assert.ok(a.position[2] > 4, "out from the wall");
  }
  // a ground-floor window right of the door blocks that side; an upper-floor one does not
  const win = { position: [2, 1.5, 4] as [number, number, number], yaw: 0, size: [1, 1.2, 0.1] as [number, number, number] };
  assert.deepEqual(postAnchors("smithy", door, [win], 0).map((a) => a.id.slice(-1)).sort(), [both[0]!.position[0] < 0 ? "l" : "r"]);
  assert.equal(postAnchors("smithy", door, [{ ...win, position: [2, 5, 4] }], 0).length, 2);
});
