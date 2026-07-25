import * as THREE from "three/webgpu";
import type { SceneDoc } from "@hitreg/core";
import type { EngineRenderer } from "@hitreg/render";

// -- billboard proxy baking: a real snapshot instead of a color guess ------
// Same render-to-texture technique as the prefab thumbnails, minus the CPU
// pixel readback — this stays entirely GPU-side, since the caller only needs
// the render target's own texture as another material's input, not a
// displayable image. `object` is always a throwaway clone (the render
// package never hands over its shared cached model), so reparenting it into
// a temp scene here is safe.
const BILLBOARD_BAKE_SIZE = 128;

/** Read the CURRENT scene's actual sky/sun instead of a generic studio
 * rig, so a baked billboard's shading matches the real trees standing next
 * to it instead of looking lit from a different scene entirely. Falls back
 * to reasonable defaults if the scene has neither (e.g. a scene authored
 * with no sky at all). */
function currentSceneLightRig(
  getLastExpanded: () => SceneDoc,
): { hemisphere: THREE.HemisphereLight; sun: THREE.DirectionalLight } {
  let skyData:
    | { top: string; bottom: string; light: number; sun?: { direction: [number, number, number] } }
    | undefined;
  let sunData: { color: string; intensity: number } | undefined;
  for (const entity of Object.values(getLastExpanded()?.entities ?? {})) {
    const sky = entity.components["sky"] as typeof skyData | undefined;
    if (sky && !skyData) skyData = sky;
    const light = entity.components["light"] as
      | { kind: string; color: string; intensity: number }
      | undefined;
    if (light?.kind === "directional" && !sunData) sunData = light;
  }
  const hemisphere = new THREE.HemisphereLight(
    new THREE.Color(skyData?.top ?? "#5fa9ff"),
    new THREE.Color(skyData?.bottom ?? "#dff1ff"),
    skyData?.light ?? 0.75,
  );
  const sun = new THREE.DirectionalLight(
    new THREE.Color(sunData?.color ?? "#fff3d9"),
    sunData?.intensity ?? 2.4,
  );
  // the sky dome's own sun.direction IS the scene's actual light direction
  // (buildSkyDome in scene-builder.ts renders the visible sun disc from this
  // exact vector) — using it here, instead of a fixed "from above" guess,
  // means a baked billboard's shading direction actually matches both the
  // sky the player sees AND the real (unbaked) near-tier trees standing
  // right next to it, lit by the scene's real directional light.
  const dir = skyData?.sun?.direction ?? [1, 2, 1];
  sun.position.set(dir[0], dir[1], dir[2]);
  return { hemisphere, sun };
}

export function bakeBillboardTexture(
  renderer: EngineRenderer,
  getLastExpanded: () => SceneDoc,
  object: THREE.Object3D,
  aspect: { width: number; height: number },
): THREE.Texture | null {
  try {
    const scene = new THREE.Scene();
    const { hemisphere, sun } = currentSceneLightRig(getLastExpanded);
    scene.add(hemisphere);
    scene.add(sun);
    scene.add(object);

    const halfW = Math.max(aspect.width, 0.1) / 2;
    const halfH = Math.max(aspect.height, 0.1) / 2;
    const box = new THREE.Box3().setFromObject(object);
    const center = box.getCenter(new THREE.Vector3());
    const depth = Math.max(halfW, halfH) * 4;
    const cam = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.01, depth * 2);
    cam.position.copy(center).add(new THREE.Vector3(0, 0, depth));
    cam.lookAt(center);

    const aspectRatio = aspect.width / aspect.height;
    const texW = aspectRatio >= 1 ? BILLBOARD_BAKE_SIZE : Math.max(16, Math.round(BILLBOARD_BAKE_SIZE * aspectRatio));
    const texH = aspectRatio >= 1 ? Math.max(16, Math.round(BILLBOARD_BAKE_SIZE / aspectRatio)) : BILLBOARD_BAKE_SIZE;
    const target = new THREE.RenderTarget(texW, texH);

    const prevClear = new THREE.Color();
    renderer.renderer.getClearColor(prevClear);
    const prevAlpha = renderer.renderer.getClearAlpha();
    renderer.renderer.setClearColor(0x000000, 0); // transparent, not chroma-keyed — no green fringing
    renderer.renderer.setRenderTarget(target);
    renderer.renderer.render(scene, cam);
    renderer.renderer.setRenderTarget(null);
    renderer.renderer.setClearColor(prevClear, prevAlpha);

    scene.remove(object); // release our hold; the clone itself can be gc'd
    return target.texture;
  } catch (error) {
    console.warn("[billboard] bake failed, falling back to material color:", error);
    return null;
  }
}
