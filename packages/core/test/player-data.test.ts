import { describe, expect, it } from "vitest";
import {
  MemoryPlayerDataBackend,
  PlayerDataError,
  PlayerDataService,
  type PlayerDataBackend,
  type PlayerDataRecord,
  type PlayerDataScope,
} from "../src/index.js";

const scope: PlayerDataScope = { playerId: "player_01", experienceId: "exp_forest" };

function service(
  backend: PlayerDataBackend = new MemoryPlayerDataBackend(),
  limits = {},
  now?: () => number,
) {
  return new PlayerDataService(backend, scope, limits, now);
}

describe("PlayerDataService", () => {
  it("set/get roundtrip with revision bumps", async () => {
    const backend = new MemoryPlayerDataBackend();
    const pd = service(backend);
    await pd.set("primary", "wood", 42);
    await pd.set("primary", "stone", 18);
    expect(await pd.get("primary", "wood")).toBe(42);
    expect(await pd.keys("primary")).toEqual(["wood", "stone"]);
    const stored = await backend.load(scope, "primary");
    expect(stored!.revision).toBe(1); // two writes: rev 0 then 1
    expect(stored!.schemaVersion).toBe(1);
  });

  it("namespaces are isolated per scope and name", async () => {
    const backend = new MemoryPlayerDataBackend();
    const pd = service(backend);
    await pd.set("save-a", "level", 3);
    expect(await pd.get("save-b", "level")).toBeUndefined();
    const other = new PlayerDataService(backend, { ...scope, playerId: "player_02" });
    expect(await other.get("save-a", "level")).toBeUndefined();
  });

  it("increment starts at 0 and returns the new value", async () => {
    const pd = service();
    expect(await pd.increment("stats", "kills")).toBe(1);
    expect(await pd.increment("stats", "kills", 4)).toBe(5);
    expect(await pd.get("stats", "kills")).toBe(5);
  });

  it("transaction retries on conflicting concurrent writes", async () => {
    const backend = new MemoryPlayerDataBackend();
    const a = service(backend);
    const b = service(backend);
    await a.set("shared", "n", 0);
    // interleave: both read rev 0; CAS makes the loser retry and converge
    await Promise.all([a.increment("shared", "n"), b.increment("shared", "n")]);
    expect(await service(backend).get("shared", "n")).toBe(2);
  });

  it("gives up after maxRetries when the backend always conflicts", async () => {
    const conflictBackend: PlayerDataBackend = {
      load: () => Promise.resolve(null),
      store: () => Promise.resolve("conflict"),
    };
    const pd = service(conflictBackend, { maxRetries: 2 });
    await expect(pd.set("primary", "k", 1)).rejects.toMatchObject({ code: "conflict" });
  });

  it("enforces the size quota", async () => {
    const pd = service(undefined, { quotaBytes: 64 });
    await expect(pd.set("primary", "blob", "x".repeat(200))).rejects.toMatchObject({
      code: "quota",
    });
    // and nothing was persisted
    expect(await pd.get("primary", "blob")).toBeUndefined();
  });

  it("rate-limits writes with a refilling token bucket", async () => {
    let clock = 0;
    const pd = service(undefined, { writesPerMinute: 2 }, () => clock);
    await pd.set("primary", "a", 1);
    await pd.set("primary", "b", 2);
    await expect(pd.set("primary", "c", 3)).rejects.toMatchObject({ code: "rate-limit" });
    clock += 60_000; // a minute later the bucket refills
    await pd.set("primary", "c", 3);
    expect(await pd.get("primary", "c")).toBe(3);
  });

  it("rejects invalid namespaces and malformed stored records", async () => {
    const pd = service();
    await expect(pd.get("Bad Namespace!", "k")).rejects.toMatchObject({ code: "invalid" });
    const badBackend: PlayerDataBackend = {
      load: () =>
        Promise.resolve({ nope: true } as unknown as PlayerDataRecord),
      store: () => Promise.resolve("ok"),
    };
    await expect(service(badBackend).get("primary", "k")).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("transaction draft mutations are isolated until commit", async () => {
    const pd = service();
    await pd.set("primary", "inventory", { wood: 1 });
    await expect(
      pd.transaction("primary", () => {
        throw new PlayerDataError("invalid", "abort");
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(await pd.get("primary", "inventory")).toEqual({ wood: 1 });
  });
});
