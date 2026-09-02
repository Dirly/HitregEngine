import { z } from "zod";
import { toolIdSchema } from "./tools.js";

/**
 * A project's manifest — the one tracked file that says what a game IS and
 * what it needs from outside itself.
 *
 * A project (a game, a demo) is its own git repo, checked out into an engine
 * working copy at `apps/playground/projects/<name>/`. The engine repo never
 * tracks it. That separation is the point — an engine stays an engine — but it
 * creates one real problem: a project can silently depend on a tool that
 * whoever clones it does not have installed, and the failure shows up much
 * later as a generator that "doesn't work" or an asset that never regenerates.
 *
 * `project.json` is the fix. It is declarative and validated, so a missing
 * dependency is reported at boot, by id, with the repo to get it from —
 * instead of being discovered by a person debugging a tool that was never
 * there.
 *
 * The manifest deliberately does NOT install anything. Tools are trusted code
 * that runs in the host (see docs/tools.md), so fetching one is a decision a
 * human makes, not a side effect of opening a project.
 */

const projectName = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]*$/,
    "use a lowercase kebab-case name matching the project folder (for example voxel-demo)",
  )
  .describe("Project id. Must match the folder name under projects/, since asset ids namespace by it.");

/**
 * One tool this project needs. `id` is what matters — it is the id the tool
 * registers under, so it can be checked against what is actually installed.
 * `repo` and `version` are guidance for the human who has to go get it; the
 * engine never fetches on its own.
 */
export const projectToolDependencySchema = z.object({
  id: toolIdSchema.describe("Registered tool id, e.g. hitreg.wfc-3d."),
  repo: z
    .string()
    .min(1)
    .optional()
    .describe("Where to get it — a git URL or other clone/install source. Shown when it is missing."),
  version: z
    .string()
    .min(1)
    .optional()
    .describe("Version or range the project was built against. Advisory: nothing enforces it yet."),
  optional: z
    .boolean()
    .default(false)
    .describe("True if the project still runs without it (the tool only regenerates content)."),
  reason: z
    .string()
    .min(1)
    .optional()
    .describe("What this project uses it for. Worth writing: it is what tells a reader whether they need it."),
});

export const projectManifestSchema = z
  .object({
    version: z.literal(1).default(1),
    name: projectName,
    description: z.string().min(1).optional(),
    engine: z
      .string()
      .min(1)
      .optional()
      .describe("Engine version or range this project was built against. Advisory."),
    tools: z
      .array(projectToolDependencySchema)
      .default([])
      .describe("Registered tools this project needs installed under the engine's tools/ folder."),
  })
  .superRefine((manifest, ctx) => {
    const seen = new Set<string>();
    for (const [index, tool] of manifest.tools.entries()) {
      if (seen.has(tool.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["tools", index, "id"],
          message: `duplicate tool dependency "${tool.id}"`,
        });
      }
      seen.add(tool.id);
    }
  });

export type ProjectToolDependency = z.infer<typeof projectToolDependencySchema>;
export type ProjectManifest = z.infer<typeof projectManifestSchema>;

export interface ProjectToolStatus extends ProjectToolDependency {
  installed: boolean;
}

export interface ProjectToolReport {
  project: string;
  /** True when every REQUIRED dependency is installed. Optional ones never block. */
  satisfied: boolean;
  installed: ProjectToolStatus[];
  /** Required and not installed — this is what makes `satisfied` false. */
  missing: ProjectToolStatus[];
  /** Declared optional and not installed — worth saying once, never an error. */
  missingOptional: ProjectToolStatus[];
}

/**
 * Compare a project's declared tool dependencies against what the host has
 * actually registered. Pure — the caller supplies the installed ids, so this
 * works in the dev server, in a CI check, or in a test.
 */
export function resolveProjectTools(
  manifest: ProjectManifest,
  installedIds: Iterable<string>,
): ProjectToolReport {
  const installedSet = new Set(installedIds);
  const report: ProjectToolReport = {
    project: manifest.name,
    satisfied: true,
    installed: [],
    missing: [],
    missingOptional: [],
  };
  for (const tool of manifest.tools) {
    const status: ProjectToolStatus = { ...tool, installed: installedSet.has(tool.id) };
    if (status.installed) report.installed.push(status);
    else if (status.optional) report.missingOptional.push(status);
    else {
      report.missing.push(status);
      report.satisfied = false;
    }
  }
  return report;
}

/**
 * Render a report as the warning a human should see, or null when there is
 * nothing to say. Kept here rather than in the dev server so the same wording
 * reaches a CLI check later — a dependency message that differs by surface is
 * how people learn to ignore one of them.
 */
export function describeMissingTools(report: ProjectToolReport): string | null {
  const lines: string[] = [];
  const line = (tool: ProjectToolStatus): string => {
    const where = tool.repo ? ` — install from ${tool.repo}` : "";
    const why = tool.reason ? ` (${tool.reason})` : "";
    return `  ${tool.id}${tool.version ? `@${tool.version}` : ""}${why}${where}`;
  };
  if (report.missing.length > 0) {
    lines.push(
      `project "${report.project}" declares ${report.missing.length} tool ` +
        `${report.missing.length === 1 ? "dependency" : "dependencies"} that ${report.missing.length === 1 ? "is" : "are"} not installed:`,
      ...report.missing.map(line),
    );
  }
  if (report.missingOptional.length > 0) {
    lines.push(
      `project "${report.project}" optional tools not installed:`,
      ...report.missingOptional.map(line),
    );
  }
  if (lines.length === 0) return null;
  lines.push(`  Clone each into the engine's tools/ folder; see docs/tools.md.`);
  return lines.join("\n");
}
