import * as THREE from "three/webgpu";
import { loadGltf } from "@hitreg/render";
import type { CreationStage } from "@hitreg/core";

/**
 * The clearing the character stands in on the creation and character-select
 * screens (Derek, 2026-10-07: "use some of the ingame stuff, like trees god
 * rays, fog… but with a painted background"; then "the tree models look faded
 * and they dont look like they are part of any ground… you dont want any of
 * the ai art in the forefront").
 *
 * The painting is CSS behind the transparent canvas and shows only in the
 * DISTANCE: everything from the character's feet to the horizon is this 3D
 * layer, built from the game's own art, which the game names in its creation
 * asset's `stage` (core `creationStageSchema`); this module owns only the layout —
 *
 *   - the ground: the stage's ground texture, with a worn patch under the
 *     feet (its groundPatch texture), lit like the world, running
 *     out to the fog where it meets the painting's misty treeline;
 *   - ground cover: the world's cover sprites (ferns, heather, moss, clover),
 *     thick at the edges, sparse in the middle, none in front of the character;
 *   - the world's trees and rocks, standing ON that ground, darkened into the
 *     evening light but not fogged out;
 *   - god rays slanting in from the painting's sun, dust drifting in them,
 *     low mist sliding across the back.
 *
 * A model or texture that fails to load is skipped — the clearing never stops
 * the screen.
 */

/** Fog: thin near the character, closing in where the ground meets the painting. */
export const STAGE_FOG = { color: 0x5f6d6b, near: 16, far: 58 };
/** How the portrait frames the character in the clearing (PortraitView padding / aimLow). */
export const STAGE_FRAMING = { padding: 1.9, aimLow: -0.06 };
/** The clearing's trees and plants are drawn this much darker than in the world: evening, in the painting's shade. */
const SHADE = 0.5;

interface Placement {
  model: string;
  at: [number, number, number];
  scale: number;
  yaw: number;
}

/**
 * A dense forest round the clearing: rings of the stage's tree models (picked by
 * weight) on both sides and behind, a corridor kept open down the middle so the
 * painting's ruin and light show through, and nothing between the camera and the
 * character. Deterministic: the same clearing every time.
 */
function forest(trees: CreationStage["trees"]): Placement[] {
  const out: Placement[] = [];
  const total = trees.reduce((sum, t) => sum + t.weight, 0);
  if (!(total > 0)) return out;
  const h = (i: number, k: number): number => {
    const v = Math.sin(i * 91.7 + k * 47.3) * 43758.5453;
    return v - Math.floor(v);
  };
  for (let i = 0; out.length < 72 && i < 600; i++) {
    const x = (h(i, 1) - 0.5) * 64;
    const z = -3 - h(i, 2) * 40;
    // the clearing and the corridor stay open; the trees close in further back
    const corridor = 1.6 + Math.max(0, -z - 8) * 0.12;
    if (Math.abs(x) < corridor) continue;
    // the clearing itself: open round the character
    if (z > -7 && Math.abs(x) < 5.5) continue;
    // not too close to another
    if (out.some((p) => Math.hypot(p.at[0] - x, p.at[2] - z) < 2.6)) continue;
    let pick = h(i, 3) * total;
    const model = trees.find((t) => (pick -= t.weight) < 0)?.model ?? trees[trees.length - 1]!.model;
    out.push({ model, at: [x, 0, z], scale: 1.0 + h(i, 4) * 0.7, yaw: h(i, 5) * Math.PI * 2 });
  }
  return out;
}

/** A canvas texture: (u, v) in 0..1 → rgba 0..255. */
function painted(size: number, paint: (u: number, v: number) => [number, number, number, number]): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = paint((x + 0.5) / size, (y + 0.5) / size);
      const i = (y * size + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Deterministic noise 0..1. */
const hash = (x: number, y: number): number => {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
};

const loader = new THREE.TextureLoader();
function pixelTexture(url: string | undefined, repeat: number): THREE.Texture | null {
  if (!url) return null;
  const tex = loader.load(url);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestMipmapLinearFilter;
  return tex;
}

export function clearingStage(
  resolveModel: (assetId: string) => string | undefined,
  resolveTexture: (assetId: string) => string | undefined,
  art: CreationStage | undefined,
) {
  const plants: Placement[] = [...forest(art?.trees ?? []), ...(art?.props ?? []).map((p) => ({ model: p.model, at: p.at, scale: p.scale ?? 1, yaw: p.yaw ?? 0 }))];
  const cover = art?.cover;
  return (scene: THREE.Scene): { update(dt: number): void; dispose(): void } => {
    const group = new THREE.Group();
    group.name = "creation-stage";
    scene.add(group);
    const disposables: Array<{ dispose(): void }> = [];
    let alive = true;

    // -- the ground: the world's grass to the horizon, a worn dirt patch under the feet
    const GROUND = 90;
    const grassTex = art?.ground ? pixelTexture(resolveTexture(art.ground), GROUND / 3.5) : null;
    const groundGeo = new THREE.CircleGeometry(GROUND, 64);
    const groundMat = new THREE.MeshLambertMaterial({ color: grassTex ? 0x6f7d66 : 0x3f4a32, ...(grassTex ? { map: grassTex } : {}) });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    group.add(ground);
    disposables.push(groundGeo, groundMat);
    if (grassTex) disposables.push(grassTex);
    // the worn patch: dirt, its edge broken up so it is never a circle
    const dirtTex = art?.groundPatch ? pixelTexture(resolveTexture(art.groundPatch), 2.2) : null;
    const patchMask = painted(64, (u, v) => {
      const dx = u - 0.5;
      const dz = v - 0.5;
      const a = Math.atan2(dz, dx);
      const wobble = 0.36 + 0.07 * Math.sin(a * 5 + 1.3) + 0.05 * Math.sin(a * 9);
      const r = Math.hypot(dx, dz);
      const k = Math.max(0, Math.min(1, (wobble - r) / 0.12));
      const n = hash(Math.floor(u * 32), Math.floor(v * 32)) > 0.5 ? 1 : 0.8;
      const g = Math.round(k * n * 255);
      return [g, g, g, 255];
    });
    patchMask.magFilter = THREE.NearestFilter;
    const patchGeo = new THREE.PlaneGeometry(5.5, 5.5);
    const patchMat = new THREE.MeshLambertMaterial({ color: 0xb8a690, transparent: true, alphaMap: patchMask, depthWrite: false, ...(dirtTex ? { map: dirtTex } : {}) });
    const patch = new THREE.Mesh(patchGeo, patchMat);
    patch.rotation.x = -Math.PI / 2;
    patch.position.y = 0.01;
    group.add(patch);
    disposables.push(patchGeo, patchMat, patchMask);
    if (dirtTex) disposables.push(dirtTex);
    // a soft contact shadow under the feet
    const shadowTex = painted(64, (u, v) => {
      const r = Math.hypot(u - 0.5, v - 0.5) * 2;
      return [6, 8, 5, Math.round(Math.max(0, 1 - r) ** 1.6 * 170)];
    });
    const shadowGeo = new THREE.PlaneGeometry(1.6, 1.6);
    const shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false });
    const shadow = new THREE.Mesh(shadowGeo, shadowMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.02;
    group.add(shadow);
    disposables.push(shadowTex, shadowGeo, shadowMat);

    // -- the horizon: a ring of mist where the ground meets the painting, the fog's colour fading up into nothing
    const bandTex = painted(8, (_u, v) => {
      // CylinderGeometry: v = 0 at the bottom — the mist is thick at the ground and thins upward
      const a = Math.pow(Math.max(0, Math.min(1, 1 - v)), 1.6);
      return [95, 109, 107, Math.round(a * 255)];
    });
    bandTex.magFilter = THREE.LinearFilter;
    const bandGeo = new THREE.CylinderGeometry(46, 46, 14, 48, 1, true);
    const bandMat = new THREE.MeshBasicMaterial({ map: bandTex, transparent: true, depthWrite: false, side: THREE.BackSide, fog: false });
    const band = new THREE.Mesh(bandGeo, bandMat);
    band.position.y = 5;
    group.add(band);
    disposables.push(bandTex, bandGeo, bandMat);

    // -- ground cover: the world's tufts, thick at the edges, sparse in the middle, none in front
    const coverUrl = cover ? resolveTexture(cover.texture) : undefined;
    if (cover && coverUrl) {
      const coverTex = loader.load(coverUrl);
      coverTex.colorSpace = THREE.SRGBColorSpace;
      coverTex.magFilter = THREE.NearestFilter;
      coverTex.minFilter = THREE.NearestFilter;
      coverTex.generateMipmaps = false;
      // unlit, tinted to the clearing's light: a lit double-sided sprite turns black from behind (its normal flips)
      const coverMat = new THREE.MeshBasicMaterial({ map: coverTex, alphaTest: 0.5, side: THREE.DoubleSide, color: 0x76806a });
      disposables.push(coverTex, coverMat);
      const tw = 1 / cover.columns;
      const th = 1 / cover.rows;
      const positions: number[] = [];
      const uvs: number[] = [];
      let n = 0;
      for (let i = 0; i < 900 && n < 260; i++) {
        const r = 2.6 + Math.pow(hash(i, 1), 0.7) * 16;
        const a = hash(i, 2) * Math.PI * 2;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r - 3;
        // nothing between the viewer and the character, and nothing big near the camera at all
        if (z > -0.5) continue;
        // denser toward the sides and the back
        if (hash(i, 3) > 0.25 + Math.min(1, (Math.abs(x) + Math.max(0, -z)) / 9)) continue;
        const tile = cover.tiles[Math.floor(hash(i, 4) * cover.tiles.length)]!;
        const s = 0.3 + hash(i, 5) * 0.4;
        const col = tile % cover.columns;
        const row = Math.floor(tile / cover.columns);
        const u0 = col * tw;
        const v1 = 1 - row * th;
        const v0 = v1 - th;
        // two crossed quads per tuft
        for (const rot of [hash(i, 6) * Math.PI, hash(i, 6) * Math.PI + Math.PI / 2]) {
          const cx = Math.cos(rot) * s * 0.5;
          const cz = Math.sin(rot) * s * 0.5;
          const quad = [
            [x - cx, 0, z - cz, u0, v0],
            [x + cx, 0, z + cz, u0 + tw, v0],
            [x + cx, s, z + cz, u0 + tw, v1],
            [x - cx, 0, z - cz, u0, v0],
            [x + cx, s, z + cz, u0 + tw, v1],
            [x - cx, s, z - cz, u0, v1],
          ];
          for (const q of quad) {
            positions.push(q[0]!, q[1]!, q[2]!);
            uvs.push(q[3]!, q[4]!);
          }
        }
        n++;
      }
      const coverGeo = new THREE.BufferGeometry();
      coverGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      coverGeo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
      group.add(new THREE.Mesh(coverGeo, coverMat));
      disposables.push(coverGeo);
    }

    // -- the world's trees and rocks, standing on the ground, darkened into the evening
    for (const p of plants) {
      const url = resolveModel(p.model);
      if (!url) continue;
      void loadGltf(url)
        .then((gltf) => {
          if (!alive) return;
          const object = gltf.scene.clone(true);
          object.position.set(p.at[0], p.at[1], p.at[2]);
          object.rotation.y = p.yaw;
          object.scale.setScalar(p.scale);
          object.traverse((n) => {
            const mesh = n as THREE.Mesh;
            if (!mesh.isMesh) return;
            const own = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((m) => {
              const copy = m.clone() as THREE.MeshStandardMaterial;
              copy.color?.multiplyScalar(SHADE);
              const map = copy.map;
              if (map && map.magFilter !== THREE.NearestFilter) {
                map.magFilter = THREE.NearestFilter;
                map.minFilter = THREE.NearestFilter;
                map.needsUpdate = true;
              }
              disposables.push(copy);
              return copy;
            });
            mesh.material = Array.isArray(mesh.material) ? own : own[0]!;
          });
          group.add(object);
        })
        .catch((error) => console.warn(`[creation-stage] ${p.model}:`, error));
    }

    // -- god rays: soft additive streaks slanting in from the painting's sun (upper left)
    const rayTex = painted(64, (u, v) => {
      const across = Math.exp(-Math.pow((u - 0.5) / 0.22, 2));
      const along = Math.pow(Math.sin(Math.PI * v), 0.8) * (1 - v * 0.55);
      return [255, 214, 150, Math.round(255 * across * along)];
    });
    const rays: Array<{ mat: THREE.MeshBasicMaterial; phase: number; base: number }> = [];
    const rayGeo = new THREE.PlaneGeometry(1, 1);
    const shafts = [
      { x: -3.4, z: -5, w: 1.8, h: 12, base: 0.16 },
      { x: -1.2, z: -8, w: 2.6, h: 14, base: 0.12 },
      { x: -6.5, z: -10, w: 3, h: 15, base: 0.1 },
    ];
    shafts.forEach((s, i) => {
      const mat = new THREE.MeshBasicMaterial({ map: rayTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, opacity: s.base, fog: false });
      const mesh = new THREE.Mesh(rayGeo, mat);
      mesh.scale.set(s.w, s.h, 1);
      mesh.position.set(s.x, s.h * 0.42, s.z);
      mesh.rotation.set(0, 0.25, -0.38);
      group.add(mesh);
      rays.push({ mat, phase: i * 1.7, base: s.base });
      disposables.push(mat);
    });
    disposables.push(rayTex, rayGeo);

    // -- dust motes drifting in the light
    const motes = 120;
    const motePos = new Float32Array(motes * 3);
    const moteSeed = new Float32Array(motes);
    for (let i = 0; i < motes; i++) {
      motePos[i * 3] = -5 + hash(i, 11) * 7;
      motePos[i * 3 + 1] = 0.3 + hash(i, 12) * 5;
      motePos[i * 3 + 2] = -8 + hash(i, 13) * 7;
      moteSeed[i] = hash(i, 14) * Math.PI * 2;
    }
    const moteGeo = new THREE.BufferGeometry();
    moteGeo.setAttribute("position", new THREE.BufferAttribute(motePos, 3));
    const moteMat = new THREE.PointsMaterial({ color: 0xffe2a8, size: 0.03, transparent: true, opacity: 0.65, depthWrite: false, blending: THREE.AdditiveBlending });
    group.add(new THREE.Points(moteGeo, moteMat));
    disposables.push(moteGeo, moteMat);

    // -- low mist sliding across the back of the clearing (never in front of the character)
    const mistTex = painted(64, (u, v) => {
      const r = Math.hypot((u - 0.5) * 2, (v - 0.5) * 2);
      const n = 0.7 + hash(Math.floor(u * 8), Math.floor(v * 8)) * 0.3;
      return [178, 196, 196, Math.round(Math.max(0, 1 - r) ** 1.6 * 255 * n)];
    });
    const mistGeo = new THREE.PlaneGeometry(1, 1);
    const mists: Array<{ mesh: THREE.Mesh; speed: number; span: number }> = [];
    for (let i = 0; i < 6; i++) {
      const mat = new THREE.MeshBasicMaterial({ map: mistTex, transparent: true, depthWrite: false, opacity: 0.22, fog: false });
      const mesh = new THREE.Mesh(mistGeo, mat);
      const w = 7 + hash(i, 17) * 6;
      mesh.scale.set(w, w * 0.3, 1);
      mesh.rotation.x = -Math.PI / 2 + 0.2;
      mesh.position.set(-12 + hash(i, 18) * 24, 0.3 + hash(i, 19) * 0.4, -6 - hash(i, 20) * 12);
      group.add(mesh);
      mists.push({ mesh, speed: 0.1 + hash(i, 21) * 0.12, span: 14 });
      disposables.push(mat);
    }
    disposables.push(mistTex, mistGeo);

    let t = 0;
    return {
      update(dt: number): void {
        t += dt;
        for (const r of rays) r.mat.opacity = r.base * (0.75 + 0.25 * Math.sin(t * 0.35 + r.phase));
        for (let i = 0; i < motes; i++) {
          const s = moteSeed[i]!;
          motePos[i * 3]! += Math.sin(t * 0.3 + s) * 0.0015;
          motePos[i * 3 + 1] = ((motePos[i * 3 + 1]! + dt * 0.05 - 0.3) % 5) + 0.3;
        }
        (moteGeo.attributes["position"] as THREE.BufferAttribute).needsUpdate = true;
        for (const m of mists) {
          m.mesh.position.x += m.speed * dt;
          if (m.mesh.position.x > m.span) m.mesh.position.x = -m.span;
        }
      },
      dispose(): void {
        alive = false;
        group.removeFromParent();
        for (const d of disposables) d.dispose();
      },
    };
  };
}
