import type { InputLike } from "./script.js";

/**
 * Browser keyboard state. Codes are KeyboardEvent.code ("KeyW", "Space").
 * Keys typed into form fields are ignored so the editor UI doesn't drive
 * the player around.
 */
export class InputService implements InputLike {
  private readonly down = new Set<string>();
  private readonly offs: Array<() => void> = [];

  constructor(target: Window = window) {
    const onDown = (e: KeyboardEvent) => {
      if (
        typeof HTMLInputElement !== "undefined" &&
        (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)
      ) {
        return;
      }
      this.down.add(e.code);
    };
    const onUp = (e: KeyboardEvent) => this.down.delete(e.code);
    const onBlur = () => this.down.clear();
    target.addEventListener("keydown", onDown);
    target.addEventListener("keyup", onUp);
    target.addEventListener("blur", onBlur);
    this.offs.push(
      () => target.removeEventListener("keydown", onDown),
      () => target.removeEventListener("keyup", onUp),
      () => target.removeEventListener("blur", onBlur),
    );
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.down.clear();
  }
}
