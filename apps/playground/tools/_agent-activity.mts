/**
 * AGENT ACTIVITY — "an active agent working in that scene should cause a warning" (owner, 2026-11-11).
 *
 * An agent working in a scene leaves a HEARTBEAT file, `.hitreg/agent-activity/<scene>--<agent>[--<pid>].json`
 * ({ scene, agent, what, since, beat, expires }); the dev server's GET /__hitreg/agent-activity?scene= returns the live
 * ones (not past `expires`, so a crashed agent's warning lapses by itself) plus the scene file's lock when a tool holds
 * it, and the editor shows a warning for that scene. It never blocks the owner: a warning, not a lock.
 *
 *  - `syncScene` / `editScene` (tools/_scene-sync.mts) declare themselves for as long as they run (file per pid);
 *  - an agent working longer (reading notes, rebuilding in several steps) declares the session:
 *      npx tsx tools/agent-activity.mts start --scene <name> [--agent <name>] [--what "<doing>"] [--ttl <sec>]
 *    re-run `start` (or `beat`) within the ttl to keep it up; `done` takes it down.
 * Node only (fs). The folder is `HITREG_ACTIVITY_DIR` when set (tests).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lockIsStale, writeAtomic } from "./_scene-write.mts";

export interface Activity {
  scene: string;
  agent: string;
  what: string;
  since: string;
  beat: string;
  expires: string;
  pid: number;
  host: string;
  /** "declared" (a heartbeat file) or "lock" (a tool holds the scene file's lock right now). */
  source?: "declared" | "lock";
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const activityDir = (): string => process.env["HITREG_ACTIVITY_DIR"] ?? path.resolve(HERE, "..", ".hitreg", "agent-activity");
const seg = (s: string): string => s.replace(/[^a-zA-Z0-9._-]+/g, "_");
const fileOf = (scene: string, agent: string, pid?: number): string => path.join(activityDir(), `${seg(scene)}--${seg(agent)}${pid ? `--${pid}` : ""}.json`);
const defaultAgent = (): string => process.env["HITREG_AGENT"] ?? "agent";

/**
 * Declare an agent working in `scene` until `done()` (or `ttlMs` after the last `beat()`). `session: true` = one file
 * per agent and scene (the CLI's long session); otherwise one per process (a tool run).
 */
export function declareActivity(o: { scene: string; agent?: string; what?: string; ttlMs?: number; session?: boolean }): { beat(): void; done(): void } {
  const agent = o.agent ?? defaultAgent(), ttl = o.ttlMs ?? 600_000;
  const file = fileOf(o.scene, agent, o.session ? undefined : process.pid);
  let since = new Date().toISOString();
  if (o.session && fs.existsSync(file)) try { since = (JSON.parse(fs.readFileSync(file, "utf8")) as Activity).since ?? since; } catch { /* rewritten below */ }
  const beat = (): void => {
    const now = Date.now();
    const a: Activity = { scene: o.scene, agent, what: o.what ?? "", since, beat: new Date(now).toISOString(), expires: new Date(now + ttl).toISOString(), pid: process.pid, host: os.hostname() };
    try { writeAtomic(file, JSON.stringify(a) + "\n"); } catch { /* a warning is best-effort: never fail the work over it */ }
  };
  beat();
  return { beat, done: () => { try { fs.rmSync(file, { force: true }); } catch { /* gone */ } } };
}

/** Take down an agent's session declaration for a scene (the CLI's `done`). */
export function endActivity(scene: string, agent = defaultAgent()): void {
  fs.rmSync(fileOf(scene, agent), { force: true });
}

/**
 * The agents working in `scene` now: unexpired heartbeats (expired ones are deleted), and a tool holding the scene
 * file's lock (`sceneFile` given; the dev server's own save is not an agent).
 */
export function activeAgents(scene: string, sceneFile?: string | null, now = Date.now()): Activity[] {
  const out: Activity[] = [];
  const dir = activityDir();
  const prefix = `${seg(scene)}--`;
  if (fs.existsSync(dir))
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith(prefix) || !f.endsWith(".json")) continue;
      const full = path.join(dir, f);
      try {
        const a = JSON.parse(fs.readFileSync(full, "utf8")) as Activity;
        if (a.scene !== scene) continue;
        if (Date.parse(a.expires) <= now) { fs.rmSync(full, { force: true }); continue; }
        out.push({ ...a, source: "declared" });
      } catch { /* mid-write: next poll */ }
    }
  if (sceneFile) {
    const lf = path.resolve(sceneFile) + ".lock";
    try {
      const info = JSON.parse(fs.readFileSync(lf, "utf8")) as { pid: number; host: string; label: string; at: string };
      if (!/dev-server/.test(info.label ?? "") && !lockIsStale(info, now) && !out.some((a) => a.pid === info.pid))
        out.push({ scene, agent: info.label ?? "a tool", what: "writing the scene file", since: info.at, beat: info.at, expires: "", pid: info.pid, host: info.host, source: "lock" });
    } catch { /* no lock */ }
  }
  return out;
}
