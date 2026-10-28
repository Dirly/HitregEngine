import * as THREE from "three/webgpu";
import { onMaterialMapsWired } from "./material-maps.js";
import { cloneMaterial } from "./node-material.js";
import { cameraPosition, clamp, float, log, max, min, mix, output, positionWorld, reference, renderGroup, smoothstep, uniform, vec4 } from "three/tsl";

/**
 * Landmark fog: the `landmark` component's subtree draws through the zone's
 * fog with its OWN fog curve, so a dungeon entrance the zone fog hides at
 * 200 m still stands as a darker, hazy shape out to its `fogReach`.
 *
 * The curve is defined on optical depth, not distance, so it works on any fog
 * the scene has (height fog with mist and sun scatter, plain exponential,
 * linear) without re-deriving each one:
 *
 *   tau   = -ln(1 - f)                      the scene fog's own depth at this pixel
 *   tauL  = clamp(3 d / reach, kMin tau, tau)
 *
 * - `3 d / reach` is an even haze that reaches 95 % opacity at `fogReach`.
 * - never MORE fog than the ground at the same spot (`<= tau`): in thin air a
 *   landmark looks exactly like everything around it;
 * - never less than `kMin` of it (`>= kMin tau`): it always sits IN the
 *   atmosphere, it does not punch a clear hole through a dense bank.
 * - past 80 % of the reach it is driven to fully fogged, so it is gone at
 *   `fogReach` whatever the fog does (and culling may drop it there).
 *
 * What it fogs TOWARD is the fog colour darkened by `silhouette` (up to 40 %),
 * the darkening dissolving back into the fog colour over the last 30 % of the
 * reach: a dark shape on the horizon that never pops at the edge.
 *
 * One variant material per (source material, quantised reach, quantised
 * silhouette), cached: the same meshes, the same draw calls, one more
 * pipeline per landmark material. The variant overrides `setupFog` (three's
 * NodeMaterial fog hook, which `fromMaterial` copies onto classic materials)
 * and `customProgramCacheKey`, so its program never aliases the source's.
 */

/** Share of the scene fog's optical depth a landmark always keeps. */
export const LANDMARK_MIN_FOG_SHARE = 0.15;
/** Optical depth reached at `fogReach` (1 - e^-3 = 95 %). */
const REACH_DEPTH = 3;
/** Fully fogged from here (fraction of reach) to the reach. */
const FADE_START = 0.8;
/** The silhouette tone returns to the fog colour from here (fraction of reach). */
const TONE_FADE_START = 0.7;
/** `silhouette: 1` darkens the fog colour by this much. Was 0.7: at 250 m by day a silhouette-1 chapel drew as a black
 *  cutout against fog-grey trees at the same distance (owner, 2026-10-27: "the church isn't affected by fog"). */
const MAX_DARKEN = 0.4;
/** 1 - f is clamped here before the log (a fully fogged pixel has infinite depth). */
const MIN_TRANSMITTANCE = 1e-4;

export interface LandmarkFog {
  fogReach: number;
  silhouette: number;
}

/**
 * Parts of a scene fog node a landmark variant re-blends: the fog colour and
 * blend factor (0 clear, 1 opaque). FogSystem attaches them to its node; for
 * three's own Fog/FogExp2 they are rebuilt from the fog object.
 */
export interface LandmarkFogParts {
  color: unknown;
  factor: unknown;
  /** Light scattered in the air in front of the surface (fog lamps), added as is. */
  glow?: unknown;
}
export const LANDMARK_FOG_PARTS = "__landmarkFogParts";

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * CPU reference of the shader: the landmark's fog factor and how much of the
 * silhouette darkening its fog colour carries, given the scene fog's factor
 * `base` at the same pixel and the camera distance.
 */
export function landmarkFogFactor(base: number, distance: number, settings: LandmarkFog): { factor: number; tone: number } {
  const reach = Math.max(1, settings.fogReach);
  const tau = -Math.log(Math.max(MIN_TRANSMITTANCE, 1 - Math.min(1, Math.max(0, base))));
  const tauL = Math.min(tau, Math.max(LANDMARK_MIN_FOG_SHARE * tau, (REACH_DEPTH * distance) / reach));
  const factor = Math.max(1 - Math.exp(-tauL), smooth(FADE_START * reach, reach, distance));
  const tone = Math.min(1, Math.max(0, settings.silhouette)) * (1 - smooth(TONE_FADE_START * reach, reach, distance));
  return { factor, tone };
}

/** The colour a landmark fogs toward: the fog colour darkened by `tone` (from `landmarkFogFactor`). */
export function landmarkFogTone(fogColor: THREE.Color, tone: number, target = new THREE.Color()): THREE.Color {
  return target.copy(fogColor).multiplyScalar(1 - MAX_DARKEN * tone);
}

/** Quantised so a zone's landmarks share variants (25 m, 0.05). */
export function landmarkFogKey(settings: LandmarkFog): string {
  return `${Math.round(settings.fogReach / 25) * 25}:${Math.round(settings.silhouette * 20) / 20}`;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any;

/** Parts for the scene fog this build sees, or null (no fog / unknown kind = the scene's fog unchanged). */
export function sceneFogParts(builder: N): LandmarkFogParts | null {
  const node = builder.fogNode as N;
  if (!node) return null;
  const attached = node[LANDMARK_FOG_PARTS] as LandmarkFogParts | undefined;
  if (attached) return attached;
  const sceneFog = builder.scene?.fog as (THREE.Fog & THREE.FogExp2) | null | undefined;
  if (!sceneFog || builder.scene?.fogNode) return null;
  const color = (reference("color", "color", sceneFog) as N).setGroup(renderGroup);
  const distance = positionWorld.distance(cameraPosition);
  if ((sceneFog as THREE.FogExp2).isFogExp2) {
    const density = (reference("density", "float", sceneFog) as N).setGroup(renderGroup);
    const d = density.mul(distance);
    return { color, factor: float(1).sub(d.mul(d).negate().exp()) };
  }
  if ((sceneFog as THREE.Fog).isFog) {
    const near = (reference("near", "float", sceneFog) as N).setGroup(renderGroup);
    const far = (reference("far", "float", sceneFog) as N).setGroup(renderGroup);
    return { color, factor: smoothstep(near, far, distance) };
  }
  return null;
}

function landmarkSetupFog(reachU: N, silhouetteU: N): (builder: N, outputNode: N) => N {
  return (builder: N, outputNode: N): N => {
    const parts = sceneFogParts(builder);
    if (!parts) {
      // whatever fog this is, draw it as the scene does (NodeMaterial.setupFog)
      if (builder.fogNode) {
        output.assign(outputNode);
        return vec4(builder.fogNode.toVar());
      }
      return outputNode;
    }
    output.assign(outputNode);
    const base: N = clamp(parts.factor as N, 0, 1);
    const distance: N = positionWorld.distance(cameraPosition);
    const reach: N = max(reachU, 1);
    const tau: N = log(max(float(1).sub(base), MIN_TRANSMITTANCE)).negate();
    const tauL: N = min(tau, max(tau.mul(LANDMARK_MIN_FOG_SHARE), distance.mul(REACH_DEPTH).div(reach)));
    const factor: N = max(tauL.negate().exp().oneMinus(), smoothstep(reach.mul(FADE_START), reach, distance));
    const tone: N = silhouetteU.mul(smoothstep(reach.mul(TONE_FADE_START), reach, distance).oneMinus());
    const fogColor: N = (parts.color as N).mul(float(1).sub(tone.mul(MAX_DARKEN)));
    let rgb: N = mix(output.rgb, fogColor, factor);
    if (parts.glow) rgb = rgb.add(parts.glow as N);
    return vec4(rgb, output.a);
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const SOURCE = "landmarkFogSource";
const variants = new WeakMap<THREE.Material, Map<string, THREE.Material>>();
let variantCount = 0;

/** How many landmark fog variants exist (tests, the draw/pipeline budget). */
export function landmarkFogVariantCount(): number {
  return variantCount;
}

/** The material a landmark variant was made from (itself when it is not one). */
export function landmarkFogSource(material: THREE.Material): THREE.Material {
  return (material.userData[SOURCE] as THREE.Material | undefined) ?? material;
}

/** The cached landmark variant of `material` (a source material, or a variant of one). */
export function landmarkFogMaterial(material: THREE.Material, settings: LandmarkFog): THREE.Material {
  const source = landmarkFogSource(material);
  if ((source as THREE.Material & { fog?: boolean }).fog === false) return source; // a material that opted out of fog stays out
  // Light cards keep ordinary atmospheric extinction. A landmark's darker
  // fog colour would turn their whole transparent quad into a visible sheet.
  if (source.blending === THREE.AdditiveBlending) return source;
  const key = landmarkFogKey(settings);
  let byKey = variants.get(source);
  if (!byKey) variants.set(source, (byKey = new Map()));
  const cached = byKey.get(key);
  if (cached) return cached;
  const variant = cloneMaterial(source);
  variant.name = source.name;
  variant.userData = { ...source.userData, [SOURCE]: source };
  const [reach, silhouette] = key.split(":").map(Number) as [number, number];
  const reachU = uniform(reach);
  const silhouetteU = uniform(Math.min(1, Math.max(0, silhouette)));
  const host = variant as THREE.Material & { setupFog?: unknown };
  host.setupFog = landmarkSetupFog(reachU, silhouetteU);
  const baseKey = source.customProgramCacheKey.bind(variant);
  const cacheKey = (): string => `${baseKey()}|landmark-fog`;
  variant.customProgramCacheKey = cacheKey;
  // A source whose texture maps are still loading has its flat graph; a clone taken now kept it forever and the
  // landmark drew its untextured colour (pale stone read as blank white slabs). Re-sync in place when they land;
  // Material.copy overwrites the fog hook, the cache key, name and userData, so they are put back.
  onMaterialMapsWired(source, () => {
    const fresh = cloneMaterial(source);
    variant.copy(fresh);
    variant.alphaTest = fresh.alphaTest;
    variant.name = source.name;
    variant.userData = { ...source.userData, [SOURCE]: source };
    host.setupFog = landmarkSetupFog(reachU, silhouetteU);
    variant.customProgramCacheKey = cacheKey;
    variant.needsUpdate = true;
    fresh.dispose();
  });
  byKey.set(key, variant);
  variantCount++;
  return variant;
}

/**
 * Point a renderable at its landmark variants (`settings`) or back at its
 * source materials (null). Idempotent; only the reference changes, never the
 * shared material.
 */
export function applyLandmarkFog(node: THREE.Object3D, settings: LandmarkFog | null): void {
  const mesh = node as THREE.Mesh;
  const current = mesh.material as THREE.Material | THREE.Material[] | undefined;
  if (!current) return;
  const swap = (m: THREE.Material): THREE.Material => (settings ? landmarkFogMaterial(m, settings) : landmarkFogSource(m));
  if (Array.isArray(current)) {
    const next = current.map(swap);
    if (next.some((m, i) => m !== current[i])) mesh.material = next;
  } else {
    const next = swap(current);
    if (next !== current) mesh.material = next;
  }
}
