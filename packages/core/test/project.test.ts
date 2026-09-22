import { describe, expect, it } from "vitest";
import {
  addSceneToManifest,
  buildSceneMenu,
  describeMissingTools,
  projectManifestSchema,
  resolveProjectTools,
  sceneMenuProjectOf,
  type ProjectManifest,
  type SceneMenuProjectInput,
} from "../src/project.js";

const manifest = (over: Partial<ProjectManifest> = {}): ProjectManifest =>
  projectManifestSchema.parse({ name: "voxel-demo", ...over });

describe("project manifest", () => {
  it("accepts a minimal manifest and defaults the tool list", () => {
    const parsed = manifest();
    expect(parsed.version).toBe(1);
    expect(parsed.tools).toEqual([]);
  });

  it("rejects a name that could not match a project folder", () => {
    // Asset ids namespace by folder name, so a manifest name that can't BE a
    // folder name is a broken project, not a cosmetic problem.
    for (const name of ["Voxel-Demo", "voxel demo", "1st-game", ""]) {
      expect(projectManifestSchema.safeParse({ name }).success).toBe(false);
    }
  });

  it("rejects a tool id that no registry could ever produce", () => {
    const bad = projectManifestSchema.safeParse({
      name: "voxel-demo",
      tools: [{ id: "Hitreg.WFC" }],
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a duplicate tool dependency", () => {
    const bad = projectManifestSchema.safeParse({
      name: "voxel-demo",
      tools: [{ id: "hitreg.wfc-3d" }, { id: "hitreg.wfc-3d", version: "^2" }],
    });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0]?.message).toContain("duplicate");
  });
});

describe("resolveProjectTools", () => {
  it("is satisfied when nothing is declared", () => {
    const report = resolveProjectTools(manifest(), []);
    expect(report.satisfied).toBe(true);
    expect(describeMissingTools(report)).toBeNull();
  });

  it("splits declared tools into installed, missing and missing-optional", () => {
    const report = resolveProjectTools(
      manifest({
        tools: [
          { id: "hitreg.wfc-3d", optional: false },
          { id: "hitreg.armor-atlas", optional: false },
          { id: "hitreg.texture-intake", optional: true },
        ],
      }),
      ["hitreg.wfc-3d"],
    );
    expect(report.installed.map((t) => t.id)).toEqual(["hitreg.wfc-3d"]);
    expect(report.missing.map((t) => t.id)).toEqual(["hitreg.armor-atlas"]);
    expect(report.missingOptional.map((t) => t.id)).toEqual(["hitreg.texture-intake"]);
  });

  it("an optional tool never makes a project unsatisfied", () => {
    const report = resolveProjectTools(
      manifest({ tools: [{ id: "hitreg.armor-atlas", optional: true }] }),
      [],
    );
    expect(report.satisfied).toBe(true);
    expect(report.missing).toEqual([]);
    // …but it is still reported, or an opt-in tool is invisible until it fails.
    expect(describeMissingTools(report)).toContain("hitreg.armor-atlas");
  });

  it("a required missing tool fails the report and names where to get it", () => {
    const report = resolveProjectTools(
      manifest({
        tools: [
          {
            id: "hitreg.wfc-3d",
            optional: false,
            repo: "https://example.invalid/wfc-3d",
            version: "^1.2",
            reason: "generates the vault layouts",
          },
        ],
      }),
      ["hitreg.armor-atlas"],
    );
    expect(report.satisfied).toBe(false);
    const message = describeMissingTools(report);
    expect(message).toContain("hitreg.wfc-3d@^1.2");
    expect(message).toContain("generates the vault layouts");
    expect(message).toContain("https://example.invalid/wfc-3d");
  });
});

describe("scene menu", () => {
  const input = (over: Partial<SceneMenuProjectInput> & { name: string }): SceneMenuProjectInput => ({
    scenes: [],
    files: [],
    ...over,
  });

  it("rejects a scene listed twice, including as a variant", () => {
    const bad = projectManifestSchema.safeParse({
      name: "voxel-demo",
      scenes: [{ id: "arena" }, { id: "fx-lab", variants: ["arena"] }],
    });
    expect(bad.success).toBe(false);
  });

  it("lists manifest scenes in order, variants under their base, and the rest under other", () => {
    const [group] = buildSceneMenu([
      input({
        name: "faultline-reliquary",
        group: "Dungeons",
        scenes: [
          { id: "faultline-reliquary", label: "Faultline Reliquary", variants: ["faultline-reliquary-blockout"] },
          { id: "gone", variants: [] },
        ],
        files: ["faultline-reliquary-blockout", "scratch", "faultline-reliquary"],
      }),
    ]);
    const project = group!.projects[0]!;
    expect(group!.title).toBe("Dungeons");
    expect(project.main).toBe("faultline-reliquary");
    expect(project.listed).toEqual([
      { id: "faultline-reliquary", label: "Faultline Reliquary", note: undefined, depth: 0 },
      { id: "faultline-reliquary-blockout", label: "blockout", depth: 1 },
    ]);
    // a listed scene with no file is dropped; an unlisted file is never hidden
    expect(project.other.map((s) => s.id)).toEqual(["scratch"]);
  });

  it("labels a variant by what it adds past its shared prefix, and a project by its title", () => {
    const [group] = buildSceneMenu([
      input({
        name: "dc-carved-library",
        title: "Carved library",
        scenes: [{ id: "diag-hard", variants: ["diag-blend", "other-thing"] }],
        files: ["diag-hard", "diag-blend", "other-thing"],
      }),
    ]);
    const project = group!.projects[0]!;
    expect(project.label).toBe("Carved library");
    expect(project.listed.map((s) => s.label)).toEqual(["diag-hard", "blend", "other-thing"]);
  });

  it("orders groups by menuOrder, ungrouped and loose files last, and skips empty projects", () => {
    const menu = buildSceneMenu(
      [
        input({ name: "hollow-bastion", group: "DC reference", menuOrder: 30, files: ["x"] }),
        input({ name: "voxel-demo", group: "MMO", menuOrder: 10, files: ["mmo"] }),
        input({ name: "stray", files: ["s"] }),
        input({ name: "empty", group: "MMO", menuOrder: 0 }),
      ],
      ["atlas-carousel"],
    );
    expect(menu.map((g) => g.title)).toEqual(["MMO", "DC reference", null]);
    expect(menu[2]!.projects.map((p) => p.name)).toEqual(["stray", null]);
    expect(sceneMenuProjectOf(menu, "atlas-carousel")?.name).toBeNull();
    expect(sceneMenuProjectOf(menu, "mmo")?.name).toBe("voxel-demo");
    expect(sceneMenuProjectOf(menu, "nope")).toBeNull();
  });
});

describe("adding a scene to the menu", () => {
  const raw = () => ({
    name: "voxel-demo",
    multiplayer: "server",
    scenes: [{ id: "mmo", label: "MMO world" }, { id: "keep", variants: ["keep-blockout"] }],
  });

  it("appends an own entry and leaves the authored fields as written", () => {
    const next = addSceneToManifest(raw(), { id: "boss-lab", label: "Boss lab", note: "Boss fights." });
    expect(next.multiplayer).toBe("server");
    expect(next).not.toHaveProperty("tools"); // no parse defaults written back
    expect((next.scenes as unknown[]).at(-1)).toEqual({ id: "boss-lab", label: "Boss lab", note: "Boss fights." });
  });

  it("adds a variant under its base, and lists an unlisted base with it", () => {
    const under = addSceneToManifest(raw(), { id: "keep-undercoat", variantOf: "keep", label: "ignored" });
    expect((under.scenes as Array<{ variants?: string[] }>)[1]!.variants).toEqual(["keep-blockout", "keep-undercoat"]);
    const fresh = addSceneToManifest({ name: "voxel-demo" }, { id: "arena-night", variantOf: "arena" });
    expect(fresh.scenes).toEqual([{ id: "arena", variants: ["arena-night"] }]);
  });

  it("refuses a scene already listed, a variant of a variant, and a bad id", () => {
    expect(() => addSceneToManifest(raw(), { id: "keep-blockout" })).toThrow(/already/);
    expect(() => addSceneToManifest(raw(), { id: "x", variantOf: "keep-blockout" })).toThrow(/itself a variant/);
    expect(() => addSceneToManifest(raw(), { id: "Boss Lab" })).toThrow();
  });
});
