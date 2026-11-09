import { describe, expect, it } from 'vitest';
import { applyOps, AssetLibrary, createScene, type Op } from '@hitreg/core';
import { LoopbackHub } from '@hitreg/net';
import { GameServer, HeadlessWorld, NpcManager, defaultRegistry } from '../src/index.js';

describe('NPC respawn policy', () => {
  it('keeps bosses dead, waits a full hour for authored and cloned trash, and preserves the ordinary server delay', async () => {
    const registry = defaultRegistry();
    const ops: Op[] = ['ordinary', 'hourly', 'boss'].map((id, i) => ({ op: 'add-entity', id, entity: {
      name: id, parent: null, tags: ['npc'], components: { transform: { position: [i * 4, 0, 0] },
        ...(id === 'ordinary' ? {} : { npcRespawn: { seconds: id === 'boss' ? 0 : 3600 } }) },
    } }));
    const doc = applyOps(createScene('respawn'), ops, registry).doc;
    const world = await HeadlessWorld.create({ doc, registry, assets: new AssetLibrary(), fixedHz: 1 });
    const hub = new LoopbackHub({ manualFlush: true });
    const server = new GameServer({ world, transport: hub.connect('host'), terrain: null, playerTemplate: null });
    const npcs = new NpcManager(server, { respawnSeconds: 20, dormancy: false });
    try {
      expect(npcs.spawn('hourly', [12, 0, 0], { id: 'patrol' })).not.toBeNull();
      for (const id of ['ordinary', 'hourly', 'boss', 'patrol']) world.netState.set(`combat/${id}.dead`, true);
      server.tick(); // death timestamps
      for (let i = 0; i < 3599; i++) server.tick();
      expect(world.netState.get('combat/ordinary.dead')).not.toBe(true);
      for (const id of ['hourly', 'boss', 'patrol']) expect(world.netState.get(`combat/${id}.dead`)).toBe(true);
      server.tick(); // exactly 3600 simulated seconds after death was observed
      expect(world.netState.get('combat/hourly.dead')).not.toBe(true);
      expect(world.netState.get('combat/patrol.dead')).not.toBe(true);
      expect(world.netState.get('combat/boss.dead')).toBe(true);
      expect(world.entities.get('hourly')?.components['npcRespawn']).toEqual({ seconds: 3600 });
      expect(world.entities.get('patrol')?.components['npcRespawn']).toEqual({ seconds: 3600 });
    } finally { world.dispose(); }
  });
});
