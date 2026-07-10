import { Script } from "@hitreg/scripting";

/**
 * Demo of Unity-style animation blending: crossfades through a list of clips
 * on a timer. Watch the robot flow Idle -> Walking -> Dance with no pops.
 */
export default class AnimCycler extends Script {
  static override scriptName = "anim-cycler";
  static override params = {
    clips: { default: ["Idle", "Walking", "Dance"], description: "clip names to cycle" },
    interval: { default: 4, min: 0.5, max: 60, description: "seconds per clip" },
    fade: { default: 0.6, min: 0, max: 5, description: "crossfade seconds" },
  };

  private index = 0;
  private nextAt = 0;

  override onFixedUpdate(): void {
    const t = this.ctx.now() / 1000;
    if (t < this.nextAt) return;
    const clips = this.param<string[]>("clips");
    if (clips.length === 0) return;
    this.ctx.setAnimation?.(clips[this.index % clips.length]!, this.param<number>("fade"));
    this.index++;
    this.nextAt = t + this.param<number>("interval");
  }
}
