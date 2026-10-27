import * as THREE from "three";
import { Script } from "./script.js";
import { pingPongProgress } from "./easing.js";

/** Metres of travel along a lift's line for `drop` down and `run` out. */
export function liftLength(drop: number, run: number): number {
  return Math.hypot(drop, run);
}

/** Where a lift deck is `t` seconds into its clock: 0 at the top landing, 1 at the bottom (pure; tests and tools use it). */
export function liftProgress(t: number, length: number, speed: number, dwell: number, phase: number): number {
  if (!(length > 0) || !(speed > 0)) return 0;
  return pingPongProgress(Math.max(0, t + phase), length / speed, Math.max(0, dwell));
}

/** Seconds one full lift cycle takes (down, wait, up, wait). */
export function liftCycle(length: number, speed: number, dwell: number): number {
  return length > 0 && speed > 0 ? 2 * (length / speed + Math.max(0, dwell)) : 0;
}

const scratch = new THREE.Vector3();
const scratch2 = new THREE.Vector3();
const scratchQ = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * A winch lift (Thunder Bluff's elevators): the body it sits on runs between its authored spot — the TOP
 * landing — and the bottom landing `drop` metres below and `run` metres out along its own facing (+Z), forever, at
 * `speed`, waiting `dwell` seconds at each end. Nobody calls it; it just runs. `run` 0 is a plumb shaft; a run makes
 * an inclined winch down a slope too steep to stand a shaft in front of. The body keeps its orientation.
 *
 * Put it on the DECK: an entity with `rigidbody.kind: "kinematic"` and a box collider whose top is the floor people
 * stand on (and on each railing body, same params: they share the clock, so they move as one). A deck carries
 * whatever stands on it (@hitreg/physics `carryRiders`), so a player rides with a ground-relative velocity of zero —
 * grounded, not falling.
 *
 * Multiplayer: the deck's place is a pure function of the shared simulation clock (a dedicated server's clients run
 * it on the server's clock), so every peer and the server compute the SAME deck and nothing is replicated —
 * `clockDriven` keeps it out of the implicit script+rigidbody replication, which would otherwise take the deck's
 * body off every client and drop the riders through it. Two lifts side by side alternate with `phase` = half of
 * {@link liftCycle}.
 *
 * Rope: descendants tagged `lift-rope` are aimed and stretched every rendered frame from where they hang on the deck
 * to `ropeTo` (the headframe's wheel; author a 1 m segment that grows along +Y from its origin).
 */
export class LiftScript extends Script {
  static override scriptName = "lift";
  /** Motion from the shared clock alone: every peer runs it, nothing replicates (see class doc). */
  static clockDriven = true;
  static override params = {
    drop: { default: 20, min: 0, max: 400, description: "Metres from the top landing (the deck's authored position) down to the bottom landing." },
    run: { default: 0, min: 0, max: 400, description: "Metres the deck also travels OUT along its own facing (+Z) on the way down: 0 = a plumb shaft; > 0 = an inclined winch down a slope (the deck stays level)." },
    speed: { default: 3, min: 0.2, max: 20, description: "Travel speed along the line, metres per second. 3 m/s is a brisk Thunder Bluff winch: a 60 m cliff is a 20 s ride." },
    dwell: { default: 6, min: 0, max: 120, description: "Seconds the deck waits at each landing for people to step on or off." },
    phase: { default: 0, min: 0, max: 3600, description: "Seconds added to the clock. A second lift beside the first alternates with it at half a cycle: (length / speed + dwell)." },
    ropeTo: { default: [0, 6, 0], description: "Where the rope ends (the headframe's wheel), metres from the deck's TOP position in the deck's own frame (+Y up, +Z its facing). Descendants tagged `lift-rope` are aimed and stretched to it each frame." },
  };

  private top = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private wheel = new THREE.Vector3();
  private ropes: THREE.Object3D[] = [];

  override onStart(): void {
    this.object.getWorldPosition(this.top);
    this.object.getWorldQuaternion(scratchQ);
    this.dir.set(0, -this.param<number>("drop"), this.param<number>("run")).applyQuaternion(scratchQ);
    const r = this.param<[number, number, number]>("ropeTo") ?? [0, 6, 0];
    this.wheel.set(r[0], r[1], r[2]).applyQuaternion(scratchQ).add(this.top);
    this.ropes = [];
    this.object.traverse((child) => {
      if (child === this.object) return;
      if (this.ctx.getEntity(child.name)?.tags.includes("lift-rope")) this.ropes.push(child);
    });
    this.drive();
  }

  override onFixedUpdate(): void {
    this.drive();
  }

  /** 0 at the top landing, 1 at the bottom, now. */
  progress(): number {
    return liftProgress(
      this.ctx.now() / 1000,
      liftLength(this.param<number>("drop"), this.param<number>("run")),
      this.param<number>("speed"),
      this.param<number>("dwell"),
      this.param<number>("phase"),
    );
  }

  private drive(): void {
    scratch.copy(this.dir).multiplyScalar(this.progress()).add(this.top);
    const sim = this.ctx.sim;
    if (sim?.setKinematicTarget) sim.setKinematicTarget(this.entityId, [scratch.x, scratch.y, scratch.z]);
    else {
      // no physics (an editor preview): move the object itself
      if (this.object.parent) this.object.parent.worldToLocal(scratch);
      this.object.position.copy(scratch);
    }
  }

  override onLateUpdate(): void {
    for (const rope of this.ropes) {
      const parent = rope.parent;
      if (!parent) continue;
      rope.getWorldPosition(scratch);
      scratch2.copy(this.wheel).sub(scratch);
      const length = scratch2.length();
      if (length < 0.01) continue;
      // aim +Y at the wheel in the parent's frame, then stretch the 1 m segment to reach it
      parent.getWorldQuaternion(scratchQ).invert();
      scratch2.applyQuaternion(scratchQ).normalize();
      rope.quaternion.setFromUnitVectors(UP, scratch2);
      rope.scale.set(1, length, 1);
    }
  }
}

/** Is this script class motion-from-the-clock (every peer runs it; never replicated, never suspended)? */
export function isClockDrivenScript(cls: unknown): boolean {
  return (cls as { clockDriven?: boolean } | undefined)?.clockDriven === true;
}
