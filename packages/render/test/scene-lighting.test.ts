import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import type { SceneDoc } from "@hitreg/core";
import { buildScene, makeMaterial, type MaterialData } from "../src/scene-builder.js";
import { sceneLighting } from "../src/scene-lighting.js";
import { currentMaterialEnvironment } from "../src/material-maps.js";
import { DEFAULT_VOLUMETRIC_SETTINGS, volumetricSignature } from "../src/atmosphere.js";
import { passPlan, pipelineSignature, resolvePostFx, POST_PASS_ORDER } from "../src/post.js";

const IDENTITY = {
  position: [0, 0, 0] as [number, number, number],
  rotation: [0, 0, 0, 1] as [number, number, number, number],
  scale: [1, 1, 1] as [number, number, number],
};

function doc(entities: SceneDoc["entities"]): SceneDoc {
  return { version: 1, name: "test", entities };
}

/** The `light` component as it appears in a scene doc written before `shadow`. */
function sunEntity(light: Record<string, unknown> = {}) {
  return {
    name: "Sun",
    parent: null,
    tags: [],
    components: {
      transform: { ...IDENTITY, position: [10, 20, 10] as [number, number, number] },
      light: {
        kind: "directional",
        color: "#fff5e0",
        intensity: 1,
        range: 10,
        angle: 0.5235987755982988,
        castShadow: true,
        importance: 1,
        shadowSize: 40,
        ...light,
      },
    },
  };
}

function skyEntity(sky: Record<string, unknown> = {}) {
  return {
    name: "Sky",
    parent: null,
    tags: [],
    components: {
      transform: { ...IDENTITY },
      sky: { top: "#39598f", bottom: "#101522", light: 0.5, ...sky },
    },
  };
}

function findLight(built: ReturnType<typeof buildScene>, id: string): THREE.Light {
  const group = built.objects.get(id)!;
  const light = group.children.find((child) => (child as THREE.Light).isLight === true);
  return light as THREE.Light;
}

describe("scene-builder lighting integration", () => {
  it("renders a doc with no `shadow` block exactly as it did before cascades existed", () => {
    // The regression that matters most: every value below is the literal the
    // builder hardcoded before `light.shadow` was a schema field.
    const built = buildScene(doc({ sun: sunEntity() }));
    const sun = findLight(built, "sun") as THREE.DirectionalLight;
    expect(sun.castShadow).toBe(true);
    expect(sun.shadow.mapSize.width).toBe(1024);
    expect(sun.shadow.camera.left).toBe(-40);
    expect(sun.shadow.camera.right).toBe(40);
    expect(sun.shadow.camera.top).toBe(40);
    expect(sun.shadow.camera.bottom).toBe(-40);
    expect(sun.shadow.camera.near).toBe(0.5);
    expect(sun.shadow.camera.far).toBe(120);
    expect(sun.shadow.bias).toBe(-0.0004);
    expect(sun.shadow.normalBias).toBe(0.02);
    // no cascades means no CSMShadowNode — same single map, same cost
    expect(sun.shadow.shadowNode).toBeFalsy();
    expect(built.lighting.stats().cascadedLights).toBe(0);
    built.lighting.dispose();
  });

  it("leaves a scene with no sky component with no fog and no IBL", () => {
    const built = buildScene(doc({ sun: sunEntity() }));
    expect(built.scene.fog).toBeNull();
    expect(built.scene.fogNode).toBeNull();
    expect(built.scene.environment).toBeNull();
    built.lighting.dispose();
  });

  it("honours cascades on a directional light and ignores them on point/spot", () => {
    const built = buildScene(
      doc({
        sun: sunEntity({ shadow: { cascades: 3, cascadeSplit: 0.7 } }),
        lamp: {
          name: "Lamp",
          parent: null,
          tags: [],
          components: {
            transform: { ...IDENTITY },
            light: {
              kind: "point",
              color: "#ffffff",
              intensity: 2,
              range: 12,
              angle: 0.5,
              castShadow: true,
              importance: 1,
              shadow: { cascades: 4, mapSize: 2048 },
            },
          },
        },
      }),
    );
    const sun = findLight(built, "sun") as THREE.DirectionalLight;
    const lamp = findLight(built, "lamp") as THREE.PointLight;
    expect(sun.shadow.shadowNode).toBeTruthy();
    // `cascades: 4` on a point light is inert; the rest of the block is not
    expect(lamp.shadow.shadowNode).toBeFalsy();
    expect(lamp.shadow.mapSize.width).toBe(2048);
    expect(built.lighting.stats()).toMatchObject({ cascadedLights: 1, shadowPasses: 3 + 6 });
    built.lighting.dispose();
  });

  it("force-disables a shadow through shadow.enabled without losing the tuning", () => {
    const built = buildScene(doc({ sun: sunEntity({ shadow: { enabled: false, cascades: 3 } }) }));
    const sun = findLight(built, "sun") as THREE.DirectionalLight;
    expect(sun.castShadow).toBe(false);
    expect(sun.shadow.shadowNode).toBeFalsy();
    expect(built.lighting.stats().shadowPasses).toBe(0);
    built.lighting.dispose();
  });

  it("keeps linear fog identical for a doc written before fog.mode existed", () => {
    const built = buildScene(
      doc({ sky: skyEntity({ fog: { color: "#101522", near: 40, far: 180 } }) }),
    );
    const fog = built.scene.fog as THREE.Fog;
    expect(fog).toBeInstanceOf(THREE.Fog);
    expect(fog.near).toBe(40);
    expect(fog.far).toBe(180);
    expect(built.scene.fogNode).toBeNull();
    built.lighting.dispose();
  });

  it("switches to a height-fog node when the doc asks for one", () => {
    const built = buildScene(
      doc({
        sky: skyEntity({
          fog: { color: "#0d1016", mode: "height", density: 0.03, heightFalloff: 0.2, baseHeight: -4 },
        }),
      }),
    );
    expect(built.scene.fogNode).not.toBeNull();
    expect(built.scene.fog).toBeInstanceOf(THREE.FogExp2);
    built.lighting.dispose();
  });

  it("turns IBL on by default for any scene with a sky, and off again without one", () => {
    // sky.environment.mode defaults to "sky": this is the fix for metalness: 1
    // rendering near-black, and it is deliberately a behaviour change.
    const metal = makeMaterial({
      shader: "standard",
      color: "#c0c0c0",
      repeat: [1, 1],
      roughness: 0.2,
      metalness: 1,
      emissive: "#000000",
      emissiveIntensity: 0,
      opacity: 1,
      transparent: false,
    } satisfies MaterialData);
    const camera = new THREE.PerspectiveCamera();
    const withSky = buildScene(doc({ sky: skyEntity() }));
    expect(withSky.scene.environment).not.toBeNull();
    expect(withSky.scene.environmentIntensity).toBe(1);

    // BUILDING a scene must not touch the module-global material seam: chunk
    // streaming and thumbnail bakes build scenes nobody renders, and pushing
    // from the builder would let either clear the live scene's IBL.
    expect(currentMaterialEnvironment()).toBeNull();

    // rendering it does
    withSky.lighting.frame(camera);
    expect(currentMaterialEnvironment()).toBe(withSky.scene.environment);
    // three ignores a material's own envMapIntensity unless it has an envMap
    expect((metal as THREE.MeshStandardMaterial).envMap).toBe(withSky.scene.environment);

    // an unrendered second build leaves the live scene's IBL alone...
    const chunk = buildScene(doc({ sun: sunEntity() }));
    expect(currentMaterialEnvironment()).toBe(withSky.scene.environment);
    // ...and rendering a sky-less scene clears it
    chunk.lighting.frame(camera);
    expect(chunk.scene.environment).toBeNull();
    expect(currentMaterialEnvironment()).toBeNull();
    expect((metal as THREE.MeshStandardMaterial).envMap).toBeNull();

    withSky.lighting.dispose();
    chunk.lighting.dispose();
  });

  it("reuses the same sky texture across rebuilds, so no PMREM or shader recompile", () => {
    // A structural edit forces a full rebuild. A fresh-but-identical texture
    // would re-run three's PMREM (cached by texture identity) and dirty every
    // PBR material, on every rebuild.
    const first = buildScene(doc({ sky: skyEntity() }));
    const second = buildScene(doc({ sky: skyEntity() }));
    expect(second.scene.environment).toBe(first.scene.environment);
    const different = buildScene(doc({ sky: skyEntity({ top: "#ff0000" }) }));
    expect(different.scene.environment).not.toBe(first.scene.environment);
    first.lighting.dispose();
    second.lighting.dispose();
    different.lighting.dispose();
  });

  it("respects environment.mode none and carries intensity/rotation", () => {
    const built = buildScene(
      doc({ sky: skyEntity({ environment: { mode: "none", intensity: 2, rotation: 1 } }) }),
    );
    expect(built.scene.environment).toBeNull();
    built.lighting.dispose();

    const rotated = buildScene(
      doc({ sky: skyEntity({ environment: { intensity: 2.5, rotation: 1.25 } }) }),
    );
    expect(rotated.scene.environment).not.toBeNull();
    expect(rotated.scene.environmentIntensity).toBe(2.5);
    expect(rotated.scene.environmentRotation.y).toBe(1.25);
    rotated.lighting.dispose();
  });

  it("publishes itself on the scene, which is how the renderer finds it", () => {
    const built = buildScene(doc({ sun: sunEntity() }));
    expect(sceneLighting(built.scene)).toBe(built.lighting);
    built.lighting.dispose();
    expect(sceneLighting(built.scene)).toBeNull();
  });

  it("asks for no shafts until a candidate light actually has a shadow map", () => {
    const built = buildScene(
      doc({
        sun: sunEntity(),
        sky: skyEntity({ volumetric: { enabled: true }, environment: { mode: "none" } }),
      }),
    );
    const camera = new THREE.PerspectiveCamera();
    built.lighting.frame(camera);
    // no shadow render has happened, so `shadow.map` is still null
    expect(built.lighting.volumetricRequest()).toBeNull();

    const sun = findLight(built, "sun") as THREE.DirectionalLight;
    (sun.shadow as unknown as { map: unknown }).map = {};
    // the poll is throttled; step it far enough to re-query
    for (let i = 0; i < 20; i++) built.lighting.frame(camera);
    const request = built.lighting.volumetricRequest();
    expect(request?.lights).toEqual([sun]);
    expect(request?.signature).toBe(volumetricSignature([sun]));
    expect(request?.settings.samples).toBe(DEFAULT_VOLUMETRIC_SETTINGS.samples);
    built.lighting.dispose();
  });
});

describe("post plan with volumetrics", () => {
  const fx = resolvePostFx(null);
  const light = new THREE.DirectionalLight();
  const request = {
    settings: { ...DEFAULT_VOLUMETRIC_SETTINGS, enabled: true },
    lights: [light],
    signature: volumetricSignature([light]),
  };

  it("keeps the documented pass order, with volumetrics ahead of it", () => {
    const order = [...POST_PASS_ORDER];
    expect(order.indexOf("volumetrics")).toBeLessThan(order.indexOf("ao"));
    expect(order.indexOf("ao")).toBeLessThan(order.indexOf("bloom"));
    expect(order.indexOf("bloom")).toBeLessThan(order.indexOf("dof"));
    expect(order.indexOf("dof")).toBeLessThan(order.indexOf("motionBlur"));
    expect(order.indexOf("motionBlur")).toBeLessThan(order.indexOf("tonemap"));
  });

  it("adds the pass only when a shaft can actually be drawn", () => {
    expect(passPlan(fx, {})).not.toContain("volumetrics");
    expect(passPlan(fx, { volumetric: null })).not.toContain("volumetrics");
    expect(passPlan(fx, { volumetric: { ...request, lights: [] } })).not.toContain("volumetrics");
    expect(passPlan(fx, { volumetric: { ...request, settings: DEFAULT_VOLUMETRIC_SETTINGS } })).not.toContain(
      "volumetrics",
    );
    expect(passPlan(fx, { volumetric: request })).toContain("volumetrics");
  });

  it("makes a changed shaft light structural and a changed knob not", () => {
    const base = pipelineSignature(fx, { volumetric: request });
    const retuned = pipelineSignature(fx, {
      volumetric: { ...request, settings: { ...request.settings, samples: 96, density: 0.9 } },
    });
    expect(retuned).toBe(base);
    const other = new THREE.DirectionalLight();
    const swapped = pipelineSignature(fx, {
      volumetric: { ...request, lights: [other], signature: volumetricSignature([other]) },
    });
    expect(swapped).not.toBe(base);
  });

  it("stays retired once the backend has refused it", () => {
    const plan = passPlan(fx, { volumetric: request, disabled: new Set(["volumetrics" as const]) });
    expect(plan).not.toContain("volumetrics");
  });
});
