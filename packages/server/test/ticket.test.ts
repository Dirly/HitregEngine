import { describe, expect, it } from "vitest";
import { signSession, signTicket, verifySession, verifyTicket } from "../src/cluster/ticket.js";
import { ServerRegistry } from "../src/main/registry.js";

describe("tickets", () => {
  const secret = "s3cret";
  it("round-trips claims and binds to a server", () => {
    const t = signTicket(secret, { sub: "acct-1", chr: "chr-1", name: "Ann", srv: "layer-1", rev: { character: 4 }, reason: "join", now: 1000, ttlSeconds: 60 });
    const v = verifyTicket(secret, t, { srv: "layer-1", now: 1030 });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.claims.sub).toBe("acct-1");
      expect(v.claims.chr).toBe("chr-1");
      expect(v.claims.rev).toEqual({ character: 4 });
      expect(v.claims.exp).toBe(1060);
    }
    expect(verifyTicket(secret, t, { srv: "layer-2", now: 1030 })).toEqual({ ok: false, reason: "ticket is for another server" });
    expect(verifyTicket(secret, t, { srv: "layer-1", now: 1061 })).toEqual({ ok: false, reason: "ticket expired" });
    expect(verifyTicket("other", t, { srv: "layer-1", now: 1030 })).toEqual({ ok: false, reason: "bad ticket signature" });
  });

  it("rejects tampering and garbage", () => {
    const t = signTicket(secret, { sub: "acct-1", chr: "chr-1", name: "Ann", srv: "layer-1", now: 1000 });
    const [body, sig] = t.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), chr: "chr-2" })).toString("base64url");
    expect(verifyTicket(secret, `${forged}.${sig}`, { srv: "layer-1", now: 1001 }).ok).toBe(false);
    expect(verifyTicket(secret, "nonsense", { srv: "layer-1" }).ok).toBe(false);
    expect(verifyTicket(secret, "", { srv: "layer-1" }).ok).toBe(false);
  });

  it("sessions are tickets for the gateway", () => {
    const s = signSession(secret, "acct-9", 3600, 5000);
    expect(verifySession(secret, s, 5100)).toEqual({ ok: true, sub: "acct-9" });
    expect(verifySession(secret, s, 9000).ok).toBe(false);
    // a session is not a play ticket for a layer
    expect(verifyTicket(secret, s, { srv: "layer-1", now: 5100 }).ok).toBe(false);
  });
});

describe("placement", () => {
  const presence = (id: string) => ({ characterId: id, playerId: `acct-${id}`, name: id, position: null });

  it("party first, then affinity, then the fullest layer with room", () => {
    const reg = new ServerRegistry(60_000);
    reg.register({ id: "layer-1", kind: "layer", url: "ws://a", scene: "mmo", cap: 3 }, 1000);
    reg.register({ id: "layer-2", kind: "layer", url: "ws://b", scene: "mmo", cap: 3 }, 2000);
    reg.status("layer-1", [presence("x"), presence("y")], 1, 10, true, 3000);
    reg.status("layer-2", [presence("z")], 1, 10, true, 3000);
    // fullest with room
    expect(reg.place({ scene: "mmo", characterId: "new", now: 3000 })).toMatchObject({ why: "fullest", server: { id: "layer-1" } });
    // party member on layer-2 wins over fullest
    expect(reg.place({ scene: "mmo", characterId: "new", partyMembers: ["new", "z"], now: 3000 })).toMatchObject({ why: "party", server: { id: "layer-2" } });
    // affinity: 'y' leaves layer-1 and comes back
    reg.left("layer-1", "y", 4000);
    expect(reg.place({ scene: "mmo", characterId: "y", now: 5000 })).toMatchObject({ why: "affinity", server: { id: "layer-1" } });
    // affinity expires
    expect(reg.place({ scene: "mmo", characterId: "y", now: 4000 + 61_000 })).toMatchObject({ why: "fullest" });
    // a full layer is skipped, and nothing is placed when every layer is full
    reg.status("layer-1", [presence("x"), presence("y"), presence("w")], 1, 10, true, 6000);
    expect(reg.place({ scene: "mmo", characterId: "new", now: 6000 })).toMatchObject({ server: { id: "layer-2" } });
    reg.status("layer-2", [presence("z"), presence("q"), presence("r")], 1, 10, true, 6000);
    expect(reg.place({ scene: "mmo", characterId: "new", now: 6000 })).toBeNull();
    expect(reg.freeSlots("mmo")).toBe(0);
  });

  it("reservations count against the cap and a draining layer takes nobody", () => {
    const reg = new ServerRegistry();
    reg.register({ id: "layer-1", kind: "layer", url: "ws://a", scene: "mmo", cap: 2 }, 1000);
    reg.reserve("layer-1", "a", "acct-a", "A");
    reg.reserve("layer-1", "b", "acct-b", "B");
    expect(reg.place({ scene: "mmo", characterId: "c" })).toBeNull();
    reg.register({ id: "layer-2", kind: "layer", url: "ws://b", scene: "mmo", cap: 2 }, 2000);
    reg.servers.get("layer-2")!.draining = true;
    expect(reg.place({ scene: "mmo", characterId: "c" })).toBeNull();
    // instances never take overworld placements
    reg.register({ id: "inst-1", kind: "instance", url: "ws://c", scene: "mmo", cap: 5, instanceOf: "party" }, 3000);
    expect(reg.place({ scene: "mmo", characterId: "c" })).toBeNull();
  });

  it("a reservation survives the layer's own status reports and blocks retirement until it expires", () => {
    const reg = new ServerRegistry();
    reg.register({ id: "layer-1", kind: "layer", url: "ws://a", scene: "mmo", cap: 2 }, 1000);
    reg.register({ id: "layer-2", kind: "layer", url: "ws://b", scene: "mmo", cap: 2 }, 2000);
    reg.status("layer-1", [presence("x")], 1, 0, true, 3000); // busy
    reg.status("layer-2", [], 1, 0, true, 3000);
    // a transfer ticket was minted for layer-2; the client is still on its way
    reg.reserve("layer-2", "a", "acct-a", "A", 3000);
    expect(reg.free(reg.servers.get("layer-2")!)).toBe(1);
    // the layer keeps reporting nobody: the slot stays reserved, the layer is not idle
    reg.status("layer-2", [], 1, 0, true, 10_000);
    expect(reg.free(reg.servers.get("layer-2")!)).toBe(1);
    expect(reg.retirable("mmo", 5_000, 1, 20_000)).toBeNull();
    // the character arrives: the reservation becomes a player
    reg.status("layer-2", [presence("a")], 1, 0, true, 21_000);
    expect(reg.free(reg.servers.get("layer-2")!)).toBe(1);
    // a reservation nobody honours expires and the layer becomes retirable again
    reg.reserve("layer-1", "ghost", "acct-g", "G", 30_000);
    reg.status("layer-1", [], 1, 0, true, 31_000);
    expect(reg.retirable("mmo", 5_000, 1, 40_000)).toBeNull();
    reg.status("layer-1", [], 1, 0, true, 80_000);
    expect(reg.retirable("mmo", 5_000, 1, 90_000)?.id).toBe("layer-1");
  });

  it("retires the newest idle layer but never below the minimum", () => {
    const reg = new ServerRegistry();
    reg.register({ id: "layer-1", kind: "layer", url: "ws://a", scene: "mmo", cap: 2 }, 1000);
    reg.register({ id: "layer-2", kind: "layer", url: "ws://b", scene: "mmo", cap: 2 }, 2000);
    reg.status("layer-1", [], 1, 0, true, 3000);
    reg.status("layer-2", [], 1, 0, true, 3000);
    expect(reg.retirable("mmo", 10_000, 1, 5000)).toBeNull(); // not idle long enough
    expect(reg.retirable("mmo", 10_000, 1, 13_001)?.id).toBe("layer-2");
    expect(reg.retirable("mmo", 10_000, 2, 13_001)).toBeNull();
    reg.status("layer-2", [presence("p")], 1, 0, true, 14_000);
    expect(reg.retirable("mmo", 10_000, 1, 30_000)?.id).toBe("layer-1");
  });
});
