/// <reference lib="dom" />
/**
 * The developer console — "/time 22", "/weather storm" — and its overlay.
 *
 * ## Why this is its own entry point
 *
 * `@hitreg/scripting/console` is imported NOWHERE inside the engine. A host
 * pulls it in behind a build-time constant, so a published game that does not
 * ask for it never has this module in its bundle at all: no parser, no
 * overlay, no command table, nothing for a player to find. That is the whole
 * reason it is a separate file rather than a flag on the runtime — a flag
 * still ships the code, and code that ships is code a player can reach.
 *
 * ## Where the commands come from
 *
 * Not from here. Scripts declare their own (`static commands` +
 * `onCommand` — see `ScriptCommandDecl`), so the script that owns the clock
 * owns `/time`, a project's own script can add `/gold` without touching the
 * engine, and `/help` is generated from the declarations instead of written
 * twice and left to rot. This module is the parser, the dispatcher and the
 * input line; hosts add their own commands with `register` for things no
 * script owns (`/fps`, `/scene`).
 *
 * ## What it deliberately does not do
 *
 * It does not reach across the wire. A command runs against THIS tab's script
 * runtime; one that changes authority-owned state is marked `authority: true`
 * and the console says plainly when this tab is not the authority, rather than
 * applying a change the next sync will undo. A shipped game that wants remote
 * GM commands needs a permission model, and a stripped-by-default debug tool
 * is the wrong place to grow one.
 */

import type { ScriptCommandDecl } from "./script.js";
import type { ScriptRuntime } from "./runtime.js";

/** A line the console prints. `kind` is also carried as a glyph, never colour alone. */
export interface ConsoleLine {
  kind: "in" | "out" | "error";
  text: string;
}

/** A command the HOST owns (not a script): "/fps", "/scene". */
export interface ConsoleCommand extends ScriptCommandDecl {
  /** Return the line to print, or null. Throw to report a bad argument. */
  run(args: string[]): string | null;
}

export interface DevConsoleOptions {
  /**
   * The live script runtime, or null when nothing is running (edit mode, or
   * before play). A getter, not a value: the runtime is recreated every time
   * play starts, and a console that captured the first one would talk to a
   * dead session for the rest of the sitting.
   */
  runtime(): ScriptRuntime | null;
  /** True when this tab owns world state (single player, or the host/server). */
  isAuthority?(): boolean;
  /** Longest input remembered for the up-arrow (default 50). */
  historyLimit?: number;
}

/**
 * The registry + dispatcher. UI-free, so it can be driven from a chat input,
 * from the overlay below, or from a test.
 */
export class DevConsole {
  private readonly own = new Map<string, ConsoleCommand>();
  private readonly recent: string[] = [];

  constructor(private readonly opts: DevConsoleOptions) {
    this.register({
      name: "help",
      args: "[command]",
      description: "List the commands this scene answers, or explain one.",
      run: (args) => this.help(args[0]),
    });
  }

  /** Add a command this host owns. Replaces one of the same name. */
  register(command: ConsoleCommand): () => void {
    this.own.set(command.name, command);
    return () => {
      this.own.delete(command.name);
    };
  }

  /** Everything reachable right now: host commands plus the live scripts'. */
  commands(): ScriptCommandDecl[] {
    const out = new Map<string, ScriptCommandDecl>();
    for (const decl of this.opts.runtime()?.consoleCommands() ?? []) out.set(decl.name, decl);
    for (const [name, command] of this.own) out.set(name, command);
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Names starting with `prefix`, for tab completion. */
  complete(prefix: string): string[] {
    const bare = prefix.replace(/^\//, "").toLowerCase();
    return this.commands()
      .map((c) => c.name)
      .filter((name) => name.startsWith(bare));
  }

  /** Inputs typed this session, oldest first. */
  history(): readonly string[] {
    return this.recent;
  }

  /**
   * Run one line ("/time 22", or "time 22" — the slash is optional, since a
   * chat box has already eaten it by the time it gets here).
   */
  run(line: string): ConsoleLine[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    this.remember(trimmed);
    const parts = trimmed.replace(/^\//, "").split(/\s+/);
    const name = (parts.shift() ?? "").toLowerCase();
    if (!name) return [];
    return this.dispatch(name, parts);
  }

  /** Run a command already split by someone else — the chat UI's `onCommand`. */
  dispatch(name: string, args: string[]): ConsoleLine[] {
    const lower = name.toLowerCase();
    const mine = this.own.get(lower);
    if (mine) return this.attempt(mine, () => mine.run(args));

    const runtime = this.opts.runtime();
    if (!runtime) {
      return [
        {
          kind: "error",
          text: `no scripts are running, so nothing answers /${lower} — start play mode first`,
        },
      ];
    }
    const decl = runtime.consoleCommands().find((c) => c.name === lower);
    if (!decl) return [{ kind: "error", text: `unknown command /${lower} — try /help` }];
    const warning = this.authorityWarning(decl);
    const result = runtime.runConsoleCommand(lower, args);
    if (!result) return [{ kind: "error", text: `unknown command /${lower} — try /help` }];
    const lines: ConsoleLine[] = [];
    if (warning) lines.push({ kind: "error", text: warning });
    if (result.text) lines.push({ kind: result.ok ? "out" : "error", text: result.text });
    else if (result.ok) lines.push({ kind: "out", text: "ok" });
    return lines;
  }

  // -- internals ----------------------------------------------------------

  private attempt(decl: ScriptCommandDecl, run: () => string | null): ConsoleLine[] {
    const warning = this.authorityWarning(decl);
    const lines: ConsoleLine[] = warning ? [{ kind: "error", text: warning }] : [];
    try {
      const text = run();
      lines.push({ kind: "out", text: text ?? "ok" });
    } catch (error) {
      lines.push({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    }
    return lines;
  }

  /**
   * Said BEFORE the command runs, not instead of it: on a peer the change
   * still happens locally and still looks right for a second or two, and
   * hiding that is how a tester concludes the feature is broken.
   */
  private authorityWarning(decl: ScriptCommandDecl): string | null {
    if (!decl.authority) return null;
    const authority = this.opts.isAuthority?.();
    if (authority === undefined || authority) return null;
    return `/${decl.name} changes world state the host owns — this tab will be corrected on the next sync`;
  }

  private remember(line: string): void {
    if (this.recent[this.recent.length - 1] === line) return;
    this.recent.push(line);
    const limit = this.opts.historyLimit ?? 50;
    while (this.recent.length > limit) this.recent.shift();
  }

  private help(which: string | undefined): string {
    const commands = this.commands();
    if (which) {
      const name = which.replace(/^\//, "").toLowerCase();
      const found = commands.find((c) => c.name === name);
      if (!found) return `no command /${name}`;
      const authority = found.authority ? "  (host only — changes world state)" : "";
      return `/${found.name}${found.args ? ` ${found.args}` : ""}\n  ${found.description}${authority}`;
    }
    if (commands.length === 0) return "no commands — start play mode so the scene's scripts are running";
    const width = Math.max(...commands.map((c) => c.name.length));
    return commands
      .map((c) => `/${c.name.padEnd(width)}  ${c.args ? `${c.args} ` : ""}${c.description}`)
      .join("\n");
  }
}

// ---------------------------------------------------------------------------
// The overlay
// ---------------------------------------------------------------------------

export interface ConsoleUIOptions {
  console: DevConsole;
  /** Mount point (default document.body). */
  parent?: HTMLElement;
  /**
   * KeyboardEvent.key that opens the input (default "/"), which is also the
   * first character typed — a console is opened by starting to type a command,
   * not by finding a key that happens to be free.
   */
  openKey?: string;
  /** Lines kept on screen (default 12). */
  maxLines?: number;
  /** Extra class on the root. */
  className?: string;
}

export interface ConsoleUI {
  root: HTMLElement;
  open(prefill?: string): void;
  close(): void;
  print(lines: ConsoleLine[]): void;
  dispose(): void;
}

const CSS = `
.hitreg-console{position:fixed;left:0;right:0;bottom:0;z-index:100010;font:12px/1.5 ui-monospace,monospace;
  pointer-events:none;display:flex;flex-direction:column;gap:4px;padding:8px}
.hitreg-console[data-open="false"]{display:none}
.hitreg-console-log{align-self:flex-start;max-width:min(880px,92vw);max-height:42vh;overflow:auto;
  background:rgba(13,17,23,.94);border:1px solid #30363d;border-radius:3px;padding:6px 8px;
  color:#c9d1d9;white-space:pre-wrap;pointer-events:auto}
.hitreg-console-line{display:flex;gap:6px;align-items:flex-start}
.hitreg-console-mark{color:#8b949e;flex:none}
.hitreg-console-line[data-kind="in"] .hitreg-console-text{color:#e6edf3}
.hitreg-console-line[data-kind="error"] .hitreg-console-text{color:#ffa198}
.hitreg-console-row{display:flex;gap:6px;align-items:center;pointer-events:auto}
.hitreg-console-prompt{color:#8b949e;font-weight:600}
.hitreg-console-field{flex:1;max-width:min(880px,92vw);background:#161b22;border:1px solid #30363d;
  color:#e6edf3;border-radius:3px;padding:4px 6px;font:inherit;outline:none}
.hitreg-console-field:focus{border-color:#3b5b8a}
.hitreg-console-hint{color:#8b949e;font-size:10px}
`;

/**
 * A one-line input with a short scrollback, opened by typing "/".
 *
 * Deliberately not the chat overlay: a published build usually has no chat,
 * and the console has to work in an empty scene with nothing else mounted.
 * Where there IS a chat (the editor), the host routes its slash commands into
 * the same `DevConsole`, so both surfaces answer identically.
 *
 * Meaning never rides on colour: every line carries a glyph (> you, · output,
 * ! error) as well as its tint, per DESIGN.md's accessibility bar.
 */
export function mountDevConsole(options: ConsoleUIOptions): ConsoleUI {
  const parent = options.parent ?? document.body;
  const maxLines = options.maxLines ?? 12;
  const openKey = options.openKey ?? "/";

  if (!document.getElementById("hitreg-console-css")) {
    const style = document.createElement("style");
    style.id = "hitreg-console-css";
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  const root = document.createElement("div");
  root.className = `hitreg-console${options.className ? ` ${options.className}` : ""}`;
  root.dataset["open"] = "false";
  const log = document.createElement("div");
  log.className = "hitreg-console-log";
  const row = document.createElement("div");
  row.className = "hitreg-console-row";
  const prompt = document.createElement("span");
  prompt.className = "hitreg-console-prompt";
  prompt.textContent = ">";
  const field = document.createElement("input");
  field.className = "hitreg-console-field";
  field.type = "text";
  field.spellcheck = false;
  field.autocomplete = "off";
  field.setAttribute("aria-label", "developer console");
  field.placeholder = "/help";
  row.append(prompt, field);
  const hint = document.createElement("div");
  hint.className = "hitreg-console-hint";
  hint.textContent = "Enter run · Tab complete · ↑↓ history · Esc close";
  root.append(log, row, hint);
  parent.appendChild(root);

  let cursor = -1; // where ↑/↓ is in the history

  const print = (lines: ConsoleLine[]): void => {
    for (const line of lines) {
      const el = document.createElement("div");
      el.className = "hitreg-console-line";
      el.dataset["kind"] = line.kind;
      const mark = document.createElement("span");
      mark.className = "hitreg-console-mark";
      mark.textContent = line.kind === "in" ? ">" : line.kind === "error" ? "!" : "·";
      const text = document.createElement("span");
      text.className = "hitreg-console-text";
      text.textContent = line.text;
      el.append(mark, text);
      log.appendChild(el);
    }
    while (log.childElementCount > maxLines) log.firstElementChild?.remove();
    log.scrollTop = log.scrollHeight;
  };

  const open = (prefill = ""): void => {
    root.dataset["open"] = "true";
    // a locked pointer (play mode) swallows keystrokes meant for the field
    if (document.pointerLockElement) document.exitPointerLock?.();
    field.value = prefill;
    cursor = -1;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  };
  const close = (): void => {
    root.dataset["open"] = "false";
    field.value = "";
    field.blur();
  };

  const submit = (): void => {
    const line = field.value.trim();
    field.value = "";
    if (!line) {
      close();
      return;
    }
    print([{ kind: "in", text: line }]);
    print(options.console.run(line));
    cursor = -1;
  };

  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const [word, ...rest] = field.value.replace(/^\//, "").split(/\s+/);
      if (rest.length > 0) return; // only the command name completes
      const matches = options.console.complete(word ?? "");
      if (matches.length === 1) field.value = `/${matches[0]} `;
      else if (matches.length > 1) print([{ kind: "out", text: matches.map((m) => `/${m}`).join("  ") }]);
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const history = options.console.history();
      if (history.length === 0) return;
      event.preventDefault();
      if (cursor === -1) cursor = history.length;
      cursor += event.key === "ArrowUp" ? -1 : 1;
      cursor = Math.max(0, Math.min(history.length, cursor));
      field.value = cursor >= history.length ? "" : (history[cursor] ?? "");
      field.setSelectionRange(field.value.length, field.value.length);
    }
    // everything else is typing: never let it reach the game's input handlers
    event.stopPropagation();
  });
  field.addEventListener("keyup", (event) => event.stopPropagation());
  field.addEventListener("keypress", (event) => event.stopPropagation());

  /** Typing "/" anywhere that is not already a text field opens the console. */
  const onKeyDown = (event: KeyboardEvent): void => {
    if (root.dataset["open"] === "true") return;
    if (event.key !== openKey || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
    event.preventDefault();
    open("/");
  };
  window.addEventListener("keydown", onKeyDown);

  return {
    root,
    open,
    close,
    print,
    dispose: () => {
      window.removeEventListener("keydown", onKeyDown);
      root.remove();
    },
  };
}
