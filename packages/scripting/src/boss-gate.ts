import * as THREE from "three";
import { readTarget } from "@hitreg/core";
import { Script } from "./script.js";

/**
 * How far open a boss gate is (0 shut .. 1 open), on the shared clock. Eased in and out.
 */
export function bossGateProgress(openedAtSec: number | null, nowSec: number, seconds: number): number {
  if (openedAtSec === null || !Number.isFinite(openedAtSec)) return 0;
  if (!(seconds > 0)) return 1;
  const t = Math.max(0, Math.min(1, (nowSec - openedAtSec) / seconds));
  return t * t * (3 - 2 * t);
}

/** The netState key that latches a gate open: the shared-clock second it began to open. */
export const bossGateKey = (entityId: string): string => `boss-gate/${entityId}.openedAt`;
export const bossGateCloseKey = (entityId: string): string => `boss-gate/${entityId}.closedAt`;

const scratch = new THREE.Vector3();

/**
 * A gate that stays shut until a boss dies, then rises or sinks (a portcullis, sealed slab, or wall of bone):
 * the "beat the boss to go on" door of a dungeon.
 *
 * Put it on the GATE body: an entity with `rigidbody.kind: "kinematic"` and a box collider filling the doorway, its
 * art as children. While `combat/<boss>.dead` (the combat netState convention) is not true the gate stands where it
 * was authored. The first time the authority sees the boss dead it writes the shared-clock second into
 * `boss-gate/<entity>.openedAt`, and from then on every peer moves the gate `drop` metres over `seconds`. The latch
 * never clears, so a boss that respawns does not shut the way again and a player joining later finds it open.
 * Arena entrances can start open and close on the boss AI's actual target acquisition. Optional evade recovery
 * re-arms only that entrance; ordinary progression/reward gates remain shut until victory.
 *
 * Multiplayer: the gate's place is a pure function of that replicated key and the shared clock, so every peer and the
 * server compute the same gate and nothing else is replicated (`clockDriven`, like the lift).
 */
export class BossGateScript extends Script {
  static override scriptName = "boss-gate";
  /** Motion from netState + the shared clock: every peer runs it, the body is never replicated. */
  static clockDriven = true;
  static override params = {
    boss: { default: "", description: "Entity id of the boss (its combat netState key, `combat/<boss>.dead`). Empty = the gate never opens." },
    drop: { default: 8, min: 0, max: 100, description: "Metres the gate travels when it opens (at least its full height to clear the passage)." },
    direction: { default: "down", description: "Opening direction: down sinks a slab into the floor; up raises a portcullis. Art and collision move together." },
    slide: { default: [0, 0, 0], description: "World-space metres the gate travels when it opens, as [x, y, z]. Any non-zero value replaces drop/direction: a stockade gate dragged aside along its fence line instead of sinking or rising. Art and collision move together." },
    seconds: { default: 4, min: 0, max: 60, description: "Seconds the gate takes to open." },
    closeOnAggro: { default: false, description: "Arena entrance: starts open, then closes when target/<boss>.primary contains a target id (actual MobBrain engagement, read through the shared target contract). Walking into the room alone never closes it. Boss defeat permanently opens it, including for late joiners." },
    closeSeconds: { default: 2.5, min: 0, max: 60, description: "Seconds an entrance gate takes to close after boss aggro. Motion remains continuous if the boss dies during closure." },
    resetOnEvade: { default: false, description: "Aggro gate only: reopen and re-arm after the living boss has no target for resetSeconds, allowing another attempt after a wipe/evade. Other gates stay shut until defeat. Victory is never reset." },
    resetSeconds: { default: 5, min: 0, max: 120, description: "Continuous time the boss must remain disengaged before its entrance re-arms. A brief target switch cannot reopen the arena." },
  };

  private top = new THREE.Vector3();
  private disengagedSince: number | null = null;

  override onStart(): void {
    // A script reload can see the body already raised. Its authored pose is
    // the shut anchor; reading the animated pose would add the rise twice.
    const authored = this.ctx.getEntity(this.entityId)?.components.transform as { position?: number[] } | undefined;
    if (authored?.position) {
      this.top.fromArray(authored.position);
      this.object.parent?.localToWorld(this.top);
    } else this.object.getWorldPosition(this.top);
    this.drive();
  }

  override onFixedUpdate(): void {
    const ns = this.ctx.netState, boss = this.param<string>("boss");
    if (ns && ns.isAuthority() && boss && ns.get(bossGateKey(this.entityId)) === undefined && ns.get(`combat/${boss}.dead`) === true) {
      ns.set(bossGateKey(this.entityId), this.ctx.now() / 1000);
    }
    if (ns?.isAuthority() && this.param<boolean>("closeOnAggro") && ns.get(bossGateKey(this.entityId)) === undefined) {
      const now = this.ctx.now() / 1000, key = bossGateCloseKey(this.entityId);
      const target = boss ? readTarget(ns, boss).primary : null;
      if (typeof target === "string" && target.length > 0) {
        this.disengagedSince = null;
        if (ns.get(key) === undefined) ns.set(key, now);
      } else if (this.param<boolean>("resetOnEvade") && typeof ns.get(key) === "number") {
        this.disengagedSince ??= now;
        if (now - this.disengagedSince >= this.param<number>("resetSeconds")) {
          ns.delete(key); this.disengagedSince = null;
        }
      }
    }
    this.drive();
  }

  /** 0 shut .. 1 open, now. */
  progress(): number {
    const at = this.ctx.netState?.get(bossGateKey(this.entityId));
    const now = this.ctx.now() / 1000;
    const from = this.closedProgress(typeof at === "number" ? at : now);
    return typeof at === "number" ? from + (1 - from) * bossGateProgress(at, now, this.param<number>("seconds")) : from;
  }

  private closedProgress(now: number): number {
    if (!this.param<boolean>("closeOnAggro")) return 0;
    const at = this.ctx.netState?.get(bossGateCloseKey(this.entityId));
    return 1 - bossGateProgress(typeof at === "number" ? at : null, now, this.param<number>("closeSeconds"));
  }

  private drive(): void {
    scratch.copy(this.top);
    const slide = this.param<number[]>("slide"), p = this.progress();
    if (Array.isArray(slide) && slide.length === 3 && slide.some((v) => v !== 0)) { scratch.x += slide[0]! * p; scratch.y += slide[1]! * p; scratch.z += slide[2]! * p; }
    else scratch.y += (this.param<string>("direction") === "up" ? 1 : -1) * this.param<number>("drop") * p;
    const sim = this.ctx.sim;
    if (sim?.setKinematicTarget) sim.setKinematicTarget(this.entityId, [scratch.x, scratch.y, scratch.z]);
    else {
      if (this.object.parent) this.object.parent.worldToLocal(scratch);
      this.object.position.copy(scratch);
    }
  }
}
