import * as THREE from "three/webgpu";
import { float, mix, saturate, step, texture as tslTexture, uniform, uv } from "three/tsl";
import type { VfxModuleOf } from "@hitreg/core";
import { LiveModule, easeIn, easeOut, loadTexture, moduleColor, presentationOnly, unlitMaterial, type LiveModuleHost } from "../base.js";
import { posterize, quantize, type N } from "../shaders.js";

type DecalModule = VfxModuleOf<"decal">;

const SEGMENTS = 12;
const DRAPE_CLAMP = 2.5;
const yawQ = new THREE.Quaternion();
const tiltQ = new THREE.Quaternion();
const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);

/**
 * A ground mark that GROWS: cracks racing out from a strike, frost feathering
 * across the floor, vines and flowers sprouting, shadow veins creeping.
 *
 * The sheet is a decal page (`fx.mjs decals`): R holds WHEN each texel
 * appears, measured along the art itself from the strike point, so a crack
 * runs down its own line instead of wiping in as a circle. One uniform — the
 * reveal front — moves per frame; texels behind it show, texels just crossed
 * glow in the edge colour. Dying either fades or runs the front backwards.
 * Sampled nearest and without sRGB decode: the timing is data, and the
 * stepping reveal is the PSX look.
 */
export class DecalLive extends LiveModule<DecalModule> {
  readonly kind = "decal" as const;
  private readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.PlaneGeometry;
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly uOffset = uniform(new THREE.Vector2(0, 0));
  private readonly uScale = uniform(new THREE.Vector2(1, 1));
  private readonly uColor = uniform(new THREE.Color(1, 1, 1));
  private readonly uEdgeColor = uniform(new THREE.Color(1, 1, 1));
  private readonly uOpacity = uniform(1, "float");
  /** The reveal front, 0 (nothing) .. 1 + edge (everything, front gone). */
  private readonly uFront = uniform(0, "float");
  private readonly uEdge = uniform(0.08, "float");
  private readonly uShade = uniform(0.6, "float");
  private readonly uSteps = uniform(0, "float");
  /** texel grid: cells across the mark (x, y); 0 = the page's own texels */
  private readonly uCells = uniform(new THREE.Vector2(0, 0));
  private map: THREE.Texture | null = null;
  private mapKey = "";
  private ready = false;
  private cols = 1;
  private rows = 1;
  private yaw = 0;
  private centreY = 0;

  constructor(host: LiveModuleHost) {
    super(host);
    this.geometry = new THREE.PlaneGeometry(1, 1, SEGMENTS, SEGMENTS);
    this.material = unlitMaterial(true);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    presentationOnly(this.mesh);
    this.mesh.visible = false;
    host.root.add(this.mesh);
  }

  private buildShader(map: THREE.Texture): void {
    const s: N = tslTexture(map, quantize(uv() as N, this.uCells).mul(this.uScale).add(this.uOffset));
    const reveal: N = s.r;
    const shown: N = step(reveal, this.uFront);
    // texels the front crossed less than `edge` ago burn in the edge colour
    const since: N = this.uFront.sub(reveal).div(this.uEdge.max(1e-4));
    const front: N = shown.mul(float(1).sub(saturate(since))).mul(step(float(1e-4), this.uEdge));
    const body: N = this.uColor.mul(mix(float(1), s.g, this.uShade));
    this.material.colorNode = mix(body, this.uEdgeColor, front);
    this.material.opacityNode = posterize(s.a.mul(shown), this.uSteps).mul(this.uOpacity);
    this.material.needsUpdate = true;
  }

  /** Resolve the sheet before the base class asks for the natural life. */
  override begin(module: DecalModule, ctx: Parameters<LiveModule["begin"]>[1], now: number): void {
    const sheet = this.host.resolvers.sheet?.(module.sheet);
    this.cols = sheet?.grid?.cols ?? 1;
    this.rows = sheet?.grid?.rows ?? 1;
    const url = sheet ? this.host.resolvers.texture?.(sheet.texture) : undefined;
    this.ready = false;
    if (url && url !== this.mapKey) {
      this.mapKey = url;
      this.map = null;
      loadTexture(
        url,
        (t) => {
          if (this.mapKey !== url) return;
          this.map = t;
          this.buildShader(t);
          this.ready = true;
        },
        true,
        true,
      );
    } else if (url) {
      this.ready = this.map !== null;
    } else {
      console.warn(`[vfx] decal sheet "${module.sheet}" has no texture — module skipped`);
    }
    super.begin(module, ctx, now);
  }

  protected naturalLife(): number {
    return Math.max(this.module.grow, this.ctx.phaseLength > 0 ? this.ctx.phaseLength : 1.5);
  }

  protected tail(): number {
    return this.module.fadeOut;
  }

  protected onBegin(): void {
    const m = this.module;
    this.material.blending = m.blend === "additive" ? THREE.AdditiveBlending : THREE.NormalBlending;
    this.uColor.value.copy(this.color);
    moduleColor(m.edgeColor, this.ctx.frame.palette, this.uEdgeColor.value);
    this.uEdge.value = m.edge;
    this.uShade.value = m.shade;
    this.uSteps.value = m.posterize;
    const col = Math.min(this.cols - 1, m.cell[0]);
    const row = Math.min(this.rows - 1, m.cell[1]);
    this.uScale.value.set(1 / this.cols, 1 / this.rows);
    this.uOffset.value.set(col / this.cols, (this.rows - 1 - row) / this.rows);
    this.uFront.value = 0;
    const f = this.pose.forward;
    this.yaw = (m.randomYaw ? Math.random() * Math.PI * 2 : m.yaw) + Math.atan2(-f.x, -f.z);

    // drape: probe the terrain under every vertex once, store metres above the centre
    const pos = this.geometry.attributes["position"] as THREE.BufferAttribute;
    const ground = this.ctx.frame.ground;
    const p = this.pose.position;
    const w = m.size;
    const d = m.size / Math.max(1e-3, m.aspect);
    this.centreY = ground ? (ground(p.x, p.z, p.y + 1) ?? p.y) : p.y;
    const cos = Math.cos(this.yaw);
    const sin = Math.sin(this.yaw);
    for (let i = 0; i < pos.count; i++) {
      let dy = 0;
      if (m.drape && ground) {
        // plane (x, y) → tilted (x, 0, -y) → yawed around +Y
        const lx = pos.getX(i) * w;
        const lz = -pos.getY(i) * d;
        const gy = ground(p.x + lx * cos + lz * sin, p.z - lx * sin + lz * cos, this.centreY + 1);
        dy = gy === null ? 0 : Math.max(-DRAPE_CLAMP, Math.min(DRAPE_CLAMP, gy - this.centreY));
      }
      pos.setZ(i, dy);
    }
    pos.needsUpdate = true;
    this.geometry.computeBoundingSphere();
    this.mesh.visible = false;
  }

  protected onUpdate(t: number, _dt: number, _camera: THREE.Camera): void {
    const m = this.module;
    if (!this.ready || !this.map) {
      this.mesh.visible = false;
      return;
    }
    const age = this.now - this.startedAt;
    const full = 1 + m.edge;
    const g = m.grow > 0 ? Math.min(1, age / m.grow) : 1;
    const k = m.growEase === "out" ? easeOut(g) : m.growEase === "in" ? easeIn(g) : g;
    let front = k * full;
    let opacity = this.opacityAt(t, this.now);
    // past its life: the tail — run back, or fade
    const over = age - this.life;
    if (over > 0 && m.fadeOut > 0) {
      const f = Math.min(1, over / m.fadeOut);
      if (m.recede) front = Math.min(front, (1 - f) * full);
      else opacity *= 1 - f;
    }
    this.uFront.value = front;
    this.uOpacity.value = opacity;

    const size = m.size * this.sizeAt(t);
    this.mesh.scale.set(size, size / Math.max(1e-3, m.aspect), 1);
    if (this.texelSize() > 0) {
      const cx = this.cellsAcross(size);
      this.uCells.value.set(cx, cx / Math.max(1e-3, m.aspect));
    } else this.uCells.value.set(0, 0);
    const p = this.pose.position;
    this.mesh.position.set(p.x, (m.anchor.follow ? p.y : this.centreY) + 0.05, p.z);
    yawQ.setFromAxisAngle(Y, this.yaw);
    tiltQ.setFromAxisAngle(X, -Math.PI / 2);
    this.mesh.quaternion.copy(yawQ).multiply(tiltQ);
    this.mesh.visible = true;
  }

  protected onEnd(): void {
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
