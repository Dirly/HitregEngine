import * as THREE from "three/webgpu";
import { Script } from "@hitreg/scripting";

/**
 * Sumo bot brain: run at the nearest tagged target and shove. Faces its
 * movement direction and plays a run animation. Multiplayer-shaped — this is
 * a stand-in for a networked opponent.
 */
export default class Chaser extends Script {
  static override scriptName = "chaser";
  static override params = {
    speed: { default: 4, min: 0, max: 20 },
    targetTag: { default: "player" },
    runClip: { default: "Running", description: "animation while chasing" },
    idleClip: { default: "Idle", description: "animation while waiting" },
    aggroRange: { default: 999, min: 0, max: 999, description: "starts chasing inside this range" },
    modelYaw: { default: 0, min: -3.1416, max: 3.1416, description: "visual yaw offset for imported models" },
  };

  private currentClip = "";
  private readonly selfWorld = new THREE.Vector3();
  private readonly targetWorld = new THREE.Vector3();

  private play(clip: string): void {
    if (!clip || this.currentClip === clip) return;
    this.currentClip = clip;
    this.ctx.setAnimation?.(clip, 0.2);
  }

  private stopHorizontalMotion(): void {
    const sim = this.ctx.sim;
    const vel = sim?.getLinvel(this.entityId);
    if (vel) sim?.setLinvel(this.entityId, [0, vel[1], 0]);
  }

  override onFixedUpdate(): void {
    const sim = this.ctx.sim;
    if (!sim) return;

    if (!this.object.visible) {
      this.stopHorizontalMotion();
      return;
    }

    // nearest target
    const self = this.object.getWorldPosition(this.selfWorld);
    let best: { x: number; z: number } | null = null;
    let bestDist = Infinity;
    for (const id of this.ctx.findByTag(this.param<string>("targetTag"))) {
      const target = this.ctx.getObject(id);
      if (!target || !target.visible) continue;
      const targetPos = target.getWorldPosition(this.targetWorld);
      const dx = targetPos.x - self.x;
      const dz = targetPos.z - self.z;
      const d = dx * dx + dz * dz;
      if (d < bestDist) {
        bestDist = d;
        best = { x: dx, z: dz };
      }
    }
    if (!best) {
      this.stopHorizontalMotion();
      this.play(this.param<string>("idleClip"));
      return;
    }

    const aggroRange = this.param<number>("aggroRange");
    if (bestDist > aggroRange * aggroRange) {
      this.stopHorizontalMotion();
      this.play(this.param<string>("idleClip"));
      return;
    }

    const len = Math.hypot(best.x, best.z) || 1;
    const speed = this.param<number>("speed");
    const vel = sim.getLinvel(this.entityId);
    if (!vel) return;
    sim.setLinvel(this.entityId, [(best.x / len) * speed, vel[1], (best.z / len) * speed]);
    this.play(this.param<string>("runClip"));

    // face movement (body rotations are locked; the visual is ours to steer)
    this.object.rotation.set(0, Math.atan2(best.x, best.z) + this.param<number>("modelYaw"), 0);
  }
}
