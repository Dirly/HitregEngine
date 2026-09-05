import type { VfxModuleOf } from "@hitreg/core";
import { LiveModule, type LiveModuleHost } from "../base.js";

type ShakeModule = VfxModuleOf<"shake">;
type SoundModule = VfxModuleOf<"sound">;

/** Camera shake: hands the request to the host and is over at once. */
export class ShakeLive extends LiveModule<ShakeModule> {
  readonly kind = "shake" as const;

  constructor(host: LiveModuleHost) {
    super(host);
  }

  protected naturalLife(): number {
    return 0.01;
  }

  protected onBegin(): void {
    const m = this.module;
    this.host.addShake(m.strength, m.duration > 0 ? m.duration : 0.35, m.frequency);
  }

  protected onUpdate(): void {}
  protected onEnd(): void {}
  dispose(): void {}
}

/** A one-shot sound at the anchor, through the host's audio hook. */
export class SoundLive extends LiveModule<SoundModule> {
  readonly kind = "sound" as const;

  constructor(host: LiveModuleHost) {
    super(host);
  }

  protected naturalLife(): number {
    return 0.01;
  }

  protected onBegin(): void {
    const p = this.pose.position;
    this.host.resolvers.playSound?.(this.module.asset, [p.x, p.y, p.z], this.module.volume);
  }

  protected onUpdate(): void {}
  protected onEnd(): void {}
  dispose(): void {}
}
