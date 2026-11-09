import { contentTag, rebaseSceneEdits, sceneDocSchema, type ComponentRegistry, type SceneDoc } from "@hitreg/core";

/**
 * Scene autosave that never erases another writer's work (2026-11-03: a dev client autosaved the scene it had booted
 * with and wiped places tools had installed meanwhile).
 *
 * Every write of an existing scene sends `base` = contentTag of the text this client last loaded, merged or wrote. The
 * dev server refuses a stale one (409 `stale`, with the file's current text and tag); the saver then rebases this
 * client's own edits (base -> content) onto that text with rebaseSceneEdits and sends the merge with the new base.
 * When the client had no edits of its own (a re-format of a doc it loaded), nothing is written. 409 `locked` (a tool
 * mid-write) is retried. Saves run one at a time, in order. Headless: the transport is injected.
 */
export interface SceneSave {
  /** Asset path, e.g. `scenes/<id>.scene.json`. */
  file: string;
  /** The doc text this client wants on disk. */
  content: string;
  /** The text this client last knew to be on disk ("" = unknown / new file). */
  base: string;
  project?: string | null;
}

export interface SceneSaveOutcome {
  /** What is on disk now as far as this save knows: `content`, a merge, or the other writer's text unchanged. */
  disk: string | null;
  /** True when the disk text is not `content` (the other writer's edits are in it: adopt them into the open doc). */
  rebased: boolean;
  /** Edits of this client that no longer applied (logged). */
  skipped: string[];
  error?: string;
}

export interface SceneSaverDeps {
  post(body: Record<string, unknown>): Promise<{ status: number; body: any }>;
  registry: ComponentRegistry;
  /** Called after every save (in order). */
  onSaved?(save: SceneSave, outcome: SceneSaveOutcome): void;
  warn?(message: string): void;
  sleep?(ms: number): Promise<void>;
  /** Rebase rounds before giving up (another writer keeps winning). Default 5. */
  maxRebases?: number;
  /** Retries while a tool holds the lock. Default 60 (x lockWaitMs). */
  maxLockWaits?: number;
  lockWaitMs?: number;
}

export interface SceneSaver {
  save(save: SceneSave): Promise<SceneSaveOutcome>;
  /** Resolves when every queued save has finished. */
  idle(): Promise<void>;
}

const parseScene = (text: string): SceneDoc | null => {
  if (!text) return null;
  try {
    const parsed = sceneDocSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

export function createSceneSaver(deps: SceneSaverDeps): SceneSaver {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  let queue: Promise<unknown> = Promise.resolve();

  async function run(req: SceneSave): Promise<SceneSaveOutcome> {
    let content = req.content;
    let base = req.base;
    const skipped: string[] = [];
    let rebases = 0;
    let lockWaits = 0;
    for (;;) {
      const body: Record<string, unknown> = { file: req.file, content, project: req.project ?? undefined };
      if (base) body.base = contentTag(base);
      let reply: { status: number; body: any };
      try {
        reply = await deps.post(body);
      } catch (error) {
        return { disk: null, rebased: false, skipped, error: String(error) };
      }
      if (reply.status === 200) return { disk: content, rebased: content !== req.content, skipped };
      if (reply.status === 409 && reply.body?.locked) {
        if (++lockWaits > (deps.maxLockWaits ?? 60)) return { disk: null, rebased: false, skipped, error: String(reply.body?.error ?? "locked") };
        await sleep(deps.lockWaitMs ?? 500);
        continue;
      }
      if (reply.status === 409 && reply.body?.stale && typeof reply.body.content === "string") {
        const theirsText: string = reply.body.content;
        const theirs = parseScene(theirsText);
        const mine = parseScene(content);
        if (!theirs || !mine) {
          return { disk: null, rebased: false, skipped, error: `${req.file}: ${!theirs ? "the file on disk" : "this save"} is not a valid scene; not overwriting it` };
        }
        if (++rebases > (deps.maxRebases ?? 5)) return { disk: null, rebased: false, skipped, error: `${req.file}: another writer kept changing it; edits kept in the editor, not saved` };
        const result = rebaseSceneEdits(parseScene(base), mine, theirs, deps.registry);
        for (const s of result.skipped) skipped.push(`${s.op.op} ${"id" in s.op ? s.op.id : ""}: ${s.reason}`);
        if (result.applied.length === 0) return { disk: theirsText, rebased: true, skipped }; // nothing of ours missing
        base = theirsText;
        content = JSON.stringify(result.doc, null, 2);
        continue;
      }
      return { disk: null, rebased: false, skipped, error: `${req.file}: save failed (${reply.status}) ${reply.body?.error ?? ""}` };
    }
  }

  return {
    save(req) {
      const done = queue.then(() => run(req)).then((outcome) => {
        if (outcome.error) warn(`[scene-save] ${outcome.error}`);
        if (outcome.skipped.length) warn(`[scene-save] ${req.file}: ${outcome.skipped.length} edit(s) no longer applied after another writer: ${outcome.skipped.join("; ")}`);
        deps.onSaved?.(req, outcome);
        return outcome;
      });
      queue = done.catch(() => undefined);
      return done;
    },
    idle: () => queue.then(() => undefined),
  };
}
