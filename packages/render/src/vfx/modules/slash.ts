import * as THREE from "three/webgpu";
import { abs, float, mix, smoothstep, sub, uv, vec2 } from "three/tsl";
import type { VfxModuleOf } from "@hitreg/core";
import { LiveModule, presentationOnly, unlitMaterial, type LiveModuleHost } from "../base.js";
import { makeUniforms, posterize, quantize, ringBand, type N } from "../shaders.js";

type SlashModule = VfxModuleOf<"slash">;

const SEGMENTS = 64;
const X = new THREE.Vector3(1, 0, 0);
const Z = new THREE.Vector3(0, 0, 1);
const tiltX = new THREE.Quaternion().setFromAxisAngle(X, -Math.PI / 2);
const rollQ = new THREE.Quaternion();
let disc: THREE.CircleGeometry | null = null;

/**
 * A melee cut: an annular sector whose LEADING EDGE sweeps across the arc
 * over `sweepTime` of the life, with a fading tail behind it — the anime
 * slash, drawn from one disc. The cutting plane rolls around the spell
 * direction (`tilt`): flat is a cleave, upright an overhead chop, ±45 a
 * diagonal; two copies with `repeat.alternate` are an X.
 *
 * Everything is in the shader: the band, the sector, the sweep and the tail
 * are uniforms on a unit disc, so a hundred different cuts share one
 * geometry and one program.
 */
export class SlashLive extends LiveModule<SlashModule> {
  readonly kind = "slash" as const;
  private readonly mesh: THREE.Mesh;
  private readonly material: THREE.MeshBasicNodeMaterial;
  /** color/glow/opacity; a = inner, b = soft, c = half-sweep (rad), d = head 0..1, e = tail */
  private readonly u = makeUniforms();
  /** a = core, b = pixel cells, c = posterize steps, d = reverse (0/1) */
  private readonly x = makeUniforms();

  constructor(host: LiveModuleHost) {
    super(host);
    disc ??= new THREE.CircleGeometry(1, SEGMENTS);
    this.material = unlitMaterial(true);
    this.buildShader();
    this.mesh = new THREE.Mesh(disc, this.material);
    presentationOnly(this.mesh);
    this.mesh.visible = false;
    host.root.add(this.mesh);
  }

  private buildShader(): void {
    const u = this.u;
    const x = this.x;
    const quv: N = quantize(uv() as N, x.b);
    const p: N = quv.sub(vec2(0.5, 0.5)).mul(2);
    const r: N = p.length();
    const angle: N = p.y.atan(p.x);
    const band: N = ringBand(u.a, u.b, r);
    // The arc is centred on the disc's -Y, which the placement below puts on
    // the spell direction. `d` runs -1..1 across the sweep.
    const centred: N = angle.add(float(Math.PI / 2));
    const wrapped: N = centred.sub(centred.div(Math.PI * 2).add(0.5).floor().mul(Math.PI * 2));
    const d: N = wrapped.div(u.c.max(0.01));
    const inArc: N = sub(float(1), smoothstep(float(1), float(1.04), abs(d)));
    // position along the arc, 0 = where the sweep starts, 1 = where it ends
    const along: N = mix(d.mul(0.5).add(0.5), sub(float(0.5), d.mul(0.5)), x.d);
    // the leading edge is at `head`; behind it the tail fades over `e`
    const behind: N = u.d.sub(along);
    const lit: N = smoothstep(float(0), float(0.02), behind).mul(sub(float(1), smoothstep(float(0), u.e.max(0.01), behind)));
    const edge: N = sub(float(1), smoothstep(float(0), float(0.12), behind));
    const alpha: N = band.mul(inArc).mul(lit);
    this.material.colorNode = mix(u.color, u.glow, edge.mul(x.a));
    this.material.opacityNode = posterize(alpha, x.c).mul(u.opacity);
    this.material.needsUpdate = true;
  }

  protected naturalLife(): number {
    return 0.3;
  }

  protected onBegin(): void {
    const m = this.module;
    this.material.blending = m.blend === "additive" ? THREE.AdditiveBlending : THREE.NormalBlending;
    this.u.color.value.copy(this.color);
    this.u.glow.value.copy(this.color).lerp(new THREE.Color(1, 1, 1), 0.75);
    this.u.a.value = m.inner;
    this.u.b.value = m.soft;
    this.u.c.value = (m.sweep * Math.PI) / 360;
    this.u.e.value = m.tail;
    this.x.a.value = m.core;
    this.x.b.value = m.pixel;
    this.x.c.value = m.posterize;
    this.x.d.value = m.reverse ? 1 : 0;
    this.mesh.visible = false;
  }

  protected onUpdate(t: number): void {
    const m = this.module;
    const now = this.startedAt + t * this.life;
    this.u.opacity.value = this.opacityAt(t, now);
    // the head crosses the arc over sweepTime, then overshoots so the tail drains
    const k = Math.min(1, t) / Math.max(0.05, m.sweepTime);
    this.u.d.value = k * (1 + m.tail);
    const s = Math.max(0.001, m.radius * this.sizeAt(t));
    this.mesh.scale.set(s, s, s);
    const p = this.pose.position;
    this.mesh.position.set(p.x, p.y + m.height, p.z);
    // facing puts +Z on the spell direction; roll the cutting plane around
    // it, then lay the disc flat so its -Y points forward
    rollQ.setFromAxisAngle(Z, (m.tilt * Math.PI) / 180);
    this.mesh.quaternion.copy(this.pose.facing).multiply(rollQ).multiply(tiltX);
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
