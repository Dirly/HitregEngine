/**
 * Declare that an agent is working in a scene, so the owner's editor warns him (tools/_agent-activity.mts).
 *   npx tsx tools/agent-activity.mts start --scene <name> [--agent <name>] [--what "<doing>"] [--ttl <sec, default 600>]
 *   npx tsx tools/agent-activity.mts beat  --scene <name> [--agent <name>] [--what ...] [--ttl ...]   (same as start)
 *   npx tsx tools/agent-activity.mts done  --scene <name> [--agent <name>]
 *   npx tsx tools/agent-activity.mts list  --scene <name>
 * The warning lapses by itself `--ttl` seconds after the last start/beat (a crashed agent never leaves it up).
 */
import { activeAgents, declareActivity, endActivity } from "./_agent-activity.mts";

const [cmd] = process.argv.slice(2);
const arg = (k: string): string | undefined => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const scene = arg("scene");
if (!scene || !["start", "beat", "done", "list"].includes(cmd ?? "")) {
  console.error("usage: agent-activity.mts start|beat|done|list --scene <name> [--agent <name>] [--what <text>] [--ttl <sec>]");
  process.exit(1);
}
if (cmd === "done") endActivity(scene, arg("agent"));
else if (cmd === "list") console.log(JSON.stringify(activeAgents(scene), null, 1));
else {
  declareActivity({ scene, agent: arg("agent"), what: arg("what"), ttlMs: Number(arg("ttl") ?? 600) * 1000, session: true });
  console.log(`agent-activity: working in ${scene} for ${arg("ttl") ?? 600} s (re-run start/beat to extend, done to clear)`);
}
