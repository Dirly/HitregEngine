// Image bridge: gets pictures made for agents that cannot draw them.
//
// Two modes, one queue and the same provenance records:
//   gen / gen-set  — drive `codex exec` directly and block until the PNG is on disk (preferred; no human needed)
//   new / wait     — queue a request for a separate fulfiller (another Codex session, or Derek) to pick up
//
// Requests are JSON files under apps/playground/.hitreg/image-requests/ (gitignored); the fulfilling side writes
// the PNG to `target`, then sets status "done". Prompts live in the request file, never in a project folder.
//
//   node tools/image-request.mjs gen --id flagstone --target projects/x/assets/textures/flagstone.png \
//        --size 512x512 --prompt-file prompt.txt [--ref existing.png] [--alpha] [--timeout 600] [--force]
//   node tools/image-request.mjs gen-set --manifest set.json [--timeout 1800]   # N images in ONE codex session
//   node tools/image-request.mjs new --id plan --target … --size 1024x1280 --prompt "…"   # queue only
//   node tools/image-request.mjs wait --id plan --timeout 900                   # blocks until done/failed
//   node tools/image-request.mjs list | done --id … | fail --id … --note "…"
//
// gen stages into .hitreg/image-staging/ and installs only the verified PNG, so stray notes files the generator
// emits alongside the image never land in a project folder.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, ".hitreg", "image-requests");
const stageRoot = path.join(root, ".hitreg", "image-staging");
fs.mkdirSync(dir, { recursive: true });
const [cmd, ...rest] = process.argv.slice(2);
const opt = (k, d) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : d; };
const flag = (k) => rest.includes(`--${k}`);
const opts = (k) => rest.reduce((a, v, i) => (rest[i - 1] === `--${k}` ? [...a, v] : a), []);
const file = (id) => path.join(dir, `${id}.json`);
const read = (id) => JSON.parse(fs.readFileSync(file(id), "utf8"));
const write = (id, v) => fs.writeFileSync(file(id), JSON.stringify(v, null, 2));
const usage = () => { console.error("usage: image-request.mjs gen|gen-set|new|wait|list|done|fail …"); process.exit(2); };

// PNG signature + IHDR only: width, height, colour type. No decoding, no deps.
function pngInfo(f) {
  const b = Buffer.alloc(26);
  const fd = fs.openSync(f, "r");
  try { fs.readSync(fd, b, 0, 26, 0); } finally { fs.closeSync(fd); }
  if (b.toString("latin1", 0, 8) !== "\x89PNG\r\n\x1a\n") return null;
  const colorType = b[25];
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), colorType, alpha: colorType === 4 || colorType === 6 };
}

// Verify a produced PNG against what was asked for. Returns an error string, or null when good.
function checkPng(f, { size, alpha }) {
  if (!fs.existsSync(f)) return "not written";
  const info = pngInfo(f);
  if (!info) return "not a PNG";
  if (size) {
    const [w, h] = String(size).toLowerCase().split("x").map(Number);
    if (info.w !== w || info.h !== h) return `wrong size ${info.w}x${info.h}, wanted ${w}x${h}`;
  }
  if (alpha && !info.alpha) return `no alpha channel (PNG colour type ${info.colorType})`;
  return null;
}

/**
 * An opaque image asked for and handed back on TRANSPARENT.
 *
 * Measured on a ratkin atlas sheet: 59.5% of it fully transparent, every
 * border pixel at alpha 0, the artwork itself complete. Downstream that is
 * indistinguishable from a sheet drawn on black — the atlas importer finds its
 * ground by flooding in from the border through BRIGHT pixels, so it found
 * none and refused the sheet outright, costing a whole generation.
 *
 * Unlike a sheet on black this one is trivially recoverable: the ground is not
 * the wrong colour, it is absent, so compositing over white puts back exactly
 * what was asked for — including the soft edges, which composite correctly
 * rather than being thresholded. Only done when the caller did NOT ask for
 * alpha, and only when the border really is transparent; a mostly-opaque sheet
 * with a few transparent pixels is left alone.
 */
async function flattenOntoWhite(file) {
  const { decodePng, encodePng } = await import("./_png.mjs");
  const img = decodePng(fs.readFileSync(file));
  const { width: W, height: H, data } = img;
  let border = 0;
  let n = 0;
  for (let x = 0; x < W; x++)
    for (const y of [0, H - 1]) { border += data[(y * W + x) * 4 + 3]; n++; }
  for (let y = 0; y < H; y++)
    for (const x of [0, W - 1]) { border += data[(y * W + x) * 4 + 3]; n++; }
  if (border / n > 8) return null; // the border is painted; not this failure
  for (let i = 0; i < W * H; i++) {
    const a = data[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.round(data[i * 4 + c] * a + 255 * (1 - a));
    data[i * 4 + 3] = 255;
  }
  fs.writeFileSync(file, encodePng(W, H, data));
  return `flattened a transparent background onto white (${W}x${H})`;
}

// One codex exec session. The prompt goes in on stdin so a variadic -i cannot swallow it.
function runCodex(cwd, prompt, refs, timeoutSec) {
  const args = ["exec", "--cd", cwd, "-s", "workspace-write", "--skip-git-repo-check"];
  for (const r of refs) args.push("-i", path.resolve(r));
  args.push("-");
  const res = spawnSync("codex", args, { input: prompt, encoding: "utf8", shell: true, timeout: timeoutSec * 1000, maxBuffer: 1 << 26 });
  if (res.error?.code === "ENOENT") { console.error("codex CLI not found on PATH — queue the request with `new` instead"); process.exit(4); }
  return res;
}

// The parts of the brief that must hold for every image we ask for.
function brief(items) {
  const one = items.length === 1;
  const lines = [
    `Generate ${one ? "one image" : `${items.length} separate images`} and save ${one ? "it" : "them"} into the current working directory.`,
    `Write ONLY the PNG file${one ? "" : "s"} listed below — no notes file, no prompt log, no extra files.`,
    "",
  ];
  for (const it of items) {
    lines.push(`## ${it.file}`);
    lines.push(`Exact output size: ${it.size} pixels. Save as exactly "${it.file}" in the cwd.`);
    if (it.alpha) lines.push("Background MUST be fully transparent (a real PNG alpha channel, not white, not a checkerboard pattern).");
    if (it.ref) lines.push("A reference image is attached: match its palette, grain and pixel density. Follow the text below for subject and layout.");
    lines.push("", it.prompt.trim(), "");
  }
  lines.push(`Resize to the exact pixel size with nearest-neighbour (never bilinear) so pixel art stays crisp${items.some((i) => i.alpha) ? ", preserving alpha" : ""}.`);
  lines.push("Reply with only the filename and byte size of each PNG you wrote.");
  return lines.join("\n");
}

// gen / gen-set: record the request, generate, verify, install, record the outcome.
async function generate(items, timeoutSec) {
  const stage = path.join(stageRoot, Date.now().toString(36));
  fs.mkdirSync(stage, { recursive: true });

  for (const it of items) {
    const existing = fs.existsSync(file(it.id)) ? read(it.id) : null;
    if (existing?.status === "done" && fs.existsSync(existing.target) && !flag("force")) {
      console.error(`request ${it.id} already done (${existing.target}) — pass --force to regenerate`);
      process.exit(1);
    }
    write(it.id, {
      id: it.id, status: "pending", createdAt: new Date().toISOString(), requester: opt("requester", "claude"),
      purpose: it.purpose ?? "", size: it.size, target: it.target, prompt: it.prompt,
      refs: it.ref ? [path.resolve(it.ref)] : [], notes: "",
    });
  }

  const refs = items.map((i) => i.ref).filter(Boolean);
  const t0 = Date.now();
  const res = runCodex(stage, brief(items), refs, timeoutSec);
  const secs = Number(((Date.now() - t0) / 1000).toFixed(0));

  if (res.status !== 0 && !items.some((it) => fs.existsSync(path.join(stage, it.file)))) {
    const why = `codex exec exited ${res.status}${res.signal ? ` (${res.signal})` : ""}`;
    for (const it of items) write(it.id, { ...read(it.id), status: "failed", finishedAt: new Date().toISOString(), fulfiller: "codex", notes: why });
    console.error((res.stderr || res.stdout || "").slice(-2000));
    console.error(`${why} after ${secs}s`);
    process.exit(1);
  }

  const out = [];
  let bad = 0;
  for (const it of items) {
    const produced = path.join(stage, it.file);
    const err = checkPng(produced, it);
    if (err) {
      write(it.id, { ...read(it.id), status: "failed", finishedAt: new Date().toISOString(), fulfiller: "codex", notes: err });
      out.push({ id: it.id, status: "failed", reason: err });
      bad++;
      continue;
    }
    fs.mkdirSync(path.dirname(it.target), { recursive: true });
    fs.copyFileSync(produced, it.target);
    // A generator that was told "background must be pure white" and returned a
    // transparent one has produced the right picture on the wrong ground.
    let flattened = null;
    if (!it.alpha) flattened = await flattenOntoWhite(it.target);
    const info = pngInfo(it.target);
    write(it.id, { ...read(it.id), status: "done", finishedAt: new Date().toISOString(), fulfiller: "codex", notes: `${secs}s` });
    out.push({ id: it.id, status: "done", target: it.target, bytes: fs.statSync(it.target).size, size: `${info.w}x${info.h}`, alpha: info.alpha, ...(flattened ? { fixed: flattened } : {}) });
  }
  const strays = fs.readdirSync(stage).filter((f) => !items.some((it) => it.file === f));
  console.log(JSON.stringify({ seconds: secs, results: out, ...(strays.length ? { discardedStrays: strays } : {}) }, null, 2));
  process.exit(bad ? 1 : 0);
}

if (cmd === "gen") {
  const id = opt("id"); const target = opt("target"); if (!id || !target) usage();
  const prompt = opt("prompt") ?? (opt("prompt-file") ? fs.readFileSync(opt("prompt-file"), "utf8") : null);
  if (!prompt) usage();
  await generate([{
    id, file: `${id}.png`, target: path.resolve(root, target), size: opt("size", "1024x1024"),
    prompt, alpha: flag("alpha"), ref: opts("ref")[0], purpose: opt("purpose", ""),
  }], Number(opt("timeout", 900)));
} else if (cmd === "gen-set") {
  const m = opt("manifest"); if (!m) usage();
  const spec = JSON.parse(fs.readFileSync(path.resolve(m), "utf8"));
  const list = Array.isArray(spec) ? spec : spec.images;
  const shared = (Array.isArray(spec) ? "" : spec.brief ?? "").trim();
  if (!list?.length) usage();
  await generate(list.map((it) => {
    if (!it.id || !it.target || !it.prompt) { console.error(`manifest entry needs id, target, prompt: ${JSON.stringify(it)}`); process.exit(2); }
    return {
      id: it.id, file: `${it.id}.png`, target: path.resolve(root, it.target), size: it.size ?? "1024x1024",
      prompt: shared ? `${shared}\n\n${it.prompt}` : it.prompt, alpha: !!it.alpha,
      ref: it.ref ? path.resolve(root, it.ref) : undefined, purpose: it.purpose ?? "",
    };
  }), Number(opt("timeout", 1800)));
} else if (cmd === "new") {
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
