import { describe, expect, it } from 'vitest';
import { applyRecipeEdits, createWorldField, defaultWorldRecipe, heightPatchSchema, worldRecipeSchema, featureFootprint } from '../src/index.js';

const patch = { id:'image', origin:[0,0], size:[96,96], columns:2, rows:2, heights:[-8,4,16,28], blend:16, feather:16 };
describe('raster terrain patches', () => {
  it('validates dimensions and blend distance before an edit', () => {
    expect(heightPatchSchema.safeParse({...patch,heights:[1,2]}).success).toBe(false);
    expect(heightPatchSchema.safeParse({...patch,blend:49}).success).toBe(false);
  });
  it('interpolates elevations and returns exactly to the original field outside and on all edges', () => {
    const world=defaultWorldRecipe(), base=createWorldField(world);
    const edited=applyRecipeEdits(world,[{edit:'add-feature',kind:'heightPatches',feature:patch}]);
    const field=createWorldField(edited.recipe);
    expect(field.height(48,48)).toBeCloseTo(10,8);
    expect(field.height(24,48)).toBeCloseTo(7,8);
    for(const p of [[0,35],[96,35],[35,0],[35,96],[-1,35],[97,35]]) expect(field.height(p[0]!,p[1]!)).toBe(base.height(p[0]!,p[1]!));
    const e=.001;
    expect(Math.abs((field.height(e,35)-base.height(e,35))/e)).toBeLessThan(.01);
    expect(featureFootprint('heightPatches',patch)).toEqual({x0:0,z0:0,x1:96,z1:96});
    expect(applyRecipeEdits(edited.recipe,edited.inverse).recipe).toEqual(world);
  });
  it('feeds density and sea placement through the same heightfield', () => {
    const raw=defaultWorldRecipe();raw.terrain.overhang.strength=0;raw.terrain.caves.enabled=false;
    const world=worldRecipeSchema.parse(raw);
    const edited=applyRecipeEdits(world,[{edit:'add-feature',kind:'heightPatches',feature:{...patch,heights:[-6,-6,-6,-6]}}]);
    const field=createWorldField(edited.recipe);
    expect(field.height(48,48)).toBe(-6);
    expect(field.density(48,-6,48)).toBeCloseTo(0,8);
    expect(field.density(48,-7,48)).toBeLessThan(0);
    expect(field.density(48,-5,48)).toBeGreaterThan(0);
    expect(field.waterY(48,48)).toBe(world.seaLevel);
  });
  it('gives neighbouring mesher blocks identical shared samples through the blend and interior', () => {
    const world=applyRecipeEdits(defaultWorldRecipe(),[{edit:'add-feature',kind:'heightPatches',feature:patch}]).recipe;
    const field=createWorldField(world),step=2;
    const a=field.sampleBlock({origin:[-2,-10,28],nx:28,ny:24,nz:8,step});
    const b=field.sampleBlock({origin:[-8,-10,28],nx:31,ny:24,nz:8,step});
    for(let z=0;z<8;z++)for(let y=0;y<24;y++)for(let x=0;x<28;x++)expect(b[x+3+y*31+z*31*24]).toBe(a[x+y*28+z*28*24]);
  });
});
