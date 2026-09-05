import * as THREE from "three/webgpu";
import { normalWorld, texture as tslTexture, uv } from "three/tsl";
import type { EngineRenderer, ImpostorAtlas } from "@hitreg/render";
import {
  DEFAULT_IMPOSTOR_FRAME_SIZE,
  DEFAULT_IMPOSTOR_GRID,
  impostorFrameDirection,
  impostorFrameUp,
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
const PAGE_SIZE = 4096;

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

function pageWithRoom(blockSize: number): ImpostorPage {
  const perRow = Math.floor(PAGE_SIZE / blockSize);
  for (const page of pages) {
    if (page.blockSize === blockSize && page.cursor < perRow * perRow) return page;
  }
  const page: ImpostorPage = {
    albedo: new THREE.RenderTarget(PAGE_SIZE, PAGE_SIZE),
    normal: new THREE.RenderTarget(PAGE_SIZE, PAGE_SIZE),
    cursor: 0,
    perRow,
    blockSize,
    cleared: false,
  };
  pages.push(page);
  return page;
}

function normalMaterialFor(source: THREE.Material): THREE.MeshBasicNodeMaterial {
  const src = source as THREE.Material & { map?: THREE.Texture | null; alphaTest?: number; transparent?: boolean };
  const material = new THREE.MeshBasicNodeMaterial({ side: src.side });
  material.colorNode = normalWorld.mul(0.5).add(0.5);
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
  const frameSize = options.frameSize ?? DEFAULT_IMPOSTOR_FRAME_SIZE;
  const size = grid * frameSize;
  const gl = renderer.renderer;
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
    const shared = options.shared !== false;
    const page = shared ? pageWithRoom(size) : null;
    const block = page ? page.cursor++ : 0;
    const originX = page ? (block % page.perRow) * size : 0;
    const originY = page ? Math.floor(block / page.perRow) * size : 0;
    const albedo = page ? page.albedo : new THREE.RenderTarget(size, size);
    // a page is cleared once, on its first block; every later block draws
    // into its own rectangle of the same target
    renderFrames(gl, scene, albedo, center, radius, grid, frameSize, originX, originY, !page || !page.cleared);
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
    renderFrames(gl, scene, normal, center, radius, grid, frameSize, originX, originY, !page || !page.cleared);
    if (page) page.cleared = true;
    const backend = gl.backend as { isWebGPUBackend?: boolean };
    return {
      albedo: albedo.texture,
      normal: normal.texture,
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
