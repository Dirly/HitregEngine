import { Script } from "@hitreg/scripting";

export default class Wanderer extends Script {
  static override scriptName = "wanderer";
  static override params = {
    radius: { default: 4, min: 0, max: 30 },
    speed: { default: 1.2, min: 0, max: 10 },
    idleClip: { default: "Idle" },
    walkClip: { default: "Walk" },
    waitSeconds: { default: 1.5, min: 0, max: 10 },
    moveSeconds: { default: 2.5, min: 0.2, max: 10 },
    modelYaw: { default: 0, min: -3.1416, max: 3.1416 },
  };

  private home: [number, number] = [0, 0];
  private target: [number, number] = [0, 0];
  private nextSwitchAt = 0;
  private moving = false;
  private clip = "";
  private seed = 1;

  override onStart(): void {
    this.home = [this.object.position.x, this.object.position.z];
    this.seed = [...this.entityId].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 2166136261);
    this.pickTarget();
    this.play(this.param<string>("idleClip"));
  }

  private play(clip: string): void {
    if (!clip || this.clip === clip) return;
    this.clip = clip;
    this.ctx.setAnimation?.(clip, 0.25);
  }

  private pickTarget(): void {
    const angle = this.rand() * Math.PI * 2;
    const dist = this.rand() * this.param<number>("radius");
    this.target = [
      this.home[0] + Math.cos(angle) * dist,
      this.home[1] + Math.sin(angle) * dist,
    ];
  }

  private rand(): number {
    this.seed = (1664525 * this.seed + 1013904223) >>> 0;
    return this.seed / 0x100000000;
  }

  override onFixedUpdate(): void {
    const sim = this.ctx.sim;
    if (!sim) return;

    const now = this.ctx.now() / 1000;
    const vel = sim.getLinvel(this.entityId);
    if (!vel) return;

    if (now >= this.nextSwitchAt) {
      this.moving = !this.moving;
      this.nextSwitchAt =
        now + (this.moving ? this.param<number>("moveSeconds") : this.param<number>("waitSeconds"));
      if (this.moving) this.pickTarget();
    }

    if (!this.moving) {
      sim.setLinvel(this.entityId, [0, vel[1], 0]);
      this.play(this.param<string>("idleClip"));
      return;
    }

    const dx = this.target[0] - this.object.position.x;
    const dz = this.target[1] - this.object.position.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.4) {
      this.moving = false;
      this.nextSwitchAt = now + this.param<number>("waitSeconds");
      sim.setLinvel(this.entityId, [0, vel[1], 0]);
      this.play(this.param<string>("idleClip"));
      return;
    }

    const speed = this.param<number>("speed");
    sim.setLinvel(this.entityId, [(dx / len) * speed, vel[1], (dz / len) * speed]);
    this.object.rotation.set(0, Math.atan2(dx, dz) + this.param<number>("modelYaw"), 0);
    this.play(this.param<string>("walkClip"));
  }
}
