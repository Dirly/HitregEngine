import { z } from "zod";
import { prefabDocSchema, validatePrefab, PrefabError, type PrefabDoc } from "./prefab.js";
import { materialSchema } from "./components/core.js";

/** Register the engine's built-in data-asset types (currently: material). */
export function registerCoreAssetTypes(assets: AssetLibrary): void {
  assets.defineDataType("material", materialSchema);
}

/**
 * A data asset is a ScriptableObject: a standalone, schema-defined JSON
 * document with a GUID, referenced from components, scripts, and prefab props.
 * Everything holding the same GUID sees edits immediately.
 */
export interface DataAssetDoc {
  id: string;
  /** Data type name, e.g. "weapon-stats" — must be defined before assets of it are added. */
  type: string;
  name: string;
  data: unknown;
}

/** A mesh asset (glTF/GLB). `url` is host-resolved (Vite import, CDN, file path). */
export interface ModelAssetDoc {
  id: string;
  name: string;
  url: string;
}

export class AssetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetError";
  }
}

export class AssetLibrary {
  private prefabs = new Map<string, PrefabDoc>();
  private dataTypes = new Map<string, z.ZodType>();
  private dataAssets = new Map<string, DataAssetDoc>();

  // -- prefabs -------------------------------------------------------------

  addPrefab(id: string, doc: unknown): PrefabDoc {
    if (this.prefabs.has(id)) throw new AssetError(`prefab ${id} already exists`);
    const parsed = prefabDocSchema.safeParse(doc);
    if (!parsed.success) {
      throw new PrefabError(`prefab ${id}: ${z.prettifyError(parsed.error)}`);
    }
    validatePrefab(parsed.data);
    this.prefabs.set(id, parsed.data);
    return parsed.data;
  }

  /** Replace a prefab definition — edits propagate to all instances on next expand. */
  updatePrefab(id: string, doc: unknown): PrefabDoc {
    if (!this.prefabs.has(id)) throw new AssetError(`prefab ${id} does not exist`);
    const parsed = prefabDocSchema.safeParse(doc);
    if (!parsed.success) {
      throw new PrefabError(`prefab ${id}: ${z.prettifyError(parsed.error)}`);
    }
    validatePrefab(parsed.data);
    this.prefabs.set(id, parsed.data);
    return parsed.data;
  }

  getPrefab(id: string): PrefabDoc | undefined {
    return this.prefabs.get(id);
  }

  prefabIds(): string[] {
    return [...this.prefabs.keys()];
  }

  // -- model assets (glTF/GLB files, resolved to URLs by the host app) -------

  private models = new Map<string, ModelAssetDoc>();

  addModel(model: ModelAssetDoc): void {
    if (this.models.has(model.id)) {
      throw new AssetError(`model ${model.id} already exists`);
    }
    this.models.set(model.id, model);
  }

  getModel(id: string): ModelAssetDoc | undefined {
    return this.models.get(id);
  }

  modelIds(): string[] {
    return [...this.models.keys()];
  }

  // -- texture assets (images, resolved to URLs by the host app) -------------

  private textures = new Map<string, ModelAssetDoc>();

  addTexture(texture: ModelAssetDoc): void {
    if (this.textures.has(texture.id)) {
      throw new AssetError(`texture ${texture.id} already exists`);
    }
    this.textures.set(texture.id, texture);
  }

  getTexture(id: string): ModelAssetDoc | undefined {
    return this.textures.get(id);
  }

  textureIds(): string[] {
    return [...this.textures.keys()];
  }

  // -- sound assets (audio files, resolved to URLs by the host app) ----------

  private sounds = new Map<string, ModelAssetDoc>();

  addSound(sound: ModelAssetDoc): void {
    if (this.sounds.has(sound.id)) {
      throw new AssetError(`sound ${sound.id} already exists`);
    }
    this.sounds.set(sound.id, sound);
  }

  getSound(id: string): ModelAssetDoc | undefined {
    return this.sounds.get(id);
  }

  soundIds(): string[] {
    return [...this.sounds.keys()];
  }

  // -- data assets (ScriptableObjects) --------------------------------------

  defineDataType(type: string, schema: z.ZodType): void {
    if (this.dataTypes.has(type)) {
      throw new AssetError(`data type "${type}" is already defined`);
    }
    this.dataTypes.set(type, schema);
  }

  addDataAsset(asset: DataAssetDoc): DataAssetDoc {
    if (this.dataAssets.has(asset.id)) {
      throw new AssetError(`data asset ${asset.id} already exists`);
    }
    return this.putDataAsset(asset);
  }

  /** Replace a data asset — every reference to its GUID sees the new values. */
  updateDataAsset(asset: DataAssetDoc): DataAssetDoc {
    if (!this.dataAssets.has(asset.id)) {
      throw new AssetError(`data asset ${asset.id} does not exist`);
    }
    return this.putDataAsset(asset);
  }

  private putDataAsset(asset: DataAssetDoc): DataAssetDoc {
    const schema = this.dataTypes.get(asset.type);
    if (!schema) throw new AssetError(`unknown data type "${asset.type}"`);
    const parsed = schema.safeParse(asset.data);
    if (!parsed.success) {
      throw new AssetError(
        `data asset ${asset.id} (${asset.type}): ${z.prettifyError(parsed.error)}`,
      );
    }
    const stored: DataAssetDoc = { ...asset, data: parsed.data };
    this.dataAssets.set(asset.id, stored);
    return stored;
  }

  getDataAsset(id: string): DataAssetDoc | undefined {
    return this.dataAssets.get(id);
  }

  dataAssetsOfType(type: string): DataAssetDoc[] {
    return [...this.dataAssets.values()].filter((a) => a.type === type);
  }

  /** JSON Schema per data type — part of the AI's machine-readable spec. */
  dataTypeJsonSchemas(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [type, schema] of this.dataTypes) {
      out[type] = z.toJSONSchema(schema, { io: "input" });
    }
    return out;
  }
}
