import { describe, expect, it } from "vitest";
import {
  NetStateStore,
  creditedBody,
  petKey,
  petOwner,
  petsOf,
  readPet,
  readTarget,
  registerCharacterNetState,
  resolveSupportTarget,
  sameTarget,
  targetKey,
  withTarget,
} from "../src/index.js";

describe("target/<id>: primary enemy, secondary friend", () => {
  it("merges a change: undefined keeps, null clears, a cleared primary drops `manual`", () => {
    const a = withTarget({}, { primary: "wolf", manual: true });
    expect(a).toEqual({ primary: "wolf", manual: true });
    const b = withTarget(a, { secondary: "tank" });
    expect(b).toEqual({ primary: "wolf", manual: true, secondary: "tank" });
    const c = withTarget(b, { primary: null });
    expect(c).toEqual({ secondary: "tank" });
    expect(withTarget(c, { secondary: null })).toEqual({});
    expect(sameTarget(b, { secondary: "tank", primary: "wolf", manual: true })).toBe(true);
    expect(sameTarget(b, c)).toBe(false);
  });

  it("validates on write and reads junk as none", () => {
    const store = new NetStateStore();
    registerCharacterNetState(store);
    expect(store.set(targetKey("me"), { primary: "wolf", secondary: "tank" })).toBe(true);
    expect(readTarget(store, "me")).toEqual({ primary: "wolf", secondary: "tank" });
    expect(store.set(targetKey("me"), { primary: 7 })).toBe(false);
    expect(readTarget(store, "nobody")).toEqual({});
  });
});

describe("resolveSupportTarget: where support goes unaimed", () => {
  const friends = new Set(["tank", "healer", "rogue", "me"]);
  const usable = (id: string): boolean => friends.has(id);
  const hp: Record<string, number> = { tank: 0.4, healer: 0.9, rogue: 0.2, me: 1 };
  const base = { self: "me", usable, party: ["me", "tank", "healer", "rogue"], health: (id: string) => hp[id] ?? 1 };

  it("asked-for friend, then the chosen secondary, then the enemy's target, then the most hurt, then self", () => {
    expect(resolveSupportTarget({ ...base, requested: "healer", secondary: "tank", enemyTarget: "rogue" })).toBe("healer");
    expect(resolveSupportTarget({ ...base, requested: "goblin", secondary: "tank", enemyTarget: "rogue" })).toBe("tank");
    expect(resolveSupportTarget({ ...base, enemyTarget: "tank" })).toBe("tank");
    // the enemy is on a foe (or nobody): the most hurt party member
    expect(resolveSupportTarget({ ...base, enemyTarget: "goblin" })).toBe("rogue");
    expect(resolveSupportTarget({ self: "me", usable })).toBe("me");
    // nobody hurt: yourself
    expect(resolveSupportTarget({ ...base, health: () => 1 })).toBe("me");
  });
});

describe("pet/<id>: whose, which, credit", () => {
  it("records owner and stance; pets of an owner; credit goes to the owner", () => {
    const store = new NetStateStore();
    registerCharacterNetState(store);
    expect(store.set(petKey("wolf-1"), { owner: "ana", source: "summonWolf", role: "damage" })).toBe(true);
    store.set(petKey("bear-1"), { owner: "ana", source: "summonBear", stance: "defend" });
    store.set(petKey("wolf-2"), { owner: "bo", source: "summonWolf" });
    expect(readPet(store, "wolf-1")).toMatchObject({ owner: "ana", stance: "assist", order: "follow" });
    expect(readPet(store, "bear-1")?.stance).toBe("defend");
    expect(readPet(store, "ana")).toBeNull();
    expect(petOwner(store, "wolf-2")).toBe("bo");
    expect(petsOf(store, "ana").sort()).toEqual(["bear-1", "wolf-1"]);
    expect(creditedBody(store, "wolf-1")).toBe("ana");
    expect(creditedBody(store, "ana")).toBe("ana");
    expect(store.set(petKey("x"), { owner: "ana", source: "s", stance: "berserk" })).toBe(false);
  });
});
