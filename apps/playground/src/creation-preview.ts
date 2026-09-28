/**
 * The creation screen's live model: the build's body in a PortraitView
 * (idle clip, own renderer), with every appearance option that names a model
 * and a socket parented to that bone on the preview's clone — placed by its
 * offset/rotation/scale, showing its tile of a packed page and only the
 * ubermesh parts the build picks, with the body's own head (the hood) hidden
 * under it when the option says so. An option naming the BODY model itself
 * with no socket (an outfit, a legs override) dresses the body: each such
 * option is one GROUP of parts wearing its own sheet, later slots winning a
 * shared part — a vanguard chest over ranger legs is still one mesh.
 *
 * Tiles and the skin tone are drawn by render's appearance material (one per
 * model, shared by every character; the look rides on the mesh as 16 floats):
 * no material or texture copy per preview. The skin colour slot (material
 * "Skin") recolours the skin texels of the sheets options OPT IN with `skin`
 * (the faces, the unequipped body, a gloved set's bare fingers) — never an
 * armour sheet that did not.
 *
 * Models carry `rules` beside `parts` (core partRulesSchema); a shown part's
 * `hides` removes the parts it covers from every OTHER model worn with it —
 * a helm hides the hair, a face cover the head's skin.
 *
 * Options without a model draw nothing — the art arrives later and the choice
 * is still a valid one. A missing body model leaves the stage empty rather
 * than failing the screen.
 */

import * as THREE from "three/webgpu";
import {
  appearanceOf,
  bodyModelOf,
  partRulesSchema,
  partsHiddenBy,
  placementOf,
  type CharacterBuild,
  type CharacterCreation,
} from "@hitreg/core";
import { applyModelAppearance, loadGltf, PortraitView, type SkinSheet } from "@hitreg/render";
import type { CreationPreview } from "./character-creation.js";

/** The colour slot material that recolours skin texels rather than a material. */
const SKIN = "Skin";

export function createCreationPreview(
  canvas: HTMLCanvasElement,
  creation: CharacterCreation,
  resolveModel: (assetId: string) => string | undefined,
): CreationPreview {
  let view: PortraitView | null = null;
  let bodyUrl = "";
  let bodyReady: Promise<void> = Promise.resolve();
  let yaw = 0;
  let alive = true;
  let generation = 0;
  const pieces: THREE.Object3D[] = [];

  const pixelated = (root: THREE.Object3D): void => {
    // the game draws its characters nearest-filtered (PSX look); so does the preview
    root.traverse((n) => {
      const mesh = n as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const map = (m as THREE.MeshStandardMaterial).map;
        if (map && map.magFilter !== THREE.NearestFilter) {
          map.magFilter = THREE.NearestFilter;
          map.minFilter = THREE.NearestFilter;
          map.needsUpdate = true;
        }
      }
    });
  };

  const findBone = (root: THREE.Object3D, name: string): THREE.Object3D | null => {
    let hit: THREE.Object3D | null = null;
    root.traverse((n) => {
      if (!hit && n.name === name) hit = n;
    });
    return hit;
  };

  /**
   * Colour slots (skin tone, lip colour) tint the body material they name.
   * The clone shares materials with the loaded model, so a tinted material is
   * copied once per mesh first — the world's copy of the model is never touched.
   */
  const tint = (model: THREE.Object3D, build: CharacterBuild): void => {
    const colors = new Map<string, string>();
    for (const { slot, option } of appearanceOf(creation, build)) {
      // "Skin" is the page-texel tint (skinToneOf), never a material swap
      if (slot.material && slot.material !== SKIN && option.color) colors.set(slot.material, option.color);
    }
    // a slot that is no longer offered (lips on a male body) falls back to the material's own colour
    for (const slot of creation.appearance) if (slot.material && slot.material !== SKIN && !colors.has(slot.material)) colors.set(slot.material, "");
    if (colors.size === 0) return;
    model.traverse((n) => {
      const mesh = n as THREE.Mesh;
      if (!mesh.isMesh) return;
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const next = list.map((m) => {
        const base = (m.userData["creationBase"] as THREE.Material | undefined) ?? m;
        const color = colors.get(base.name);
        if (color === undefined) return m;
        if (color === "") return base;
        const own = m === base ? base.clone() : m;
        own.userData["creationBase"] = base;
        (own as THREE.MeshStandardMaterial).color?.set(color);
        return own;
      });
      mesh.material = Array.isArray(mesh.material) ? next : next[0]!;
    });
  };

  /**
   * Per model, every sheet any option OPTS IN as bare skin (`skin`): one list
   * per model, so every build shares one material for it.
   */
  const skinSheets = new Map<string, SkinSheet[]>();
  for (const slot of creation.appearance) {
    for (const option of slot.options) {
      if (!option.skin || !option.model || !option.texture) continue;
      let list = skinSheets.get(option.model);
      if (!list) skinSheets.set(option.model, (list = []));
      const parts = Array.isArray(option.skin) ? option.skin : undefined;
      const face = option.skin === "face";
      const same = list.find((s) => s.texture === option.texture);
      if (!same) list.push(parts ? { texture: option.texture, parts: [...parts] } : face ? { texture: option.texture, face } : { texture: option.texture });
      else if (same.parts) {
        if (!parts) delete same.parts;
        else same.parts = [...new Set([...same.parts, ...parts])];
      }
    }
  }

  /** The build's skin tone: the colour of the option in the slot whose material is "Skin". */
  const skinToneOf = (build: CharacterBuild): string | null =>
    appearanceOf(creation, build).find(({ slot, option }) => slot.material === SKIN && option.color)?.option.color ?? null;

  /**
   * Whole-sheet colours (hair colour): model → the chosen colour, from every slot
   * with `tintModels`. A model named by such a slot always draws with its
   * whole-sheet material, so switching colours never swaps a material.
   */
  const sheetTintsOf = (build: CharacterBuild): Map<string, string | null> => {
    const out = new Map<string, string | null>();
    for (const slot of creation.appearance) for (const model of slot.tintModels ?? []) out.set(model, null);
    for (const { slot, option } of appearanceOf(creation, build)) {
      if (option.color) for (const model of slot.tintModels ?? []) out.set(model, option.color);
    }
    return out;
  };
  let sheetTints = new Map<string, string | null>();

  /** Swap the body when the build's body model changes; later calls await the same load. */
  const loadBody = async (url: string): Promise<void> => {
    try {
      const gltf = await loadGltf(url);
      if (!alive || bodyUrl !== url) return;
      view?.dispose();
      pieces.length = 0;
      pixelated(gltf.scene);
      // neutral-warm light: the default cool studio fill turned dark skin tones grey-violet
      view = new PortraitView(gltf.scene, canvas, {
        clips: gltf.animations,
        padding: 1.35,
        lights: { sky: 0xf1ebe3, ground: 0x3a3029, rim: 0xffe9d6 },
      });
      view.setYaw(yaw);
    } catch (error) {
      console.warn("[creation] body model failed to load:", error);
    }
  };

  /**
   * The pieces a build wears: every option naming a model and a socket, with
   * options in different slots that name the SAME model folded into one piece.
   * The head module is one ubermesh whose face is a tile of its page and whose
   * hair and beard are parts of it, so face, hair and beard are one draw.
   */
  interface Piece {
    model: string;
    socket: string;
    offset?: [number, number, number];
    rotationDeg?: [number, number, number];
    scale?: number;
    mirrorTo?: { socket: string; offset: [number, number, number]; rotationDeg: [number, number, number] };
    texture?: string;
    parts: Set<string> | null;
    hideBones: string[];
    /** Per-part sheets (the body: one group per outfit-like option, in slot order). */
    groups?: Array<{ parts: string[]; texture: string | null }>;
  }
  const piecesOf = (build: CharacterBuild, bodyModel: string): { pieces: Piece[]; body: Piece | null } => {
    const byModel = new Map<string, Piece>();
    let body: Piece | null = null;
    for (const { slot, option } of appearanceOf(creation, build)) {
      if (slot.body) {
        // the body option's own parts + sheet: its unequipped look, under every outfit row
        if (option.parts?.length && (option.model ?? bodyModel) === bodyModel) {
          body ??= { model: bodyModel, socket: "", parts: null, hideBones: [], groups: [] };
          body.texture ??= option.texture;
          for (const part of option.parts) (body.parts ??= new Set()).add(part);
          body.groups!.push({ parts: [...option.parts], texture: option.texture ?? null });
        }
        continue;
      }
      if (!option.model) continue;
      // the option's own socket, else the creation's mount for its model (per sex where it says so)
      const at = placementOf(creation, option, build.appearance);
      if (!at) {
        // an outfit: the body model's own tile and parts
        if (option.model !== bodyModel) continue;
        body ??= { model: bodyModel, socket: "", parts: null, hideBones: [], groups: [] };
        body.texture ??= option.texture;
        if (option.parts) for (const part of option.parts) (body.parts ??= new Set()).add(part);
        // each option is one group wearing its own sheet; a later slot wins a shared part
        if (option.parts) body.groups!.push({ parts: [...option.parts], texture: option.texture ?? null });
        continue;
      }
      let piece = byModel.get(option.model);
      if (!piece) {
        piece = { model: option.model, socket: at.socket, parts: null, hideBones: [] };
        byModel.set(option.model, piece);
      }
      piece.offset ??= at.offset;
      piece.rotationDeg ??= at.rotationDeg;
      piece.scale ??= at.scale;
      piece.mirrorTo ??= at.mirrorTo;
      piece.texture ??= option.texture;
      if (option.parts) for (const part of option.parts) (piece.parts ??= new Set()).add(part);
      if (option.hideBones) piece.hideBones.push(...option.hideBones);
    }
    return { pieces: [...byModel.values()], body };
  };

  /** What the shown parts of a model cover on the others, from the model's own `rules`. */
  const hiddenBy = (root: THREE.Object3D, piece: Piece): Set<string> => {
    let out = new Set<string>();
    root.traverse((n) => {
      const raw = n.userData["rules"];
      const table = n.userData["parts"] as Record<string, number> | undefined;
      if (!raw || !table) return;
      const rules = partRulesSchema.safeParse(raw);
      if (!rules.success) return;
      out = partsHiddenBy(rules.data, piece.parts ? [...piece.parts] : Object.keys(table));
    });
    return out;
  };

  /** A copy of `geo` with only the triangles `keep` accepts: attributes shared, a new index. */
  const filtered = (geo: THREE.BufferGeometry, keep: (a: number, b: number, c: number) => boolean): THREE.BufferGeometry => {
    const out = geo.clone();
    const count = geo.attributes["position"]!.count;
    const src = geo.index ? Array.from(geo.index.array) : Array.from({ length: count }, (_, i) => i);
    const kept: number[] = [];
    for (let t = 0; t + 2 < src.length; t += 3) {
      if (keep(src[t]!, src[t + 1]!, src[t + 2]!)) kept.push(src[t]!, src[t + 1]!, src[t + 2]!);
    }
    out.setIndex(kept);
    out.clearGroups();
    return out;
  };

  /**
   * Hide the body's triangles carried by these bones and every bone under them —
   * the hood and head a head module replaces. The collar that only leans on
   * them (neck, shoulders) stays. An empty list restores the body.
   */
  const hideBody = (model: THREE.Object3D, roots: string[]): void => {
    model.traverse((n) => {
      const mesh = n as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh) return;
      const original = (mesh.userData["creationGeometry"] as THREE.BufferGeometry | undefined) ?? mesh.geometry;
      if (mesh.geometry !== original) mesh.geometry.dispose();
      mesh.userData["creationGeometry"] = original;
      mesh.geometry = original;
      if (roots.length === 0) return;
      const hidden = new Set<number>();
      mesh.skeleton.bones.forEach((bone, i) => {
        for (let b: THREE.Object3D | null = bone; b; b = b.parent) {
          if (roots.includes(b.name)) {
            hidden.add(i);
            break;
          }
        }
      });
      const joints = original.attributes["skinIndex"];
      const weights = original.attributes["skinWeight"];
      const position = original.attributes["position"];
      if (!joints || !weights || !position) return;
      const onHidden = (v: number): number => {
        let w = 0;
        for (let k = 0; k < 4; k++) if (hidden.has(joints.getComponent(v, k))) w += weights.getComponent(v, k);
        return w;
      };
      // Everything rising above the lowest hidden root at bind pose goes too,
      // whatever carries it: human.glb's hood hangs a back flap up behind the
      // head that is skinned to the spine alone.
      mesh.updateWorldMatrix(true, false);
      const toWorld = new THREE.Matrix4().multiplyMatrices(mesh.matrixWorld, mesh.bindMatrix);
      let ceiling = Infinity;
      mesh.skeleton.bones.forEach((bone, i) => {
        if (!roots.includes(bone.name)) return;
        const at = new THREE.Vector3().setFromMatrixPosition(mesh.skeleton.boneInverses[i]!.clone().invert());
        ceiling = Math.min(ceiling, at.applyMatrix4(toWorld).y + 0.05);
      });
      const p = new THREE.Vector3();
      const height = (v: number): number => p.fromBufferAttribute(position, v).applyMatrix4(toWorld).y;
      mesh.geometry = filtered(
        original,
        (a, b, c) =>
          (onHidden(a) + onHidden(b) + onHidden(c)) / 3 <= 0.3 && Math.max(height(a), height(b), height(c)) <= ceiling,
      );
    });
  };

  /**
   * Show the piece's tiles of its packed page and its skin tone, and only the
   * ubermesh parts it picks (less what others hide).
   */
  const dress = (root: THREE.Object3D, piece: Piece, hidden: Set<string>, tone: string | null): void => {
    root.traverse((n) => {
      const mesh = n as THREE.Mesh;
      if (!mesh.isMesh) return;
      // the body is dressed again on every change: start from its own material
      const ownMaterial = (mesh.userData["creationMaterial"] as THREE.Material | undefined) ?? (mesh.material as THREE.Material);
      mesh.userData["creationMaterial"] = ownMaterial;
      mesh.material = ownMaterial;
      const table = mesh.userData["parts"] as Record<string, number> | undefined;
      // the tiles: the body's groups, or every part on the piece's one sheet
      const groups = piece.groups?.length
        ? piece.groups
        : piece.texture && table
          ? [{ parts: piece.parts ? [...piece.parts] : Object.keys(table), texture: piece.texture }]
          : [];
      const skin = skinSheets.get(piece.model) ?? [];
      const dressed = sheetTints.has(piece.model)
        ? // hair: the whole sheet takes the chosen colour
          applyModelAppearance(mesh, { groups, skinTint: sheetTints.get(piece.model) ?? null }, { tintWhole: true })
        : applyModelAppearance(
            mesh,
            { groups, skinTint: skin.length ? tone : null },
            // part islands are read from the whole model, not the hood-trimmed copy
            { skin, geometry: (mesh.userData["creationGeometry"] as THREE.BufferGeometry | undefined) ?? mesh.geometry },
          );
      for (const t of dressed.missingTextures) console.warn(`[creation] ${piece.model}: no tile "${t}" on the model`);
      const index = mesh.geometry.attributes["uv1"];
      if ((piece.parts || hidden.size) && table && index) {
        const names = piece.parts ? [...piece.parts] : Object.keys(table);
        const show = new Set(names.filter((p) => !hidden.has(p)).map((p) => table[p]).filter((i): i is number => i !== undefined));
        mesh.geometry = filtered(mesh.geometry, (a) => show.has(Math.round(index.getX(a))));
      }
    });
  };

  const show = async (build: CharacterBuild): Promise<void> => {
    const mine = ++generation;
    const url = resolveModel(bodyModelOf(creation, build));
    if (url && url !== bodyUrl) {
      bodyUrl = url;
      bodyReady = loadBody(url);
    }
    await bodyReady;
    if (!alive || mine !== generation || !view) return;
    tint(view.model, build);
    // a body-slot option may scale the whole character (female = 0.96 of the rig)
    const bodyScale = appearanceOf(creation, build).find(({ slot }) => slot.body)?.option.scale ?? 1;
    view.model.scale.setScalar(bodyScale);
    const { pieces: wanted, body } = piecesOf(build, bodyModelOf(creation, build));
    const loaded: Array<{ piece: Piece; scene: THREE.Object3D }> = [];
    for (const piece of wanted) {
      const pieceUrl = resolveModel(piece.model);
      if (!pieceUrl) continue;
      try {
        loaded.push({ piece, scene: (await loadGltf(pieceUrl)).scene });
      } catch (error) {
        console.warn(`[creation] ${piece.model}: model failed to load:`, error);
      }
      if (!alive || mine !== generation || !view) return;
    }
    for (const old of pieces.splice(0)) old.removeFromParent();
    hideBody(view.model, loaded.flatMap(({ piece }) => piece.hideBones));
    // what each model's shown parts cover on the others (the body's too)
    const bodyPiece: Piece = body ?? { model: bodyModelOf(creation, build), socket: "", parts: null, hideBones: [] };
    const covers = new Map<THREE.Object3D, Set<string>>([[view.model, hiddenBy(view.model, bodyPiece)]]);
    for (const { piece, scene } of loaded) covers.set(scene, hiddenBy(scene, piece));
    const hiddenFor = (self: THREE.Object3D): Set<string> => {
      const out = new Set<string>();
      for (const [who, set] of covers) if (who !== self) for (const p of set) out.add(p);
      return out;
    };
    const tone = skinToneOf(build);
    sheetTints = sheetTintsOf(build);
    dress(view.model, bodyPiece, hiddenFor(view.model), tone);
    // one placement per bone: the piece's own, and a mirrored copy for `mirrorTo`
    const mount = (piece: Piece, scene: THREE.Object3D, at: { socket: string; offset?: [number, number, number]; rotationDeg?: [number, number, number] }, mirror: boolean): void => {
      const bone = findBone(view!.model, at.socket);
      if (!bone) {
        console.warn(`[creation] ${piece.model}: no bone "${at.socket}" on the body`);
        return;
      }
      const object = scene.clone(true);
      pixelated(object);
      dress(object, piece, hiddenFor(scene), tone);
      const holder = new THREE.Group();
      if (at.offset) holder.position.fromArray(at.offset);
      if (at.rotationDeg) {
        const [x, y, z] = at.rotationDeg.map((d) => THREE.MathUtils.degToRad(d));
        holder.rotation.set(x!, y!, z!);
      }
      holder.scale.setScalar(piece.scale ?? 1);
      // mirrored across the model's own Z: the right-hand copy of a left-hand piece
      if (mirror) holder.scale.z *= -1;
      holder.add(object);
      bone.add(holder);
      pieces.push(holder);
    };
    for (const { piece, scene } of loaded) {
      mount(piece, scene, piece, false);
      if (piece.mirrorTo) mount(piece, scene, piece.mirrorTo, true);
    }
  };

  return {
    update: (build) => void show(build),
    setYaw: (radians) => {
      yaw = radians;
      view?.setYaw(radians);
    },
    dispose: () => {
      alive = false;
      view?.dispose();
      view = null;
    },
  };
}
