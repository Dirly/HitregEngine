import * as THREE from "three/webgpu";
import { Script } from "@hitreg/scripting";

/**
 * Arcade helicopter flight model — third-person, mouse-steered like a flight
 * stick: the mouse sets the nose direction (yaw + pitch) directly, W/S is
 * throttle (forward/back speed along that nose), A/D is a side-slip strafe,
 * Space/Ctrl is the collective (vertical trim — release both and the craft
 * holds altitude), Shift boosts. Requires `camera.rig.mode: "chase"` in the
 * scene (the default "follow" rig owns the mouse for free orbit instead).
 *
 * Physics rotations are LOCKED (rigidbody.lockRotations) exactly like
 * third-person-controller.ts's steering: Rapier only ever reports the spawn
 * orientation back, so this script freely overwrites object.quaternion every
 * tick (roll is the one purely cosmetic axis — auto-banks off turn rate,
 * never fed back into velocity). Movement itself is real physics (setLinvel +
 * a box collider), so the craft still collides solidly with terrain/buildings.
 *
 * Exposes read/write state on object.userData for the job manager:
 *  - speed: current total speed (units/s), for HUD display
 *  - crashed: set true for one tick when a hard impact resets the craft
 *  - respawnPoint: [x,y,z] | undefined — job manager updates this when
 *    parked safely on a helipad; falls back to the spawn position.
 */
export default class HeliFlightController extends Script {
  static override scriptName = "heli-flight-controller";
  static override params = {
    maxSpeed: { default: 26, min: 5, max: 60, description: "units/sec, forward or backward" },
    accel: { default: 16, min: 1, max: 60, description: "how fast speed responds to throttle" },
    strafeSpeed: { default: 10, min: 0, max: 40, description: "units/sec, A/D side-slip" },
    mouseYawSens: { default: 0.0022, min: 0, max: 0.02, description: "radians per pixel of mouse X" },
    mousePitchSens: { default: 0.0018, min: 0, max: 0.02, description: "radians per pixel of mouse Y" },
    maxPitch: { default: 0.55, min: 0, max: 1.4, description: "nose up/down clamp, radians" },
    maxBank: { default: 0.6, min: 0, max: 1.4, description: "cosmetic bank into turns, radians" },
    climbRate: { default: 9, min: 1, max: 30, description: "units/sec vertical, collective trim" },
    verticalAccel: { default: 12, min: 1, max: 60 },
    boost: { default: 1.6, min: 1, max: 4, description: "Shift speed multiplier" },
    crashSpeed: { default: 17, min: 4, max: 60, description: "impact speed (units/sec) that counts as a crash" },
  };

  private yaw = 0;
  private pitch = 0;
  private roll = 0;
  private forwardSpeed = 0;
  private verticalTrim = 0;
  private spawnPoint: [number, number, number] = [0, 0, 0];
  private crashCooldownUntil = 0;
  private readonly quat = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, "YXZ");
  private readonly yawOnlyEuler = new THREE.Euler(0, 0, 0, "YXZ");
  private readonly forwardVec = new THREE.Vector3();
  private readonly rightVec = new THREE.Vector3();

  override onStart(): void {
    const p = this.object.position;
    this.spawnPoint = [p.x, p.y + 1, p.z];
    this.yaw = this.object.rotation.y;
    this.object.userData.speed = 0;
    this.object.userData.crashed = false;
  }

  override onCollision(otherId: string): void {
    const t = this.now();
    if (t < this.crashCooldownUntil) return;
    const other = this.ctx.getEntity(otherId.split(":")[0]!) ?? this.ctx.getEntity(otherId);
    if (other?.tags.includes("no-impact")) return;
    const impactSpeed = Math.hypot(this.forwardSpeed, this.verticalTrim);
    if (impactSpeed < this.param<number>("crashSpeed")) return;
    this.crash();
  }

  private now(): number {
    return this.ctx.now() / 1000;
  }

  private crash(): void {
    this.crashCooldownUntil = this.now() + 1.5;
    this.forwardSpeed = 0;
    this.verticalTrim = 0;
    this.pitch = 0;
    const respawn =
      (this.object.userData.respawnPoint as [number, number, number] | undefined) ?? this.spawnPoint;
    this.ctx.sim?.setPosition?.(this.entityId, respawn);
    this.object.userData.crashed = true;
    this.ctx.playSound?.();
  }

  override onFixedUpdate(dt: number): void {
    const sim = this.ctx.sim;
    if (!sim) return;

    if (this.object.userData.crashed) this.object.userData.crashed = false;

    if (this.object.position.y < -40) {
      this.crash();
      return;
    }

    const input = this.ctx.input;
    let throttleIn = 0;
    let strafeIn = 0;
    let climbIn = 0;
    if (input.isDown("KeyW") || input.isDown("ArrowUp")) throttleIn += 1;
    if (input.isDown("KeyS") || input.isDown("ArrowDown")) throttleIn -= 1;
    if (input.isDown("KeyD") || input.isDown("ArrowRight")) strafeIn += 1;
    if (input.isDown("KeyA") || input.isDown("ArrowLeft")) strafeIn -= 1;
    if (input.isDown("Space")) climbIn += 1;
    if (input.isDown("ControlLeft") || input.isDown("KeyC")) climbIn -= 1;
    const boosting = input.isDown("ShiftLeft") || input.isDown("ShiftRight");

    // mouse sets the nose direction directly (a flight-stick, not a camera orbit)
    const [dx, dy] = input.mouseDelta?.() ?? [0, 0];
    this.yaw -= dx * this.param<number>("mouseYawSens");
    const maxPitch = this.param<number>("maxPitch");
    this.pitch = Math.max(-maxPitch, Math.min(maxPitch, this.pitch - dy * this.param<number>("mousePitchSens")));

    const boost = boosting ? this.param<number>("boost") : 1;
    const maxSpeed = this.param<number>("maxSpeed") * boost;
    const accel = this.param<number>("accel");
    const targetForward = throttleIn * maxSpeed;
    this.forwardSpeed += (targetForward - this.forwardSpeed) * Math.min(1, accel * dt);

    const climbRate = this.param<number>("climbRate") * boost;
    const targetVertical = climbIn * climbRate;
    this.verticalTrim +=
      (targetVertical - this.verticalTrim) * Math.min(1, this.param<number>("verticalAccel") * dt);

    // auto-bank cosmetically off this tick's yaw input — never fed back into velocity
    const bankInput = Math.max(-1, Math.min(1, -dx / 8));
    const targetRoll = bankInput * this.param<number>("maxBank");
    this.roll += (targetRoll - this.roll) * Math.min(1, 5 * dt);

    // full pitch+yaw heading drives thrust (climbing while pitched up, like a real
    // stick); strafe stays yaw-only so side-slip never fights the pitch axis
    this.euler.set(this.pitch, this.yaw, 0);
    this.forwardVec.set(0, 0, -1).applyEuler(this.euler);
    this.yawOnlyEuler.set(0, this.yaw, 0);
    this.rightVec.set(1, 0, 0).applyEuler(this.yawOnlyEuler);

    sim.setLinvel(this.entityId, [
      this.forwardVec.x * this.forwardSpeed + this.rightVec.x * strafeIn * this.param<number>("strafeSpeed"),
      this.forwardVec.y * this.forwardSpeed + this.verticalTrim,
      this.forwardVec.z * this.forwardSpeed + this.rightVec.z * strafeIn * this.param<number>("strafeSpeed"),
    ]);

    this.euler.set(this.pitch, this.yaw, this.roll);
    this.quat.setFromEuler(this.euler);
    this.object.quaternion.copy(this.quat);

    this.object.userData.speed = Math.hypot(this.forwardSpeed, this.verticalTrim);
  }
}
