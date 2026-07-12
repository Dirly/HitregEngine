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
 * - GET/POST /__hitreg/spec — the running app posts its capability spec
 *   (buildEngineSpec: every component/event/data-type/script + the ops
 *   protocol, generated from the live Zod schemas); AI tools GET it to learn
 *   what they can build, always current. GET also lists these HTTP endpoints.
 *
 * assets/ is excluded from Vite's own watcher so writes never trigger a full
 * reload; the in-place sync above replaces it.
 *
 * projects/<name>/ is a self-contained game built on the engine (see
 * apps/playground/PROJECTS.md): projects/<name>/assets/ merges into the same
 * kind buckets as the flat assets/ tree above (same live-sync, same
 * read/write endpoints — this file just also looks there). projects/<name>/
 * scripts/ is NOT part of that — it's a sibling of assets/, so it's outside
 * the assets-watch-ignore pattern below and gets Vite's completely normal
 * HMR, no bridge involvement at all (see main.ts's script glob).
 * Gitignored wholesale: a project folder is meant to be its own git repo,
 * not engine-repo content.
 */

/** The bridge's own HTTP surface, surfaced through GET /__hitreg/spec so an AI
 * can discover the tooling without reading this file. */
const BRIDGE_ENDPOINTS = [
  { method: "GET", path: "/__hitreg/spec", purpose: "This capability spec + endpoint list." },
  { method: "GET", path: "/__hitreg/context", purpose: "What the user currently sees: scene, selection, camera, in-view entities, play mode, diagnostics." },
  { method: "GET", path: "/__hitreg/assets-index", purpose: "Every asset file on disk, bucketed by kind (scenes, prefabs, materials, models, chunks, …)." },
  { method: "GET", path: "/__hitreg/asset-file?file=<rel>", purpose: "Read one asset file fresh from disk (bypasses Vite's cache)." },
  { method: "POST", path: "/__hitreg/write-asset", purpose: "Write an asset file ({file, content}); live-syncs into the running app." },
  { method: "GET", path: "/__hitreg/player-data", purpose: "Read experience-scoped player-data records (dev backend)." },
  { method: "GET", path: "/__hitreg/net-debug", purpose: "Multiplayer signaling rooms + a ring buffer of relayed traffic." },
] as const;

function hitregBridge(): Plugin {
  let latestContext: unknown = null;
  let latestSpec: unknown = null;

  return {
    name: "hitreg-bridge",
    configureServer(server) {
      const assetsRoot = path.resolve(server.config.root, "assets");
      const projectsRoot = path.resolve(server.config.root, "projects");
      fs.mkdirSync(assetsRoot, { recursive: true });

      const ASSET_KINDS = [
        "scenes",
        "prefabs",
        "materials",
        "terrain",
        "spritesheets",
        "models",
        "textures",
        "audio",
        "chunks",
      ] as const;

      // A virtual path like "materials/heli-island/beacon-glow.json" may live
      // under the flat assets/ tree OR under some projects/<name>/assets/ tree
      // — try the flat location first, then search each project. New files
      // (neither exists yet) default to the flat tree.
      const resolveAssetPath = (file: string): string => {
        const flat = path.resolve(assetsRoot, file);
        if (fs.existsSync(flat)) return flat;
        if (fs.existsSync(projectsRoot)) {
          for (const entry of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const candidate = path.resolve(projectsRoot, entry.name, "assets", file);
            if (fs.existsSync(candidate)) return candidate;
          }
        }
        return flat;
      };
      const withinKnownRoot = (target: string): boolean =>
        target.startsWith(assetsRoot + path.sep) || target.startsWith(projectsRoot + path.sep);

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
            const target = resolveAssetPath(file);
            if (!withinKnownRoot(target)) throw new Error("path outside assets/ or projects/");
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
        const index: Record<string, string[]> = Object.fromEntries(ASSET_KINDS.map((k) => [k, []]));
        const walk = (dir: string, bucket: string[], base: string) => {
          if (!fs.existsSync(dir)) return;
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full, bucket, base);
            else bucket.push(path.relative(base, full).split(path.sep).join("/"));
          }
        };
        for (const kind of ASSET_KINDS) {
          walk(path.join(assetsRoot, kind), index[kind]!, path.join(assetsRoot, kind));
        }
        // merge in every projects/<name>/assets/<kind>/ tree — same virtual
        // path meaning as the flat layout (a project's own materials/ already
        // namespaces itself, e.g. materials/heli-island/beacon-glow.json)
        if (fs.existsSync(projectsRoot)) {
          for (const entry of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const projectAssets = path.join(projectsRoot, entry.name, "assets");
            for (const kind of ASSET_KINDS) {
              const kindDir = path.join(projectAssets, kind);
              walk(kindDir, index[kind]!, kindDir);
            }
          }
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(index));
      });

      server.middlewares.use("/__hitreg/asset-file", (req, res) => {
        try {
          const url = new URL(req.url ?? "", "http://x");
          const file = url.searchParams.get("file") ?? "";
          const target = resolveAssetPath(file);
          if (!withinKnownRoot(target)) throw new Error("path outside assets/ or projects/");
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

      // dev backend for experience-scoped player data (ARCHITECTURE §3c cat. 2):
      // same PlayerDataBackend contract the platform service implements later.
      // Files: .hitreg/player-data/<experience>/<player>/<namespace>.json
      const playerDataRoot = path.resolve(server.config.root, ".hitreg", "player-data");
      const segment = (raw: string): string => {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9-_]{0,63}$/.test(raw)) throw new Error(`bad segment "${raw}"`);
        return raw;
      };
      const recordPath = (experience: string, player: string, namespace: string) =>
        path.join(playerDataRoot, segment(experience), segment(player), `${segment(namespace)}.json`);
      server.middlewares.use("/__hitreg/player-data", (req, res) => {
        try {
          if (req.method === "GET") {
            const url = new URL(req.url ?? "", "http://x");
            const file = recordPath(
              url.searchParams.get("experience") ?? "",
              url.searchParams.get("player") ?? "",
              url.searchParams.get("namespace") ?? "",
            );
            res.setHeader("content-type", "application/json");
            res.setHeader("cache-control", "no-store");
            res.end(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "null");
            return;
          }
          if (req.method === "POST") {
            let body = "";
            req.on("data", (chunk: Buffer) => (body += chunk));
            req.on("end", () => {
              try {
                const { experience, player, namespace, record, expectedRevision } = JSON.parse(
                  body,
                ) as {
                  experience: string;
                  player: string;
                  namespace: string;
                  record: { revision: number };
                  expectedRevision: number | null;
                };
                const file = recordPath(experience, player, namespace);
                const current = fs.existsSync(file)
                  ? (JSON.parse(fs.readFileSync(file, "utf8")) as { revision: number })
                  : null;
                const currentRevision = current ? current.revision : null;
                res.setHeader("content-type", "application/json");
                if (currentRevision !== expectedRevision) {
                  res.end(JSON.stringify({ ok: false, conflict: true }));
                  return;
                }
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, JSON.stringify(record, null, 2), "utf8");
                res.end(JSON.stringify({ ok: true }));
              } catch (error) {
                res.statusCode = 400;
                res.end(JSON.stringify({ ok: false, error: String(error) }));
              }
            });
            return;
          }
          res.statusCode = 405;
          res.end();
        } catch (error) {
          res.statusCode = 400;
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

      // the running app posts its live capability spec; AI tools GET it to learn
      // the current component/event/script/data-type surface + these endpoints.
      server.middlewares.use("/__hitreg/spec", (req, res) => {
        if (req.method === "GET") {
          res.setHeader("content-type", "application/json");
          res.setHeader("cache-control", "no-store");
          const base =
            latestSpec ?? { note: "open the app once so it can post its spec" };
          res.end(JSON.stringify({ ...(base as object), endpoints: BRIDGE_ENDPOINTS }));
          return;
        }
        if (req.method === "POST") {
          let body = "";
          req.on("data", (chunk: Buffer) => (body += chunk));
          req.on("end", () => {
            try {
              latestSpec = JSON.parse(body);
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

      // -- multiplayer dev signaling (WebRTC) --------------------------------
      // The dev server is a signaling relay ONLY: it brokers room membership
      // and forwards SDP/ICE envelopes between tabs over the vite websocket.
      // Game traffic never touches it — that flows P2P over DataChannels.
      // Host election: the first PLAYING member (join order) — the authority
      // must be a tab that actually simulates; a tab sitting in edit mode
      // never hosts while someone else plays. Falls back to the first member
      // when nobody plays. On host change, clients tear down and re-dial.
      type NetSignalUp =
        | { kind: "join"; room: string; peerId: string }
        | { kind: "leave"; room: string; peerId: string }
        | { kind: "state"; room: string; peerId: string; playing: boolean }
        | { kind: "signal"; room: string; from: string; to: string; data: unknown };
      const netRooms = new Map<string, string[]>(); // room -> peerIds in join order
      const netPlaying = new Map<string, Set<string>>(); // room -> peerIds in play mode
      const netHosts = new Map<string, string>(); // room -> current authority (sticky)
      // socket -> (room -> peerId), so a dead tab's memberships get cleaned up
      const netSockets = new WeakMap<object, Map<string, string>>();
      const broadcastMembers = (room: string) => {
        const members = netRooms.get(room) ?? [];
        const playing = netPlaying.get(room) ?? new Set<string>();
        // STICKY election: the host only moves when it becomes invalid —
        // it left, or it stopped playing while someone else still plays.
        // (A playing host never loses the room to a later play-presser.)
        const current = netHosts.get(room);
        const currentValid =
          current !== undefined &&
          members.includes(current) &&
          (playing.has(current) || playing.size === 0);
        const host = currentValid
          ? current
          : (members.find((id) => playing.has(id)) ?? members[0] ?? null);
        if (host === null) netHosts.delete(room);
        else netHosts.set(room, host);
        server.ws.send("hitreg:net-signal", { kind: "members", room, members, host });
      };
      const leaveNetRoom = (room: string, peerId: string) => {
        netPlaying.get(room)?.delete(peerId);
        const members = netRooms.get(room);
        if (!members?.includes(peerId)) return;
        const next = members.filter((id) => id !== peerId);
        if (next.length === 0) {
          netRooms.delete(room);
          netPlaying.delete(room);
          netHosts.delete(room);
        } else netRooms.set(room, next);
        broadcastMembers(room);
      };
      // ring buffer of relayed traffic — GET /__hitreg/net-debug (AI debugging)
      const netLog: Array<Record<string, unknown>> = [];
      const logNet = (entry: Record<string, unknown>) => {
        netLog.push({ at: new Date().toISOString(), ...entry });
        if (netLog.length > 80) netLog.shift();
      };
      server.middlewares.use("/__hitreg/net-debug", (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ rooms: Object.fromEntries(netRooms), log: netLog }));
      });
      server.ws.on("hitreg:net-signal", (payload, client) => {
        try {
          const msg = payload as NetSignalUp;
          if ((msg as { kind?: string }).kind === "trace") {
            const t = msg as unknown as { peerId?: string; event?: string; detail?: string };
            logNet({ kind: "trace", peerId: t.peerId, event: t.event, detail: t.detail });
            return; // debug tap only — never rebroadcast
          }
          if (msg.kind === "signal") {
            logNet({
              kind: "signal",
              from: msg.from,
              to: msg.to,
              rtc: (msg.data as { rtc?: string } | null)?.rtc ?? "?",
            });
            // broadcast; clients filter by `to` (dev tab counts are tiny)
            server.ws.send("hitreg:net-signal", msg);
            return;
          }
          const m = msg as { kind: string; room?: string; peerId?: string };
          logNet({ kind: m.kind, room: m.room, peerId: m.peerId });
          if (msg.kind === "join") {
            const members = netRooms.get(msg.room) ?? [];
            if (!members.includes(msg.peerId)) members.push(msg.peerId);
            netRooms.set(msg.room, members);
            const socket = client.socket as unknown as {
              on(event: "close", cb: () => void): void;
            } & object;
            let owned = netSockets.get(socket);
            if (!owned) {
              const registrations = new Map<string, string>();
              owned = registrations;
              netSockets.set(socket, registrations);
              socket.on("close", () => {
                for (const [room, peerId] of registrations) leaveNetRoom(room, peerId);
                registrations.clear();
              });
            }
            owned.set(msg.room, msg.peerId);
            broadcastMembers(msg.room);
            return;
          }
          if (msg.kind === "state") {
            let playing = netPlaying.get(msg.room);
            if (!playing) {
              playing = new Set();
              netPlaying.set(msg.room, playing);
            }
            if (msg.playing) playing.add(msg.peerId);
            else playing.delete(msg.peerId);
            broadcastMembers(msg.room); // host may have moved to a playing tab
            return;
          }
          if (msg.kind === "leave") {
            leaveNetRoom(msg.room, msg.peerId);
            netSockets.get(client.socket as unknown as object)?.delete(msg.room);
          }
        } catch (error) {
          console.warn("[hitreg] net-signal relay error:", error);
        }
      });

      // live-sync: push asset file changes into the running app
      const pushAssetChange = (root: string, filename: string): void => {
        const file = filename.split(path.sep).join("/");
        const full = path.join(root, filename);
        let content: string | null = null;
        try {
          content = fs.readFileSync(full, "utf8");
        } catch {
          return; // deleted or mid-write; next event will catch it
        }
        console.log(`[hitreg] asset changed: ${file} (${content.length}b) -> ws push`);
        server.ws.send("hitreg:asset-changed", { file, content });
      };
      try {
        fs.watch(assetsRoot, { recursive: true }, (_event, filename) => {
          if (!filename || !filename.endsWith(".json")) return;
          pushAssetChange(assetsRoot, filename);
        });
      } catch (error) {
        console.warn("[hitreg] assets watcher failed:", error);
      }
      // same live-sync for projects/<name>/assets/ — filename is relative to
      // projectsRoot (e.g. "heli-island/assets/materials/heli-island/x.json"),
      // strip the "<project>/assets/" prefix to get the same virtual "file"
      // path the flat watcher above sends (e.g. "materials/heli-island/x.json")
      try {
        fs.mkdirSync(projectsRoot, { recursive: true });
        fs.watch(projectsRoot, { recursive: true }, (_event, filename) => {
          if (!filename || !filename.endsWith(".json")) return;
          const parts = filename.split(path.sep);
          const assetsIdx = parts.indexOf("assets");
          if (assetsIdx === -1 || assetsIdx === parts.length - 1) return;
          const projectAssetsDir = path.join(projectsRoot, ...parts.slice(0, assetsIdx + 1));
          pushAssetChange(projectAssetsDir, parts.slice(assetsIdx + 1).join(path.sep));
        });
      } catch (error) {
        console.warn("[hitreg] projects watcher failed:", error);
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
