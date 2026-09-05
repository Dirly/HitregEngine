import * as THREE from "three/webgpu";
import { attribute, float, floor, mix, positionWorld, saturate, step, uniform } from "three/tsl";
import type { VfxModuleOf } from "@hitreg/core";
import { LiveModule, hashCell, presentationOnly, unlitMaterial, type LiveModuleHost } from "../base.js";
import { posterize, type N } from "../shaders.js";

type TrailModule = VfxModuleOf<"trail">;

const MAX = 96;
const camPos = new THREE.Vector3();
const tmpDir = new THREE.Vector3();
const tmpToCam = new THREE.Vector3();
const tmpSide = new THREE.Vector3();

/**
 * A ribbon behind a moving anchor — the projectile's tail. Points are the
 * anchor's recent positions; each frame the strip is rebuilt facing the
 * camera, tapered toward the tail and faded by age.
 *
 * With `pixel` the ribbon goes PSX: the fade is banded into `posterize`
 * steps, the width steps with it, and a world-grid dither eats the tail away
 * in hard cells instead of a smooth gradient — so the trail dissolves into
 * pixels rather than smearing.
 */
export class TrailLive extends LiveModule<TrailModule> {
  readonly kind = "trail" as const;
  private readonly mesh: THREE.Mesh;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly positions = new Float32Array(MAX * 2 * 3);
  private readonly fades = new Float32Array(MAX * 2);
  private readonly posAttr: THREE.BufferAttribute;
  private readonly fadeAttr: THREE.BufferAttribute;
  private readonly uColor = uniform(new THREE.Color());
  private readonly uColorEnd = uniform(new THREE.Color());
  private readonly uOpacity = uniform(1, "float");
  /** cells per metre of the dither grid (0 = smooth) and alpha steps */
  private readonly uCells = uniform(0, "float");
  private readonly uSteps = uniform(0, "float");
  private readonly hx = new Float32Array(MAX);
  private readonly hy = new Float32Array(MAX);
  private readonly hz = new Float32Array(MAX);
  private readonly ht = new Float32Array(MAX);
  private head = 0;
  private count = 0;

  constructor(host: LiveModuleHost) {
    super(host);
    this.posAttr = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    this.fadeAttr = new THREE.BufferAttribute(this.fades, 1).setUsage(THREE.DynamicDrawUsage);
    const idx = new Uint16Array((MAX - 1) * 6);
    for (let i = 0; i < MAX - 1; i++) {
      const a = i * 2;
      const b = a + 2;
      idx.set([a, a + 1, b, a + 1, b + 1, b], i * 6);
    }
    this.geometry.setAttribute("position", this.posAttr);
    this.geometry.setAttribute("aFade", this.fadeAttr);
    this.geometry.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geometry.setDrawRange(0, 0);
    this.material = unlitMaterial(true);
    const fade: N = attribute("aFade", "float");
    const banded: N = posterize(fade, this.uSteps);
    const cell: N = floor((positionWorld as N).mul(this.uCells));
    const pixelOn: N = saturate(this.uCells);
    // keep a cell while the hash under it is below the fade: the tail thins
    // out pixel by pixel, the head stays solid
    const dither: N = mix(float(1), step(hashCell(cell), fade.mul(1.3)), pixelOn);
    this.material.colorNode = mix(this.uColorEnd, this.uColor, banded);
    this.material.opacityNode = banded.mul(dither).mul(this.uOpacity);
    this.material.needsUpdate = true;
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    presentationOnly(this.mesh);
    this.mesh.visible = false;
    host.root.add(this.mesh);
  }

  protected naturalLife(): number {
    return this.ctx.phaseLength > 0 ? this.ctx.phaseLength : 0.5;
  }

  protected tail(): number {
    return this.module.length;
  }

  protected onBegin(): void {
    const m = this.module;
    this.head = 0;
    this.count = 0;
    this.uColor.value.copy(this.color);
    this.uColorEnd.value.copy(this.colorEnd);
    // `pixel` is cells across the shape; a trail's shape is its width
    this.uCells.value = m.pixel > 0 ? Math.max(2, m.pixel / Math.max(0.1, m.width)) : 0;
    this.uSteps.value = m.posterize;
    this.material.blending = m.blend === "additive" ? THREE.AdditiveBlending : THREE.NormalBlending;
    this.mesh.visible = false;
  }

  private push(p: THREE.Vector3, now: number): void {
    const i = this.head;
    this.hx[i] = p.x;
    this.hy[i] = p.y;
    this.hz[i] = p.z;
    this.ht[i] = now;
    this.head = (i + 1) % MAX;
    this.count = Math.min(MAX, this.count + 1);
  }

  protected onUpdate(t: number, _dt: number, camera: THREE.Camera): void {
    const m = this.module;
    const now = this.startedAt + t * this.life;
    // keep sampling while alive; during the tail the ribbon just drains
    if (t < 1) {
      const last = (this.head - 1 + MAX) % MAX;
      const moved = this.count === 0 || Math.hypot(this.hx[last]! - this.pose.position.x, this.hy[last]! - this.pose.position.y, this.hz[last]! - this.pose.position.z) > 0.02;
      if (moved) this.push(this.pose.position, now);
    }
    camera.getWorldPosition(camPos);
    const o = this.opacityAt(Math.min(1, t), now);
    this.uOpacity.value = o;
    const half = m.width * 0.5 * this.sizeAt(Math.min(1, t));
    const steps = m.posterize > 0 ? m.posterize : 0;
    let written = 0;
    // newest first: index 0 is the head
    for (let k = 0; k < this.count; k++) {
      const i = (this.head - 1 - k + MAX) % MAX;
      const age = now - this.ht[i]!;
      if (age > m.length) break;
      const f = 1 - age / m.length;
      // the width steps down with the alpha bands, so the ribbon narrows in jumps
      const wf = m.taper ? (steps > 0 ? Math.ceil(f * steps) / steps : f) : 1;
      const j = (this.head - 2 - k + MAX) % MAX;
      const hasPrev = k + 1 < this.count;
      tmpDir.set(this.hx[i]! - (hasPrev ? this.hx[j]! : this.hx[i]!), this.hy[i]! - (hasPrev ? this.hy[j]! : this.hy[i]!), this.hz[i]! - (hasPrev ? this.hz[j]! : this.hz[i]!));
      if (tmpDir.lengthSq() < 1e-8) tmpDir.copy(this.pose.velocity);
      if (tmpDir.lengthSq() < 1e-8) tmpDir.set(0, 1, 0);
      tmpToCam.set(camPos.x - this.hx[i]!, camPos.y - this.hy[i]!, camPos.z - this.hz[i]!);
      tmpSide.crossVectors(tmpDir, tmpToCam);
      if (tmpSide.lengthSq() < 1e-8) tmpSide.set(1, 0, 0);
      tmpSide.normalize().multiplyScalar(half * wf);
      const o6 = written * 6;
      this.positions[o6] = this.hx[i]! + tmpSide.x;
      this.positions[o6 + 1] = this.hy[i]! + tmpSide.y;
      this.positions[o6 + 2] = this.hz[i]! + tmpSide.z;
      this.positions[o6 + 3] = this.hx[i]! - tmpSide.x;
      this.positions[o6 + 4] = this.hy[i]! - tmpSide.y;
      this.positions[o6 + 5] = this.hz[i]! - tmpSide.z;
      this.fades[written * 2] = f;
      this.fades[written * 2 + 1] = f;
      written++;
    }
    this.posAttr.needsUpdate = true;
    this.fadeAttr.needsUpdate = true;
    this.geometry.setDrawRange(0, Math.max(0, (written - 1) * 6));
    this.geometry.computeBoundingSphere();
    this.mesh.visible = written >= 2;
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
