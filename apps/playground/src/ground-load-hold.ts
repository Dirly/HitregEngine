import type { PhysicsSim } from "@hitreg/physics";

/** Keep prediction above ground that is still loading, including when no frames are rendered. */
export class GroundLoadHold {
  private held: { id: string; y: number } | null = null;

  reset(): void { this.held = null; }

  update(sim: Pick<PhysicsSim, "getPosition" | "setTranslation" | "getLinvel" | "setLinvel">,
    id: string | null, isLoaded: (x: number, z: number) => boolean): void {
    const p = id ? sim.getPosition(id) : null;
    if (!id || !p || isLoaded(p[0], p[2])) {
      this.held = null;
      return;
    }
    if (!this.held || this.held.id !== id) this.held = { id, y: p[1] };
    // An authoritative teleport or respawn can put the body higher while waiting.
    this.held.y = Math.max(this.held.y, p[1]);
    if (p[1] < this.held.y) sim.setTranslation(id, [p[0], this.held.y, p[2]]);
    const velocity = sim.getLinvel(id);
    if (velocity && velocity[1] < 0) sim.setLinvel(id, [velocity[0], 0, velocity[2]]);
  }
}
