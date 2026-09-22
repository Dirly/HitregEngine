/**
 * Boot the developer console — or don't, and leave no trace that it existed.
 *
 * Both runtimes (the editor in `main.ts`, the published game in `play.ts`)
 * call `startDevConsole`. It checks a BUILD-TIME constant, so in a bundle
 * built without the console `import.meta.env.HITREG_CONSOLE` is the literal
 * "0", the branch folds away, and rollup never follows the dynamic import:
 * no console module, no chunk, nothing a player can load. That is the whole
 * reason this is a constant and a dynamic import rather than an `enabled`
 * flag — a flag still ships the code.
 *
 * See `vite.config.ts` (the define) and `tools/publish.mjs` (--console).
 */
import type { ScriptRuntime } from "@hitreg/scripting";

/** Compiled in? A literal after the define, so `false` erases everything below. */
export const DEV_CONSOLE_BUILT = import.meta.env.HITREG_CONSOLE === "1";

export interface DevConsoleHandle {
  /** Run a slash command from another surface (the chat box). True if it was handled. */
  command(name: string, args: string[]): boolean;
  dispose(): void;
}

export interface DevConsoleBoot {
  /** The live script runtime, or null between play sessions. */
  runtime(): ScriptRuntime | null;
  /** True when this tab owns world state (alone, or host/server). */
  isAuthority?(): boolean;
  /** Extra commands this host owns — "/fps", "/scene". */
  extras?(register: (command: import("@hitreg/scripting/console").ConsoleCommand) => void): void;
}

/**
 * Mount the console when this build has one. Resolves to null when it does
 * not, so callers need no second check.
 */
export async function startDevConsole(boot: DevConsoleBoot): Promise<DevConsoleHandle | null> {
  if (!DEV_CONSOLE_BUILT) return null;
  const { DevConsole, mountDevConsole } = await import("@hitreg/scripting/console");
  const dev = new DevConsole({
    runtime: boot.runtime,
    ...(boot.isAuthority ? { isAuthority: boot.isAuthority } : {}),
  });
  boot.extras?.((command) => dev.register(command));
  const ui = mountDevConsole({ console: dev });
  return {
    command: (name, args) => {
      const lines = dev.dispatch(name, args);
      // An unknown command belongs to whoever asked (the chat's own /team,
      // /party, /friend): say no and let their handler have it.
      if (lines.length === 1 && lines[0]!.kind === "error" && lines[0]!.text.startsWith("unknown command")) return false;
      ui.open();
      ui.print([{ kind: "in", text: `/${name}${args.length > 0 ? ` ${args.join(" ")}` : ""}` }, ...lines]);
      return true;
    },
    dispose: () => ui.dispose(),
  };
}
