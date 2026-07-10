import { defineConfig, type Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";

/**
 * The dev server is the AI/file bridge:
 *
 * - POST /__hitreg/write-asset — editor overlay persists created/edited assets
 *   as real files under assets/ (path-sandboxed).
 * - fs.watch on assets/ — ANY change to asset/scene JSON (AI editing files,
 *   humans in a text editor, the overlay's own saves) is pushed to the running
 *   app over the Vite websocket and applied in place, no page reload.
 * - GET/POST /__hitreg/context — the running app posts what the user sees
 *   (selection, camera, in-view entities, play mode); AI tools GET it to
 *   resolve "the thing I'm looking at" tasks.
 *
 * assets/ is excluded from Vite's own watcher so writes never trigger a full
 * reload; the in-place sync above replaces it.
 */
function hitregBridge(): Plugin {
  let latestContext: unknown = null;

  return {
    name: "hitreg-bridge",
    configureServer(server) {
      const assetsRoot = path.resolve(server.config.root, "assets");
      fs.mkdirSync(assetsRoot, { recursive: true });

      server.middlewares.use("/__hitreg/write-asset", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = "";
        req.on("data", (chunk: Buffer) => (body += chunk));
        req.on("end", () => {
          try {
            const { file, content } = JSON.parse(body) as { file: string; content: string };
            const target = path.resolve(assetsRoot, file);
            if (!target.startsWith(assetsRoot + path.sep)) throw new Error("path outside assets/");
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, content, "utf8");
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true, file }));
          } catch (error) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: String(error) }));
          }
        });
      });

      // fresh-from-disk asset reads: dev NEVER trusts vite's module cache for
      // assets (the watcher ignores assets/, so cached imports go stale)
      server.middlewares.use("/__hitreg/assets-index", (_req, res) => {
        const index: Record<string, string[]> = {
          scenes: [],
          prefabs: [],
          materials: [],
          models: [],
          textures: [],
          audio: [],
        };
        const walk = (dir: string, bucket: string[], base: string) => {
          if (!fs.existsSync(dir)) return;
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full, bucket, base);
            else bucket.push(path.relative(base, full).split(path.sep).join("/"));
          }
        };
        for (const kind of Object.keys(index)) {
          walk(path.join(assetsRoot, kind), index[kind]!, path.join(assetsRoot, kind));
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(index));
      });

      server.middlewares.use("/__hitreg/asset-file", (req, res) => {
        try {
          const url = new URL(req.url ?? "", "http://x");
          const file = url.searchParams.get("file") ?? "";
          const target = path.resolve(assetsRoot, file);
          if (!target.startsWith(assetsRoot + path.sep)) throw new Error("path outside assets/");
          const data = fs.readFileSync(target);
          res.setHeader(
            "content-type",
            file.endsWith(".json") ? "application/json" : "application/octet-stream",
          );
          res.setHeader("cache-control", "no-store");
          res.end(data);
        } catch (error) {
          res.statusCode = 404;
          res.end(JSON.stringify({ ok: false, error: String(error) }));
        }
      });

      server.middlewares.use("/__hitreg/log", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = "";
        req.on("data", (chunk: Buffer) => (body += chunk));
        req.on("end", () => {
          console.log(`[client] ${body}`);
          res.end("{}");
        });
      });

      server.middlewares.use("/__hitreg/context", (req, res) => {
        if (req.method === "GET") {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(latestContext));
          return;
        }
        if (req.method === "POST") {
          let body = "";
          req.on("data", (chunk: Buffer) => (body += chunk));
          req.on("end", () => {
            try {
              latestContext = JSON.parse(body);
              res.end(JSON.stringify({ ok: true }));
            } catch {
              res.statusCode = 400;
              res.end(JSON.stringify({ ok: false }));
            }
          });
          return;
        }
        res.statusCode = 405;
        res.end();
      });

      // live-sync: push asset file changes into the running app
      try {
        fs.watch(assetsRoot, { recursive: true }, (_event, filename) => {
          if (!filename || !filename.endsWith(".json")) return;
          const file = filename.split(path.sep).join("/");
          const full = path.join(assetsRoot, filename);
          let content: string | null = null;
          try {
            content = fs.readFileSync(full, "utf8");
          } catch {
            return; // deleted or mid-write; next event will catch it
          }
          console.log(`[hitreg] asset changed: ${file} (${content.length}b) -> ws push`);
          server.ws.send("hitreg:asset-changed", { file, content });
        });
      } catch (error) {
        console.warn("[hitreg] assets watcher failed:", error);
      }
    },
  };
}

export default defineConfig({
  plugins: [hitregBridge()],
  server: {
    port: 5173,
    watch: { ignored: ["**/assets/**"] },
  },
  build: { target: "esnext" },
});
