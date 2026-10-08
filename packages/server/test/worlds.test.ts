import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryPlayerDataBackend, createSheet } from "@hitreg/core";
import { startMain, type MainHandle } from "../src/main/main.js";
import { MemoryAccountStore, type AccountRecord } from "../src/persistence/accounts.js";
import { signSession } from "../src/cluster/ticket.js";
import { PlayerStore } from "../src/cluster/player-store.js";

const secret = "world-selection-test";
const accounts = new MemoryAccountStore();
const data = new MemoryPlayerDataBackend();
let alpha: MainHandle, beta: MainHandle;
const others: Array<{ id: string; name: string; url: string }> = [];
async function call(main: MainHandle, route: string, token?: string, body?: unknown, method?: string) {
  const response = await fetch(main.url + route, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, json: await response.json() };
}
async function register(name: string) { return (await call(alpha, "/auth/register", undefined, { name, password: "hunter22" })).json; }

beforeAll(async () => {
  const common = { port: 0, host: "127.0.0.1", secret, accounts, playerData: data, experienceId: "shared-game", supervisor: null, scaleEverySeconds: 3600, log: () => undefined } as const;
  alpha = await startMain({ ...common, world: { id: "alpha-world", scene: "empty", min: 0, max: 0, others } });
  beta = await startMain({ ...common, world: { id: "beta", name: "Beta", scene: "empty", min: 0, max: 0 } });
  others.push({ id: "beta", name: "Beta", url: beta.url });
});
afterAll(async () => { await alpha?.close(); await beta?.close(); });

describe("world-bound characters", () => {
  it("refuses a stale account write instead of replacing a newer world roster", async () => {
    const session = await register("StaleWriter");
    const expected = (await accounts.get(session.account.id))!;
    const first = structuredClone(expected);
    first.characters.push({ id: "chr-first", name: "First", createdAt: "2026-10-08", world: "alpha-world" });
    const stale = structuredClone(expected);
    stale.characters.push({ id: "chr-stale", name: "Stale", createdAt: "2026-10-08", world: "beta" });
    expect(await accounts.update(first, expected)).toBe(true);
    expect(await accounts.update(stale, expected)).toBe(false);
    expect((await accounts.get(session.account.id))!.characters.map(c => c.id)).toEqual(["chr-first"]);
  });
  it("lists worlds and scopes playable/deleted rosters and character actions to the serving world", async () => {
    expect((await call(alpha, "/worlds")).status).toBe(401);
    const session = await register("WorldWalker");
    expect(session.world).toEqual({ id: "alpha-world", name: "Alpha World" });
    const a = (await call(alpha, "/characters", session.session, { name: "Aldric" })).json.character;
    expect(a.world).toBe("alpha-world"); expect(a.saveId).toBe(a.id);
    expect((await call(alpha, "/characters", session.session, { name: "Aldra" })).status).toBe(409);
    const b = (await call(beta, "/characters", session.session, { name: "Berina" })).json.character;
    expect(b.world).toBe("beta"); expect(b.saveId).not.toBe(a.saveId);
    expect((await call(alpha, "/characters", session.session)).json.characters.map((c: any) => c.id)).toEqual([a.id]);
    expect((await call(beta, "/characters", session.session)).json.characters.map((c: any) => c.id)).toEqual([b.id]);
    const worlds = (await call(alpha, "/worlds", session.session)).json;
    expect(worlds.worlds.map((w: any) => w.character.name)).toEqual(["Aldric", "Berina"]);
    expect(worlds.worlds[1].url).toBe(beta.url);
    expect((await call(alpha, "/play", session.session, { characterId: b.id })).status).toBe(409);
    expect((await call(alpha, `/characters/${b.id}`, session.session, { confirm: b.name }, "DELETE")).status).toBe(409);
    expect((await call(beta, `/characters/${b.id}`, session.session, { confirm: b.name }, "DELETE")).status).toBe(200);
    expect((await call(alpha, `/characters/${b.id}/restore`, session.session, {})).status).toBe(409);
    const replacement = (await call(beta, "/characters", session.session, { name: "Brynn" })).json.character;
    expect((await call(beta, `/characters/${b.id}/restore`, session.session, {})).status).toBe(409);
    const saves = new PlayerStore(data, "shared-game");
    await saves.commit(a.saveId, { sheet: createSheet(undefined, 7), scene: "empty", position: [1, 2, 3], yaw: 0 });
    await saves.commit(b.saveId, { sheet: createSheet(undefined, 2), scene: "empty", position: [9, 2, 3], yaw: 1 });
    expect((await saves.load(a.saveId, "empty")).sheet).toMatchObject({ level: 7 });
    expect((await saves.load(b.saveId, "empty")).sheet).toMatchObject({ level: 2 });
    expect((await saves.load(replacement.saveId, "empty")).sheet).toBeNull();
  });
  it("permanently binds a legacy character on first authenticated access and preserves its account save", async () => {
    const account: AccountRecord = { id: "acct-legacy", name: "Legacy", nameLower: "legacy", salt: "", hash: "", createdAt: "2026-01-01", characters: [{ id: "chr-legacy", name: "Eldric", createdAt: "2026-01-01" }] };
    await accounts.create(account);
    const token = signSession(secret, account.id);
    const roster = (await call(alpha, "/characters", token)).json;
    expect(roster.characters[0]).toMatchObject({ world: "alpha-world", saveId: account.id });
    expect((await accounts.get(account.id))!.characters[0]!.world).toBe("alpha-world");
    expect((await call(beta, "/characters", token)).json.characters).toEqual([]);
    expect((await call(beta, "/play", token, { characterId: "chr-legacy" })).status).toBe(409);
  });
  it("never overwrites another world's roster during concurrent character creation", async () => {
    const session = await register("Concurrent");
    const outcomes = await Promise.all([call(alpha, "/characters", session.session, { name: "Caldrin" }), call(beta, "/characters", session.session, { name: "Darien" })]);
    expect(outcomes.filter(r => r.status === 200).length).toBeGreaterThanOrEqual(1);
    expect(outcomes.every(r => r.status === 200 || r.status === 409)).toBe(true);
    for (const [index, result] of outcomes.entries()) {
      if (result.status === 409) expect((await call(index === 0 ? alpha : beta, "/characters", session.session, { name: index === 0 ? "Caldrin" : "Darien" })).status).toBe(200);
    }
    expect((await accounts.get(session.account.id))!.characters).toHaveLength(2);
    const sameWorld = await register("TwinClicks");
    const duplicates = await Promise.all([call(alpha, "/characters", sameWorld.session, { name: "Edrin" }), call(alpha, "/characters", sameWorld.session, { name: "Farin" })]);
    expect(duplicates.map(r => r.status).sort()).toEqual([200, 409]);
    expect((await accounts.get(sameWorld.account.id))!.characters).toHaveLength(1);
  });
});
