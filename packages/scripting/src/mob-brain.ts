import type * as THREE from "three";
import { z } from "zod";
import {
  MOB_EVENTS,
  ThreatTable,
  combatKey,
  combatants,
  isDowned,
  isLanding,
  mobEventDecls,
  readNotice,
  readPet,
  readTarget,
  sameTarget,
  targetKey,
  withTarget,
  type MobState,
} from "@hitreg/core";
import { Script, type ScriptEventDecl } from "./script.js";

/**
 * The target rules a move may name. Mirrors core's `MOB_TARGET_RULES` (the
 * `rule` field of `mob.attack`); a test pins the two together.
 */
export const MOVE_TARGET_RULES = ["threat", "nearest", "furthest", "behind"] as const;

/**
 * One entry of `mob-brain`'s `moves` param — the schema the brain validates a
 * prefab's moveset against at start. A move is WHEN and AT WHOM; what the
 * ability does is the game's (`ability` is passed through untouched).
 */
export const mobMoveSchema = z.object({
  ability: z.string().min(1).describe("Ability id passed through in `mob.attack`; the game decides what it does."),
  range: z
    .tuple([z.number().min(0), z.number().min(0)])
    .optional()
    .describe("[min, max] metres to the chosen target for this move to be usable. Omitted = [0, attackRange]."),
  cooldown: z
    .number()
    .min(0)
    .default(0)
    .describe("Seconds before this move may be picked again. Keep it at least the ability's own cooldown, or the game refuses the cast."),
  weight: z.number().min(0).default(1).describe("Relative chance among the moves usable this instant. 0 = never picked."),
  windup: z
    .number()
    .min(0)
    .default(0.5)
    .describe("Seconds the body stands committed: no walking, no new move, turning only at the wind-up rate. Match the ability's wind-up."),
  target: z
    .enum(MOVE_TARGET_RULES)
    .default("threat")
    .describe(
      "Whom it goes for: threat = the current target (top of the threat table); nearest / furthest = the nearest / " +
        "furthest enemy in range; behind = the nearest enemy in the mob's rear half (a turn-and-lash).",
    ),
  turnRate: z
    .number()
    .min(0)
    .optional()
    .describe("Degrees per second it may turn during THIS wind-up. Omitted = the brain's `windupTurnRate`. A turn-and-lash wants it fast."),
  lunge: z
    .boolean()
    .default(false)
    .describe("Close the gap at the END of the wind-up: the body springs at the point the target stood on and lands as the wind-up ends (a leap)."),
});
export type MobMove = z.output<typeof mobMoveSchema>;

const DEG = Math.PI / 180;

/** `mob.threat` as this script reads it (the schema is in core). */
interface ThreatPayload {
  mobId: string;
  sourceId: string;
  amount?: number;
  kind?: "add" | "set" | "taunt" | "forget";
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
 * Two userData channels let another script (a game's combat) act on that
 * drive without knowing the brain: `driveScale` (a number, default 1)
 * multiplies the brain's own speed — 0 roots it, 0.5 slows it — and
 * `driveHeldUntil` (sim seconds) is a deadline before which the brain leaves
 * `impulseVel` alone, so a knockback or a pull written there is not stomped.
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
/** The nearest point (x, z plane; y interpolated) of a polyline route to p. Shared by the brain and the server's fence. */
export function nearestOnRoute(route: ReadonlyArray<readonly [number, number, number]>, p: readonly number[]): [number, number, number] {
  if (route.length === 1) return [route[0]![0], route[0]![1], route[0]![2]];
  let best: [number, number, number] = [route[0]![0], route[0]![1], route[0]![2]];
  let bestD = Infinity;
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i]!, b = route[i + 1]!;
    const dx = b[0] - a[0], dz = b[2] - a[2], L2 = dx * dx + dz * dz;
    const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0]! - a[0]) * dx + (p[2]! - a[2]) * dz) / L2));
    const q: [number, number, number] = [a[0] + dx * t, a[1] + (b[1] - a[1]) * t, a[2] + dz * t];
    const d = Math.hypot(q[0] - p[0]!, q[2] - p[2]!);
    if (d < bestD) { bestD = d; best = q; }
  }
  return best;
}

export class MobBrain extends Script {
  static override scriptName = "mob-brain";
  static override events: ScriptEventDecl[] = [...mobEventDecls];
  /** What one entry of the `moves` param must look like. */
  static readonly moveSchema = mobMoveSchema;

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
    patrol: {
      default: [] as number[][],
      description:
        "Patrol route: world points [[x, y, z], ...] walked in order and back (ping-pong) at roamSpeed while idle, instead of " +
        "wandering inside `roam`. The leash and the way home are measured from the nearest point of the route, so a long " +
        "route is legal with a short leash. `spawnArea.patrol` writes it (area-relative points made world).",
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
    retreatSpeed: {
      default: 0,
      min: 0,
      max: 30,
      description:
        "m/s a ranged mob (preferredRange > 0) backs away at when crowded. 0 = 0.6 x speed. Keep it well under a " +
        "player's run, or melee can never catch a caster to interrupt it. It never backs away while winding up.",
    },
    attackInterval: { default: 1.8, min: 0.1, max: 120, description: "Seconds between attack requests." },
    attackJitter: { default: 0.5, min: 0, max: 30, description: "Random seconds added to each interval, so a pack does not swing in unison." },
    abilities: {
      default: "",
      description:
        "Comma-separated ability ids, one picked at random per swing and passed through in `mob.attack`. Empty = the game decides. " +
        "Ignored when `moves` is set.",
    },
    moves: {
      default: [] as unknown[],
      description:
        "The creature's MOVESET: an array of moves (schema: MobBrain.moveSchema), e.g. " +
        '[{"ability":"mobSlam","range":[0,2.8],"cooldown":6,"weight":2,"windup":1.05,"target":"threat"},' +
        '{"ability":"mobLeap","range":[5,14],"cooldown":10,"windup":1.3,"target":"furthest","lunge":true}]. ' +
        "Each needs an ability id; range [min,max] metres (default [0, attackRange]), cooldown s, weight, windup s, " +
        "target threat|nearest|furthest|behind, optional turnRate deg/s and lunge. Every `attackInterval` it picks, by " +
        "weight, one move that is off cooldown and whose target rule finds someone inside its range, and stands committed " +
        "for the wind-up. Moves are tried while chasing too, so a leap or a shot can open a fight. Empty = the old single " +
        "`abilities` swing at the threat target.",
    },
    turnRate: {
      default: 540,
      min: 1,
      max: 3600,
      description: "Degrees per second it turns outside a wind-up — fast, but finite, so a body never snaps round.",
    },
    windupTurnRate: {
      default: 90,
      min: 0,
      max: 3600,
      description:
        "Degrees per second it turns while winding up a move. Low is what makes stepping round a heavy attack work and lets " +
        "a tank hold the mob's facing. A move's own `turnRate` overrides it.",
    },
    lungeSpeed: {
      default: 14,
      min: 1,
      max: 60,
      description: "Metres per second of a move's `lunge`. Raised as needed so the body still lands by the end of the wind-up.",
    },
    sightAngle: {
      default: 180,
      min: 0,
      max: 180,
      description:
        "Half-angle of its sight cone, degrees from where it faces. Acquisition only — a target it already has, or a grudge, " +
        "is kept all round. 180 = sees all round (the old behaviour); ~70 lets a player walk up from behind.",
    },
    hearRadius: {
      default: 4,
      min: 0,
      max: 100,
      description:
        "Metres inside which it notices an enemy whatever way it faces. Keep it short, or the sight cone means nothing. " +
        "This and aggroRange are scaled per body by netState notice/<bodyId> (a game's stealth: 0.3 = sneaking).",
    },
    guardBetween: {
      default: false,
      description:
        "A guard-carrying mob (a shield): raise the guard while in melee and not winding up, and drop it for each move. " +
        "Emitted as `mob.guard`; what a guard does is the game's.",
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
      default: -1,
      min: -1,
      max: 200,
      description:
        "Metres its shout carries when it pulls: packmates of the same faction inside this take the same target. " +
        "0 = fights alone. This is what makes a camp a camp rather than five things queueing up to die. " +
        "-1 (default) = by temperament: 10 for hostile and territorial, 0 for passive (a passive creature neither shouts " +
        "nor answers a shout unless this is set).",
    },
    temperament: {
      default: "hostile",
      description:
        "When it starts a fight. hostile = on sight, inside aggroRange (the classic mob). territorial = only against " +
        "someone inside `territory` metres of it or of its home: walk round it and it lets you pass. passive = never: " +
        "it wanders until hit, fights back whoever the threat table names (the game's `mob.threat` on damage), drops " +
        "it once that grudge decays or the attacker leaves deaggroRange, and goes back to wandering. Any other value " +
        "reads as hostile. `spawnArea.temperament` (or a mix row's) writes it.",
    },
    territory: {
      default: 7,
      min: 0,
      max: 100,
      description: "A territorial creature's: metres round itself or its home inside which a stranger is attacked (still within aggroRange, and seen).",
    },
    patrolDir: {
      default: 0,
      min: -1,
      max: 1,
      description:
        "Which way it sets off along `patrol`: 1 forward, -1 backward, from the segment it stands on. 0 (default) = start at " +
        "the nearest route point and walk forward. A route-placed spawnArea writes ±1 at random.",
    },
    owner: {
      default: "",
      description:
        "Body id of the player this creature belongs to: a PET. Empty = an ordinary mob. A pet's home is its owner " +
        "(the leash is measured from them), it follows them between fights, never wanders, never shouts for a pack and " +
        "never heals on a leash; whom it fights is its netState pet/<id> record (stance assist|defend|passive, order " +
        "follow|stay|attack) and its owner's primary target (target/<owner>). The game's pet keeper spawns it with this set.",
    },
    followDistance: {
      default: 2.5,
      min: 0.5,
      max: 20,
      description: "A pet's: metres behind its owner it settles at between fights.",
    },
    catchUp: {
      default: 60,
      min: 10,
      max: 500,
      description: "A pet's: metres from its owner past which it is put back beside them at once (the owner rode, fell or ran off).",
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
  private route: Array<[number, number, number]> = [];
  private routeAt = 0;
  private routeDir = 1;
  private nextRoamAt = 0;
  /**
   * Where it WANTS to face (null = nothing claimed yet), and where it does:
   * `yaw` walks toward `faceGoal` at a finite rate every tick and is what goes
   * out on the controller's `faceYaw` channel. Convention: atan2(x, z), the
   * controller's — forward is (sin yaw, cos yaw).
   */
  private faceGoal: number | null = null;
  private yaw = 0;
  private moves: MobMove[] = [];
  /** Per move: sim seconds before which it may not be picked again. */
  private moveReadyAt: number[] = [];
  /** The move being wound up — committed until `windupUntil`. */
  private windupUntil = 0;
  private windupTargetId = "";
  private windupTurn = 0;
  /** A wind-up that ends in a spring at a ground point (a move's `lunge`). */
  private lunge: { at: [number, number]; from: number; speed: number } | null = null;
  /** Interrupted (a parry, a stagger): no move and no walking until this. */
  private stunnedUntil = 0;
  /** What `mob.engaged` last said; null = not said yet. */
  private engagedSaid: boolean | null = null;
  private guardUp = false;
  private guardReadyAt = 0;
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
  /** A pet's owner (the `owner` param); "" = an ordinary mob. */
  private owner = "";
  /** The primary last published to target/<actorId>. */
  private publishedTarget: string | null = null;
  /** The `temperament` param, normalised (anything unknown is hostile). */
  private temperament: "hostile" | "territorial" | "passive" = "hostile";

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

    const patrol = this.param<unknown>("patrol");
    this.route = Array.isArray(patrol) ? (patrol as unknown[]).filter((p): p is number[] => Array.isArray(p) && p.length >= 3).map((p) => [p[0]!, p[1]!, p[2]!] as [number, number, number]) : [];
    if (this.route.length) {
      // start at the route point nearest the spawn, so a pack does not cross its whole route first
      const me = this.bodyPosition() ?? this.home;
      let best = Infinity;
      this.route.forEach((p, i) => { const d = Math.hypot(p[0] - me[0], p[2] - me[2]); if (d < best) { best = d; this.routeAt = i; } });
      const dir = Math.sign(this.param<number>("patrolDir") ?? 0);
      if (dir !== 0 && this.route.length > 1) {
        // set off along the segment it stands on, in the given direction (a rare placed mid-route walks on, not back)
        let seg = 0;
        let segD = Infinity;
        for (let i = 0; i < this.route.length - 1; i++) {
          const q = nearestOnRoute([this.route[i]!, this.route[i + 1]!], me);
          const d = Math.hypot(q[0] - me[0], q[2] - me[2]);
          if (d < segD) { segD = d; seg = i; }
        }
        this.routeDir = dir;
        this.routeAt = dir > 0 ? seg + 1 : seg;
      }
    }
    const temperament = String(this.param<string>("temperament") ?? "hostile");
    this.temperament = temperament === "passive" || temperament === "territorial" ? temperament : "hostile";
    this.tags = splitList(this.param<string>("targetTags"));
    this.choices = splitList(this.param<string>("abilities"));
    // A bad moveset is reported and dropped, never thrown: the mob still
    // fights with its plain `abilities` swing rather than standing inert.
    const moves = z.array(mobMoveSchema).safeParse(this.param<unknown>("moves") ?? []);
    if (moves.success) {
      this.moves = moves.data;
    } else {
      console.warn(`[mob-brain] ${this.actorId}: invalid moves — ${moves.error.issues[0]?.message ?? "?"}; using abilities`);
      this.moves = [];
    }
    this.moveReadyAt = this.moves.map(() => 0);
    this.yaw = this.body?.rotation?.y ?? 0;
    // Hashed off the entity id rather than Math.random: a respawned mob keeps
    // its own rhythm, and a test gets the same fight twice.
    this.phase = hash01(this.actorId);
    this.nextRoamAt = this.ctx.now() / 1000 + this.param<number>("roamPause") * this.phase;
    this.nextAttackAt = 0;

    this.threat = new ThreatTable({ halfLife: this.param<number>("threatHalfLife") });
    this.owner = this.param<string>("owner").trim();
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
    this.ctx.events?.on(MOB_EVENTS.interrupt, (payload) => {
      const p = payload as { mobId: string; seconds?: number };
      if (p.mobId === this.actorId) this.interrupt(p.seconds ?? 0);
    });
  }

  /**
   * The game broke the wind-up — a parry, a stagger. Drop it, stand still for
   * `seconds`, and do not start the next move the instant that ends: a
   * staggered body that swings again on the next frame was never staggered.
   */
  private interrupt(seconds: number): void {
    const now = this.ctx.now() / 1000;
    this.windupUntil = 0;
    this.windupTargetId = "";
    this.lunge = null;
    this.stunnedUntil = Math.max(this.stunnedUntil, now + seconds);
    if (this.nextAttackAt > 0) this.nextAttackAt = Math.max(this.nextAttackAt, this.stunnedUntil + 0.3);
    this.dir = [0, 0];
    this.moveSpeed = 0;
    if (this.faceGoal !== null) this.faceGoal = this.yaw; // reeling, not turning
    this.setGuard(false);
  }

  /** Winding up a move or knocked off its feet: walking and choosing wait. */
  private committed(now: number): boolean {
    return now < this.windupUntil || now < this.stunnedUntil;
  }

  /**
   * Damage dealt, a heal landed, a taunt. The engine cannot know what a hit is
   * worth, so the game's combat layer supplies the number and this decides
   * what it means.
   */
  private onThreat(p: ThreatPayload): void {
    if (p.mobId !== this.actorId || !p.sourceId) return;
    const now = this.ctx.now() / 1000;
    if (p.kind === "forget") return this.forget(p.sourceId);
    if (p.kind === "taunt") this.threat.taunt(p.sourceId, now, p.seconds ?? 3);
    else if (p.kind === "set") this.threat.set(p.sourceId, p.amount ?? 0, now);
    else this.threat.add(p.sourceId, p.amount ?? 0, now);
  }

  /**
   * Let go of a source entirely (`mob.threat` kind `forget`, a stealth
   * escape): off the table, and no longer the target it keeps all round. It
   * has to be noticed afresh — through the sight cone, the hearing radius and
   * its `notice/<bodyId>` — like any stranger. A wind-up already aimed at it
   * still lands where it was aimed; only the next decision changes.
   */
  private forget(sourceId: string): void {
    this.threat.forget(sourceId);
    if (this.targetId === sourceId) this.targetId = "";
    if (this.alertedFor === sourceId) this.alertedFor = "";
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
    const radius = this.alertRadius();
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
        this.windupUntil = 0;
        this.lunge = null;
        this.setGuard(false);
        this.sayEngaged(false);
      }
      this.drive(body, [0, 0], 0, now, dt);
      this.publishTarget();
      return;
    }
    if (this.state === "dead") {
      // Back on its feet (NpcManager respawns by rebuilding the subtree, but a
      // game may simply clear the flag) — start over from where it stands.
      this.transition("idle");
      this.steering.reset();
    }

    // A committed body is decided per TICK, not per steering tick: a wind-up
    // ends, and a lunge springs, on the frame it should — an eighth of a second
    // late is the difference between a leap landing on you and beside you.
    if (this.committed(now)) {
      this.holdCommitment(now);
      this.drive(body, this.dir, this.moveSpeed, now, dt);
      return;
    }
    if (this.windupUntil > 0) {
      // the wind-up just ended: back to deciding, at once
      this.windupUntil = 0;
      this.windupTargetId = "";
      this.lunge = null;
      this.dir = [0, 0];
      this.moveSpeed = 0;
      this.lastSteerAt = -Infinity;
    }

    const hz = this.param<number>("steerHz");
    if (now - this.lastSteerAt >= 1 / hz) {
      const since = Number.isFinite(this.lastSteerAt) ? now - this.lastSteerAt : dt;
      this.think(since || dt, now);
      this.lastSteerAt = now;
    }
    this.drive(body, this.dir, this.moveSpeed, now, dt);
    this.publishTarget();
  }

  /**
   * Whom it is going for, published as target/<actorId>.primary on change, so
   * a player's target frame can say "targeting: you" (target-of-target) and a
   * healer's support falls on whoever it is hitting. Authority only.
   */
  private publishTarget(): void {
    const id = this.state === "dead" ? "" : this.targetId;
    if (id === this.publishedTarget) return;
    const net = this.ctx.netState;
    if (!net?.isAuthority()) return;
    this.publishedTarget = id;
    const current = readTarget(net, this.actorId);
    const next = withTarget(current, { primary: id || null });
    if (sameTarget(current, next)) return;
    if (!next.primary && !next.secondary) net.delete(targetKey(this.actorId));
    else net.set(targetKey(this.actorId), next);
  }

  /**
   * Standing in a wind-up: still, turning toward whoever the move is for at
   * the wind-up rate — and, for a lunge, springing at the spot the target
   * stood on so the body lands as the wind-up ends.
   */
  private holdCommitment(now: number): void {
    this.dir = [0, 0];
    this.moveSpeed = 0;
    if (now < this.stunnedUntil) return; // on the floor: not even turning toward anyone
    const me = this.bodyPosition();
    if (!me) return;
    const lunge = this.lunge;
    if (lunge && now >= lunge.from) {
      const dx = lunge.at[0] - me[0];
      const dz = lunge.at[1] - me[2];
      const d = Math.hypot(dx, dz);
      if (d > 0.6) {
        this.dir = [dx / d, dz / d];
        this.moveSpeed = lunge.speed;
        this.faceGoal = Math.atan2(dx, dz);
        return;
      }
      this.lunge = null; // arrived
    }
    const at = this.windupTargetId ? this.positionOf(this.windupTargetId) : null;
    if (at && Math.hypot(at[0] - me[0], at[2] - me[2]) > 0.05) this.faceGoal = Math.atan2(at[0] - me[0], at[2] - me[2]);
  }

  /**
   * One decision: who to fight, which of the six states that puts us in, and
   * which way to walk. Runs at `steerHz`, not per tick — everything expensive
   * (the tag scan, the sight ray, the terrain probes) lives here.
   */
  private think(dt: number, now: number): void {
    const me = this.bodyPosition();
    if (!me) return;
    if (this.owner) {
      this.thinkPet(me, dt, now);
      return;
    }
    const anchor = this.anchorFor(me);
    const fromHome = Math.hypot(me[0] - anchor[0], me[2] - anchor[2]);
    const leash = this.param<number>("leash");

    // Leashing outranks everything, including a target standing on its face.
    // A mob that re-aggros on the way home never gets home.
    if (this.state === "leash" || fromHome > leash) {
      this.setGuard(false);
      this.returnHome(me, fromHome, dt, now);
      this.sayEngaged(false);
      return;
    }
    if (this.faceGoal === null) this.yaw = this.body?.rotation?.y ?? this.yaw; // nothing claimed yet: it faces what the body faces

    const target = this.pickTarget(me);
    // Aware = a target, or a grudge still on the table (a target that stepped
    // out of reach is still remembered). `top` in pickTarget has just pruned
    // whatever decayed away, so `size` is current.
    this.sayEngaged(target !== null || this.threat.size > 0);
    if (!target) {
      if (this.targetId) this.targetId = "";
      this.alertedFor = "";
      this.setGuard(false);
      this.wander(me, dt, now);
      return;
    }

    this.fight(me, target, dt, now, true);
  }

  /**
   * Close on a target and swing at it: the in-range / chase half of a
   * decision, shared by a mob and a pet. `shout` = alert the pack on a new
   * target (a pet never does).
   */
  private fight(
    me: readonly [number, number, number],
    target: { id: string; at: [number, number, number] },
    dt: number,
    now: number,
    shout: boolean,
  ): void {
    if (target.id !== this.targetId) this.targetId = target.id;
    // A pull is loud. Shout once per target, not once per tick — and from
    // where the fight started, so a mob that has already chased you thirty
    // metres does not drag a second camp in behind it.
    if (shout && this.alertedFor !== target.id) {
      this.alertedFor = target.id;
      const radius = this.alertRadius();
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

    this.faceGoal = Math.atan2(desired[0], desired[1]);

    // In range: hold the ground and swing. A ranged mob backs up when crowded
    // (prefer > 0); a melee one simply stops, because a melee mob that keeps
    // walking into you shoves you around the arena.
    const inRange = dist <= (prefer > 0 ? prefer + 1 : attackRange);
    if (inRange) {
      if (this.state !== "attack") this.transition("attack");
      const tooClose = prefer > 0 && dist < prefer - 1;
      if (tooClose) {
        const retreat = this.param<number>("retreatSpeed");
        this.steer(me, [-desired[0], -desired[1]], retreat > 0 ? retreat : this.param<number>("speed") * 0.6, dt, now);
      } else {
        this.dir = [0, 0];
        this.moveSpeed = 0;
      }
      if (this.moves.length > 0) this.tryMove(me, target, now);
      else this.tryAttack(dist, desired, now);
      // between moves a shield-bearer stands behind its guard
      this.setGuard(this.param<boolean>("guardBetween") && !this.committed(now) && now >= this.guardReadyAt);
      return;
    }

    if (this.state !== "chase") this.transition("chase");
    this.setGuard(false);
    this.steer(me, desired, this.param<number>("speed"), dt, now);
    // A moveset is tried on the way in too: a leap or a shot is exactly what
    // opens a fight from range. Melee moves simply find nobody in their band.
    if (this.moves.length > 0) this.tryMove(me, target, now);
  }

  /**
   * A pet's decision (`owner` set): its home is its owner — or the spot a
   * `stay` order holds — and whom it fights comes from its pet/<id> record:
   *
   *   - an `attack` order: the named enemy, whatever the stance;
   *   - `assist`: its owner's primary target, else whatever has hit it or its
   *     owner (the game feeds that in as threat);
   *   - `defend`: only what has hit it or its owner;
   *   - `passive`: nothing.
   *
   * Between fights it settles a few metres behind its owner, at the owner's
   * pace, and is put back beside them when they get `catchUp` metres away.
   */
  private thinkPet(me: readonly [number, number, number], dt: number, now: number): void {
    const net = this.ctx.netState;
    const owner = this.positionOf(this.owner);
    if (!owner || net?.get(combatKey.dead(this.owner)) === true) {
      // no owner to follow (gone, dead): stand down; the game's keeper dismisses it
      this.targetId = "";
      this.threat.clear();
      this.dir = [0, 0];
      this.moveSpeed = 0;
      this.setGuard(false);
      this.sayEngaged(false);
      if (this.state !== "idle") this.transition("idle");
      return;
    }
    const pet = readPet(net, this.actorId);
    const stance = pet?.stance ?? "assist";
    const order = pet?.order ?? "follow";
    const anchor: [number, number, number] = order === "stay" && pet?.at ? [pet.at[0], pet.at[1], pet.at[2]] : owner;
    this.home = anchor;
    const fromAnchor = Math.hypot(me[0] - anchor[0], me[2] - anchor[2]);
    if (this.faceGoal === null) this.yaw = this.body?.rotation?.y ?? this.yaw;

    // left far behind (a fall, a mount, a portal on the same layer): beside the owner at once
    if (order !== "stay" && Math.hypot(me[0] - owner[0], me[2] - owner[2]) > this.param<number>("catchUp")) {
      const back = this.followPoint(owner);
      this.ctx.sim?.setPosition?.(this.actorId, [back[0], owner[1] + 0.5, back[1]]);
      this.targetId = "";
      this.threat.clear();
      this.dir = [0, 0];
      this.moveSpeed = 0;
      return;
    }
    // past the leash from its anchor: let go and come back
    if (fromAnchor > this.param<number>("leash")) {
      this.targetId = "";
      this.threat.clear();
      this.setGuard(false);
      this.sayEngaged(false);
      this.petFollow(me, anchor, order === "stay", dt, now);
      return;
    }

    let target: { id: string; at: [number, number, number] } | null = null;
    const tagged = this.taggedTargets();
    const nowMs = this.ctx.now();
    const valid = (id: string | undefined): { id: string; at: [number, number, number] } | null => {
      const at = id ? this.validPosition(id, tagged, nowMs) : null;
      return at && id ? { id, at } : null;
    };
    if (order === "attack") target = valid(pet?.orderTarget);
    if (!target && stance !== "passive") {
      if (stance === "assist") target = valid(readTarget(net, this.owner).primary);
      if (!target) {
        const leash = this.param<number>("leash");
        const hated = this.threat.top(now, (id) => {
          const at = this.validPosition(id, tagged, nowMs);
          return at !== null && Math.hypot(at[0] - anchor[0], at[2] - anchor[2]) <= leash;
        });
        target = valid(hated ?? undefined);
      }
    }
    this.sayEngaged(target !== null);
    if (!target) {
      if (this.targetId) this.targetId = "";
      this.setGuard(false);
      this.petFollow(me, anchor, order === "stay", dt, now);
      return;
    }
    this.fight(me, target, dt, now, false);
  }

  /** Where a following pet settles: `followDistance` behind its owner, a little to one side (each pet its own side). */
  private followPoint(owner: readonly [number, number, number]): [number, number] {
    const yaw = this.ctx.getObject(this.owner)?.rotation?.y ?? 0;
    const back = this.param<number>("followDistance");
    const side = (this.phase < 0.5 ? -1 : 1) * back * 0.6;
    const f: [number, number] = [Math.sin(yaw), Math.cos(yaw)];
    return [owner[0] - f[0] * back + f[1] * side, owner[2] - f[1] * back - f[0] * side];
  }

  /** Between fights: to the follow point (or the stay spot) at the owner's pace, and stand there. */
  private petFollow(me: readonly [number, number, number], anchor: readonly [number, number, number], staying: boolean, dt: number, now: number): void {
    const goal = staying ? [anchor[0], anchor[2]] : this.followPoint(anchor);
    const dx = goal[0]! - me[0];
    const dz = goal[1]! - me[2];
    const d = Math.hypot(dx, dz);
    if (d < 0.8) {
      this.dir = [0, 0];
      this.moveSpeed = 0;
      if (this.state !== "idle") this.transition("idle");
      return;
    }
    if (this.state !== "roam") this.transition("roam");
    // pace grows with the gap: a walk beside a walking owner, a sprint after a sprinting one
    const pace = Math.max(this.param<number>("roamSpeed"), Math.min(this.param<number>("speed") * 2.2, d * 1.6));
    this.steer(me, [dx, dz], pace, dt, now);
  }

  /**
   * Pick and start one move: every move off cooldown whose target rule finds
   * someone inside its range band is a candidate, and one is drawn by weight.
   *
   * This is where a fight stops being a tank and a queue. `threat` swings at
   * whoever holds the mob; `nearest`, `furthest` and `behind` go for someone
   * else — the mage at the back, the rogue at its flank — so everyone in the
   * party has to read the mob and answer it, not only the one holding it.
   */
  private tryMove(me: readonly [number, number, number], main: { id: string; at: [number, number, number] }, now: number): boolean {
    if (this.nextAttackAt === 0) {
      // The first tick in a fight is not a free hit: schedule, then swing.
      this.nextAttackAt = now + this.param<number>("attackInterval") * (0.4 + this.phase * 0.6);
      return false;
    }
    if (now < this.nextAttackAt) return false;
    const enemies = this.enemies(me, main, now);
    const usable: Array<{ index: number; target: Enemy }> = [];
    let total = 0;
    this.moves.forEach((move, index) => {
      if (move.weight <= 0 || now < this.moveReadyAt[index]!) return;
      const target = this.targetFor(move, enemies, main.id);
      if (!target) return;
      usable.push({ index, target });
      total += move.weight;
    });
    if (usable.length === 0 || total <= 0) return false;
    let roll = hash01(`${this.actorId}:m:${now}`) * total;
    let pick = usable[usable.length - 1]!;
    for (const u of usable) {
      roll -= this.moves[u.index]!.weight;
      if (roll < 0) {
        pick = u;
        break;
      }
    }
    const move = this.moves[pick.index]!;
    const target = pick.target;
    // Someone other than the current target has not been sight-checked yet:
    // one ray, for the winner only. Blocked = try again next steering tick.
    if (target.id !== main.id && this.param<boolean>("requireLineOfSight") && !this.canSee(me, target.at, target.id)) return false;

    this.windupUntil = now + move.windup;
    this.windupTargetId = target.id;
    this.windupTurn = move.turnRate ?? this.param<number>("windupTurnRate");
    this.moveReadyAt[pick.index] = now + move.cooldown;
    // the breath between moves is counted from the END of the wind-up
    this.nextAttackAt =
      now + move.windup + this.param<number>("attackInterval") + hash01(`${this.actorId}:${now}`) * this.param<number>("attackJitter");
    this.guardReadyAt = now + move.windup + 0.5;
    this.setGuard(false);
    this.dir = [0, 0];
    this.moveSpeed = 0;
    const dx = target.at[0] - me[0];
    const dz = target.at[2] - me[2];
    const len = Math.hypot(dx, dz) || 1;
    this.lunge = null;
    if (move.lunge && len > 1.2) {
      // Spring for the last part of the wind-up and land as it ends: stop a
      // metre short so the body arrives beside its target, not inside it.
      const travel = len - 1;
      let speed = this.param<number>("lungeSpeed");
      const longest = move.windup * 0.6;
      if (travel / speed > longest && longest > 0) speed = travel / longest;
      this.lunge = { at: [me[0] + (dx / len) * travel, me[2] + (dz / len) * travel], from: now + move.windup - travel / speed, speed };
    }
    this.faceGoal = Math.atan2(dx, dz);
    this.ctx.events?.emit(MOB_EVENTS.attack, {
      mobId: this.actorId,
      targetId: target.id,
      abilityId: move.ability,
      aim: [dx / len, dz / len],
      distance: target.d,
      rule: move.target,
      windup: move.windup,
      at: [target.at[0], target.at[1], target.at[2]],
    });
    return true;
  }

  /**
   * Every enemy a move could go for right now: the current target, anyone with
   * threat on the table, and any hostile candidate — all through the same
   * validity test as targeting, and inside `deaggroRange`.
   */
  private enemies(me: readonly [number, number, number], main: { id: string; at: [number, number, number] }, now: number): Enemy[] {
    const deaggro = Math.max(this.param<number>("deaggroRange"), this.param<number>("aggroRange"));
    const tagged = this.taggedTargets();
    const nowMs = this.ctx.now();
    const fwd: [number, number] = [Math.sin(this.yaw), Math.cos(this.yaw)];
    const out: Enemy[] = [];
    const add = (id: string, known?: [number, number, number]): void => {
      if (out.some((e) => e.id === id)) return;
      const at = known ?? this.validPosition(id, tagged, nowMs);
      if (!at) return;
      const dx = at[0] - me[0];
      const dz = at[2] - me[2];
      const d = Math.hypot(dx, dz);
      if (d > deaggro) return;
      out.push({ id, at, d, behind: dx * fwd[0] + dz * fwd[1] < 0 });
    };
    add(main.id, main.at);
    for (const e of this.threat.list(now)) add(e.id);
    // a pet swings only at what it is fighting: a bystander is never pulled by a "nearest" move
    if (!this.owner) for (const id of this.candidates(now)) add(id);
    return out;
  }

  /** The one enemy a move's rule picks from those inside its range band, or null. */
  private targetFor(move: MobMove, enemies: readonly Enemy[], mainId: string): Enemy | null {
    const [lo, hi] = move.range ?? [0, this.param<number>("attackRange")];
    let best: Enemy | null = null;
    for (const e of enemies) {
      if (e.d < lo || e.d > hi) continue;
      switch (move.target) {
        case "threat":
          if (e.id === mainId) return e;
          break;
        case "nearest":
          if (!best || e.d < best.d) best = e;
          break;
        case "furthest":
          if (!best || e.d > best.d) best = e;
          break;
        case "behind":
          if (e.behind && (!best || e.d < best.d)) best = e;
          break;
      }
    }
    return best;
  }

  /** Raise or drop the guard — on the edge only, so a held guard is two events a fight. */
  private setGuard(on: boolean): void {
    if (on === this.guardUp) return;
    this.guardUp = on;
    this.ctx.events?.emit(MOB_EVENTS.guard, { mobId: this.actorId, on });
  }

  /** Aware or not, on the edge only. The first think always says which. */
  private sayEngaged(engaged: boolean): void {
    if (engaged === this.engagedSaid) return;
    this.engagedSaid = engaged;
    this.ctx.events?.emit(MOB_EVENTS.engaged, { mobId: this.actorId, engaged });
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
    const nowMs = this.ctx.now();
    const now = nowMs / 1000;
    const aggro = this.param<number>("aggroRange");
    const deaggro = Math.max(this.param<number>("deaggroRange"), aggro);
    const tagged = this.taggedTargets();
    const seen = new Map<string, [number, number, number] | null>();

    const positionIfValid = (id: string): [number, number, number] | null => {
      const cached = seen.get(id);
      if (cached !== undefined) return cached;
      const at = this.validPosition(id, tagged, nowMs);
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
      const kept = id === this.targetId;
      if (!kept && !this.wouldStart(me, at)) continue;
      const range = kept ? deaggro : aggro * this.noticeScale(id);
      if (d > range || d >= best) continue;
      // A target it already has is kept all round; a NEW one has to be in
      // front of it, or close enough to hear.
      if (!kept && !this.notices(me, at, d, id)) continue;
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

  /**
   * Its temperament's say on starting a NEW fight with someone standing at `at`. A grudge on the threat table and a
   * target it already has never come through here, which is all "fights back" needs. hostile: yes; passive: never;
   * territorial: only inside `territory` of the body or of its home.
   */
  private wouldStart(me: readonly [number, number, number], at: readonly [number, number, number]): boolean {
    if (this.temperament === "hostile") return true;
    if (this.temperament === "passive") return false;
    const t = this.param<number>("territory");
    return Math.hypot(at[0] - me[0], at[2] - me[2]) <= t || Math.hypot(at[0] - this.home[0], at[2] - this.home[2]) <= t;
  }

  /** How far its shout carries (and how far off it answers one): the param, or by temperament when it is -1. */
  private alertRadius(): number {
    const r = this.param<number>("alertRadius");
    if (typeof r === "number" && r >= 0) return r;
    return this.temperament === "passive" ? 0 : 10;
  }

  /**
   * Where an enemy stands, or null if it may not be fought: not itself, hostile,
   * alive, not landing, and not so far from home that taking it would break the
   * leash. The one validity test every targeting decision goes through.
   */
  private validPosition(id: string, tagged: ReadonlySet<string>, nowMs: number): [number, number, number] | null {
    if (id === this.actorId || id === this.entityId || !this.hostile(id, tagged)) return null;
    const net = this.ctx.netState;
    if (net?.get(combatKey.dead(id)) === true) return null;
    // A downed body is out of the fight: never targeted, never finished (core isDowned).
    if (net && isDowned(net, id)) return null;
    // A body that just logged in or arrived from another layer is settling.
    // Leave it alone — landing.ts makes this a contract.
    if (net && isLanding(net, id, nowMs)) return null;
    const p = this.positionOf(id);
    // Never take a fight that would break the leash before it starts.
    if (!p) return null;
    { const a = this.anchorFor(p); if (Math.hypot(p[0] - a[0], p[2] - a[2]) > this.param<number>("leash")) return null; }
    return p;
  }

  /**
   * Would it notice this one? Inside `hearRadius` always; otherwise only inside
   * the sight cone — which is what lets a player walk up behind a mob.
   * Line of sight is a separate test (canSee), run once for the winner.
   */
  private notices(me: readonly [number, number, number], at: readonly [number, number, number], d: number, id: string): boolean {
    if (d <= this.param<number>("hearRadius") * this.noticeScale(id)) return true;
    const half = this.param<number>("sightAngle");
    if (half >= 180) return true;
    if (d < 1e-4) return true;
    const cos = ((at[0] - me[0]) * Math.sin(this.yaw) + (at[2] - me[2]) * Math.cos(this.yaw)) / d;
    return cos >= Math.cos(half * DEG);
  }

  /**
   * How noticeable a body is, as a multiplier on `aggroRange` and
   * `hearRadius` — 1 = plainly, 0.3 = sneaking: netState `notice/<bodyId>`
   * (core `readNotice`), written by whatever stealth system the game has.
   * Every acquisition goes through this; a target already held is kept
   * whatever it says (a stealth escape is `mob.threat` kind `forget`).
   */
  private noticeScale(id: string): number {
    return readNotice(this.ctx.netState, id);
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
    // (an empty list is an answer too: a lone camp with nobody near rechecks once a second, not every think)
    if (now - this.candidatesAt < 1) return this.candidateCache;
    this.candidatesAt = now;
    const tagged = this.taggedTargets();
    const ids = new Set(tagged);
    const net = this.ctx.netState;
    if (this.faction && net) for (const id of combatants(net)) ids.add(id);
    // Only the hostile ones: in a camp of three hundred, the other 299 are
    // friends, and every think used to walk them all. Every pick re-checks
    // hostility (validPosition), so this only narrows the list, for a second.
    const out: string[] = [];
    for (const id of ids) if (id !== this.actorId && id !== this.entityId && this.hostile(id, tagged)) out.push(id);
    this.candidateCache = out;
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
    if (fromHome <= Math.max(1.5, this.route.length ? 1.5 : this.param<number>("roam") * 0.5)) {
      this.heal();
      this.dir = [0, 0];
      this.moveSpeed = 0;
      this.transition("idle");
      this.nextRoamAt = now + this.param<number>("roamPause") * (0.5 + this.phase);
      return;
    }
    const back = this.anchorFor(me);
    this.steer(me, [back[0] - me[0], back[2] - me[2]], this.param<number>("roamSpeed"), dt, now);
  }

  /** Where the leash is measured from: home, or the nearest point of the patrol route. */
  private anchorFor(p: readonly number[]): readonly [number, number, number] {
    return this.route.length ? nearestOnRoute(this.route, p) : this.home;
  }

  /** Walk the patrol route, point to point and back. */
  private patrolStep(me: readonly [number, number, number], dt: number, now: number): void {
    const target = this.route[this.routeAt]!;
    if (Math.hypot(target[0] - me[0], target[2] - me[2]) < 1.2) {
      if (this.route.length > 1) {
        if (this.routeAt + this.routeDir < 0 || this.routeAt + this.routeDir >= this.route.length) this.routeDir = -this.routeDir;
        this.routeAt += this.routeDir;
      }
      return;
    }
    if (this.state !== "roam") this.transition("roam");
    const result = this.steer(me, [target[0] - me[0], target[2] - me[2]], this.param<number>("roamSpeed"), dt, now);
    if (result.blocked && result.dir[0] === 0 && result.dir[1] === 0) {
      // a blocked leg turns the patrol round rather than pushing at a wall forever
      this.routeDir = -this.routeDir;
      this.routeAt = Math.max(0, Math.min(this.route.length - 1, this.routeAt + this.routeDir));
    }
  }

  /** Nothing to fight: mill about inside the roam radius, or stand still. */
  private wander(me: readonly [number, number, number], dt: number, now: number): void {
    if (this.route.length) {
      this.patrolStep(me, dt, now);
      return;
    }
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
      this.faceGoal = Math.atan2(result.dir[0], result.dir[1]);
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
    if (this.owner) return this.petmates(me);
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

  /** A pet keeps out of its owner and the owner's other pets (pet/<id> records naming the same owner). */
  private petmates(me: readonly [number, number, number]): Array<[number, number, number]> {
    const out: Array<[number, number, number]> = [];
    const net = this.ctx.netState;
    const spacing = Math.max(0.6, this.param<number>("separation"));
    const near = (id: string): void => {
      const at = this.positionOf(id);
      if (at && Math.hypot(at[0] - me[0], at[2] - me[2]) <= spacing * 3) out.push([at[0], at[2], spacing]);
    };
    near(this.owner);
    if (net) for (const key of net.keys("pet/")) {
      const id = key.slice(4);
      if (id !== this.actorId && readPet(net, id)?.owner === this.owner) near(id);
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
  private drive(body: THREE.Object3D, dir: readonly [number, number], speed: number, now: number, dt: number): void {
    const ud = body.userData as Record<string, unknown>;
    // another script holds the drive (a shove), or scales it (a slow, a root): see "How it moves"
    const held = typeof ud["driveHeldUntil"] === "number" && (ud["driveHeldUntil"] as number) > now;
    if (!held) {
      const scale = typeof ud["driveScale"] === "number" && Number.isFinite(ud["driveScale"]) ? Math.max(0, ud["driveScale"] as number) : 1;
      ud["impulseVel"] = [dir[0] * speed * scale, dir[1] * speed * scale];
      ud["impulseUntil"] = now + 0.3;
    }
    // Facing while standing still: the controller only turns a body that is
    // moving, so an attacker that stops would keep swinging at the spot where
    // its target used to be. `faceYaw` is the controller's override for that.
    //
    // The brain turns the claimed yaw itself, at a FINITE rate: slow while a
    // move winds up (stepping round a heavy swing works, and a tank can hold
    // the facing), quicker otherwise. The controller then smooths toward it.
    if (this.faceGoal !== null) {
      const winding = now < this.windupUntil && !(this.lunge && now >= this.lunge.from);
      const rate = (winding ? this.windupTurn : this.param<number>("turnRate")) * DEG;
      this.yaw = approachAngle(this.yaw, this.faceGoal, rate * dt);
      ud["faceYaw"] = this.yaw;
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
      winding: now < this.windupUntil ? { target: this.windupTargetId, left: Math.round((this.windupUntil - now) * 100) / 100 } : null,
      stunned: now < this.stunnedUntil,
      moves: this.moves.map((m, i) => ({ ability: m.ability, ready: Math.max(0, Math.round((this.moveReadyAt[i]! - now) * 10) / 10) })),
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
    return p ? groundHeightAt(this.ctx.sim, p[0], p[2], p[1], { up: 1.2 }) : null;
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

/** An enemy a move could go for, as `enemies` sees it this instant. */
interface Enemy {
  id: string;
  at: [number, number, number];
  /** Horizontal metres from the mob. */
  d: number;
  /** In the mob's rear half (behind the line through it, square to its facing). */
  behind: boolean;
}

/** Step angle `from` toward `to` by at most `step` radians, the short way round. */
function approachAngle(from: number, to: number, step: number): number {
  let diff = to - from;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  if (Math.abs(diff) <= step) return to;
  return from + Math.sign(diff) * step;
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
