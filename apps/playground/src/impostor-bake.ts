import * as THREE from "three/webgpu";
import { float, normalWorld, texture as tslTexture, uv, vec4 } from "three/tsl";
import type { EngineRenderer, ImpostorAtlas } from "@hitreg/render";
import {
  DEFAULT_IMPOSTOR_FRAME_SIZE,
  DEFAULT_IMPOSTOR_GRID,
  impostorFrameDirection,
  impostorFrameUp,
  vegetationMaterialRole,
} from "@hitreg/render";

// -- octahedral impostor baking: the model from 36 directions, twice ---------
// Same render-to-texture technique as the prefab thumbnails and the old
// single-view billboard bake, minus any CPU readback — the two atlases stay
// GPU-side as inputs to the far-tier material (see packages/render/src/
// impostor.ts for the mapping and the sampler). `object` is always a
// throwaway clone (the render package never hands over its shared cached
// model), so reparenting it and swapping its materials here is safe.
//
// Two passes per model:
//  - albedo: the model's own materials under a uniform white ambient of π —
//    Lambert's ambient term is albedo · irradiance / π, so that intensity
//    yields the un-lit base colour (plus the material's own alpha cut-outs).
//    Lighting is NOT baked in: the impostor is lit at runtime through the…
//  - …normal atlas: every mesh temporarily wears an unlit material writing
//    its model-space normal (`normalWorld` with the object at the origin),
//    keeping the original map's alpha so leaf cards keep their silhouette.
//
// Each frame is drawn into its own viewport rectangle of ONE render target
// (cleared once, then `autoClear` off) — no per-frame targets, no copies.
// WebGPU's viewport origin is top-left and WebGL's bottom-left, but both put
// viewport row j at texel row j, so the atlas layout is backend-independent;
// only the orientation WITHIN a frame differs, which `flipFrames` reports.

export interface ImpostorBakeOptions {
  grid?: number;
  frameSize?: number;
  /** Bake into the shared page (default) or into textures of this model's own. */
  shared?: boolean;
}

/**
 * One PAGE of many models' atlases — the same two render targets, each model
 * in its own block — so every impostor in the world samples one texture pair
 * and a supercell's species can share a draw (`impostorPageMaterial`). A
 * 4096² page holds 49 default-sized (576²) blocks; a second page opens when
 * the first is full. Pages are never freed: they are bounded by unique
 * models, not by what is loaded.
 */
const DEFAULT_PAGE_SIZE = 4096;

/**
 * Page size, read once: 4096 by default. `?impostorPage=2048` (or
 * localStorage `hitreg.impostorPage` = "2048") bakes into 2048² pages with
 * frames HALF the default size, so a page still holds 49 models — a quarter
 * of the GPU memory (two 4096² RGBA8 targets are 128 MB, two 2048² are
 * 32 MB) for half the impostor resolution. Off by default; an owner decision
 * (docs/combat-build/P-performance.md in the voxel-demo project).
 */
function readPageSize(): number {
  let raw: string | null = null;
  try {
    raw = new URLSearchParams(globalThis.location?.search ?? "").get("impostorPage");
    if (raw === null) raw = globalThis.localStorage?.getItem("hitreg.impostorPage") ?? null;
  } catch {
    raw = null;
  }
  return raw === "2048" ? 2048 : DEFAULT_PAGE_SIZE;
}
const PAGE_SIZE = readPageSize();
/** `?impostorBake=direct`: the old direct-to-page bake (page targets with depth), for A/B checks. */
const DIRECT_PAGE_BAKE = (() => {
  try {
    return new URLSearchParams(globalThis.location?.search ?? "").get("impostorBake") === "direct";
  } catch {
    return false;
  }
})();
const PAGE_FRAME_SIZE = Math.round((DEFAULT_IMPOSTOR_FRAME_SIZE * PAGE_SIZE) / DEFAULT_PAGE_SIZE);

/**
 * Page targets own NO depth buffer on WebGPU: a 4096² depth attachment is
 * 64 MB, two per page, and nothing reads depth after the bake. Each block is
 * drawn into one small SCRATCH target (block-sized colour + depth, ~2.6 MB)
 * and copied into its rectangle of the page (`copyTextureToTexture`). Sharing
 * one page-sized depth texture between targets instead is a trap in three
 * r185: a target's first use marks the depth texture for update, which
 * destroys and recreates it under every other target's cached render-pass
 * descriptor. WebGL keeps the original direct-to-page path (its texture copy
 * between render targets is a different code path, and WebGL is the rare
 * fallback).
 */
interface ImpostorPage {
  albedo: THREE.RenderTarget;
  normal: THREE.RenderTarget;
  /** Next free block, in blocks. */
  cursor: number;
  perRow: number;
  blockSize: number;
  cleared: boolean;
}

const pages: ImpostorPage[] = [];
let scratch: THREE.RenderTarget | null = null;

function scratchTarget(size: number): THREE.RenderTarget {
  if (scratch && scratch.width === size) return scratch;
  scratch?.dispose();
  scratch = new THREE.RenderTarget(size, size);
  return scratch;
}

function pageWithRoom(blockSize: number, depth: boolean): ImpostorPage {
  const perRow = Math.floor(PAGE_SIZE / blockSize);
  for (const page of pages) {
    if (page.blockSize === blockSize && page.cursor < perRow * perRow) return page;
  }
  const page: ImpostorPage = {
    albedo: new THREE.RenderTarget(PAGE_SIZE, PAGE_SIZE, { depthBuffer: depth }),
    normal: new THREE.RenderTarget(PAGE_SIZE, PAGE_SIZE, { depthBuffer: depth }),
    cursor: 0,
    perRow,
    blockSize,
    cleared: false,
  };
  pages.push(page);
  return page;
}

/** For memory probes: the impostor pages baked so far. */
export function impostorPageStats(): { pages: number; pageSize: number; blocks: number; capacity: number } {
  let blocks = 0;
  let capacity = 0;
  for (const p of pages) {
    blocks += p.cursor;
    capacity += p.perRow * p.perRow;
  }
  return { pages: pages.length, pageSize: PAGE_SIZE, blocks, capacity };
}
/** What each block holds, for probes comparing two bakes of the same models (memory A/Bs). */
const blockLabels: Array<{ page: number; x: number; y: number; size: number; label: string }> = [];
let lastRenderer: THREE.WebGPURenderer | null = null;
/**
 * Probe hook: read one block of one page back (`which` "albedo" | "normal") as RGBA8 bytes.
 * Debug only; nothing in the game calls it.
 */
async function readImpostorBlock(index: number, which: "albedo" | "normal"): Promise<Uint8Array | null> {
  const b = blockLabels[index];
  const page = b ? pages[b.page] : undefined;
  if (!b || !page || !lastRenderer) return null;
  const pixels = await lastRenderer.readRenderTargetPixelsAsync(page[which], b.x, b.y, b.size, b.size);
  return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
}
Object.assign(globalThis, {
  __hitregImpostorPages: impostorPageStats,
  __hitregImpostorBlocks: () => blockLabels.slice(),
  __hitregImpostorRead: readImpostorBlock,
});

function normalMaterialFor(source: THREE.Material): THREE.MeshBasicNodeMaterial {
  const src = source as THREE.Material & { map?: THREE.Texture | null; alphaTest?: number; transparent?: boolean };
  const material = new THREE.MeshBasicNodeMaterial({ side: src.side });
  material.colorNode = normalWorld.mul(0.5).add(0.5);
  const role = vegetationMaterialRole(source);
  // Override output alpha AFTER the original cutout test. This packs the
  // material role into unused normal-alpha without another bake or texture.
  material.outputNode = vec4(normalWorld.mul(0.5).add(0.5), float(role === "leaves" ? 1 : role === "bark" ? 0.5 : 0));
  if (src.map && ((src.alphaTest ?? 0) > 0 || src.transparent)) {
    material.opacityNode = tslTexture(src.map, uv()).a;
    material.alphaTest = Math.max(src.alphaTest ?? 0, 0.5);
  }
  return material;
}

function renderFrames(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  target: THREE.RenderTarget,
  center: THREE.Vector3,
  radius: number,
  grid: number,
  frameSize: number,
  originX = 0,
  originY = 0,
  clear = true,
): void {
  const camera = new THREE.OrthographicCamera(-radius, radius, radius, -radius, 0.01, radius * 4);
  const dir = new THREE.Vector3();
  renderer.setRenderTarget(target);
  if (clear) renderer.clear();
  const prevAutoClear = renderer.autoClear;
  renderer.autoClear = false;
  try {
    for (let j = 0; j < grid; j++) {
      for (let i = 0; i < grid; i++) {
        impostorFrameDirection(i, j, grid, dir);
        impostorFrameUp(dir, camera.up);
        camera.position.copy(center).addScaledVector(dir, radius * 2);
        camera.lookAt(center);
        camera.updateMatrixWorld();
        target.viewport.set(originX + i * frameSize, originY + j * frameSize, frameSize, frameSize);
        renderer.render(scene, camera);
      }
    }
  } finally {
    renderer.autoClear = prevAutoClear;
    target.viewport.set(0, 0, target.width, target.height);
  }
}

export function bakeImpostorAtlas(
  renderer: EngineRenderer,
  object: THREE.Object3D,
  bounds: THREE.Box3,
  options: ImpostorBakeOptions = {},
): ImpostorAtlas | null {
  const grid = options.grid ?? DEFAULT_IMPOSTOR_GRID;
  const shared = options.shared !== false;
  const frameSize = options.frameSize ?? (shared ? PAGE_FRAME_SIZE : DEFAULT_IMPOSTOR_FRAME_SIZE);
  const size = grid * frameSize;
  const gl = renderer.renderer;
  const backend = gl.backend as { isWebGPUBackend?: boolean };
  // see ImpostorPage: WebGPU bakes through a block-sized scratch target
  const viaScratch = shared && backend.isWebGPUBackend === true && !DIRECT_PAGE_BAKE;
  const scene = new THREE.Scene();
  const prevClear = new THREE.Color();
  gl.getClearColor(prevClear);
  const prevAlpha = gl.getClearAlpha();
  const prevTarget = gl.getRenderTarget();
  const swapped: Array<{ mesh: THREE.Mesh; material: THREE.Material | THREE.Material[] }> = [];
  try {
    const center = bounds.getCenter(new THREE.Vector3());
    const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, 0.05);
    object.position.set(0, 0, 0);
    object.quaternion.identity();
    object.scale.set(1, 1, 1);
    scene.add(object);
    gl.setClearColor(0x000000, 0); // transparent, not chroma-keyed — no fringing

    // pass 1: albedo under a flat white ambient (see header)
    const ambient = new THREE.AmbientLight(0xffffff, Math.PI);
    scene.add(ambient);
    const page = shared ? pageWithRoom(size, !viaScratch) : null;
    const block = page ? page.cursor++ : 0;
    const originX = page ? (block % page.perRow) * size : 0;
    const originY = page ? Math.floor(block / page.perRow) * size : 0;
    const albedo = page ? page.albedo : new THREE.RenderTarget(size, size);
    const blockOrigin = new THREE.Vector2(originX, originY);
    if (page) {
      lastRenderer = gl;
      const s = bounds.getSize(new THREE.Vector3());
      blockLabels.push({
        page: pages.indexOf(page),
        x: originX,
        y: originY,
        size,
        label: `${object.name}|${s.x.toFixed(2)},${s.y.toFixed(2)},${s.z.toFixed(2)}`,
      });
    }
    const pass = (into: THREE.RenderTarget): void => {
      if (viaScratch) {
        // the whole block into the scratch target (cleared), then copied into place
        const tmp = scratchTarget(size);
        renderFrames(gl, scene, tmp, center, radius, grid, frameSize, 0, 0, true);
        gl.copyTextureToTexture(tmp.texture, into.texture, null, blockOrigin);
        return;
      }
      // a page is cleared once, on its first block; every later block draws
      // into its own rectangle of the same target
      renderFrames(gl, scene, into, center, radius, grid, frameSize, originX, originY, !page || !page.cleared);
    };
    pass(albedo);
    scene.remove(ambient);

    // pass 2: model-space normals, same frames
    object.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      swapped.push({ mesh, material: mesh.material });
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map((m) => normalMaterialFor(m))
        : normalMaterialFor(mesh.material);
    });
    const normal = page ? page.normal : new THREE.RenderTarget(size, size);
    pass(normal);
    if (page) page.cleared = true;
    return {
      albedo: albedo.texture,
      normal: normal.texture,
      vegetationMask: true,
      grid,
      flipFrames: backend.isWebGPUBackend === true,
      ...(page ? { region: { u: originX / PAGE_SIZE, v: originY / PAGE_SIZE, scale: size / PAGE_SIZE } } : {}),
    };
  } catch (error) {
    console.warn("[impostor] bake failed, falling back to primitive far proxies:", error);
    return null;
  } finally {
    for (const { mesh, material } of swapped) {
      const temp = mesh.material;
      mesh.material = material;
      if (Array.isArray(temp)) for (const m of temp) m.dispose();
      else temp.dispose();
    }
    scene.remove(object);
    gl.setRenderTarget(prevTarget);
    gl.setClearColor(prevClear, prevAlpha);
  }
}
