/**
 * NpcManager — the server's population, managed at runtime.
 *
 * Two jobs:
 *
 * 1. **Runtime spawns.** An NPC is a subtree of entity docs (a body with a
 *    rigidbody + collider + script, and children carrying combat-actor /
 *    combat-caster / a brain) placed at a world point. The manager clones a
 *    TEMPLATE — a subtree already in the scene (a `hero0` to copy) or docs
 *    handed in directly — under fresh ids, rewrites the params that name the
 *    old body, settles it onto the ground, and hands it to `GameServer.spawn`,
 *    which replicates the docs to every client. This is the hook the AI
 *    dungeon master drives: "put three boars here" is one call.
 *
 * 2. **Respawn.** A dead combatant (netState `combat/<id>.dead === true`)
 *    comes back after `respawnSeconds` at its spawn point with fresh pools —
 *    by despawning and re-spawning the subtree, so every script restarts from
 *    onStart the same way it did at boot. Authored scene NPCs get this too;
 *    they respawn in place under the SAME ids (clients already have the doc).
 */

import type { EntityDoc } from "@hitreg/core";
import type { GameServer } from "./server.js";

export interface NpcTemplate {
  rootId: string;
  entities: Record<string, EntityDoc>;
}

export interface NpcRecord {
  id: string;
  /** Template the NPC was spawned from (a scene subtree or a registered template). */
  template: string;
  ids: string[];
  spawnAt: [number, number, number];
  yaw: number;
  /** Server tick the NPC was seen dead, or null while alive. */
  deadSince: number | null;
  /** Scene-authored (true) or spawned at runtime (false) — decides whether clients need the docs. */
  authored: boolean;
}

export interface NpcManagerOptions {
  /** Seconds a dead combatant lies before respawning; 0 disables. Default 20. */
  respawnSeconds?: number;
  /** Register every scene subtree whose root carries one of these tags as both a template and a managed NPC. Default ["npc"]. */
  npcTags?: string[];
}

function rewriteIds(value: unknown, map: Map<string, string>): unknown {
  if (typeof value === "string") return map.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => rewriteIds(v, map));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = rewriteIds(v, map);
    return out;
  }
  return value;
}

export class NpcManager {
  readonly server: GameServer;
  readonly templates = new Map<string, NpcTemplate>();
  readonly npcs = new Map<string, NpcRecord>();
  private readonly respawnTicks: number;
  private counter = 0;

  constructor(server: GameServer, opts: NpcManagerOptions = {}) {
    this.server = server;
    const seconds = opts.respawnSeconds ?? 20;
    this.respawnTicks = seconds > 0 ? Math.round(seconds / server.world.fixedDt) : 0;
    const tags = opts.npcTags ?? ["npc"];
    const world = server.world;
    // adopt authored NPCs: every root entity with a rigidbody + a combat child, or an npc tag
    for (const [id, e] of world.entities) {
      if (e.parent !== null) continue;
      const tagged = tags.some((t) => e.tags.includes(t));
      const hasBody = e.components["rigidbody"] !== undefined && e.components["script"] !== undefined;
      const combatChild = [...world.entities].some(([cid, c]) => c.parent === id && world.netState.get(`combat/${id}.hp`) !== undefined && cid !== id);
      if (!tagged && !(hasBody && combatChild)) continue;
      if (e.tags.includes("player")) continue;
      const ids = world.subtree(id);
      const entities: Record<string, EntityDoc> = {};
      for (const eid of ids) entities[eid] = structuredClone(world.entities.get(eid)!);
      this.templates.set(id, { rootId: id, entities });
      const p = world.positionOf(id) ?? [0, 0, 0];
      this.npcs.set(id, { id, template: id, ids, spawnAt: p, yaw: 0, deadSince: null, authored: true });
    }
    world.afterStep.add(this.afterStep);
  }

  /** Register a template by name (a subtree of docs; the root is the one with parent null). */
  register(name: string, entities: Record<string, EntityDoc>): void {
    const rootId = Object.entries(entities).find(([, e]) => e.parent === null)?.[0];
    if (!rootId) throw new Error(`template "${name}": no root entity (parent: null)`);
    this.templates.set(name, { rootId, entities: structuredClone(entities) });
  }

  /**
   * Spawn a template at a point. `id` defaults to `<template>#<n>`. Returns
   * the record, or null when the template is unknown.
   */
  spawn(template: string, at: [number, number, number], opts: { id?: string; yaw?: number; params?: Record<string, unknown> } = {}): NpcRecord | null {
    const tpl = this.templates.get(template);
    if (!tpl) return null;
    const id = opts.id ?? `${tpl.rootId}#${++this.counter}`;
    if (this.server.world.entities.has(id)) return null;
    const map = new Map<string, string>();
    for (const oldId of Object.keys(tpl.entities)) {
      map.set(oldId, oldId === tpl.rootId ? id : `${id}/${oldId.startsWith(`${tpl.rootId}-`) ? oldId.slice(tpl.rootId.length + 1) : oldId}`);
    }
    const yaw = opts.yaw ?? 0;
    const entities: Record<string, EntityDoc> = {};
    for (const [oldId, entity] of Object.entries(tpl.entities)) {
      const doc: EntityDoc = {
        ...structuredClone(entity),
        parent: entity.parent === null ? null : (map.get(entity.parent) ?? entity.parent),
        components: rewriteIds(entity.components, map) as Record<string, unknown>,
      };
      if (oldId === tpl.rootId) {
        doc.name = id;
        const transform = (doc.components["transform"] ?? {}) as Record<string, unknown>;
        doc.components["transform"] = { ...transform, position: at, rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)] };
        if (opts.params) {
          const script = doc.components["script"] as { name: string; params?: Record<string, unknown> } | undefined;
          if (script) script.params = { ...(script.params ?? {}), ...opts.params };
        }
      }
      entities[map.get(oldId)!] = doc;
    }
    // ground first: a body spawned into an unloaded cell falls forever
    this.server.terrain?.ensureAround(at[0], at[2], 1);
    this.server.spawn(entities);
    const record: NpcRecord = { id, template, ids: Object.keys(entities), spawnAt: at, yaw, deadSince: null, authored: false };
    this.npcs.set(id, record);
    return record;
  }

  /** Remove an NPC everywhere (authored ones too — they are gone until a server restart). */
  despawn(id: string): boolean {
    const record = this.npcs.get(id);
    if (!record) return false;
    this.npcs.delete(id);
    this.server.despawn(record.ids);
    this.clearCombatState(record.ids);
    return true;
  }

  /** Everything the manager knows, for the admin endpoint. */
  list(): Array<NpcRecord & { position: [number, number, number] | null; hp: unknown; dead: boolean }> {
    const world = this.server.world;
    return [...this.npcs.values()].map((r) => ({
      ...r,
      position: world.positionOf(r.id),
      hp: world.netState.get(`combat/${r.id}.hp`),
      dead: world.netState.get(`combat/${r.id}.dead`) === true,
    }));
  }

  private clearCombatState(ids: string[]): void {
    const net = this.server.world.netState;
    for (const id of ids) {
      for (const key of net.keys(`combat/${id}.`)) net.delete(key);
      for (const key of net.keys(`cooldown/${id}.`)) net.delete(key);
    }
  }

  /** Watches for deaths (respawn) and for bodies that left the world (teleport home). */
  private afterStep = (): void => {
    const world = this.server.world;
    const tick = world.tick;
    // Insurance against the one failure that is silent: a body with no
    // ground under it (a cell that failed to load, a bad spawn point) falls
    // forever and its scripts keep running, probing air. Put it back.
    if (tick % 30 === 0) {
      for (const record of this.npcs.values()) {
        const p = world.positionOf(record.id);
        if (p && p[1] < record.spawnAt[1] - 60) {
          console.warn(`[server:npcs] ${record.id} fell out of the world (y=${p[1].toFixed(0)}) — returned to spawn`);
          this.server.terrain?.ensureAround(record.spawnAt[0], record.spawnAt[2], 1);
          world.sim.setPosition(record.id, record.spawnAt);
        }
      }
    }
    if (this.respawnTicks === 0) return;
    for (const record of this.npcs.values()) {
      const dead = world.netState.get(`combat/${record.id}.dead`) === true;
      if (!dead) {
        record.deadSince = null;
        continue;
      }
      if (record.deadSince === null) {
        record.deadSince = tick;
        continue;
      }
      if (tick - record.deadSince < this.respawnTicks) continue;
      this.respawn(record);
    }
  };

  /** Tear the subtree down and bring it back fresh at its spawn point, same ids. */
  respawn(record: NpcRecord): void {
    const tpl = this.templates.get(record.template);
    if (!tpl) return;
    const world = this.server.world;
    // rebuild the docs exactly as spawn did, keeping this record's ids
    const docs: Record<string, EntityDoc> = {};
    for (const id of record.ids) {
      const live = world.entities.get(id) ?? this.server.runtimeDocs.get(id);
      if (live) docs[id] = structuredClone(live);
    }
    const root = docs[record.id];
    if (!root) return;
    const transform = (root.components["transform"] ?? {}) as Record<string, unknown>;
    root.components["transform"] = {
      ...transform,
      position: record.spawnAt,
      rotation: [0, Math.sin(record.yaw / 2), 0, Math.cos(record.yaw / 2)],
    };
    // the body's runtime channels (frozen, actionClip …) die with the object
    if (record.authored) {
      // clients already hold this doc: remove + re-add locally, no docs on the wire
      world.removeEntities(record.ids, { silent: true });
      this.clearCombatState(record.ids);
      this.server.terrain?.ensureAround(record.spawnAt[0], record.spawnAt[2], 1);
      world.addEntities({ ...world.base, entities: docs }, { silent: true });
    } else {
      this.server.despawn(record.ids);
      this.clearCombatState(record.ids);
      this.server.terrain?.ensureAround(record.spawnAt[0], record.spawnAt[2], 1);
      this.server.spawn(docs);
    }
    record.deadSince = null;
  }
}
