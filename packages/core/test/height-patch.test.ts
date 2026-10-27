import { describe, expect, it } from 'vitest';
import { applyRecipeEdits, createWorldField, defaultWorldRecipe, heightPatchSchema, worldRecipeSchema, featureFootprint, prepareHeightPatch } from '../src/index.js';

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
  it('a MASKED patch (weights) pulls toward its heights only where weighted, and lets later ground show through elsewhere', () => {
    const world=defaultWorldRecipe();
    // 3x3 raster over 96 m: only the centre sample is held (weight 1), every other weight is 0
    const masked={id:'masked',origin:[0,0],size:[96,96],columns:3,rows:3,heights:[50,50,50,50,50,50,50,50,50],weights:[0,0,0,0,1,0,0,0,0],blend:4,filter:0};
    expect(heightPatchSchema.safeParse({...masked,weights:[0,1]}).success).toBe(false);
    const field=createWorldField(applyRecipeEdits(world,[{edit:'add-feature',kind:'heightPatches',feature:masked}]).recipe);
    const base=createWorldField(world);
    // the held sample is at 50; half way to a zero-weight corner the weight is a quarter (bilinear)
    expect(field.height(48,48)).toBeCloseTo(50,6);
    const q=base.height(24,24);
    expect(field.height(24,24)).toBeCloseTo(q+(50-q)*0.25,6);
    // a zero-weight sample is the ground under the patch, NOT a frozen copy: a patch applied BEFORE it shows through
    const under={id:'under',origin:[0,0],size:[96,96],columns:2,rows:2,heights:[-3,-3,-3,-3],blend:4,feather:4,filter:0};
    const both=createWorldField(applyRecipeEdits(world,[{edit:'add-feature',kind:'heightPatches',feature:under},{edit:'add-feature',kind:'heightPatches',feature:masked}]).recipe);
    const w=(8/48)**2;
    expect(both.height(8,8)).toBeCloseTo(-3+(50+3)*w,6);
    expect(both.height(48,48)).toBeCloseTo(50,6);
    // all-ones weights = the opaque patch
    const opaque={...masked,id:'opaque',weights:undefined};
    const ones={...masked,id:'ones',weights:masked.heights.map(()=>1)};
    const fo=createWorldField(applyRecipeEdits(world,[{edit:'add-feature',kind:'heightPatches',feature:opaque}]).recipe);
    const f1=createWorldField(applyRecipeEdits(world,[{edit:'add-feature',kind:'heightPatches',feature:ones}]).recipe);
    for(const p of [[10,10],[30,70],[48,48],[90,5]]) expect(f1.height(p[0]!,p[1]!)).toBeCloseTo(fo.height(p[0]!,p[1]!),8);
  });
  it('gives neighbouring mesher blocks identical shared samples through the blend and interior', () => {
    const world=applyRecipeEdits(defaultWorldRecipe(),[{edit:'add-feature',kind:'heightPatches',feature:patch}]).recipe;
    const field=createWorldField(world),step=2;
    const a=field.sampleBlock({origin:[-2,-10,28],nx:28,ny:24,nz:8,step});
    const b=field.sampleBlock({origin:[-8,-10,28],nx:31,ny:24,nz:8,step});
    for(let z=0;z<8;z++)for(let y=0;y<24;y++)for(let x=0;x<28;x++)expect(b[x+3+y*31+z*31*24]).toBe(a[x+y*28+z*28*24]);
  });
  it('raiseOnly never lowers the ground under the patch', () => {
    const world=defaultWorldRecipe(), base=createWorldField(world);
    const low={...patch,id:'low',heights:[-200,-200,-200,-200]};
    const cut=createWorldField(applyRecipeEdits(world,[{edit:'add-feature',kind:'heightPatches',feature:low}]).recipe);
    const kept=createWorldField(applyRecipeEdits(world,[{edit:'add-feature',kind:'heightPatches',feature:{...low,raiseOnly:true}}]).recipe);
    expect(cut.height(48,48)).toBeLessThan(base.height(48,48)-50);
    expect(kept.height(48,48)).toBe(base.height(48,48));
    const high=createWorldField(applyRecipeEdits(world,[{edit:'add-feature',kind:'heightPatches',feature:{...patch,heights:[400,400,400,400],raiseOnly:true}}]).recipe);
    expect(high.height(48,48)).toBeCloseTo(400,6);
  });
  it('a raiseOnly patch takes a column from the sea-cliff / butte walls only where it lifts gentle ground (hold)', () => {
    const flat=()=>0, stack=(x:number)=>(x<44?85:0), high=()=>50;
    const plain=prepareHeightPatch(heightPatchSchema.parse(patch),2,stack);
    const fill=(under:(x:number,z:number)=>number)=>prepareHeightPatch(heightPatchSchema.parse({...patch,raiseOnly:true}),2,under);
    expect(plain.hold(48,48)).toBe(1);                       // a plain patch: its weight
    expect(fill(flat).hold(48,48)).toBe(1);                  // lifts gentle ground: holds
    expect(fill(high).hold(48,48)).toBe(0);                  // lifts nothing (raster 10 under 50): the walls keep it
    expect(fill(stack).hold(48,48)).toBe(0);                 // a stack's top plane 4 m off: the walls keep it
    expect(fill(stack).apply(48,48,0)).toBeCloseTo(10,6);    // the height itself is still raised
  });
});

describe('calm height patches (built ground)', () => {
  it('switch the overhang noise off where the patch pulls the ground, and only there', () => {
    const raw = defaultWorldRecipe(); raw.terrain.overhang.strength = 4; raw.terrain.overhang.slopeStart = 0; raw.terrain.overhang.slopeEnd = 0.01; raw.terrain.caves.enabled = false;
    const world = worldRecipeSchema.parse(raw);
    const steep = { ...patch, heights: [0, 60, 0, 60] };
    const noisy = createWorldField(applyRecipeEdits(world, [{ edit: 'add-feature', kind: 'heightPatches', feature: steep }]).recipe);
    const calm = createWorldField(applyRecipeEdits(world, [{ edit: 'add-feature', kind: 'heightPatches', feature: { ...steep, calm: true } }]).recipe);
    let worst = 0, calmWorst = 0;
    for (let x = 30; x <= 66; x += 3) for (let dy = -2; dy <= 2; dy += 1) {
      const h = noisy.height(x, 48), y = h + dy;
      worst = Math.max(worst, Math.abs(noisy.density(x, y, 48) - dy));
      calmWorst = Math.max(calmWorst, Math.abs(calm.density(x, y, 48) - (y - calm.height(x, 48))));
    }
    expect(worst).toBeGreaterThan(0.3);
    expect(calmWorst).toBeLessThan(1e-6);
    // outside the patch the noise is untouched
    expect(calm.density(200, noisy.height(200, 48) + 1, 48)).toBeCloseTo(noisy.density(200, noisy.height(200, 48) + 1, 48), 9);
  });
});
