import * as THREE from "three/webgpu";

/**
 * Image-based lighting for `sky.environment`.
 *
 * THE PROBLEM THIS EXISTS TO FIX: a PBR metal is nothing but its reflection.
 * With no environment map, `metalness: 1` has nothing to reflect and renders
 * near-black, which reads as "the material is broken" rather than "the scene
 * is unlit". That is why `sky.environment.mode` defaults to `"sky"` — the one
 * schema default that deliberately changes how existing scenes render.
 *
 * HOW THE PREFILTER HAPPENS: three's node pipeline PMREM-prefilters
 * `scene.environment` itself (`EnvironmentNode` -> `pmremTexture()`), keyed by
 * texture identity in a per-renderer WeakMap. So the cache discipline that
 * matters is OURS: return the SAME `THREE.Texture` object whenever the sky
 * parameters have not changed, and three never re-prefilters. Handing back a
 * freshly built (but identical) texture every frame would silently re-run a
 * full PMREM chain per frame — the exact failure this module's cache key
 * exists to prevent. `prefilter()` can additionally do the PMREM eagerly, to
 * move that one-off cost off the first frame a metal becomes visible.
 *
 * The `"sky"` source is generated on the CPU as a small equirectangular
 * float texture from the same gradient maths the sky dome shades with
 * (`buildSkyDome` in scene-builder.ts), so the reflections always agree with
 * the visible background. It is small on purpose: PMREM blurs everything
 * except the mirror-roughness level anyway, and the sun disc is the only
 * high-frequency feature, which `SKY_ENVIRONMENT_SIZE` still resolves.
 */

/** `sky.environment`, zod-defaulted. */
export interface EnvironmentSettings {
  mode: "none" | "sky" | "hdri";
  hdri?: string | undefined;
  intensity: number;
  /** Yaw around world Y, radians. */
  rotation: number;
}

/** The subset of `sky` that can source an environment. */
export interface SkyEnvironmentSource {
  top: string;
  bottom: string;
  texture?: string | undefined;
  cubemap?: { px: string; nx: string; py: string; ny: string; pz: string; nz: string } | undefined;
  sun?: { direction: [number, number, number]; color: string; size: number; intensity: number } | undefined;
}

export interface EnvironmentResult {
  /** null means "no IBL" — `mode: "none"`, or an async source still loading. */
  texture: THREE.Texture | null;
  intensity: number;
  /** Radians of yaw; feed `scene.environmentRotation.y`. */
  rotation: number;
}

export const NO_ENVIRONMENT: EnvironmentResult = { texture: null, intensity: 1, rotation: 0 };

/**
 * Equirect size for the generated sky environment. 256x128 RGBA-float is 512 KB
 * and ~2 ms of CPU to fill; going higher buys nothing once PMREM has run, and
 * this is regenerated on every sky edit while someone drags a colour picker.
 */
export const SKY_ENVIRONMENT_SIZE = { width: 256, height: 128 };

/**
 * Everything that changes the generated environment, and nothing that does
 * not. `rotation` and `intensity` are excluded deliberately: both are applied
 * on the scene (`environmentRotation` / `environmentIntensity`) without
 * touching the texture, so dragging either must not invalidate the PMREM.
 */
export function environmentCacheKey(sky: SkyEnvironmentSource | null, settings: EnvironmentSettings): string {
  if (settings.mode === "none") return "none";
  if (settings.mode === "hdri") return `hdri:${settings.hdri ?? ""}`;
  if (!sky) return "none";
  if (sky.cubemap) {
    const c = sky.cubemap;
    return `cube:${c.px}|${c.nx}|${c.py}|${c.ny}|${c.pz}|${c.nz}`;
  }
  if (sky.texture) return `equirect:${sky.texture}`;
  const sun = sky.sun
    ? `${sky.sun.direction.join(",")}|${sky.sun.color}|${sky.sun.size}|${sky.sun.intensity}`
    : "none";
  return `gradient:${sky.top}|${sky.bottom}|${sun}`;
}

/**
 * Fill an equirectangular RGBA float buffer with the sky gradient.
 *
 * This mirrors `buildSkyDome`'s TSL shader line for line — vertical gradient
 * with the same 0.35/1.35/0.9 remap, the same horizon haze band, the same sun
 * glow exponent. If the dome's shading is ever changed, change this with it or
 * the reflections stop matching the background, which reads as wrong long
 * before anyone can say why.
 *
 * Values are LINEAR (`THREE.Color` converts the sRGB hex on construction), so
 * the texture must be tagged `LinearSRGBColorSpace`.
 */
export function skyEquirectData(
  sky: SkyEnvironmentSource,
  width = SKY_ENVIRONMENT_SIZE.width,
  height = SKY_ENVIRONMENT_SIZE.height,
): Float32Array {
  const data = new Float32Array(width * height * 4);
  const top = new THREE.Color(sky.top || "#5fa9ff");
  const bottom = new THREE.Color(sky.bottom || "#101522");
  const sun = sky.sun;
  const sunColor = sun ? new THREE.Color(sun.color) : null;
  const sunDirection = sun
    ? new THREE.Vector3(sun.direction[0], sun.direction[1], sun.direction[2]).normalize()
    : null;
  const sunExponent = sun ? 1 / Math.max(1e-4, 1 - sun.size) : 0;

  for (let y = 0; y < height; y++) {
    // Equirect convention matching THREE.EquirectangularReflectionMapping:
    // v = 0 at the top of the image is +Y.
    const theta = ((y + 0.5) / height) * Math.PI;
    const sinTheta = Math.sin(theta);
    const dirY = Math.cos(theta);
    for (let x = 0; x < width; x++) {
      const phi = ((x + 0.5) / width) * Math.PI * 2 - Math.PI;
      const dirX = sinTheta * Math.sin(phi);
      const dirZ = sinTheta * Math.cos(phi);

      const t = Math.pow(THREE.MathUtils.clamp((dirY + 0.35) * (1 / 1.35), 0, 1), 0.9);
      let r = bottom.r + (top.r - bottom.r) * t;
      let g = bottom.g + (top.g - bottom.g) * t;
      let b = bottom.b + (top.b - bottom.b) * t;

      const haze = (1 - THREE.MathUtils.smoothstep(Math.abs(dirY), 0, 0.22)) * 0.6;
      r += (bottom.r - r) * haze;
      g += (bottom.g - g) * haze;
      b += (bottom.b - b) * haze;

      if (sunDirection && sunColor && sun) {
        const facing = THREE.MathUtils.clamp(
          dirX * sunDirection.x + dirY * sunDirection.y + dirZ * sunDirection.z,
          0,
          1,
        );
        const glow = Math.pow(facing, sunExponent) * sun.intensity;
        r += sunColor.r * glow;
        g += sunColor.g * glow;
        b += sunColor.b * glow;
      }

      const offset = (y * width + x) * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = 1;
    }
  }
  return data;
}

/** Build the generated-sky environment texture. Caller owns disposal. */
export function skyEnvironmentTexture(sky: SkyEnvironmentSource): THREE.DataTexture {
  const { width, height } = SKY_ENVIRONMENT_SIZE;
  const texture = new THREE.DataTexture(
    skyEquirectData(sky, width, height),
    width,
    height,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  texture.name = "sky-environment";
  return texture;
}

/**
 * Generated sky textures, shared across every `EnvironmentSystem`.
 *
 * Module-level because a full scene rebuild — which any structural edit forces
 * — builds a fresh scene and a fresh system. Deriving an identical-but-new
 * texture each time would re-run three's PMREM chain (keyed by texture
 * identity) and flag every PBR material for a shader recompile, on every
 * rebuild. Returning the same object makes both a no-op.
 *
 * Capped and LRU-evicted so dragging a sky colour picker cannot grow it
 * without bound; the evicted entry is by construction not one of the last
 * `SKY_TEXTURE_CACHE_LIMIT` skies anyone asked for.
 */
const SKY_TEXTURE_CACHE_LIMIT = 6;
const skyTextureCache = new Map<string, THREE.DataTexture>();

export function cachedSkyEnvironmentTexture(key: string, sky: SkyEnvironmentSource): THREE.DataTexture {
  const hit = skyTextureCache.get(key);
  if (hit) {
    skyTextureCache.delete(key); // re-insert: Map iterates in insertion order, so this is the LRU touch
    skyTextureCache.set(key, hit);
    return hit;
  }
  const texture = skyEnvironmentTexture(sky);
  skyTextureCache.set(key, texture);
  for (const oldest of skyTextureCache.keys()) {
    if (skyTextureCache.size <= SKY_TEXTURE_CACHE_LIMIT) break;
    skyTextureCache.get(oldest)?.dispose();
    skyTextureCache.delete(oldest);
  }
  return texture;
}

/** Test seam: drop every cached sky texture. */
export function clearSkyEnvironmentCache(): void {
  for (const texture of skyTextureCache.values()) texture.dispose();
  skyTextureCache.clear();
}

/**
 * Average linear luminance of an equirect buffer. Exists so a test can assert
 * the non-obvious property that actually matters: the environment carries real
 * energy, which is the difference between a metal that reflects and one that
 * renders black.
 */
export function averageLuminance(data: Float32Array): number {
  let sum = 0;
  const pixels = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    sum += 0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0);
  }
  return pixels > 0 ? sum / pixels : 0;
}

/**
 * Push an environment onto a scene.
 *
 * Kept separate from the system so the material/build seam can consume
 * `EnvironmentResult` however it likes (a per-material `envMap`, a scene-level
 * environment, or both) without this module having to know which.
 *
 * CAUTION for the material path: three's `materialEnvIntensity` reads
 * `scene.environmentIntensity` only while `material.envMap === null`. A
 * material that sets its own `envMap` silently stops honouring
 * `sky.environment.intensity` and uses `material.envMapIntensity` instead.
 */
export function applyEnvironment(scene: THREE.Scene, result: EnvironmentResult): void {
  scene.environment = result.texture;
  scene.environmentIntensity = result.intensity;
  scene.environmentRotation.set(0, result.rotation, 0);
}

type TextureResolver = (assetId: string) => string | undefined;

export interface EnvironmentOptions {
  /** Asset id -> URL, same contract as `BuildOptions.resolveTexture`. */
  resolveTexture?: TextureResolver | undefined;
  /**
   * Called when an async source (HDRI, panorama, cubemap) finishes loading and
   * the result changes after `update()` already returned. The host re-applies.
   */
  onChange?: ((result: EnvironmentResult) => void) | undefined;
}

/**
 * Owns the environment texture for one scene and rebuilds it only when the
 * sky parameters that feed it actually change.
 */
export class EnvironmentSystem {
  private key = "";
  private result: EnvironmentResult = { ...NO_ENVIRONMENT };
  /** Textures this system created and must dispose; loaded ones included. */
  private owned: THREE.Texture | null = null;
  private prefiltered: THREE.RenderTarget | null = null;
  private generation = 0;

  constructor(private options: EnvironmentOptions = {}) {}

  get current(): EnvironmentResult {
    return this.result;
  }

  /**
   * Resolve the environment for a sky. Cheap and idempotent: when
   * `environmentCacheKey` is unchanged, the SAME texture object comes back and
   * three's PMREM cache is untouched — only `intensity`/`rotation` are
   * refreshed.
   */
  update(sky: SkyEnvironmentSource | null, settings: EnvironmentSettings): EnvironmentResult {
    const key = environmentCacheKey(sky, settings);
    if (key === this.key) {
      this.result = {
        texture: this.result.texture,
        intensity: settings.intensity,
        rotation: settings.rotation,
      };
      return this.result;
    }

    this.key = key;
    this.generation++;
    this.releaseTextures();
    this.result = { texture: null, intensity: settings.intensity, rotation: settings.rotation };

    if (settings.mode === "none" || key === "none") return this.result;

    if (settings.mode === "hdri") {
      if (settings.hdri) this.loadEquirect(settings.hdri, this.generation);
      return this.result;
    }

    // mode "sky": follow the same source priority the background uses, so the
    // reflections and the visible sky can never disagree.
    if (sky?.cubemap) {
      this.loadCubemap(sky.cubemap, this.generation);
      return this.result;
    }
    if (sky?.texture) {
      this.loadEquirect(sky.texture, this.generation);
      return this.result;
    }
    if (sky) {
      // Shared, so `this.owned` stays null — this system must not dispose it.
      const texture = cachedSkyEnvironmentTexture(key, sky);
      this.result = { texture, intensity: settings.intensity, rotation: settings.rotation };
    }
    return this.result;
  }

  /**
   * Run the PMREM prefilter now instead of letting three run it lazily on the
   * first frame a PBR material is drawn. Optional: correctness does not depend
   * on it, but the lazy path spends its cost inside a frame, which shows up as
   * a hitch the first time a metal enters view (and again after every sky
   * edit). Safe to call with an uninitialised renderer — it no-ops.
   *
   * DELIBERATELY NOT CALLED by `SceneLighting`. Once generated sky textures are
   * shared across builds (`cachedSkyEnvironmentTexture`), three's own PMREM
   * cache — a WeakMap keyed by texture identity — already survives every scene
   * rebuild, so the hitch happens once per sky for the whole session either
   * way. Owning a `RenderTarget` per scene to save that one occurrence would
   * cost a VRAM leak on every rebuild, since the host discards built scenes
   * without disposing them. Kept for a host that wants to pay it explicitly.
   */
  prefilter(renderer: THREE.WebGPURenderer): EnvironmentResult {
    const source = this.owned ?? this.result.texture;
    if (!source || this.prefiltered) return this.result;
    let generator: THREE.PMREMGenerator | null = null;
    try {
      generator = new THREE.PMREMGenerator(renderer);
      const target =
        source instanceof THREE.CubeTexture
          ? generator.fromCubemap(source)
          : generator.fromEquirectangular(source);
      this.prefiltered = target;
      this.result = { ...this.result, texture: target.texture };
    } catch (error) {
      // Backend not initialised yet, or a backend that cannot do it — the lazy
      // path in three still works, so this is a missed optimisation, not a bug.
      console.warn("[render] environment prefilter unavailable; falling back to lazy PMREM:", error);
    } finally {
      generator?.dispose();
    }
    return this.result;
  }

  dispose(): void {
    this.releaseTextures();
    this.key = "";
    this.result = { ...NO_ENVIRONMENT };
  }

  private releaseTextures(): void {
    this.prefiltered?.dispose();
    this.prefiltered = null;
    this.owned?.dispose();
    this.owned = null;
  }

  private publish(texture: THREE.Texture, generation: number): void {
    // A newer update() already replaced this request — drop the late arrival
    // rather than stomping the current environment with a stale one.
    if (generation !== this.generation) {
      texture.dispose();
      return;
    }
    this.owned = texture;
    this.result = { ...this.result, texture };
    this.options.onChange?.(this.result);
  }

  private loadEquirect(assetId: string, generation: number): void {
    const url = this.options.resolveTexture?.(assetId);
    if (!url) {
      console.warn(`[render] no URL for environment texture "${assetId}"`);
      return;
    }
    void loadEquirectTexture(url).then(
      (texture) => this.publish(texture, generation),
      (error) => console.warn(`[render] environment texture failed: ${url}`, error),
    );
  }

  private loadCubemap(
    cubemap: { px: string; nx: string; py: string; ny: string; pz: string; nz: string },
    generation: number,
  ): void {
    const urls = (["px", "nx", "py", "ny", "pz", "nz"] as const).map((face) =>
      this.options.resolveTexture?.(cubemap[face]),
    );
    if (!urls.every((url): url is string => !!url)) {
      console.warn("[render] environment cubemap has unresolved faces");
      return;
    }
    new THREE.CubeTextureLoader().load(
      urls,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        this.publish(texture, generation);
      },
      undefined,
      (error) => console.warn("[render] environment cubemap failed", error),
    );
  }
}

/**
 * Load an equirect environment source. `.hdr`/`.exr` go through the loaders
 * that preserve range — an 8-bit jpg/png loads too, but its clipped highlights
 * give dull reflections and no usable specular punch, which is why the schema
 * says so out loud.
 */
export async function loadEquirectTexture(url: string): Promise<THREE.Texture> {
  const lower = url.split("?")[0]?.toLowerCase() ?? "";
  let texture: THREE.Texture;
  if (lower.endsWith(".hdr")) {
    const { RGBELoader } = await import("three/addons/loaders/RGBELoader.js");
    texture = await new RGBELoader().loadAsync(url);
  } else if (lower.endsWith(".exr")) {
    const { EXRLoader } = await import("three/addons/loaders/EXRLoader.js");
    texture = await new EXRLoader().loadAsync(url);
  } else {
    texture = await new THREE.TextureLoader().loadAsync(url);
    texture.colorSpace = THREE.SRGBColorSpace;
  }
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.needsUpdate = true;
  return texture;
}
