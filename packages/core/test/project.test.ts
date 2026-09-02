import { describe, expect, it } from "vitest";
import {
  describeMissingTools,
  projectManifestSchema,
  resolveProjectTools,
  type ProjectManifest,
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
