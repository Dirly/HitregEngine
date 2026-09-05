import * as THREE from "three/webgpu";
import { float, mix, positionLocal, sub, uv, vec3 } from "three/tsl";
import type { VfxModuleOf } from "@hitreg/core";
import { LiveModule, presentationOnly, unlitMaterial, type LiveModuleHost } from "../base.js";
import { capFade, fresnel, makeUniforms, noise01, posterize, quantize, type N } from "../shaders.js";

type ColumnModule = VfxModuleOf<"column">;
type BeamModule = VfxModuleOf<"beam">;

const Y = new THREE.Vector3(0, 1, 0);
const tmpDir = new THREE.Vector3();
const tmpEnd = new THREE.Vector3();
const flip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
const spinQ = new THREE.Quaternion();
let cylinder: THREE.CylinderGeometry | null = null;

/**
 * One open cylinder with a soft-edged, cap-faded, noise-scrolled shader. A
 * pillar of light, a breath cone, a hanging judgement beam and a laser
 * between two points are all this mesh with different uniforms and a
 * different placement — which is the reason column and beam share it.
 *
 * The far-end radius is applied in the VERTEX shader (`uTop`), so a cone and
 * a pillar share geometry too.
 */
class TubeMesh {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshBasicNodeMaterial;
  readonly u = makeUniforms();
  /** Far-end radius ratio, cap fades, edge fade, noise scale, axial stretch. */
  readonly x = makeUniforms();
  /** PSX cells and alpha steps. */
  readonly q = makeUniforms();

  constructor(root: THREE.Object3D) {
    cylinder ??= new THREE.CylinderGeometry(1, 1, 1, 48, 8, true);
    this.material = unlitMaterial(true);
    this.mesh = new THREE.Mesh(cylinder, this.material);
    presentationOnly(this.mesh);
    this.mesh.visible = false;
    root.add(this.mesh);
    this.build();
  }

  private build(): void {
    const u = this.u; // color, glow, opacity, time, a=noise amount, b=scroll, c=pulse phase(unused), d=core mix
    const x = this.x; // a=top ratio, b=cap lo, c=cap hi, d=edge fade, e=noise scale ; x.opacity=axial stretch
    const quv: N = quantize(uv() as N, this.q.a);
    const v: N = quv.y; // 1 at the top (+Y), 0 at the base
    // cone: scale x/z by the far-end ratio along the axis
    const s: N = mix(float(1), x.a, v);
    const p: N = positionLocal as N;
    this.material.positionNode = vec3(p.x.mul(s), p.y, p.z.mul(s));
    const caps: N = capFade(v, x.b, x.c);
    // Silhouette fade with a wide falloff (power 1.1): a tube with a hard
    // vertical edge reads as a painted cylinder, not as light.
    const edge: N = mix(float(1), sub(float(1), fresnel(float(1.1))), x.d);
    const qp: N = quantize(p.mul(0.5).add(0.5), this.q.a).sub(0.5).mul(2);
    // One octave: a column is a lot of screen, and the second octave was the
    // single most expensive thing in a big spell (a 3D perlin per pixel per
    // surface, several surfaces deep). Posterised it was invisible anyway.
    const n: N = noise01(vec3(qp.x.mul(x.e).mul(2), v.mul(x.e).mul(x.opacity).sub(u.time.mul(u.b)), qp.z.mul(x.e).mul(2)), 1);
    const broken: N = mix(float(1), n.mul(1.7), u.a);
    // 0.3 toward glow, not 0.5: the old mix made every cone and pillar a
    // white wedge as soon as two of them overlapped
    this.material.colorNode = mix(u.color, u.glow, caps.mul(edge).mul(0.3).add(u.d));
    this.material.opacityNode = posterize(caps.mul(edge).mul(broken), this.q.b).mul(u.opacity);
    this.material.needsUpdate = true;
  }

  set(color: THREE.Color, glow: THREE.Color, opts: { top: number; capLo: number; capHi: number; edge: number; noise: number; scale: number; stretch: number; scroll: number; core: number; additive: boolean; pixel?: number; posterize?: number }): void {
    this.q.a.value = opts.pixel ?? 0;
    this.q.b.value = opts.posterize ?? 0;
    this.u.color.value.copy(color);
    this.u.glow.value.copy(glow);
    this.u.a.value = opts.noise;
    this.u.b.value = opts.scroll;
    this.u.d.value = opts.core;
    this.x.a.value = opts.top;
    this.x.b.value = opts.capLo;
    this.x.c.value = opts.capHi;
    this.x.d.value = opts.edge;
    this.x.e.value = opts.scale;
    this.x.opacity.value = opts.stretch;
    this.material.blending = opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.material.dispose();
  }
}

export class ColumnLive extends LiveModule<ColumnModule> {
  readonly kind = "column" as const;
  private readonly tube: TubeMesh;
  private readonly glow = new THREE.Color();

  constructor(host: LiveModuleHost) {
    super(host);
    this.tube = new TubeMesh(host.root);
  }

  protected naturalLife(): number {
    return this.ctx.phaseLength > 0 ? this.ctx.phaseLength : 0.8;
  }

  protected onBegin(): void {
    const m = this.module;
    this.glow.copy(this.color).lerp(new THREE.Color(1, 1, 1), 0.65);
    const top = (m.topRadius ?? m.radius) / Math.max(1e-3, m.radius);
    this.tube.set(this.color, this.glow, {
      top,
      capLo: m.capFade[0],
      capHi: m.capFade[1],
      edge: m.edgeFade,
      noise: m.noise,
      scale: m.noiseScale,
      stretch: m.height / Math.max(0.2, m.radius),
      scroll: m.scroll,
      core: 0,
      additive: m.blend === "additive",
      pixel: m.pixel,
      posterize: m.posterize,
    });
    this.tube.mesh.visible = false;
  }

  protected onUpdate(t: number): void {
    const m = this.module;
    const now = this.startedAt + t * this.life;
    this.tube.u.time.value = now;
    this.tube.u.opacity.value = this.opacityAt(t, now);
    const expand = m.expand[0] + (m.expand[1] - m.expand[0]) * Math.min(1, t);
    const r = Math.max(0.001, m.radius * expand * this.sizeAt(t));
    const h = Math.max(0.001, m.height * (0.7 + 0.3 * expand));
    const mesh = this.tube.mesh;
    const p = this.pose.position;
    mesh.scale.set(r, h, r);
    spinQ.setFromAxisAngle(Y, m.spin * (now - this.startedAt));
    switch (m.orient) {
      case "up":
        mesh.position.set(p.x, p.y + h / 2, p.z);
        mesh.quaternion.copy(spinQ);
        break;
      case "down":
        // base at the sky end, far end on the anchor
        mesh.position.set(p.x, p.y + h / 2, p.z);
        mesh.quaternion.copy(flip).multiply(spinQ);
        break;
      case "forward": {
        tmpDir.copy(this.pose.forward);
        mesh.position.copy(p).addScaledVector(tmpDir, h / 2);
        mesh.quaternion.setFromUnitVectors(Y, tmpDir).multiply(spinQ);
        break;
      }
    }
    mesh.visible = true;
  }

  protected onEnd(): void {
    this.tube.mesh.visible = false;
  }

  dispose(): void {
    this.tube.dispose();
  }
}

/** A beam from the anchor to the target (or along the direction): glow + core. */
export class BeamLive extends LiveModule<BeamModule> {
  readonly kind = "beam" as const;
  private readonly glow: TubeMesh;
  private readonly core: TubeMesh;
  private readonly glowColor = new THREE.Color();

  constructor(host: LiveModuleHost) {
    super(host);
    this.glow = new TubeMesh(host.root);
    this.core = new TubeMesh(host.root);
  }

  protected naturalLife(): number {
    return this.ctx.phaseLength > 0 ? this.ctx.phaseLength : 0.5;
  }

  protected onBegin(): void {
    const m = this.module;
    this.glowColor.copy(this.colorEnd);
    const laser = m.style === "laser";
    const plasma = m.style === "plasma";
    this.glow.set(this.color, this.glowColor, {
      top: 1 - m.taper,
      capLo: 0.03,
      capHi: 0.06,
      edge: laser ? 0.6 : plasma ? 0.95 : 0.9,
      noise: laser ? m.noise * 0.4 : m.noise,
      scale: plasma ? 0.8 : 1.4,
      stretch: 1,
      scroll: m.scroll,
      core: 0,
      additive: m.blend === "additive",
      pixel: m.pixel,
      posterize: m.posterize,
    });
    this.core.set(this.glowColor, new THREE.Color(1, 1, 1), {
      top: 1 - m.taper,
      capLo: 0.02,
      capHi: 0.04,
      edge: laser ? 0.1 : 0.4,
      noise: laser ? 0 : m.noise * 0.5,
      scale: 1.4,
      stretch: 1,
      scroll: m.scroll * 1.6,
      core: 0.5,
      additive: true,
      pixel: m.pixel,
      posterize: m.posterize,
    });
    this.glow.mesh.visible = false;
    this.core.mesh.visible = false;
  }

  private endPoint(out: THREE.Vector3): void {
    const f = this.ctx.frame;
    const m = this.module;
    if (m.toTarget) {
      if (f.targetObject) {
        f.targetObject.updateWorldMatrix(true, false);
        out.setFromMatrixPosition(f.targetObject.matrixWorld);
        out.y += 0.9;
        return;
      }
      if (f.target) {
        out.set(f.target[0], f.target[1], f.target[2]);
        return;
      }
    }
    out.copy(this.pose.position).addScaledVector(this.pose.forward, m.length);
  }

  protected onUpdate(t: number): void {
    const m = this.module;
    const now = this.startedAt + t * this.life;
    const age = now - this.startedAt;
    const o = this.opacityAt(t, now);
    this.endPoint(tmpEnd);
    tmpDir.copy(tmpEnd).sub(this.pose.position);
    const len = Math.max(0.05, tmpDir.length());
    tmpDir.divideScalar(len);
    const pulse = m.pulse > 0 ? 1 + m.pulseDepth * Math.sin(age * m.pulse * Math.PI * 2) : 1;
    const w = m.width * pulse * this.sizeAt(t);
    for (const [tube, width, opacity] of [
      [this.glow, w, o * 0.7],
      [this.core, w * m.core, o * (m.core > 0 ? 0.9 : 0)],
    ] as const) {
      tube.u.time.value = now;
      tube.u.opacity.value = opacity;
      tube.x.opacity.value = len / Math.max(0.2, width); // noise stretch along the axis
      const mesh = tube.mesh;
      mesh.scale.set(width / 2, len, width / 2);
      mesh.position.copy(this.pose.position).addScaledVector(tmpDir, len / 2);
      mesh.quaternion.setFromUnitVectors(Y, tmpDir);
      mesh.visible = width > 0;
    }
  }

  protected onEnd(): void {
    this.glow.mesh.visible = false;
    this.core.mesh.visible = false;
  }

  dispose(): void {
    this.glow.dispose();
    this.core.dispose();
  }
}
