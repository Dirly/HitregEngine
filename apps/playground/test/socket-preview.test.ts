import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { createScene, type SceneDoc } from "@hitreg/core";
import { createSocketPreview } from "../src/socket-preview.js";

function fixture(mask: number, equipment = false, fixed = "") {
  const doc = createScene("socket-preview");
  const carrier = new THREE.Group();
  const head = new THREE.Bone(); head.name = "CC_Base_Head"; head.position.set(0, 1.3, 0); carrier.add(head);
  const hair = new THREE.Group(); carrier.add(hair);
  const socket = {
    name: "Socket", parent: "actor", tags: [],
    components: {
      mesh: { source: { kind: "asset", assetId: "hair.glb", partMask: mask } },
      script: { name: "bone-socket", params: { bone: head.name, offset: [0, .1, 0], rotationDeg: [0, 0, 0] } },
    },
  };
  doc.entities.socket = socket as SceneDoc["entities"][string];
  if (equipment) doc.entities.look = {
    name: "Equipment look", parent: "socket", tags: [],
    components: { script: { name: "equipment-look", params: { actor: "actor", item: fixed } } },
  } as SceneDoc["entities"][string];
  let currentMask = mask;
  const sent: unknown[] = [];
  const preview = createSocketPreview({
    doc: () => doc, objectOf: (id) => id === "socket" ? hair : undefined,
    dragging: () => [], showAlt: () => false, selected: () => null,
    item: (id) => id === "fixed-hair" ? { appearance: { model: "hair.glb", parts: ["HairBase1"], texture: "grey.png" } } : undefined,
    itemOfModel: () => undefined, handleOf: () => null,
    setLook: (_id, look) => { sent.push(look); if (look.partMask !== undefined) currentMask = look.partMask; },
  });
  return { preview, hair, sent, mask: () => currentMask };
}

for (const mask of [1, 4]) test(`plain socket keeps authored hair mask ${mask} when Edit hands off to Play`, () => {
  const f = fixture(mask);
  f.preview.update();
  assert.ok(f.hair.position.distanceTo(new THREE.Vector3(0, 1.4, 0)) < 1e-10, "plain attachment still follows its head socket");
  assert.equal(f.mask(), mask);
  assert.deepEqual(f.sent, [], "Edit must not cache an empty equipment-slot look on authored hair");
  f.preview.reset(); // The host calls reset on leaving Edit; bone-socket then owns placement in Play.
  assert.equal(f.mask(), mask, "the existing runtime look handed to Play remains authored");
});

test("an empty equipment-look socket still hides its weapon", () => {
  const f = fixture(1, true);
  f.preview.update();
  assert.equal(f.mask(), 0);
  assert.deepEqual(f.sent, [{ partMask: 0, glow: null, effects: [] }]);
});

test("a fixed equipment-look item previews without a character sheet", () => {
  const f = fixture(0, true, "fixed-hair");
  f.preview.update();
  assert.deepEqual(f.sent, [{ parts: ["HairBase1"], texture: "grey.png", glow: null, effects: [] }]);
});
