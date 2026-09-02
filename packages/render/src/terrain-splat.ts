import * as THREE from "three/webgpu";
import {
  add,
  attribute,
  clamp,
  color as tslColor,
  float,
  max,
  mix,
  mul,
  mx_fractal_noise_float,
  mx_fractal_noise_vec3,
  normalWorld,
  positionWorld,
  sin,
  smoothstep,
  sub,
  vec3,
  vec4,
} from "three/tsl";
import {
  decodeNormalSample,
  loadSharedTexture,
  sampleTriplanar,
  triplanarNormalToWorld,
  worldNormalToViewNode,
  worldTriplanarBasis,
  type TextureFilter,
  type TextureResolver,
  type TriplanarBasis,
} from "./material-maps.js";
import type { MaterialData } from "./scene-builder.js";

/**
 * The `terrain-splat` shader: a palette of surfaces blended into one material.
 *
 * Two weight sources, and the difference matters:
 *
 * - **`height`** (the original): each layer overtakes the previous through its
 *   own height band. Perfect for a heightmap island, useless for a real world
 *   — a desert and a snowfield at the same altitude cannot look different.
 * - **`vertex`**: the mesh carries a per-vertex vec4 that the world recipe's
 *   biome rules produced (temperature, moisture, altitude, slope), so what a
 *   place looks like is decided by what KIND of place it is. This is the path
 *   marching-cubes voxel terrain uses.
 *
 * Textures are sampled TRIPLANAR, per layer, at each layer's own world scale.
 * That is not a stylistic choice: marching-cubes terrain has cliffs, caves and
 * overhangs and simply has no UV unwrap to sample with. It also happens to be
 * what keeps a texture continuous across a chunk seam, since world-space
 * projection knows nothing about where one cell ends.
 *
 * Cost is honest and worth stating: N layers with albedo = 3N texture fetches,
 * doubling with normal maps. Four textured layers is 12 fetches (24 with
 * normals) per fragment, eight is 24, sixteen is 48 — fine for ground at the
 * low end, and something to measure before committing at the high end. It
 * would be ruinous pointed at anything instanced.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

interface SplatLayerData {
  color: string;
  roughness: number;
  heightStart: number;
  heightEnd: number;
  grassy?: boolean;
  map?: string;
  normalMap?: string;
  uvScale?: number;
}

export interface MacroNoiseData {
  scale: number;
  strength: number;
  octaves: number;
  detailScale?: number;
  detailStrength: number;
  roughnessStrength: number;
  warp?: number;
  warpScale?: number;
  colorStrength?: number;
  colorScale?: number;
  colorOctaves?: number;
}

export interface SplatData {
  source?: "height" | "vertex";
  layers: SplatLayerData[];
  slopeRock?: { color: string; roughness: number; start: number; end: number };
  tintByVertexColor?: boolean;
  macroNoise?: MacroNoiseData;
}

/**
 * Per-vertex splat weights written by the voxel mesher, four surfaces each.
 *
 * A vertex attribute is four components, so a palette of N surfaces rides in
 * ceil(N / 4) of these. The mesher emits exactly that many — no more, so a
 * four-surface world carries one vec4, and no fewer, so every cell of a world
 * declares the same attributes and HLOD can merge them.
 */
export const SPLAT_ATTRIBUTES = ["splatWeight", "splatWeight2", "splatWeight3", "splatWeight4"] as const;
/** Surfaces 0-3. */
export const SPLAT_ATTRIBUTE = SPLAT_ATTRIBUTES[0];
/** Surfaces 4-7. */
export const SPLAT_ATTRIBUTE_HI = SPLAT_ATTRIBUTES[1];
/** Palette channels one vertex attribute can carry. */
export const SPLAT_ATTRIBUTE_WIDTH = 4;

/**
 * Normalized layer weights, whichever source the material declares.
 *
 * The `vertex` branch renormalizes and falls back to layer 0 when the
 * attribute is missing or zero — three warns and substitutes a zero constant
 * for an absent attribute, and an unguarded divide would render the terrain
 * black rather than merely wrong.
 */
function layerWeights(data: SplatData, layerCount: number): N[] {
  if (data.source === "vertex") {
    const vecs = Math.min(
      SPLAT_ATTRIBUTES.length,
      Math.ceil(layerCount / SPLAT_ATTRIBUTE_WIDTH),
    );
    const attrs: N[] = [];
    for (let v = 0; v < vecs; v++) attrs.push(attribute(SPLAT_ATTRIBUTES[v]!, "vec4"));
    let sum: N = add(add(attrs[0].x, attrs[0].y), add(attrs[0].z, attrs[0].w));
    for (let v = 1; v < attrs.length; v++) {
      sum = add(sum, add(add(attrs[v].x, attrs[v].y), add(attrs[v].z, attrs[v].w)));
    }
    // Renormalise, and fall back to layer 0 when the attribute is missing or
    // all zero — three substitutes a zero constant for an absent attribute, and
    // an unguarded divide would render the terrain black rather than wrong.
    const present: N = smoothstep(float(0), float(1e-3), sum);
    const inv: N = float(1).div(max(sum, float(1e-4)));
    const out: N[] = [];
    for (let v = 0; v < attrs.length; v++) {
      const fallback: N = v === 0 ? vec4(1, 0, 0, 0) : vec4(0, 0, 0, 0);
      const safe: N = mix(fallback, attrs[v].mul(inv), present);
      out.push(safe.x, safe.y, safe.z, safe.w);
    }
    return out.slice(0, layerCount);
  }
  // height bands: layer i owns everything above its band, minus whatever the
  // layers above it take. Expressed as successive mixes, matching the original.
  const weights: N[] = [];
  let remaining: N = float(1);
  for (let i = layerCount - 1; i >= 1; i--) {
    const layer = data.layers[i]!;
    const t: N = smoothstep(float(layer.heightStart), float(layer.heightEnd), positionWorld.y);
    const w: N = mul(remaining, t);
    weights[i] = w;
    remaining = mul(remaining, sub(float(1), t));
  }
  weights[0] = remaining;
  return weights;
}

/** Cheap per-pixel mottling so an untextured green layer reads as grass. */
function grassyTone(): N {
  const n1: N = sin(add(mul(positionWorld.x, float(1.7)), mul(positionWorld.z, float(2.3))));
  const n2: N = sin(add(mul(positionWorld.x, float(-2.9)), mul(positionWorld.z, float(1.1))));
  return add(float(1), mul(add(n1, n2), float(0.06)));
}

/**
 * A world-space noise value in roughly -1..1 that breaks up texture repetition.
 *
 * Tiling is visible because the SAME pattern recurs on a fixed grid, so the eye
 * finds the grid rather than the texture. The fix is a second variation whose
 * period shares no factor with the tile — then there is no grid to find. Two
 * bands, because they solve different halves of the problem: the broad one
 * (~90m) kills "the same hillside forever" at distance, the detail one (~13m,
 * a couple of tiles) hides the grid underfoot. One band alone leaves the other
 * range untouched and reads as a stain rather than as ground.
 *
 * Deliberately NOT stochastic/hex-grid sampling, which is the other standard
 * answer: that triples the fetch count, and this material is already 24 fetches
 * a fragment at eight layers. Two gradient-noise evaluations fetch nothing.
 */
function macroNoiseValue(noise: MacroNoiseData): N {
  const broad: N = mx_fractal_noise_float(
    positionWorld.div(float(Math.max(noise.scale, 1e-3))),
    noise.octaves,
    2,
    0.5,
  ).mul(float(noise.strength));
  if (!noise.detailScale || noise.detailStrength <= 0) return broad;
  // Offset so the two bands cannot line up at the origin and cancel into a
  // single visible blotch there.
  const detail: N = mx_fractal_noise_float(
    positionWorld.div(float(Math.max(noise.detailScale, 1e-3))).add(vec3(17.3, 4.1, 29.7)),
    2,
    2,
    0.5,
  ).mul(float(noise.detailStrength));
  return add(broad, detail);
}

/**
 * Noise displacement applied to the texture projection before sampling, in
 * units of each layer's own tile (scaled per layer at the call site).
 *
 * The brightness overlay above can only shade OVER a tile grid; the grid is
 * still underneath it, and on a large flat-lit face seen from a distance the
 * eye finds it anyway. This moves the projection itself, so neighbouring tiles
 * stop lining up and there is no grid left to find.
 *
 * Cheap for what it does: one vec3 noise evaluation, shared by every layer,
 * and no extra texture fetches — the alternative that actually removes
 * repetition (stochastic/hex sampling) triples the fetch count on a material
 * already doing 24 of them.
 */
function triplanarWarpNoise(noise: MacroNoiseData | undefined): N | null {
  if (!noise?.warp || noise.warp <= 0) return null;
  const scale = Math.max(noise.warpScale ?? 40, 1e-3);
  return mx_fractal_noise_vec3(positionWorld.div(float(scale)), 2, 2, 0.5);
}

/**
 * Per-CHANNEL noise, so the overlay shifts colour and not only brightness.
 *
 * The scalar band above can only make ground lighter or darker, and a large
 * area varying in brightness alone still reads as one material under uneven
 * light rather than as varied ground. Letting the three channels drift apart
 * slightly — warmer here, greyer there — is what reads as the ground itself
 * being different from place to place, which is the actual complaint behind
 * "it all looks the same".
 *
 * Offset from the brightness band so the two cannot line up and turn every
 * dark patch the same colour.
 */
function macroTintValue(noise: MacroNoiseData): N | null {
  if (!noise.colorStrength || noise.colorStrength <= 0) return null;
  const scale = Math.max(noise.colorScale ?? noise.scale, 1e-3);
  return mx_fractal_noise_vec3(
    positionWorld.div(float(scale)).add(vec3(53.1, 11.7, 91.3)),
    noise.colorOctaves ?? 3,
    2,
    0.5,
  ).mul(float(noise.colorStrength));
}

/** Blend a list of per-layer nodes by the weights, as a weighted sum. */
function blend(values: N[], weights: N[]): N {
  let out: N = mul(values[0], weights[0]);
  for (let i = 1; i < values.length; i++) out = add(out, mul(values[i], weights[i]));
  return out;
}

/**
 * Build the material. Colours and roughness are wired synchronously; layer
 * textures load asynchronously and rewire the graph in ONE pass when they all
 * settle (a node material recompiles its pipeline per graph change, so wiring
 * four layers one at a time would mean four recompiles per material).
 */
export function buildTerrainSplatMaterial(
  data: MaterialData,
  options?: TextureResolver,
): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({
    transparent: data.transparent || data.opacity < 1,
    opacity: data.opacity,
    metalness: 0,
  });
  const splat = data.splat as SplatData | undefined;
  const layers = splat?.layers ?? [];
  if (!splat || layers.length === 0) {
    material.colorNode = tslColor(data.color);
    material.roughnessNode = float(data.roughness);
    return material;
  }

  wireSplat(material, data, splat, {});

  const textured = layers.some((layer) => layer.map || layer.normalMap);
  if (textured && options) void loadLayerTextures(material, data, splat, options);
  return material;
}

type LayerTextures = Record<number, { map?: THREE.Texture; normalMap?: THREE.Texture }>;

/** Wire the whole node graph for one set of resolved layer textures. */
function wireSplat(
  material: THREE.MeshStandardNodeMaterial,
  data: MaterialData,
  splat: SplatData,
  textures: LayerTextures,
): void {
  const layers = splat.layers;
  const weights = layerWeights(splat, layers.length);
  const bases = new Map<number, TriplanarBasis>();
  // ONE warp for every layer, in world units, built once. Per-layer warps would
  // slide the layers against each other and turn every biome border into a
  // fringe; and this is the expensive half of the noise work, so paying for it
  // once rather than per layer is the difference between cheap and not.
  const warpNoise = triplanarWarpNoise(splat.macroNoise);
  const warpFraction = splat.macroNoise?.warp ?? 0;
  const basisFor = (index: number): TriplanarBasis => {
    let basis = bases.get(index);
    if (!basis) {
      const scale = Math.max(layers[index]!.uvScale ?? 4, 1e-3);
      // scaled by THIS layer's tile size, so one setting means the same thing
      // to a 3.5m grass tile and a 9m cliff tile. A fixed world-unit warp has
      // to be sized to the smallest tile in the palette and then does nothing
      // for the largest — which is the one you read from a distance.
      basis = worldTriplanarBasis(float(scale), warpNoise ? warpNoise.mul(float(warpFraction * scale)) : null);
      bases.set(index, basis);
    }
    return basis;
  };

  const colors: N[] = layers.map((layer, i) => {
    const tint: N = tslColor(layer.color);
    const map = textures[i]?.map;
    if (map) return mul(sampleTriplanar(basisFor(i), map).xyz, tint);
    return layer.grassy ? mul(tint, grassyTone()) : tint;
  });
  const roughnesses: N[] = layers.map((layer) => float(layer.roughness));

  let colorNode: N = blend(colors, weights);
  let roughnessNode: N = blend(roughnesses, weights);

  const slope = splat.slopeRock;
  if (slope) {
    // steepness: 0 = flat (normal straight up), 1 = vertical (normal sideways)
    const steepness: N = clamp(sub(float(1), normalWorld.y), 0, 1);
    const t: N = smoothstep(float(slope.start), float(slope.end), steepness);
    colorNode = mix(colorNode, tslColor(slope.color), t);
    roughnessNode = mix(roughnessNode, float(slope.roughness), t);
  }

  if (splat.macroNoise && (splat.macroNoise.strength > 0 || (splat.macroNoise.colorStrength ?? 0) > 0)) {
    const n = macroNoiseValue(splat.macroNoise);
    // A multiply, so it reads as light and shade over the ground rather than as
    // a colour laid on it. Floored above zero: fractal noise can overshoot its
    // nominal range, and a negative factor is a black hole in the terrain.
    const tint = macroTintValue(splat.macroNoise);
    const brightness: N = add(float(1), n);
    colorNode = mul(
      colorNode,
      clamp(tint ? add(vec3(brightness, brightness, brightness), tint) : brightness, 0.05, 2),
    );
    if (splat.macroNoise.roughnessStrength > 0) {
      const swing = float(splat.macroNoise.roughnessStrength).div(
        float(Math.max(splat.macroNoise.strength, 1e-3)),
      );
      roughnessNode = clamp(add(roughnessNode, mul(n, swing)), 0.02, 1);
    }
  }

  if (splat.tintByVertexColor) {
    // per-biome tint the mesher wrote into COLOR_0 — what lets two biomes
    // share the grass channel and still read as different places
    colorNode = mul(colorNode, attribute("color", "vec3"));
  }

  material.colorNode = colorNode;
  material.roughnessNode = roughnessNode;

  // normals only if at least one layer supplied one; blending a normal map
  // across layers that mostly lack one just flattens the ones that have it
  const normalLayers = layers.map((_, i) => textures[i]?.normalMap);
  if (normalLayers.some(Boolean)) {
    const strength = float(data.normalScale ?? 1);
    const worldNormals: N[] = layers.map((_, i) => {
      const tex = normalLayers[i];
      if (!tex) return normalWorld;
      const basis = basisFor(i);
      const samples: [N, N, N] = [
        decodeNormalSample(sampleTriplanar(basis, tex), strength),
        decodeNormalSample(sampleTriplanar(basis, tex), strength),
        decodeNormalSample(sampleTriplanar(basis, tex), strength),
      ];
      return triplanarNormalToWorld(basis, samples);
    });
    material.normalNode = worldNormalToViewNode(vec3(blend(worldNormals, weights)).normalize());
  }

  material.needsUpdate = true;
}

/** Track the newest wiring pass per material so a late load can't overwrite a newer one. */
const splatGeneration = new WeakMap<THREE.Material, number>();

async function loadLayerTextures(
  material: THREE.MeshStandardNodeMaterial,
  data: MaterialData,
  splat: SplatData,
  options: TextureResolver,
): Promise<void> {
  const generation = (splatGeneration.get(material) ?? 0) + 1;
  splatGeneration.set(material, generation);
  const maxAnisotropy = options.resolveMaxAnisotropy?.() ?? 0;
  const filter = (data.filter ?? "linear") as TextureFilter;

  const requests: { index: number; field: "map" | "normalMap"; url: string; srgb: boolean }[] = [];
  splat.layers.forEach((layer, index) => {
    for (const field of ["map", "normalMap"] as const) {
      const assetId = layer[field];
      if (!assetId) continue;
      const url = options.resolveTexture?.(assetId);
      if (!url) {
        console.warn(`[render] no texture asset "${assetId}" for splat layer ${index} ${field}`);
        continue;
      }
      requests.push({ index, field, url, srgb: field === "map" });
    }
  });
  if (requests.length === 0) return;

  const results = await Promise.allSettled(
    requests.map((request) => loadSharedTexture(request.url, request.srgb, maxAnisotropy, filter)),
  );
  if (splatGeneration.get(material) !== generation) return;

  const textures: LayerTextures = {};
  results.forEach((result, i) => {
    const request = requests[i]!;
    if (result.status !== "fulfilled") {
      console.warn(`[render] splat texture failed to load: ${request.url}`, result.reason);
      return;
    }
    // triplanar projects in world units, so a layer must tile in both axes
    result.value.wrapS = THREE.RepeatWrapping;
    result.value.wrapT = THREE.RepeatWrapping;
    const entry = (textures[request.index] ??= {});
    entry[request.field] = result.value;
  });
  if (Object.keys(textures).length === 0) return;
  wireSplat(material, data, splat, textures);
}
