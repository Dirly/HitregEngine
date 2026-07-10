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
