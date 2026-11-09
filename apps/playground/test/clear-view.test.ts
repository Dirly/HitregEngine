// Batch cameras inside canopy/rock (e-guard 2026-11-03): tools/_clear-view.mts candidate poses + sight rays,
// src/line-of-sight.ts casting against drawn meshes (both faces, instanced vegetation), render-batch's pose judge.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { clearViewCandidates, sightRays, type V3 } from "../tools/_clear-view.mts";
import { batchSpots, poseFaults } from "../tools/_render-batch.mts";
import { firstClearPose } from "../src/line-of-sight.ts";

const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test("candidates: the given pose first, then nearest moves; orbit keeps the distance; none under the ground", () => {
  const cam: V3 = [100, 50, 0], aim: V3 = [0, 0, 0];
  const c = clearViewCandidates(cam, aim, aim, { groundAt: () => 0 });
  assert.deepEqual(c[0]!.camera, cam);
  assert.equal(c[0]!.cost, 0);
  for (let i = 1; i < c.length; i++) assert.ok(c[i]!.cost >= c[i - 1]!.cost);
  const orbit = c.find((x) => x.dYawDeg === 12 && x.dElevDeg === 0 && x.pull === 1)!;
  assert.ok(Math.abs(dist(orbit.camera, aim) - dist(cam, aim)) < 0.05);
  assert.deepEqual(orbit.target, [0, 0, 0], "a view aimed at the aim keeps looking at it");
  // ground at 60 m: every candidate keeps 1.5 m of air
  for (const x of clearViewCandidates(cam, aim, aim, { groundAt: () => 40 })) assert.ok(x.camera[1] >= 41.5);
});

test("rays: the aim first, then a cross round it", () => {
  const r = sightRays([0, 10, 50], [0, 0, 0], 22);
  assert.equal(r.length, 5);
  assert.deepEqual(r[0], [0, 0, 0]);
  assert.ok(Math.abs(r[1]![0]) > 0.9 && Math.abs(r[1]![0]) <= 12);
});

/** A tree: a trunk box and an instanced canopy ball, the way vegetation draws. */
function world(): THREE.Scene {
  const s = new THREE.Scene();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial());
  s.add(ground);
  const canopy = new THREE.InstancedMesh(new THREE.SphereGeometry(4, 12, 8), new THREE.MeshBasicMaterial(), 2);
  canopy.setMatrixAt(0, new THREE.Matrix4().makeTranslation(50, 10, 0)); // the camera's tree
  canopy.setMatrixAt(1, new THREE.Matrix4().makeTranslation(-80, 10, 80));
  canopy.computeBoundingSphere();
  s.add(canopy);
  const sky = new THREE.Mesh(new THREE.SphereGeometry(5000, 8, 6), new THREE.MeshBasicMaterial({ side: THREE.BackSide }));
  s.add(sky);
  s.updateMatrixWorld(true);
  return s;
}

test("line of sight: a camera inside a canopy is blocked (faces from inside count); the nearest clear pose is found", () => {
  const s = world();
  const aim: V3 = [0, 0, 0], cam: V3 = [50, 10, 0]; // inside the canopy ball
  const cands = clearViewCandidates(cam, aim, aim, { groundAt: () => 0 });
  const v = firstClearPose(s, cands.map((c) => ({ camera: c.camera, rays: sightRays(c.camera, aim, 22) })));
  assert.ok(v.clear > 0, "the given pose is blocked, a moved one is clear");
  assert.ok(v.tried[0]!.first && v.tried[0]!.first.d < 5, "blocked right at the camera");
  const pick = cands[v.clear]!;
  assert.ok(dist(pick.camera, cam) > 3);
  // the sky dome (huge shell) and the ground near the aim never block
  const open = firstClearPose(s, [{ camera: [0, 60, -60], rays: sightRays([0, 60, -60], aim, 22) }]);
  assert.equal(open.clear, 0);
});

test("line of sight: no clear pose is reported", () => {
  const s = new THREE.Scene();
  const box = new THREE.Mesh(new THREE.BoxGeometry(20, 20, 20), new THREE.MeshBasicMaterial());
  s.add(box);
  s.updateMatrixWorld(true);
  const v = firstClearPose(s, [{ camera: [0, 0, 0], rays: [[100, 0, 0]] }]);
  assert.equal(v.clear, -1);
});

test("render-batch: rig views get the place centre as aim; a cleared camera is judged at its cleared pose", () => {
  const iso = [{ name: "iso-ne", x: 0, z: 0, camera: [50, 50, -50], target: [1, 2, 3] }, { name: "iso-sw", x: 0, z: 0, camera: [-50, 50, 50], target: [1, 2, 3] }];
  const views = [{ name: "core-close", x: 0, z: 0, facing: 180, distance: 1 }, { name: "read-1-60m", x: 60, z: 0, facing: 270, distance: 1 }, { name: "cam-close", x: 5, z: 5, camera: [5, 2, 5], target: [0, 1, 0] }];
  const spots = batchSpots([{ id: "p", views: [...iso, ...views], iso: [], readView: "read-1-60m", lit: false }]);
  const read = spots.find((s) => s.name === "p--read-1-60m")!;
  assert.deepEqual(read.aim, [1, 2, 3]);
  const fixed = { name: "p--x", x: 0, z: 0, camera: [10, 5, 0], target: [0, 0, 0] };
  const moved = { moved: true, from: [10, 5, 0], to: [8, 9, -5], target: [0, 0, 0], dYawDeg: 30, dElevDeg: 10, pull: 1, blockedBy: "tree", blockedAtM: 1 };
  const run = { shots: [{ spot: "p--x", file: "f", time: 12, camera: { pos: [8, 9, -5], target: [0, 1, 0], distance: 1 }, clearView: moved }] };
  assert.deepEqual(poseFaults([fixed] as any, run as any), []);
  const run2 = { shots: [{ spot: "p--x", file: "f", time: 12, camera: { pos: [8, 9, -5], target: [0, 1, 0], distance: 1 } }] };
  assert.equal(poseFaults([fixed] as any, run2 as any).length, 1, "without the record the move is a pose fault");
});
