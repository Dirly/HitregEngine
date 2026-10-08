import * as THREE from "three/webgpu";
import { attribute, float, floor, mix, positionWorld, pow, saturate, step } from "three/tsl";
import { hashCell, presentationOnly, unlitMaterial } from "../base.js";
import { posterize, type N } from "../shaders.js";

/** Vertices per blend mode; a trail that would overflow is cut short for that frame. */
const MAX_VERTS = 8192;

/**
 * Every trail in view, in ONE draw per blend mode.
 *
 * A trail is rebuilt from its history every frame anyway, so there is nothing
 * to gain from a mesh per trail and a draw per swing to lose: each live trail
 * appends its strip here between `begin` and `end` (VfxSystem.update brackets
 * the module step), and the batch uploads only the written range. Everything
 * that used to be a per-trail uniform is a vertex attribute instead — head and
 * tail colour, the fade, the PSX alpha steps and texel grid, the opacity — so
 * six fighters' sword trails and a volley's projectile tails share one program
 * and one draw.
 */
export class TrailBatch {
  private readonly layers: Record<"additive" | "normal", Layer>;

  constructor(root: THREE.Object3D) {
    this.layers = { additive: new Layer(root, true), normal: new Layer(root, false) };
  }

  /** Start a frame: forget last frame's strips. */
  begin(): void {
    this.layers.additive.reset();
    this.layers.normal.reset();
  }

  /** Upload what was written this frame and show only the layers that have anything. */
  end(): void {
    this.layers.additive.commit();
    this.layers.normal.commit();
  }

  /** Open a strip; `point` pairs then join into quads until the next `strip`. */
  strip(blend: "additive" | "normal"): TrailStrip {
    return this.layers[blend].open();
  }

  /** Draw stats for probes and tests: vertices written last frame per layer. */
  stats(): { additive: number; normal: number } {
    return { additive: this.layers.additive.lastVerts, normal: this.layers.normal.lastVerts };
  }

  dispose(): void {
    this.layers.additive.dispose();
    this.layers.normal.dispose();
  }
}

/** Writer for one strip: a pair of points per sample, newest or oldest first. */
export interface TrailStrip {
  /**
   * One sample: the two sides of the ribbon. `fade` is 1 at the head and 0 at
   * the end of the tail; `alphaA`/`alphaB` scale each side's opacity. Returns
   * false once the batch is full (the rest of this strip is dropped).
   */
  point(ax: number, ay: number, az: number, bx: number, by: number, bz: number, fade: number, alphaA: number, alphaB: number): boolean;
  /**
   * Head colour, tail colour, alpha steps (0 = smooth) and dither cells per
   * metre (0 = off) for the points that follow; optionally a HOT core colour
   * (a stepped three-colour ramp core -> head -> tail), the fade exponent
   * (`falloff`, brightness = fade^falloff) and whether the strip is a swept
   * EDGE (side A the inner point, side B the outer: the core leans to B).
   */
  style(head: THREE.Color, tail: THREE.Color, steps: number, cells: number, core?: THREE.Color | null, falloff?: number, edge?: boolean): void;
}

class Layer implements TrailStrip {
  private readonly mesh: THREE.Mesh;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly pos = new Float32Array(MAX_VERTS * 3);
  private readonly head = new Float32Array(MAX_VERTS * 3);
  private readonly tail = new Float32Array(MAX_VERTS * 3);
  /** fade, alpha, steps, cells */
  private readonly data = new Float32Array(MAX_VERTS * 4);
  /** hot core colour, and whether there is one (0/1) */
  private readonly core = new Float32Array(MAX_VERTS * 4);
  /** across the ribbon (0 inner .. 1 outer), falloff exponent */
  private readonly edge = new Float32Array(MAX_VERTS * 2);
  private readonly index = new Uint32Array(MAX_VERTS * 3);
  private readonly attrs: THREE.BufferAttribute[];
  private readonly indexAttr: THREE.BufferAttribute;
  private verts = 0;
  private indices = 0;
  /** Vertex index where the open strip began (-1 = none open). */
  private stripStart = -1;
  private hr = 1;
  private hg = 1;
  private hb = 1;
  private tr = 0;
  private tg = 0;
  private tb = 0;
  private steps = 0;
  private cells = 0;
  private cr = 1;
  private cg = 1;
  private cb = 1;
  private hasCore = 0;
  private falloff = 1;
  private isEdge = false;
  lastVerts = 0;

  constructor(root: THREE.Object3D, additive: boolean) {
    const stream = (array: Float32Array, size: number): THREE.BufferAttribute => new THREE.BufferAttribute(array, size).setUsage(THREE.StreamDrawUsage);
    const position = stream(this.pos, 3);
    const head = stream(this.head, 3);
    const tail = stream(this.tail, 3);
    const data = stream(this.data, 4);
    const core = stream(this.core, 4);
    const edge = stream(this.edge, 2);
    this.attrs = [position, head, tail, data, core, edge];
    this.geometry.setAttribute("position", position);
    this.geometry.setAttribute("aHead", head);
    this.geometry.setAttribute("aTail", tail);
    this.geometry.setAttribute("aTrail", data);
    this.geometry.setAttribute("aCore", core);
    this.geometry.setAttribute("aEdge", edge);
    this.indexAttr = new THREE.BufferAttribute(this.index, 1).setUsage(THREE.StreamDrawUsage);
    this.geometry.setIndex(this.indexAttr);
    this.geometry.setDrawRange(0, 0);
    this.material = unlitMaterial(additive);
    this.material.forceSinglePass = true;
    const d: N = attribute("aTrail", "vec4");
    const c: N = attribute("aCore", "vec4");
    const e: N = attribute("aEdge", "vec2");
    const has: N = c.w;
    // brightness behind the leading edge: fade^falloff (1 = the old linear sheet), and with a
    // core the outer side (the blade's edge near the tip) burns brighter than the inner
    const heat: N = pow(d.x.max(0), e.y.max(0.25)).mul(mix(float(1), mix(float(0.45), float(1), e.x), has));
    const banded: N = posterize(heat, d.z);
    const cells: N = d.w;
    const cell: N = floor((positionWorld as N).mul(cells.max(0.001)));
    // keep a cell while the hash under it is below the brightness: the tail thins
    // out pixel by pixel, the head stays solid
    const dither: N = mix(float(1), step(hashCell(cell), heat.mul(1.3)), saturate(cells));
    const headC: N = attribute("aHead", "vec3");
    const tailC: N = attribute("aTail", "vec3");
    // two colours: a smooth (or banded) fade; with a core, three HARD steps core -> head -> tail
    const ramp: N = mix(mix(tailC, headC, step(0.34, banded)), c.xyz, step(0.67, banded));
    this.material.colorNode = mix(mix(tailC, headC, banded), ramp, has);
    // with a core the core and middle bands are SOLID (a saturated crescent right behind the edge,
    // never a pale translucent sheet) and the tail band is half-strength, eaten by the dither
    const solid: N = mix(banded.mul(0.5), float(1), step(0.34, banded));
    this.material.opacityNode = mix(banded, solid, has).mul(dither).mul(d.y);
    this.material.needsUpdate = true;
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = additive ? "vfx-trails" : "vfx-trails-normal";
    presentationOnly(this.mesh);
    this.mesh.visible = false;
    root.add(this.mesh);
  }

  reset(): void {
    this.verts = 0;
    this.indices = 0;
    this.stripStart = -1;
  }

  open(): TrailStrip {
    this.stripStart = this.verts;
    return this;
  }

  style(head: THREE.Color, tail: THREE.Color, steps: number, cells: number, core: THREE.Color | null = null, falloff = 1, edge = false): void {
    this.hr = head.r;
    this.hg = head.g;
    this.hb = head.b;
    this.tr = tail.r;
    this.tg = tail.g;
    this.tb = tail.b;
    this.steps = steps;
    this.cells = cells;
    this.hasCore = core ? 1 : 0;
    if (core) {
      this.cr = core.r;
      this.cg = core.g;
      this.cb = core.b;
    }
    this.falloff = falloff;
    this.isEdge = edge;
  }

  point(ax: number, ay: number, az: number, bx: number, by: number, bz: number, fade: number, alphaA: number, alphaB: number): boolean {
    if (this.stripStart < 0 || this.verts + 2 > MAX_VERTS) return false;
    const v = this.verts;
    this.vertex(v, ax, ay, az, fade, alphaA, this.isEdge ? 0 : 1);
    this.vertex(v + 1, bx, by, bz, fade, alphaB, 1);
    if (v - this.stripStart >= 2) {
      const a = v - 2;
      const i = this.indices;
      this.index[i] = a;
      this.index[i + 1] = a + 1;
      this.index[i + 2] = v;
      this.index[i + 3] = a + 1;
      this.index[i + 4] = v + 1;
      this.index[i + 5] = v;
      this.indices += 6;
    }
    this.verts += 2;
    return true;
  }

  private vertex(v: number, x: number, y: number, z: number, fade: number, alpha: number, across: number): void {
    const o2 = v * 2;
    this.edge[o2] = across;
    this.edge[o2 + 1] = this.falloff;
    const c4 = v * 4;
    this.core[c4] = this.cr;
    this.core[c4 + 1] = this.cg;
    this.core[c4 + 2] = this.cb;
    this.core[c4 + 3] = this.hasCore;
    const o3 = v * 3;
    this.pos[o3] = x;
    this.pos[o3 + 1] = y;
    this.pos[o3 + 2] = z;
    this.head[o3] = this.hr;
    this.head[o3 + 1] = this.hg;
    this.head[o3 + 2] = this.hb;
    this.tail[o3] = this.tr;
    this.tail[o3 + 1] = this.tg;
    this.tail[o3 + 2] = this.tb;
    const o4 = v * 4;
    this.data[o4] = fade;
    this.data[o4 + 1] = alpha;
    this.data[o4 + 2] = this.steps;
    this.data[o4 + 3] = this.cells;
  }

  commit(): void {
    this.lastVerts = this.verts;
    this.stripStart = -1;
    if (this.indices === 0) {
      this.mesh.visible = false;
      this.geometry.setDrawRange(0, 0);
      return;
    }
    const sizes = [3, 3, 3, 4, 4, 2];
    this.attrs.forEach((attr, k) => {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, this.verts * sizes[k]!);
      attr.needsUpdate = true;
    });
    this.indexAttr.clearUpdateRanges();
    this.indexAttr.addUpdateRange(0, this.indices);
    this.indexAttr.needsUpdate = true;
    this.geometry.setDrawRange(0, this.indices);
    this.mesh.visible = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
