import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { CSMFrustum } from "three/addons/csm/CSMFrustum.js";
import {
  CASCADE_BIAS_SCALE_CAP,
  CascadeShadowSystem,
  DEFAULT_SHADOW_SETTINGS,
  applyShadowSettings,
  cascadeBiasScale,
  cascadeSplits,
  frustumSliceSphere,
  quantizeExtent,
  shadowEnabled,
  shadowFarPlane,
  shadowPassCost,
  snapToTexelGrid,
} from "../src/csm.js";

describe("shadow settings", () => {
  it("reproduces the pre-schema hardcoded directional shadow exactly", () => {
    // These are the literal values scene-builder.ts used before `light.shadow`
    // existed. If this test ever has to change, an existing scene's shadows
    // changed with it.
    for (const size of [40, 120, 300]) {
      const light = new THREE.DirectionalLight();
      applyShadowSettings(light, true, DEFAULT_SHADOW_SETTINGS, size);
      const camera = light.shadow.camera;
      expect(light.castShadow).toBe(true);
      expect(light.shadow.mapSize.width).toBe(1024);
      expect(light.shadow.mapSize.height).toBe(1024);
      expect(camera.left).toBe(-size);
      expect(camera.right).toBe(size);
      expect(camera.top).toBe(size);
      expect(camera.bottom).toBe(-size);
      expect(camera.near).toBe(0.5);
      expect(camera.far).toBe(Math.max(120, size * 3));
      expect(light.shadow.bias).toBe(-0.0004);
      expect(light.shadow.normalBias).toBe(0.02);
    }
  });

  it("treats castShadow as the master switch and shadow.enabled as an AND-ed force-off", () => {
    expect(shadowEnabled(true, { enabled: true })).toBe(true);
    expect(shadowEnabled(true, { enabled: false })).toBe(false);
    // the block alone can never turn a shadow ON
    expect(shadowEnabled(false, { enabled: true })).toBe(false);

    const light = new THREE.DirectionalLight();
    applyShadowSettings(light, true, { ...DEFAULT_SHADOW_SETTINGS, enabled: false }, 40);
    expect(light.castShadow).toBe(false);
    // tuning survives the force-off, which is the point of having two fields
    expect(light.shadow.bias).toBe(DEFAULT_SHADOW_SETTINGS.bias);
  });

  it("far: 0 means auto and matches the old max(120, size * 3)", () => {
    expect(shadowFarPlane(40, 0)).toBe(120);
    expect(shadowFarPlane(300, 0)).toBe(900);
    expect(shadowFarPlane(300, 250)).toBe(250);
  });

  it("never reads cascade fields on a point light", () => {
    const light = new THREE.PointLight();
    // cascades: 4 must be inert here — the schema promises directional-only
    applyShadowSettings(light, true, { ...DEFAULT_SHADOW_SETTINGS, cascades: 4 }, 40);
    expect(light.castShadow).toBe(true);
    expect(light.shadow.mapSize.width).toBe(1024);
    expect(shadowPassCost("point", { ...DEFAULT_SHADOW_SETTINGS, cascades: 4 })).toBe(6);
    expect(shadowPassCost("spot", { ...DEFAULT_SHADOW_SETTINGS, cascades: 4 })).toBe(1);
    expect(shadowPassCost("ambient", DEFAULT_SHADOW_SETTINGS)).toBe(0);
    expect(shadowPassCost("directional", { ...DEFAULT_SHADOW_SETTINGS, cascades: 3 })).toBe(3);
  });
});

describe("cascade splits", () => {
  it("returns `cascades` breaks, strictly increasing, ending at exactly 1", () => {
    for (const lambda of [0, 0.25, 0.5, 1]) {
      const breaks = cascadeSplits(4, 0.1, 400, lambda);
      expect(breaks).toHaveLength(4);
      expect(breaks.at(-1)).toBe(1);
      for (let i = 1; i < breaks.length; i++) expect(breaks[i]!).toBeGreaterThan(breaks[i - 1]!);
    }
  });

  it("lambda 0 is uniform and lambda 1 is logarithmic, in that direction", () => {
    const uniform = cascadeSplits(3, 0.1, 300, 0);
    const logarithmic = cascadeSplits(3, 0.1, 300, 1);
    expect(uniform[0]).toBeCloseTo(1 / 3, 3);
    // logarithmic pulls the near breaks in, leaving the far cascade enormous
    expect(logarithmic[0]!).toBeLessThan(uniform[0]!);
    expect(logarithmic[1]!).toBeLessThan(uniform[1]!);
  });

  it("clamps lambda and degenerates to a single full-range cascade", () => {
    expect(cascadeSplits(1, 0.1, 100, 0.5)).toEqual([1]);
    expect(cascadeSplits(3, 0.1, 100, -5)).toEqual(cascadeSplits(3, 0.1, 100, 0));
    expect(cascadeSplits(3, 0.1, 100, 5)).toEqual(cascadeSplits(3, 0.1, 100, 1));
  });
});

describe("cascade fitting", () => {
  it("quantises an extent upward, so coverage is never lost", () => {
    for (const extent of [1, 12.5, 37.9, 512.3]) {
      expect(quantizeExtent(extent)).toBeGreaterThanOrEqual(extent);
      expect(quantizeExtent(extent)).toBeLessThan(extent * 1.05);
    }
    expect(quantizeExtent(0)).toBe(0);
  });

  it("holds the quantised extent still across a small FOV change", () => {
    // The shimmer bug: a continuously varying extent moves the texel grid
    // every frame. Neighbouring FOVs must land on the same quantised extent.
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 500);
    const a = quantizeExtent(frustumSliceSphere(camera, 0.1, 40).radius * 2);
    camera.fov = 60.05;
    camera.updateProjectionMatrix();
    const b = quantizeExtent(frustumSliceSphere(camera, 0.1, 40).radius * 2);
    expect(b).toBe(a);
  });

  it("snaps to a texel grid", () => {
    expect(snapToTexelGrid(10.7, 0.5)).toBeCloseTo(10.5, 6);
    expect(snapToTexelGrid(-3.2, 1)).toBe(-4);
    expect(snapToTexelGrid(7, 0)).toBe(7);
  });

  it("bounds a frustum slice with a sphere that ignores camera rotation", () => {
    const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 500);
    const before = frustumSliceSphere(camera, 5, 60);
    camera.rotation.set(0.4, 1.2, -0.3);
    camera.updateMatrixWorld(true);
    const after = frustumSliceSphere(camera, 5, 60);
    expect(after.radius).toBeCloseTo(before.radius, 10);
    expect(after.centerDistance).toBeGreaterThanOrEqual(5);
    expect(after.centerDistance).toBeLessThanOrEqual(60);
    // the sphere must actually contain the far corners
    const tan = Math.tan(THREE.MathUtils.degToRad(35));
    const corner = new THREE.Vector3(tan * 60 * camera.aspect, tan * 60, -60);
    const dz = corner.z + after.centerDistance;
    expect(Math.hypot(corner.x, corner.y, dz)).toBeLessThanOrEqual(after.radius + 1e-6);
  });

  it("scales bias with texel size and depth range, capped", () => {
    expect(cascadeBiasScale(0.1, 200, 0.1, 200)).toEqual({ bias: 1, normalBias: 1 });
    const far = cascadeBiasScale(0.4, 400, 0.1, 200);
    expect(far.normalBias).toBeCloseTo(4, 6);
    expect(far.bias).toBeCloseTo(2, 6); // 4x texels, but half the depth resolution
    // a 40x texel ratio must not detach the shadow from its caster
    const absurd = cascadeBiasScale(40, 200, 0.1, 200);
    expect(absurd.normalBias).toBe(CASCADE_BIAS_SCALE_CAP);
    expect(absurd.bias).toBe(CASCADE_BIAS_SCALE_CAP);
    expect(cascadeBiasScale(1, 1, 0, 0)).toEqual({ bias: 1, normalBias: 1 });
  });
});

describe("CascadeShadowSystem", () => {
  it("leaves cascades: 1 on the plain single-map path (unchanged scenes)", () => {
    const system = new CascadeShadowSystem();
    const light = new THREE.DirectionalLight();
    expect(system.register(light, true, DEFAULT_SHADOW_SETTINGS, 40)).toBe(false);
    expect(light.shadow.shadowNode).toBeFalsy();
    expect(light.shadow.camera.far).toBe(120);
    expect(system.stats()).toEqual({ cascadedLights: 0, shadowPasses: 1 });
    system.dispose();
  });

  it("costs nothing when the light casts no shadow", () => {
    const system = new CascadeShadowSystem();
    const light = new THREE.DirectionalLight();
    expect(system.register(light, false, { ...DEFAULT_SHADOW_SETTINGS, cascades: 3 }, 40)).toBe(false);
    expect(light.shadow.shadowNode).toBeFalsy();
    expect(system.stats()).toEqual({ cascadedLights: 0, shadowPasses: 0 });
    system.dispose();
  });

  it("attaches a shadow node for cascades >= 2 and releases it cleanly", () => {
    const system = new CascadeShadowSystem();
    const light = new THREE.DirectionalLight();
    expect(system.register(light, true, { ...DEFAULT_SHADOW_SETTINGS, cascades: 3 }, 40)).toBe(true);
    expect(light.shadow.shadowNode).toBeTruthy();
    expect(system.stats()).toEqual({ cascadedLights: 1, shadowPasses: 3 });

    // re-registering with cascades back at 1 must remove the node, not stack one
    expect(system.register(light, true, DEFAULT_SHADOW_SETTINGS, 40)).toBe(false);
    expect(light.shadow.shadowNode).toBeFalsy();
    expect(system.stats()).toEqual({ cascadedLights: 0, shadowPasses: 1 });

    system.register(light, true, { ...DEFAULT_SHADOW_SETTINGS, cascades: 2 }, 40);
    system.dispose();
    expect(light.shadow.shadowNode).toBeFalsy();
    expect(system.stats()).toEqual({ cascadedLights: 0, shadowPasses: 0 });
  });

  /**
   * Stand in for the `_init(builder)` a real render would do: three only
   * builds `frustums`/`lights` once it has a NodeBuilder, which no headless
   * test has. Everything below it — where each cascade actually ends up — is
   * plain matrix maths and is exactly what regressed.
   */
  interface CascadeNodeInternals {
    camera: THREE.Camera | null;
    frustums: CSMFrustum[];
    lights: THREE.DirectionalLight[];
    lightMargin: number;
    updateBefore(): unknown;
  }

  function primeCascades(
    node: CascadeNodeInternals,
    camera: THREE.PerspectiveCamera,
    count: number,
  ): THREE.DirectionalLight[] {
    camera.updateMatrixWorld(true);
    node.camera = camera;
    node.frustums = Array.from({ length: count }, () => {
      const f = new CSMFrustum();
      f.setFromProjectionMatrix(camera.projectionMatrix, camera.far);
      return f;
    });
    const lights = Array.from({ length: count }, () => new THREE.DirectionalLight());
    node.lights = lights;
    return lights;
  }

  it("places cascades independently of where the light ENTITY sits", () => {
    // three's updateBefore() computes cascade centres in WORLD space (from
    // camera.matrixWorld) and writes them into lwLight.position, which is
    // LOCAL to light.parent. That is only correct while the light hangs off
    // the scene root. This engine parents a light to its entity's transform
    // group, so a sun authored at (40, 90, 30) displaced every cascade by
    // exactly that — the shadowed volume never contained the player.
    //
    // Same light direction, same camera, two different entity positions: the
    // cascades have to land in the same place in the world.
    const place = (x: number, y: number, z: number): THREE.Vector3[] => {
      const system = new CascadeShadowSystem();
      const group = new THREE.Group();
      group.position.set(x, y, z);
      group.quaternion.set(0.150505, 0, -0.200673, 0.968028);
      const light = new THREE.DirectionalLight();
      light.target.position.set(0, -1, 0);
      group.add(light.target);
      group.add(light);
      new THREE.Scene().add(group);
      system.register(light, true, { ...DEFAULT_SHADOW_SETTINGS, cascades: 2 }, 40);
      const node = light.shadow.shadowNode as unknown as CascadeNodeInternals;
      const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
      camera.position.set(-26, 13, 38);
      const cascades = primeCascades(node, camera, 2);
      node.updateBefore();
      const out = cascades.map((cascade) => {
        cascade.updateWorldMatrix(true, false);
        return cascade.getWorldPosition(new THREE.Vector3());
      });
      system.dispose();
      return out;
    };

    const atOrigin = place(0, 0, 0);
    const offset = place(40, 90, 30);
    expect(offset).toHaveLength(atOrigin.length);
    for (let i = 0; i < atOrigin.length; i++) {
      expect(offset[i]!.x).toBeCloseTo(atOrigin[i]!.x, 4);
      expect(offset[i]!.y).toBeCloseTo(atOrigin[i]!.y, 4);
      expect(offset[i]!.z).toBeCloseTo(atOrigin[i]!.z, 4);
    }
  });

  it("aims cascades along the light's WORLD direction, not its local one", () => {
    // three derives the light direction from light.position/target.position,
    // which are LOCAL. Rotate the light and that reads (0,-1,0) — straight
    // down — while three's own renderer lights the surface from the world
    // direction. The cascades then rasterise from a different angle than the
    // one being shaded, and the shadows do not land on anything.
    const system = new CascadeShadowSystem();
    const light = new THREE.DirectionalLight();
    light.quaternion.set(0.150505, 0, -0.200673, 0.968028); // ~61 deg elevation
    light.target.position.set(0, -1, 0);
    light.add(light.target); // direction carried by the light's own rotation
    new THREE.Scene().add(light);
    system.register(light, true, { ...DEFAULT_SHADOW_SETTINGS, cascades: 2 }, 40);
    const node = light.shadow.shadowNode as unknown as CascadeNodeInternals;

    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(-26, 13, 38);
    const cascades = primeCascades(node, camera, 2);
    node.updateBefore();

    light.updateWorldMatrix(true, true);
    const expected = light.target
      .getWorldPosition(new THREE.Vector3())
      .sub(light.getWorldPosition(new THREE.Vector3()))
      .normalize();
    expect(expected.y).toBeGreaterThan(-0.99); // guard: the fixture IS rotated

    for (const cascade of cascades) {
      cascade.updateWorldMatrix(true, true);
      const actual = cascade.target
        .getWorldPosition(new THREE.Vector3())
        .sub(cascade.getWorldPosition(new THREE.Vector3()))
        .normalize();
      expect(actual.x).toBeCloseTo(expected.x, 5);
      expect(actual.y).toBeCloseTo(expected.y, 5);
      expect(actual.z).toBeCloseTo(expected.z, 5);
    }
    system.dispose();
  });

  it("update() is inert before three has built the cascade frustums", () => {
    const system = new CascadeShadowSystem();
    const light = new THREE.DirectionalLight();
    const camera = new THREE.PerspectiveCamera();
    system.register(light, true, { ...DEFAULT_SHADOW_SETTINGS, cascades: 2 }, 40);
    expect(() => system.update(camera)).not.toThrow();
    system.dispose();
  });
});
