import { z } from "zod";

/**
 * Game manifest — the versioned CONTRACT between the engine (which writes it on
 * export) and any publishing platform (which validates it on upload). The two
 * are joined by this artifact + a versioned HTTP API, NOT by shared code, so
 * they can evolve independently. Bump `manifestVersion` on breaking changes.
 *
 * A published game bundle is: `manifest.json` + the entry scene + its assets +
 * a self-contained runtime build (index.html + js). The platform reads this
 * manifest to validate, store, index, and serve the game.
 */

/** Runtime the export was built against; the platform checks compat on upload. */
export const RUNTIME_ENGINE = "hitreg";
export const RUNTIME_VERSION = "0.1.0";
export const MANIFEST_VERSION = 1;

export const gameManifestSchema = z.object({
  manifestVersion: z.literal(1),
  game: z.object({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase kebab id")
      .describe("Stable unique id — the URL slug and registry key."),
    name: z.string().min(1).max(120).describe("Human display name."),
    version: z.string().min(1).max(32).describe("Game version (semver-ish)."),
    author: z.string().max(120).optional(),
    description: z.string().max(500).optional(),
  }),
  runtime: z.object({
    engine: z.literal(RUNTIME_ENGINE),
    version: z.string().min(1).describe("Engine runtime version this was built against (compat gate)."),
  }),
  entry: z.object({
    scene: z.string().min(1).describe("Entry scene file, relative to the bundle's assets/scenes/."),
  }),
  multiplayer: z
    .object({
      enabled: z.boolean().default(false),
      min: z.number().int().min(1).max(64).optional(),
      max: z.number().int().min(1).max(64).optional(),
      /** wss:// relay the shipped game dials for signaling; stamped at export. */
      relay: z.string().url().optional(),
    })
    .default({ enabled: false }),
  build: z
    .object({
      hash: z.string().optional().describe("Content hash of the bundle."),
      at: z.string().optional().describe("ISO timestamp of the build."),
    })
    .default({}),
});

export type GameManifest = z.infer<typeof gameManifestSchema>;

/** Validate an unknown value as a manifest (platform upload gate / export self-check). */
export function parseManifest(input: unknown): { ok: true; manifest: GameManifest } | { ok: false; error: string } {
  const r = gameManifestSchema.safeParse(input);
  return r.success ? { ok: true, manifest: r.data } : { ok: false, error: z.prettifyError(r.error) };
}
