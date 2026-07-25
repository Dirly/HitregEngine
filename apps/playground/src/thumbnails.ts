import * as THREE from "three/webgpu";
import { clone as skeletonClone } from "three/addons/utils/SkeletonUtils.js";
import { expandScene, type AssetLibrary, type ComponentRegistry } from "@hitreg/core";
import { buildScene, loadGltf, makeMaterial, type Backend, type EngineRenderer, type MaterialData } from "@hitreg/render";
import type { Observable } from "@hitreg/editor";
import { getThumb, putThumb } from "./thumbnail-cache.js";

/**
 * Yield the main thread between GPU bakes. Each bake is a buildScene + offscreen
 * render + pixel readback (a GPU sync roundtrip) on the same renderer drawing
 * the viewport; running dozens back-to-back at boot starves the render loop and
 * input. Draining one per idle slot keeps the editor interactive while
 * thumbnails fill in progressively.
 */
function idle(): Promise<void> {
  return new Promise((resolve) => {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void })
      .requestIdleCallback;
    if (ric) ric(() => resolve(), { timeout: 100 });
    else setTimeout(resolve, 0);
  });
}

// -- prefab thumbnails: render each prefab to a tiny offscreen target -------

const THUMB = 96;

/** Frame `object` in a 3/4 studio view and rasterize it to a PNG data URL. */
async function snapshotObject(renderer: EngineRenderer, backend: Backend, object: THREE.Object3D): Promise<string> {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0e14);
  scene.add(new THREE.AmbientLight(0xffffff, 1.2));
  const sun = new THREE.DirectionalLight(0xfff5e0, 2);
  sun.position.set(3, 5, 4);
  scene.add(sun);
  scene.add(object);

  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3()).length() || 1;
  const center = box.getCenter(new THREE.Vector3());
  const cam = new THREE.PerspectiveCamera(45, 1, 0.01, size * 10);
  cam.position.copy(center).add(new THREE.Vector3(size * 0.7, size * 0.55, size * 0.7));
  cam.lookAt(center);

  const target = new THREE.RenderTarget(THUMB, THUMB);
  renderer.renderer.setRenderTarget(target);
  renderer.renderer.render(scene, cam);
  const pixels = (await renderer.renderer.readRenderTargetPixelsAsync(
    target,
    0,
    0,
    THUMB,
    THUMB,
  )) as Uint8Array;
  renderer.renderer.setRenderTarget(null);
  target.dispose();

  const canvas2d = document.createElement("canvas");
  canvas2d.width = THUMB;
  canvas2d.height = THUMB;
  const ctx = canvas2d.getContext("2d")!;
  const image = ctx.createImageData(THUMB, THUMB);
  // WebGPU copies each row into a buffer aligned to 256 bytes;
  // `readRenderTargetPixelsAsync()` returns that padded buffer verbatim.
  // Treating it as tightly packed RGBA made every following row start 128
  // bytes early at our 96px thumbnail size, producing horizontal strips.
  // WebGPU uses top-left row order, while the WebGL fallback is bottom-up.
  const bytesPerPixel = 4; // RenderTarget's default RGBA UnsignedByteType
  const sourceRowStride = Math.ceil((THUMB * bytesPerPixel) / 256) * 256;
  const destinationRowStride = THUMB * bytesPerPixel;
  for (let y = 0; y < THUMB; y++) {
    const sourceY = backend === "webgl" ? THUMB - 1 - y : y;
    const src = sourceY * sourceRowStride;
    image.data.set(
      pixels.subarray(src, src + destinationRowStride),
      y * destinationRowStride,
    );
  }
  ctx.putImageData(image, 0, 0);
  return canvasToDataURLAsync(canvas2d);
}

/**
 * `canvas.toDataURL()` PNG-encodes synchronously on the main thread — proven
 * (via a CPU profile of the exact hang this fixes) to be the single largest
 * cost of a cold-cache thumbnail pass: ~33% of a ~19s main-thread block that
 * showed up to the user as Firefox's "this page is slowing down" warning,
 * with no way to yield mid-encode since it's one synchronous call. `toBlob()`
 * does the same PNG encode off the main thread; `FileReader.readAsDataURL`
 * is also async — together they keep the render loop and input responsive
 * during a bake instead of freezing for however long the encode takes.
 */
function canvasToDataURLAsync(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("canvas.toBlob() returned null"));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
      reader.readAsDataURL(blob);
    });
  });
}

function buildStreetDocEmpty(prefabId: string) {
  const { doc: d } = (() => {
    const empty = { version: 1 as const, name: "thumb", entities: {} };
    return {
      doc: {
        ...empty,
        entities: {
          subject: {
            name: "Subject",
            parent: null,
            tags: [],
            components: { transform: {}, prefab: { prefabId, props: {}, overrides: [] } },
          },
        },
      },
    };
  })();
  return d;
}

export interface RenderThumbnailsDeps {
  assets: AssetLibrary;
  registry: ComponentRegistry;
  renderer: EngineRenderer;
  backend: Backend;
  thumbnails: Observable<Record<string, string>>;
}

// renderThumbnails is triggered from boot AND every assetsVersion bump; now
// that a pass yields between bakes, two could interleave and double-bake the
// same assets. Coalesce: while one pass runs, further requests set a rerun flag
// and share its promise; a single follow-up pass then picks up anything added
// meanwhile.
let inFlight: Promise<void> | null = null;
let rerunRequested = false;

export function renderThumbnails(deps: RenderThumbnailsDeps): Promise<void> {
  if (inFlight) {
    rerunRequested = true;
    return inFlight;
  }
  inFlight = (async () => {
    do {
      rerunRequested = false;
      await renderThumbnailsOnce(deps);
    } while (rerunRequested);
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function renderThumbnailsOnce(deps: RenderThumbnailsDeps): Promise<void> {
  const { assets, registry, renderer, backend, thumbnails } = deps;
  const out: Record<string, string> = { ...thumbnails.get() };
  let changed = false;

  /**
   * Fill `out[id]` for one asset, doing the expensive GPU bake only when both
   * the in-memory marker AND the persistent cache miss the current content key.
   * `cacheKey` is content-derived and namespaced, so a hit restores a prior
   * bake across reloads without touching the GPU. Every real bake yields first
   * so the boot render loop stays live. Returns true if `out` changed.
   */
  async function fill(
    id: string,
    marker: string,
    contentKey: string,
    cacheKey: string,
    bake: () => Promise<string>,
  ): Promise<void> {
    if (out[marker] === contentKey && out[id]) return; // already current in memory
    const cached = await getThumb(cacheKey);
    if (cached) {
      out[id] = cached;
      out[marker] = contentKey;
      changed = true;
      return;
    }
    await idle(); // unblock the viewport before the GPU roundtrip
    const dataUrl = await bake();
    out[id] = dataUrl;
    out[marker] = contentKey;
    changed = true;
    void putThumb(cacheKey, dataUrl);
  }

  for (const pid of assets.prefabIds()) {
    try {
      const json = JSON.stringify(assets.getPrefab(pid));
      const contentKey = `${pid}:${json.length}`;
      await fill(pid, `__key_${pid}`, contentKey, `p:${pid}:${hash(json)}`, async () => {
        const expanded = expandScene(buildStreetDocEmpty(pid), assets, registry);
        const thumb = buildScene(expanded, { resolveMaterial: (id) => assets.getDataAsset(id)?.data });
        return snapshotObject(renderer, backend, thumb.scene);
      });
    } catch (error) {
      console.warn(`[thumbnails] failed for prefab ${pid}:`, error);
    }
  }

  for (const mid of assets.modelIds()) {
    try {
      const model = assets.getModel(mid);
      if (!model) continue;
      await fill(mid, `__key_model_${mid}`, model.url, `m:${model.url}`, async () => {
        const gltf = await loadGltf(model.url);
        // the cache shares one loaded scene: always render a skeleton-safe clone
        return snapshotObject(renderer, backend, skeletonClone(gltf.scene));
      });
    } catch (error) {
      console.warn(`[thumbnails] failed for model ${mid}:`, error);
    }
  }

  for (const asset of assets.dataAssetsOfType("material")) {
    try {
      const json = JSON.stringify(asset.data);
      await fill(asset.id, `__key_material_${asset.id}`, json, `mat:${asset.id}:${hash(json)}`, async () => {
        const data = asset.data as MaterialData;
        const material = makeMaterial(data) as THREE.Material & { map?: THREE.Texture | null };
        const textureUrl = data.map ? assets.getTexture(data.map)?.url : undefined;
        if (textureUrl && data.shader !== "wireframe") {
          // snapshot is one-shot (no render loop to pick up a later-arriving
          // texture), so wait for it instead of the fire-and-forget helper
          const texture = await new THREE.TextureLoader().loadAsync(textureUrl);
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.wrapS = THREE.RepeatWrapping;
          texture.wrapT = THREE.RepeatWrapping;
          const [rx, ry] = data.repeat ?? [1, 1];
          texture.repeat.set(rx, ry);
          material.map = texture;
          material.needsUpdate = true;
        }
        const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), material);
        return snapshotObject(renderer, backend, sphere);
      });
    } catch (error) {
      console.warn(`[thumbnails] failed for material ${asset.id}:`, error);
    }
  }

  if (changed) thumbnails.set(out);
}

/** Small stable string hash (FNV-1a) for namespacing persistent cache keys. */
function hash(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
