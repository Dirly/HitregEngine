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
          terrain: [],
          spritesheets: [],
          models: [],
          textures: [],
          audio: [],
          chunks: [],
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
