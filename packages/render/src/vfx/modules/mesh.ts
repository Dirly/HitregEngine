import * as THREE from "three/webgpu";
import { texture as tslTexture, uniform, uv } from "three/tsl";
import type { VfxModuleOf } from "@hitreg/core";
import { LiveModule, easeOut, loadTexture, presentationOnly, unlitMaterial, type LiveModuleHost } from "../base.js";
import { quantize, type N } from "../shaders.js";

const camPos = new THREE.Vector3();
const bodyPos = new THREE.Vector3();

type MeshModule = VfxModuleOf<"mesh">;

const MAX_BODIES = 12;
const primitives = new Map<string, THREE.BufferGeometry>();

/** Procedural bodies, built once. Rocks and crystals get a noisy vertex push. */
function primitive(kind: MeshModule["primitive"]): THREE.BufferGeometry {
  let g = primitives.get(kind);
  if (g) return g;
  switch (kind) {
    case "rock": {
      g = new THREE.DodecahedronGeometry(0.5, 1);
      jitter(g, 0.12, 7);
      break;
    }
    case "crystal": {
      g = new THREE.OctahedronGeometry(0.5, 0);
      g.scale(0.55, 1, 0.55);
      break;
    }
    case "spike":
      g = new THREE.ConeGeometry(0.22, 1, 6);
      break;
    case "orb":
      g = new THREE.SphereGeometry(0.5, 20, 14);
      break;
    case "blade":
      g = new THREE.BoxGeometry(0.12, 1, 0.5);
      break;
  }
  g.computeVertexNormals();
  primitives.set(kind, g);
  return g;
}

function jitter(g: THREE.BufferGeometry, amount: number, seed: number): void {
  const pos = g.attributes["position"] as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const h = Math.sin(i * 12.9898 + seed) * 43758.5453;
    const k = 1 + (h - Math.floor(h) - 0.5) * 2 * amount;
    pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k, pos.getZ(i) * k);
  }
  pos.needsUpdate = true;
}

interface Body {
  node: THREE.Object3D;
  /** the camera-facing drawing, used instead of the primitive when the module names a `sheet` */
  card: THREE.Mesh;
  angle: number;
  radius: number;
  offset: THREE.Vector3;
  spinAxis: THREE.Vector3;
}

/**
 * Real bodies in an effect: the rock a meteor drops, the crystals a frost
 * nova throws up, the orbs that orbit a buffed body, the thing a summon
 * raises. A sprite says something happened HERE; a body you watch fall says
 * something is ABOUT to happen here.
 *
 * With `sheet` + `cells` each body is a DRAWING instead: an upright quad
 * that yaws to face the camera (base at the bottom, like a PSX prop), cut
 * from the school's object sheet. One shared material; each body's quad
 * carries its cell in its own UVs, so the bodies need no per-body shader.
 */
export class MeshLive extends LiveModule<MeshModule> {
  readonly kind = "mesh" as const;
  private readonly group = new THREE.Group();
  private readonly bodies: Body[] = [];
  private readonly material: THREE.MeshStandardMaterial;
  private readonly primMeshes: THREE.Mesh[] = [];
  private loaded: THREE.Object3D | null = null;
  private loadedFor = "";
  private useLoaded = false;
  private readonly cardMaterial: THREE.MeshBasicNodeMaterial;
  private readonly uTint = uniform(new THREE.Color(1, 1, 1));
  private readonly uOpacity = uniform(1, "float");
  /** texel grid across the whole sheet (cols·k, rows·k); 0 = the art's own texels */
  private readonly uGrid = uniform(new THREE.Vector2(0, 0));
  private cardMap: THREE.Texture | null = null;
  private cardUrl = "";
  private drawn = false;
  private sheetCols = 1;
  private sheetRows = 1;

  constructor(host: LiveModuleHost) {
    super(host);
    this.material = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05, transparent: true });
    this.cardMaterial = unlitMaterial(false);
    for (let i = 0; i < MAX_BODIES; i++) {
      const mesh = new THREE.Mesh(primitive("crystal"), this.material);
      // presentation only: a shadow-casting effect body drags the whole
      // shadow pass into every spell, for a shadow nobody reads
      presentationOnly(mesh);
      this.primMeshes.push(mesh);
      const card = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.cardMaterial);
      presentationOnly(card);
      card.visible = false;
      const node = new THREE.Group();
      node.add(mesh);
      node.add(card);
      node.visible = false;
      this.group.add(node);
      this.bodies.push({ node, card, angle: 0, radius: 0, offset: new THREE.Vector3(), spinAxis: new THREE.Vector3(0, 1, 0) });
    }
    host.root.add(this.group);
  }

  protected naturalLife(): number {
    return this.ctx.phaseLength > 0 ? this.ctx.phaseLength : 1;
  }

  private buildCardShader(map: THREE.Texture): void {
    const s: N = tslTexture(map, quantize(uv() as N, this.uGrid));
    this.cardMaterial.colorNode = s.rgb.mul(this.uTint);
    this.cardMaterial.opacityNode = s.a.mul(this.uOpacity);
    this.cardMaterial.needsUpdate = true;
  }

  /** Point body `i`'s quad at its cell of the sheet (row 0 is the TOP of the image). */
  private setCell(card: THREE.Mesh, cell: readonly [number, number]): void {
    const uvs = card.geometry.attributes["uv"] as THREE.BufferAttribute;
    const u0 = cell[0] / this.sheetCols;
    const v0 = (this.sheetRows - 1 - cell[1]) / this.sheetRows;
    // PlaneGeometry(1,1): vertices TL, TR, BL, BR
    uvs.setXY(0, u0, v0 + 1 / this.sheetRows);
    uvs.setXY(1, u0 + 1 / this.sheetCols, v0 + 1 / this.sheetRows);
    uvs.setXY(2, u0, v0);
    uvs.setXY(3, u0 + 1 / this.sheetCols, v0);
    uvs.needsUpdate = true;
  }

  protected onBegin(): void {
    const m = this.module;
    this.material.color.copy(m.tint ? this.color : new THREE.Color(0.7, 0.7, 0.7));
    this.material.emissive.copy(this.color);
    this.material.emissiveIntensity = m.tint ? m.emissive : 0;
    this.material.opacity = 1;
    const geo = primitive(m.primitive);
    this.useLoaded = false;
    // drawn bodies: the school's object sheet instead of a primitive
    const sheet = m.sheet && m.cells.length > 0 ? this.host.resolvers.sheet?.(m.sheet) : undefined;
    const cardUrl = sheet ? this.host.resolvers.texture?.(sheet.texture) : undefined;
    this.drawn = !!cardUrl;
    if (sheet && cardUrl) {
      this.sheetCols = sheet.grid?.cols ?? 1;
      this.sheetRows = sheet.grid?.rows ?? 1;
      // the art tinted by the palette and lifted a little so it reads as lit
      this.uTint.value.copy(this.color).lerp(new THREE.Color(1, 1, 1), m.tint ? Math.min(0.5, m.emissive * 0.15) : 1);
      if (cardUrl !== this.cardUrl) {
        this.cardUrl = cardUrl;
        this.cardMap = null;
        loadTexture(
          cardUrl,
          (t) => {
            if (this.cardUrl !== cardUrl) return;
            this.cardMap = t;
            this.buildCardShader(t);
          },
          true,
        );
      }
    }
    if (m.asset && this.host.resolvers.loadModel) {
      if (this.loadedFor === m.asset && this.loaded) {
        this.useLoaded = true;
      } else {
        const asset = m.asset;
        this.loadedFor = asset;
        void this.host.resolvers.loadModel(asset).then((obj) => {
          if (!obj || this.loadedFor !== asset) return;
          this.loaded = obj;
          this.useLoaded = true;
          this.mountLoaded();
        });
      }
    }
    const n = Math.min(MAX_BODIES, m.count);
    for (let i = 0; i < MAX_BODIES; i++) {
      const b = this.bodies[i]!;
      const active = i < n;
      b.node.visible = active;
      if (!active) continue;
      const mesh = this.primMeshes[i]!;
      mesh.geometry = geo;
      mesh.visible = !this.useLoaded && !this.drawn;
      b.card.visible = this.drawn;
      if (this.drawn) this.setCell(b.card, m.cells[i % m.cells.length]!);
      b.angle = (i / n) * Math.PI * 2 + Math.random() * 0.3;
      b.radius = n > 1 ? m.spread * (0.5 + 0.5 * Math.random()) : 0;
      b.offset.set(Math.cos(b.angle) * b.radius, 0, Math.sin(b.angle) * b.radius);
      b.spinAxis.set(Math.random() - 0.5, 1, Math.random() - 0.5).normalize();
      b.node.rotation.set(Math.random() * 0.3, Math.random() * Math.PI * 2, Math.random() * 0.3);
    }
    if (this.useLoaded) this.mountLoaded();
  }

  /** Put a clone of the loaded model under each active body. */
  private mountLoaded(): void {
    const src = this.loaded;
    if (!src) return;
    const box = new THREE.Box3().setFromObject(src);
    const size = new THREE.Vector3();
    box.getSize(size);
    const norm = 1 / Math.max(1e-3, Math.max(size.x, size.y, size.z));
    const n = Math.min(MAX_BODIES, this.module.count);
    for (let i = 0; i < n; i++) {
      const b = this.bodies[i]!;
      // drop any earlier clone, keep the primitive mesh (child 0)
      for (let c = b.node.children.length - 1; c >= 1; c--) b.node.children[c]!.removeFromParent();
      const clone = src.clone(true);
      clone.scale.setScalar(norm);
      clone.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          presentationOnly(mesh);
          if (this.module.tint) {
            const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
            const own = mat.clone();
            own.emissive = this.color.clone();
            own.emissiveIntensity = this.module.emissive * 0.5;
            own.transparent = true;
            mesh.material = own;
          }
        }
      });
      b.node.add(clone);
      this.primMeshes[i]!.visible = false;
    }
  }

  protected onUpdate(t: number, dt: number, camera: THREE.Camera): void {
    const m = this.module;
    const now = this.now;
    const k = Math.min(1, t);
    const o = this.opacityAt(t, now);
    this.material.opacity = o;
    this.uOpacity.value = o;
    const drawn = this.drawn && this.cardMap !== null;
    if (drawn) {
      const texel = this.texelSize();
      const cells = texel > 0 ? (m.size * this.sizeAt(t)) / texel : 0;
      this.uGrid.value.set(cells * this.sheetCols, cells * this.sheetRows);
      camera.getWorldPosition(camPos);
    }
    const s = m.size * this.sizeAt(t);
    const p = this.pose.position;
    const n = Math.min(MAX_BODIES, m.count);
    for (let i = 0; i < n; i++) {
      const b = this.bodies[i]!;
      let y = 0;
      let x = b.offset.x;
      let z = b.offset.z;
      let scale = s;
      switch (m.motion) {
        case "drop": {
          const from = m.from > 0 ? m.from : 12;
          // gentle acceleration: a hard quadratic parks the body in the sky
          // for most of the windup, where nobody can see it coming
          y = from * (1 - Math.pow(k, 1.5));
          break;
        }
        case "rise": {
          const depth = m.from > 0 ? m.from : s;
          y = -depth * (1 - easeOut(k)) + s * 0.5;
          break;
        }
        case "hover":
          y = s * 0.5 + Math.sin(now * 1.7 + i) * 0.12 * s;
          break;
        case "orbit": {
          const a = b.angle + now * m.spin;
          x = Math.cos(a) * Math.max(0.3, m.spread);
          z = Math.sin(a) * Math.max(0.3, m.spread);
          y = 0.9 + Math.sin(now * 2.3 + i * 1.7) * 0.15;
          break;
        }
        case "forward": {
          const dist = (m.from > 0 ? m.from : 3) * easeOut(k);
          x = b.offset.x + this.pose.forward.x * dist;
          z = b.offset.z + this.pose.forward.z * dist;
          y = 0.05;
          break;
        }
        case "launch":
          y = s * 0.5 + k * (m.from > 0 ? m.from : 4);
          x = b.offset.x * (1 + k * 2);
          z = b.offset.z * (1 + k * 2);
          scale = s * (1 - k * 0.5);
          break;
      }
      b.node.position.set(p.x + x, p.y + y, p.z + z);
      b.node.scale.setScalar(Math.max(0.001, scale));
      if (this.drawn) {
        // a drawing stands upright and turns to the camera (a PSX prop), never tumbles
        b.card.visible = drawn;
        bodyPos.copy(b.node.position);
        b.node.rotation.set(0, Math.atan2(camPos.x - bodyPos.x, camPos.z - bodyPos.z), 0);
      } else if (m.motion !== "rise" && m.motion !== "hover") b.node.rotateOnAxis(b.spinAxis, m.spin * dt);
      else b.node.rotateY(m.spin * 0.3 * dt);
    }
  }

  protected onEnd(): void {
    for (const b of this.bodies) b.node.visible = false;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.material.dispose();
    this.cardMaterial.dispose();
    for (const b of this.bodies) b.card.geometry.dispose();
  }
}
