import { describe, expect, it } from "vitest";
import { applyRecipeEdits, buildVoxelMesh, createWorldField, defaultWorldRecipe, featureFootprint, meshDensity, passageSchema, worldRecipeSchema } from "../src/index.js";

function recipe() {
  const base = defaultWorldRecipe();
  return worldRecipeSchema.parse({ ...base, cellSize: 48, resolution: 24, bounds: undefined,
    terrain: { ...base.terrain, overhang: { ...base.terrain.overhang, strength: 0 }, caves: { ...base.terrain.caves, enabled: false } },
    features: { passages: [], heightPatches: [{ id: "flat", origin: [-200, -200], size: [400, 400], columns: 2, rows: 2, heights: [100,100,100,100], blend: 1, feather: 1 }] } });
}
const passage = () => passageSchema.parse({ id: "trial", start: [25,36,12], length: 60, width: 6, height: 4, wallNoise: .4, connectionBand: 1, seed: 27 });

describe("bounded flat-floor terrain passages", () => {
  it("validates dimensions and edits atomically with bounded inverse footprints", () => {
    expect(passageSchema.safeParse({ ...passage(), width: 0 }).success).toBe(false);
    expect(passageSchema.safeParse({ ...passage(), wallNoise: -1 }).success).toBe(false);
    const source = recipe(), result = applyRecipeEdits(source, [{ edit: "add-feature", kind: "passages", feature: passage() }]);
    expect(applyRecipeEdits(result.recipe, result.inverse).recipe).toEqual(source);
    expect(featureFootprint("passages", passage())).toEqual({ x0:17.6,x1:32.4,z0:8,z1:76 });
    expect(source.features.passages).toEqual([]);
    const legacy = structuredClone(source) as unknown as { features: { passages?: unknown[] } };
    delete legacy.features.passages;
    const parsed = worldRecipeSchema.parse(legacy);
    expect(parsed.features.passages).toEqual([]);
    const edited = applyRecipeEdits(parsed,[{edit:"add-feature",kind:"passages",feature:passage()}]);
    expect(applyRecipeEdits(edited.recipe,edited.inverse).recipe).toEqual(parsed);
  });

  it("supports X-axis negative-direction passages without transposing floor or footprint", () => {
    const p=passageSchema.parse({...passage(),start:[60,36,25],axis:"x",direction:-1,length:36});
    expect(featureFootprint("passages",p)).toEqual({x0:20,x1:64,z0:17.6,z1:32.4});
    const field=createWorldField(applyRecipeEdits(recipe(),[{edit:"add-feature",kind:"passages",feature:p}]).recipe);
    expect(field.density(42,38,25)).toBeGreaterThan(0);
    expect(field.density(66,38,25)).toBeLessThan(0);
    expect(field.density(18,38,25)).toBeLessThan(0);
    expect(field.density(42,35,25)).toBeLessThan(0);
    const block=field.sampleBlock({origin:[22,34,22],nx:21,ny:5,nz:5,step:2});
    for(let z=0;z<5;z++)for(let y=0;y<5;y++)for(let x=0;x<21;x++)expect(block[x+y*21+z*105]).toBeCloseTo(field.density(22+x*2,34+y*2,22+z*2),5);
  });

  it("agrees on scalar/bulk samples, keeps floor and terminal profiles stable, and only recesses walls outward", () => {
    const p = passage(), r = applyRecipeEdits(recipe(), [{ edit:"add-feature",kind:"passages",feature:p }]).recipe, field=createWorldField(r);
    const origin:[number,number,number]=[20,32,8], block=field.sampleBlock({origin,nx:7,ny:7,nz:36,step:2});
    for(let z=0;z<36;z++)for(let y=0;y<7;y++)for(let x=0;x<7;x++) expect(block[x+y*7+z*49]).toBeCloseTo(field.density(origin[0]+2*x,origin[1]+2*y,origin[2]+2*z),5);
    for(let z=12;z<=72;z+=.5) {
      expect(field.density(25,36,z)).toBe(0);
      expect(field.density(25,40,z)).toBe(0);
      for(const x of [22,28]) expect(field.density(x,38,z)).toBeGreaterThanOrEqual(0);
      for(const x of [21.59,28.41]) expect(field.density(x,38,z)).toBeLessThan(0);
    }
    for(const z of [12,72]) expect(field.density(28,38,z)).toBe(0);
    expect(field.heightRange(0,0,48,48).min).toBeLessThanOrEqual(32);
    expect(field.heightRange(96,96,144,144).min).toBeCloseTo(100,5);
    const md=meshDensity(field,{x0:16,x1:34,y0:30,y1:46,z0:8,z1:76});
    for(let z=16;z<=68;z+=1)for(let x=22.5;x<=27.5;x+=.25) expect(md.down(x,z,37,34)).toBeCloseTo(36,5);
  });

  it("preserves surface skirts without extruding cave-ceiling curtains across the actual MC chunk seam", () => {
    const field=createWorldField(applyRecipeEdits(recipe(),[{edit:"add-feature",kind:"passages",feature:passage()}]).recipe);
    for(const cell of [[0,0],[0,1]] as [number,number][]) {
      const mesh=buildVoxelMesh(field,{kind:"voxel",world:"test",cell,mesher:"mc"});
      let ceilingCurtains=0,groundSkirts=0,roofSkirts=0;
      for(let i=0;i<mesh.indices.length;i+=3){
        const vs=[mesh.indices[i]!,mesh.indices[i+1]!,mesh.indices[i+2]!].map(v=>[mesh.positions[v*3]!,mesh.positions[v*3+1]!,mesh.positions[v*3+2]!+cell[1]*48]);
        if(vs.every(v=>Math.abs(v[2]!-48)<1e-5)) {
          const x=vs.reduce((s,v)=>s+v[0]!,0)/3, y=vs.reduce((s,v)=>s+v[1]!,0)/3;
          if(x>22.5&&x<27.5&&y>36.01&&y<39.99)ceilingCurtains++;
          if(y>95&&y<100)groundSkirts++;
          if(x>22.5&&x<27.5&&y>40.01&&y<48)roofSkirts++;
        }
      }
      expect(ceilingCurtains).toBe(0);
      expect(groundSkirts).toBeGreaterThan(0);
      expect(roofSkirts).toBeGreaterThan(0);
    }
  });

  it("retains legacy downward-skirt geometry for worlds without authored passages", () => {
    const base=recipe();base.features.tunnels=[{id:"legacy",points:[[25,38,12],[25,38,72]],radius:3,minDepth:0} as never];
    const field=createWorldField(base),mesh=buildVoxelMesh(field,{kind:"voxel",world:"legacy",cell:[0,0],mesher:"mc",yRange:[20,112]});
    let undersideDrops=0;
    for(let i=0;i<mesh.positions.length;i+=3)if(Math.abs(mesh.positions[i+2]!-48)<1e-5&&mesh.positions[i]!>22&&mesh.positions[i]!<28&&mesh.positions[i+1]!<38)undersideDrops++;
    expect(undersideDrops).toBeGreaterThan(0);
    const same=buildVoxelMesh(createWorldField(worldRecipeSchema.parse({...base,features:{...base.features,passages:[]}})),{kind:"voxel",world:"legacy",cell:[0,0],mesher:"mc",yRange:[20,112]});
    expect(same.positions).toEqual(mesh.positions);expect(same.indices).toEqual(mesh.indices);
  });
});
