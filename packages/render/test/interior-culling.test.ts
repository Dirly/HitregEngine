import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { CullingSystem } from "../src/culling.js";
import { OCCLUDED_LAYER } from "../src/horizon.js";
import { hierarchyVisible } from "../src/cull-visibility.js";
import { LightBudgetSystem } from "../src/light-budget.js";
import { AmbientVfx, VfxSystem } from "../src/vfx/index.js";

function roomScene() {
  const scene = new THREE.Scene();
  const building = new THREE.Group();
  const room = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  room.add(mesh);
  building.add(room);
  scene.add(building);
  const camera = new THREE.PerspectiveCamera();
  camera.position.x = 30;
  const culling = new CullingSystem();
  const unit = culling.register({ objects: [room], interior: true, reveal: 5, occlusion: false });
  return { scene, building, room, mesh, camera, culling, unit };
}

describe("interior culling integration", () => {
  it("keeps room ownership when an enclosing fallback gate registers later, including async meshes", () => {
    const { building, room, mesh, camera, culling, unit } = roomScene();
    culling.register({ objects: [building], occlusion: false });
    culling.update(camera, 720);
    expect(mesh.layers.mask).toBe(0);
    expect(room.visible).toBe(true);
    expect(hierarchyVisible(room)).toBe(false);

    const late = mesh.clone();
    late.layers.mask = 1; // a freshly loaded mesh, rather than the clone's culled mask
    room.add(late);
    for (let i = 0; i < 4; i++) culling.update(camera, 720);
    expect(late.layers.mask).toBe(0);
    camera.position.x = 0;
    culling.update(camera, 720);
    expect(mesh.layers.mask).toBe(1);
    expect(late.layers.mask).toBe(1);
    expect(hierarchyVisible(room)).toBe(true);

    camera.position.x = 30;
    culling.update(camera, 720);
    culling.unregister(unit);
    expect(hierarchyVisible(room)).toBe(true);
    expect(late.layers.mask).toBe(1);
    culling.clear();
  });

  it("parks pooled interior lights without changing the renderer's light set", () => {
    const { scene, room, camera, culling } = roomScene();
    const light = new THREE.PointLight(0xffffff, 4, 12);
    room.add(light);
    const budget = new LightBudgetSystem(2);
    budget.register(light);
    const lightSet = () => {
      const ids: number[] = [];
      scene.traverseVisible((o) => { if ((o as THREE.PointLight).isPointLight) ids.push(o.id); });
      return ids;
    };
    culling.update(camera, 720);
    budget.update(scene, camera);
    expect(budget.stats().active).toBe(0);
    const parkedSet = lightSet();
    camera.position.x = 0;
    culling.update(camera, 720);
    budget.update(scene, camera);
    expect(budget.stats().active).toBe(1);
    expect(lightSet()).toEqual(parkedSet);
    culling.enabled = false;
    camera.position.x = 30;
    culling.update(camera, 720);
    expect(hierarchyVisible(room)).toBe(true);
    culling.clear();
    budget.dispose();
  });

  it("sleeps detached ambient flames with their source room and restores them on approach", () => {
    const { scene, room, camera, culling } = roomScene();
    const sys = new VfxSystem();
    sys.attach(scene);
    const ambient = new AmbientVfx(sys, { resolveEffect: () => ({ name: "torch", modules: [
      { kind: "particles", stream: true, color: "glow", emitter: { rate: 20, max: 40, lifetime: [0.3, 0.5] } },
      { kind: "light", intensity: 10, range: 8, color: "primary", intensityCurve: [[0, 1], [1, 1]] },
    ] }) });
    const torch = new THREE.Group();
    room.add(torch);
    ambient.register("torch", torch, { effect: "torch", playing: true, cullDistance: 100 });
    const tick = (frames = 1) => { for (let i = 0; i < frames; i++) {
      ambient.update(camera, scene);
      sys.update(0.1, camera, scene);
    } };
    culling.update(camera, 720);
    tick();
    expect(ambient.stats().playing).toBe(0);
    camera.position.x = 0;
    culling.update(camera, 720);
    tick();
    expect(ambient.stats().playing).toBe(1);
    camera.position.x = 30;
    culling.update(camera, 720);
    tick(10);
    expect(ambient.stats().playing).toBe(0);
    sys.dispose();
    culling.clear();
  });
  it("keeps a distance-hidden prop cell casting inside shadow range, and drops it past (shadowWhenHidden)", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    const group = new THREE.Group();
    group.add(mesh);
    const camera = new THREE.PerspectiveCamera();
    const culling = new CullingSystem();
    culling.register({ name: "props", objects: [group], interior: true, reveal: 5, occlusion: false, shadowWhenHidden: true });
    camera.position.x = 30;
    culling.update(camera, 720);
    // off the main camera's layer, on the layer only shadow cameras draw
    expect(mesh.layers.mask).toBe(1 << OCCLUDED_LAYER);
    camera.position.x = culling.shadowDistance + 20;
    culling.update(camera, 720);
    expect(mesh.layers.mask).toBe(0);
    camera.position.x = 0;
    culling.update(camera, 720);
    expect(mesh.layers.mask).toBe(1);
    culling.clear();
  });
});
