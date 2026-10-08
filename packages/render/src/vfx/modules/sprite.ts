import * as THREE from "three/webgpu";
import { clamp, float, step, texture as tslTexture, uniform, uv, vec2 } from "three/tsl";
import type { VfxModuleOf } from "@hitreg/core";
import { LiveModule, loadTexture, moduleColor, presentationOnly, unlitMaterial, type LiveModuleHost } from "../base.js";
import { posterize, quantize, type N } from "../shaders.js";

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
const axisUp = new THREE.Vector3();
const axisRight = new THREE.Vector3();
const axisNormal = new THREE.Vector3();
const basis = new THREE.Matrix4();
const basisQ = new THREE.Quaternion();
const crossRoll = new THREE.Quaternion();
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
 *
 * With a world `texel` the quad's UVs snap to that grid and the art is read
 * from the mip level whose texels match it, so a 5 m sigil and a 0.5 m glyph
 * show the same block size and thin lines fade rather than drop out.
 *
 * `glow` grows the quad around a symbol and builds a halo from the symbol's
 * own alpha (two rings of taps, confined to its cell so neighbours on the
 * sheet never bleed in), banded into PSX steps on the texel grid.
 */
export class SpriteLive extends LiveModule<SpriteModule> {
  readonly kind = "sprite" as const;
  private readonly mesh: THREE.Mesh;
  /** `world` + `crossed`: the second quad, at 90° around the long axis (same material, same quad). */
  private readonly cross: THREE.Mesh;
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly uOffset = uniform(new THREE.Vector2(0, 0));
  private readonly uScale = uniform(new THREE.Vector2(1, 1));
  private readonly uTint = uniform(new THREE.Color(1, 1, 1));
  private readonly uOpacity = uniform(1, "float");
  /** texel grid: cells across the quad (x, y) and the mip level matching them */
  private readonly uCells = uniform(new THREE.Vector2(0, 0));
  private readonly uLod = uniform(0, "float");
  /** halo: strength, reach (symbol units), quad enlargement, colour */
  private readonly uGlow = uniform(0, "float");
  private readonly uReach = uniform(0.14, "float");
  private readonly uPad = uniform(1, "float");
  private readonly uGlowColor = uniform(new THREE.Color(1, 1, 1));
  /** which shader variant is built: grid (texel) and/or halo */
  private grid = false;
  private halo = false;
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
    this.cross = new THREE.Mesh(quad, this.material);
    presentationOnly(this.cross);
    this.cross.visible = false;
    host.root.add(this.cross);
    this.buildShader();
  }

  private buildShader(): void {
    const map = this.map;
    if (map) {
      const grid = this.grid;
      // symbol-local coordinates; with a halo the quad is larger than the symbol
      const l: N = uv() as N;
      const c: N = this.halo ? l.sub(0.5).mul(this.uPad).add(0.5) : l;
      const cq: N = grid ? quantize(c, this.uCells) : c;
      const inside = (p: N): N => step(float(0), p.x).mul(step(p.x, float(1))).mul(step(float(0), p.y)).mul(step(p.y, float(1)));
      const at = (p: N): N => {
        const t = tslTexture(map, (clamp(p, 0, 1) as N).mul(this.uScale).add(this.uOffset)) as N;
        return grid ? (t.level(this.uLod) as N) : t;
      };
      const s: N = at(cq);
      const coreA: N = this.halo ? s.a.mul(inside(cq)) : s.a;
      let color: N = s.rgb.mul(this.uTint);
      let alpha: N = coreA;
      if (this.halo) {
        // a neon band: the STRONGEST line within reach, full near, half at the
        // outer ring. (An average reads nothing on thin line art; a boosted
        // average fills a sigil's interior into one white disc.)
        // three rings of taps, each ring weighted by its distance and rotated
        // off the last, so no single offset copy of the art stands out as a
        // ghost outline
        let halo: N = float(0);
        for (const [k, w, phase] of [[0.34, 1, 0], [0.67, 0.6, 0.33], [1, 0.3, 0.66]] as const) {
          for (let i = 0; i < 8; i++) {
            const a = ((i + phase) / 8) * Math.PI * 2;
            const p: N = cq.add(vec2(Math.cos(a), Math.sin(a)).mul(this.uReach.mul(k)));
            halo = halo.max(at(p).a.mul(inside(p)).mul(w));
          }
        }
        if (grid) halo = posterize(halo, float(3));
        const h: N = halo.mul(this.uGlow).mul(0.6).min(0.85).mul(float(1).sub(coreA));
        alpha = coreA.add(h);
        color = color.mul(coreA).add(this.uGlowColor.mul(h)).div(alpha.max(1e-3));
      }
      this.material.colorNode = color;
      this.material.opacityNode = alpha.mul(this.uOpacity);
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
    // the texel grid reads mipmapped art at a chosen level; legacy `pixel` reads nearest
    const onGrid = (module.texel > 0 ? module.texel : (ctx.texel ?? 0)) > 0;
    const halo = !!module.cell && module.glow > 0;
    const nearest = !onGrid && module.pixel > 0;
    const key = url ? `${url}#${nearest ? "nearest" : "linear"}` : "";
    const variantChanged = onGrid !== this.grid || halo !== this.halo;
    this.grid = onGrid;
    this.halo = halo;
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
      if (variantChanged && this.map) this.buildShader();
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
    this.uGlow.value = this.halo ? m.glow : 0;
    this.uReach.value = m.glowSize;
    this.uPad.value = this.halo ? 1 + 2 * m.glowSize : 1;
    moduleColor(m.glowColor, this.ctx.frame.palette, this.uGlowColor.value);
    this.mesh.visible = false;
    this.cross.visible = false;
  }

  protected onUpdate(t: number, _dt: number, camera: THREE.Camera): void {
    const m = this.module;
    if (!this.ready || !this.map) {
      this.mesh.visible = false;
      this.cross.visible = false;
      return;
    }
    const age = this.now - this.startedAt;
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
    this.uOpacity.value = this.opacityAt(t, this.now);

    const size = m.size * this.sizeAt(t);
    const pad = this.uPad.value;
    this.mesh.scale.set(size * pad, (size / Math.max(1e-3, m.aspect)) * pad, 1);
    if (this.grid) {
      // cells across the symbol on the world grid, and the mip whose texels match
      const cx = this.cellsAcross(size);
      this.uCells.value.set(cx, cx / Math.max(1e-3, m.aspect));
      const img = this.map.image as { width?: number } | undefined;
      const cellPx = (img?.width ?? 256) / this.cols;
      this.uLod.value = Math.max(0, Math.log2(cellPx / Math.max(1, cx)));
    }

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
      case "world": {
        // fixed in the world: the art's top runs along the motion; at rest it
        // stands upright, square to the spell direction (a stuck spear)
        const v = this.pose.velocity;
        const f = this.pose.forward;
        if (v.lengthSq() > 1e-4) axisUp.copy(v).normalize();
        else axisUp.set(0, 1, 0);
        axisRight.crossVectors(axisUp, Y);
        if (axisRight.lengthSq() < 1e-4) axisRight.crossVectors(axisUp, f);
        if (axisRight.lengthSq() < 1e-4) axisRight.set(1, 0, 0);
        axisRight.normalize();
        axisNormal.crossVectors(axisRight, axisUp).normalize();
        basisQ.setFromRotationMatrix(basis.makeBasis(axisRight, axisUp, axisNormal));
        // spin rolls around the long axis — a spinning spear, never a cartwheel
        roll.setFromAxisAngle(Y, spin);
        this.mesh.quaternion.copy(basisQ).multiply(roll);
        break;
      }
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
    const crossed = m.orient === "world" && m.crossed;
    this.cross.visible = crossed;
    if (crossed) {
      this.cross.position.copy(this.mesh.position);
      this.cross.scale.copy(this.mesh.scale);
      crossRoll.setFromAxisAngle(Y, Math.PI / 2);
      this.cross.quaternion.copy(this.mesh.quaternion).multiply(crossRoll);
    }
  }

  protected onEnd(): void {
    this.mesh.visible = false;
    this.cross.visible = false;
  }

  dispose(): void {
    this.cross.removeFromParent();
    this.mesh.removeFromParent();
    this.material.dispose();
  }
}
