import type { InputLike } from "./script.js";

/**
 * Browser keyboard state. Codes are KeyboardEvent.code ("KeyW", "Space").
 * Keys typed into form fields are ignored so the editor UI doesn't drive
 * the player around. Mouse buttons are the codes "Mouse0" (left), "Mouse1"
 * (middle) and "Mouse2" (right), fed by the host through `setMouseButton`
 * — only while the pointer is locked on the game canvas, so a click on the
 * editor UI never fires an ability (see main.ts).
 */
export class InputService implements InputLike {
  private readonly down = new Set<string>();
  private readonly offs: Array<() => void> = [];
  private mouseDX = 0;
  private mouseDY = 0;

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
    return this.captures.size === 0 && this.down.has(code);
  }

  private readonly captures = new Set<string>();

  /**
   * A menu owns the keyboard (see InputLike.captureKeyboard): while any owner
   * holds a capture, gameplay reads nothing. Keys are still tracked underneath
   * so releasing mid-press does not leave a phantom key stuck down or lost.
   */
  captureKeyboard(owner: string, active: boolean): void {
    if (active) this.captures.add(owner);
    else this.captures.delete(owner);
  }

  /** Whether any menu currently owns the keyboard. */
  isCaptured(): boolean {
    return this.captures.size > 0;
  }

  /** Host feeds mouse button state here as "Mouse<n>" codes; a capture or blur releases them like keys. */
  setMouseButton(button: number, down: boolean): void {
    const code = `Mouse${button}`;
    if (down) this.down.add(code);
    else this.down.delete(code);
  }

  /** Release every mouse button (pointer lock ended, window blurred). */
  releaseMouse(): void {
    for (const code of [...this.down]) if (code.startsWith("Mouse")) this.down.delete(code);
  }

  /** Host feeds raw pointer-locked mouse movement here (see main.ts's mousemove handler). */
  addMouseDelta(dx: number, dy: number): void {
    this.mouseDX += dx;
    this.mouseDY += dy;
  }

  mouseDelta(): [number, number] {
    const d: [number, number] = [this.mouseDX, this.mouseDY];
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.down.clear();
  }
}
