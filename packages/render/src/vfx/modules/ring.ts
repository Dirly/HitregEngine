import * as THREE from "three/webgpu";
import { abs, float, mix, smoothstep, sub, texture as tslTexture, uv, vec2, vec3 } from "three/tsl";
import type { VfxModuleOf } from "@hitreg/core";
import { LiveModule, easeIn, easeOut, loadTexture, presentationOnly, unlitMaterial, type LiveModuleHost } from "../base.js";
import { makeUniforms, noise01, posterize, quantize, ringBand, type N } from "../shaders.js";

type RingModule = VfxModuleOf<"ring">;

const SEGMENTS = 72;
const DRAPE_CLAMP = 2.5;
const camQuat = new THREE.Quaternion();
const camPos = new THREE.Vector3();
const yawQ = new THREE.Quaternion();
const tiltQ = new THREE.Quaternion();
const roll = new THREE.Quaternion();
const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

/**
 * A disc or annulus: shockwaves, runes, portal faces, lingering floors.
 *
 * The band is drawn in the shader from the disc's UVs rather than baked into
 * the geometry, so `inner`, `soft`, `noise` and `swirl` are all uniforms and
 * one geometry serves every ring. Ground rings DRAPE: each vertex probes the
 * terrain once at spawn and stores its height as an offset from the centre,
 * so a uniform scale shrinks radius and relief together (the telegraph's
 * trick — exact at both ends, a slope in between).
 */
export class RingLive extends LiveModule<RingModule> {
  readonly kind = "ring" as const;
  private readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.CircleGeometry;
  private readonly baseY: Float32Array;
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly texMaterial: THREE.MeshBasicNodeMaterial;
  private readonly u = makeUniforms();
  /** a = arc half-angle (rad, >= PI disables), b = pixel cells, c = posterize steps */
  private readonly x = makeUniforms();
  private map: THREE.Texture | null = null;
  private mapUrl = "";
  private mapReady = false;
  private centreY = 0;

  constructor(host: LiveModuleHost) {
    super(host);
    this.geometry = new THREE.CircleGeometry(1, SEGMENTS);
    this.baseY = new Float32Array(this.geometry.attributes["position"]!.count);
    this.material = unlitMaterial(true);
    this.texMaterial = unlitMaterial(true);
    this.buildShader(this.material, null);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    presentationOnly(this.mesh);
    this.mesh.visible = false;
    host.root.add(this.mesh);
  }

  private buildShader(material: THREE.MeshBasicNodeMaterial, map: THREE.Texture | null): void {
    const u = this.u;
    const x = this.x;
    // PSX: quantise the disc coordinates before anything reads them
    const quv: N = quantize(uv() as N, x.b);
    const p: N = quv.sub(vec2(0.5, 0.5)).mul(2);
    const r: N = p.length();
    const angle: N = p.y.atan(p.x);
    const band: N = ringBand(u.a, u.b, r);
    // arc: keep the sector within the half-angle of +Y (the spell direction
    // after the ground tilt); a half-angle >= PI keeps everything
    const off: N = abs(angle.sub(float(Math.PI / 2)));
    const offWrapped: N = off.min(abs(angle.add(float(Math.PI * 1.5))));
    const sector: N = sub(float(1), smoothstep(x.a, x.a.add(0.06), offWrapped));
    const inArc: N = sector.max(smoothstep(float(Math.PI - 0.02), float(Math.PI), x.a));
    let alpha: N;
    let color: N;
    if (map) {
      // A mask ring is a drawn sigil: band × sector × the mask, and NO noise.
      // The old path evaluated two fractal noises per pixel under every mask
      // it never used — on a 5 m floor that was most of a big spell's GPU time.
      const s: N = tslTexture(map, quv);
      alpha = band.mul(inArc).mul(s.a);
      color = mix(u.color, u.glow, band.mul(0.15)).mul(s.rgb);
    } else {
      // Noise breaks the band into energy; swirl turns it into a spiral. One
      // evaluation: the coordinates blend between flat and polar, not the results.
      const spiralA: N = angle.add(r.mul(u.d).mul(6)).sub(u.time.mul(1.5));
      const coord: N = mix(vec3(quv.mul(u.e), u.time.mul(0.6)), vec3(r.mul(u.e), spiralA.mul(1.6), u.time.mul(0.35)), u.d.min(1));
      const n: N = noise01(coord, 1);
      const broken: N = mix(float(1), n.mul(1.6), u.c);
      alpha = band.mul(broken).mul(inArc);
      color = mix(u.color, u.glow, band.mul(0.35).mul(u.c));
    }
    material.colorNode = color;
    material.opacityNode = posterize(alpha, x.c).mul(u.opacity);
    material.needsUpdate = true;
  }

  protected naturalLife(): number {
    return this.ctx.phaseLength > 0 ? this.ctx.phaseLength : 0.6;
  }

  protected onBegin(): void {
    const m = this.module;
    const additive = m.blend === "additive";
    this.material.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    this.texMaterial.blending = this.material.blending;
    this.u.color.value.copy(this.color);
    this.u.glow.value.copy(this.color).lerp(new THREE.Color(1, 1, 1), 0.6);
    this.u.a.value = m.inner;
    this.u.b.value = m.soft;
    this.u.c.value = m.noise;
    this.u.d.value = m.swirl;
    this.u.e.value = 2.5;
    this.x.a.value = m.arc >= 360 ? Math.PI : (m.arc * Math.PI) / 360;
    this.x.b.value = m.pixel;
    this.x.c.value = m.posterize;

    // texture (a rune, a sigil): swap material once it lands
    if (m.texture) {
      const url = this.host.resolvers.texture?.(m.texture);
      if (url && url !== this.mapUrl) {
        this.mapUrl = url;
        this.mapReady = false;
        loadTexture(url, (t) => {
          if (this.mapUrl !== url) return;
          // masks are pixel art: never bilinear
          t.magFilter = THREE.NearestFilter;
          t.minFilter = THREE.NearestFilter;
          t.needsUpdate = true;
          this.map = t;
          this.buildShader(this.texMaterial, t);
          this.mapReady = true;
          this.mesh.material = this.texMaterial;
        });
      } else if (url && this.mapReady) {
        this.mesh.material = this.texMaterial;
      }
    } else {
      this.mesh.material = this.material;
    }

    // drape
    const pos = this.geometry.attributes["position"] as THREE.BufferAttribute;
    const ground = this.ctx.frame.ground;
    const p = this.pose.position;
    this.centreY = p.y;
    if (m.orient === "ground" && m.drape && ground) {
      const cy = ground(p.x, p.z, p.y + 1) ?? p.y;
      this.centreY = cy;
      const yaw = 0;
      for (let i = 0; i < pos.count; i++) {
        const lx = pos.getX(i) * m.radius;
        const ly = pos.getY(i) * m.radius; // circle lies in XY; rotated to XZ below
        const wx = p.x + lx * Math.cos(yaw);
        const wz = p.z - ly;
        const gy = ground(wx, wz, cy + 1);
        const dy = gy === null ? 0 : Math.max(-DRAPE_CLAMP, Math.min(DRAPE_CLAMP, gy - cy));
        // stored in the unscaled geometry's units: the mesh scales by radius
        this.baseY[i] = dy / Math.max(1e-3, m.radius);
      }
    } else {
      this.baseY.fill(0);
    }
    // CircleGeometry is flat in XY facing +Z; drape rides Z (which becomes
    // world Y after the -90° tilt).
    for (let i = 0; i < pos.count; i++) pos.setZ(i, this.baseY[i]!);
    pos.needsUpdate = true;
    this.geometry.computeBoundingSphere();
    this.mesh.visible = false;
  }

  protected onUpdate(t: number, _dt: number, camera: THREE.Camera): void {
    const m = this.module;
    const now = this.startedAt + t * this.life;
    this.u.time.value = now;
    this.u.opacity.value = this.opacityAt(t, now);

    const k = m.ease === "out" ? easeOut(Math.min(1, t)) : m.ease === "in" ? easeIn(Math.min(1, t)) : Math.min(1, t);
    const expand = m.expand[0] + (m.expand[1] - m.expand[0]) * k;
    const s = Math.max(0.001, m.radius * expand * this.sizeAt(t));
    this.mesh.scale.set(s, s, s);

    const p = this.pose.position;
    const spin = m.spin * (now - this.startedAt);
    switch (m.orient) {
      case "ground": {
        this.mesh.position.set(p.x, (m.anchor.follow ? p.y : this.centreY) + 0.06, p.z);
        // The disc's +Y lands on world -Z after the tilt; yaw it onto the
        // spell direction so wedges and masks point where the spell does.
        const f = this.pose.forward;
        yawQ.setFromAxisAngle(Y, spin + Math.atan2(-f.x, -f.z));
        tiltQ.setFromAxisAngle(X, -Math.PI / 2);
        this.mesh.quaternion.copy(yawQ).multiply(tiltQ);
        break;
      }
      case "facing":
        this.mesh.position.set(p.x, p.y + m.height, p.z);
        roll.setFromAxisAngle(Z, spin);
        this.mesh.quaternion.copy(this.pose.facing).multiply(roll);
        break;
      case "vertical": {
        camera.getWorldPosition(camPos);
        this.mesh.position.set(p.x, p.y + m.height, p.z);
        yawQ.setFromAxisAngle(Y, Math.atan2(camPos.x - p.x, camPos.z - p.z));
        roll.setFromAxisAngle(Z, spin);
        this.mesh.quaternion.copy(yawQ).multiply(roll);
        break;
      }
      case "billboard":
        this.mesh.position.set(p.x, p.y + m.height, p.z);
        camera.getWorldQuaternion(camQuat);
        roll.setFromAxisAngle(Z, spin);
        this.mesh.quaternion.copy(camQuat).multiply(roll);
        break;
    }
    this.mesh.visible = !m.texture || this.mapReady;
  }

  protected onEnd(): void {
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    this.texMaterial.dispose();
  }
}
