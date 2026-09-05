/**
 * Supervisor — main's process manager for layers and instances on THIS box.
 *
 * A layer is `bin/serve.ts` with cluster flags; the supervisor allocates it a
 * port from a range, spawns it, and forgets it when it exits (the registry
 * learns the same from the socket closing). Nothing here is cloud-specific:
 * a container orchestrator replaces this class by starting the same command
 * itself and letting the layer register — `supervisor: null` in main.
 *
 * `node <tsx cli> serve.ts …` is used rather than `pnpm` so it works the same
 * in a Docker image, under systemd, and in a test.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerKind } from "../cluster/protocol.js";

export interface SupervisorOptions {
  /** Playground checkout (content root) the children read. */
  playground: string;
  /** What children dial to reach main (ws://127.0.0.1:port). */
  mainUrl: string;
  secret: string;
  /** Host clients dial to reach a child (the box's public name or LAN address). */
  publicHost: string;
  /** Bind address for children (default 0.0.0.0). */
  bindHost?: string;
  /** Port range children are allocated from. */
  ports: { from: number; to: number };
  /** Extra args for every child (--workers 2, --hz 30 …). */
  extraArgs?: string[];
  /** Path to serve.ts (default: this package's bin). */
  serveBin?: string;
  /** `ws://` vs `wss://` in the public url (behind a TLS proxy the proxy terminates; default ws). */
  publicScheme?: "ws" | "wss";
  /** Public port override per child: `(port) => port` by default; a proxy may map them. */
  publicPort?: (port: number) => number;
  log?: (line: string) => void;
}

export interface ChildInfo {
  id: string;
  kind: ServerKind;
  scene: string;
  port: number;
  url: string;
  pid: number | undefined;
  startedAt: number;
  instanceOf?: string;
}

export interface SpawnChildOptions {
  cap?: number;
  instanceOf?: string;
  idleExitSeconds?: number;
  /** Persist terraformed recipes (only the primary layer should). */
  persist?: boolean;
}

export class Supervisor {
  readonly children = new Map<string, { info: ChildInfo; proc: ChildProcess }>();
  private readonly exitHandlers = new Set<(info: ChildInfo, code: number | null) => void>();
  private readonly log: (line: string) => void;
  private readonly serveBin: string;
  private readonly tsxCli: string;

  constructor(readonly opts: SupervisorOptions) {
    this.log = opts.log ?? (() => undefined);
    const here = path.dirname(fileURLToPath(import.meta.url));
    this.serveBin = opts.serveBin ?? path.resolve(here, "../../bin/serve.ts");
    const require = createRequire(import.meta.url);
    this.tsxCli = require.resolve("tsx/cli");
  }

  private allocatePort(): number {
    const used = new Set([...this.children.values()].map((c) => c.info.port));
    for (let p = this.opts.ports.from; p <= this.opts.ports.to; p++) if (!used.has(p)) return p;
    throw new Error(`no free port in ${this.opts.ports.from}-${this.opts.ports.to}`);
  }

  spawn(kind: ServerKind, scene: string, id: string, options: SpawnChildOptions = {}): ChildInfo {
    if (this.children.has(id)) throw new Error(`child "${id}" already running`);
    const port = this.allocatePort();
    const publicPort = this.opts.publicPort ? this.opts.publicPort(port) : port;
    const url = `${this.opts.publicScheme ?? "ws"}://${this.opts.publicHost}:${publicPort}`;
    const args = [
      this.tsxCli,
      this.serveBin,
      "--scene",
      scene,
      "--playground",
      this.opts.playground,
      "--port",
      String(port),
      "--host",
      this.opts.bindHost ?? "0.0.0.0",
      "--main",
      this.opts.mainUrl,
      "--secret",
      this.opts.secret,
      "--id",
      id,
      "--kind",
      kind,
      "--public-url",
      url,
      ...(options.cap !== undefined ? ["--max-players", String(options.cap)] : []),
      ...(options.instanceOf ? ["--instance-of", options.instanceOf] : []),
      ...(options.idleExitSeconds !== undefined ? ["--idle-exit", String(options.idleExitSeconds)] : []),
      ...(options.persist === false ? ["--no-persist"] : []),
      ...(this.opts.extraArgs ?? []),
    ];
    const proc = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HITREG_CHILD: id },
    });
    const info: ChildInfo = { id, kind, scene, port, url, pid: proc.pid, startedAt: Date.now(), ...(options.instanceOf ? { instanceOf: options.instanceOf } : {}) };
    this.children.set(id, { info, proc });
    const prefix = `[${id}]`;
    proc.stdout?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) this.log(`${prefix} ${line}`);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) this.log(`${prefix} ! ${line}`);
    });
    proc.on("exit", (code) => {
      this.children.delete(id);
      this.log(`${prefix} exited (${code ?? "signal"})`);
      for (const cb of [...this.exitHandlers]) cb(info, code);
    });
    proc.on("error", (error) => {
      this.log(`${prefix} spawn error: ${error.message}`);
    });
    this.log(`[supervisor] started ${kind} "${id}" (${scene}) on ${url} (pid ${proc.pid})`);
    return info;
  }

  stop(id: string, signal: NodeJS.Signals = "SIGTERM"): boolean {
    const child = this.children.get(id);
    if (!child) return false;
    try {
      child.proc.kill(signal);
    } catch {
      // already gone
    }
    return true;
  }

  onExit(cb: (info: ChildInfo, code: number | null) => void): () => void {
    this.exitHandlers.add(cb);
    return () => this.exitHandlers.delete(cb);
  }

  list(): ChildInfo[] {
    return [...this.children.values()].map((c) => c.info);
  }

  /** Stop everything; resolves when every child has exited (or after the grace). */
  async closeAll(graceMs = 5000): Promise<void> {
    const ids = [...this.children.keys()];
    for (const id of ids) this.stop(id);
    const deadline = Date.now() + graceMs;
    while (this.children.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    for (const id of [...this.children.keys()]) this.stop(id, "SIGKILL");
  }
}
