import { describe, expect, it } from "vitest";
import { createVolume, buildVolumeMesh, volumeDocSchema, type VolumeDoc } from "../src/index.js";

/**
 * CSG volumes: the dual-contoured half of the voxel path.
 *
 * The properties worth pinning are the ones that fail silently. A wrong sign
 * gives you a solid world with a room-shaped lump in it; a mis-attributed
 * surface paints a dressed hall in cave rock; a vertex escaping its cell folds
 * the mesh through itself and cooks into a collider you fall out of. None of
 * those throw.
 */

const box = (over: Partial<VolumeDoc> = {}): VolumeDoc =>
  volumeDocSchema.parse({
    voxelSize: 0.25,
    palette: ["a", "b", "c"],
    surface: { floor: 0, wall: 1, ceiling: 2 },
    nodes: [{ id: "solid", op: "add", shape: "box", position: [0, 0, 0], size: [8, 8, 8] }],
    ...over,
  });

describe("csg volume", () => {
  it('keeps structural materials on every side of a pillar despite surface solver tolerance', () => {
    const v=createVolume(volumeDocSchema.parse({palette:['wall','pillar'],nodes:[
      {op:'add',shape:'box',size:[16,16,16],surface:{floor:0,wall:0,ceiling:0}},
      {op:'sub',shape:'box',size:[12,12,12],surface:{floor:0,wall:0,ceiling:0}},
      {op:'add',shape:'box',size:[2,14,3],surface:{floor:1,wall:1,ceiling:1}},
    ]}));
    for(const [x,z,nx,nz] of [[1.00001,0,1,0],[-1.00001,0,-1,0],[0,1.50001,0,1],[0,-1.50001,0,-1]]){
      const out=new Float32Array(5);v.surfaceAt(x!,0,z!,0,out,0,nx!,nz!);
      expect(Array.from(out.slice(0,2))).toEqual([0,1]);
    }
  });
  it('meshes both floors between vertically stacked unblended rooms', () => {
    const v=createVolume(volumeDocSchema.parse({voxelSize:.5,bounds:{min:[-17.113,-26.137,-17.119],max:[17.137,16.113,17.131]},nodes:[
      {op:'add',shape:'box',position:[0,-5,0],size:[32,40,32]},
      {op:'sub',shape:'box',position:[0,2.5,0],size:[12,5,12]},
      {op:'sub',shape:'box',position:[0,-7.5,0],size:[12,5,12]},
    ]}));
    const m=buildVolumeMesh(v),ys:number[]=[];
    // Vertical ray through the centre, intersecting triangle projections in XZ.
    for(let i=0;i<m.indices.length;i+=3){
      const a=m.indices[i]!*3,b=m.indices[i+1]!*3,c=m.indices[i+2]!*3,p=m.positions;
      const ax=p[a]!,az=p[a+2]!,bx=p[b]!,bz=p[b+2]!,cx=p[c]!,cz=p[c+2]!;
      const det=(bz-cz)*(ax-cx)+(cx-bx)*(az-cz);if(Math.abs(det)<1e-9)continue;
      const u=((bz-cz)*(-cx)+(cx-bx)*(-cz))/det,w=((cz-az)*(-cx)+(ax-cx)*(-cz))/det;
      if(u>=-1e-6&&w>=-1e-6&&u+w<=1+1e-6)ys.push(u*p[a+1]!+w*p[b+1]!+(1-u-w)*p[c+1]!);
    }
    expect(ys.some(y=>Math.abs(y)<.1)).toBe(true);
    expect(ys.some(y=>Math.abs(y+10)<.1)).toBe(true);
  });
  it("is solid inside an added box and empty outside it", () => {
    const v = createVolume(box());
    expect(v.density(0, 0, 0)).toBeLessThan(0);
    expect(v.density(0, 6, 0)).toBeGreaterThan(0);
    expect(v.density(10, 0, 0)).toBeGreaterThan(0);
  });

  it("carves a room out with a subtract, in document order", () => {
    const v = createVolume(
      box({
        nodes: [
          { id: "rock", op: "add", shape: "box", position: [0, 0, 0], size: [20, 20, 20] },
          { id: "room", op: "sub", shape: "box", position: [0, 0, 0], size: [8, 6, 8] },
        ],
      } as Partial<VolumeDoc>),
    );
    expect(v.density(0, 0, 0), "inside the room").toBeGreaterThan(0);
    expect(v.density(0, 6, 0), "in the rock above it").toBeLessThan(0);
  });

  it("paints the surface with whoever last MOVED the boundary", () => {
    // A doorway cut through a wall must wear the doorway's stone, not the
    // wall's — which is why ownership tracks the change, not the nearest node.
    const v = createVolume(
      volumeDocSchema.parse({
        voxelSize: 0.25,
        palette: ["rock", "hall-floor", "hall-wall", "hall-ceil"],
        surface: { floor: 0, wall: 0, ceiling: 0 },
        nodes: [
          { id: "rock", op: "add", shape: "box", position: [0, 0, 0], size: [20, 20, 20] },
          {
            id: "room",
            op: "sub",
            shape: "box",
            position: [0, 0, 0],
            size: [8, 6, 8],
            surface: { floor: 1, wall: 2, ceiling: 3 },
          },
        ],
      }),
    );
    const out = new Float32Array(8);
    // a point on the room's FLOOR, normal up
    v.surfaceAt(0, -3, 0, 1, out, 0);
    expect(out[1], "floor takes the room's floor index").toBeGreaterThan(0.9);
    // a point on the room's WALL, normal horizontal
    v.surfaceAt(-4, 0, 0, 0, out, 0);
    expect(out[2], "wall takes the room's wall index").toBeGreaterThan(0.9);
    // the ceiling, normal down
    v.surfaceAt(0, 3, 0, -1, out, 0);
    expect(out[3], "ceiling takes the room's ceiling index").toBeGreaterThan(0.9);
  });

  it("meshes a carved room into a closed-ish solid with the palette on it", () => {
    const doc = volumeDocSchema.parse({
      voxelSize: 0.3,
      palette: ["rock", "floor", "wall"],
      surface: { floor: 0, wall: 0, ceiling: 0 },
      nodes: [
        { id: "rock", op: "add", shape: "box", position: [0, 0, 0], size: [16, 12, 16] },
        { id: "room", op: "sub", shape: "box", position: [0, -2, 0], size: [8, 5, 8], surface: { floor: 1, wall: 2, ceiling: 2 } },
      ],
    });
    const mesh = buildVolumeMesh(createVolume(doc));
    expect(mesh.triangleCount).toBeGreaterThan(500);
    expect(mesh.surfaceCount).toBe(3);
    expect(mesh.splat.length).toBe(mesh.vertexCount * 3);
    // every vertex's weights sum to one, or the splat shader renders black
    for (let i = 0; i < mesh.vertexCount; i += 37) {
      let sum = 0;
      for (let s = 0; s < 3; s++) sum += mesh.splat[i * 3 + s]!;
      expect(sum).toBeCloseTo(1, 3);
    }
  });

  it("keeps a hard edge hard — the whole reason this path exists", () => {
    // A cube's corner region: with exact Hermite data the dual contour puts
    // vertices ON the corner, so the mesh's own extent reaches it. Rounding it
    // off (what marching cubes does, and what DC does when fed smoothed
    // gradients) pulls the extent in by a fraction of a voxel.
    const doc = volumeDocSchema.parse({
      voxelSize: 0.25,
      palette: ["a"],
      nodes: [{ id: "cube", op: "add", shape: "box", position: [0, 0, 0], size: [6, 6, 6] }],
    });
    const mesh = buildVolumeMesh(createVolume(doc));
    // the box's faces sit at +/-3; a chamfered corner would fall well short
    expect(mesh.max[0]).toBeGreaterThan(2.97);
    expect(mesh.max[1]).toBeGreaterThan(2.97);
    expect(mesh.min[2]).toBeLessThan(-2.97);
  });

  it("blends where asked, so cut stone can melt into natural rock", () => {
    const hard = createVolume(
      volumeDocSchema.parse({
        voxelSize: 0.25,
        palette: ["a"],
        nodes: [
          { id: "a", op: "add", shape: "box", position: [-1.5, 0, 0], size: [4, 4, 4] },
          { id: "b", op: "add", shape: "sphere", position: [1.5, 0, 0], radius: 2 },
        ],
      }),
    );
    const soft = createVolume(
      volumeDocSchema.parse({
        voxelSize: 0.25,
        palette: ["a"],
        nodes: [
          { id: "a", op: "add", shape: "box", position: [-1.5, 0, 0], size: [4, 4, 4] },
          { id: "b", op: "add", shape: "sphere", position: [1.5, 0, 0], radius: 2, blend: 1.5 },
        ],
      }),
    );
    // in the crease between the two, a blend fills material in
    expect(soft.density(0.4, 1.9, 0)).toBeLessThan(hard.density(0.4, 1.9, 0));
  });

  it("derives bounds from the solid, ignoring subtracts that cannot enlarge it", () => {
    const v = createVolume(
      volumeDocSchema.parse({
        voxelSize: 0.5,
        palette: ["a"],
        nodes: [
          { id: "a", op: "add", shape: "box", position: [0, 0, 0], size: [10, 10, 10] },
          { id: "far", op: "sub", shape: "sphere", position: [500, 0, 0], radius: 4 },
        ],
      }),
    );
    expect(v.max[0]).toBeLessThan(20);
  });
});

describe("csg volume tiling", () => {
  /** Edges used by exactly one triangle — i.e. holes. Welds by position, since blocks are contoured independently. */
  function survey(mesh: { positions: Float32Array; indices: Uint32Array; triangleCount: number; vertexCount: number }) {
    const Q = 10000;
    const ids = new Map<string, number>();
    const weld = new Int32Array(mesh.vertexCount);
    let next = 0;
    for (let i = 0; i < mesh.vertexCount; i++) {
      const qx = Math.round(mesh.positions[i * 3]! * Q);
      const qy = Math.round(mesh.positions[i * 3 + 1]! * Q);
      const qz = Math.round(mesh.positions[i * 3 + 2]! * Q);
      let f = -1;
      for (let dx = -1; dx <= 1 && f < 0; dx++)
        for (let dy = -1; dy <= 1 && f < 0; dy++)
          for (let dz = -1; dz <= 1 && f < 0; dz++) {
            const h = ids.get(`${qx + dx}_${qy + dy}_${qz + dz}`);
            if (h !== undefined) f = h;
          }
      if (f < 0) f = next++;
      ids.set(`${qx}_${qy}_${qz}`, f);
      weld[i] = f;
    }
    const use = new Map<string, number>();
    for (let t = 0; t < mesh.triangleCount; t++) {
      const a = weld[mesh.indices[t * 3]!]!;
      const b = weld[mesh.indices[t * 3 + 1]!]!;
      const c = weld[mesh.indices[t * 3 + 2]!]!;
      for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
        if (p === q) continue;
        const k = p < q ? `${p}_${q}` : `${q}_${p}`;
        use.set(k, (use.get(k) ?? 0) + 1);
      }
    }
    let open = 0;
    let nonManifold = 0;
    for (const n of use.values()) {
      if (n === 1) open++;
      else if (n > 2) nonManifold++;
    }
    return { open, nonManifold };
  }

  it("closes a solid that spans many meshing blocks", () => {
    // Volumes are contoured in 24-cell blocks and concatenated, so a solid
    // bigger than one block is the only thing that exercises face ownership
    // across a seam. Two bugs lived here and neither was visible on screen:
    // no Y ownership at all (vertically adjacent blocks both emitting their
    // overlap), and an ownership rule keyed on all three of an edge's indices
    // rather than on one anchor cell — which drops every face near a block
    // CORNER, because its indices belong to different blocks and so neither
    // claims it. A sphere is the cheapest shape that crosses blocks on all
    // three axes at once.
    const doc = volumeDocSchema.parse({
      voxelSize: 0.25,
      palette: ["a"],
      bounds: { min: [-8, -8, -8], max: [8, 8, 8] },
      nodes: [{ id: "s", op: "add", shape: "sphere", position: [0, 0, 0], radius: 6 }],
    });
    const mesh = buildVolumeMesh(createVolume(doc));
    expect(mesh.triangleCount).toBeGreaterThan(10000);
    const { open, nonManifold } = survey(mesh);
    expect(open, "holes").toBe(0);
    expect(nonManifold, "edges shared by more than two faces").toBe(0);
  });

  it("stays closed with a blended solid, where the block reject is unsound", () => {
    // A smooth blend makes the field over-state its distance, so the
    // "this block is far from any surface, skip it" shortcut can skip a block
    // the surface actually clips. That is a hole, and it is why the shortcut
    // is taken only for documents with no blend in them.
    const doc = volumeDocSchema.parse({
      voxelSize: 0.25,
      palette: ["a"],
      bounds: { min: [-12, -8, -8], max: [12, 8, 8] },
      nodes: [
        { id: "a", op: "add", shape: "box", position: [-4, 0, 0], size: [10, 8, 8] },
        { id: "b", op: "add", shape: "sphere", position: [5, 0, 0], radius: 4.5, blend: 3 },
      ],
    });
    const mesh = buildVolumeMesh(createVolume(doc));
    expect(survey(mesh).open, "holes").toBe(0);
  });
});
