import * as THREE from "three/webgpu";
import { texture as tslTexture, uniform, uv } from "three/tsl";
import type { VfxModuleOf } from "@hitreg/core";
import { LiveModule, loadTexture, presentationOnly, unlitMaterial, type LiveModuleHost } from "../base.js";
import type { N } from "../shaders.js";

type SpriteModule = VfxModuleOf<"sprite">;

const camQuat = new THREE.Quaternion();
const invCam = new THREE.Quaternion();
const roll = new THREE.Quaternion();
const yawQ = new THREE.Quaternion();
const tiltQ = new THREE.Quaternion();
const Z = new THREE.Vector3(0, 0, 1);
const Y = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);
const tmpV = new THREE.Vector3();
const camPos = new THREE.Vector3();
const at = new THREE.Vector3();
let quad: THREE.PlaneGeometry | null = null;

/**
 * A flipbook quad — or, with `cell`, one static SYMBOL from the sheet. The
 * sheet's grid is the timeline (columns) and the colour variants (rows); the
 * greyscale row + a tint is how one texture serves every element. Only two
 * uniforms move per frame, so a sprite costs one quad and one shared texture
 * however many frames it has.
 *
 * `pixel > 0` samples a nearest-filtered copy of the sheet: symbols and PSX
 * flipbooks keep their hard edges at any size.
 */
export class SpriteLive extends LiveModule<SpriteModule> {
  readonly kind = "sprite" as const;
  private readonly mesh: THREE.Mesh;
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly uOffset = uniform(new THREE.Vector2(0, 0));
  private readonly uScale = uniform(new THREE.Vector2(1, 1));
  private readonly uTint = uniform(new THREE.Color(1, 1, 1));
  private readonly uOpacity = uniform(1, "float");
  private map: THREE.Texture | null = null;
  private mapKey = "";
  private cols = 1;
  private rows = 1;
  private frames = 1;
  private yaw = 0;
  private ready = false;

  constructor(host: LiveModuleHost) {
    super(host);
    quad ??= new THREE.PlaneGeometry(1, 1);
    this.material = unlitMaterial(true);
    this.mesh = new THREE.Mesh(quad, this.material);
    presentationOnly(this.mesh);
    this.mesh.visible = false;
    host.root.add(this.mesh);
    this.buildShader();
  }

  private buildShader(): void {
    const map = this.map;
    if (map) {
      const sampled: N = tslTexture(map, (uv() as N).mul(this.uScale).add(this.uOffset));
      this.material.colorNode = sampled.rgb.mul(this.uTint);
      this.material.opacityNode = sampled.a.mul(this.uOpacity);
    } else {
      this.material.colorNode = this.uTint;
      this.material.opacityNode = this.uOpacity;
    }
    this.material.needsUpdate = true;
  }

  /** Resolve the sheet before the base class asks for the natural life. */
  override begin(module: SpriteModule, ctx: Parameters<LiveModule["begin"]>[1], now: number): void {
    const sheet = this.host.resolvers.sheet?.(module.sheet);
    const grid = sheet?.grid;
    this.cols = grid?.cols ?? 1;
    this.rows = grid?.rows ?? 1;
    this.frames = this.cols;
    const url = sheet ? this.host.resolvers.texture?.(sheet.texture) : undefined;
    const nearest = module.pixel > 0;
    const key = url ? `${url}#${nearest ? "nearest" : "linear"}` : "";
    this.ready = false;
    if (url && key !== this.mapKey) {
      this.mapKey = key;
      this.map = null;
      loadTexture(
        url,
        (t) => {
          if (this.mapKey !== key) return; // a later play wanted a different sheet
          this.map = t;
          this.buildShader();
          this.ready = true;
        },
        nearest,
      );
    } else if (url) {
      this.ready = this.map !== null;
    } else {
      console.warn(`[vfx] sprite sheet "${module.sheet}" has no texture — module skipped`);
    }
    super.begin(module, ctx, now);
  }

  protected naturalLife(): number {
    const m = this.module;
    if (m.cell || m.loop) return this.ctx.phaseLength > 0 ? this.ctx.phaseLength : m.cell ? 0.6 : 1;
    return this.frames / Math.max(1, m.fps);
  }

  protected onBegin(): void {
    const m = this.module;
    this.material.blending = m.blend === "additive" ? THREE.AdditiveBlending : THREE.NormalBlending;
    this.uTint.value.copy(this.color);
    this.uScale.value.set(1 / this.cols, 1 / this.rows);
    this.yaw = m.randomYaw ? Math.random() * Math.PI * 2 : m.yaw;
    this.mesh.visible = false;
  }

  protected onUpdate(t: number, _dt: number, camera: THREE.Camera): void {
    const m = this.module;
    if (!this.ready || !this.map) {
      this.mesh.visible = false;
      return;
    }
    const age = t * this.life;
    let col: number;
    let row: number;
    if (m.cell) {
      col = Math.min(this.cols - 1, m.cell[0]);
      row = Math.min(this.rows - 1, m.cell[1]);
    } else {
      col = m.loop ? Math.floor(age * m.fps) % this.frames : Math.min(this.frames - 1, Math.floor(t * this.frames));
      row = Math.min(this.rows - 1, m.row);
    }
    this.uOffset.value.set(col / this.cols, (this.rows - 1 - row) / this.rows);
    this.uOpacity.value = this.opacityAt(t, this.startedAt + age);

    const size = m.size * this.sizeAt(t);
    this.mesh.scale.set(size, size / Math.max(1e-3, m.aspect), 1);

    // orbit: circle the anchor around its up axis, phase 0 in front of it
    at.copy(this.pose.position);
    if (m.orbit > 0) {
      const a = m.orbitPhase + m.orbitSpeed * age;
      const f = this.pose.forward;
      // forward turned by `a` around +Y
      const fx = f.x * Math.cos(a) + f.z * Math.sin(a);
      const fz = -f.x * Math.sin(a) + f.z * Math.cos(a);
      at.x += fx * m.orbit;
      at.z += fz * m.orbit;
    }
    this.mesh.position.copy(at);

    const spin = this.yaw + m.spin * age;
    camera.getWorldQuaternion(camQuat);
    switch (m.orient) {
      case "billboard":
        roll.setFromAxisAngle(Z, spin);
        this.mesh.quaternion.copy(camQuat).multiply(roll);
        break;
      case "ground": {
        // The quad's +Y lands on world -Z after the tilt; yaw it onto the
        // spell direction (as rings do) so an arrow points where the spell does.
        const f = this.pose.forward;
        yawQ.setFromAxisAngle(Y, spin + Math.atan2(-f.x, -f.z));
        tiltQ.setFromAxisAngle(X, -Math.PI / 2);
        this.mesh.quaternion.copy(yawQ).multiply(tiltQ);
        break;
      }
      case "vertical": {
        camera.getWorldPosition(camPos);
        const a = Math.atan2(camPos.x - at.x, camPos.z - at.z);
        yawQ.setFromAxisAngle(Y, a);
        roll.setFromAxisAngle(Z, spin);
        this.mesh.quaternion.copy(yawQ).multiply(roll);
        break;
      }
      case "facing":
        roll.setFromAxisAngle(Z, spin);
        this.mesh.quaternion.copy(this.pose.facing).multiply(roll);
        break;
      case "velocity": {
        const v = this.pose.velocity;
        if (v.lengthSq() > 1e-4) {
          invCam.copy(camQuat).invert();
          tmpV.copy(v).normalize().applyQuaternion(invCam);
          roll.setFromAxisAngle(Z, Math.atan2(-tmpV.x, tmpV.y) + spin);
          this.mesh.quaternion.copy(camQuat).multiply(roll);
        } else {
          roll.setFromAxisAngle(Z, spin);
          this.mesh.quaternion.copy(camQuat).multiply(roll);
        }
        break;
      }
    }
    this.mesh.visible = true;
  }

  protected onEnd(): void {
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.material.dispose();
  }
}
