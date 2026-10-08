import { describe, expect, it } from "vitest";
import {
  anchorPose,
  NetStateStore,
  portalArrivalSpot,
  portalDeparture,
  portalVolumeDistance,
  portalVolumeForCorridor,
  portalVolumeOf,
  registerCharacterNetState,
  resolvePortalArrival,
  type EntityDoc,
} from "../src/index.js";

const e = (parent: string | null, position: number[], rotation = [0, 0, 0, 1]): EntityDoc => ({ name: "x", parent, tags: [], components: { transform: { position, rotation, scale: [1, 1, 1] } } });

describe("portal records", () => {
  it("composes an anchor's world pose up the parent chain", () => {
    const half = Math.SQRT1_2;
    const entities = { root: e(null, [10, 2, 0], [0, half, 0, half]), anchor: e("root", [0, 0, -5]) };
    const pose = anchorPose(entities, "anchor")!;
    expect(pose.position[0]).toBeCloseTo(5);
    expect(pose.position[1]).toBeCloseTo(2);
    expect(pose.position[2]).toBeCloseTo(0);
    expect(pose.yaw).toBeCloseTo(Math.PI / 2);
    expect(anchorPose(entities, "missing")).toBeNull();
  });

  it("an entering trip records the arrival and the way back; the return uses it up", () => {
    const enter = portalDeparture(undefined, { actorId: "b", portalId: "door", scene: "barrow", anchor: "entry", back: false, party: true, returnTo: { position: [1, 2, 3], yaw: 0.5 } }, { scene: "proving", srv: "layer-1" });
    expect(enter.scene).toBe("barrow");
    expect(enter.record).toEqual({ arrive: { scene: "barrow", anchor: "entry" }, return: { scene: "proving", position: [1, 2, 3], yaw: 0.5, portal: "door", srv: "layer-1" } });
    const landed = resolvePortalArrival(enter.record, "barrow", { entry: e(null, [0, 0, -7]) })!;
    expect(landed.position).toEqual([0, 1.2, -7]);
    expect(landed.next).toEqual({ return: enter.record.return });
    expect(resolvePortalArrival(enter.record, "elsewhere", {})).toBeNull();
    const back = portalDeparture(landed.next, { actorId: "b", portalId: "exit", scene: "proving", back: true, party: false }, { scene: "barrow" });
    expect(back).toEqual({ scene: "proving", record: { arrive: { scene: "proving", position: [1, 2, 3], yaw: 0.5 } } });
    const home = resolvePortalArrival(back.record, "proving", {})!;
    expect(home.position).toEqual([1, 2, 3]);
    expect(home.next).toEqual({});
  });

  it("portal/<bodyId> validates in netState", () => {
    const store = new NetStateStore();
    store.setAuthority(true);
    registerCharacterNetState(store);
    expect(store.set("portal/b", { return: { scene: "s", position: [0, 0, 0], yaw: 0 } })).toBe(true);
    expect(store.set("portal/b", { arrive: { scene: "" } })).toBe(false);
  });
});

describe("portal arrivals and trigger volumes", () => {
  it("a corridor anchor lines later arrivals up along its forward line; open ground rings them", () => {
    const base: [number, number, number] = [10, 1.2, 0];
    const yaw = Math.PI / 2; // facing +X
    expect(portalArrivalSpot(base, yaw, 2.4, [])).toEqual(base);
    const second = portalArrivalSpot(base, yaw, 2.4, [base]);
    expect(second[0]).toBeCloseTo(11.1);
    expect(second[2]).toBeCloseTo(0); // never sideways into the passage wall
    const third = portalArrivalSpot(base, yaw, 2.4, [base, second]);
    expect(third[0]).toBeCloseTo(12.2);
    const ring = portalArrivalSpot(base, yaw, 0, [base]);
    expect(Math.hypot(ring[0] - 10, ring[2])).toBeCloseTo(1.2);
    // resolvePortalArrival reads the anchor's portalAnchor.corridor
    const entities: Record<string, EntityDoc> = {
      entry: { name: "entry", parent: null, tags: ["instance-entry"], components: { transform: { position: [10, 0, 0], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] }, portalAnchor: { corridor: 2 } } },
    };
    const landed = resolvePortalArrival({ arrive: { scene: "d", anchor: "entry" } }, "d", entities, [[10, 1.2, 0]])!;
    expect(landed.position[0]).toBeCloseTo(11.1);
    expect(landed.position[2]).toBeCloseTo(0);
    expect(landed.yaw).toBeCloseTo(Math.PI / 2);
  });

  it("trigger volume: params, distance, and a corridor-sized return volume", () => {
    expect(portalVolumeOf({ scene: "x" })).toBeNull();
    const v = portalVolumeOf({ mode: "trigger" })!;
    expect(v.half).toEqual([1.2, 1.3, 0.75]);
    expect(portalVolumeDistance([0, 1.2, 0], v)).toBe(0);
    expect(portalVolumeDistance([0, 1.2, 2.75], v)).toBeCloseTo(2);
    expect(portalVolumeForCorridor(3)).toEqual({ halfExtents: [1.5, 1.3, 0.75], offset: [0, 1.3, 0] });
    expect(portalVolumeForCorridor(0).halfExtents[0]).toBe(1.2);
  });
});
