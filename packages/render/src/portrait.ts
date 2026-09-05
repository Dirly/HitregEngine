import * as THREE from "three/webgpu";
import { clone as skeletonClone } from "three/addons/utils/SkeletonUtils.js";

/**
 * A live portrait of one runtime object — the player's body in the middle of
 * the character screen — rendered into its own canvas.
 *
 * It never touches the main scene. The source subtree is cloned
 * (SkeletonUtils, so skinned meshes get their own skeleton) into a private
 * scene with its own lights, camera and renderer. Given the model's clips it
 * runs its OWN AnimationMixer playing one clip — the idle, by default — so
 * the portrait stands calmly whatever the real character is doing. Without
 * clips it falls back to mirroring the source's bones every frame. Geometry,
 * materials and textures are SHARED with the source (a second renderer
 * uploads its own GPU copies); dispose() therefore tears down only the
 * renderer, the mixer and the clone's scene graph.
 *
 * Presentation only. The canvas is transparent (alpha clear) so the UI's
 * panel shows through; size follows the canvas's CSS box each frame.
 */
export interface PortraitOptions {
  /** Turntable speed in radians/second; 0 (default) faces the camera. */
  spin?: number;
  /** Vertical field of view in degrees. */
  fov?: number;
  /** Camera distance multiplier over the tight fit (breathing room). */
  padding?: number;
  /**
   * Which way the model faces along Z, so the camera sits in front of it:
   * +1 (default — glTF assets face +Z, which is what the retarget tool
   * emits) or -1 for a model authored facing three's -Z.
   */
  forward?: -1 | 1;
  /** The model's animation clips (AnimationSystem.clipsOf). Without them the portrait mirrors the live bones. */
  clips?: THREE.AnimationClip[];
  /** Clip to loop (default "Idle"; falls back to any clip whose name contains "idle", then the first clip). */
  clip?: string;
}

export class PortraitView {
  private renderer: THREE.WebGPURenderer | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly clone: THREE.Object3D;
  /** source node → clone node, for every node below the root (bone-mirror fallback). */
  private readonly pairs: Array<[THREE.Object3D, THREE.Object3D]> = [];
  private mixer: THREE.AnimationMixer | null = null;
  private alive = true;
  private raf = 0;
  private framed = false;
  private last = 0;
  private readonly box = new THREE.Box3();
  private readonly size = new THREE.Vector3();
  private readonly center = new THREE.Vector3();
  private readonly spin: number;
  private readonly padding: number;
  private readonly forward: -1 | 1;

  constructor(
    private readonly source: THREE.Object3D,
    private readonly canvas: HTMLCanvasElement,
    opts: PortraitOptions = {},
  ) {
    this.spin = opts.spin ?? 0;
    this.padding = opts.padding ?? 1.25;
    this.forward = opts.forward ?? 1;
    this.camera = new THREE.PerspectiveCamera(opts.fov ?? 28, 1, 0.05, 100);
    this.clone = skeletonClone(source);
    this.clone.position.set(0, 0, 0);
    this.clone.quaternion.identity();
    // pair nodes by traversal order — SkeletonUtils.clone preserves structure
    const src: THREE.Object3D[] = [];
    const dst: THREE.Object3D[] = [];
    source.traverse((n) => src.push(n));
    this.clone.traverse((n) => dst.push(n));
    for (let i = 1; i < Math.min(src.length, dst.length); i++) this.pairs.push([src[i]!, dst[i]!]);
    // overhead bars, labels, lights, particle pools and debug lines belong to
    // the world, not the portrait — and their (often huge) bounds must not
    // steer the camera fit
    this.clone.traverse((n) => {
      const o = n as THREE.Object3D & {
        isSprite?: boolean;
        isLight?: boolean;
        isPoints?: boolean;
        isLine?: boolean;
        isInstancedMesh?: boolean;
      };
      if (o.isSprite || o.isLight || o.isPoints || o.isLine || o.isInstancedMesh || n.userData["billboard"]) {
        n.visible = false;
      }
    });
    this.scene.add(this.clone);
    const hemi = new THREE.HemisphereLight(0xdfe6f5, 0x2a3040, 2.0);
    const key = new THREE.DirectionalLight(0xffffff, 3.2);
    key.position.set(1.5, 3, 2.5 * this.forward);
    const rim = new THREE.DirectionalLight(0x9fb3ff, 0.8);
    rim.position.set(-2, 2, -2.5 * this.forward);
    this.scene.add(hemi, key, rim);

    const clip = pickClip(opts.clips ?? [], opts.clip ?? "Idle");
    if (clip) {
      // the clone keeps the source's node names, so the clip's tracks bind to
      // the clone's own bones — an independent, always-idle character
      this.mixer = new THREE.AnimationMixer(this.clone);
      const action = this.mixer.clipAction(clip);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.play();
      // start mid-cycle so a fresh screen does not show the same first frame every time
      this.mixer.update(Math.random() * clip.duration);
    }
    void this.init();
  }

  private async init(): Promise<void> {
    const renderer = new THREE.WebGPURenderer({ canvas: this.canvas, alpha: true, antialias: true });
    try {
      await renderer.init();
    } catch (error) {
      console.warn("[portrait] renderer init failed:", error);
      return;
    }
    if (!this.alive) {
      renderer.dispose();
      return;
    }
    renderer.setClearColor(0x000000, 0);
    this.renderer = renderer;
    this.last = performance.now();
    this.loop();
  }

  private loop = (): void => {
    if (!this.alive || !this.renderer) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.mixer) this.mixer.update(dt);
    else this.sync();
    if (this.spin !== 0) this.clone.rotation.y += this.spin * dt;
    this.clone.updateMatrixWorld(true);
    if (!this.framed) this.frame();
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== h) {
      this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    this.renderer.render(this.scene, this.camera);
  };

  /** Fallback without clips: copy every node's local transform (bones included) from the live character. */
  private sync(): void {
    for (const [s, d] of this.pairs) {
      d.position.copy(s.position);
      d.quaternion.copy(s.quaternion);
      d.scale.copy(s.scale);
      d.visible = s.visible && d.visible;
    }
  }

  /** Fit the camera to the posed clone once its bounds are real. */
  private frame(): void {
    // bounds over VISIBLE meshes only — setFromObject would include hidden
    // helpers (and a skinned mesh's bind-pose box is the right size anyway)
    this.box.makeEmpty();
    const tmp = new THREE.Box3();
    this.clone.traverse((n) => {
      const mesh = n as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible || !mesh.geometry) return;
      let parent: THREE.Object3D | null = mesh;
      while (parent) {
        if (!parent.visible) return;
        parent = parent.parent;
      }
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      if (!mesh.geometry.boundingBox) return;
      tmp.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
      this.box.union(tmp);
    });
    if (this.box.isEmpty()) return;
    this.box.getSize(this.size);
    this.box.getCenter(this.center);
    const height = Math.max(0.3, this.size.y);
    if (height < 0.3) return;
    const halfFov = (this.camera.fov * Math.PI) / 360;
    const dist = ((height / 2) / Math.tan(halfFov)) * this.padding;
    this.camera.position.set(this.center.x, this.center.y + height * 0.04, this.center.z + this.forward * dist);
    this.camera.lookAt(this.center);
    this.camera.near = Math.max(0.02, dist * 0.1);
    this.camera.far = dist * 10;
    this.camera.updateProjectionMatrix();
    this.framed = true;
  }

  /** Re-fit the camera on the next frame (the source swapped models). */
  refit(): void {
    this.framed = false;
  }

  dispose(): void {
    this.alive = false;
    cancelAnimationFrame(this.raf);
    this.mixer?.stopAllAction();
    this.mixer = null;
    this.scene.remove(this.clone);
    this.renderer?.dispose();
    this.renderer = null;
  }
}

/** Exact name, then any clip whose name contains it case-insensitively, then the first clip. */
function pickClip(clips: THREE.AnimationClip[], name: string): THREE.AnimationClip | null {
  if (clips.length === 0) return null;
  const lower = name.toLowerCase();
  return (
    clips.find((c) => c.name === name) ??
    clips.find((c) => c.name.toLowerCase().includes(lower)) ??
    clips[0] ??
    null
  );
}
