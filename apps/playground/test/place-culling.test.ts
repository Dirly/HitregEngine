import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import type { SceneDoc } from "@hitreg/core";
import { CullingSystem, cullRootsOf, registerCullRoots } from "@hitreg/render";
import { hierarchyVisible } from "../../../packages/render/src/cull-visibility.js";
import { placeContainerVisible, placeCullObjects, placeInteriorRoot } from "../src/place-streamer.js";

function roomDoc(): SceneDoc {
  return { version: 1, name: "room", entities: {
    room: { name: "Room", parent: null, tags: [], components: {
      culling: { interior: true, reveal: 12, occlusion: false, minScreenPx: 0 },
    } },
    chair: { name: "Chair", parent: "room", tags: [], components: {} },
  } };
}

describe("streamed room container culling", () => {
  it("blocks late children before mesh adoption and restores authored visibility on release", () => {
    const doc = roomDoc();
    const container = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    container.add(mesh);
    const system = new CullingSystem();
    const [unit] = registerCullRoots(system, cullRootsOf(doc), new Map([["room", container]]), null);
    assert.equal(placeInteriorRoot(doc), "room");
    unit!.gateRootVisibility(container, () => placeContainerVisible(doc));
    assert.equal(container.visible, false); // no first cull verdict yet
    // Keep this room out of the two-units-per-frame rescan for several frames.
    for (let i = 0; i < 20; i++) system.register({ name: `other-${i}`, objects: [new THREE.Group()], occlusion: false });
    const camera = new THREE.PerspectiveCamera();
    camera.position.z = 40;
    system.update(camera, 720);

    const late = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    container.add(late);
    system.update(camera, 720);
    assert.equal(late.layers.mask, 1); // deliberately not adopted yet
    const projected: THREE.Object3D[] = [];
    container.traverseVisible((object) => projected.push(object));
    assert.equal(projected.includes(late), false); // Three's traversal skips the entire room

    camera.position.z = 3;
    system.update(camera, 720);
    assert.equal(container.visible, true);
    assert.equal(late.layers.mask, 1);
    doc.entities["room"]!.components["visibility"] = { visible: false };
    system.update(camera, 720); // same SHOWN verdict must still respect an author edit
    assert.equal(container.visible, false);
    system.unregister(unit!);
    assert.equal(container.visible, false);
    delete doc.entities["room"]!.components["visibility"];
    const again = system.register({ name: "room", objects: [container], interior: true, reveal: 12, occlusion: false });
    again.gateRootVisibility(container, () => placeContainerVisible(doc));
    camera.position.z = 40;
    system.update(camera, 720);
    assert.equal(container.visible, false);
    system.unregister(again);
    assert.equal(container.visible, true);
    system.clear();
  });

  it("holds an empty room until it has bounds and keeps occluded shadow-layer traversal", () => {
    const container = new THREE.Group();
    const system = new CullingSystem();
    const unit = system.register({ name: "room", objects: [container], interior: true, reveal: 12, occlusion: false });
    unit.gateRootVisibility(container, () => true);
    const camera = new THREE.PerspectiveCamera();
    system.update(camera, 720);
    assert.equal(container.visible, false);
    const late = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    container.add(late);
    assert.equal(container.visible, false);
    system.update(camera, 720);
    assert.equal(container.visible, true);
    unit.occluded = true; // occlusion:false preserves the verdict, without terrain setup
    system.update(camera, 720);
    assert.equal(container.visible, true); // shadows must still traverse the container
    assert.notEqual(late.layers.mask, 0);
    assert.equal(late.layers.mask & 1, 0); // main-camera layer remains hidden
    system.unregister(unit);
    assert.equal(late.layers.mask, 1);
    assert.equal(container.visible, true);
  });

  it("hides scene-anchored batches and effects with the single root's effective visibility", () => {
    const doc = roomDoc();
    const container = new THREE.Group();
    const room = new THREE.Group();
    const light = new THREE.PointLight();
    const effect = new THREE.Group();
    room.add(light, effect);
    container.add(room);
    const batch = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 1);
    batch.setMatrixAt(0, new THREE.Matrix4());
    container.add(batch);

    doc.entities["room"]!.components["visibility"] = { visible: false };
    room.visible = false;
    container.visible = placeContainerVisible(doc);
    assert.equal(hierarchyVisible(batch), false);
    assert.equal(hierarchyVisible(light), false);
    assert.equal(hierarchyVisible(effect), false);

    delete doc.entities["room"]!.components["visibility"];
    room.visible = true;
    container.visible = placeContainerVisible(doc);
    assert.equal(hierarchyVisible(batch), true);
    assert.equal(hierarchyVisible(light), true);
    assert.equal(hierarchyVisible(effect), true);
  });

  it("preserves the actual map for outdoor places and multiple-root documents", () => {
    const doc = roomDoc();
    const objects = new Map([["room", new THREE.Group()]]);
    const outdoor = structuredClone(doc);
    outdoor.entities["room"]!.components = {};
    assert.equal(placeCullObjects(outdoor, objects, new THREE.Group()), objects);
    const multiple = structuredClone(doc);
    multiple.entities["other"] = { name: "Other", parent: null, tags: [], components: {} };
    assert.equal(placeCullObjects(multiple, objects, new THREE.Group()), objects);
  });

  it("one existing room unit gates ordinary meshes, instanced siblings, lights and effects", () => {
    const doc = roomDoc();
    const container = new THREE.Group();
    const room = new THREE.Group();
    const chair = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    chair.add(mesh);
    room.add(chair);
    container.add(room);
    const instanced = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 1);
    instanced.setMatrixAt(0, new THREE.Matrix4());
    container.add(instanced);
    const light = new THREE.PointLight();
    const effect = new THREE.Group();
    room.add(light, effect);
    const objects = new Map<string, THREE.Object3D>([["room", room], ["chair", chair]]);
    const aliases = placeCullObjects(doc, objects, container);
    assert.equal(objects.get("room"), room);
    assert.equal(aliases.get("room"), container);
    assert.equal(aliases.get("chair"), chair);

    const system = new CullingSystem();
    const units = registerCullRoots(system, cullRootsOf(doc), aliases, null);
    assert.equal(units.length, 1);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.set(0, 0, 40);
    system.update(camera, 720);
    assert.equal(system.stats().units, 1);
    assert.equal(mesh.layers.mask, 0);
    assert.equal(instanced.layers.mask, 0);
    assert.equal(hierarchyVisible(light), false);
    assert.equal(hierarchyVisible(effect), false);

    // A batch arriving after registration follows the same unit during rescan.
    const late = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 1);
    late.setMatrixAt(0, new THREE.Matrix4());
    container.add(late);
    system.update(camera, 720);
    assert.equal(late.layers.mask, 0);

    camera.position.set(0, 0, 3);
    system.update(camera, 720);
    assert.equal(mesh.layers.mask, 1);
    assert.equal(instanced.layers.mask, 1);
    assert.equal(late.layers.mask, 1);
    assert.equal(hierarchyVisible(light), true);
    assert.equal(hierarchyVisible(effect), true);

    camera.position.set(0, 0, 40);
    system.update(camera, 720);
    system.unregister(units[0]!);
    assert.equal(instanced.layers.mask, 1);
    assert.equal(hierarchyVisible(light), true);
  });
});
