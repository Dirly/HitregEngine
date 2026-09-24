import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { ThirdPersonCameraRig, fitRigToBody, type CameraSweep, type RigVec3 } from "../src/camera-rig.js";

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

interface Box {
  min: RigVec3;
  max: RigVec3;
}

/**
 * A world of axis-aligned boxes. The swept sphere is approximated by growing
 * each box by the radius (a cube, not a rounded one — conservative, and these
 * tests care about doorways, not about corner rounding). Honours `fromInside`
 * the way Rapier does: a probe that starts overlapping a box is stopped at 0
 * unless it was asked to ignore what it is already in.
 */
function boxWorld(boxes: Box[]): CameraSweep {
  return (r, from, to, fromInside) => {
    const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const len = Math.hypot(d[0]!, d[1]!, d[2]!);
    let best: number | null = null;
    for (const b of boxes) {
      let tEnter = 0;
      let tExit = 1;
      let inside = true;
      for (let a = 0; a < 3; a++) {
        const lo = b.min[a]! - r;
        const hi = b.max[a]! + r;
        const outside = from[a]! < lo || from[a]! > hi;
        if (outside) inside = false;
        if (Math.abs(d[a]!) < 1e-12) {
          if (outside) tExit = -1;
          continue;
        }
        const t1 = (lo - from[a]!) / d[a]!;
        const t2 = (hi - from[a]!) / d[a]!;
        tEnter = Math.max(tEnter, Math.min(t1, t2));
        tExit = Math.min(tExit, Math.max(t1, t2));
      }
      if (inside) {
        if (fromInside) continue;
        return 0;
      }
      if (tEnter <= tExit && tExit >= 0) best = best === null ? tEnter * len : Math.min(best, tEnter * len);
    }
    return best;
  };
}

function insideAny(boxes: Box[], p: THREE.Vector3Like, margin: number): boolean {
  return boxes.some(
    (b) =>
      p.x > b.min[0] - margin &&
      p.x < b.max[0] + margin &&
      p.y > b.min[1] - margin &&
      p.y < b.max[1] + margin &&
      p.z > b.min[2] - margin &&
      p.z < b.max[2] + margin,
  );
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
    const rig = new ThirdPersonCameraRig();
    const cam = camera();
    let z = 0;
    // 9.5 m/s — the MMO scene's sprint speed
    for (let i = 0; i < 300; i++) {
      z -= 9.5 / 60;
      rig.update(1 / 60, { x: 0, y: 0, z }, cam, clear);
    }
    const lag = Math.abs(rig.getPivot().z - z);
    // camera-controls' 0.25s smoothTime trailed by >2m here, which is what put
    // the camera through town walls. Under half a metre keeps the pivot inside
    // the character's own capsule width, so it cannot cut a door jamb.
    expect(lag).toBeLessThan(0.45);
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
    const rig = new ThirdPersonCameraRig({ distance: 7, skin: 0.2, pitchMin: 0, pitchMax: 0 });
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
    const rig = new ThirdPersonCameraRig({ distance: 7, skin: 0.2, pitchMin: 0, pitchMax: 0 });
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
    const rig = new ThirdPersonCameraRig({ distance: 7, minDistance: 1.1, fadeTargetBelow: 1.6 });
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

    rig.update(1 / 60, { x: 0, y: 0, z: 0 }, cam, clear);
    rig.update(1 / 60, { x: 0, y: 0, z: 0 }, cam, clear);
    const leaving = rig.distance;
    rig.update(1 / 60, { x: 0, y: 0, z: 0 }, cam, clear);
    expect(rig.distance - leaving).toBeLessThanOrEqual(7 / 60 + 1e-6); // capped on the way out
    for (let i = 0; i < 150; i++) rig.update(1 / 60, { x: 0, y: 0, z: 0 }, cam, clear);
    expect(rig.distance).toBeCloseTo(7, 2); // then back to the authored framing
  });

  it("does not chatter when obstructions come and go every other frame", () => {
    const rig = new ThirdPersonCameraRig({ distance: 7, skin: 0.2, pitchMin: 0, pitchMax: 0 });
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

describe("ThirdPersonCameraRig MMO boom", () => {
  it("never pitches on its own — only the mouse moves the angle", () => {
    // An earlier cut rose over obstructions by adding pitch. It made doorways
    // pump and, worse, made looking up read as an inverted axis.
    const rig = new ThirdPersonCameraRig({ distance: 7, height: 1.6, pitchMin: -1.2, pitchMax: 1.2 });
    rig.setOrbit(0, 0);
    const cam = camera();
    settle(rig, cam, wallAtZBelow(3, 4)); // a house front it COULD see over
    expect(cam.position.y).toBeCloseTo(1.6, 3); // stayed level
    expect(rig.distance).toBeLessThan(3.1); // and shortened instead
  });

  it("keeps lowering the camera as the mouse goes forward, into the ground and along it", () => {
    // The "inverted Y" report. Looking up drives the eye into the ground; the
    // boom must slide in along it, and the view angle must never come back up.
    const rig = new ThirdPersonCameraRig({ distance: 7.5, height: 1.6, pitchMin: -0.9, pitchMax: 1.15 });
    rig.setOrbit(0, 0.3);
    const cam = camera();
    const ground = boxWorld([{ min: [-100, -10, -100], max: [100, 0, 100] }]);
    settle(rig, cam, ground);
    let lastElevation = Infinity;
    for (let i = 0; i < 200; i++) {
      rig.addLook(0, -4); // steady push forward
      rig.update(1 / 60, { x: 0, y: 0, z: 0 }, cam, ground);
      const pivot = rig.getPivot();
      const elevation = Math.atan2(
        cam.position.y - pivot.y,
        Math.hypot(cam.position.x - pivot.x, cam.position.z - pivot.z),
      );
      expect(elevation).toBeLessThanOrEqual(lastElevation + 1e-9);
      expect(cam.position.y).toBeGreaterThan(0.25); // never under the ground
      lastElevation = elevation;
    }
    expect(lastElevation).toBeCloseTo(-0.9, 3); // reached the bottom of the band
  });

  it("flips the vertical axis on request and nothing else", () => {
    const rig = new ThirdPersonCameraRig({ invertY: true });
    const before = rig.orbit;
    rig.addLook(100, -100);
    expect(rig.orbit.pitch).toBeGreaterThan(before.pitch); // forward now RAISES the eye
    expect(rig.orbit.yaw).toBeLessThan(before.yaw); // yaw untouched by the flag
  });

  it("goes first person rather than holding a metre of wall in front of the lens", () => {
    const rig = new ThirdPersonCameraRig({ distance: 7 });
    rig.setOrbit(0, 0);
    const cam = camera();
    settle(rig, cam, () => 0); // wedged: every sweep is stopped at once
    expect(rig.distance).toBeLessThan(0.4);
    expect(rig.targetObscured).toBe(true); // and the body is out of the shot
  });

  it("costs one sweep a frame at rest — no pivot guard, no look-ahead while nothing moves", () => {
    let calls = 0;
    const counting: CameraSweep = () => {
      calls++;
      return null;
    };
    const rig = new ThirdPersonCameraRig({ distance: 7 });
    const cam = camera();
    for (let i = 0; i < 10; i++) rig.update(1 / 60, { x: 0, y: 0, z: 0 }, cam, counting);
    expect(calls).toBe(10); // the boom, nothing else
  });

  it("does not strobe the body when the boom hovers at the fade distance", () => {
    const rig = new ThirdPersonCameraRig({ distance: 7, fadeTargetBelow: 1, skin: 0, pitchMin: 0, pitchMax: 0 });
    rig.setOrbit(0, 0);
    const cam = camera();
    settle(rig, cam, wallAtZ(0.9), 30);
    let toggles = 0;
    let last = rig.targetObscured;
    for (let i = 0; i < 240; i++) {
      // a wall wobbling between 0.85 and 0.98 m, inside the hysteresis band
      rig.update(1 / 60, { x: 0, y: 0, z: 0 }, cam, wallAtZ(i % 2 === 0 ? 0.85 : 0.98));
      if (rig.targetObscured !== last) toggles++;
      last = rig.targetObscured;
    }
    expect(toggles).toBe(0);
  });
});

describe("ThirdPersonCameraRig entering a building", () => {
  // A housefront across z = 0 with a doorway in it: 1.2 m wide, 2.2 m tall.
  // The character origin is its capsule centre (0.9 m up), as in the MMO.
  const FRONT: Box[] = [
    { min: [-20, 0, -0.15], max: [-0.6, 6, 0.15] },
    { min: [0.6, 0, -0.15], max: [20, 6, 0.15] },
    { min: [-0.6, 2.2, -0.15], max: [0.6, 6, 0.15] }, // the lintel
    { min: [-100, -10, -100], max: [100, 0, 100] }, // the ground
  ];

  function walkThrough(rig: ThirdPersonCameraRig): { worstJump: number; clipped: number } {
    const cam = camera();
    const world = boxWorld(FRONT);
    rig.setOrbit(0, 0.25);
    let z = 8;
    for (let i = 0; i < 60; i++) rig.update(1 / 60, { x: 0, y: 0.9, z }, cam, world);
    let worstJump = 0;
    let clipped = 0;
    let last = rig.distance;
    while (z > -8) {
      z -= 6.5 / 60; // the MMO run speed, straight in through the door
      rig.update(1 / 60, { x: 0, y: 0.9, z }, cam, world);
      worstJump = Math.max(worstJump, Math.abs(rig.distance - last));
      last = rig.distance;
      if (insideAny(FRONT, cam.position, 0.2)) clipped++;
    }
    return { worstJump, clipped };
  }

  it("closes the boom through a doorway instead of jump-cutting under the lintel", () => {
    const blind = walkThrough(new ThirdPersonCameraRig({ distance: 7.5, height: 0.65, lookAhead: 0 }));
    const sighted = walkThrough(new ThirdPersonCameraRig({ distance: 7.5, height: 0.65 }));
    expect(blind.worstJump).toBeGreaterThan(3); // the pop this replaces: metres in one frame
    expect(sighted.worstJump).toBeLessThan(0.6); // a steady dolly-in: ~15 m/s, never a lurch
    expect(sighted.clipped).toBe(0); // and the eye was never inside the masonry
    expect(blind.clipped).toBe(0);
  });

  it("stands in the doorway without going first person, once the pivot is fitted to the body", () => {
    // pivotHeight 1.6 over a capsule-CENTRE origin is 2.5 m up — above the
    // head and inside a 2.2 m lintel. The boom sweep that starts in there
    // reports 0, which slammed the camera to first person in every doorway.
    const stand = (pivotHeight: number): ThirdPersonCameraRig => {
      const rig = new ThirdPersonCameraRig();
      rig.applyAuthored({ mode: "follow", distance: 7.5, height: pivotHeight + 0.4, pivotHeight });
      rig.setOrbit(0, null);
      const cam = camera();
      // strict world: a probe that starts overlapping is stopped at once
      const world = boxWorld(FRONT);
      const strict: CameraSweep = (r, from, to) => world(r, from, to, false);
      for (let i = 0; i < 120; i++) rig.update(1 / 60, { x: 0, y: 0.9, z: 0 }, cam, strict);
      return rig;
    };
    const body = { shape: "capsule", size: [0.8, 1.8, 0.8] };
    expect(stand(1.6).targetObscured).toBe(true); // the bug, reproduced
    const fitted = fitRigToBody({ mode: "follow", pivotHeight: 1.6 }, body).pivotHeight!;
    const rig = stand(fitted);
    expect(rig.targetObscured).toBe(false);
    expect(rig.distance).toBeGreaterThan(7); // the boom runs out of the door behind
  });

  it("keeps a lagging pivot from cutting the door jamb on a turn", () => {
    const rig = new ThirdPersonCameraRig({ distance: 5, height: 0.65, followDamping: 6 }); // sloppy on purpose
    rig.setOrbit(0, 0.1);
    const cam = camera();
    const world = boxWorld(FRONT);
    // run along the inside of the housefront, then turn out through the door
    let x = -6;
    let z = -0.6;
    for (let i = 0; i < 30; i++) rig.update(1 / 60, { x, y: 0.9, z }, cam, world);
    for (let i = 0; i < 400; i++) {
      if (x < 0) x += 9.5 / 60;
      else z += 9.5 / 60;
      rig.update(1 / 60, { x, y: 0.9, z }, cam, world);
      expect(insideAny(FRONT, rig.getPivot(), 0.25)).toBe(false);
    }
  });
});

describe("ThirdPersonCameraRig wheel", () => {
  it("glides to the new framing instead of stepping per notch", () => {
    const rig = new ThirdPersonCameraRig({ distance: 7 });
    const cam = camera();
    settle(rig, cam, clear, 10);
    rig.addZoom(-3);
    rig.update(1 / 60, { x: 0, y: 0, z: 0 }, cam, clear);
    expect(rig.distance).toBeGreaterThan(6.2); // one frame later it has barely begun
    settle(rig, cam, clear, 120);
    expect(rig.distance).toBeCloseTo(4, 2);
  });

  it("rolls all the way in to first person, with a first-person look band", () => {
    const rig = new ThirdPersonCameraRig({ distance: 7 });
    const cam = camera();
    rig.addZoom(-100);
    settle(rig, cam, clear, 120);
    expect(rig.firstPerson).toBe(true);
    expect(rig.targetObscured).toBe(true); // no body in a first-person view
    rig.addLook(0, -100000);
    expect(rig.orbit.pitch).toBeCloseTo(-1.4, 5); // can look at the sky from in here

    // back out: the pitch is walked into the third-person band, not snapped
    rig.addZoom(8);
    rig.addZoom(8);
    rig.update(1 / 60, { x: 0, y: 0, z: 0 }, cam, clear);
    expect(rig.firstPerson).toBe(false);
    expect(rig.orbit.pitch).toBeLessThan(-1.3);
    settle(rig, cam, clear, 120);
    expect(rig.orbit.pitch).toBeCloseTo(rig.config.pitchMin, 5);
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
    const rig = new ThirdPersonCameraRig({ mode: "chase", distance: 7, skin: 0.2, pitchMin: 0, pitchMax: 0 });
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

describe("fitRigToBody", () => {
  it("pulls a default pivot down inside a capsule whose origin is its centre", () => {
    // the MMO player: 1.8 m capsule centred on the entity, pivotHeight left at 1.6
    const fitted = fitRigToBody({ mode: "follow", pivotHeight: 1.6 }, { shape: "capsule", size: [0.8, 1.8, 0.8] });
    expect(fitted.pivotHeight).toBeCloseTo(0.6, 6); // 1.5 m over the feet, probe and all inside the body
  });

  it("leaves a feet-origin character and a lower authored pivot alone", () => {
    const feet = { shape: "capsule", size: [0.8, 1.8, 0.8], offset: [0, 0.9, 0] };
    const rig = { mode: "follow", pivotHeight: 1.5 };
    expect(fitRigToBody(rig, feet)).toBe(rig); // already a probe radius under the 1.8 m top
    const low = { mode: "follow", pivotHeight: 0.6 };
    expect(fitRigToBody(low, { shape: "capsule", size: [0.8, 1.8, 0.8] })).toBe(low);
  });

  it("does not second-guess a chase rig, a cooked collider, or no collider", () => {
    const rig = { mode: "chase", pivotHeight: 3 };
    expect(fitRigToBody(rig, { shape: "box", size: [2, 1, 4] })).toBe(rig);
    const follow = { mode: "follow", pivotHeight: 1.6 };
    expect(fitRigToBody(follow, { shape: "trimesh", size: [1, 1, 1] })).toBe(follow);
    expect(fitRigToBody(follow, undefined)).toBe(follow);
  });
});

describe("ThirdPersonCameraRig free look", () => {
  it("orbits the camera while the aim holds, stays parked, and swings back when asked", () => {
    const rig = new ThirdPersonCameraRig({ distance: 7, pitchMin: -0.5, pitchMax: 0.5 });
    rig.setOrbit(0, 0);
    const cam = camera();
    settle(rig, cam, clear, 10);
    const aim = rig.aimDirection();
    expect(aim.z).toBeCloseTo(-1, 3);

    rig.setFreeLook(true);
    rig.addLook(600, 0); // ~86° to the right
    settle(rig, cam, clear, 10);
    expect(rig.freeLooking).toBe(true);
    expect(cam.getWorldDirection(new THREE.Vector3()).x).toBeGreaterThan(0.9);
    // the aim — what movement and facing read — never moved
    expect(rig.aimDirection().distanceTo(aim)).toBeLessThan(1e-9);
    expect(rig.orbit.yaw).toBe(0);

    rig.setFreeLook(false);
    settle(rig, cam, clear, 60);
    // released: parked, so the player can keep looking at their character
    expect(cam.getWorldDirection(new THREE.Vector3()).x).toBeGreaterThan(0.9);

    rig.returnToAim(); // they moved or cast
    settle(rig, cam, clear, 60); // one second
    expect(rig.freeLooking).toBe(false);
    expect(cam.getWorldDirection(new THREE.Vector3()).z).toBeCloseTo(-1, 3);
  });

  it("returns the short way round after a spin past half a turn", () => {
    const rig = new ThirdPersonCameraRig({ distance: 7, pitchMin: 0, pitchMax: 0, freeLookReturn: 14 });
    rig.setOrbit(0, 0);
    const cam = camera();
    rig.setFreeLook(true);
    rig.addLook(-(Math.PI * 1.9) / 0.0025, 0); // 342° one way = 18° the other
    rig.setFreeLook(false);
    rig.returnToAim();
    let maxTurn = 0;
    for (let i = 0; i < 60; i++) {
      rig.update(1 / 60, { x: 0, y: 0, z: 0 }, cam, clear);
      maxTurn = Math.max(maxTurn, Math.abs(cam.getWorldDirection(new THREE.Vector3()).x));
    }
    expect(maxTurn).toBeLessThan(Math.sin(0.35)); // never swept through the long way
    expect(cam.getWorldDirection(new THREE.Vector3()).z).toBeCloseTo(-1, 3);
  });

  it("keeps the free-look pitch inside the look band", () => {
    const rig = new ThirdPersonCameraRig({ pitchMin: -0.4, pitchMax: 0.8 });
    rig.setOrbit(0, 0);
    rig.setFreeLook(true);
    rig.addLook(0, 1e6);
    const cam = camera();
    settle(rig, cam, clear, 1);
    expect(Math.asin(-cam.getWorldDirection(new THREE.Vector3()).y)).toBeCloseTo(0.8, 3);
    expect(rig.orbit.pitch).toBe(0);
  });

  it("turning the aim from a parked view adopts the view first, without a cut", () => {
    const rig = new ThirdPersonCameraRig({ distance: 7, pitchMin: 0, pitchMax: 0 });
    rig.setOrbit(0, 0);
    const cam = camera();
    rig.setFreeLook(true);
    rig.addLook(Math.PI / 0.0025, 0); // swung round to the front
    rig.setFreeLook(false);
    settle(rig, cam, clear, 5);
    const parked = cam.getWorldDirection(new THREE.Vector3());

    rig.addLook(0.001, 0); // a right-drag, as small as it gets
    settle(rig, cam, clear, 5);
    expect(cam.getWorldDirection(new THREE.Vector3()).distanceTo(parked)).toBeLessThan(1e-3);
    expect(rig.freeLooking).toBe(false);
    // and the aim now points where the camera does
    expect(rig.aimDirection().distanceTo(parked)).toBeLessThan(1e-3);
  });

  it("is ignored by a chase rig, whose yaw belongs to its target", () => {
    const rig = new ThirdPersonCameraRig({ mode: "chase" });
    rig.setFreeLook(true);
    expect(rig.freeLooking).toBe(false);
  });
});
