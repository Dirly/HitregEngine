import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  boneSide,
  planRagdoll,
  quatFromY,
  ragdollIgnores,
  ragdollSpec,
  RagdollScript,
  RAGDOLL_PRESETS,
  type RagdollBoneInput,
  type ScriptContext,
  type SimRagdollSpec,
} from "../src/index.js";

/** A small biped: hips branching into legs and a spine; clavicles, fingers, twist and face helpers. */
function biped(): RagdollBoneInput[] {
  const b: RagdollBoneInput[] = [];
  const add = (name: string, parent: string | null, position: [number, number, number]): void => {
    b.push({ name, parent: parent === null ? -1 : b.findIndex((x) => x.name === parent), position });
  };
  add("Root", null, [0, 0, 0]);
  add("Hip", "Root", [0, 1, 0]);
  add("Pelvis", "Hip", [0, 1, 0]);
  for (const [s, x] of [["L", 0.1], ["R", -0.1]] as const) {
    add(`${s}_Thigh`, "Pelvis", [x, 0.95, 0]);
    add(`${s}_ThighTwist01`, `${s}_Thigh`, [x, 0.75, 0]);
    add(`${s}_Calf`, `${s}_Thigh`, [x, 0.5, 0]);
    add(`${s}_Foot`, `${s}_Calf`, [x, 0.05, 0]);
    add(`${s}_ToeBase`, `${s}_Foot`, [x, 0, 0.15]);
  }
  add("Waist", "Hip", [0, 1.05, 0]);
  add("Spine01", "Waist", [0, 1.1, 0]);
  add("Spine02", "Spine01", [0, 1.3, 0]);
  add("NeckTwist01", "Spine02", [0, 1.5, 0]);
  add("Head", "NeckTwist01", [0, 1.6, 0]);
  add("L_Eye", "Head", [0.03, 1.7, 0.08]);
  add("HeadTop_End", "Head", [0, 1.8, 0]);
  for (const [s, x] of [["L", 1], ["R", -1]] as const) {
    add(`${s}_Clavicle`, "Spine02", [x * 0.05, 1.45, 0]);
    add(`${s}_Upperarm`, `${s}_Clavicle`, [x * 0.2, 1.45, 0]);
    add(`${s}_UpperarmTwist01`, `${s}_Upperarm`, [x * 0.3, 1.45, 0]);
    add(`${s}_Forearm`, `${s}_Upperarm`, [x * 0.45, 1.45, 0]);
    add(`${s}_Hand`, `${s}_Forearm`, [x * 0.7, 1.45, 0]);
    add(`${s}_Index1`, `${s}_Hand`, [x * 0.8, 1.45, 0]);
    add(`${s}_Index3`, `${s}_Index1`, [x * 0.88, 1.45, 0]);
  }
  return b;
}

const names = (bones: RagdollBoneInput[], plan: NonNullable<ReturnType<typeof planRagdoll>>): string[] =>
  plan.bodies.map((p) => bones[p.bone]!.name);

describe("planRagdoll", () => {
  it("maps a biped to a trunk, a neck-head and two three-part limbs per side", () => {
    const bones = biped();
    const plan = planRagdoll(bones)!;
    const got = names(bones, plan);
    expect(got[0]).toBe("Hip"); // the branch point, not the root bone at the feet
    expect(new Set(got)).toEqual(
      new Set([
        "Hip", "Waist", "Spine02", "NeckTwist01",
        "L_Thigh", "L_Calf", "L_Foot", "R_Thigh", "R_Calf", "R_Foot",
        "L_Upperarm", "L_Forearm", "L_Hand", "R_Upperarm", "R_Forearm", "R_Hand",
      ]),
    );
    // never a body: helpers, fingers, faces, clavicles (folded into the chest)
    for (const n of ["Pelvis", "L_ThighTwist01", "L_Index1", "L_Eye", "L_Clavicle", "Spine01", "Head"]) expect(got).not.toContain(n);
    const by = (n: string) => plan.bodies[got.indexOf(n)]!;
    // parents: limbs hang off the trunk body they attach to
    expect(got[by("L_Upperarm").parent]).toBe("Spine02");
    expect(got[by("L_Thigh").parent]).toBe("Hip");
    expect(got[by("L_Forearm").parent]).toBe("L_Upperarm");
    // the trunk ends at its midline continuation, the head reaches its top, a hand its fingertips
    expect(bones[by("Hip").endBones[0]!]!.name).toBe("Waist");
    expect(bones[by("Spine02").endBones[0]!]!.name).toBe("NeckTwist01");
    expect(bones[by("NeckTwist01").endBones[0]!]!.name).toBe("HeadTop_End");
    expect(bones[by("L_Hand").endBones[0]!]!.name).toBe("L_Index3");
    // roles drive the joint limits
    expect(by("Hip").role).toBe("core");
    expect(by("Waist").role).toBe("core");
    expect(by("NeckTwist01").role).toBe("head");
    expect(by("L_Calf").role).toBe("limb");
    // parents always come first (bones are written parents-first)
    plan.bodies.forEach((b, i) => expect(b.parent).toBeLessThan(i));
  });

  it("chunkier bodies with a bigger minimum segment", () => {
    const bones = biped();
    expect(planRagdoll(bones, { minSegment: 0.2 })!.bodies.length).toBeLessThan(planRagdoll(bones)!.bodies.length);
  });

  it("uses skin girth hints, clamped to the skeleton's size", () => {
    const bones = biped();
    const radii: number[] = [];
    radii[bones.findIndex((b) => b.name === "L_Calf")] = 0.07;
    radii[bones.findIndex((b) => b.name === "Hip")] = 5; // absurd
    const plan = planRagdoll(bones, { radii })!;
    const got = names(bones, plan);
    expect(plan.bodies[got.indexOf("L_Calf")]!.radius).toBeCloseTo(0.07);
    expect(plan.bodies[got.indexOf("Hip")]!.radius).toBeLessThanOrEqual(0.22 * plan.size + 1e-9);
  });

  it("name rules", () => {
    expect(ragdollIgnores("CC_Base_L_Forearm")).toBe(false); // "ear" inside a word is not an ear
    expect(ragdollIgnores("Ear_L")).toBe(true);
    expect(ragdollIgnores("CC_Base_NeckTwist01")).toBe(false);
    expect(ragdollIgnores("CC_Base_L_UpperarmTwist01")).toBe(true);
    expect(ragdollIgnores("Front_Leg_Tip_L")).toBe(true);
    expect(boneSide("CC_Base_L_Thigh")).toBe("L");
    expect(boneSide("Back_Leg_Upper_R")).toBe("R");
    expect(boneSide("Spine_2")).toBe(null);
  });
});

/** A small quadruped along +z: hips, a four-bone spine to the chest, neck + head, four legs, a tail. */
function quadruped(zUp = false): RagdollBoneInput[] {
  const b: RagdollBoneInput[] = [];
  const add = (name: string, parent: string | null, p: [number, number, number]): void => {
    b.push({ name, parent: parent === null ? -1 : b.findIndex((x) => x.name === parent), position: zUp ? [p[0], -p[2], p[1]] : p });
  };
  add("root", null, [0, 0, 0]);
  add("Hips", "root", [0, 0.6, 0]);
  add("Spine_1", "Hips", [0, 0.62, 0.12]);
  add("Spine_2", "Spine_1", [0, 0.63, 0.24]);
  add("Spine_3", "Spine_2", [0, 0.64, 0.36]);
  add("Chest", "Spine_3", [0, 0.65, 0.5]);
  add("Neck", "Chest", [0, 0.75, 0.62]);
  add("Head", "Neck", [0, 0.85, 0.75]);
  add("Headtip", "Head", [0, 0.85, 0.9]);
  for (const [sd, x] of [["L", 0.12], ["R", -0.12]] as const) {
    add(`Front_Upper_${sd}`, "Chest", [x, 0.55, 0.5]);
    add(`Front_Lower_${sd}`, `Front_Upper_${sd}`, [x, 0.3, 0.5]);
    add(`Front_Foot_${sd}`, `Front_Lower_${sd}`, [x, 0.02, 0.52]);
    add(`Back_Upper_${sd}`, "Hips", [x, 0.55, 0]);
    add(`Back_Lower_${sd}`, `Back_Upper_${sd}`, [x, 0.3, -0.03]);
    add(`Back_Foot_${sd}`, `Back_Lower_${sd}`, [x, 0.02, 0]);
  }
  add("Tail_Base", "Hips", [0, 0.6, -0.1]);
  add("Tail_Mid", "Tail_Base", [0, 0.5, -0.3]);
  add("Tail_End", "Tail_Mid", [0, 0.4, -0.5]);
  return b;
}

describe("planRagdoll postures", () => {
  it("a quadruped is horizontal and its short spine bones merge into a stiff back", () => {
    const bones = quadruped();
    const plan = planRagdoll(bones)!;
    expect(plan.posture).toBe("horizontal");
    const core = (p: NonNullable<ReturnType<typeof planRagdoll>>) => p.bodies.filter((x) => x.role === "core").length;
    // one body per spine bone when the trunk minimum is tiny; fewer, longer ones by default
    expect(core(plan)).toBeLessThan(core(planRagdoll(bones, { trunkSegment: 0.01 })!));
    expect(planRagdoll(biped())!.posture).toBe("upright");
  });

  it("reads posture against the given up (a Z-up bind pose)", () => {
    const bones = quadruped(true);
    expect(planRagdoll(bones, { up: [0, 0, 1] })!.posture).toBe("horizontal");
    const standing = biped().map((b) => ({ ...b, position: [b.position[0], -b.position[2], b.position[1]] as [number, number, number] }));
    expect(planRagdoll(standing, { up: [0, 0, 1] })!.posture).toBe("upright");
    expect(planRagdoll(standing)!.posture).toBe("horizontal"); // Y-up assumed: lying down
  });
});

describe("ragdollSpec", () => {
  it("bodies at bone heads with identity rotation, capsules along their segments, joints at child heads", () => {
    const bones = biped();
    const plan = planRagdoll(bones)!;
    const pos = bones.map((b) => b.position);
    const spec = ragdollSpec(plan, pos, 1, { stiffness: 30, limitScale: 1, linearDamping: 0.3, angularDamping: 3 }, () => [1, 0, 0]);
    expect(spec.bodies.length).toBe(plan.bodies.length);
    expect(spec.joints.length).toBe(plan.bodies.length - 1);
    const calf = plan.bodies.findIndex((b) => bones[b.bone]!.name === "L_Calf");
    const body = spec.bodies[calf]!;
    expect(body.position).toEqual([0.1, 0.5, 0]);
    expect(body.rotation).toBeUndefined();
    // calf runs straight down to the foot: centre halfway, capsule axis -Y
    expect(body.collider.center[1]).toBeCloseTo(-0.225);
    const q = new THREE.Quaternion(...body.collider.rotation);
    const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    expect(axis.y).toBeCloseTo(-1);
    expect(body.linvel).toEqual([1, 0, 0]);
    const joint = spec.joints.find((j) => j.child === calf)!;
    expect(joint.anchor).toEqual([0.1, 0.5, 0]);
    // per axis, about the shared spawn frame (identity here): the upright preset's limb
    expect(joint.limit).toEqual(RAGDOLL_PRESETS.upright.limb);
    expect(plan.posture).toBe("upright");
  });

  it("a frame: every body spawns at it, capsules are in its axes, limits are the posture preset's", () => {
    const bones = quadruped();
    const plan = planRagdoll(bones)!;
    const pos = bones.map((b) => b.position);
    const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    const frame: [number, number, number, number] = [yaw.x, yaw.y, yaw.z, yaw.w];
    const spec = ragdollSpec(plan, pos, 1, { stiffness: 0, limitScale: 1, linearDamping: 0, angularDamping: 0, frame, selfCollide: true, restDamping: [6, 20], relax: 1 });
    for (const b of spec.bodies) expect(b.rotation).toEqual(frame);
    // the hips body: its capsule, turned back to world by the frame, runs toward the spine (+z)
    const hips = spec.bodies[0]!;
    const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(...hips.collider.rotation)).applyQuaternion(yaw);
    expect(axis.z).toBeGreaterThan(0.9);
    const leg = plan.bodies.findIndex((b) => bones[b.bone]!.name === "Back_Lower_L");
    expect(spec.joints.find((j) => j.child === leg)!.limit).toEqual(RAGDOLL_PRESETS.horizontal.limb);
    expect(spec.selfCollide).toBe(true);
    expect(spec.settle).toEqual({ after: 1, linearDamping: 6, angularDamping: 20 });
  });

  it("quatFromY maps +Y onto the direction", () => {
    for (const d of [[1, 0, 0], [0, 0, -1], [0, -1, 0], [0.6, 0.8, 0]] as const) {
      const v = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(...quatFromY(d[0], d[1], d[2])));
      expect(v.x).toBeCloseTo(d[0]);
      expect(v.y).toBeCloseTo(d[1]);
      expect(v.z).toBeCloseTo(d[2]);
    }
  });
});

/** A skinned biped under a body object, plus a fake sim that records what the script asks for. */
function rig() {
  const bones = biped();
  const objs = bones.map((b) => {
    const bone = new THREE.Bone();
    bone.name = b.name;
    return bone;
  });
  bones.forEach((b, i) => {
    const p = b.parent >= 0 ? bones[b.parent]!.position : [0, 0, 0];
    objs[i]!.position.set(b.position[0] - p[0]!, b.position[1] - p[1]!, b.position[2] - p[2]!);
    if (b.parent >= 0) objs[b.parent]!.add(objs[i]!);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute([0, 1, 0, 0.1, 0.5, 0, 0, 1.6, 0], 3));
  geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute([1, 0, 0, 0, 5, 0, 0, 0, 16, 0, 0, 0], 4));
  geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshBasicMaterial());
  const body = new THREE.Object3D();
  const visual = new THREE.Object3D();
  body.add(visual);
  visual.add(mesh);
  mesh.add(objs[0]!);
  body.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(objs));
  const ragdollChild = new THREE.Object3D();
  body.add(ragdollChild);

  const live = new Map<number, SimRagdollSpec>();
  let serial = 0;
  let settled = false;
  const sim = {
    getLinvel: () => null,
    setLinvel: () => {},
    applyImpulse: () => {},
    addRagdoll: (spec: SimRagdollSpec) => {
      live.set(++serial, spec);
      return serial;
    },
    ragdollPoses: (h: number, out: Float32Array) => {
      const s = live.get(h);
      if (!s) return 0;
      // everything dropped 0.5 m
      s.bodies.forEach((b, i) => out.set([b.position[0], b.position[1] - 0.5, b.position[2], 0, 0, 0, 1], i * 7));
      return s.bodies.length;
    },
    ragdollSettled: () => settled,
    removeRagdoll: (h: number) => void live.delete(h),
    ragdollStats: () => ({ active: live.size, bodies: 0, joints: 0, created: serial, removed: 0 }),
  };
  const script = new RagdollScript();
  const params = Object.fromEntries(Object.entries(RagdollScript.params).map(([k, v]) => [k, v.default])) as Record<string, unknown>;
  script.ctx = {
    entityId: "mob/ragdoll",
    object: ragdollChild,
    params,
    input: { isDown: () => false },
    sim,
    getEntity: () => ({ parent: "mob" }) as never,
    getObject: () => undefined,
    findByTag: () => [],
    now: () => 0,
    after: () => () => {},
  } as unknown as ScriptContext;
  script.onStart();
  return { script, body, objs, live, params, sim: sim as Record<string, unknown>, ctx: script.ctx as unknown as Record<string, unknown>, setSettled: (v: boolean) => (settled = v) };
}

describe("ragdoll builtin", () => {
  it("lead-in, bodies drive bones, freeze removes the bodies and keeps the pose, respawn restores", () => {
    const { script, body, objs, live, params, setSettled } = rig();
    script.onLateUpdate(1 / 60);
    expect(live.size).toBe(0); // alive: nothing
    body.userData["ragdollKick"] = { at: 1, dir: [1, 0, 0] };
    script.onLateUpdate(1 / 60); // death seen: lead-in starts, animation still drives
    expect(live.size).toBe(0);
    for (let t = 0; t < (params["leadIn"] as number) + 0.05; t += 1 / 60) script.onLateUpdate(1 / 60);
    expect(live.size).toBe(1);
    expect(body.userData["poseHoldUntil"]).toBe(Infinity); // the mixer is stopped
    const spec = [...live.values()][0]!;
    expect(spec.bodies.length).toBe(16);
    // the blow pushes along +x, harder up top
    expect(spec.bodies[0]!.linvel![0]).toBeGreaterThan(0);
    script.onLateUpdate(1 / 60);
    const calf = objs.find((o) => o.name === "L_Calf")!;
    const w = new THREE.Vector3().setFromMatrixPosition(calf.matrixWorld);
    expect(w.y).toBeCloseTo(0.0); // 0.5 m bone head dropped 0.5 m
    expect(w.x).toBeCloseTo(0.1);
    // settles: frozen after settleSeconds, bodies gone, bones stay where they fell
    setSettled(true);
    for (let t = 0; t < (params["settleSeconds"] as number) + 0.05; t += 1 / 60) script.onLateUpdate(1 / 60);
    expect(live.size).toBe(0);
    expect((body.userData["ragdoll"] as { phase: string }).phase).toBe("frozen");
    const before = calf.position.clone();
    script.onLateUpdate(1 / 60);
    expect(calf.position.equals(before)).toBe(true);
    // respawn: the death signal goes, the pose and the mixer come back
    delete body.userData["ragdollKick"];
    script.onLateUpdate(1 / 60);
    expect(body.userData["poseHoldUntil"]).toBeUndefined();
    expect(calf.position.y).toBeCloseTo(0.5 - 0.95);
  });

  it("past the cap the plain death clip stays", () => {
    const { script, body, live, params } = rig();
    params["maxActive"] = 0;
    script.onLateUpdate(1 / 60); // seen alive
    body.userData["ragdollKick"] = { at: 1 };
    for (let t = 0; t < 1; t += 1 / 60) script.onLateUpdate(1 / 60);
    expect(live.size).toBe(0);
    expect(body.userData["poseHoldUntil"]).toBeUndefined();
    expect((body.userData["ragdoll"] as { skippedCap: number }).skippedCap).toBe(1);
  });

  it("starts from the controller's death convention (frozen + death action clip)", () => {
    const { script, body, live } = rig();
    script.onLateUpdate(1 / 60); // seen alive
    body.userData["frozen"] = true;
    body.userData["actionClip"] = "Death";
    for (let t = 0; t < 0.5; t += 1 / 60) script.onLateUpdate(1 / 60);
    expect(live.size).toBe(1);
  });

  it("a body already dead when first seen (a late join) keeps its clip", () => {
    const { script, body, live } = rig();
    body.userData["ragdollKick"] = { at: 1 };
    for (let t = 0; t < 1; t += 1 / 60) script.onLateUpdate(1 / 60);
    expect(live.size).toBe(0);
    expect(body.userData["poseHoldUntil"]).toBeUndefined();
  });

  it("beyond maxDistance from the camera the plain death clip stays", () => {
    const { script, body, live, ctx } = rig();
    ctx["viewOrigin"] = () => [100, 2, 0];
    script.onLateUpdate(1 / 60);
    body.userData["ragdollKick"] = { at: 1 };
    for (let t = 0; t < 1; t += 1 / 60) script.onLateUpdate(1 / 60);
    expect(live.size).toBe(0);
    expect((body.userData["ragdoll"] as { skippedFar: number }).skippedFar).toBe(1);
    // within range it falls
    const near = rig();
    near.ctx["viewOrigin"] = () => [5, 2, 0];
    near.script.onLateUpdate(1 / 60);
    near.body.userData["ragdollKick"] = { at: 1 };
    for (let t = 0; t < 0.5; t += 1 / 60) near.script.onLateUpdate(1 / 60);
    expect(near.live.size).toBe(1);
  });

  it("no ground under it (outside the simulated terrain) keeps the clip", () => {
    const { script, body, live, sim } = rig();
    const asked: number[] = [];
    sim["raycast"] = (_o: unknown, _d: unknown, max: number, opts: { layers: number }) => (asked.push(max, opts.layers), null);
    script.onLateUpdate(1 / 60);
    body.userData["ragdollKick"] = { at: 1 };
    for (let t = 0; t < 1; t += 1 / 60) script.onLateUpdate(1 / 60);
    expect(live.size).toBe(0);
    expect((body.userData["ragdoll"] as { skippedNoGround: number }).skippedNoGround).toBe(1);
    expect(asked[1]).toBe(0b11); // WORLD | TERRAIN
  });

  it("lying still (no body moving more than a hair) freezes even while the velocity test says otherwise", () => {
    const { script, body, live, params } = rig();
    script.onLateUpdate(1 / 60);
    body.userData["ragdollKick"] = { at: 1 };
    for (let t = 0; t < (params["leadIn"] as number) + 0.05; t += 1 / 60) script.onLateUpdate(1 / 60);
    expect(live.size).toBe(1);
    // the fake sim never reports settled, but its poses do not move: frozen after settleSeconds
    for (let t = 0; t < (params["settleSeconds"] as number) + 0.1; t += 1 / 60) script.onLateUpdate(1 / 60);
    expect(live.size).toBe(0);
    expect((body.userData["ragdoll"] as { phase: string }).phase).toBe("frozen");
  });
});
