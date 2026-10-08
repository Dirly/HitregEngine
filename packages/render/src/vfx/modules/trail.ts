import * as THREE from "three/webgpu";
import type { VfxModuleOf } from "@hitreg/core";
import { LiveModule, moduleColor, type LiveModuleHost } from "../base.js";

type TrailModule = VfxModuleOf<"trail">;

const MAX = 96;
const camPos = new THREE.Vector3();
const tmpDir = new THREE.Vector3();
const tmpToCam = new THREE.Vector3();
const tmpSide = new THREE.Vector3();
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();

/** Catmull-Rom through p1..p2 at s (p0, p3 the neighbours). */
function cr(p0: number, p1: number, p2: number, p3: number, s: number): number {
  const s2 = s * s;
  const s3 = s2 * s;
  return 0.5 * (2 * p1 + (p2 - p0) * s + (2 * p0 - 5 * p1 + 4 * p2 - p3) * s2 + (3 * p1 - p0 - 3 * p2 + p3) * s3);
}

/**
 * A ribbon of recent history, in two forms:
 *
 * - **behind a point** (the projectile's tail): the anchor's recent
 *   positions, rebuilt each frame facing the camera, tapered toward the tail;
 * - **swept by an edge** (`edge`, a weapon trail): two points on the anchor
 *   object — a blade's base and tip — sampled every frame, and the ribbon is
 *   the surface between them, smoothed along a curve through the samples so
 *   a fast swing draws an arc. The tip side stays bright, the hilt side
 *   see-through, and with `taper` the inner side slides out to the tip as it
 *   ages, so the smear thins to the line the edge cut.
 *
 * Nothing here owns a mesh: every live trail writes its strip into the
 * system's TrailBatch, one draw per blend mode for all of them.
 *
 * With `pixel`/`texel` the ribbon goes PSX: the fade is banded into
 * `posterize` steps, the width steps with it, and a world-grid dither eats the
 * tail away in hard cells instead of a smooth gradient.
 */
export class TrailLive extends LiveModule<TrailModule> {
  readonly kind = "trail" as const;
  private readonly hx = new Float32Array(MAX);
  private readonly hy = new Float32Array(MAX);
  private readonly hz = new Float32Array(MAX);
  /** the edge's outer point (edge trails only) */
  private readonly ex = new Float32Array(MAX);
  private readonly ey = new Float32Array(MAX);
  private readonly ez = new Float32Array(MAX);
  private readonly ht = new Float32Array(MAX);
  /** per sample: 0..1 opacity from the outer point's speed (edge.minSpeed) */
  private readonly hw = new Float32Array(MAX);
  private head = 0;
  private count = 0;
  private cells = 0;
  /** `coreColor`, resolved against the play's palette. */
  private readonly core = new THREE.Color();
  /** What the edge's points are measured on (the weapon entity, or a bone under the body). */
  private edgeObject: THREE.Object3D | null = null;

  constructor(host: LiveModuleHost) {
    super(host);
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
    // cells per metre: the spell texel, else `pixel` cells across the trail width
    const texel = this.texelSize();
    this.cells = texel > 0 ? 1 / texel : m.pixel > 0 ? Math.max(2, m.pixel / Math.max(0.1, m.width)) : 0;
    this.edgeObject = m.edge ? this.findEdgeObject(m.edge.bone) : null;
    if (m.coreColor) moduleColor(m.coreColor, this.ctx.frame.palette, this.core);
  }

  private findEdgeObject(bone: string | undefined): THREE.Object3D | null {
    const f = this.ctx.frame;
    const a = this.module.anchor;
    const base = a.socket && (a.at === "caster" || a.at === "target") ? f.socket?.(a.at, a.socket) : a.at === "caster" ? f.caster : a.at === "target" ? f.targetObject : null;
    if (!base || !bone) return base ?? null;
    const exact = base.getObjectByName(bone);
    if (exact) return exact;
    const want = bone.toLowerCase();
    let found: THREE.Object3D | null = null;
    base.traverse((o) => {
      if (!found && o.name.toLowerCase().includes(want)) found = o;
    });
    return found;
  }

  private push(now: number): void {
    const i = this.head;
    const edge = this.module.edge;
    if (edge && this.edgeObject) {
      this.edgeObject.updateWorldMatrix(true, false);
      this.edgeObject.matrixWorld.decompose(tmpPos, tmpQuat, tmpScale);
      tmpA.set(edge.from[0], edge.from[1], edge.from[2]).applyQuaternion(tmpQuat).add(tmpPos);
      tmpB.set(edge.to[0], edge.to[1], edge.to[2]).applyQuaternion(tmpQuat).add(tmpPos);
    } else {
      tmpA.copy(this.pose.position);
      tmpB.copy(this.pose.position);
    }
    if (this.count > 0) {
      const last = (i - 1 + MAX) % MAX;
      const moved = Math.abs(this.ex[last]! - tmpB.x) + Math.abs(this.ey[last]! - tmpB.y) + Math.abs(this.ez[last]! - tmpB.z) + Math.abs(this.hx[last]! - tmpA.x) + Math.abs(this.hy[last]! - tmpA.y) + Math.abs(this.hz[last]! - tmpA.z);
      if (moved < 0.02) return;
    }
    this.hx[i] = tmpA.x;
    this.hy[i] = tmpA.y;
    this.hz[i] = tmpA.z;
    this.ex[i] = tmpB.x;
    this.ey[i] = tmpB.y;
    let w = 1;
    const minSpeed = edge?.minSpeed ?? 0;
    if (minSpeed > 0) {
      if (this.count === 0) w = 0;
      else {
        const last = (i - 1 + MAX) % MAX;
        const dt = Math.max(1e-3, now - this.ht[last]!);
        const speed = Math.hypot(tmpB.x - this.ex[last]!, tmpB.y - this.ey[last]!, tmpB.z - this.ez[last]!) / dt;
        w = Math.min(1, speed / minSpeed);
      }
    }
    this.ez[i] = tmpB.z;
    this.ht[i] = now;
    this.hw[i] = w;
    this.head = (i + 1) % MAX;
    this.count = Math.min(MAX, this.count + 1);
  }

  protected onUpdate(t: number, _dt: number, camera: THREE.Camera): void {
    const m = this.module;
    const now = this.now;
    // keep sampling while alive; during the tail the ribbon just drains
    if (t < 1 && (!m.edge || this.edgeObject)) this.push(now);
    const batch = this.host.trails;
    if (!batch || this.count < 2) return;
    const o = this.opacityAt(Math.min(1, t), now);
    if (o <= 0) return;
    const strip = batch.strip(m.blend === "additive" ? "additive" : "normal");
    strip.style(this.color, this.colorEnd, m.posterize, this.cells, m.coreColor ? this.core : null, m.falloff ?? 1, !!m.edge);
    if (m.edge) this.drawEdge(strip, o, now);
    else this.drawRibbon(strip, o, now, camera);
  }

  /** Ring index of the k-th newest sample. */
  private at(k: number): number {
    return (this.head - 1 - k + 2 * MAX) % MAX;
  }

  private drawEdge(strip: import("./trail-batch.js").TrailStrip, o: number, now: number): void {
    const m = this.module;
    const edge = m.edge!;
    const steps = m.posterize > 0 ? m.posterize : 0;
    // samples still inside the tail, newest first
    let n = 0;
    while (n < this.count && now - this.ht[this.at(n)]! <= m.length) n++;
    if (n < 2) return;
    const sub = edge.subdivide + 1;
    const root = edge.rootOpacity;
    // a fast falloff tapers the wake all the way to the tip's line (nothing at the tail)
    const reachTip = (m.falloff ?? 1) > 1 ? 0.96 : 0.75;
    const emit = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, age: number, w: number): boolean => {
      const f = Math.max(0, 1 - age / m.length);
      if (m.taper) {
        // the inner side slides out to the outer one as the sample ages, in the alpha's steps
        const k = (1 - (steps > 0 ? Math.ceil(f * steps) / steps : f)) * reachTip;
        ax += (bx - ax) * k;
        ay += (by - ay) * k;
        az += (bz - az) * k;
      }
      return strip.point(ax, ay, az, bx, by, bz, f, o * root * w, o * w);
    };
    for (let k = 0; k < n - 1; k++) {
      const i0 = this.at(Math.max(0, k - 1));
      const i1 = this.at(k);
      const i2 = this.at(k + 1);
      const i3 = this.at(Math.min(n - 1, k + 2));
      for (let s = 0; s < sub; s++) {
        const u = s / sub;
        const age = now - (this.ht[i1]! + (this.ht[i2]! - this.ht[i1]!) * u);
        const ok =
          u === 0
            ? emit(this.hx[i1]!, this.hy[i1]!, this.hz[i1]!, this.ex[i1]!, this.ey[i1]!, this.ez[i1]!, age, this.hw[i1]!)
            : emit(
                cr(this.hx[i0]!, this.hx[i1]!, this.hx[i2]!, this.hx[i3]!, u),
                cr(this.hy[i0]!, this.hy[i1]!, this.hy[i2]!, this.hy[i3]!, u),
                cr(this.hz[i0]!, this.hz[i1]!, this.hz[i2]!, this.hz[i3]!, u),
                cr(this.ex[i0]!, this.ex[i1]!, this.ex[i2]!, this.ex[i3]!, u),
                cr(this.ey[i0]!, this.ey[i1]!, this.ey[i2]!, this.ey[i3]!, u),
                cr(this.ez[i0]!, this.ez[i1]!, this.ez[i2]!, this.ez[i3]!, u),
                age,
                this.hw[i1]! + (this.hw[i2]! - this.hw[i1]!) * u,
              );
        if (!ok) return;
      }
    }
    const last = this.at(n - 1);
    emit(this.hx[last]!, this.hy[last]!, this.hz[last]!, this.ex[last]!, this.ey[last]!, this.ez[last]!, now - this.ht[last]!, this.hw[last]!);
  }

  private drawRibbon(strip: import("./trail-batch.js").TrailStrip, o: number, now: number, camera: THREE.Camera): void {
    const m = this.module;
    camera.getWorldPosition(camPos);
    const half = m.width * 0.5 * this.sizeAt(Math.min(1, (now - this.startedAt) / Math.max(1e-3, this.life)));
    const steps = m.posterize > 0 ? m.posterize : 0;
    // newest first: index 0 is the head
    for (let k = 0; k < this.count; k++) {
      const i = this.at(k);
      const age = now - this.ht[i]!;
      if (age > m.length) break;
      const f = 1 - age / m.length;
      // the width steps down with the alpha bands, so the ribbon narrows in jumps
      const wf = m.taper ? (steps > 0 ? Math.ceil(f * steps) / steps : f) : 1;
      const hasPrev = k + 1 < this.count;
      const j = this.at(k + 1);
      tmpDir.set(this.hx[i]! - (hasPrev ? this.hx[j]! : this.hx[i]!), this.hy[i]! - (hasPrev ? this.hy[j]! : this.hy[i]!), this.hz[i]! - (hasPrev ? this.hz[j]! : this.hz[i]!));
      if (tmpDir.lengthSq() < 1e-8) tmpDir.copy(this.pose.velocity);
      if (tmpDir.lengthSq() < 1e-8) tmpDir.set(0, 1, 0);
      tmpToCam.set(camPos.x - this.hx[i]!, camPos.y - this.hy[i]!, camPos.z - this.hz[i]!);
      tmpSide.crossVectors(tmpDir, tmpToCam);
      if (tmpSide.lengthSq() < 1e-8) tmpSide.set(1, 0, 0);
      tmpSide.normalize().multiplyScalar(half * wf);
      const ok = strip.point(
        this.hx[i]! + tmpSide.x,
        this.hy[i]! + tmpSide.y,
        this.hz[i]! + tmpSide.z,
        this.hx[i]! - tmpSide.x,
        this.hy[i]! - tmpSide.y,
        this.hz[i]! - tmpSide.z,
        f,
        o,
        o,
      );
      if (!ok) return;
    }
  }

  protected onEnd(): void {
    this.count = 0;
    this.edgeObject = null;
  }

  dispose(): void {}
}
