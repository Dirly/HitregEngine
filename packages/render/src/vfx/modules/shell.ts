import * as THREE from "three/webgpu";
import { abs, float, mix, normalLocal, positionLocal, smoothstep, step, sub, vec3 } from "three/tsl";
import type { VfxModuleOf } from "@hitreg/core";
import { LiveModule, presentationOnly, sampleCurve, unlitMaterial, type LiveModuleHost } from "../base.js";
import { fresnel, makeUniforms, noise01, posterize, quantize, type N } from "../shaders.js";

type ShellModule = VfxModuleOf<"shell">;

const roll = new THREE.Quaternion();
const Y = new THREE.Vector3(0, 1, 0);
let sphere: THREE.SphereGeometry | null = null;

/** Body opacity (face-on) per style; the rim is always brighter. */
const BODY: Record<ShellModule["style"], number> = { energy: 0.22, glass: 0.06, smoke: 0.8, wire: 0 };

/**
 * A sphere with a fresnel rim, scrolling 3D noise and a dissolve threshold —
 * the orb in a hand, the barrier around a body, the pop of an impact, the
 * dome of a lingering field. One material, four styles by uniform.
 */
export class ShellLive extends LiveModule<ShellModule> {
  readonly kind = "shell" as const;
  private readonly mesh: THREE.Mesh;
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly u = makeUniforms();
  private readonly uDisplace: THREE.UniformNode<"float", number>;
  private readonly uWire: THREE.UniformNode<"float", number>;
  private readonly uSpeed: THREE.UniformNode<"float", number>;
  private readonly uPixel: THREE.UniformNode<"float", number>;
  private readonly uSteps: THREE.UniformNode<"float", number>;

  constructor(host: LiveModuleHost) {
    super(host);
    sphere ??= new THREE.SphereGeometry(1, 48, 32);
    const extra = makeUniforms();
    this.uDisplace = extra.a;
    this.uWire = extra.b;
    this.uSpeed = extra.c;
    this.uPixel = extra.d;
    this.uSteps = extra.e;
    this.material = unlitMaterial(true);
    this.material.side = THREE.FrontSide;
    this.buildShader();
    this.mesh = new THREE.Mesh(sphere, this.material);
    presentationOnly(this.mesh);
    this.mesh.visible = false;
    host.root.add(this.mesh);
  }

  private buildShader(): void {
    const u = this.u;
    // u.a = noise amount, u.b = noise scale, u.c = fresnel power, u.d = dissolve, u.e = body opacity
    const flow: N = vec3(u.time.mul(this.uSpeed), u.time.mul(this.uSpeed).mul(0.6), u.time.mul(this.uSpeed).mul(-0.4));
    const pl: N = quantize((positionLocal as N).mul(0.5).add(0.5), this.uPixel).sub(0.5).mul(2);
    // one octave — see tube.ts; a lingering dome is the biggest surface a spell draws
    const n: N = noise01(pl.mul(u.b).add(flow), 1);
    const rim: N = fresnel(u.c.max(0.01));
    // wire: bright lines where noise crosses its midpoint
    const lines: N = sub(float(1), smoothstep(float(0), float(0.1), abs(n.sub(0.5))));
    const surface: N = mix(float(1), n.mul(1.5), u.a);
    // Rim capped below 1: a full-strength silhouette on a squashed dome reads as
    // a solid white bowl from above, not as a rim.
    const body: N = mix(u.e, float(0.7), rim).mul(surface);
    const shape: N = mix(body, lines.add(rim.mul(0.4)), this.uWire);
    // dissolve: burn away where noise < threshold, with a glowing edge
    const keep: N = step(u.d, n);
    const edge: N = sub(float(1), smoothstep(float(0), float(0.12), n.sub(u.d))).mul(keep);
    const color: N = mix(mix(u.color, u.glow, rim), u.glow, edge);
    this.material.colorNode = color;
    this.material.opacityNode = posterize(shape.mul(keep), this.uSteps).mul(u.opacity);
    this.material.positionNode = (positionLocal as N).add((normalLocal as N).mul(n.sub(0.5)).mul(this.uDisplace));
    this.material.needsUpdate = true;
  }

  protected naturalLife(): number {
    return this.ctx.phaseLength > 0 ? this.ctx.phaseLength : 0.6;
  }

  protected onBegin(): void {
    const m = this.module;
    const additive = m.blend === "additive" && m.style !== "smoke";
    this.material.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    this.material.side = m.style === "smoke" ? THREE.DoubleSide : THREE.FrontSide;
    this.u.color.value.copy(this.color);
    this.u.glow.value.copy(this.color).lerp(new THREE.Color(1, 1, 1), 0.7);
    this.u.a.value = m.noise;
    this.u.b.value = m.noiseScale;
    this.u.c.value = m.fresnel;
    this.u.d.value = 0;
    this.u.e.value = BODY[m.style];
    this.uWire.value = m.style === "wire" ? 1 : 0;
    this.uDisplace.value = m.style === "energy" ? 0.06 * m.noise : m.style === "smoke" ? 0.12 : 0;
    this.uSpeed.value = m.noiseSpeed;
    this.uPixel.value = m.pixel;
    this.uSteps.value = m.posterize;
    this.mesh.visible = false;
  }

  protected onUpdate(t: number): void {
    const m = this.module;
    const now = this.startedAt + t * this.life;
    this.u.time.value = now;
    this.u.opacity.value = this.opacityAt(t, now);
    this.u.d.value = m.dissolve ? sampleCurve(m.dissolve, Math.min(1, t)) : 0;
    const expand = m.expand[0] + (m.expand[1] - m.expand[0]) * Math.min(1, t);
    const s = Math.max(0.001, m.radius * expand * this.sizeAt(t));
    this.mesh.scale.set(s, s * m.squash, s);
    this.mesh.position.copy(this.pose.position);
    roll.setFromAxisAngle(Y, m.spin * (now - this.startedAt));
    this.mesh.quaternion.copy(roll);
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
