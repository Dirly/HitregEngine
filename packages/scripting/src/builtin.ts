import { Script } from "./script.js";
import type { ScriptRegistry } from "./registry.js";

/**
 * The standard interaction vocabulary, v1. Most gameplay requests should
 * resolve to attaching one of these with params — code is the escape hatch.
 */

class Spinner extends Script {
  static override scriptName = "spinner";
  static override params = {
    speed: { default: 1.5, min: -10, max: 10, description: "radians/sec around local Y" },
  };

  override onFixedUpdate(dt: number): void {
    this.object.rotateY(this.param<number>("speed") * dt);
  }
}

class Oscillator extends Script {
  static override scriptName = "oscillator";
  static override params = {
    axis: { default: [0, 1, 0], description: "movement direction" },
    amplitude: { default: 1, min: 0, max: 20 },
    period: { default: 2, min: 0.1, max: 60, description: "seconds per cycle" },
  };

  private origin: [number, number, number] = [0, 0, 0];

  override onStart(): void {
    const p = this.object.position;
    this.origin = [p.x, p.y, p.z];
  }

  override onFixedUpdate(): void {
    // visual/kinematic motion — pair with a physics body only if kinematic
    const axis = this.param<[number, number, number]>("axis");
    const offset =
      Math.sin((this.ctx.now() / 1000 / this.param<number>("period")) * Math.PI * 2) *
      this.param<number>("amplitude");
    this.object.position.set(
      this.origin[0] + axis[0] * offset,
      this.origin[1] + axis[1] * offset,
      this.origin[2] + axis[2] * offset,
    );
  }
}

class PlayerController extends Script {
  static override scriptName = "player-controller";
  static override params = {
    speed: { default: 6, min: 0, max: 30 },
    jump: { default: 7, min: 0, max: 30, description: "jump velocity" },
  };

  override onFixedUpdate(): void {
    const sim = this.ctx.sim;
    if (!sim) return;
    const vel = sim.getLinvel(this.entityId);
    if (!vel) return;

    const input = this.ctx.input;
    let forwardIn = 0;
    let strafeIn = 0;
    if (input.isDown("KeyW") || input.isDown("ArrowUp")) forwardIn += 1;
    if (input.isDown("KeyS") || input.isDown("ArrowDown")) forwardIn -= 1;
    if (input.isDown("KeyA") || input.isDown("ArrowLeft")) strafeIn -= 1;
    if (input.isDown("KeyD") || input.isDown("ArrowRight")) strafeIn += 1;

    // camera-relative when the host provides a view direction; world axes otherwise
    const [fx, fz] = this.ctx.viewForward?.() ?? [0, -1];
    const rx = -fz; // right = forward rotated -90° about Y
    const rz = fx;
    let x = fx * forwardIn + rx * strafeIn;
    let z = fz * forwardIn + rz * strafeIn;
    const len = Math.hypot(x, z);
    const speed = this.param<number>("speed");
    if (len > 0) {
      x = (x / len) * speed;
      z = (z / len) * speed;
    }

    let vy = vel[1];
    // crude grounded check: vertical velocity near zero
    if (input.isDown("Space") && Math.abs(vy) < 0.05) {
      vy = this.param<number>("jump");
    }
    sim.setLinvel(this.entityId, [x, vy, z]);
  }
}

class Collectible extends Script {
  static override scriptName = "collectible";
  static override params = {
    collectorTag: { default: "player", description: "tag that may collect this" },
  };

  private collected = false;

  override onCollision(otherId: string): void {
    if (this.collected) return;
    const other = this.ctx.getEntity(otherId.split(":")[0]!) ?? this.ctx.getEntity(otherId);
    if (!other?.tags.includes(this.param<string>("collectorTag"))) return;
    this.collected = true;
    this.object.visible = false;
    this.ctx.playSound?.();
    console.log(`[collectible] ${this.entityId} collected by ${otherId}`);
  }
}

/**
 * Moving platform: ping-pongs between its start and start+`distance` at a
 * constant `speed`, pausing `dwell` seconds at each end. Kinematic (drives
 * the transform directly, like Oscillator) — pair with a kinematic rigidbody
 * so riders are carried. Motion is a pure function of accumulated sim time,
 * so it never drifts and replays identically on every client.
 */
class PlatformMover extends Script {
  static override scriptName = "platform-mover";
  static override params = {
    distance: { default: [0, 3, 0], description: "offset from start to the far end" },
    speed: { default: 2, min: 0, max: 50, description: "units/sec along the path" },
    dwell: { default: 1, min: 0, max: 60, description: "seconds paused at each end" },
  };

  private origin: [number, number, number] = [0, 0, 0];

  override onStart(): void {
    const p = this.object.position;
    this.origin = [p.x, p.y, p.z];
  }

  override onFixedUpdate(): void {
    const d = this.param<[number, number, number]>("distance");
    const length = Math.hypot(d[0], d[1], d[2]);
    const speed = this.param<number>("speed");
    if (length === 0 || speed === 0) return; // degenerate: nowhere to go
    const travel = length / speed; // seconds for one A→B leg
    const dwell = this.param<number>("dwell");
    const cycle = 2 * (travel + dwell);
    const u = (this.ctx.now() / 1000) % cycle;
    let s: number; // 0 at A, 1 at B
    if (u < dwell) s = 0;
    else if (u < dwell + travel) s = (u - dwell) / travel;
    else if (u < 2 * dwell + travel) s = 1;
    else s = 1 - (u - 2 * dwell - travel) / travel;
    this.object.position.set(
      this.origin[0] + d[0] * s,
      this.origin[1] + d[1] * s,
      this.origin[2] + d[2] * s,
    );
  }
}

/**
 * Proximity door: opens while any entity tagged `openerTag` is within `range`
 * and closes when they leave, easing `open` 0→1 at `speed`/sec. Opening
 * slides by `move` and/or spins by `rotateY` degrees about local Y. Pure
 * transform animation — no physics, no events — so it is trivially authored
 * ("make this a door the player opens") and multiplayer-correct by suspension.
 */
class Door extends Script {
  static override scriptName = "door";
  static override params = {
    openerTag: { default: "player", description: "tag that opens the door when near" },
    range: { default: 3, min: 0, max: 50, description: "open when an opener is within this" },
    move: { default: [0, 3, 0], description: "slide offset when fully open" },
    rotateY: { default: 0, min: -180, max: 180, description: "spin (deg) about Y when open" },
    speed: { default: 3, min: 0.1, max: 20, description: "open/close rate (fraction/sec)" },
  };

  private origin: [number, number, number] = [0, 0, 0];
  private originYaw = 0;
  private open = 0;

  override onStart(): void {
    const p = this.object.position;
    this.origin = [p.x, p.y, p.z];
    this.originYaw = this.object.rotation.y;
  }

  override onFixedUpdate(dt: number): void {
    const target = this.anyOpenerNear() ? 1 : 0;
    const step = this.param<number>("speed") * dt;
    // ease toward the target, clamped so it settles exactly at 0 or 1
    if (this.open < target) this.open = Math.min(target, this.open + step);
    else if (this.open > target) this.open = Math.max(target, this.open - step);

    const move = this.param<[number, number, number]>("move");
    this.object.position.set(
      this.origin[0] + move[0] * this.open,
      this.origin[1] + move[1] * this.open,
      this.origin[2] + move[2] * this.open,
    );
    const yaw = (this.param<number>("rotateY") * Math.PI) / 180;
    this.object.rotation.y = this.originYaw + yaw * this.open;
  }

  private anyOpenerNear(): boolean {
    const range = this.param<number>("range");
    const rangeSq = range * range;
    // measure from the REST position, never the animated one — otherwise the
    // door slides out of its own range as it opens and oscillates
    const [hx, hy, hz] = this.origin;
    for (const id of this.ctx.findByTag(this.param<string>("openerTag"))) {
      if (id === this.entityId) continue;
      const other = this.ctx.getObject(id);
      if (!other) continue;
      const dx = other.position.x - hx;
      const dy = other.position.y - hy;
      const dz = other.position.z - hz;
      if (dx * dx + dy * dy + dz * dz <= rangeSq) return true;
    }
    return false;
  }
}

/**
 * Face-target: yaws to look at the nearest entity tagged `targetTag`
 * (turrets, security cameras, NPCs tracking the player). `turnSpeed` 0 snaps
 * instantly; otherwise it eases at that many radians/sec along the shortest
 * arc. `range` 0 means unlimited; a positive range ignores targets farther
 * than that (and holds the last heading). Yaw-only — the entity stays upright.
 */
class FaceTarget extends Script {
  static override scriptName = "face-target";
  static override params = {
    targetTag: { default: "player", description: "tag of the entity to face" },
    range: { default: 0, min: 0, max: 500, description: "0 = unlimited; else max look distance" },
    turnSpeed: { default: 0, min: 0, max: 20, description: "rad/sec (0 = instant snap)" },
  };

  override onFixedUpdate(dt: number): void {
    const target = this.nearestTarget();
    if (!target) return; // nobody in range — hold heading
    const here = this.object.position;
    const dx = target[0] - here.x;
    const dz = target[2] - here.z;
    if (dx === 0 && dz === 0) return; // directly above/below — yaw undefined
    // default forward is local -Z; this yaw points it at (dx, dz)
    const desired = Math.atan2(-dx, -dz);
    const turnSpeed = this.param<number>("turnSpeed");
    if (turnSpeed <= 0) {
      this.object.rotation.y = desired;
      return;
    }
    // shortest-arc ease toward the desired heading
    let delta = desired - this.object.rotation.y;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta)); // wrap to [-π, π]
    const maxStep = turnSpeed * dt;
    this.object.rotation.y +=
      Math.abs(delta) <= maxStep ? delta : Math.sign(delta) * maxStep;
  }

  private nearestTarget(): [number, number, number] | null {
    const range = this.param<number>("range");
    const rangeSq = range > 0 ? range * range : Infinity;
    const here = this.object.position;
    let best: [number, number, number] | null = null;
    let bestSq = rangeSq;
    for (const id of this.ctx.findByTag(this.param<string>("targetTag"))) {
      if (id === this.entityId) continue;
      const other = this.ctx.getObject(id);
      if (!other) continue;
      const dx = other.position.x - here.x;
      const dy = other.position.y - here.y;
      const dz = other.position.z - here.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq <= bestSq) {
        bestSq = distSq;
        best = [other.position.x, other.position.y, other.position.z];
      }
    }
    return best;
  }
}

/**
 * Damageable: hit points that drop when a collider tagged `hazardTag` touches
 * this entity (spikes, lava, projectiles), with `invulnMs` i-frames between
 * hits so one contact isn't billed every tick. Drives this entity's health
 * billboard (fill = hp/maxHp) if it has one, and hides the entity at 0 hp.
 *
 * Self-contained and LOCAL, exactly like `collectible` — no networked combat
 * contract is presumed here (that stays game-specific, e.g. cube-rpg's
 * authority-validated npc.hit). Good as a single-player / local hazard
 * primitive; graduate to a networked version when the combat model is settled.
 */
class Damageable extends Script {
  static override scriptName = "damageable";
  static override params = {
    maxHp: { default: 100, min: 1, max: 100000 },
    hazardTag: { default: "hazard", description: "colliders with this tag deal damage" },
    damagePerHit: { default: 10, min: 0, max: 100000 },
    invulnMs: { default: 500, min: 0, max: 10000, description: "i-frames between hits" },
  };

  private hp = 0;
  private invulnerable = false;

  override onStart(): void {
    this.hp = this.param<number>("maxHp");
    this.ctx.setBillboard?.({ fill: 1 });
  }

  override onCollision(otherId: string): void {
    if (this.invulnerable || this.hp <= 0) return;
    // colliders can be sub-entities ("id:childIndex") — resolve the root too
    const other = this.ctx.getEntity(otherId.split(":")[0]!) ?? this.ctx.getEntity(otherId);
    if (!other?.tags.includes(this.param<string>("hazardTag"))) return;

    this.hp = Math.max(0, this.hp - this.param<number>("damagePerHit"));
    this.ctx.setBillboard?.({ fill: this.hp / this.param<number>("maxHp") });

    if (this.hp <= 0) {
      this.object.visible = false;
      return;
    }
    // i-frames: use the sim-stepped timer, not wall-clock, so it replays
    const invulnMs = this.param<number>("invulnMs");
    if (invulnMs > 0) {
      this.invulnerable = true;
      this.ctx.after(invulnMs / 1000, () => {
        this.invulnerable = false;
      });
    }
  }
}

export function registerBuiltinScripts(registry: ScriptRegistry): void {
  registry.register(Spinner);
  registry.register(Oscillator);
  registry.register(PlayerController);
  registry.register(Collectible);
  registry.register(PlatformMover);
  registry.register(Door);
  registry.register(FaceTarget);
  registry.register(Damageable);
}
