import { Script } from "@hitreg/scripting";

/**
 * Third-person character movement: camera-relative WASD, Space to jump, and
 * the model smoothly turns to face where it's running. Crossfades between
 * idle and run clips off its own velocity, so it needs no game-specific
 * wiring. Reads two runtime channels other scripts may set on
 * object.userData: speedMult (upgrades) and frozen (menus pause movement).
 */
export default class ThirdPersonController extends Script {
  static override scriptName = "third-person-controller";
  static override params = {
    speed: { default: 6.5, min: 0, max: 30 },
    jump: { default: 8, min: 0, max: 30, description: "jump velocity" },
    idleClip: { default: "Idle" },
    runClip: { default: "Run" },
    modelYaw: { default: 0, min: -3.1416, max: 3.1416, description: "extra yaw if the model faces backwards" },
    turnSpeed: { default: 14, min: 1, max: 40, description: "how snappily the character turns" },
    face: { default: "camera", description: "camera = always face the aim (strafe shooter); movement = face where you run" },
  };

  private yaw = 0;
  private lastClip = "";

  private play(clip: string, fade: number): void {
    if (this.lastClip === clip) return;
    this.lastClip = clip;
    this.ctx.setAnimation?.(clip, fade);
  }

  override onStart(): void {
    this.yaw = this.object.rotation.y;
    this.play(this.param<string>("idleClip"), 0.2);
  }

  override onFixedUpdate(dt: number): void {
    const sim = this.ctx.sim;
    if (!sim) return;
    const vel = sim.getLinvel(this.entityId);
    if (!vel) return;

    const ud = this.object.userData as { speedMult?: number; frozen?: boolean };
    if (ud.frozen) {
      sim.setLinvel(this.entityId, [0, vel[1], 0]);
      this.play(this.param<string>("idleClip"), 0.25);
      return;
    }

    const input = this.ctx.input;
    let forwardIn = 0;
    let strafeIn = 0;
    if (input.isDown("KeyW") || input.isDown("ArrowUp")) forwardIn += 1;
    if (input.isDown("KeyS") || input.isDown("ArrowDown")) forwardIn -= 1;
    if (input.isDown("KeyA") || input.isDown("ArrowLeft")) strafeIn -= 1;
    if (input.isDown("KeyD") || input.isDown("ArrowRight")) strafeIn += 1;

    // camera-relative when the host provides a view direction
    const [fx, fz] = this.ctx.viewForward?.() ?? [0, -1];
    const rx = -fz;
    const rz = fx;
    let x = fx * forwardIn + rx * strafeIn;
    let z = fz * forwardIn + rz * strafeIn;
    const len = Math.hypot(x, z);
    const speed = this.param<number>("speed") * (ud.speedMult ?? 1);
    if (len > 0) {
      x = (x / len) * speed;
      z = (z / len) * speed;
    }

    let vy = vel[1];
    const grounded = Math.abs(vy) < 0.05;
    if (input.isDown("Space") && grounded) vy = this.param<number>("jump");
    sim.setLinvel(this.entityId, [x, vy, z]);

    // steer the visual (body rotations are locked): shooter mode tracks the
    // camera aim even while strafing; movement mode faces where you run
    const faceCamera = this.param<string>("face") === "camera";
    if (faceCamera || len > 0) {
      const target = faceCamera
        ? Math.atan2(fx, fz) + this.param<number>("modelYaw")
        : Math.atan2(x, z) + this.param<number>("modelYaw");
      let diff = target - this.yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      this.yaw += diff * Math.min(1, this.param<number>("turnSpeed") * dt);
      this.object.rotation.set(0, this.yaw, 0);
    }

    this.play(
      len > 0 ? this.param<string>("runClip") : this.param<string>("idleClip"),
      len > 0 ? 0.15 : 0.25,
    );
  }
}
