import { afterEach, describe, expect, it, vi } from "vitest";
import { NetStateStore } from "@hitreg/core";
import { COMMS_NETSTATE, isValidGroupName, netStateMembership, registerCommsNetState } from "../src/index.js";

afterEach(() => vi.restoreAllMocks());

describe("netState membership", () => {
  it("reads team/party from the replicated store and validates names", () => {
    const store = new NetStateStore();
    registerCommsNetState(store);
    const m = netStateMembership(store);
    const changes: string[] = [];
    m.onChange(() => changes.push("x"));

    expect(m.teamOf("p1")).toBeNull();
    expect(store.set(`${COMMS_NETSTATE.team}/p1`, "red")).toBe(true);
    expect(store.set(`${COMMS_NETSTATE.party}/p1`, "the crew")).toBe(true);
    expect(m.teamOf("p1")).toBe("red");
    expect(m.partyOf("p1")).toBe("the crew");
    expect(changes).toHaveLength(2);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(store.set(`${COMMS_NETSTATE.team}/p1`, "")).toBe(false); // rejected by schema
    expect(store.set(`${COMMS_NETSTATE.team}/p1`, "<script>")).toBe(false);
    expect(warn).toHaveBeenCalled();
    expect(m.teamOf("p1")).toBe("red");

    // unrelated keys don't fire membership change
    store.set("score/p1", 3);
    expect(changes).toHaveLength(2);

    // peers see replicated values the same way
    const replica = new NetStateStore();
    registerCommsNetState(replica);
    replica.setAuthority(false);
    replica.applyRemote({ full: store.snapshot() });
    expect(netStateMembership(replica).teamOf("p1")).toBe("red");
  });

  it("exposes the namespaces in the spec", () => {
    const store = new NetStateStore();
    registerCommsNetState(store);
    expect(Object.keys(store.jsonSchemas()).sort()).toEqual(["comms.party", "comms.team"]);
  });

  it("isValidGroupName", () => {
    expect(isValidGroupName("red")).toBe(true);
    expect(isValidGroupName("Team 1_a-b")).toBe(true);
    expect(isValidGroupName("")).toBe(false);
    expect(isValidGroupName(" leading")).toBe(false);
    expect(isValidGroupName("x".repeat(33))).toBe(false);
    expect(isValidGroupName(7)).toBe(false);
  });
});
