import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { socketBone } from "../src/runtime.js";

/** A body with a rig of the given bone names, nested in order. */
function rig(names: string[]): THREE.Object3D {
  const body = new THREE.Group();
  let parent: THREE.Object3D = body;
  for (const name of names) {
    const bone = new THREE.Bone();
    bone.name = name;
    parent.add(bone);
    parent = bone;
  }
  return body;
}

describe("socketBone: a named VFX socket finds the rig's bone", () => {
  it("reads Character Creator, Mixamo (sanitized), UAL and plain rigs", () => {
    expect(socketBone(rig(["CC_Base_Hip", "CC_Base_R_Hand", "CC_Base_R_Thumb1"]), "rightHand")?.name).toBe("CC_Base_R_Hand");
    expect(socketBone(rig(["mixamorigHips", "mixamorigLeftHand"]), "leftHand")?.name).toBe("mixamorigLeftHand");
    expect(socketBone(rig(["root", "hand_r"]), "rightHand")?.name).toBe("hand_r");
    expect(socketBone(rig(["Hips", "Spine2", "Head"]), "chest")?.name).toBe("Spine2");
    expect(socketBone(rig(["CC_Base_Spine02", "CC_Base_Head"]), "head")?.name).toBe("CC_Base_Head");
  });

  it("never takes a finger, an end bone or the other side", () => {
    expect(socketBone(rig(["CC_Base_R_Hand_end", "CC_Base_R_Thumb1"]), "rightHand")).toBeNull();
    expect(socketBone(rig(["CC_Base_L_Hand"]), "rightHand")).toBeNull();
    expect(socketBone(rig(["CC_Base_R_Hand"]), "feet")).toBeNull();
  });
});
