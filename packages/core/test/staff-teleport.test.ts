import { describe, expect, it } from "vitest";
import { EventRegistry, registerCoreEvents, STAFF_TELEPORT_EVENT, staffTeleportRefusal } from "../src/index.js";

const store = (values: Record<string, unknown>) => ({ get: (key: string) => values[key] });

describe("staff.teleport request gate", () => {
  const state = store({ "owner/body-a": "peer-a", "owner/body-b": "peer-b", "staff/peer-a": "dev", "staff/peer-c": "gm" });

  it("honours a staff peer moving its own body, and a local emission", () => {
    expect(staffTeleportRefusal(state, "peer-a", "body-a")).toBeNull();
    expect(staffTeleportRefusal(state, undefined, "body-b")).toBeNull();
  });

  it("refuses a player, and a staff peer moving someone else's body", () => {
    expect(staffTeleportRefusal(state, "peer-b", "body-b")).toMatch(/Only staff/);
    expect(staffTeleportRefusal(state, "peer-c", "body-a")).toMatch(/not your character/);
  });

  it("is a to-authority request in the core registry", () => {
    const events = new EventRegistry();
    registerCoreEvents(events);
    expect(events.has(STAFF_TELEPORT_EVENT)).toBe(true);
    expect(events.replicationOf(STAFF_TELEPORT_EVENT)).toBe("to-authority");
  });
});
