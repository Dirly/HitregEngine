import * as THREE from "three/webgpu";
import { attribute, float, floor, fract, mix, positionWorld, saturate, step, uniform } from "three/tsl";
import type { VfxModuleOf } from "@hitreg/core";
import { LiveModule, hashCell, presentationOnly, unlitMaterial, type LiveModuleHost } from "../base.js";
import { posterize, type N } from "../shaders.js";

type TelegraphModule = VfxModuleOf<"telegraph">;

const ARC_SEGMENTS = 40;
const WALL_RATIO = 0.42;
const WALL_MIN = 0.7;
const WALL_MAX = 2.2;

interface Outline {
  loop: Array<[number, number]>;
  centre: [number, number];
  key: string;
}

/** One telegraph surface: a node material with the knobs the draw turns. */
interface Surface {
  material: THREE.MeshBasicNodeMaterial;
  color: THREE.UniformNode<"color", THREE.Color>;
  opacity: THREE.UniformNode<"float", number>;
  /** cells per metre of the pixel grid (0 = smooth) */
  cells: THREE.UniformNode<"float", number>;
  steps: THREE.UniformNode<"float", number>;
  dash: THREE.UniformNode<"float", number>;
}

/**
 * The declared volume, drawn from data: a dim interior wash that grows to
 * meet a bright rim over the windup (that growth IS the clock), and a
 * vertical curtain rising from the boundary so the warning survives a
 * shallow camera, grass and a body in the way.
 *
 * Ported into the engine from combat-demo's telegraph-pool so a generated
 * spell carries its own warning: every vertex is draped against the host's
 * ground probe and clamped to the volume's own `height`, so what is drawn
 * and what hits are one shape.
 *
 * The PSX look (`pixel`): the fill is a world-grid checker so it reads as a
 * painted marker instead of a flat wash, the rim is dashed, and the curtain
 * fades upward in hard bands that dissolve cell by cell. All of it is a
 * uniform on the same three surfaces — a smooth telegraph is `pixel: 0`.
 */
export class TelegraphLive extends LiveModule<TelegraphModule> {
  readonly kind = "telegraph" as const;
  private readonly group = new THREE.Group();
  private readonly fillS: Surface;
  private readonly rimS: Surface;
  private readonly wallS: Surface;
  private fill!: THREE.Mesh;
  private rim!: THREE.Mesh;
  private wall!: THREE.Mesh;
  private outline: Outline | null = null;
  private wallBase: Float32Array | null = null;
  private startScale = 1;
  private centreY = 0;

  constructor(host: LiveModuleHost) {
    super(host);
    this.group.visible = false;
    host.root.add(this.group);
    this.fillS = this.surface("fill");
    this.rimS = this.surface("rim");
    this.wallS = this.surface("wall");
  }

  private surface(kind: "fill" | "rim" | "wall"): Surface {
    const material = unlitMaterial(true);
    const s: Surface = {
      material,
      color: uniform(new THREE.Color(1, 1, 1)),
      opacity: uniform(0, "float"),
      cells: uniform(0, "float"),
      steps: uniform(0, "float"),
      dash: uniform(0, "float"),
    };
    const pixelOn: N = saturate(s.cells);
    const cell: N = floor((positionWorld as N).mul(s.cells));
    let alpha: N;
    if (kind === "fill") {
      // a world-grid checker: half the cells dim, so the wash reads as a
      // painted marker on the ground rather than a tinted plane
      const checker: N = fract(cell.x.add(cell.z).mul(0.5)).mul(2);
      alpha = mix(float(1), mix(float(0.35), float(1), checker), pixelOn);
    } else if (kind === "rim") {
      // dashes along the boundary: `aAlong` counts boundary segments
      const along: N = attribute("aAlong", "float");
      const dashed: N = step(fract(along.mul(0.5)), float(1).sub(s.dash));
      alpha = mix(float(1), dashed, saturate(s.dash.mul(1000)));
    } else {
      // curtain: the vertex fade (1 at the ground, 0 at the top) banded, and
      // dissolving upward cell by cell
      const fade: N = (attribute("color", "vec4") as N).w;
      const banded: N = posterize(fade, s.steps);
      const dither: N = mix(float(1), step(hashCell(cell), fade.add(0.1)), pixelOn);
      alpha = banded.mul(dither);
    }
    material.colorNode = s.color;
    material.opacityNode = alpha.mul(s.opacity);
    material.needsUpdate = true;
    return s;
  }

  private outlineFor(m: TelegraphModule): Outline {
    const max = m.radius;
    const key = `${m.shape}:${max}:${m.angle}:${m.width}`;
    if (this.outline?.key === key) return this.outline;
    const loop: Array<[number, number]> = [];
    let centre: [number, number] = [0, 0];
    if (m.shape === "circle") {
      for (let i = 0; i < ARC_SEGMENTS; i++) {
        const t = (i / ARC_SEGMENTS) * Math.PI * 2;
        loop.push([Math.sin(t) * max, -Math.cos(t) * max]);
      }
    } else if (m.shape === "cone") {
      const half = (m.angle * Math.PI) / 180;
      const steps = Math.max(8, Math.round((ARC_SEGMENTS * half) / Math.PI));
      loop.push([0, 0]);
      for (let i = 0; i <= steps; i++) {
        const t = -half + (i / steps) * half * 2;
        loop.push([Math.sin(t) * max, -Math.cos(t) * max]);
      }
    } else {
      const w = m.width;
      loop.push([-w, 0], [w, 0], [w, -max], [-w, -max]);
      centre = [0, -max / 2];
    }
    return { loop, centre, key };
  }

  private buildFill(o: Outline): THREE.BufferGeometry {
    const n = o.loop.length;
    const pos = new Float32Array(n * 9);
    let k = 0;
    for (let i = 0; i < n; i++) {
      const a = o.loop[i]!;
      const b = o.loop[(i + 1) % n]!;
      pos[k++] = o.centre[0]; pos[k++] = 0; pos[k++] = o.centre[1];
      pos[k++] = a[0]; pos[k++] = 0; pos[k++] = a[1];
      pos[k++] = b[0]; pos[k++] = 0; pos[k++] = b[1];
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return geo;
  }

  private buildRim(o: Outline, rimWidth: number): THREE.BufferGeometry {
    const n = o.loop.length;
    const pos = new Float32Array(n * 18);
    const along = new Float32Array(n * 6);
    const inset = (p: [number, number]): [number, number] => {
      const dx = o.centre[0] - p[0];
      const dz = o.centre[1] - p[1];
      const len = Math.hypot(dx, dz) || 1;
      const t = Math.min(rimWidth, len * 0.9);
      return [p[0] + (dx / len) * t, p[1] + (dz / len) * t];
    };
    let k = 0;
    let q = 0;
    for (let i = 0; i < n; i++) {
      const a = o.loop[i]!;
      const b = o.loop[(i + 1) % n]!;
      const ai = inset(a);
      const bi = inset(b);
      // dashes: the segment index runs along the boundary; both ends of a
      // segment share it so each segment is wholly on or off
      pos[k++] = a[0]; pos[k++] = 0; pos[k++] = a[1]; along[q++] = i;
      pos[k++] = b[0]; pos[k++] = 0; pos[k++] = b[1]; along[q++] = i;
      pos[k++] = ai[0]; pos[k++] = 0; pos[k++] = ai[1]; along[q++] = i;
      pos[k++] = b[0]; pos[k++] = 0; pos[k++] = b[1]; along[q++] = i;
      pos[k++] = bi[0]; pos[k++] = 0; pos[k++] = bi[1]; along[q++] = i;
      pos[k++] = ai[0]; pos[k++] = 0; pos[k++] = ai[1]; along[q++] = i;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aAlong", new THREE.BufferAttribute(along, 1));
    return geo;
  }

  private buildWall(o: Outline, height: number): THREE.BufferGeometry {
    const n = o.loop.length;
    const pos = new Float32Array(n * 18);
    const col = new Float32Array(n * 24);
    let k = 0;
    let c = 0;
    const put = (x: number, y: number, z: number, a: number): void => {
      pos[k++] = x; pos[k++] = y; pos[k++] = z;
      col[c++] = 1; col[c++] = 1; col[c++] = 1; col[c++] = a;
    };
    for (let i = 0; i < n; i++) {
      const a = o.loop[i]!;
      const b = o.loop[(i + 1) % n]!;
      put(a[0], 0, a[1], 1);
      put(b[0], 0, b[1], 1);
      put(a[0], height, a[1], 0);
      put(b[0], 0, b[1], 1);
      put(b[0], height, b[1], 0);
      put(a[0], height, a[1], 0);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 4));
    return geo;
  }

  private rebuild(m: TelegraphModule): void {
    const o = this.outlineFor(m);
    if (this.outline?.key === o.key && this.fill) return;
    this.outline = o;
    for (const mesh of [this.fill, this.rim, this.wall]) {
      if (mesh) {
        mesh.geometry.dispose();
        mesh.removeFromParent();
      }
    }
    const wallHeight = m.curtain > 0 ? m.curtain : Math.min(WALL_MAX, Math.max(WALL_MIN, m.radius * WALL_RATIO));
    const make = (geo: THREE.BufferGeometry, s: Surface): THREE.Mesh => {
      const mesh = new THREE.Mesh(geo, s.material);
      presentationOnly(mesh);
      this.group.add(mesh);
      return mesh;
    };
    this.fill = make(this.buildFill(o), this.fillS);
    this.rim = make(this.buildRim(o, m.rim), this.rimS);
    this.wall = make(this.buildWall(o, wallHeight), this.wallS);
    this.wallBase = null;
  }

  protected naturalLife(): number {
    const m = this.module;
    return m.windup + m.hold + 0.14;
  }

  protected onBegin(): void {
    const m = this.module;
    this.rebuild(m);
    // `pixel` is cells across the shape; the grid is in world metres
    const cells = m.pixel > 0 ? Math.max(1.5, m.pixel / Math.max(0.5, m.radius * 2)) : 0;
    for (const s of [this.fillS, this.rimS, this.wallS]) {
      s.color.value.copy(this.color);
      s.cells.value = cells;
      s.steps.value = m.posterize;
      s.dash.value = m.pixel > 0 ? m.dash : 0;
      s.opacity.value = 0;
    }
    const p = this.pose.position;
    const yaw = Math.atan2(-this.pose.forward.x, -this.pose.forward.z);
    const ground = this.ctx.frame.ground;
    this.centreY = ground?.(p.x, p.z, p.y + 1) ?? p.y;
    this.drape(p, yaw, this.centreY, m.height, ground);
    this.group.position.set(p.x, this.centreY + 0.12, p.z);
    this.group.rotation.set(0, yaw, 0);
    this.rim.position.y = 0.02;
    this.startScale = m.growFrom;
    this.rim.scale.setScalar(this.startScale);
    this.wall.scale.setScalar(this.startScale);
    this.fill.scale.setScalar(0.001);
    this.group.visible = true;
  }

  private drape(p: THREE.Vector3, yaw: number, centre: number, clamp: number, ground: ((x: number, z: number, near: number) => number | null) | undefined): void {
    const o = this.outline!;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const loop = o.loop;
    const n = loop.length;
    const raw = new Float32Array(n);
    if (ground) {
      for (let i = 0; i < n; i++) {
        const [lx, lz] = loop[i]!;
        const wx = p.x + lx * cos + lz * sin;
        const wz = p.z - lx * sin + lz * cos;
        const gy = ground(wx, wz, centre + 1);
        const dy = gy === null ? 0 : gy - centre;
        raw[i] = Math.max(-clamp, Math.min(clamp, dy));
      }
    }
    // Smooth along the boundary: one outlier probe otherwise turns a curtain
    // panel into a slanted sheet that reads as a rendering bug.
    const height = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      height[i] = (raw[(i - 1 + n) % n] ?? 0) * 0.25 + (raw[i] ?? 0) * 0.5 + (raw[(i + 1) % n] ?? 0) * 0.25;
    }
    const at = (lx: number, lz: number): number => {
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < n; i++) {
        const [px, pz] = loop[i]!;
        const d = (px - lx) ** 2 + (pz - lz) ** 2;
        if (d < bestD) {
          bestD = d;
          best = height[i] ?? 0;
        }
      }
      if (bestD > 0.01) {
        let sum = 0;
        for (let i = 0; i < n; i++) sum += height[i] ?? 0;
        return (best + sum / n) / 2;
      }
      return best;
    };
    for (const mesh of [this.fill, this.rim]) {
      const pos = mesh.geometry.attributes["position"] as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) pos.setY(i, at(pos.getX(i), pos.getZ(i)));
      pos.needsUpdate = true;
      mesh.geometry.computeBoundingSphere();
    }
    const wpos = this.wall.geometry.attributes["position"] as THREE.BufferAttribute;
    if (!this.wallBase) {
      this.wallBase = new Float32Array(wpos.count);
      for (let i = 0; i < wpos.count; i++) this.wallBase[i] = wpos.getY(i);
    }
    for (let i = 0; i < wpos.count; i++) wpos.setY(i, (this.wallBase[i] ?? 0) + at(wpos.getX(i), wpos.getZ(i)));
    wpos.needsUpdate = true;
    this.wall.geometry.computeBoundingSphere();
  }

  protected onUpdate(t: number): void {
    const m = this.module;
    const now = this.startedAt + t * this.life;
    const age = now - this.startedAt;
    const o = this.opacityAt(t, now);
    if (age < m.windup) {
      const k = age / Math.max(0.01, m.windup);
      this.fill.scale.setScalar(Math.max(0.001, k * this.startScale));
      this.fillS.opacity.value = m.fillOpacity * o;
      this.rimS.opacity.value = m.rimOpacity * o;
      this.wallS.opacity.value = m.curtainOpacity * o;
    } else {
      const held = m.hold > 0 ? Math.min(1, (age - m.windup) / m.hold) : 1;
      const scale = this.startScale + (1 - this.startScale) * held;
      this.fill.scale.setScalar(scale);
      this.rim.scale.setScalar(scale);
      this.wall.scale.setScalar(scale);
      if (m.hold > 0) {
        // Breathe while live, thin out over the last second so "nearly safe"
        // is readable a beat before it is true.
        const fade = Math.min(1, (m.windup + m.hold - age) / 1);
        this.fillS.opacity.value = (m.fillOpacity + 0.12 * Math.sin(age * 7)) * fade * o;
        this.rimS.opacity.value = m.rimOpacity * fade * o;
        this.wallS.opacity.value = m.curtainOpacity * fade * o;
      } else {
        this.fillS.opacity.value = Math.min(0.75, m.fillOpacity * 2.5) * o; // the flash at the moment of truth
      }
    }
  }

  protected onEnd(): void {
    this.group.visible = false;
  }

  dispose(): void {
    for (const mesh of [this.fill, this.rim, this.wall]) {
      if (!mesh) continue;
      mesh.geometry.dispose();
    }
    for (const s of [this.fillS, this.rimS, this.wallS]) s.material.dispose();
    this.group.removeFromParent();
  }
}
