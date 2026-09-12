// Image bridge: an agent that cannot generate images (a Claude session) asks one that can (Codex, or Derek)
// through the filesystem. Requests are JSON files under apps/playground/.hitreg/image-requests/ (gitignored);
// the fulfilling side writes the PNG to `target`, then sets status "done" on the request. Nothing here draws.
//
//   node tools/image-request.mjs new --id plan --target projects/x/references/plan.png --size 1024x1280 \
//        --purpose "top-down plan reference" --prompt-file prompt.txt        # or --prompt "…"
//   node tools/image-request.mjs wait --id plan --timeout 900                  # blocks until done/failed
//   node tools/image-request.mjs list                                          # pending / done / failed
//   node tools/image-request.mjs done --id plan [--note "…"]                   # fulfiller: marks done after writing target
//   node tools/image-request.mjs fail --id plan --note "…"
//
// Prompts stay in the request file (under .hitreg/, never in a project); the fulfiller copies nothing but the image.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, ".hitreg", "image-requests");
fs.mkdirSync(dir, { recursive: true });
const [cmd, ...rest] = process.argv.slice(2);
const opt = (k, d) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : d; };
const file = (id) => path.join(dir, `${id}.json`);
const read = (id) => JSON.parse(fs.readFileSync(file(id), "utf8"));
const write = (id, v) => fs.writeFileSync(file(id), JSON.stringify(v, null, 2));
const usage = () => { console.error("usage: image-request.mjs new|wait|list|done|fail …"); process.exit(2); };

if (cmd === "new") {
  const id = opt("id"); const target = opt("target"); if (!id || !target) usage();
  const prompt = opt("prompt") ?? (opt("prompt-file") ? fs.readFileSync(opt("prompt-file"), "utf8") : null);
  if (!prompt) usage();
  if (fs.existsSync(file(id)) && read(id).status !== "failed") { console.error(`request ${id} already exists (${read(id).status})`); process.exit(1); }
  write(id, { id, status: "pending", createdAt: new Date().toISOString(), requester: opt("requester", "claude"), purpose: opt("purpose", ""), size: opt("size", "1024x1024"), target: path.resolve(root, target), prompt, notes: "" });
  console.log(JSON.stringify({ id, file: file(id), target: path.resolve(root, target) }));
} else if (cmd === "wait") {
  const id = opt("id"); if (!id) usage(); const timeout = Number(opt("timeout", 900)) * 1000; const t0 = Date.now();
  for (;;) {
    const r = fs.existsSync(file(id)) ? read(id) : null;
    if (r?.status === "done" && fs.existsSync(r.target)) { console.log(JSON.stringify({ id, status: "done", target: r.target, bytes: fs.statSync(r.target).size })); process.exit(0); }
    if (r?.status === "failed") { console.log(JSON.stringify({ id, status: "failed", notes: r.notes })); process.exit(1); }
    if (Date.now() - t0 > timeout) { console.log(JSON.stringify({ id, status: r?.status ?? "missing", timedOut: true })); process.exit(3); }
    await new Promise((r) => setTimeout(r, 2000));
  }
} else if (cmd === "list") {
  const rows = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => { const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); return { id: r.id, status: r.status, size: r.size, target: r.target, purpose: r.purpose }; });
  console.log(JSON.stringify(rows, null, 2));
} else if (cmd === "done" || cmd === "fail") {
  const id = opt("id"); if (!id || !fs.existsSync(file(id))) usage(); const r = read(id);
  if (cmd === "done" && !fs.existsSync(r.target)) { console.error(`target missing: ${r.target}`); process.exit(1); }
  write(id, { ...r, status: cmd === "done" ? "done" : "failed", finishedAt: new Date().toISOString(), fulfiller: opt("by", "codex"), notes: opt("note", r.notes) });
  console.log(JSON.stringify({ id, status: cmd === "done" ? "done" : "failed" }));
} else usage();
