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

const sceneId = z
  .string()
  .min(1)
  .describe(
    "Scene file id: the path under assets/scenes/ without .scene.json (e.g. \"arena\", \"hollow-bastion/deepwake\"). " +
      "The file is the scene's identity; the doc's own `name` field is not.",
  );

/**
 * One row of the editor's scene menu. The order of `scenes` is the order of
 * the menu, and the first entry is the project's main scene.
 */
export const projectSceneEntrySchema = z.object({
  id: sceneId,
  label: z
    .string()
    .min(1)
    .optional()
    .describe("What the menu shows instead of the id, e.g. \"Combat lab\" for arena."),
  note: z
    .string()
    .min(1)
    .optional()
    .describe("One line on what the scene is for; shown as the menu tooltip."),
  variants: z
    .array(sceneId)
    .default([])
    .describe(
      "Pipeline stages or alternates of this scene (blockout, undercoat, editable, …). They list under it instead " +
        "of as separate scenes; the menu labels each by what its id adds to the base id.",
    ),
});

export const projectManifestSchema = z
  .object({
    version: z.literal(1).default(1),
    name: projectName,
    description: z.string().min(1).optional(),
    title: z
      .string()
      .min(1)
      .optional()
      .describe("Display name in the editor's project picker (e.g. \"MMO\"); the folder name when unset."),
    group: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Editor project-picker group, e.g. \"MMO\", \"Dungeons\", \"DC reference\". Projects sharing a group list " +
          "together; ungrouped projects list last.",
      ),
    menuOrder: z
      .number()
      .int()
      .optional()
      .describe(
        "Sort key in the project picker, lower first. A group sorts by its lowest member; unset sorts after set, " +
          "then by name.",
      ),
    scenes: z
      .array(projectSceneEntrySchema)
      .default([])
      .describe(
        "The editor's scene menu for this project, in order; the first entry is the main scene. Scene files on disk " +
          "that no entry names still appear, under \"other\", so a new scene is never hidden.",
      ),
    engine: z
      .string()
      .min(1)
      .optional()
      .describe("Engine version or range this project was built against. Advisory."),
    multiplayer: z
      .enum(["p2p", "server"])
      .default("p2p")
      .describe(
        "How this game is played together. \"p2p\": the engine's peer rooms (a tab hosts; fine for co-op, prototypes, " +
          "anything where a host cheating costs nobody). \"server\": dedicated/layered servers ONLY — the playground " +
          "never forms a peer room for this project's scenes (a tab with no server plays alone), because a peer host " +
          "is authoritative over everything it simulates. An MMO with a persistent world declares \"server\".",
      ),
    devConsole: z
      .enum(["dev", "always", "never"])
      .default("dev")
      .describe(
        "Whether a PUBLISHED build of this game contains the developer console (/time, /weather, whatever its " +
          "scripts declare). \"dev\": the editor has it, published bundles do not — the console module is not " +
          "compiled in at all, so there is nothing for a player to find. \"always\": ship it (an internal build, " +
          "a playtest bundle you want to drive from the chat box). \"never\": not even in the editor, for a game " +
          "whose own scripts must not be pokeable. tools/publish.mjs reads this; --console / --no-console " +
          "override it for one build.",
      ),
    tools: z
      .array(projectToolDependencySchema)
      .default([])
      .describe("Registered tools this project needs installed under the engine's tools/ folder."),
  })
  .superRefine((manifest, ctx) => {
    const listed = new Set<string>();
    for (const [index, entry] of manifest.scenes.entries()) {
      for (const [at, id] of [[null, entry.id] as const, ...entry.variants.map((v, i) => [i, v] as const)]) {
        if (listed.has(id)) {
          ctx.addIssue({
            code: "custom",
            path: at === null ? ["scenes", index, "id"] : ["scenes", index, "variants", at],
            message: `scene "${id}" is listed twice`,
          });
        }
        listed.add(id);
      }
    }
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

export type ProjectSceneEntry = z.infer<typeof projectSceneEntrySchema>;

/** What the scene menu needs to know about one project. */
export interface SceneMenuProjectInput {
  name: string;
  title?: string;
  description?: string;
  group?: string;
  menuOrder?: number;
  /** The manifest's `scenes` list (empty for a project with no project.json). */
  scenes: ProjectSceneEntry[];
  /** Scene ids actually on disk under the project's assets/scenes/. */
  files: string[];
}

export interface SceneMenuItem {
  id: string;
  label: string;
  note?: string;
  /** 1 for a variant listed under its base scene. */
  depth: 0 | 1;
}

export interface SceneMenuProject {
  /** Project folder name; null for the flat assets/ tree. */
  name: string | null;
  label: string;
  description?: string;
  /** The first listed scene that exists, else the first file. */
  main: string;
  /** Listed scenes in manifest order, variants under their base. */
  listed: SceneMenuItem[];
  /** Files no entry names, by id. */
  other: SceneMenuItem[];
}

export interface SceneMenuGroup {
  /** null for projects that declare no group (and the flat tree). */
  title: string | null;
  projects: SceneMenuProject[];
}

/**
 * Organise every scene file into the editor's two-level menu: project groups →
 * projects → scenes. Pure, so the dev server, the editor and a test all agree.
 *
 * A listed scene whose file is gone is dropped rather than shown dead. A file
 * nothing lists goes under `other` — hiding a scene an agent just wrote would
 * be worse than an untidy menu. Projects with no scene files are left out.
 */
export function buildSceneMenu(
  projects: SceneMenuProjectInput[],
  looseScenes: string[] = [],
): SceneMenuGroup[] {
  // what a variant id adds past what it shares with its base, cut back to a
  // word boundary: faultline-reliquary-blockout → "blockout",
  // dc-projection-diagnostic-blend under …-hard → "blend"
  const variantLabel = (base: string, id: string): string => {
    let shared = 0;
    while (shared < base.length && shared < id.length && base[shared] === id[shared]) shared++;
    if (shared < base.length) shared = Math.max(0, ...[..."-_/. "].map((c) => base.lastIndexOf(c, shared - 1) + 1));
    const tail = id.slice(shared).replace(/^[-_/.\s]+/, "");
    return tail || id;
  };
  const byId = (a: SceneMenuItem, b: SceneMenuItem) => a.id.localeCompare(b.id);
  const menuProjects: Array<SceneMenuProject & { group: string | null; order: number | undefined }> = [];

  for (const project of projects) {
    const files = new Set(project.files);
    if (files.size === 0) continue;
    const listed: SceneMenuItem[] = [];
    const named = new Set<string>();
    for (const entry of project.scenes) {
      for (const id of [entry.id, ...entry.variants]) named.add(id);
      const variants = entry.variants.filter((id) => files.has(id));
      if (files.has(entry.id)) {
        listed.push({ id: entry.id, label: entry.label ?? entry.id, note: entry.note, depth: 0 });
        for (const id of variants) listed.push({ id, label: variantLabel(entry.id, id), depth: 1 });
      } else {
        // base file gone: its surviving variants stand on their own
        for (const id of variants) listed.push({ id, label: id, depth: 0 });
      }
    }
    const other = [...files]
      .filter((id) => !named.has(id))
      .map((id): SceneMenuItem => ({ id, label: id, depth: 0 }))
      .sort(byId);
    menuProjects.push({
      name: project.name,
      label: project.title ?? project.name,
      description: project.description,
      main: listed[0]?.id ?? other[0]!.id,
      listed,
      other,
      group: project.group ?? null,
      order: project.menuOrder,
    });
  }

  const byOrder = (a: number | undefined, b: number | undefined): number =>
    a === b ? 0 : a === undefined ? 1 : b === undefined ? -1 : a - b;
  menuProjects.sort((a, b) => byOrder(a.order, b.order) || a.label.localeCompare(b.label));

  const groups = new Map<string | null, SceneMenuGroup & { order: number | undefined }>();
  for (const { group, order, ...project } of menuProjects) {
    let bucket = groups.get(group);
    if (!bucket) groups.set(group, (bucket = { title: group, projects: [], order }));
    bucket.projects.push(project);
  }
  const sorted = [...groups.values()].sort(
    (a, b) =>
      (a.title === null ? 1 : 0) - (b.title === null ? 1 : 0) ||
      byOrder(a.order, b.order) ||
      (a.title ?? "").localeCompare(b.title ?? ""),
  );

  if (looseScenes.length > 0) {
    const other = [...new Set(looseScenes)].map((id): SceneMenuItem => ({ id, label: id, depth: 0 })).sort(byId);
    const loose: SceneMenuProject = { name: null, label: "assets/ (loose)", main: other[0]!.id, listed: [], other };
    const ungrouped = sorted.find((g) => g.title === null);
    if (ungrouped) ungrouped.projects.push(loose);
    else sorted.push({ title: null, projects: [loose], order: undefined });
  }
  return sorted.map(({ title, projects: list }) => ({ title, projects: list }));
}

/** The project a scene belongs to in a built menu, or null if no menu row names it. */
export function sceneMenuProjectOf(menu: SceneMenuGroup[], sceneId: string): SceneMenuProject | null {
  for (const group of menu) {
    for (const project of group.projects) {
      if (project.listed.some((s) => s.id === sceneId) || project.other.some((s) => s.id === sceneId)) {
        return project;
      }
    }
  }
  return null;
}

/** A new row for a project's scene menu: what the editor's "New scene" dialog sends. */
export const newSceneMenuEntrySchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, "use a lowercase kebab-case scene id (letters, digits, dashes)")
    .describe("Scene file id; the file is assets/scenes/<id>.scene.json in the project."),
  label: z.string().min(1).optional().describe("Menu label for an own entry. Ignored for a variant."),
  note: z.string().min(1).optional().describe("One-line menu tooltip for an own entry. Ignored for a variant."),
  variantOf: z
    .string()
    .min(1)
    .optional()
    .describe("List the scene as a variant (pipeline stage) of this scene id instead of as its own entry."),
});

export type NewSceneMenuEntry = z.infer<typeof newSceneMenuEntrySchema>;

/**
 * Add one scene to a project.json's menu and return the updated manifest.
 *
 * Works on the RAW manifest object so the fields a person wrote keep their
 * authored form (parsing would add every default). A variant of a scene the
 * menu doesn't list yet lists that base too, so the new variant has somewhere
 * to hang. Throws on a scene already listed, or a result the schema rejects.
 */
export function addSceneToManifest(
  raw: Record<string, unknown>,
  entry: NewSceneMenuEntry,
): Record<string, unknown> {
  const request = newSceneMenuEntrySchema.parse(entry);
  const scenes = (Array.isArray(raw.scenes) ? structuredClone(raw.scenes) : []) as Array<{
    id: string;
    label?: string;
    note?: string;
    variants?: string[];
  }>;
  const listed = scenes.flatMap((s) => [s.id, ...(s.variants ?? [])]);
  if (listed.includes(request.id)) throw new Error(`scene "${request.id}" is already in the menu`);

  if (request.variantOf) {
    const base = scenes.find((s) => s.id === request.variantOf);
    if (base) base.variants = [...(base.variants ?? []), request.id];
    else if (listed.includes(request.variantOf)) {
      throw new Error(`"${request.variantOf}" is itself a variant; add the new scene under its base scene`);
    } else scenes.push({ id: request.variantOf, variants: [request.id] });
  } else {
    scenes.push({
      id: request.id,
      ...(request.label ? { label: request.label } : {}),
      ...(request.note ? { note: request.note } : {}),
    });
  }

  const next = { ...raw, scenes };
  const checked = projectManifestSchema.safeParse(next);
  if (!checked.success) {
    throw new Error(
      `project.json would be invalid: ${checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return next;
}
