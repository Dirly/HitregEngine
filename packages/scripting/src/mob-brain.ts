import type * as THREE from "three";
import {
  MOB_EVENTS,
  ThreatTable,
  combatKey,
  combatants,
  isLanding,
  mobEventDecls,
  type MobState,
} from "@hitreg/core";
import { Script, type ScriptEventDecl } from "./script.js";

/** `mob.threat` as this script reads it (the schema is in core). */
interface ThreatPayload {
  mobId: string;
  sourceId: string;
  amount?: number;
  kind?: "add" | "set" | "taunt";
  seconds?: number;
}

/** `mob.alert` as this script reads it. */
interface AlertPayload {
  mobId: string;
  targetId: string;
  at?: [number, number, number];
  radius?: number;
  faction?: string;
}
import { TerrainSteering, groundHeightAt, LAYER_WORLD, LAYER_PROP, LAYER_TERRAIN } from "./steering.js";

/**
 * The standard enemy: stands somewhere, notices you, comes after you, gives up
 * and goes home.
 *
 * This is deliberately the whole of it. A mob brain decides WHERE A BODY GOES
 * and WHEN IT WANTS TO SWING; it never decides what a swing does, how much it
 * hurts, what it drops or who hates whom. Damage, abilities, cooldowns, threat
 * and loot are the game's, and a brain that reached into any of them would be
 * a game script wearing an engine badge. So it emits `mob.attack` and the
 * game's combat layer bridges it — three lines — onto whatever a cast means
 * there (see `@hitreg/core`'s `mobEventDecls`).
 *
 * ## How it moves
 *
 * Through the controller's `impulseVel` channel, never by writing velocity:
 * `third-person-controller` (and the server's player mover) would stomp a
 * direct `setLinvel` on its very next tick, which is the single most confusing
 * way for an AI to "not work". Driving that channel also keeps mobs and
 * players on ONE movement path, so a mob picks its gait clip off measured
 * velocity exactly as a player does and never animates like something else.
 *
 * The channel is held even while standing still (a zero impulse) — a body that
 * stops writing it hands itself back to whatever else is driving.
 *
 * Direction comes from {@link TerrainSteering}, which probes the live physics
 * world: it walks up hills, around boulders and NOT off cliffs, with no
 * navmesh to bake and nothing to invalidate when a chunk streams in or a river
 * gets carved. It is local, though — it slides around obstacles, it does not
 * plan around a mountain. That is why the leash matters.
 *
 * ## The leash is the contract
 *
 * `SpawnAreaManager` hands every NPC it spawns `home`, `leash` and `roam` as
 * params, and fences anything 1.5x past its leash straight back home with a
 * warning. That fence is a BACKSTOP for a broken brain, not a mechanism: this
 * script is what is supposed to keep a pack in its own zone, because a pack
 * dragged across a zone border is a pack standing in the transfer band, and
 * `clearToTransfer` then refuses to move players through it.
 *
 * ## Where it runs
 *
 * On the session authority only. A peer's copy of an NPC is net-suspended by
 * the runtime, so its brain is not ticking; the `isAuthority` check here is
 * insurance and documentation, not the mechanism.
 */
export class MobBrain extends Script {
  static override scriptName = "mob-brain";
  static override events: ScriptEventDecl[] = [...mobEventDecls];

  static override params = {
    actor: {
      default: "",
      description:
        "Entity id of the BODY this steers (the thing with the rigidbody). Empty = this entity. " +
        "A character is two entities — body with the scripts, model on a child — so a brain " +
        "living on the model child names its body here.",
    },
    home: {
      default: [] as number[],
      description:
        "World point the mob belongs to, [x, y, z]. Empty = wherever it stood at onStart. " +
        "`spawnArea` components write this (with `leash` and `roam`) when they spawn a pack.",
    },
    leash: {
      default: 30,
      min: 0,
      max: 500,
      description:
        "Metres from home it will chase before giving up and walking back. Keep it inside the " +
        "zone: a pack dragged over a border stands in the transfer band and blocks players moving " +
        "between layers.",
    },
    roam: {
      default: 6,
      min: 0,
      max: 200,
      description: "Radius it wanders inside while idle. 0 = stands still (a guard, a boss).",
    },
    roamPause: {
      default: 6,
      min: 0.5,
      max: 120,
      description: "Average seconds between wander destinations (jittered per mob so a pack does not march in step).",
    },
    spawnArea: {
      default: "",
      description: "Id of the spawnArea that owns this mob. Informational — written by the spawner, read by tools.",
    },
    targetTags: {
      default: "player",
      description: "Comma-separated entity tags it treats as enemies. Faction rules are the game's; this is the engine's blunt version.",
    },
    aggroRange: { default: 16, min: 0, max: 300, description: "Metres at which it notices a target." },
    deaggroRange: {
      default: 26,
      min: 0,
      max: 400,
      description:
        "Metres at which it loses one it already has. Must exceed aggroRange — the gap IS the hysteresis, " +
        "and without it a target standing on the boundary makes the mob flicker in and out of combat.",
    },
    attackRange: { default: 2.4, min: 0.5, max: 100, description: "Metres at which it stops closing and starts swinging." },
    preferredRange: {
      default: 0,
      min: 0,
      max: 100,
      description:
        "Distance a RANGED mob tries to hold. 0 = melee (closes to attackRange and stays there). " +
        "Set it near attackRange for an archer that backs off when you walk into it.",
    },
    attackInterval: { default: 1.8, min: 0.1, max: 120, description: "Seconds between attack requests." },
    attackJitter: { default: 0.5, min: 0, max: 30, description: "Random seconds added to each interval, so a pack does not swing in unison." },
    abilities: {
      default: "",
      description: "Comma-separated ability ids, one picked at random per swing and passed through in `mob.attack`. Empty = the game decides.",
    },
    speed: { default: 4.2, min: 0, max: 30, description: "Chase speed (m/s)." },
    roamSpeed: { default: 1.6, min: 0, max: 30, description: "Wander/return speed (m/s) — a walk, so a returning mob reads as disengaged." },
    requireLineOfSight: {
      default: true,
      description: "Do not aggro through walls and hills. Costs one raycast per steering tick, and only for the nearest candidate.",
    },
    eyeHeight: { default: 1.6, min: 0, max: 10, description: "Height above the body's origin that sight is traced from." },
    steerHz: {
      default: 8,
      min: 1,
      max: 60,
      description:
        "Times per second it re-decides where to go. The drive channel is written every tick regardless, so " +
        "lowering this makes a mob think less often, not move choppily — the lever to pull when a layer has too many mobs.",
    },
    radius: { default: 0.45, min: 0.05, max: 5, description: "Body radius, for obstacle probes and packmate spacing." },
    separation: {
      default: 0.9,
      min: 0,
      max: 10,
      description: "Metres of personal space kept from packmates so a pack arrives as a pack, not as one body. 0 = off.",
    },
    stepUp: { default: 0.6, min: 0, max: 5, description: "Rise it walks up without treating it as a slope at all." },
    maxSlope: { default: 50, min: 5, max: 89, description: "Steepest grade it will climb, in degrees." },
    maxDrop: { default: 2.5, min: 0, max: 100, description: "Deepest drop it will walk off. Low values keep mobs off cliffs; high ones let them follow you down." },
    returnHeal: {
      default: true,
      description:
        "Restore hp to maxHp on getting home after a leash. The anti-kite rule every MMO has: " +
        "only writes when the game already publishes combat/<id>.hp and .maxHp.",
    },
    faction: {
      default: "",
      description:
        "Who it fights for, published to combat/<id>.faction. A DIFFERENT published faction is an enemy and the " +
        "same one never is — so goblins and dwarves are at war without anyone writing a matrix, and neither has to " +
        "be tagged. Empty = fall back to targetTags entirely.",
    },
    hostileTo: {
      default: "",
      description:
        "Comma-separated factions this one attacks. Empty = every faction but its own, which is what you want " +
        "until three-way politics exist. Ignored when `faction` is empty.",
    },
    alertRadius: {
      default: 10,
      min: 0,
      max: 200,
      description:
        "Metres its shout carries when it pulls: packmates of the same faction inside this take the same target. " +
        "0 = fights alone. This is what makes a camp a camp rather than five things queueing up to die.",
    },
    threatHalfLife: {
      default: 12,
      min: 0,
      max: 600,
      description:
        "Seconds for threat to halve. The whole feel knob: short and it turns on whoever hit it last, long and the " +
        "first person to commit holds it all fight. 0 = threat never decays.",
    },
  };

  private steering!: TerrainSteering;
  private actorId = "";
  private body: THREE.Object3D | undefined;
  private state: MobState = "idle";
  private targetId = "";
  private home: [number, number, number] = [0, 0, 0];
  private tags: string[] = [];
  private choices: string[] = [];
  private dir: [number, number] = [0, 0];
  private moveSpeed = 0;
  private lastSteerAt = 0;
  private nextAttackAt = 0;
  private roamTarget: [number, number] | null = null;
  private nextRoamAt = 0;
  private faceYaw: number | null = null;
  /** Deterministic per-mob jitter: same body, same rhythm, every run. */
  private phase = 0;
  private threat!: ThreatTable;
  private faction = "";
  private hostileTo: string[] = [];
  /** Target the pack has already been shouted at about, so a pull shouts once. */
  private alertedFor = "";
  /** Ids worth considering, refreshed at 1 Hz — see `candidates`. */
  private candidateCache: string[] = [];
  private candidatesAt = -Infinity;

  override onStart(): void {
    this.actorId = this.param<string>("actor") || this.entityId;
    this.body = this.ctx.getObject(this.actorId) ?? this.ctx.object;
    this.steering = new TerrainSteering({
      radius: this.param<number>("radius"),
      maxStepUp: this.param<number>("stepUp"),
      maxSlope: this.param<number>("maxSlope"),
      maxDrop: this.param<number>("maxDrop"),
    });

    const home = this.param<number[]>("home");
    if (Array.isArray(home) && home.length >= 3) {
      this.home = [home[0]!, home[1]!, home[2]!];
    } else {
      const p = this.bodyPosition();
      this.home = p ?? [0, 0, 0];
    }

    this.tags = splitList(this.param<string>("targetTags"));
    this.choices = splitList(this.param<string>("abilities"));
    // Hashed off the entity id rather than Math.random: a respawned mob keeps
    // its own rhythm, and a test gets the same fight twice.
    this.phase = hash01(this.actorId);
    this.nextRoamAt = this.ctx.now() / 1000 + this.param<number>("roamPause") * this.phase;
    this.nextAttackAt = 0;

    this.threat = new ThreatTable({ halfLife: this.param<number>("threatHalfLife") });
    this.faction = this.param<string>("faction").trim();
    this.hostileTo = splitList(this.param<string>("hostileTo"));
    const net = this.ctx.netState;
    // Publish the faction so everything else can tell friend from foe. A game
    // whose combat script already publishes it wins — this only fills a gap,
    // so a mob dropped into a scene with no combat layer still has a side.
    if (this.faction && net?.isAuthority() && typeof net.get(combatKey.faction(this.actorId)) !== "string") {
      net.set(combatKey.faction(this.actorId), this.faction);
    }

    // The game tells us how angry to be; we decide who that makes the target.
    this.ctx.events?.on(MOB_EVENTS.threat, (payload) => this.onThreat(payload as ThreatPayload));
    this.ctx.events?.on(MOB_EVENTS.alert, (payload) => this.onAlert(payload as AlertPayload));
  }

  /**
   * Damage dealt, a heal landed, a taunt. The engine cannot know what a hit is
   * worth, so the game's combat layer supplies the number and this decides
   * what it means.
   */
  private onThreat(p: ThreatPayload): void {
    if (p.mobId !== this.actorId || !p.sourceId) return;
    const now = this.ctx.now() / 1000;
    if (p.kind === "taunt") this.threat.taunt(p.sourceId, now, p.seconds ?? 3);
    else if (p.kind === "set") this.threat.set(p.sourceId, p.amount ?? 0, now);
    else this.threat.add(p.sourceId, p.amount ?? 0, now);
  }

  /**
   * A packmate picked a fight. Take the same target.
   *
   * Answered as a seed of threat rather than by setting the target directly,
   * so an assist goes through the same table every other decision goes
   * through: whoever actually hits this mob still takes it off the friend who
   * shouted, which is what stops a whole camp from tunnel-visioning one player
   * while a second one carves through them.
   */
  private onAlert(p: AlertPayload): void {
    if (p.mobId === this.actorId || !p.targetId) return;
    if (this.state === "dead" || this.state === "leash") return;
    if (this.state === "chase" || this.state === "attack") return; // already busy
    const radius = this.param<number>("alertRadius");
    if (radius <= 0) return;
    // Own faction only. With no factions in play, a shared spawn area is the
    // pack — which is exactly the set the spawner woke together.
    if (p.faction || this.faction) {
      if (p.faction !== this.faction) return;
    } else if (!this.param<string>("spawnArea")) {
      return;
    }
    const me = this.bodyPosition();
    if (!me || !p.at) return;
    if (Math.hypot(me[0] - p.at[0], me[2] - p.at[2]) > Math.max(radius, p.radius ?? 0)) return;
    if (!this.hostile(p.targetId, this.taggedTargets())) return;
    this.threat.add(p.targetId, 1, this.ctx.now() / 1000);
  }

  override onFixedUpdate(dt: number): void {
    const body = this.body;
    if (!body) return;
    const net = this.ctx.netState;
    // Insurance: the runtime already net-suspends entities the authority owns.
    if (net && !net.isAuthority()) return;
    const now = this.ctx.now() / 1000;

    if (net?.get(combatKey.dead(this.actorId)) === true) {
      if (this.state !== "dead") {
        this.transition("dead");
        this.targetId = "";
        this.alertedFor = "";
        this.dir = [0, 0];
        this.threat.clear();
        this.steering.reset();
      }
      this.drive(body, [0, 0], 0, now);
      return;
    }
    if (this.state === "dead") {
      // Back on its feet (NpcManager respawns by rebuilding the subtree, but a
      // game may simply clear the flag) — start over from where it stands.
      this.transition("idle");
      this.steering.reset();
    }

    const hz = this.param<number>("steerHz");
    if (now - this.lastSteerAt >= 1 / hz) {
      this.think(now - this.lastSteerAt || dt, now);
      this.lastSteerAt = now;
    }
    this.drive(body, this.dir, this.moveSpeed, now);
  }

  /**
   * One decision: who to fight, which of the six states that puts us in, and
   * which way to walk. Runs at `steerHz`, not per tick — everything expensive
   * (the tag scan, the sight ray, the terrain probes) lives here.
   */
  private think(dt: number, now: number): void {
    const me = this.bodyPosition();
    if (!me) return;
    const fromHome = Math.hypot(me[0] - this.home[0], me[2] - this.home[2]);
    const leash = this.param<number>("leash");

    // Leashing outranks everything, including a target standing on its face.
    // A mob that re-aggros on the way home never gets home.
    if (this.state === "leash" || fromHome > leash) {
      this.returnHome(me, fromHome, dt, now);
      return;
    }

    const target = this.pickTarget(me);
    if (!target) {
      if (this.targetId) this.targetId = "";
      this.alertedFor = "";
      this.wander(me, dt, now);
      return;
    }

    if (target.id !== this.targetId) this.targetId = target.id;
    // A pull is loud. Shout once per target, not once per tick — and from
    // where the fight started, so a mob that has already chased you thirty
    // metres does not drag a second camp in behind it.
    if (this.alertedFor !== target.id) {
      this.alertedFor = target.id;
      const radius = this.param<number>("alertRadius");
      if (radius > 0) {
        this.ctx.events?.emit(MOB_EVENTS.alert, {
          mobId: this.actorId,
          targetId: target.id,
          at: [me[0], me[1], me[2]],
          radius,
          faction: this.faction,
        });
      }
    }
    const desired: [number, number] = [target.at[0] - me[0], target.at[2] - me[2]];
    const dist = Math.hypot(desired[0], desired[1]);
    const attackRange = this.param<number>("attackRange");
    const prefer = this.param<number>("preferredRange");

    this.faceYaw = Math.atan2(desired[0], desired[1]);

    // In range: hold the ground and swing. A ranged mob backs up when crowded
    // (prefer > 0); a melee one simply stops, because a melee mob that keeps
    // walking into you shoves you around the arena.
    const inRange = dist <= (prefer > 0 ? prefer + 1 : attackRange);
    if (inRange) {
      if (this.state !== "attack") this.transition("attack");
      const tooClose = prefer > 0 && dist < prefer - 1;
      if (tooClose) {
        this.steer(me, [-desired[0], -desired[1]], this.param<number>("speed") * 0.6, dt, now);
      } else {
        this.dir = [0, 0];
        this.moveSpeed = 0;
      }
      this.tryAttack(dist, desired, now);
      return;
    }

    if (this.state !== "chase") this.transition("chase");
    this.steer(me, desired, this.param<number>("speed"), dt, now);
  }

  /**
   * Who it should be fighting — or null.
   *
   * Two rules, in order:
   *
   *   1. **Threat decides, once anyone has earned any.** That is what makes a
   *      tank a role rather than a costume: the mob holds on whoever it hates
   *      most, not whoever wandered closest, and a taunt beats even that for a
   *      few seconds. A threat target is judged against `deaggroRange` and NOT
   *      against line of sight — once it hates you it follows you round the
   *      corner, which is the entire point of having hated you.
   *   2. **Otherwise the nearest one it can actually see**, which is how a
   *      fight starts. Nearest rather than first: on a server every joined
   *      player carries the tag, and a brain that fights `findByTag(...)[0]`
   *      ignores the one standing on its foot.
   *
   * Both rules run over the same validity test, so nothing anywhere can pick a
   * dead body, a landing body, a friend, or a target so far from home that
   * taking it would break the leash.
   */
  private pickTarget(me: readonly [number, number, number]): { id: string; at: [number, number, number] } | null {
    const net = this.ctx.netState;
    const nowMs = this.ctx.now();
    const now = nowMs / 1000;
    const aggro = this.param<number>("aggroRange");
    const deaggro = Math.max(this.param<number>("deaggroRange"), aggro);
    const leash = this.param<number>("leash");
    const tagged = this.taggedTargets();
    const seen = new Map<string, [number, number, number] | null>();

    const positionIfValid = (id: string): [number, number, number] | null => {
      const cached = seen.get(id);
      if (cached !== undefined) return cached;
      let at: [number, number, number] | null = null;
      if (id !== this.actorId && id !== this.entityId && this.hostile(id, tagged)) {
        if (net?.get(combatKey.dead(id)) !== true) {
          // A body that just logged in or arrived from another layer is
          // settling. Leave it alone — landing.ts makes this a contract.
          if (!net || !isLanding(net, id, nowMs)) {
            const p = this.positionOf(id);
            // Never take a fight that would break the leash before it starts.
            if (p && Math.hypot(p[0] - this.home[0], p[2] - this.home[2]) <= leash) at = p;
          }
        }
      }
      seen.set(id, at);
      return at;
    };

    const hated = this.threat.top(now, (id) => {
      const at = positionIfValid(id);
      return at !== null && Math.hypot(at[0] - me[0], at[2] - me[2]) <= deaggro;
    });
    if (hated) return { id: hated, at: seen.get(hated)! };

    let bestId = "";
    let bestAt: [number, number, number] | null = null;
    let best = Infinity;
    for (const id of this.candidates(now)) {
      const at = positionIfValid(id);
      if (!at) continue;
      const d = Math.hypot(at[0] - me[0], at[2] - me[2]);
      const range = id === this.targetId ? deaggro : aggro;
      if (d > range || d >= best) continue;
      best = d;
      bestId = id;
      bestAt = at;
    }
    if (!bestAt) return null;
    // Sight is checked once, for the winner only: a ray per candidate per tick
    // is how an AI budget disappears on a busy layer.
    if (this.param<boolean>("requireLineOfSight") && !this.canSee(me, bestAt, bestId)) return null;
    return { id: bestId, at: bestAt };
  }

  /** Entities carrying one of `targetTags`, this tick. */
  private taggedTargets(): Set<string> {
    const out = new Set<string>();
    for (const tag of this.tags) for (const id of this.ctx.findByTag(tag)) out.add(id);
    return out;
  }

  /**
   * Is this one an enemy?
   *
   * Factions first, when both sides publish one: the same faction is NEVER an
   * enemy (that is what stops a pack tearing itself apart the moment one of
   * them assists), a different one is, and `hostileTo` narrows that if a game
   * has three-way politics. Anything that publishes no faction falls back to
   * the blunt version — does it carry a tag I hunt — which is what keeps a
   * plain scene with no combat layer working.
   */
  private hostile(id: string, tagged: ReadonlySet<string>): boolean {
    const theirs = this.ctx.netState?.get(combatKey.faction(id));
    if (this.faction && typeof theirs === "string" && theirs) {
      if (theirs === this.faction) return false;
      return this.hostileTo.length === 0 || this.hostileTo.includes(theirs);
    }
    return tagged.has(id);
  }

  /**
   * Everything worth considering, refreshed once a second.
   *
   * Tagged entities always; plus, when this mob has a faction, every body with
   * published combat state — because the other faction's NPCs carry no tag of
   * ours, and goblins-vs-dwarves has to work without either side being called
   * "player". That scan walks the netState keyspace, so it is cached rather
   * than run at `steerHz` for every mob on the layer.
   */
  private candidates(now: number): readonly string[] {
    if (now - this.candidatesAt < 1 && this.candidateCache.length > 0) return this.candidateCache;
    this.candidatesAt = now;
    const ids = this.taggedTargets();
    const net = this.ctx.netState;
    if (this.faction && net) for (const id of combatants(net)) ids.add(id);
    this.candidateCache = [...ids];
    return this.candidateCache;
  }

  /** Eye-to-torso ray against the things that actually block vision. */
  private canSee(
    me: readonly [number, number, number],
    at: readonly [number, number, number],
    targetId: string,
  ): boolean {
    const raycast = this.ctx.sim?.raycast;
    if (!raycast) return true; // no physics queries: sight is not a thing here
    const eye = this.param<number>("eyeHeight");
    const from: [number, number, number] = [me[0], me[1] + eye, me[2]];
    const to: [number, number, number] = [at[0], at[1] + eye * 0.6, at[2]];
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const dz = to[2] - from[2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-3) return true;
    const hit = raycast.call(this.ctx.sim!, from, [dx / len, dy / len, dz / len], len, {
      layers: LAYER_WORLD | LAYER_TERRAIN | LAYER_PROP,
      // The TARGET cannot block the view of itself — and it will, every single
      // time, if it is not excluded: the ray ends at the target's centre, which
      // is half a body radius PAST its own collider. A character body is a
      // dynamic rigidbody, and a dynamic body's collider defaults to the PROP
      // layer (physics `defaultMembership`) unless a scene retags it, which is
      // one of the layers sight is traced against. Leave it in and the check
      // reports "blocked" for every candidate at every range, so a mob with the
      // default `requireLineOfSight` never acquires anything and roams straight
      // past the player.
      exclude: [this.actorId, this.entityId, targetId],
    });
    return hit === null;
  }

  /** Walk home, and arrive healed. */
  private returnHome(me: readonly [number, number, number], fromHome: number, dt: number, now: number): void {
    if (this.state !== "leash") {
      this.transition("leash");
      this.targetId = "";
      this.alertedFor = "";
      this.roamTarget = null;
      // Wiping the table is what makes a leash a real escape rather than a
      // pause: get away, and the fight is genuinely over.
      this.threat.clear();
    }
    if (fromHome <= Math.max(1.5, this.param<number>("roam") * 0.5)) {
      this.heal();
      this.dir = [0, 0];
      this.moveSpeed = 0;
      this.transition("idle");
      this.nextRoamAt = now + this.param<number>("roamPause") * (0.5 + this.phase);
      return;
    }
    this.steer(me, [this.home[0] - me[0], this.home[2] - me[2]], this.param<number>("roamSpeed"), dt, now);
  }

  /** Nothing to fight: mill about inside the roam radius, or stand still. */
  private wander(me: readonly [number, number, number], dt: number, now: number): void {
    const roam = this.param<number>("roam");
    if (roam <= 0) {
      if (this.state !== "idle") this.transition("idle");
      this.dir = [0, 0];
      this.moveSpeed = 0;
      return;
    }

    if (this.roamTarget) {
      const d = Math.hypot(this.roamTarget[0] - me[0], this.roamTarget[1] - me[2]);
      // "Blocked" ends a stroll rather than fighting the terrain for it: the
      // destination was picked at random, so any other patch of grass will do.
      if (d < 1) this.roamTarget = null;
    }
    if (!this.roamTarget && now >= this.nextRoamAt) {
      const angle = hash01(`${this.actorId}:${Math.floor(now)}`) * Math.PI * 2;
      const r = Math.sqrt(hash01(`${this.actorId}:r:${Math.floor(now)}`)) * roam;
      this.roamTarget = [this.home[0] + Math.cos(angle) * r, this.home[2] + Math.sin(angle) * r];
    }
    if (!this.roamTarget) {
      if (this.state !== "idle") this.transition("idle");
      this.dir = [0, 0];
      this.moveSpeed = 0;
      return;
    }

    if (this.state !== "roam") this.transition("roam");
    const result = this.steer(
      me,
      [this.roamTarget[0] - me[0], this.roamTarget[1] - me[2]],
      this.param<number>("roamSpeed"),
      dt,
      now,
    );
    if (result.blocked && result.dir[0] === 0 && result.dir[1] === 0) {
      this.roamTarget = null;
      this.nextRoamAt = now + this.param<number>("roamPause") * (0.5 + this.phase);
      this.transition("idle");
    }
  }

  private steer(
    me: readonly [number, number, number],
    desired: readonly [number, number],
    speed: number,
    dt: number,
    now: number,
  ): { dir: [number, number]; blocked: boolean } {
    const result = this.steering.solve(
      this.ctx.sim,
      {
        from: me,
        desired,
        dt,
        speed,
        exclude: [this.actorId, this.entityId],
        ...(this.param<number>("separation") > 0 ? { avoid: this.packmates(me) } : {}),
      },
      now,
    );
    this.dir = result.dir;
    this.moveSpeed = result.dir[0] === 0 && result.dir[1] === 0 ? 0 : speed;
    // Face where it walks unless a target already claimed the facing.
    if (this.state !== "attack" && this.moveSpeed > 0) {
      this.faceYaw = Math.atan2(result.dir[0], result.dir[1]);
    }
    return result;
  }

  /**
   * Packmates to keep out of, as [x, z, radius].
   *
   * Everything sharing this mob's `spawnArea` — which is exactly the set the
   * spawner woke together, so it costs a param read rather than a spatial
   * query. A lone mob (no spawn area) has no packmates and pays nothing.
   */
  private packmates(me: readonly [number, number, number]): Array<[number, number, number]> {
    const area = this.param<string>("spawnArea");
    if (!area) return [];
    const out: Array<[number, number, number]> = [];
    const spacing = this.param<number>("separation");
    // Spawned ids are `<areaId>#<template>#<n>` — cheap membership by prefix,
    // no registry lookup and nothing to keep in sync.
    for (const id of this.ctx.findByTag("npc")) {
      if (id === this.actorId || !id.startsWith(`${area}#`)) continue;
      const at = this.positionOf(id);
      if (!at) continue;
      const d = Math.hypot(at[0] - me[0], at[2] - me[2]);
      if (d > spacing * 3) continue;
      out.push([at[0], at[2], spacing]);
    }
    return out;
  }

  private tryAttack(dist: number, toTarget: readonly [number, number], now: number): void {
    if (now < this.nextAttackAt) return;
    // The first tick in range is not a free hit: schedule, then swing.
    if (this.nextAttackAt === 0) {
      this.nextAttackAt = now + this.param<number>("attackInterval") * (0.4 + this.phase * 0.6);
      return;
    }
    this.nextAttackAt =
      now + this.param<number>("attackInterval") + hash01(`${this.actorId}:${now}`) * this.param<number>("attackJitter");
    const len = Math.hypot(toTarget[0], toTarget[1]) || 1;
    this.ctx.events?.emit(MOB_EVENTS.attack, {
      mobId: this.actorId,
      targetId: this.targetId,
      abilityId: this.choices.length > 0 ? this.choices[Math.floor(hash01(`${this.actorId}:a:${now}`) * this.choices.length)]! : "",
      aim: [toTarget[0] / len, toTarget[1] / len],
      distance: dist,
    });
  }

  /**
   * The drive channel, written EVERY tick even at rest.
   *
   * `impulseUntil` is a deadline, not a duration: it has to outlast the gap
   * between steering ticks (up to 1/steerHz) or the controller hands the body
   * back to whatever else is driving — on a client that is the shared keyboard,
   * and every mob in the scene walks around behind you.
   */
  private drive(body: THREE.Object3D, dir: readonly [number, number], speed: number, now: number): void {
    const ud = body.userData as Record<string, unknown>;
    ud["impulseVel"] = [dir[0] * speed, dir[1] * speed];
    ud["impulseUntil"] = now + 0.3;
    // Facing while standing still: the controller only turns a body that is
    // moving, so an attacker that stops would keep swinging at the spot where
    // its target used to be. `faceYaw` is the controller's override for that.
    if (this.faceYaw !== null) {
      ud["faceYaw"] = this.faceYaw;
      ud["faceUntil"] = now + 0.3;
    }
  }

  private heal(): void {
    if (!this.param<boolean>("returnHeal")) return;
    const net = this.ctx.netState;
    if (!net) return;
    const max = net.get(combatKey.maxHp(this.actorId));
    // Only when the game publishes both keys: writing hp into a namespace the
    // scene never defined is refused with a warning, and inventing a maximum
    // would make the engine an opinion about combat.
    if (typeof max !== "number") return;
    if (typeof net.get(combatKey.hp(this.actorId)) !== "number") return;
    net.set(combatKey.hp(this.actorId), max);
  }

  private transition(next: MobState): void {
    if (next === this.state) return;
    const previous = this.state;
    this.state = next;
    if (next !== "attack") this.nextAttackAt = 0;
    this.ctx.events?.emit(MOB_EVENTS.state, {
      mobId: this.actorId,
      state: next,
      previous,
      targetId: this.targetId,
    });
  }

  private bodyPosition(): [number, number, number] | null {
    return this.body ? worldPosition(this.body) : null;
  }

  private positionOf(id: string): [number, number, number] | null {
    const obj = this.ctx.getObject(id);
    return obj ? worldPosition(obj) : null;
  }

  /**
   * Why is it doing that? — the answer, for `/admin/npcs`, the inspector, or
   * an agent debugging a camp that behaves wrongly on a live layer.
   *
   * The threat table is the part worth surfacing: "it is chasing the wizard"
   * is a symptom, "the wizard is on 4100 threat and the tank is on 900" is the
   * cause, and nothing else in the system can tell you that.
   */
  override onDebug(): unknown {
    const now = this.ctx.now() / 1000;
    return {
      script: "mob-brain",
      state: this.state,
      target: this.targetId,
      faction: this.faction,
      home: this.home.map((v) => Math.round(v * 10) / 10),
      leash: this.param<number>("leash"),
      threat: this.threat.list(now).map((e) => ({ id: e.id, threat: Math.round(e.threat) })),
      taunted: this.threat.forcedTarget(now) ?? "",
    };
  }

  /** Exposed for tests and for a debug overlay: what is it doing right now? */
  get currentState(): MobState {
    return this.state;
  }

  get currentTarget(): string {
    return this.targetId;
  }

  /** Ground height under the body, or null — the probe, shared. */
  groundUnder(): number | null {
    const p = this.bodyPosition();
    return p ? groundHeightAt(this.ctx.sim, p[0], p[2], p[1]) : null;
  }
}

/**
 * World position, matrix first.
 *
 * Bodies are root entities, so `position` is normally the right answer — but
 * reading the matrix first means a brain still works when someone parents a
 * mob under a moving platform, and it costs nothing.
 */
function worldPosition(o: THREE.Object3D): [number, number, number] {
  const e = o.matrixWorld?.elements as ArrayLike<number> | undefined;
  if (e && e.length >= 15) return [e[12] as number, e[13] as number, e[14] as number];
  return [o.position.x, o.position.y, o.position.z];
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * A stable number in [0, 1) from a string.
 *
 * Every "random" decision here is hashed rather than drawn from Math.random so
 * a fight replays identically and a test is not flaky: same mob id, same
 * rhythm, same wander, every run. Multiplayer wants this too — brains run on
 * the authority, but a deterministic one can be re-simulated.
 */
function hash01(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}
