import {
  CHARACTER_EVENTS,
  PORTAL_EVENTS,
  QUEST_EVENTS,
  PORTAL_LANDING_LIFT,
  PORTAL_TRIGGER_DEFAULTS,
  portalVolumeOf,
  portalVolumeDistance,
  yawOfQuaternion,
  dialogueConditionSchema,
  isTransferLocked,
  portalEventDecls,
  portalKey,
  portalRecordSchema,
  testCondition,
  type DialogueCondition,
  type NpcMemory,
  type PortalTravel,
  type PortalVolume,
  type Quest,
  type QuestJournal,
} from "@hitreg/core";
import * as THREE from "three";
import { Script, type ScriptEventDecl } from "./script.js";
import { readSheet, sheetStoreOf, type SheetStoreLike } from "./character-store.js";
import { worldFactsAt } from "./world-facts.js";

/**
 * A door a player USES to go somewhere else: the mouth of a barrow, a rift, the
 * way back out of a dungeon. The far side need not match the facade — the
 * player is moved to a named anchor entity in the target scene ("game black
 * magic").
 *
 * Put it on an entity tagged `interactable` (npc-ui then shows the inspect icon
 * and the `[E] <prompt> <name>` line). A player who uses it sends the ordinary
 * `player.interact`; HERE, on the session authority, the portal checks the
 * sender owns the body, stands within `radius`, is not dead or held by a fight
 * (`transferLock`), and meets `condition` — a refusal comes back as a
 * `character.refused` toast with `refusal`. A cleared player gets the
 * `portal.travel` event (authority-local); the HOST moves them — a layer asks
 * main for an instance and transfers the character, the playground's local
 * play swaps scenes, the headless harness swaps worlds. The host writes
 * `portal/<bodyId>` (the arrival anchor, and the way back) before the body
 * leaves, so a reconnect inside the instance still knows the way out.
 *
 * WALK-THROUGH (`mode: "trigger"`): no key press. The portal owns a box in
 * its own local space (`halfExtents`, `offset`); on the authority, every
 * fixed tick, a `player` body that ENTERS it (outside last tick, inside now,
 * having walked in rather than been placed) is checked exactly as a use is and
 * sent through. Put the box 4–5 m down a passage that carries on into black
 * past it, so the player walks into darkness rather than into a wall
 * (docs/scene-authoring.md → "Portals"). A refusal is said once per entry. A
 * body that appears inside or beside a volume (an arrival) is ignored for
 * `arrivalGrace` seconds (or until it has walked 1.5 m clear of where it
 * first stood outside: an arrival that turns straight round to leave is
 * walking in) and until it has been outside — no ping-pong,
 * and an arrival anchor may sit in the return portal's own volume. The
 * playground darkens the screen over the last `fade` metres before it.
 *
 * A RETURN portal (`back: true`) sends the player to the point recorded when
 * they came in (their `portal/<bodyId>.return`), on the layer they left when it
 * is still up. docs/hosting.md → "Portals".
 */
/** metres a body that arrived outside a trigger box must walk before it may trip the box inside the arrival grace */
const PORTAL_ARM_WALK = 1.5;

export class PortalScript extends Script {
  static override scriptName = "portal";
  static override params = {
    mode: {
      default: "interact",
      description:
        '"interact" = used with [E] on an `interactable` entity within `radius`; "trigger" = walked through: a player body entering the box (halfExtents/offset) is sent with no key press',
    },
    halfExtents: {
      default: [...PORTAL_TRIGGER_DEFAULTS.halfExtents],
      description: "trigger mode: half size of the box in the portal's local space, metres [x across, y up, z along] (default 2.4 wide, 2.6 high, 1.5 deep)",
    },
    offset: {
      default: [...PORTAL_TRIGGER_DEFAULTS.offset],
      description: "trigger mode: box centre in the portal's local space (default [0, 1.3, 0]: standing on the portal's origin on the floor)",
    },
    fade: {
      default: PORTAL_TRIGGER_DEFAULTS.fade,
      min: 0,
      max: 10,
      description: "trigger mode: metres before the box over which the traveller's screen darkens (presentation; 0 = a plain curtain)",
    },
    arrivalGrace: {
      default: PORTAL_TRIGGER_DEFAULTS.arrivalGrace,
      min: 0,
      max: 30,
      description: "trigger mode: seconds a body that just appeared (an arrival) is ignored; it must also have been OUTSIDE the box once",
    },
    scene: {
      default: "",
      description:
        "destination scene id (an instance on a cluster; any project folder's scene). A return portal uses it only when the traveller has no recorded way back",
    },
    anchor: { default: "", description: "entity id in the destination scene the traveller lands on, facing its yaw (an `instance-entry` anchor)" },
    back: {
      default: false,
      description: "a RETURN portal: brings the traveller back to the point recorded when they entered (portal/<bodyId>.return), ignoring scene/anchor unless none is recorded",
    },
    returnAnchor: {
      default: "",
      description: "entering: entity id in THIS scene a later return lands on (facing its yaw); empty = where the traveller stood when they used the portal, turned away from it",
    },
    radius: { default: 3, min: 1, max: 20, description: "metres (horizontal) a player must be within to use it; vertical slack is 4 m" },
    prompt: { default: "Enter", description: "verb the inspect icon and the [E] line show (\"Enter\", \"Leave\", \"Descend into\")" },
    name: { default: "", description: "what the prompt names (\"the Fieldfast Barrow\"); empty = the entity's name" },
    party: { default: true, description: "the traveller's party goes together (a cluster pulls the other members into the same instance); local play moves one player" },
    condition: {
      default: {} as Record<string, unknown>,
      description:
        "dialogue condition the traveller must meet (quest status, a memory flag, an item, level, coins…; the same shape as a dialogue `if`). {} = anyone",
    },
    refusal: { default: "The way is shut.", description: "line shown (a toast) to a traveller who does not meet `condition`" },
    cooldown: { default: 3, min: 0, max: 60, description: "seconds a traveller's repeated uses are ignored (a double click is one trip)" },
  };
  static override events: ScriptEventDecl[] = [...portalEventDecls];

  private store!: SheetStoreLike;
  private condition: DialogueCondition | null = null;
  private conditionBroken = false;
  private readonly lastUse = new Map<string, number>();
  private volume: PortalVolume | null = null;
  /** trigger mode: what this portal last saw of each player body */
  private readonly bodies = new Map<string, { obj: object; inside: boolean; seenAt: number; since: number; armed: boolean; last: [number, number, number]; outAt: [number, number, number] | null }>();
  private readonly v = new THREE.Vector3();

  override onStart(): void {
    this.store = sheetStoreOf(this.ctx);
    this.volume = portalVolumeOf(this.ctx.params);
    const self = this.ctx.getEntity(this.entityId);
    if (!this.volume && self && !self.tags.includes("interactable")) console.warn(`[portal] ${this.entityId}: tag it "interactable" so players can use it`);
    const raw = this.param<Record<string, unknown>>("condition");
    if (raw && typeof raw === "object" && Object.keys(raw).length > 0) {
      const parsed = dialogueConditionSchema.safeParse(raw);
      if (parsed.success) this.condition = parsed.data;
      else {
        // a typo must not open the door to everyone: a broken condition refuses
        this.conditionBroken = true;
        console.warn(`[portal] ${this.entityId}: invalid condition — refusing every traveller`, parsed.error.issues.slice(0, 2));
      }
    }
    if (!this.param<boolean>("back") && !this.param<string>("scene")) console.warn(`[portal] ${this.entityId}: no destination scene`);
    this.ctx.events?.on(QUEST_EVENTS.interact, (payload, meta) => {
      const p = payload as { actorId?: unknown; entityId?: unknown };
      if (p.entityId !== this.entityId || typeof p.actorId !== "string" || !this.store.isAuthority()) return;
      if (meta?.from !== undefined && this.store.get(`owner/${p.actorId}`) !== meta.from) return;
      if (this.volume) return; // a walk-through portal is walked through
      this.use(p.actorId);
    });
  }

  override onParamsChanged(): void {
    this.volume = portalVolumeOf(this.ctx.params);
  }

  /** Trigger mode, authority: send every player body that walked INTO the box this tick. */
  override onFixedUpdate(): void {
    const vol = this.volume;
    if (!vol || !this.store.isAuthority()) return;
    const portal = this.ctx.getObject(this.entityId);
    if (!portal) return;
    portal.updateWorldMatrix(true, false);
    const now = this.ctx.now();
    const graceMs = this.param<number>("arrivalGrace") * 1000;
    const seen = new Set<string>();
    for (const id of this.ctx.findByTag("player")) {
      const o = this.ctx.getObject(id);
      if (!o) continue;
      seen.add(id);
      const w = o.getWorldPosition(this.v);
      const at: [number, number, number] = [w.x, w.y, w.z];
      const local = portal.worldToLocal(w);
      const inside = portalVolumeDistance([local.x, local.y, local.z], vol) === 0;
      let b = this.bodies.get(id);
      // first sight, a new body under the same id, or back after a gap (it left this world and came back): an ARRIVAL, which never fires until it has been outside
      if (!b || b.obj !== o || now - b.seenAt > 500) {
        this.bodies.set(id, { obj: o, inside, seenAt: now, since: now, armed: false, last: at, outAt: inside ? null : at });
        continue;
      }
      const was = b.inside;
      const prev = b.last;
      const step = Math.hypot(at[0] - prev[0], at[2] - prev[2]);
      b.inside = inside;
      b.seenAt = now;
      b.last = at;
      if (!inside) {
        // armed once the grace is over, or once it has WALKED clear of where it first stood outside: a traveller who
        // arrives and turns straight round to leave walks in on purpose (the grace only stops a body placed in or
        // against the box, or still holding a key from the trip, from bouncing straight back)
        b.outAt ??= at;
        if (now - b.since >= graceMs || Math.hypot(at[0] - b.outAt[0], at[2] - b.outAt[2]) >= PORTAL_ARM_WALK) b.armed = true;
        continue;
      }
      // the entering edge only, walked in (a teleport across the box is not walking in)
      if (was || !b.armed || step > 3) continue;
      this.use(id, prev);
    }
    for (const id of this.bodies.keys()) if (!seen.has(id)) this.bodies.delete(id);
  }

  private positionOf(id: string): [number, number, number] | null {
    const o = this.ctx.getObject(id);
    if (!o) return null;
    const p = o.getWorldPosition(o.position.clone());
    return [p.x, p.y, p.z];
  }

  private refuse(actorId: string, error: string): void {
    this.ctx.events?.emit(CHARACTER_EVENTS.refused, { actorId, request: "portal", error });
  }

  private holds(actorId: string): boolean {
    if (this.conditionBroken) return false;
    if (!this.condition) return true;
    const at = this.positionOf(actorId);
    return testCondition(this.condition, {
      npcId: this.entityId,
      memory: (this.store.get(`npc/${actorId}`) as NpcMemory | undefined) ?? null,
      journal: (this.store.get(`quests/${actorId}`) as QuestJournal | undefined) ?? null,
      sheet: readSheet(this.store, actorId),
      quest: (id) => {
        const a = this.ctx.getDataAsset?.(id);
        return a?.type === "quest" ? (a.data as Quest) : undefined;
      },
      metBefore: false,
      world: at ? worldFactsAt(this.ctx, this.store, at[0], at[2]) : null,
    });
  }

  /**
   * Authority: check the traveller, then hand the trip to the host. `cameFrom`
   * (trigger mode) is where the body stood outside the box the tick before it
   * walked in: the way back lands just outside it, not inside the trigger.
   */
  private use(actorId: string, cameFrom?: [number, number, number]): void {
    const now = this.ctx.now();
    const last = this.lastUse.get(actorId);
    if (last !== undefined && now - last < this.param<number>("cooldown") * 1000) return;
    const me = this.positionOf(actorId);
    const it = this.positionOf(this.entityId);
    if (!me || !it) return;
    if (!cameFrom && (Math.hypot(me[0] - it[0], me[2] - it[2]) > this.param<number>("radius") + 0.5 || Math.abs(me[1] - it[1]) >= 4)) return;
    if (this.store.get(`combat/${actorId}.dead`) === true) return;
    if (isTransferLocked(this.store, actorId, now)) {
      this.refuse(actorId, "You cannot leave in the middle of a fight.");
      return;
    }
    if (!this.holds(actorId)) {
      this.refuse(actorId, this.param<string>("refusal"));
      return;
    }
    const back = this.param<boolean>("back");
    const recorded = portalRecordSchema.safeParse(this.store.get(portalKey(actorId)) ?? {});
    const way = back && recorded.success ? recorded.data.return : undefined;
    const scene = way?.scene ?? this.param<string>("scene");
    if (!scene) {
      this.refuse(actorId, back ? "The way back is lost." : this.param<string>("refusal"));
      return;
    }
    this.lastUse.set(actorId, now);
    const anchor = this.param<string>("anchor");
    const travel: PortalTravel = {
      actorId,
      portalId: this.entityId,
      scene,
      back,
      party: this.param<boolean>("party"),
      ...(anchor && !way ? { anchor } : {}),
      ...(back ? {} : { returnTo: this.returnPoint(cameFrom ?? me, it, cameFrom !== undefined) }),
    };
    this.ctx.events?.emit(PORTAL_EVENTS.travel, travel);
  }

  /** Where a later return lands: the `returnAnchor`, else where the traveller stands, turned away from the portal. */
  private returnPoint(me: [number, number, number], it: [number, number, number], walked = false): { position: [number, number, number]; yaw: number } {
    const id = this.param<string>("returnAnchor");
    if (id) {
      const o = this.ctx.getObject(id);
      if (o) {
        const p = o.getWorldPosition(o.position.clone());
        const q = o.getWorldQuaternion(o.quaternion.clone());
        return { position: [p.x, p.y + PORTAL_LANDING_LIFT, p.z], yaw: yawOfQuaternion([q.x, q.y, q.z, q.w]) };
      }
    }
    const dx = me[0] - it[0];
    const dz = me[2] - it[2];
    const d = Math.hypot(dx, dz);
    const yaw = d > 1e-3 ? Math.atan2(dx, dz) : 0;
    // walked in: a metre further back out of the box, so the way back lands clear of it, facing away
    const out = walked && d > 1e-3 ? 1 / d : 0;
    return { position: [me[0] + dx * out, me[1], me[2] + dz * out], yaw };
  }
}
