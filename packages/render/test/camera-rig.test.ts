import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { ThirdPersonCameraRig, type CameraSweep, type RigVec3 } from "../src/camera-rig.js";

const camera = (): THREE.PerspectiveCamera => new THREE.PerspectiveCamera(60, 1.78, 0.1, 4000);

/** Nothing in the way, ever. */
const clear: CameraSweep = () => null;

/**
 * A wall: an infinite plane at `z = at`, hit only by a segment that crosses it
 * going +z. Returns the distance along the segment, like `sim.spherecast`.
 */
function wallAtZ(at: number): CameraSweep {
  return (_r: number, from: RigVec3, to: RigVec3) => {
    if (from[2] >= at) return 0; // already through it — a penetrating sweep reports 0
    if (to[2] <= at) return null;
    const t = (at - from[2]) / (to[2] - from[2]);
    return t * Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  };
}

/** A wall only up to `top` — a house you can see over. */
function wallAtZBelow(at: number, top: number): CameraSweep {
  const wall = wallAtZ(at);
  return (r, from, to) => {
    const hit = wall(r, from, to);
    if (hit === null) return null;
    const len = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    const y = from[1] + ((to[1] - from[1]) * hit) / (len || 1);
    return y > top ? null : hit;
  };
}

/** Run `frames` fixed 60 Hz updates with a stationary target. */
function settle(rig: ThirdPersonCameraRig, cam: THREE.Camera, sweep: CameraSweep, frames = 240): void {
  for (let i = 0; i < frames; i++) rig.update(1 / 60, { x: 0, y: 0, z: 0 }, cam, sweep);
}

describe("ThirdPersonCameraRig framing", () => {
  it("parks the camera behind the pivot at the authored distance and looks at it", () => {
    const rig = new ThirdPersonCameraRig({ distance: 7, height: 1.6, pitchMin: 0, pitchMax: 0 });
    rig.setOrbit(0, 0);
    const cam = camera();
    settle(rig, cam, clear);

    expect(cam.position.x).toBeCloseTo(0, 3);
    expect(cam.position.y).toBeCloseTo(1.6, 3);
    expect(cam.position.z).toBeCloseTo(7, 3);
    // looking back down -z at the pivot
    const forward = cam.getWorldDirection(new THREE.Vector3());
    expect(forward.z).toBeCloseTo(-1, 3);
  });

  it("honours the wheel between min and max, never outside", () => {
    const rig = new ThirdPersonCameraRig({ distance: 7, minDistance: 1.1, maxDistance: 14 });
    rig.addZoom(100);
    expect(rig.wantedFraming).toBe(14);
    rig.addZoom(-100);
    expect(rig.wantedFraming).toBe(1.1);
  });

  it("clamps pitch to the configured band", () => {
    const rig = new ThirdPersonCameraRig({ pitchMin: -1, pitchMax: 1 });
    rig.addLook(0, 100000);
    expect(rig.orbit.pitch).toBeCloseTo(1, 6);
    rig.addLook(0, -100000);
    expect(rig.orbit.pitch).toBeCloseTo(-1, 6);
  });

  it("looks UP when the mouse goes forward and DOWN when it comes back", () => {
    // the sign that is invisible in code and instantly obvious in the hand
    const rig = new ThirdPersonCameraRig({ distance: 7, height: 1.6 });
    rig.setOrbit(0, 0);
    const cam = camera();
    rig.update(1 / 60, { x: 0, y: 0, z: 0 }, cam, clear);
    const level = cam.position.y;

    rig.addLook(0, -120); // mouse forward = look up
    rig.update(1 / 60, { x: 0, y: 0, z: 0 }, cam, clear);
    expect(cam.position.y).toBeLessThan(level); // eye drops, view tilts up
    expect(cam.getWorldDirection(new THREE.Vector3()).y).toBeGreaterThan(0);

    rig.addLook(0, 240); // mouse back = look down
    rig.update(1 / 60, { x: 0, y: 0, z: 0 }, cam, clear);
    expect(cam.position.y).toBeGreaterThan(level);
    expect(cam.getWorldDirection(new THREE.Vector3()).y).toBeLessThan(0);
  });

  it("turns right when the mouse goes right", () => {
    const rig = new ThirdPersonCameraRig({ distance: 7, pitchMin: 0, pitchMax: 0 });
    rig.setOrbit(0, 0); // camera at +z, looking down -z ("north")
    const cam = camera();
    rig.addLook(200, 0);
    rig.update(1 / 60, { x: 0, y: 0, z: 0 }, cam, clear);
    // turning north -> east means the view direction picks up +x
    expect(cam.getWorldDirection(new THREE.Vector3()).x).toBeGreaterThan(0);
  });
});

describe("ThirdPersonCameraRig pivot tracking", () => {
  it("trails a moving target but stays within a fraction of a metre at a sprint", () => {
    const rig = new ThirdPersonCameraRig({ followDamping: 14 });
    const cam = camera();
    let z = 0;
    // 9.5 m/s — the MMO scene's sprint speed
    for (let i = 0; i < 300; i++) {
      z -= 9.5 / 60;
      rig.update(1 / 60, { x: 0, y: 0, z }, cam, clear);
    }
    const lag = Math.abs(rig.getPivot().z - z);
    // camera-controls' 0.25s smoothTime trailed by >2m here, which is what put
    // the camera through town walls; the rig's own damping keeps it under 0.75
    expect(lag).toBeLessThan(0.75);
  });

  it("snaps rather than sweeps across a teleport", () => {
    const rig = new ThirdPersonCameraRig();
    const cam = camera();
    rig.update(1 / 60, { x: 0, y: 0, z: 0 }, cam, clear);
    rig.update(1 / 60, { x: 400, y: 0, z: -400 }, cam, clear);
    expect(rig.getPivot().x).toBeCloseTo(400, 3);
    expect(rig.getPivot().z).toBeCloseTo(-400, 3);
  });

  it("smooths a stair step vertically without dropping a fall", () => {
    const rig = new ThirdPersonCameraRig({ verticalDamping: 7, verticalSnap: 2.5, height: 1.6 });
    const cam = camera();
    rig.update(1 / 60, { x: 0, y: 0, z: 0 }, cam, clear);
    rig.update(1 / 60, { x: 0, y: 0.3, z: 0 }, cam, clear); // one step up
    expect(rig.getPivot().y).toBeGreaterThan(1.6);
    expect(rig.getPivot().y).toBeLessThan(1.66); // lags the step, no bob

    rig.update(1 / 60, { x: 0, y: -8, z: 0 }, cam, clear); // fell off a wall
    expect(rig.getPivot().y).toBeCloseTo(-8 + 1.6, 3); // tracked immediately
  });
});

describe("ThirdPersonCameraRig collision", () => {
  it("shortens the boom to stop short of a wall, and resolves it about the pivot it orbits", () => {
    const rig = new ThirdPersonCameraRig({ distance: 7, skin: 0.2, pitchMin: 0, pitchMax: 0, lift: false });
    rig.setOrbit(0, 0);
    const cam = camera();
    settle(rig, cam, wallAtZ(3));
    expect(rig.distance).toBeCloseTo(2.8, 2);
    expect(cam.position.z).toBeCloseTo(2.8, 2);
  });

  it("never puts the camera past the wall while the target runs — the town regression", () => {
    // The old rig measured clearance from the player's true position but
    // applied it about camera-controls' damped (trailing) target, so a running
    // player put the camera metres beyond what the sweep had cleared. Here the
    // wall sits behind a target running along it; the eye must stay in front.
    const rig = new ThirdPersonCameraRig({ distance: 7, skin: 0.2, pitchMin: 0, pitchMax: 0, lift: false });
    rig.setOrbit(0, 0);
    const cam = camera();
    const sweep = wallAtZ(3);
    let x = 0;
    let worst = -Infinity;
    for (let i = 0; i < 400; i++) {
      x -= 9.5 / 60;
      rig.update(1 / 60, { x, y: 0, z: 0 }, cam, sweep);
      worst = Math.max(worst, cam.position.z);
    }
    expect(worst).toBeLessThanOrEqual(3);
  });

  it("floors a penetrating sweep at minDistance instead of the character's head", () => {
    const rig = new ThirdPersonCameraRig({ distance: 7, minDistance: 1.1, fadeTargetBelow: 1.6, lift: false });
    rig.setOrbit(0, 0);
    const cam = camera();
    settle(rig, cam, () => 0); // everything is penetrating
    expect(rig.distance).toBeCloseTo(1.1, 5);
    expect(rig.targetObscured).toBe(true);
  });

  it("snaps in immediately, then holds before returning at a bounded rate", () => {
    const rig = new ThirdPersonCameraRig({
      distance: 7,
      skin: 0.2,
      pitchMin: 0,
      pitchMax: 0,
      lift: false,
      recoverDelay: 0.15,
      recoverSpeed: 7,
    });
    rig.setOrbit(0, 0);
    const cam = camera();
    const blocked = wallAtZ(3);
    rig.update(1 / 60, { x: 0, y: 0, z: 0 }, cam, blocked);
    expect(rig.distance).toBeCloseTo(2.8, 2); // one frame, all the way in

    // obstruction gone: still short through the hold window
    rig.update(1 / 60, { x: 0, y: 0, z: 0 }, cam, clear);
    expect(rig.distance).toBeCloseTo(2.8, 2);
    for (let i = 0; i < 9; i++) rig.update(1 / 60, { x: 0, y: 0, z: 0 }, cam, clear);
    expect(rig.distance).toBeCloseTo(2.8, 1); // ~0.15s of hold, barely moved

    for (let i = 0; i < 60; i++) rig.update(1 / 60, { x: 0, y: 0, z: 0 }, cam, clear);
    expect(rig.distance).toBeCloseTo(7, 2); // then back to the authored framing
  });

  it("does not chatter when obstructions come and go every other frame", () => {
    const rig = new ThirdPersonCameraRig({ distance: 7, skin: 0.2, pitchMin: 0, pitchMax: 0, lift: false });
    rig.setOrbit(0, 0);
    const cam = camera();
    const blocked = wallAtZ(3);
    let swing = 0;
    let last = rig.distance;
    for (let i = 0; i < 120; i++) {
      rig.update(1 / 60, { x: 0, y: 0, z: 0 }, cam, i % 2 === 0 ? blocked : clear);
      swing += Math.abs(rig.distance - last);
      last = rig.distance;
    }
    // the hold keeps it parked at the short length instead of yo-yoing 4m/frame
    expect(swing).toBeLessThan(4.5);
  });

  it("ignores collision entirely when the host supplies no sweep", () => {
    const rig = new ThirdPersonCameraRig({ distance: 9 });
    const cam = camera();
    for (let i = 0; i < 120; i++) rig.update(1 / 60, { x: 0, y: 0, z: 0 }, cam, null);
    expect(rig.distance).toBeCloseTo(9, 5);
  });
});

describe("ThirdPersonCameraRig obstruction avoidance", () => {
  it("rises over a house instead of pressing flat against its front", () => {
    const rig = new ThirdPersonCameraRig({
      distance: 7,
      height: 1.6,
      pitchMin: -1.2,
      pitchMax: 1.2,
      lift: true,
      liftMax: 0.7,
    });
    rig.setOrbit(0, 0);
    const cam = camera();
    // a 4m eave 3m behind the character: level, the boom is cut to ~2.8m
    settle(rig, cam, wallAtZBelow(3, 4));
    expect(rig.distance).toBeGreaterThan(6); // kept its framing
    expect(cam.position.y).toBeGreaterThan(4); // by going over the roof
  });

  it("falls back to shortening when there is no way over", () => {
    const rig = new ThirdPersonCameraRig({ distance: 7, skin: 0.2, lift: true, liftMax: 0.7 });
    rig.setOrbit(0, 0);
    const cam = camera();
    settle(rig, cam, wallAtZ(3)); // infinitely tall
    expect(rig.distance).toBeLessThan(3.1);
  });

  it("holds the lift instead of bobbing over the roofline", () => {
    // Judging the lift from where the camera already IS makes it
    // self-cancelling: risen over the eave the shot is clear, so the rig
    // stops lifting, so the eave blocks again. This is that oscillation.
    const rig = new ThirdPersonCameraRig({
      distance: 7,
      height: 1.6,
      pitchMin: -1.2,
      pitchMax: 1.2,
      lift: true,
    });
    rig.setOrbit(0, 0);
    const cam = camera();
    const sweep = wallAtZBelow(3, 4);
    settle(rig, cam, sweep, 180); // let it climb over

    const heights = [];
    for (let i = 0; i < 180; i++) {
      rig.update(1 / 60, { x: 0, y: 0, z: 0 }, cam, sweep);
      heights.push(cam.position.y);
    }
    const spread = Math.max(...heights) - Math.min(...heights);
    expect(spread).toBeLessThan(0.05); // parked, not pumping up and down
  });

  it("goes first person rather than holding a metre of wall in front of the lens", () => {
    const rig = new ThirdPersonCameraRig({ distance: 7 });
    rig.setOrbit(0, 0);
    const cam = camera();
    settle(rig, cam, () => 0); // wedged: every sweep starts penetrating
    expect(rig.distance).toBeLessThan(0.4);
    expect(rig.targetObscured).toBe(true); // and the body is out of the shot
  });

  it("costs no extra sweeps while the shot is clear", () => {
    let calls = 0;
    const counting: CameraSweep = () => {
      calls++;
      return null;
    };
    const rig = new ThirdPersonCameraRig({ distance: 7, lift: true });
    const cam = camera();
    for (let i = 0; i < 10; i++) rig.update(1 / 60, { x: 0, y: 0, z: 0 }, cam, counting);
    expect(calls).toBe(10); // one per frame, no avoidance probes
  });
});

describe("ThirdPersonCameraRig chase mode", () => {
  it("takes yaw from the target and ignores mouse look", () => {
    const rig = new ThirdPersonCameraRig({ mode: "chase", distance: 6, height: 1.5, pitchMin: 0, pitchMax: 0 });
    const cam = camera();
    rig.addLook(5000, 5000); // a chase rig leaves the mouse to gameplay
    expect(rig.orbit.yaw).toBe(0);

    // target facing +x (yaw -90°): the camera belongs at -x
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
    for (let i = 0; i < 120; i++) rig.update(1 / 60, { x: 0, y: 0, z: 0 }, cam, clear, q);
    expect(cam.position.x).toBeCloseTo(-6, 2);
    expect(cam.position.z).toBeCloseTo(0, 2);
  });

  it("collides like the follow rig — the old chase rig clipped through everything", () => {
    const rig = new ThirdPersonCameraRig({ mode: "chase", distance: 7, skin: 0.2, pitchMin: 0, pitchMax: 0, lift: false });
    const cam = camera();
    const q = new THREE.Quaternion();
    for (let i = 0; i < 120; i++) rig.update(1 / 60, { x: 0, y: 0, z: 0 }, cam, wallAtZ(3), q);
    expect(cam.position.z).toBeCloseTo(2.8, 2);
  });
});

describe("ThirdPersonCameraRig authored config", () => {
  it("reads a follow rig's height as a downward PITCH over the pivot, not a translation", () => {
    // the MMO scene's own numbers: the follow rig used to ignore height outright
    const rig = new ThirdPersonCameraRig();
    rig.applyAuthored({ mode: "follow", distance: 7.5, height: 3.1, pivotHeight: 1.6 });
    expect(rig.wantedFraming).toBeCloseTo(7.5, 5);
    expect(rig.orbit.pitch).toBeCloseTo(Math.asin(1.5 / 7.5), 5); // ~11.5° above level

    const cam = camera();
    settle(rig, cam, clear);
    expect(cam.position.y).toBeCloseTo(3.1, 2); // eye where the author framed it
    expect(Math.hypot(cam.position.x, cam.position.z)).toBeCloseTo(
      Math.sqrt(7.5 * 7.5 - 1.5 * 1.5),
      2,
    );
  });

  it("reads a chase rig's distance as horizontal and its height as literal", () => {
    const rig = new ThirdPersonCameraRig();
    rig.applyAuthored({ mode: "chase", distance: 6, height: 3.6, pivotHeight: 1.6 });
    const cam = camera();
    const q = new THREE.Quaternion();
    for (let i = 0; i < 120; i++) rig.update(1 / 60, { x: 0, y: 0, z: 0 }, cam, clear, q);
    expect(cam.position.y).toBeCloseTo(3.6, 2);
    expect(Math.hypot(cam.position.x, cam.position.z)).toBeCloseTo(6, 2);
  });

  it("keeps a chase rig's pitch pinned and a follow rig's free", () => {
    const chase = new ThirdPersonCameraRig();
    chase.applyAuthored({ mode: "chase", distance: 6, height: 3.6 });
    const pinned = chase.orbit.pitch;
    chase.addLook(0, -400);
    expect(chase.orbit.pitch).toBe(pinned);

    const follow = new ThirdPersonCameraRig();
    follow.applyAuthored({ mode: "follow", distance: 7, height: 3 });
    const authored = follow.orbit.pitch;
    expect(authored).toBeGreaterThan(0); // height above the pivot = looking down
    follow.addLook(0, -100); // and the player can look up from there
    expect(follow.orbit.pitch).toBeLessThan(authored);
  });
});

describe("ThirdPersonCameraRig handover", () => {
  it("adopts the orbit a free camera was sitting at, so entering play does not cut", () => {
    const rig = new ThirdPersonCameraRig();
    const cam = camera();
    cam.position.set(0, 10, 10); // 45° above, due +z
    rig.alignFromCamera(cam, { x: 0, y: 0, z: 0 });
    expect(rig.orbit.yaw).toBeCloseTo(0, 3);
    expect(rig.orbit.pitch).toBeCloseTo(Math.PI / 4, 3);
  });

  it("re-seeds the pivot after a reset instead of sweeping across the world", () => {
    const rig = new ThirdPersonCameraRig();
    const cam = camera();
    rig.update(1 / 60, { x: 0, y: 0, z: 0 }, cam, clear);
    rig.reset();
    rig.update(1 / 60, { x: 100, y: 0, z: 0 }, cam, clear);
    expect(rig.getPivot().x).toBeCloseTo(100, 3);
  });
});
