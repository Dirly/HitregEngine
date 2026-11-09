import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { worldTransforms, type SceneDoc } from "@hitreg/core";
import { PlaceStreamer } from "../src/place-streamer.js";

const t = (x: number, z: number) => ({ transform: { position: [x, 0, z], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } });
const world = (n: number): SceneDoc => {
  const entities: Record<string, unknown> = { ground: { name: "g", parent: null, components: {} } };
  for (let i = 0; i < n; i++) {
    entities[`poi-${i}`] = { name: `p${i}`, parent: null, tags: ["poi"], components: t(i * 1000, 0) };
    entities[`poi-${i}-hut`] = { name: "hut", parent: `poi-${i}`, components: t(5, 0) };
  }
  return { version: 1, name: "w", entities } as unknown as SceneDoc;
};

function harness(mode: "stream" | "all" | "none" = "stream", cost = 0) {
  let clock = 0;
  const built = new Set<string>();
  const log: string[] = [];
  const streamer = new PlaceStreamer<string>({
    build: (id, doc) => {
      clock += cost;
      built.add(id);
      log.push(`+${id}:${Object.keys(doc.entities).length}`);
      return id;
    },
    free: (id) => {
      built.delete(id);
      log.push(`-${id}`);
    },
    now: () => clock,
  }, mode);
  return { streamer, built, log };
}

describe("PlaceStreamer", () => {
  it("reconciles effective visibility when an authored ancestor hides or reveals detached roots", () => {
    const doc = world(1);
    doc.entities["building"] = { name: "Building", parent: "poi-0", tags: [], components: t(0, 0) } as never;
    doc.entities["room"] = { name: "Room", parent: "building", tags: [], components: {
      ...t(0, 0), placeStream: { distance: 32 },
    } } as never;
    doc.entities["landmark"] = { name: "Landmark", parent: "building", tags: [], components: {
      ...t(0, 0), landmark: {},
    } } as never;
    const { streamer } = harness();
    streamer.plan(doc); streamer.update(0, 0); streamer.attach();
    const before = streamer.renderDoc()!;
    const hidden = structuredClone(doc);
    hidden.entities["building"]!.components["visibility"] = { visible: false };
    streamer.replan(hidden);
    assert.deepEqual(streamer.movedRoots(before).sort(), ["landmark", "room"]);
    assert.deepEqual(streamer.docOf("room")!.entities["room"]!.components["visibility"], { visible: false });
    const hiddenRender = streamer.renderDoc()!;
    streamer.replan(doc);
    assert.deepEqual(streamer.movedRoots(hiddenRender).sort(), ["landmark", "room"]);
    assert.equal(streamer.docOf("room")!.entities["room"]!.components["visibility"], undefined);
    assert.equal(doc.entities["room"]!.parent, "building");
  });

  it("requires rebuilding world-baked room instances after an authored building moves", () => {
    const doc = world(1);
    doc.entities["building"] = { name: "Building", parent: "poi-0", tags: [], components: t(20, 0) } as never;
    doc.entities["room"] = { name: "Room", parent: "building", tags: [], components: {
      ...t(5, 0), placeStream: { distance: 32, keepPadding: 48, footprintPadding: 2 },
    } } as never;
    doc.entities["chair"] = { name: "Chair", parent: "room", tags: [], components: {
      ...t(1, 0), mesh: { renderMode: "instanced", moving: false },
    } } as never;
    const streamer = new PlaceStreamer<THREE.InstancedMesh | null>({
      build: (_id, part) => {
        if (!part.entities["chair"]) return null;
        const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 1);
        const pose = worldTransforms(part).get("chair")!;
        mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(...pose.position));
        return mesh;
      },
      free: (_id, mesh) => { mesh?.dispose(); },
    });
    streamer.plan(doc);
    streamer.update(25, 0);
    streamer.attach();
    const before = streamer.renderDoc()!;
    const oldBatch = streamer.builtOf("room")!;
    const matrix = new THREE.Matrix4();
    oldBatch.getMatrixAt(0, matrix);
    assert.equal(matrix.elements[12], 26);

    const next = structuredClone(doc);
    (next.entities["building"]!.components["transform"] as { position: number[] }).position = [40, 0, 0];
    assert.equal(streamer.replan(next), true);
    assert.equal(streamer.requiresRebuildForInstanceEdits(before, ["building"]), true);
    oldBatch.getMatrixAt(0, matrix);
    assert.equal(matrix.elements[12], 26); // a root transform patch cannot update the baked sibling

    streamer.plan(next); // the host's full rebuild fallback regenerates instance matrices
    streamer.attach();
    streamer.builtOf("room")!.getMatrixAt(0, matrix);
    assert.equal(matrix.elements[12], 46);
    assert.equal(streamer.requiresRebuildForInstanceEdits(streamer.renderDoc()!, []), false);

    const ordinary = harness();
    const ordinaryDoc = structuredClone(doc);
    delete ordinaryDoc.entities["chair"]!.components["mesh"];
    delete next.entities["chair"]!.components["mesh"];
    ordinary.streamer.plan(ordinaryDoc);
    ordinary.streamer.update(25, 0);
    ordinary.streamer.attach();
    const original = ordinary.streamer.renderDoc()!;
    ordinary.streamer.replan(next);
    assert.equal(ordinary.streamer.requiresRebuildForInstanceEdits(original, ["building"]), false);
  });

  it("regenerates edited instance sources or descendants, checking both old and new render modes", () => {
    const doc = world(1);
    doc.entities["room"] = { name: "Room", parent: "poi-0", tags: [], components: {
      ...t(0, 0), placeStream: { distance: 32 },
    } } as never;
    doc.entities["table"] = { name: "Table", parent: "room", tags: [], components: t(0, 0) } as never;
    doc.entities["bowl"] = { name: "Bowl", parent: "table", tags: [], components: {
      ...t(1, 0), mesh: { renderMode: "instanced", moving: false },
    } } as never;
    doc.entities["ordinary"] = { name: "Ordinary", parent: "room", tags: [], components: t(2, 0) } as never;
    const { streamer } = harness();
    streamer.plan(doc); streamer.update(0, 0); streamer.attach();
    const before = streamer.renderDoc()!;
    const movedTable = structuredClone(doc);
    (movedTable.entities["table"]!.components["transform"] as { position: number[] }).position = [5, 0, 0];
    streamer.replan(movedTable);
    assert.equal(streamer.requiresRebuildForInstanceEdits(before, ["table"]), true);
    assert.equal(streamer.requiresRebuildForInstanceEdits(before, ["ordinary"]), false);

    const auto = structuredClone(doc);
    auto.entities["bowl"]!.components["mesh"] = { renderMode: "auto" };
    streamer.replan(auto);
    assert.equal(streamer.requiresRebuildForInstanceEdits(before, ["bowl"]), true); // remove the old batch
    const autoBefore = streamer.renderDoc()!;
    streamer.replan(doc);
    assert.equal(streamer.requiresRebuildForInstanceEdits(autoBefore, ["bowl"]), true); // build the new batch

    streamer.update(1000, 0);
    assert.equal(streamer.requiresRebuildForInstanceEdits(before, ["bowl"]), false); // unloaded place needs no repair
  });

  it("leaves streamed places out of the base doc and builds only the near ones", () => {
    const { streamer, built, log } = harness();
    const base = streamer.plan(world(3));
    assert.deepEqual(Object.keys(base.entities), ["ground"]);
    streamer.update(0, 0);
    streamer.attach();
    assert.deepEqual([...built], ["poi-0"]);
    assert.deepEqual(log, ["+poi-0:2"]);
  });
  it("hysteresis: crossing the build line back and forth never rebuilds", () => {
    const { streamer, log } = harness();
    streamer.plan(world(2));
    streamer.attach();
    const spec = streamer.specs().find((s) => s.id === "poi-1")!;
    const line = spec.center[0] - spec.radius - spec.distance;
    streamer.update(line + 5, 0); // inside: built
    for (let i = 0; i < 6; i++) streamer.update(i % 2 ? line + 5 : line - 60, 0);
    assert.deepEqual(log.filter((l) => l.includes("poi-1")), ["+poi-1:2"]);
    streamer.update(line - spec.keepPadding - 10, 0); // past the padding: freed
    assert.equal(log.at(-1), "-poi-1");
  });
  it("a scene rebuild frees every built place, attach rebuilds the near ones", () => {
    const { streamer, built, log } = harness();
    streamer.plan(world(2));
    streamer.update(0, 0);
    streamer.attach();
    streamer.plan(world(2));
    assert.equal(built.size, 0);
    streamer.attach();
    assert.deepEqual(log, ["+poi-0:2", "-poi-0", "+poi-0:2"]);
  });
  it("a pin (editor selection) builds a far place and keeps it while pinned", () => {
    const { streamer, built } = harness();
    streamer.plan(world(3));
    streamer.update(0, 0);
    streamer.attach();
    streamer.pin(streamer.placeOf("poi-2-hut")!);
    assert.equal(built.has("poi-2"), true);
    streamer.update(10, 0);
    assert.equal(built.has("poi-2"), true);
    streamer.pin(null);
    streamer.update(20, 0);
    assert.equal(built.has("poi-2"), false);
  });
  it("spreads builds over frames by the time budget while moving", () => {
    const { streamer, built } = harness("stream", 20);
    const doc = world(3);
    for (const id of ["poi-1", "poi-2"]) (doc.entities[id]!.components as Record<string, unknown>)["placeStream"] = { distance: 4000 };
    streamer.plan(doc);
    streamer.attach(); // no focus yet: nothing
    streamer.update(0, 0);
    assert.equal(built.size, 1);
    streamer.update(0, 0);
    assert.equal(built.size, 2);
  });
  it("?places=all builds everything in the base; none builds nothing", () => {
    assert.equal(Object.keys(harness("all").streamer.plan(world(2)).entities).length, 5);
    const none = harness("none");
    none.streamer.plan(world(2));
    none.streamer.update(0, 0);
    none.streamer.attach();
    assert.equal(none.built.size, 0);
  });

  it("independent rooms preload, survive the keep band, and release/reload without their enclosing town", () => {
    const { streamer, built, log } = harness();
    const doc = world(1);
    doc.entities['room'] = {name:'room',parent:'poi-0',tags:[],components:{...t(100,0),placeStream:{distance:20,keepPadding:30,footprintPadding:0}}} as never;
    doc.entities['room-chair'] = {name:'chair',parent:'room',tags:[],components:t(0,0)} as never;
    streamer.plan(doc);streamer.attach();
    streamer.update(75,0);
    assert.equal(built.has('poi-0'),true);
    assert.equal(built.has('room'),false);
    streamer.update(85,0);
    assert.equal(built.has('room'),true);
    assert.equal(streamer.docOf('room')!.entities['room']!.parent,null);
    streamer.update(65,0); // beyond initial threshold, inside the keep band
    assert.equal(built.has('room'),true);
    streamer.update(45,0);
    assert.equal(built.has('room'),false);
    assert.equal(built.has('poi-0'),true);
    streamer.update(85,0);
    assert.equal(log.filter(x=>x==='+room:2').length,2);
  });

  it("reconciles a detached loaded room when its authored building moves", () => {
    const {streamer} = harness();
    const doc=world(1);
    doc.entities['building']={name:'building',parent:'poi-0',tags:[],components:t(20,0)} as never;
    doc.entities['room']={name:'room',parent:'building',tags:[],components:{...t(5,0),placeStream:{distance:32,keepPadding:48,footprintPadding:2}}} as never;
    streamer.plan(doc);streamer.update(25,0);streamer.attach();
    const before=streamer.renderDoc()!;
    assert.deepEqual((before.entities['room']!.components['transform'] as {position:number[]}).position,[25,0,0]);
    const next=structuredClone(doc);
    (next.entities['building']!.components['transform'] as {position:number[]}).position=[40,0,0];
    assert.equal(streamer.replan(next),true);
    assert.deepEqual(streamer.movedRoots(before),['room']);
    assert.deepEqual((streamer.docOf('room')!.entities['room']!.components['transform'] as {position:number[]}).position,[45,0,0]);
    assert.equal(next.entities['room']!.parent,'building');
    assert.deepEqual((next.entities['room']!.components['transform'] as {position:number[]}).position,[5,0,0]);
  });

  it("also reconciles detached resident landmarks when their town moves", () => {
    const {streamer}=harness();
    const doc=world(1);
    doc.entities['landmark']={name:'tower',parent:'poi-0',tags:[],components:{...t(20,0),landmark:{}}} as never;
    streamer.plan(doc);streamer.update(0,0);streamer.attach();
    const before=streamer.renderDoc()!;
    assert.equal(before.entities['landmark']!.parent,null);
    const next=structuredClone(doc);
    (next.entities['poi-0']!.components['transform'] as {position:number[]}).position=[100,0,0];
    assert.equal(streamer.replan(next),true);
    assert.ok(streamer.movedRoots(before).includes('landmark'));
    assert.deepEqual((streamer.baseDoc()!.entities['landmark']!.components['transform'] as {position:number[]}).position,[120,0,0]);
  });
});
