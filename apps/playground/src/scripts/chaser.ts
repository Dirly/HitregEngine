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
  };

  private animStarted = false;

  override onFixedUpdate(): void {
    const sim = this.ctx.sim;
    if (!sim) return;

    if (!this.animStarted) {
      this.ctx.setAnimation?.(this.param<string>("runClip"), 0.2);
      this.animStarted = true;
    }

    // nearest target
    const self = this.object.position;
    let best: { x: number; z: number } | null = null;
    let bestDist = Infinity;
    for (const id of this.ctx.findByTag(this.param<string>("targetTag"))) {
      const target = this.ctx.getObject(id);
      if (!target || !target.visible) continue;
      const dx = target.position.x - self.x;
      const dz = target.position.z - self.z;
      const d = dx * dx + dz * dz;
      if (d < bestDist) {
        bestDist = d;
        best = { x: dx, z: dz };
      }
    }
    if (!best) return;

    const len = Math.hypot(best.x, best.z) || 1;
    const speed = this.param<number>("speed");
    const vel = sim.getLinvel(this.entityId);
    if (!vel) return;
    sim.setLinvel(this.entityId, [(best.x / len) * speed, vel[1], (best.z / len) * speed]);

    // face movement (body rotations are locked; the visual is ours to steer)
    this.object.rotation.set(0, Math.atan2(best.x, best.z), 0);
  }
}
