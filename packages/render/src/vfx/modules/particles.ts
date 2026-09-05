import * as THREE from "three/webgpu";
import type { VfxModuleOf } from "@hitreg/core";
import { LiveModule, type LiveModuleHost } from "../base.js";

type ParticlesModule = VfxModuleOf<"particles">;

let counter = 0;

/**
 * A pooled particle emitter driven from a module. The emitter itself is the
 * engine's ParticleSystem emitter — the same code path as the `particles`
 * component, so everything Phase 1 bought it (sub-UV, soft fade, stretch,
 * curves) is available to a generated spell for free.
 *
 * Pool key is the emitter DATA: an emitter's capacity and shader are fixed at
 * construction, so an instance is only reused for an identical emitter. That
 * is exactly the common case (the same spell cast again) and never wrong.
 */
export class ParticlesLive extends LiveModule<ParticlesModule> {
  readonly kind = "particles" as const;
  readonly group = new THREE.Group();
  private readonly id = `vfx-particles-${++counter}`;
  private dataKey = "";
  private streaming = false;

  static poolKey(module: ParticlesModule): string {
    return `particles:${JSON.stringify(module.emitter)}`;
  }

  constructor(host: LiveModuleHost) {
    super(host);
    this.group.visible = false;
    host.root.add(this.group);
  }

  protected naturalLife(): number {
    const m = this.module;
    if (m.stream) return this.ctx.phaseLength > 0 ? this.ctx.phaseLength : 0.5;
    return 0.01;
  }

  protected tail(): number {
    return Math.max(...this.module.emitter.lifetime) + 0.05;
  }

  protected onBegin(): void {
    const m = this.module;
    const key = ParticlesLive.poolKey(m);
    if (key !== this.dataKey) {
      if (this.dataKey) this.host.particles.unregister(this.id);
      this.host.particles.register(this.id, this.group, { ...m.emitter, emitting: false });
      this.dataKey = key;
    }
    this.group.position.copy(this.pose.position);
    this.group.quaternion.copy(this.pose.facing);
    this.group.visible = true;
    const authoredStart = m.emitter.colorStart.toLowerCase() !== "#ffffff";
    const authoredEnd = m.emitter.colorEnd.toLowerCase() !== "#ffffff";
    this.streaming = m.stream;
    this.host.particles.setValue(this.id, {
      visible: true,
      restart: true,
      emitting: m.stream,
      burst: m.burst,
      colorStart: authoredStart ? m.emitter.colorStart : `#${this.color.getHexString()}`,
      colorEnd: authoredEnd ? m.emitter.colorEnd : `#${this.colorEnd.getHexString()}`,
    });
  }

  protected onUpdate(t: number): void {
    if (this.module.anchor.follow) {
      this.group.position.copy(this.pose.position);
      this.group.quaternion.copy(this.pose.facing);
    }
    if (this.streaming && t >= 1) {
      this.streaming = false;
      this.host.particles.setValue(this.id, { emitting: false });
    }
  }

  protected onEnd(): void {
    this.host.particles.setValue(this.id, { emitting: false, visible: false });
    this.group.visible = false;
  }

  dispose(): void {
    if (this.dataKey) this.host.particles.unregister(this.id);
    this.group.removeFromParent();
  }
}
