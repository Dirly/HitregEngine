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
    let x = 0;
    let z = 0;
    if (input.isDown("KeyW") || input.isDown("ArrowUp")) z -= 1;
    if (input.isDown("KeyS") || input.isDown("ArrowDown")) z += 1;
    if (input.isDown("KeyA") || input.isDown("ArrowLeft")) x -= 1;
    if (input.isDown("KeyD") || input.isDown("ArrowRight")) x += 1;
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
    console.log(`[collectible] ${this.entityId} collected by ${otherId}`);
  }
}

export function registerBuiltinScripts(registry: ScriptRegistry): void {
  registry.register(Spinner);
  registry.register(Oscillator);
  registry.register(PlayerController);
  registry.register(Collectible);
}
