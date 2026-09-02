import { describe, expect, it } from "vitest";
import {
  AssetLibrary,
  registerCoreAssetTypes,
} from "../src/index.js";
import {
  DEFAULT_SLOT_UV_SCALE,
  REQUIRED_THEME_SLOTS,
  THEME_SLOTS,
  materialIdFor,
  materialsForTheme,
  registerThemeAssetType,
  themeFromTextureFolder,
  themeSchema,
  uvScaleFor,
  type Theme,
  type ThemeInput,
} from "../src/theme.js";

/** A fully-textured, hand-authored theme (the shape a real location ships). */
const cryptTheme: ThemeInput = {
  name: "The Sunken Crypt",
  description: "Waterlogged worked stone giving way to cave.",
  light: { warm: "#ffb078", cold: "#6ea8ff", accent: "#7fc4ff" },
  slots: {
    floor: { map: "crypt-a/flagstone-floor.png", uvScale: [3, 3] },
    wall: {
      map: "crypt-a/mossy-brick-wall.png",
      normalMap: "crypt-a/mossy-brick-wall-normal.png",
      uvScale: [4, 4],
    },
    ceiling: { map: "crypt-a/vault-ceiling.png", uvScale: [5, 5] },
    trim: { map: "crypt-a/carved-trim.png", uvScale: [2.4, 2.4], color: "#e8e0c8" },
    accent: { map: "crypt-a/rune-glow.png", uvScale: [2, 2] },
    rock: { map: "crypt-a/cave-rock.png", uvScale: [3.5, 3.5], roughness: 1 },
    wood: { map: "crypt-a/oak-planks.png", uvScale: [2, 2] },
    metal: { map: "crypt-a/iron-plate.png", uvScale: [2, 2], metalness: 0.9, roughness: 0.4 },
    step: { map: "crypt-a/flagstone-step.png", uvScale: [1.5, 1.5] },
    water: { color: "#3fa8c9", roughness: 0.05 },
  },
};

describe("themeSchema", () => {
  it("parses a valid theme and fills defaults", () => {
    const parsed = themeSchema.parse(cryptTheme);
    // color defaults in on every slot that omitted it
    expect(parsed.slots.floor.color).toBe("#ffffff");
    expect(parsed.slots.trim.color).toBe("#e8e0c8");
    // optionals stay absent rather than defaulting (material defaults apply downstream)
    expect(parsed.slots.floor.roughness).toBeUndefined();
    expect(parsed.slots.metal.metalness).toBe(0.9);
    expect(parsed.light).toEqual({ warm: "#ffb078", cold: "#6ea8ff", accent: "#7fc4ff" });
  });

  it("REJECTS a slot with map but no uvScale (the counting-stones bug)", () => {
    const bad = structuredClone(cryptTheme) as ThemeInput;
    delete (bad.slots.wall as { uvScale?: unknown }).uvScale;
    const result = themeSchema.safeParse(bad);
    expect(result.success).toBe(false);
    const issue = result.success ? null : result.error.issues[0];
    expect(issue?.path).toEqual(["slots", "wall", "uvScale"]);
    expect(issue?.message).toMatch(/metres per texture tile/i);
  });

  it("requires every slot except water", () => {
    for (const slot of REQUIRED_THEME_SLOTS) {
      const bad = structuredClone(cryptTheme) as ThemeInput;
      delete (bad.slots as Record<string, unknown>)[slot];
      expect(themeSchema.safeParse(bad).success, `missing ${slot} must reject`).toBe(false);
    }
    const dry = structuredClone(cryptTheme) as ThemeInput;
    delete (dry.slots as Record<string, unknown>).water;
    expect(themeSchema.safeParse(dry).success).toBe(true);
  });

  it("validates light colours as hex", () => {
    const bad = structuredClone(cryptTheme) as ThemeInput;
    (bad.light as { warm: string }).warm = "torchlight";
    const result = themeSchema.safeParse(bad);
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.issues[0]!.message).toMatch(/hex color/);
  });

  it("rejects a non-positive uvScale", () => {
    const bad = structuredClone(cryptTheme) as ThemeInput;
    (bad.slots.floor as { uvScale: [number, number] }).uvScale = [0, 3];
    expect(themeSchema.safeParse(bad).success).toBe(false);
  });
});

describe("registerThemeAssetType + AssetLibrary round-trip", () => {
  it("stores a theme as a data asset alongside the core types", () => {
    const assets = new AssetLibrary();
    registerCoreAssetTypes(assets);
    registerThemeAssetType(assets);

    const stored = assets.addDataAsset({
      id: "themes/sunken-crypt",
      type: "theme",
      name: "The Sunken Crypt",
      data: cryptTheme,
    });
    const data = stored.data as Theme;
    expect(data.slots.wall.map).toBe("crypt-a/mossy-brick-wall.png");
    expect(data.slots.floor.color).toBe("#ffffff"); // defaults normalized in

    // invalid theme data is rejected by the library, loudly
    expect(() =>
      assets.addDataAsset({
        id: "themes/broken",
        type: "theme",
        name: "Broken",
        data: { name: "x", slots: { ...cryptTheme.slots, wall: { map: "w.png" } } },
      }),
    ).toThrow(/uvScale/);
  });
});

describe("materialsForTheme", () => {
  const theme = themeSchema.parse(cryptTheme);

  it("produces one doc per populated slot with the specified ids and files", () => {
    const docs = materialsForTheme(theme, "crypt-a");
    expect(docs).toHaveLength(THEME_SLOTS.length); // water populated here
    for (const slot of THEME_SLOTS) {
      const doc = docs.find((d) => d.id === materialIdFor("crypt-a", slot));
      expect(doc, `doc for ${slot}`).toBeDefined();
      expect(doc!.file).toBe(`materials/crypt-a-${slot}.json`);
      // repeat pinned [1,1]: the MESH carries world-UV scale, never the material
      expect(doc!.data.repeat).toEqual([1, 1]);
    }
    const wall = docs.find((d) => d.id === "crypt-a-wall")!;
    expect(wall.data).toEqual({
      shader: "standard",
      color: "#ffffff",
      repeat: [1, 1],
      map: "crypt-a/mossy-brick-wall.png",
      normalMap: "crypt-a/mossy-brick-wall-normal.png",
    });
    const water = docs.find((d) => d.id === "crypt-a-water")!;
    expect(water.data.map).toBeUndefined();
    expect(water.data.color).toBe("#3fa8c9");
    expect(water.data.roughness).toBe(0.05);
  });

  it("skips an absent water slot", () => {
    const dry = structuredClone(cryptTheme) as ThemeInput;
    delete (dry.slots as Record<string, unknown>).water;
    const docs = materialsForTheme(themeSchema.parse(dry), "dry");
    expect(docs).toHaveLength(THEME_SLOTS.length - 1);
    expect(docs.find((d) => d.id === "dry-water")).toBeUndefined();
  });

  it("round-trips every generated doc through the engine material schema", () => {
    const assets = new AssetLibrary();
    registerCoreAssetTypes(assets);
    registerThemeAssetType(assets);
    for (const doc of materialsForTheme(theme, "crypt-a")) {
      const stored = assets.addDataAsset({ id: doc.id, type: "material", name: doc.id, data: doc.data });
      // survives validation with our fields intact (no silent stripping)
      expect(stored.data).toMatchObject(doc.data);
    }
    expect(assets.dataAssetsOfType("material")).toHaveLength(THEME_SLOTS.length);
  });
});

describe("uvScaleFor", () => {
  const theme = themeSchema.parse(cryptTheme);

  it("returns the slot's metres-per-tile for textured slots", () => {
    expect(uvScaleFor(theme, "wall")).toEqual([4, 4]);
    expect(uvScaleFor(theme, "step")).toEqual([1.5, 1.5]);
  });

  it("returns null for a slot without a map (flat colour needs no world UVs)", () => {
    expect(uvScaleFor(theme, "water")).toBeNull();
  });

  it("returns null for an absent slot", () => {
    const dry = structuredClone(cryptTheme) as ThemeInput;
    delete (dry.slots as Record<string, unknown>).water;
    expect(uvScaleFor(themeSchema.parse(dry), "water")).toBeNull();
  });

  it("returns a copy, not a reference into the theme", () => {
    const a = uvScaleFor(theme, "wall")!;
    a[0] = 999;
    expect(uvScaleFor(theme, "wall")).toEqual([4, 4]);
  });
});

describe("themeFromTextureFolder", () => {
  it("maps a realistic image-generator drop to slots and reports junk", () => {
    const files = [
      "dungeon-a/mossy-brick-wall.png",
      "dungeon-a/flagstone-floor.png",
      "dungeon-a/iron-plate.png",
      "dungeon-a/cave-rock.png",
      "dungeon-a/oak-planks.png",
      "dungeon-a/notes.txt",
    ];
    const { theme, report } = themeFromTextureFolder(files, { name: "Dungeon A" });

    expect(report.assigned).toEqual({
      wall: "dungeon-a/mossy-brick-wall.png",
      floor: "dungeon-a/flagstone-floor.png",
      metal: "dungeon-a/iron-plate.png",
      rock: "dungeon-a/cave-rock.png",
      wood: "dungeon-a/oak-planks.png",
    });
    expect(report.unassigned).toEqual(["dungeon-a/notes.txt"]);

    // matched slots carry the texture id (path with extension) + a default uvScale
    expect(theme.slots.wall.map).toBe("dungeon-a/mossy-brick-wall.png");
    expect(theme.slots.wall.uvScale).toEqual([...DEFAULT_SLOT_UV_SCALE.wall]);
    expect(report.guessedUvScale).toContain("wall");
    // unmatched required slots fall back to flat placeholder colour, schema-valid
    expect(theme.slots.ceiling.map).toBeUndefined();
    expect(theme.slots.trim.color).toMatch(/^#[0-9a-f]{6}$/);
    // no water texture, no defaults → slot stays absent
    expect(theme.slots.water).toBeUndefined();
    // whole result is already schema-valid
    expect(themeSchema.safeParse(theme).success).toBe(true);
  });

  it("routes normal maps to the matched slot's normalMap, not its map", () => {
    const { theme, report } = themeFromTextureFolder(
      ["a/brick-wall.png", "a/brick-wall-normal.png", "a/stray-normal.png"],
      { name: "N" },
    );
    expect(theme.slots.wall.map).toBe("a/brick-wall.png");
    expect(theme.slots.wall.normalMap).toBe("a/brick-wall-normal.png");
    // a normal map with no matching base map is not silently dropped
    expect(report.unassigned).toContain("a/stray-normal.png");
  });

  it("first match wins per slot; later duplicates land in unassigned", () => {
    const { theme, report } = themeFromTextureFolder(
      ["a/wall-1.png", "a/wall-2.png"],
      { name: "Dup" },
    );
    expect(theme.slots.wall.map).toBe("a/wall-1.png");
    expect(report.unassigned).toEqual(["a/wall-2.png"]);
  });

  it("applies keyword priority: 'mossy-brick-wall' is wall, 'rune-glow' is accent, 'stair-step' is step", () => {
    const { report } = themeFromTextureFolder(
      ["t/mossy-brick-wall.png", "t/rune-glow.png", "t/stone-stair-step.png", "t/vault-ceiling.png", "t/still-water.png"],
      { name: "P" },
    );
    expect(report.assigned.wall).toBe("t/mossy-brick-wall.png");
    expect(report.assigned.accent).toBe("t/rune-glow.png");
    expect(report.assigned.step).toBe("t/stone-stair-step.png");
    expect(report.assigned.ceiling).toBe("t/vault-ceiling.png");
    expect(report.assigned.water).toBe("t/still-water.png");
  });

  it("opts.defaults overrides matched slots and suppresses the uvScale guess flag", () => {
    const { theme, report } = themeFromTextureFolder(["a/brick-wall.png"], {
      name: "Tuned",
      defaults: { wall: { uvScale: [4.5, 4.5], color: "#d8d0c0" } },
    });
    expect(theme.slots.wall.uvScale).toEqual([4.5, 4.5]);
    expect(theme.slots.wall.color).toBe("#d8d0c0");
    expect(report.guessedUvScale).not.toContain("wall");
  });

  it("is deterministic for identical input", () => {
    const files = ["x/wall.png", "x/floor.png", "x/junk.bin"];
    const a = themeFromTextureFolder(files, { name: "Same" });
    const b = themeFromTextureFolder(files, { name: "Same" });
    expect(a).toEqual(b);
  });
});
