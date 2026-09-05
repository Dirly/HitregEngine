import * as THREE from "three/webgpu";
import type { VfxModuleOf } from "@hitreg/core";
import { LiveModule, sampleCurve, type LiveModuleHost } from "../base.js";

type LightModule = VfxModuleOf<"light">;

/** Default flash envelope: a spike, a fast fall, a dim tail. */
const FLASH: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [0.25, 0.55],
  [1, 0],
];

/**
 * The secondary light — the thing that makes a fireball light the ground it
 * flies over. Borrowed from the system's fixed slot pool (see VfxSystem for
 * why the pool is fixed: toggling lights recompiles every lit material).
 */
export class LightLive extends LiveModule<LightModule> {
  readonly kind = "light" as const;
  private light: THREE.PointLight | null = null;
  private phase = 0;

  constructor(host: LiveModuleHost) {
    super(host);
  }

  protected naturalLife(): number {
    return this.ctx.phaseLength > 0 ? this.ctx.phaseLength : 0.5;
  }

  protected onBegin(): void {
    this.light = this.host.takeLight();
    this.phase = Math.random() * 100;
    if (!this.light) return;
    this.light.color.copy(this.color);
    this.light.distance = this.module.range;
    this.light.decay = 2;
    this.light.intensity = 0;
    this.light.position.copy(this.pose.position);
  }

  protected onUpdate(t: number): void {
    const l = this.light;
    if (!l) return;
    const m = this.module;
    const now = this.startedAt + t * this.life;
    const env = m.intensityCurve ? sampleCurve(m.intensityCurve, Math.min(1, t)) : sampleCurve(FLASH, Math.min(1, t));
    let flicker = 1;
    if (m.flicker > 0) {
      const a = now * 23 + this.phase;
      flicker = 1 - m.flicker * (0.5 + 0.5 * Math.sin(a) * Math.sin(a * 0.37 + 1.3));
    }
    l.intensity = m.intensity * env * flicker * this.opacityAt(t, now);
    l.position.copy(this.pose.position);
  }

  protected onEnd(): void {
    if (this.light) {
      this.light.intensity = 0;
      this.host.giveLight(this.light);
      this.light = null;
    }
  }

  dispose(): void {
    this.onEnd();
  }
}
