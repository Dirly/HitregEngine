import { describe, expect, it } from 'vitest';
import { defaultWorldRecipe, worldRecipeSchema, passageSchema, applyRecipeEdits, createWorldField, buildVoxelMesh, featureFootprint, meshDensity } from '../src/index.js';
function flat() {
    const r = defaultWorldRecipe();
    return worldRecipeSchema.parse({
        ...r, cellSize: 48, resolution: 24, bounds: undefined, terrain: {
            ...r.terrain, overhang: {
                ...r.terrain.overhang, strength: 0
            }, caves: {
                ...r.terrain.caves, enabled: false
            }
        }, features: {
            heightPatches: [{
                    id: 'flat', origin: [-200, -200], size: [400, 400], columns: 2, rows: 2, heights: [100, 100, 100, 100], blend: 1, feather: 1
                }]
        }
    });
}
const chamber = () => passageSchema.parse({
    id: 'chamber', start: [25, 36, 30], length: 36, width: 30, height: 4, footprint: 'ellipse', wallNoise: 3, noiseScale: 12, noiseDetail: .4, roofRise: 7, roofNoise: 1, connectionBand: 1, seed: 17
});
describe('bounded organic flat-floor chambers and passage roofs', () => {
    it('validates the new envelopes, preserves old defaults and returns an exact inverse', () => {
        const p = chamber();
        for (const patch of [{
                noiseDetail: 1.1
            }, {
                roofRise: -1
            }, {
                roofNoise: Infinity
            }, {
                footprint: 'unknown'
            }])
            expect(passageSchema.safeParse({
                ...p, ...patch
            }).success).toBe(false);
        const old = passageSchema.parse({
            start: [1, 36, 0], length: 20, width: 6, height: 4
        });
        expect([old.footprint, old.noiseDetail, old.roofRise, old.roofNoise]).toEqual(['box', 0, 0, 0]);
        expect(featureFootprint('passages', p)).toEqual({
            x0: 3, x1: 47, z0: 23, z1: 73
        });
        const base = flat(), edit = applyRecipeEdits(base, [{
                edit: 'add-feature', kind: 'passages', feature: p
            }]);
        expect(applyRecipeEdits(edit.recipe, edit.inverse).recipe).toEqual(base);
    });
    it('retains protected ellipse air, radial end relief bounds, flat floor and bounded domed headroom', () => {
        const p = chamber(), f = createWorldField(applyRecipeEdits(flat(), [{
                edit: 'add-feature', kind: 'passages', feature: p
            }]).recipe);
        expect(f.density(25, 46, 48)).toBeGreaterThan(0);
        expect(f.density(25, 48.01, 48)).toBeLessThan(0);
        for (let a = 0; a < Math.PI * 2; a += .1) {
            const x = 25 + 15 * Math.cos(a), z = 48 + 18 * Math.sin(a);
            expect(f.density(x, 38, z)).toBeGreaterThanOrEqual(-1e-6);
            const r = Math.hypot(x - 25, z - 48), xx = 25 + (x - 25) * (1 + 3.01 / r), zz = 48 + (z - 48) * (1 + 3.01 / r);
            expect(f.density(xx, 38, zz)).toBeLessThan(0);
        }
        for (const [x, z] of [[25, 48], [20, 40], [30, 56]]) {
            expect(f.density(x!, 36, z!)).toBe(0);
            expect(f.density(x!, 35.99, z!)).toBeLessThan(0);
        }
        expect(f.heightRange(0, 0, 48, 48).min).toBeLessThanOrEqual(32);
        expect(f.density(25, 38, 22.99)).toBeLessThan(0);
        expect(f.density(25, 38, 73.01)).toBeLessThan(0);
    });
    it('agrees scalar and bulk for both axis/direction variants and union connections', () => {
        const p = chamber(), box = passageSchema.parse({
            start: [25, 36, 0], length: 55, width: 6, height: 4, wallNoise: 3, noiseDetail: .4, roofRise: 1.4, roofNoise: .6
        });
        for (const q of [p, passageSchema.parse({
                ...p, start: [66, 36, 25], axis: 'x', direction: -1
            })]) {
            const f = createWorldField(applyRecipeEdits(flat(), [{
                    edit: 'add-feature', kind: 'passages', feature: q
                }, {
                    edit: 'add-feature', kind: 'passages', feature: box
                }]).recipe), b = f.sampleBlock({
                origin: [0, 32, 20], nx: 26, ny: 11, nz: 28, step: 2
            });
            for (let z = 0; z < 28; z++)
                for (let y = 0; y < 11; y++)
                    for (let x = 0; x < 26; x++)
                        expect(b[x + y * 26 + z * 286]).toBeCloseTo(f.density(x * 2, 32 + y * 2, 20 + z * 2), 5);
        }
    });
    it('meshes a flat chamber floor and keeps raised roof seam skirts out of playable air', () => {
        const f = createWorldField(applyRecipeEdits(flat(), [{
                edit: 'add-feature', kind: 'passages', feature: chamber()
            }]).recipe), md = meshDensity(f, {
            x0: 0, x1: 48, y0: 30, y1: 55, z0: 24, z1: 72
        });
        for (let x = 16; x <= 34; x += 1)
            for (let z = 38; z <= 58; z += 1)
                expect(md.down(x, z, 37, 34)).toBeCloseTo(36, 5);
        for (const cell of [[0, 0], [0, 1]] as [
            number,
            number
        ][]) {
            const m = buildVoxelMesh(f, {
                kind: 'voxel', world: 'test', cell, mesher: 'mc'
            });
            let roofSkirts = 0, curtains = 0, groundSkirts = 0;
            for (let i = 0; i < m.indices.length; i += 3) {
                const vs = [m.indices[i]!, m.indices[i + 1]!, m.indices[i + 2]!].map(v => [m.positions[v * 3]!, m.positions[v * 3 + 1]!, m.positions[v * 3 + 2]! + cell[1] * 48]);
                if (vs.every(v => Math.abs(v[2]! - 48) < 1e-5)) {
                    const x = vs.reduce((s, v) => s + v[0]!, 0) / 3, y = vs.reduce((s, v) => s + v[1]!, 0) / 3;
                    if (x > 20 && x < 30 && y > 36.01 && y < 43)
                        curtains++;
                    if (x > 20 && x < 30 && y > 47 && y < 55)
                        roofSkirts++;
                    if (y > 95 && y < 100)
                        groundSkirts++;
                }
            }
            expect(curtains).toBe(0);
            expect(roofSkirts).toBeGreaterThan(0);
            expect(groundSkirts).toBeGreaterThan(0);
        }
    });
});
