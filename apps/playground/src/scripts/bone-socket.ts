import * as THREE from "three/webgpu";
import { Script } from "@hitreg/scripting";

/**
 * Sockets this entity onto a named bone of its PARENT entity's skinned model
 * (weapons in hands, hats on heads). Visual-only: copies the bone's world
 * pose onto this entity every tick, with tunable offsets — adjust `offset` /
 * `rotationDeg` live in the inspector until the prop sits right.
 */
export default class BoneSocket extends Script {
  static override scriptName = "bone-socket";
  static override params = {
    bone: { default: "mixamorig:RightHand" },
    offset: { default: [0, 0, 0], description: "position offset, bone-oriented world units" },
    rotationDeg: { default: [0, 90, 0], description: "rotation offset in degrees" },
  };

  private bone: THREE.Object3D | null = null;
  private readonly offsetQuat = new THREE.Quaternion();
  private readonly bonePos = new THREE.Vector3();
  private readonly boneQuat = new THREE.Quaternion();
  private readonly parentQuat = new THREE.Quaternion();
  private readonly shift = new THREE.Vector3();

  override onStart(): void {
    const deg = this.param<[number, number, number]>("rotationDeg");
    this.offsetQuat.setFromEuler(
      new THREE.Euler(
        (deg[0] * Math.PI) / 180,
        (deg[1] * Math.PI) / 180,
        (deg[2] * Math.PI) / 180,
      ),
    );
  }

  override onFixedUpdate(): void {
    const parent = this.object.parent;
    if (!parent) return;
    if (!this.bone) {
      // the skinned model loads async — keep looking until it appears
      this.bone = parent.getObjectByName(this.param<string>("bone")) ?? null;
      if (!this.bone) return;
    }
    this.bone.updateWorldMatrix(true, false);
    this.bone.getWorldPosition(this.bonePos);
    this.bone.getWorldQuaternion(this.boneQuat);

    const off = this.param<[number, number, number]>("offset");
    this.shift.set(off[0], off[1], off[2]).applyQuaternion(this.boneQuat);
    this.bonePos.add(this.shift);

    parent.updateWorldMatrix(true, false);
    this.object.position.copy(parent.worldToLocal(this.bonePos));
    parent.getWorldQuaternion(this.parentQuat).invert();
    this.object.quaternion.copy(
      this.parentQuat.multiply(this.boneQuat).multiply(this.offsetQuat),
    );
  }
}
