import * as THREE from "three/webgpu";
import { clone as skeletonClone } from "three/addons/utils/SkeletonUtils.js";

/**
 * Still head-and-shoulders pictures for unit frames (player, target, party,
 * pet) — the WoW portrait, minus the live render.
 *
 * A picture is shot ONCE per LOOK and kept: the caller names the look with a
 * key (what shows on the head — a character's face, hair, skin and helm; a
 * creature's model and skin), so every rat of one skin shares one picture and
 * a helm going on is a new key, shot once. While a new look's picture is on
 * its way the entity keeps its last one.
 *
 * It renders through the MAIN renderer into a small render target (no second
 * GPU device, no re-upload of the model's buffers), one shot at a time,
 * pipelines compiled asynchronously first so a new material never stalls a
 * frame. The source is cloned (SkeletonUtils, its own skeleton) into a
 * private scene with its own lights, posed on its idle clip, framed on its
 * head bone (or the front-top of its bounds for a body with no head bone),
 * read back and kept as a PNG data URL. Presentation only.
 */
export interface FaceShotsOptions {
  /** Pixels a side (default 128; a multiple of 64 keeps WebGPU's row alignment). */
  size?: number;
  /** Most pictures kept (least recently used dropped; default 128). */
  keep?: number;
  /** Vertical field of view in degrees (default 24). */
  fov?: number;
}

export interface FaceShotSource {
  /** The entity's runtime object (cloned, never touched). */
  object: THREE.Object3D;
  /** Its clips (AnimationSystem.clipsOf), to pose it on its idle; absent = its current pose. */
  clips?: THREE.AnimationClip[];
  /**
   * Seat what is not under the body (a character's head, hair and helm drawn
   * by moving batches) on the clone's bones; call `landed` once per piece
   * placed. The shot waits for the pieces to settle.
   */
  dress?: (source: THREE.Object3D, clone: THREE.Object3D, landed: () => void) => void;
  /** Which way the model faces along Z (+1 glTF default). */
  forward?: -1 | 1;
}

const HEAD_BONE = /(^|[:_ .-])head$/i;

export class FaceShots {
  private readonly size: number;
  private readonly keepMax: number;
  private readonly fov: number;
  /** look key → picture (insertion order = recency) */
  private readonly pictures = new Map<string, string>();
  /** look keys being shot or queued */
  private readonly pending = new Set<string>();
  private readonly queue: Array<{ key: string; source: FaceShotSource }> = [];
  private busy = false;
  private target: THREE.RenderTarget | null = null;
  private disposed = false;

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    opts: FaceShotsOptions = {},
  ) {
    this.size = opts.size ?? 128;
    this.keepMax = opts.keep ?? 128;
    this.fov = opts.fov ?? 24;
  }

  /** The picture for a look, or null (queued for shooting unless it is already). */
  get(key: string, source: () => FaceShotSource | null): string | null {
    const have = this.pictures.get(key);
    if (have) {
      // most recently used last
      this.pictures.delete(key);
      this.pictures.set(key, have);
      return have;
    }
    if (!this.pending.has(key) && !this.disposed) {
      const s = source();
      if (s) {
        this.pending.add(key);
        this.queue.push({ key, source: s });
        void this.pump();
      }
    }
    return null;
  }

  /** Whether a look has a picture already. */
  has(key: string): boolean {
    return this.pictures.has(key);
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
    this.pictures.clear();
    this.target?.dispose();
    this.target = null;
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length && !this.disposed) {
        const job = this.queue.shift()!;
        let url: string | null = null;
        try {
          url = await this.shoot(job.source);
        } catch (error) {
          console.warn("[face-shots] shot failed:", error);
        }
        this.pending.delete(job.key);
        if (url) {
          this.pictures.set(job.key, url);
          while (this.pictures.size > this.keepMax) this.pictures.delete(this.pictures.keys().next().value!);
        }
        // one picture per frame or two at most: a crowd arriving never costs a hitch
        await new Promise((r) => setTimeout(r, 30));
      }
    } finally {
      this.busy = false;
    }
  }

  private async shoot(src: FaceShotSource): Promise<string | null> {
    const clone = skeletonClone(src.object);
    clone.position.set(0, 0, 0);
    clone.quaternion.identity();
    clone.traverse((n) => {
      const o = n as THREE.Object3D & { isSprite?: boolean; isLight?: boolean; isPoints?: boolean; isLine?: boolean; isInstancedMesh?: boolean };
      if (o.isSprite || o.isLight || o.isPoints || o.isLine || o.isInstancedMesh || n.userData["billboard"]) n.visible = false;
    });
    const scene = new THREE.Scene();
    scene.add(clone);
    const forward = src.forward ?? 1;
    // a warm key from the front-left, a cool rim behind: a face that reads small
    scene.add(new THREE.HemisphereLight(0xe8e2d6, 0x2a2622, 1.8));
    const key = new THREE.DirectionalLight(0xfff1dc, 3.4);
    key.position.set(1.2, 2.2, 2.4 * forward);
    const rim = new THREE.DirectionalLight(0x9fb3ff, 1.1);
    rim.position.set(-1.6, 1.8, -2.4 * forward);
    scene.add(key, rim);

    // posed on its idle, mid-cycle, so a face is never caught mid-swing
    const clips = src.clips ?? [];
    const idle = clips.find((c) => c.name === "Idle") ?? clips.find((c) => /idle/i.test(c.name)) ?? null;
    if (idle) {
      const mixer = new THREE.AnimationMixer(clone);
      mixer.clipAction(idle).play();
      mixer.update(Math.min(idle.duration * 0.25, 0.5));
    }
    if (src.dress) {
      let landed = 0;
      let lastAt = performance.now();
      src.dress(src.object, clone, () => {
        landed++;
        lastAt = performance.now();
      });
      // pieces load async: wait for them to settle (a quiet 250 ms after the last, at most 2.5 s)
      const start = performance.now();
      await new Promise<void>((resolve) => {
        const tick = (): void => {
          const now = performance.now();
          if (now - start > 2500 || (now - lastAt > 250 && now - start > 350)) resolve();
          else setTimeout(tick, 50);
        };
        tick();
      });
      void landed;
    }
    clone.updateMatrixWorld(true);

    const camera = new THREE.PerspectiveCamera(this.fov, 1, 0.02, 50);
    if (!this.frame(clone, camera, forward)) return null;
    if (this.disposed) return null;

    const size = this.size;
    if (!this.target) {
      this.target = new THREE.RenderTarget(size, size, { type: THREE.UnsignedByteType, depthBuffer: true, samples: 4 });
    }
    const renderer = this.renderer;
    // pipelines first, off the frame: a material this scene has not met compiles without a stall
    await renderer.compileAsync(scene, camera);
    if (this.disposed) return null;
    const previousTarget = renderer.getRenderTarget();
    const clear = renderer.getClearColor(new THREE.Color());
    const alpha = renderer.getClearAlpha();
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(clear, alpha);
    const pixels = (await renderer.readRenderTargetPixelsAsync(this.target, 0, 0, size, size)) as Uint8Array;
    scene.clear();
    return toDataUrl(pixels, size, (renderer as unknown as { backend?: { isWebGLBackend?: boolean } }).backend?.isWebGLBackend === true);
  }

  /**
   * Aim the camera at the face: the head bone (a character, most creatures),
   * else the front-top of the visible bounds. False when there is nothing
   * visible to frame.
   */
  private frame(root: THREE.Object3D, camera: THREE.PerspectiveCamera, forward: -1 | 1): boolean {
    const box = new THREE.Box3();
    const tmp = new THREE.Box3();
    root.traverse((n) => {
      const mesh = n as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible || !mesh.geometry) return;
      for (let p: THREE.Object3D | null = mesh; p; p = p.parent) if (!p.visible) return;
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      if (!mesh.geometry.boundingBox) return;
      tmp.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
      box.union(tmp);
    });
    if (box.isEmpty()) return false;
    const dims = box.getSize(new THREE.Vector3());
    let head: THREE.Object3D | null = null;
    root.traverse((n) => {
      if (!head && (n as THREE.Bone).isBone && HEAD_BONE.test(n.name)) head = n;
    });
    const center = new THREE.Vector3();
    let span: number;
    if (head) {
      (head as THREE.Object3D).getWorldPosition(center);
      // a human head is ~1/8 of the body; the picture takes head and a little shoulder
      span = Math.max(0.3, Math.min(dims.y, Math.max(dims.x, dims.z) * 1.5) * 0.24);
      center.y += span * 0.12;
    } else {
      span = Math.max(0.3, Math.max(dims.y, dims.x) * 0.5);
      center.set((box.min.x + box.max.x) / 2, box.max.y - span * 0.45, forward > 0 ? box.max.z - span * 0.4 : box.min.z + span * 0.4);
    }
    const dist = (span / 2 / Math.tan((this.fov * Math.PI) / 360)) * 1.15;
    // a touch from the key light's side, a touch above: a three-quarter face, not a mugshot
    camera.position.set(center.x + dist * 0.18, center.y + dist * 0.06, center.z + forward * dist);
    camera.lookAt(center);
    camera.near = Math.max(0.01, dist * 0.2);
    camera.far = dist * 6;
    camera.updateProjectionMatrix();
    return true;
  }
}

/** Linear 8-bit readback → an sRGB PNG data URL (WebGL reads bottom-up: flipped). */
function toDataUrl(pixels: Uint8Array, size: number, flip: boolean): string | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const image = ctx.createImageData(size, size);
  const lut = SRGB_LUT;
  for (let y = 0; y < size; y++) {
    const from = (flip ? size - 1 - y : y) * size * 4;
    const to = y * size * 4;
    for (let x = 0; x < size * 4; x += 4) {
      const a = pixels[from + x + 3]!;
      // the target is premultiplied by the clear; un-premultiply before encoding
      const k = a > 0 ? 255 / a : 0;
      image.data[to + x] = lut[Math.min(255, Math.round(pixels[from + x]! * k))]!;
      image.data[to + x + 1] = lut[Math.min(255, Math.round(pixels[from + x + 1]! * k))]!;
      image.data[to + x + 2] = lut[Math.min(255, Math.round(pixels[from + x + 2]! * k))]!;
      image.data[to + x + 3] = a;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}

/** Linear 0..255 → sRGB 0..255. */
const SRGB_LUT = (() => {
  const out = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    out[i] = Math.round(Math.max(0, Math.min(1, s)) * 255);
  }
  return out;
})();
