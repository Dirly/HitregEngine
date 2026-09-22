import * as THREE from "three/webgpu";
import {
  attribute,
  float,
  length as tslLength,
  positionGeometry,
  texture as tslTexture,
  uniform,
  uv,
  vec2,
  vec4,
} from "three/tsl";

/**
 * TSL node graphs are built by chaining and the published types lose the
 * component type along the way (post.ts keeps the same alias for the same
 * reason). The graph is checked where it matters — by the shader compiler.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tsl = any;

/**
 * A wake is the water MOVING, not a white streak drawn on it.
 *
 * Three versions of this were thrown away before that sentence became the
 * whole design. A sheet of particles read as a puff of cloud; a trail ribbon
 * read as a trail ribbon; painting foam into a world-space mask read as a
 * too-thick trail ribbon — because whatever shape a mask has, adding a bright
 * colour where it is bright is still a decal. It has no relief, so the eye
 * files it as a sticker on the surface however the edges are shaped.
 *
 * So this mask holds a HEIGHT FIELD instead of ink, and it is not painted, it
 * is simulated. Every texel runs the 2D wave equation against its neighbours,
 *
 *     h' = (2h - h_prev + c^2 * laplacian(h)) * damping
 *
 * which is the whole of it: a depression pushed into the surface springs back,
 * overshoots and radiates outward as rings. A body moving through pushes a new
 * depression every frame, so what it leaves behind is the classic V — not
 * because anything draws a V, but because that is the interference pattern a
 * moving source makes. The water material then DISPLACES its vertices by that
 * height and bends its shading normal along the field's slope, so the wake
 * catches the sky, shadows its own troughs and distorts what shows through the
 * surface, exactly as the material's own waves do. Nothing about it is a
 * colour laid on top.
 *
 * The patch is one square of world that follows the camera, snapped to whole
 * texels so its contents shift by exact texel counts and resample 1:1 — a
 * fractional shift filters the field a little every frame, which blurs the
 * rings away and (found the hard way) smears a second ghost trail out of every
 * wake. Energy is damped to nothing near the border so nothing reflects off
 * the edge of the patch.
 *
 * The same mask takes rain rings, a boat, a thrown rock, an impact: anything
 * that can name a position, a radius and a push.
 */

/** 1×1 flat water: what every water material samples until a mask exists. */
const BLANK = (() => {
  const texture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  texture.needsUpdate = true;
  return texture;
})();

/**
 * Bound into every water material when it is built, and driven by the host.
 * `strength` stays 0 until a mask exists, so a scene without one samples flat
 * and moves nothing — no second material variant, and no rebuild when a mask
 * appears part-way through a session.
 */
export const waterWakeUniforms = {
  /** R = surface height (normalised, about -1..1), G = the previous step's. */
  map: tslTexture(BLANK),
  /** World XZ at the centre of the patch. */
  center: uniform(new THREE.Vector2(0, 0)),
  /** Metres across the whole patch. */
  size: uniform(1),
  /** One texel as a fraction of the patch — the material's gradient step. */
  texel: uniform(1 / 512),
  /** 0 = this scene has no wake mask. */
  strength: uniform(0),
};

export interface WaterWakeOptions {
  /** Texels across. 512 over 64 m is 12.5 cm per texel — and the texel size
   * is the finest ripple the field can hold, so it sets how TIGHT a wake
   * looks more than any other number here. */
  resolution?: number;
  /** Metres across the patch. */
  size?: number;
  /** 0..1 energy kept per step: the length of the trail. */
  damping?: number;
}

interface Stamp {
  x: number;
  z: number;
  radius: number;
  strength: number;
  /** Travel direction, which elongates the push — a line of round dents is not a wake. */
  dirX: number;
  dirZ: number;
}

/** Seconds per simulation step. Fixed, so ripples travel at one speed on any machine. */
const STEP = 1 / 60;

export class WaterWake {
  readonly size: number;
  private readonly resolution: number;
  private readonly targets: [THREE.RenderTarget, THREE.RenderTarget];
  private front = 0;
  private readonly source: ReturnType<typeof tslTexture>;
  private readonly shift: ReturnType<typeof uniform>;
  private readonly keep: ReturnType<typeof uniform>;
  private readonly stepScene: THREE.Scene;
  private readonly camera: THREE.OrthographicCamera;
  private readonly stampScene: THREE.Scene;
  private readonly stampGeometry: THREE.InstancedBufferGeometry;
  /** Per stamp: centre xy + half-extents zw, all in the patch's clip space. */
  private readonly rect: THREE.InstancedBufferAttribute;
  /** Per stamp: how hard it pushes, in z (the rest is headroom for other kinds). */
  private readonly push: THREE.InstancedBufferAttribute;
  private readonly capacity = 256;
  private readonly pending: Stamp[] = [];
  private centerX = 0;
  private centerZ = 0;
  /** Where the camera is, as opposed to where the patch sits. */
  private wantX = 0;
  private wantZ = 0;
  private placed = false;
  private accum = 0;

  constructor(options: WaterWakeOptions = {}) {
    const resolution = options.resolution ?? 512;
    this.resolution = resolution;
    this.size = options.size ?? 64;
    const damping = Math.min(1, Math.max(0.9, options.damping ?? 0.977));
    const opts: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
    };
    this.targets = [
      new THREE.RenderTarget(resolution, resolution, opts),
      new THREE.RenderTarget(resolution, resolution, opts),
    ];
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // -- the step: propagate, damp, re-centre ---------------------------------
    // Explicit wave equation. c^2 must stay under 0.5 for this scheme to hold
    // together (a field that goes unstable here does not wobble — it saturates,
    // and the lake turns into a sheet), but the value is not chosen for margin:
    // it sets the WAVE SPEED, and the wave speed is what shapes a wake.
    //
    // sqrt(c^2) texels per step = sqrt(0.06) * (64/512) * 60 = about 1.8 m/s,
    // well under swimming pace ON PURPOSE. Waves faster than the body outrun
    // it and the wake spreads away as wide concentric rings — which is exactly
    // what "the wake is too large" looks like. Waves slower than the body get
    // left behind and stay near the path: the crests then trace the V everyone
    // recognises, and it hugs the swimmer. Nothing draws the V — it is the
    // interference pattern of a source moving faster than its own waves.
    this.source = tslTexture(this.targets[1]!.texture);
    this.shift = uniform(new THREE.Vector2(0, 0));
    this.keep = uniform(damping);
    const step = new THREE.MeshBasicNodeMaterial({ depthWrite: false, depthTest: false, toneMapped: false, fog: false });
    const t = 1 / resolution;
    const base: Tsl = (uv() as Tsl).add(this.shift);
    const at = (dx: number, dy: number): Tsl =>
      (this.source as Tsl).sample(base.add(vec2(float(dx), float(dy))));
    const here: Tsl = at(0, 0);
    const h: Tsl = here.r;
    const before: Tsl = here.g;
    const laplacian: Tsl = at(t, 0).r
      .add(at(-t, 0).r)
      .add(at(0, t).r)
      .add(at(0, -t).r)
      .sub(h.mul(4));
    // Nothing propagates in from outside the patch, and nothing bounces back
    // off its border: energy fades out over the outermost ~2% of the field.
    const insideX: Tsl = float(0.5).sub(base.x.sub(0.5).abs()).mul(24).clamp(0, 1);
    const insideY: Tsl = float(0.5).sub(base.y.sub(0.5).abs()).mul(24).clamp(0, 1);
    const edge: Tsl = insideX.mul(insideY);
    const next: Tsl = h
      .mul(2)
      .sub(before)
      .add(laplacian.mul(0.06))
      .mul(this.keep)
      .mul(edge)
      .clamp(-2, 2);
    // fragmentNode, NOT colorNode. A material's colour output is clamped to
    // zero (NodeMaterial: `vec4( outgoingLight, alpha ).max( 0 )`), which for a
    // PICTURE is right and for a field holding a surface that goes below its
    // resting line silently deletes half of every wave. `fragmentNode` is the
    // raw output the clamp is not applied to. Nothing here is a colour.
    step.fragmentNode = vec4(next, h.mul(edge), float(0), float(1));
    this.stepScene = new THREE.Scene();
    this.stepScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), step));

    // -- stamps ---------------------------------------------------------------
    // One instanced quad per disturbance, pushing the surface DOWN (negative
    // height) with a soft radial falloff. Summed with plain one:one blending —
    // not three's AdditiveBlending, whose source factor is SrcAlpha and which
    // therefore cannot carry a negative push. Instanced because a busy surface
    // (rain on a lake) is hundreds of stamps a frame and not one of them may be
    // its own draw call.
    const quad = new THREE.PlaneGeometry(1, 1);
    this.stampGeometry = new THREE.InstancedBufferGeometry();
    this.stampGeometry.index = quad.index;
    this.stampGeometry.setAttribute("position", quad.attributes["position"]!);
    this.rect = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
    this.push = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
    this.rect.setUsage(THREE.DynamicDrawUsage);
    this.push.setUsage(THREE.DynamicDrawUsage);
    this.stampGeometry.setAttribute("stampRect", this.rect);
    this.stampGeometry.setAttribute("stampPush", this.push);
    this.stampGeometry.instanceCount = 0;
    const stampMaterial = new THREE.MeshBasicNodeMaterial({
      depthWrite: false,
      depthTest: false,
      transparent: true,
      // This is DATA, not a picture: a tone curve on the way out would crush
      // the small values, and fog would tint them. See `fragmentNode` below
      // for the clamp that eats the negative push.
      toneMapped: false,
      fog: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    const rect: Tsl = attribute("stampRect", "vec4");
    const shove: Tsl = attribute("stampPush", "vec4");
    const local: Tsl = positionGeometry.xy; // a unit quad: -0.5 .. 0.5
    // ONE instanced attribute in the vertex stage, and nothing but scale+add.
    // Measured the hard way on this three/TSL version: a second instanced
    // attribute read in the VERTEX node binds as zero, the quad collapses to
    // no area, and the mask looks simply empty — a failure with no error
    // anywhere. So the stamp cannot carry a rotation basis, and the elongation
    // below is axis-aligned instead (see the fill).
    stampMaterial.vertexNode = vec4(
      local.x.mul(rect.z).add(rect.x),
      local.y.mul(rect.w).add(rect.y),
      float(0),
      float(1),
    );
    // squared falloff: a soft dent rather than a disc with an edge
    const falloff: Tsl = float(1).sub(tslLength(local).mul(2)).clamp(0, 1);
    // The push goes into BOTH stored heights: it displaces the surface without
    // also handing it a velocity. Pushing only `h` leaves a step change the
    // solver reads as an impulse, and a swimmer stamping every frame then
    // builds high-frequency chop instead of a wake.
    const dent: Tsl = falloff.mul(falloff).mul(shove.z);
    stampMaterial.fragmentNode = vec4(dent, dent, float(0), float(1));
    const mesh = new THREE.Mesh(this.stampGeometry, stampMaterial);
    mesh.frustumCulled = false;
    this.stampScene = new THREE.Scene();
    this.stampScene.add(mesh);
  }

  /** The live height field — what the water material samples. */
  get texture(): THREE.Texture {
    return this.targets[this.front]!.texture;
  }

  /**
   * The target behind that texture. Only a tool wants this: reading the field
   * back (`readRenderTargetPixelsAsync`) is how a headless probe checks that
   * the simulation is running at all, which a screenshot of a subtle ripple
   * cannot settle.
   */
  get target(): THREE.RenderTarget {
    return this.targets[this.front]!;
  }

  /** Where the patch WANTS to be — the camera, every frame. */
  setCenter(x: number, z: number): void {
    this.wantX = x;
    this.wantZ = z;
  }

  /**
   * Disturb the water at a world point. `radius` in metres, `strength` 0..1 of
   * a full-speed swimmer's push, `dir` the direction of travel (which
   * elongates the dent along it).
   */
  stamp(x: number, z: number, radius: number, strength: number, dirX = 0, dirZ = 0): void {
    if (this.pending.length >= this.capacity) return;
    this.pending.push({ x, z, radius, strength, dirX, dirZ });
  }

  /**
   * Advance the surface, then lay this frame's disturbances into it.
   *
   * The simulation runs on a FIXED step and the stamps run on the frame, which
   * is the only arrangement that behaves: a wave solver stepped by a varying dt
   * changes its own wave speed with the frame rate (and loses stability when a
   * frame runs long), while a stamp skipped on a frame the solver did not step
   * would leave gaps in the trail.
   */
  update(renderer: THREE.WebGPURenderer, dt: number): void {
    const previous = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    this.accum += Math.min(Math.max(dt, 0), 0.25);
    let steps = 0;
    while (this.accum >= STEP && steps < 4) {
      this.accum -= STEP;
      this.simulate(renderer);
      steps++;
    }
    if (!this.placed) {
      // Nothing has been stepped yet, so there is no field to carry over: sit
      // the patch where it was asked for and start clean.
      this.centerX = this.snap(this.wantX);
      this.centerZ = this.snap(this.wantZ);
      this.placed = true;
    }
    if (this.pending.length > 0) this.applyStamps(renderer, Math.min(Math.max(dt, 0), 0.1));
    renderer.autoClear = autoClear;
    renderer.setRenderTarget(previous);
    waterWakeUniforms.map.value = this.texture;
    (waterWakeUniforms.center.value as THREE.Vector2).set(this.centerX, this.centerZ);
    waterWakeUniforms.size.value = this.size;
    waterWakeUniforms.texel.value = 1 / this.resolution;
  }

  /** Round a world coordinate onto the patch's texel grid. */
  private snap(v: number): number {
    const texel = this.size / this.resolution;
    return Math.round(v / texel) * texel;
  }

  /** One fixed step of the wave equation, including any re-centring it owes. */
  private simulate(renderer: THREE.WebGPURenderer): void {
    const back = 1 - this.front;
    const from = this.targets[this.front]!;
    const to = this.targets[back]!;
    const nextX = this.snap(this.wantX);
    const nextZ = this.snap(this.wantZ);
    const dx = this.placed ? nextX - this.centerX : 0;
    const dz = this.placed ? nextZ - this.centerZ : 0;
    // The shift is a whole number of texels by construction, so sampling the
    // previous field through it lands on texel centres and copies exactly.
    // A jump bigger than the patch has nothing to carry (teleport, respawn).
    const far = Math.abs(dx) >= this.size || Math.abs(dz) >= this.size;
    // v runs opposite world z (see the material's uv), hence the sign.
    (this.shift.value as THREE.Vector2).set(far ? 0 : dx / this.size, far ? 0 : -dz / this.size);
    this.centerX = nextX;
    this.centerZ = nextZ;
    this.placed = true;
    this.source.value = far ? BLANK : from.texture;
    renderer.setRenderTarget(to);
    renderer.autoClear = true;
    renderer.render(this.stepScene, this.camera);
    this.front = back;
  }

  /** Push this frame's dents into the live field, in place. */
  private applyStamps(renderer: THREE.WebGPURenderer, dt: number): void {
    const rect = this.rect.array as Float32Array;
    const push = this.push.array as Float32Array;
    for (let i = 0; i < this.pending.length; i++) {
      const s = this.pending[i]!;
      const across = (s.radius / this.size) * 2;
      const speed = Math.hypot(s.dirX, s.dirZ);
      const moving = speed > 0.001;
      // Elongated along the way the body is going, axis-aligned: the dent grows
      // in whichever direction carries more of the travel. A rotated basis
      // would be exact, but it cannot reach the vertex stage (above), and over
      // a trail of dents the difference is not visible — what IS visible is a
      // dent that never elongates, which reads as a string of rings rather than
      // a body pushing water aside.
      const ax = moving ? Math.abs(s.dirX) / speed : 0;
      const az = moving ? Math.abs(s.dirZ) / speed : 0;
      rect[i * 4 + 0] = ((s.x - this.centerX) / this.size) * 2;
      rect[i * 4 + 1] = (-(s.z - this.centerZ) / this.size) * 2;
      rect[i * 4 + 2] = across * (1 + ax * 0.8);
      rect[i * 4 + 3] = across * (1 + az * 0.8);
      push[i * 4 + 0] = 0;
      push[i * 4 + 1] = 0;
      // Negative: a body displaces water DOWNWARD, and the rebound is what
      // radiates away as the wake. Per second, so a long frame pushes as much
      // water as several short ones — but capped, because a frame that hitched
      // must not slam the solver with a metre-deep pulse. The constant is
      // large because each stamp is a PULSE, not a held dent: the solver has
      // no notion of a hull sitting in the water, so what it emits radiates
      // away immediately and only the per-frame push is ever on screen.
      push[i * 4 + 2] = -Math.min(s.strength * 30 * dt, 0.6);
      push[i * 4 + 3] = 0;
    }
    this.stampGeometry.instanceCount = this.pending.length;
    this.rect.needsUpdate = true;
    this.push.needsUpdate = true;
    renderer.setRenderTarget(this.targets[this.front]!);
    renderer.autoClear = false;
    renderer.render(this.stampScene, this.camera);
    this.pending.length = 0;
  }

  dispose(): void {
    for (const target of this.targets) target.dispose();
    this.stampGeometry.dispose();
    waterWakeUniforms.strength.value = 0;
    waterWakeUniforms.map.value = BLANK;
  }
}
