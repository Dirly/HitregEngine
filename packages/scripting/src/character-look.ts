import {
  dressCharacter,
  EQUIPMENT_SLOTS,
  partRulesSchema,
  type CharacterCreation,
  type LookPiece,
  type ModelPlacement,
  type PartRules,
} from "@hitreg/core";
import type * as THREE from "three";
import { Script, type ModelLook, type ModelTables } from "./script.js";
import { catalogOf, readSheet, sheetKey, sheetStoreOf, type SheetStoreLike } from "./character-store.js";

/**
 * Draws a CHARACTER from its replicated sheet: the creation build's body,
 * face, hair, skin tone and hair colour, and every equipped item on the
 * character's models — one of these per model the character wears.
 *
 * - On the BODY (the skinned model entity; put this on a child of it): the
 *   body option's unequipped layer under every item on the body (chest, legs,
 *   gloves, boots), mapped onto the wearer's sex (creation `remap`), with the
 *   skin tone and the whole character's scale (the woman is the rig at 0.96).
 * - On a SOCKETED model (head, hair, helm, shoulder pad — an entity drawing
 *   the model, `mesh.moving` so every character's copy is one draw): the
 *   build's face/hair/beard or the equipped helm/shoulders, placed on its bone
 *   by the creation's `mounts` (one place for every option and item; per sex
 *   where the mounts say so), in the bone's own space so the woman's scale
 *   carries through. `mirror` makes it the model's `mirrorTo` copy.
 *
 * Each model's `rules.hides` come off the others (a helm hides the hair, a face
 * cover the head). The creator's preview rows are never drawn: in game,
 * equipment dresses a character (core `dressCharacter`).
 *
 * Presentation: it reads `character/<actor>` from netState on every tab, so
 * every tab draws every player the same, and it keeps running on bodies this
 * tab does not simulate. On the dedicated server there is no `setModelLook`
 * and it does nothing.
 */
export class CharacterLook extends Script {
  static override scriptName = "character-look";
  static override presentation = true;
  static override params = {
    actor: {
      default: "",
      description: "entity id of the body whose character sheet (build + equipment) to draw — the one `character-sheet` names",
    },
    creation: {
      default: "",
      description: "creation data-asset id (assets/creation/<id>.json): body options, faces, hair, mounts, remap",
    },
    target: {
      default: "",
      description: "entity whose model this dresses; empty = this entity when it draws a mesh, else its parent (the body model)",
    },
    body: {
      default: "",
      description: "the skinned body entity whose bones a socketed model rides; empty = the target's parent",
    },
    appearance: {
      default: {} as Record<string, string>,
      description:
        "a FIXED build appearance (creation slot id → option id: sex, face, hair, hair-colour, beard, skin) for a character with no sheet — a townsperson; non-empty = the sheet is not read",
    },
    wear: {
      default: [] as string[],
      description: "item ids a sheet-less character wears (their `appearance` dresses it, later items win a shared part) — with `appearance`, an NPC outfit",
    },
    mirror: {
      default: false,
      description: "this copy is the model's MIRRORED placement (the mount's `mirrorTo`: the right-hand shoulder pad)",
    },
  };

  private store!: SheetStoreLike;
  private creation: CharacterCreation | null = null;
  private target = "";
  private targetModel = "";
  private bodyId = "";
  private shown = "";
  private placement: ModelPlacement | null = null;
  private bone: THREE.Object3D | null = null;
  private boneName = "";
  private tables = new Map<string, ModelTables | null>();
  private asked = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  private alive = false;
  // three objects borrowed from this entity (scripting imports three as a type only)
  private local!: THREE.Matrix4;
  private world!: THREE.Matrix4;
  private inverse!: THREE.Matrix4;
  private pos!: THREE.Vector3;
  private quat!: THREE.Quaternion;
  private scl!: THREE.Vector3;
  private euler!: THREE.Euler;

  override onStart(): void {
    this.alive = true;
    this.store = sheetStoreOf(this.ctx);
    const id = this.param<string>("creation");
    const asset = id ? this.ctx.getDataAsset?.(id) : undefined;
    this.creation = asset?.type === "creation" ? (asset.data as CharacterCreation) : null;
    if (!this.creation) {
      console.warn(`[character-look] ${this.entityId}: no creation asset "${id}" — set \`creation\``);
      return;
    }
    const self = this.ctx.getEntity(this.entityId);
    this.target = this.param<string>("target") || (self?.components["mesh"] ? this.entityId : self?.parent ?? "");
    const mesh = this.ctx.getEntity(this.target)?.components["mesh"] as { source?: { kind?: string; assetId?: string } } | undefined;
    this.targetModel = mesh?.source?.kind === "asset" ? (mesh.source.assetId ?? "") : "";
    if (!this.targetModel) {
      console.warn(`[character-look] ${this.entityId}: target "${this.target}" draws no model asset`);
      return;
    }
    this.bodyId = this.param<string>("body") || this.ctx.getEntity(this.target)?.parent || "";
    this.local = this.object.matrix.clone();
    this.world = this.object.matrix.clone();
    this.inverse = this.object.matrix.clone();
    this.pos = this.object.position.clone();
    this.quat = this.object.quaternion.clone();
    this.scl = this.object.scale.clone();
    this.euler = this.object.rotation.clone();
    const actor = this.param<string>("actor");
    this.refresh();
    this.unsubscribe = this.store.onChange((key) => {
      if (key === sheetKey(actor)) this.refresh();
    });
  }

  override onDispose(): void {
    this.alive = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** A model's tables, asked for once; the look is recomputed when they arrive. */
  private tablesOf(model: string): ModelTables | null {
    if (!this.asked.has(model) && this.ctx.modelTables) {
      this.asked.add(model);
      void this.ctx.modelTables(model).then(
        (t) => {
          this.tables.set(model, t);
          if (this.alive) this.refresh();
        },
        () => this.tables.set(model, null),
      );
    }
    return this.tables.get(model) ?? null;
  }

  private rulesOf(model: string): PartRules | null {
    const raw = this.tablesOf(model)?.rules;
    if (!raw) return null;
    const parsed = partRulesSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  /** The sheet-less (NPC) look from the params, or null to read the sheet. */
  private fixedLook(): { appearance: Record<string, string>; wear: string[] } | null {
    const appearance = this.param<Record<string, string>>("appearance") ?? {};
    const wear = this.param<string[]>("wear") ?? [];
    return Object.keys(appearance).length > 0 || wear.length > 0 ? { appearance, wear } : null;
  }

  private refresh(): void {
    const creation = this.creation;
    if (!creation || !this.targetModel) return;
    const catalog = catalogOf(this.ctx);
    const items: LookPiece[] = [];
    const fixed = this.fixedLook();
    const sheet = fixed ? null : readSheet(this.store, this.param<string>("actor"));
    const worn = fixed ? fixed.wear : EQUIPMENT_SLOTS.map((slot) => { const uid = sheet?.equipment[slot]; return uid ? (sheet?.items[uid]?.itemId ?? "") : ""; });
    for (const itemId of worn) {
      const appearance = itemId ? catalog(itemId)?.appearance : undefined;
      if (appearance) items.push({ model: appearance.model, parts: appearance.parts, texture: appearance.texture ?? null });
      else if (itemId && fixed) console.warn(`[character-look] ${this.entityId}: worn item "${itemId}" has no appearance`);
    }
    const dressed = dressCharacter({
      creation,
      appearance: fixed ? fixed.appearance : (sheet?.build?.appearance ?? null),
      items,
      rules: (model) => this.rulesOf(model),
      sheets: (model) => {
        const tiles = this.tablesOf(model)?.tiles;
        return tiles ? new Set(tiles) : null;
      },
    });
    const mine = dressed.models.get(this.targetModel);
    const isBody = this.targetModel === dressed.body;
    this.placement = isBody || !mine ? null : mine.mount;
    if (!isBody && !this.placement && mine && mine.parts.length > 0) {
      console.warn(`[character-look] ${this.entityId}: no mount for ${this.targetModel} in the creation asset — add one to \`mounts\``);
    }
    const mirrored = this.param<boolean>("mirror");
    const show = mine && (!mirrored || this.placement?.mirrorTo) ? mine : null;
    const look: ModelLook = {
      parts: show?.parts ?? [],
      groups: show?.groups ?? [],
      skinTint: show?.tint ?? null,
      skinSheets: mine?.skinSheets ?? [],
      ...(mine?.tintWhole ? { tintWhole: true } : {}),
      ...(isBody ? { scale: dressed.scale } : {}),
    };
    const key = JSON.stringify(look);
    if (key === this.shown) return;
    this.shown = key;
    this.ctx.setModelLook?.(this.target, look);
  }

  /** After animation: a socketed model follows its bone as it is this frame. */
  override onLateUpdate(): void {
    const at = this.placement;
    if (!at) return;
    const mirrored = this.param<boolean>("mirror");
    const socket = mirrored ? at.mirrorTo?.socket : at.socket;
    if (!socket) return;
    const target = this.target === this.entityId ? this.object : this.ctx.getObject(this.target);
    const parent = target?.parent;
    if (!target || !parent) return;
    if (!this.bone || this.boneName !== socket || !this.bone.parent) {
      const body = this.ctx.getObject(this.bodyId) ?? parent;
      this.bone = body.getObjectByName(socket) ?? null;
      this.boneName = socket;
      if (!this.bone) return; // the skinned model loads async
      // what a portrait of the body needs to re-seat this piece on ITS clone's bone
      target.userData["characterPiece"] = { entityId: this.target, model: this.targetModel, socket };
    }
    const offset = mirrored ? at.mirrorTo!.offset : at.offset;
    const rot = mirrored ? at.mirrorTo!.rotationDeg : at.rotationDeg;
    const d = Math.PI / 180;
    this.pos.set(offset[0], offset[1], offset[2]);
    this.quat.setFromEuler(this.euler.set(rot[0] * d, rot[1] * d, rot[2] * d));
    // mirrored across the model's own Z: the right-hand copy of a left-hand piece
    this.scl.set(at.scale, at.scale, mirrored ? -at.scale : at.scale);
    this.local.compose(this.pos, this.quat, this.scl);
    this.bone.updateWorldMatrix(true, false);
    this.world.multiplyMatrices(this.bone.matrixWorld, this.local);
    parent.updateWorldMatrix(true, false);
    this.inverse.copy(parent.matrixWorld).invert();
    this.world.premultiply(this.inverse);
    this.world.decompose(target.position, target.quaternion, target.scale);
  }
}
