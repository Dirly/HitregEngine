import * as THREE from "three/webgpu";
import { attribute, uniform } from "three/tsl";
import type { VfxModuleOf } from "@hitreg/core";
import { LiveModule, presentationOnly, unlitMaterial, type LiveModuleHost } from "../base.js";
import type { N } from "../shaders.js";

type BoltModule = VfxModuleOf<"bolt">;

const MAX_POINTS = 6 * 64 + 8 * 24;
const MAX_STRANDS = 6 + 8;
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpU = new THREE.Vector3();
const tmpV = new THREE.Vector3();
const tmpDir = new THREE.Vector3();
const tmpSide = new THREE.Vector3();
const tmpToCam = new THREE.Vector3();
const camPos = new THREE.Vector3();

/** A camera-facing ribbon strip: two verts per point, a fade per point. */
class Ribbon {
  readonly mesh: THREE.Mesh;
  readonly geometry = new THREE.BufferGeometry();
  readonly material: THREE.MeshBasicNodeMaterial;
  readonly positions: Float32Array;
  readonly fades: Float32Array;
  readonly uColor = uniform(new THREE.Color(1, 1, 1));
  readonly uOpacity = uniform(1, "float");
  private readonly posAttr: THREE.BufferAttribute;
  private readonly fadeAttr: THREE.BufferAttribute;
  private readonly index: THREE.BufferAttribute;

  constructor(root: THREE.Object3D, maxPoints: number) {
    this.positions = new Float32Array(maxPoints * 2 * 3);
    this.fades = new Float32Array(maxPoints * 2);
    this.posAttr = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    this.fadeAttr = new THREE.BufferAttribute(this.fades, 1).setUsage(THREE.DynamicDrawUsage);
    const idx = new Uint16Array((maxPoints - 1) * 6);
    this.index = new THREE.BufferAttribute(idx, 1).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("position", this.posAttr);
    this.geometry.setAttribute("aFade", this.fadeAttr);
    this.geometry.setIndex(this.index);
    this.geometry.setDrawRange(0, 0);
    this.material = unlitMaterial(true);
    const fade: N = attribute("aFade", "float");
    this.material.colorNode = this.uColor;
    this.material.opacityNode = fade.mul(this.uOpacity);
    this.material.needsUpdate = true;
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    presentationOnly(this.mesh);
    this.mesh.visible = false;
    root.add(this.mesh);
  }

  /**
   * Write `segments` (lists of points, each with a fade) as camera-facing
   * quads of `halfWidth`. Returns the number of points written.
   */
  write(segments: ReadonlyArray<{ points: THREE.Vector3[]; fades: number[] }>, halfWidth: number, camera: THREE.Camera): void {
    camera.getWorldPosition(camPos);
    let p = 0;
    let tri = 0;
    const idx = this.index.array as Uint16Array;
    for (const seg of segments) {
      const n = seg.points.length;
      if (n < 2) continue;
      const first = p;
      for (let i = 0; i < n; i++) {
        const pt = seg.points[i]!;
        const next = seg.points[Math.min(n - 1, i + 1)]!;
        const prev = seg.points[Math.max(0, i - 1)]!;
        tmpDir.copy(next).sub(prev);
        if (tmpDir.lengthSq() < 1e-8) tmpDir.set(0, 1, 0);
        tmpToCam.copy(camPos).sub(pt);
        tmpSide.crossVectors(tmpDir, tmpToCam);
        if (tmpSide.lengthSq() < 1e-8) tmpSide.set(1, 0, 0);
        tmpSide.normalize().multiplyScalar(halfWidth);
        const o = p * 6;
        this.positions[o] = pt.x + tmpSide.x;
        this.positions[o + 1] = pt.y + tmpSide.y;
        this.positions[o + 2] = pt.z + tmpSide.z;
        this.positions[o + 3] = pt.x - tmpSide.x;
        this.positions[o + 4] = pt.y - tmpSide.y;
        this.positions[o + 5] = pt.z - tmpSide.z;
        const f = seg.fades[i] ?? 1;
        this.fades[p * 2] = f;
        this.fades[p * 2 + 1] = f;
        if (i > 0) {
          const a = (p - 1) * 2;
          const b = p * 2;
          idx[tri++] = a;
          idx[tri++] = a + 1;
          idx[tri++] = b;
          idx[tri++] = a + 1;
          idx[tri++] = b + 1;
          idx[tri++] = b;
        }
        p++;
        if (p * 2 >= this.fades.length) break;
      }
      if (p === first) continue;
    }
    this.posAttr.needsUpdate = true;
    this.fadeAttr.needsUpdate = true;
    this.index.needsUpdate = true;
    this.geometry.setDrawRange(0, tri);
    this.geometry.computeBoundingSphere();
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}

interface Strand {
  points: THREE.Vector3[];
  fades: number[];
}

/**
 * Lightning: a jagged polyline re-rolled `refreshHz` times a second, with
 * forks, drawn as a wide glow ribbon and a thin bright core. No texture —
 * the flicker, the branching and the two-layer width are what the eye reads
 * as electricity, not the sprite.
 */
export class BoltLive extends LiveModule<BoltModule> {
  readonly kind = "bolt" as const;
  private readonly glow: Ribbon;
  private readonly core: Ribbon;
  private readonly strands: Strand[] = [];
  private nextRoll = 0;
  private flickerMul = 1;
  private readonly start = new THREE.Vector3();
  private readonly end = new THREE.Vector3();
  private readonly groundDir = new THREE.Vector3();

  constructor(host: LiveModuleHost) {
    super(host);
    this.glow = new Ribbon(host.root, MAX_POINTS);
    this.core = new Ribbon(host.root, MAX_POINTS);
    for (let i = 0; i < MAX_STRANDS; i++) {
      const points: THREE.Vector3[] = [];
      for (let k = 0; k < 64; k++) points.push(new THREE.Vector3());
      this.strands.push({ points, fades: new Array<number>(64).fill(1) });
    }
  }

  protected naturalLife(): number {
    return this.ctx.phaseLength > 0 ? this.ctx.phaseLength : 0.3;
  }

  protected onBegin(): void {
    this.nextRoll = 0;
    this.groundDir.set(Math.random() * 2 - 1, 0, Math.random() * 2 - 1).normalize();
    // The wide ribbon carries the element; the core is near-white on its own,
    // which is what reads as electricity rather than as a coloured rope.
    this.glow.uColor.value.copy(this.color);
    this.core.uColor.value.set(1, 1, 1).lerp(this.color, 0.2);
    this.glow.mesh.visible = false;
    this.core.mesh.visible = false;
  }

  /** Where the bolt runs, per arc mode. */
  private endpoints(): void {
    const m = this.module;
    const f = this.ctx.frame;
    const p = this.pose.position;
    switch (m.arc) {
      case "sky": {
        this.end.copy(p);
        this.start.set(p.x + (Math.random() - 0.5) * m.length * 0.25, p.y + m.length, p.z + (Math.random() - 0.5) * m.length * 0.25);
        break;
      }
      case "ground": {
        this.start.copy(p);
        this.end.copy(p).addScaledVector(this.groundDir, m.length);
        const gy = f.ground?.(this.end.x, this.end.z, this.end.y + 1);
        if (gy !== null && gy !== undefined) this.end.y = gy + 0.1;
        break;
      }
      case "line":
      default: {
        this.start.copy(p);
        if (m.toTarget && f.targetObject) {
          f.targetObject.updateWorldMatrix(true, false);
          this.end.setFromMatrixPosition(f.targetObject.matrixWorld);
          this.end.y += 0.9;
        } else if (m.toTarget && f.target) {
          this.end.set(f.target[0], f.target[1], f.target[2]);
        } else {
          this.end.copy(p).addScaledVector(this.pose.forward, m.length);
        }
      }
    }
  }

  /** Re-roll every strand (`count`) and their forks. */
  private roll(): void {
    const m = this.module;
    this.endpoints();
    let used = 0;
    const strands = Math.min(m.count, 6);
    for (let s = 0; s < strands && used < this.strands.length; s++) {
      // each strand gets its own far end when there is spread
      tmpB.copy(this.end);
      if (m.spread > 0 && s > 0) tmpB.add(tmpA.set(Math.random() - 0.5, (Math.random() - 0.5) * 0.5, Math.random() - 0.5).multiplyScalar(m.spread * 2));
      used = this.rollStrand(used, this.start, tmpB, m);
    }
    for (let s = used; s < this.strands.length; s++) this.strands[s]!.points.length = 0;
    this.flickerMul = 1 - m.flicker * Math.random();
  }

  /** One main path from `a` to `b` plus its forks; returns the next free strand. */
  private rollStrand(first: number, a: THREE.Vector3, b: THREE.Vector3, m: BoltModule): number {
    tmpDir.copy(b).sub(a);
    const len = tmpDir.length();
    if (len < 1e-3) return first;
    tmpDir.divideScalar(len);
    const startPt = a;
    // a frame perpendicular to the path for the jitter
    tmpU.set(0, 1, 0);
    if (Math.abs(tmpDir.dot(tmpU)) > 0.9) tmpU.set(1, 0, 0);
    tmpU.cross(tmpDir).normalize();
    tmpV.crossVectors(tmpDir, tmpU).normalize();

    const n = m.segments;
    const main = this.strands[first]!;
    main.points.length = n + 1;
    main.fades.length = n + 1;
    for (let i = 0; i <= n; i++) {
      const k = i / n;
      const amp = m.jitter * Math.sqrt(Math.sin(Math.PI * k)); // pinned at both ends
      main.points[i] ??= new THREE.Vector3();
      main.points[i]!.copy(startPt)
        .addScaledVector(tmpDir, len * k)
        .addScaledVector(tmpU, (Math.random() * 2 - 1) * amp)
        .addScaledVector(tmpV, (Math.random() * 2 - 1) * amp);
      main.fades[i] = 1;
    }
    let used = first + 1;
    for (let b = 0; b < m.branches && used < this.strands.length; b++) {
      const strand = this.strands[used++]!;
      const from = 1 + Math.floor(Math.random() * Math.max(1, n - 2));
      const origin = main.points[from]!;
      const bl = len * m.branchLength * (0.6 + Math.random() * 0.6);
      const bn = Math.max(2, Math.round(n * m.branchLength));
      // fork off the main direction by 20–55°
      tmpA.copy(tmpDir)
        .addScaledVector(tmpU, (Math.random() - 0.5) * 1.4)
        .addScaledVector(tmpV, (Math.random() - 0.5) * 1.4)
        .normalize();
      strand.points.length = bn + 1;
      strand.fades.length = bn + 1;
      for (let i = 0; i <= bn; i++) {
        const k = i / bn;
        strand.points[i] ??= new THREE.Vector3();
        strand.points[i]!.copy(origin)
          .addScaledVector(tmpA, bl * k)
          .addScaledVector(tmpU, (Math.random() * 2 - 1) * m.jitter * 0.6 * k)
          .addScaledVector(tmpV, (Math.random() * 2 - 1) * m.jitter * 0.6 * k);
        strand.fades[i] = 0.7 * (1 - k);
      }
    }
    return used;
  }

  protected onUpdate(t: number, _dt: number, camera: THREE.Camera): void {
    const m = this.module;
    const now = this.startedAt + t * this.life;
    if (now >= this.nextRoll) {
      this.roll();
      this.nextRoll = now + 1 / m.refreshHz;
    }
    const o = this.opacityAt(t, now) * this.flickerMul;
    const active = this.strands.filter((s) => s.points.length >= 2);
    this.glow.uOpacity.value = o * 0.45;
    this.core.uOpacity.value = o;
    this.glow.write(active, m.width * 0.5, camera);
    this.core.write(active, m.width * 0.5 * Math.max(0.05, m.core), camera);
    this.glow.mesh.visible = true;
    this.core.mesh.visible = m.core > 0;
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

export { Ribbon };
