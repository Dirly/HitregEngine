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
  /**
   * Light colours: the sky and ground of the hemisphere fill and the back rim.
   * The default is a cool studio (blue-grey sky, blue rim). A cool fill turns a
   * dark warm skin grey-violet — its diffuse is too dim to outweigh the blue —
   * so the character creator asks for a neutral-warm one.
   */
  lights?: { sky?: THREE.ColorRepresentation; ground?: THREE.ColorRepresentation; rim?: THREE.ColorRepresentation; key?: THREE.ColorRepresentation; scale?: number };
  /**
   * Set dressing around the model (a creation screen's clearing: ground,
   * trees, light shafts), added to the portrait's private scene once; the
   * model stands at the origin, feet at y 0. `update` runs every frame
   * (drifting fog, swaying shafts), `dispose` when the view goes.
   */
  stage?: (scene: THREE.Scene, camera: THREE.PerspectiveCamera) => { update?(dt: number): void; dispose?(): void } | void;
  /**
   * Aim this share of the model's height BELOW its centre, so it stands higher in the frame (room under its feet
   * for a name and buttons). 0 = centred.
   */
  aimLow?: number;
  /** Distance fog in the portrait scene (the stage fades into a painted backdrop behind the canvas). */
  fog?: { color: THREE.ColorRepresentation; near: number; far: number };
}

/** The head bone a face close-up frames on (Head, mixamorig:Head, …, never HeadTop_End). */
const HEAD_BONE = /(^|[:_ .-])head$/i;

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
  private readonly aimLow: number;
  /** The whole-body framing (frame()), and how far the camera has eased toward the face (0 body .. 1 face). */
  private readonly bodyPos = new THREE.Vector3();
  private readonly bodyLook = new THREE.Vector3();
  /** Where the camera is heading between the whole body (0) and the face (1), and where it is now. */
  private zoomWant = 0;
  private focusT = 0;
  private head: THREE.Object3D | null = null;
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private stageHooks: { update?(dt: number): void; dispose?(): void } | null = null;

  constructor(
    private readonly source: THREE.Object3D,
    private readonly canvas: HTMLCanvasElement,
    opts: PortraitOptions = {},
  ) {
    this.spin = opts.spin ?? 0;
    this.padding = opts.padding ?? 1.25;
    this.forward = opts.forward ?? 1;
    this.aimLow = opts.aimLow ?? 0;
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
    const level = opts.lights?.scale ?? 1;
    const hemi = new THREE.HemisphereLight(opts.lights?.sky ?? 0xdfe6f5, opts.lights?.ground ?? 0x2a3040, 2.0 * level);
    const key = new THREE.DirectionalLight(opts.lights?.key ?? 0xffffff, 3.2 * level);
    key.position.set(1.5, 3, 2.5 * this.forward);
    const rim = new THREE.DirectionalLight(opts.lights?.rim ?? 0x9fb3ff, 0.8 * Math.max(1, level));
    rim.position.set(-2, 2, -2.5 * this.forward);
    this.scene.add(hemi, key, rim);
    if (opts.fog) this.scene.fog = new THREE.Fog(opts.fog.color, opts.fog.near, opts.fog.far);
    this.clone.traverse((n) => {
      if (!this.head && (n as THREE.Bone).isBone && HEAD_BONE.test(n.name)) this.head = n;
    });
    if (opts.stage) this.stageHooks = opts.stage(this.scene, this.camera) ?? null;

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
    this.stageHooks?.update?.(dt);
    this.aim(dt);
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== h) {
      // clientWidth is in the element's own CSS px; under a CSS zoom (a UI
      // scaled up for a big monitor) it is drawn larger, so render that much finer
      const zoom = this.canvas.getBoundingClientRect().width / w || 1;
      this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1) * zoom);
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
    this.bodyPos.set(this.center.x, this.center.y + height * 0.04, this.center.z + this.forward * dist);
    this.bodyLook.copy(this.center);
    // the face close-up aims at a FIXED point: on the turning axis, at the head's height as framed — never at the
    // live head bone, which sways with the idle and swings round as the model turns
    if (this.head) this.headY = this.head.getWorldPosition(this.tmpA).y;
    this.bodyLook.y -= height * this.aimLow;
    this.bodyPos.y -= height * this.aimLow;
    this.camera.position.copy(this.bodyPos);
    this.camera.lookAt(this.bodyLook);
    this.camera.near = Math.max(0.02, dist * 0.02);
    // far enough for a stage around the model (trees, fog) as well as the model
    this.camera.far = Math.max(dist * 10, 200);
    this.camera.updateProjectionMatrix();
    this.framed = true;
  }

  /**
   * Ease the camera between the whole-body framing and a close-up of the face
   * (the head bone, head-and-shoulders), smoothly both ways.
   */
  private aim(dt: number): void {
    if (!this.framed) return;
    const want = this.head ? this.zoomWant : 0;
    if (want === this.focusT && want === 0 && this.settledAt0) return;
    this.settledAt0 = want === 0 && this.focusT === 0;
    const k = 1 - Math.exp(-dt * 5);
    this.focusT += (want - this.focusT) * k;
    if (Math.abs(want - this.focusT) < 1e-3) this.focusT = want;
    const t = this.focusT * this.focusT * (3 - 2 * this.focusT);
    let facePos = this.bodyPos;
    let faceLook = this.bodyLook;
    if (this.head) {
      // aimed a little under the head: the face sits in the upper middle, clear of a nameplate under it
      faceLook = this.tmpA.set(this.center.x, this.headY - 0.18, this.center.z);
      const halfFov = (this.camera.fov * Math.PI) / 360;
      // head and shoulders, not a nose
      const dist = (1.0 / 2 / Math.tan(halfFov)) * 1.05;
      facePos = this.tmpB.set(faceLook.x, faceLook.y + 0.02, faceLook.z + this.forward * dist);
    }
    this.camera.position.lerpVectors(this.bodyPos, facePos, t);
    const look = new THREE.Vector3().lerpVectors(this.bodyLook, faceLook, t);
    this.camera.lookAt(look);
  }

  private settledAt0 = false;
  /** The head's height when the model was framed (the face close-up's fixed aim). */
  private headY = 0;

  /** Frame the whole body, or ease in on the face. */
  setFocus(focus: "body" | "face"): void {
    this.setZoom(focus === "face" ? 1 : 0);
  }

  /** Zoom between the whole body (0) and a head-and-shoulders close-up (1); eased, e.g. from a mouse wheel. */
  setZoom(t: number): void {
    this.zoomWant = Math.max(0, Math.min(1, t));
    this.settledAt0 = false;
  }

  /** Re-fit the camera on the next frame (the source swapped models). */
  refit(): void {
    this.framed = false;
  }

  /** The posed clone — a creation screen parents appearance pieces to its bones. */
  get model(): THREE.Object3D {
    return this.clone;
  }

  /** Turn the model to a yaw (drag-to-rotate). Adds to any `spin`. */
  setYaw(radians: number): void {
    this.clone.rotation.y = radians;
  }

  dispose(): void {
    this.alive = false;
    this.stageHooks?.dispose?.();
    this.stageHooks = null;
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
