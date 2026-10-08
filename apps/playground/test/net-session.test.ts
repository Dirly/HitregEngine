import { test } from "node:test";
import assert from "node:assert/strict";
import type { SceneDoc } from "@hitreg/core";
import {
  connectionView,
  INITIAL_LINK,
  linkAfter,
  movementIntent,
  NetRuntimeWorld,
  NET_NUDGE_DIST,
  NET_SHIFT_TRUST,
  NET_SNAP_DIST,
  planSuspension,
  reconcileCorrection,
  reconcileShift,
  redialDelayMs,
  resolveNetEndpoint,
  savePendingGrant,
  stripServerPlayers,
  takePendingGrant,
  type NetTransfer,
  type ServerLink,
} from "../src/net-session.js";

type Entity = SceneDoc["entities"][string];
const ent = (parent: string | null, tags: string[] = []): Entity => ({ name: "e", parent, tags, components: {} }) as Entity;
const store = (entries: Record<string, string> = {}) => {
  const m = new Map(Object.entries(entries));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    map: m,
  };
};

// -- where to connect ---------------------------------------------------------------------

test("dev order: ?gateway, stored gateway, ?server, stored server — unchanged from main.ts", () => {
  const q = (s: string) => new URLSearchParams(s);
  assert.deepEqual(resolveNetEndpoint({ host: "dev", query: q("gateway=http://a:8780/&server=ws://b") }), { kind: "gateway", url: "http://a:8780", source: "?gateway" });
  assert.equal(resolveNetEndpoint({ host: "dev", query: q("server=ws://b"), storage: store({ "hitreg:gateway": "http://g" }) }).kind, "gateway");
  assert.deepEqual(resolveNetEndpoint({ host: "dev", query: q("server=ws://b:8790") }), { kind: "server", url: "ws://b:8790", source: "?server" });
  assert.deepEqual(resolveNetEndpoint({ host: "dev", query: q(""), storage: store({ "hitreg:server": "ws://s" }) }), { kind: "server", url: "ws://s", source: "localStorage" });
  assert.equal(resolveNetEndpoint({ host: "dev", query: q("") }).kind, "none");
  // private mode: a storage that throws is no storage
  const throwing = { getItem: () => { throw new Error("denied"); } };
  assert.equal(resolveNetEndpoint({ host: "dev", query: q(""), storage: throwing }).kind, "none");
});

test("published order: only server projects; query, then manifest, then the page origin; never localStorage", () => {
  const q = (s: string) => new URLSearchParams(s);
  const base = { host: "published" as const, origin: "https://play.example.org" };
  // not a server project: plays alone whatever the query says
  assert.equal(resolveNetEndpoint({ ...base, query: q("gateway=http://x"), mode: "p2p" }).kind, "none");
  assert.equal(resolveNetEndpoint({ ...base, query: q(""), mode: "solo" }).kind, "none");
  const server = { ...base, mode: "server" as const, manifest: { gateway: "https://gw.example.org/", server: "wss://open:8801" } };
  assert.deepEqual(resolveNetEndpoint({ ...server, query: q("gateway=http://override:8780") }), { kind: "gateway", url: "http://override:8780", source: "?gateway" });
  assert.deepEqual(resolveNetEndpoint({ ...server, query: q("server=ws://lan:8790") }), { kind: "server", url: "ws://lan:8790", source: "?server" });
  assert.deepEqual(resolveNetEndpoint({ ...server, query: q("") }), { kind: "gateway", url: "https://gw.example.org", source: "manifest" });
  assert.deepEqual(resolveNetEndpoint({ ...server, manifest: { server: "wss://open:8801" }, query: q("") }), { kind: "server", url: "wss://open:8801", source: "manifest" });
  assert.deepEqual(resolveNetEndpoint({ ...base, mode: "server", query: q("") }), { kind: "gateway", url: "https://play.example.org", source: "page origin" });
  // a file:// page has no origin to fall back to
  assert.equal(resolveNetEndpoint({ host: "published", mode: "server", origin: "null", query: q("") }).kind, "none");
  // a stored dev gateway is ignored by a shipped bundle
  assert.equal(resolveNetEndpoint({ host: "published", mode: "server", query: q(""), storage: store({ "hitreg:gateway": "http://dev" }) }).kind, "none");
});

// -- what the server owns -------------------------------------------------------------------

test("stripServerPlayers drops every player-tagged root and its whole subtree, nothing else", () => {
  const doc = { name: "s", entities: { p: ent(null, ["player"]), arm: ent("p"), sword: ent("arm"), npc: ent(null, ["npc"]), cam: ent(null), nested: ent("npc", ["player"]) } } as unknown as SceneDoc;
  stripServerPlayers(doc);
  assert.deepEqual(Object.keys(doc.entities).sort(), ["cam", "nested", "npc"]);
});

// -- the world module -------------------------------------------------------------------------

test("NetRuntimeWorld: spawn builds fresh ids once, knows our subtree, despawn clears self", () => {
  const calls: string[] = [];
  let transfer: NetTransfer | null = null;
  const world = new NetRuntimeWorld({
    build: (docs) => calls.push(`build:${Object.keys(docs).join(",")}`),
    attach: (ids) => calls.push(`attach:${ids.join(",")}`),
    despawn: (ids) => calls.push(`despawn:${ids.join(",")}`),
    onSelf: (id) => calls.push(`self:${id}`),
    onRecipe: (id) => calls.push(`recipe:${id}`),
    onTransfer: (t) => (transfer = t),
  });
  world.handle({ t: "spawn", entities: { "player:a": ent(null, ["player"]), "player:a/model": ent("player:a"), "player:b": ent(null, ["player"]) }, self: "player:a" });
  world.handle({ t: "spawn", entities: { "player:a": ent(null) } }); // a duplicate is not rebuilt
  assert.deepEqual(calls, ["build:player:a,player:a/model,player:b", "attach:player:a,player:a/model,player:b", "self:player:a"]);
  assert.deepEqual([...world.ownSubtree()].sort(), ["player:a", "player:a/model"]);
  assert.equal(world.isForeign("player:b"), true);
  assert.equal(world.isForeign("player:a/model"), false);
  assert.equal(world.isForeign("scene-npc"), false); // the scene's own creatures are not foreign
  world.handle({ t: "recipe", id: "mmo", recipe: { regions: [] } });
  world.handle({ t: "transfer", url: "ws://h:8802", ticket: "tk", reason: "portal:enter", srv: "inst-1", scene: "crypt" });
  assert.deepEqual(transfer, { url: "ws://h:8802", ticket: "tk", reason: "portal:enter", srv: "inst-1", scene: "crypt" });
  world.handle({ t: "transfer", url: 5 }); // malformed: ignored
  world.handle({ t: "despawn", ids: ["player:a", "nope", 3] });
  assert.equal(world.selfId, null);
  assert.ok(calls.includes("despawn:player:a") && calls.includes("recipe:mmo"));
  world.clear();
  assert.equal(world.docs.size, 0);
  assert.equal(calls.at(-1), "despawn:player:a/model,player:b");
  world.handle(null);
  world.handle("junk");
});

test("planSuspension: managed ids suspend, released ones resume, another player's subtree never resumes", () => {
  const foreign = new Set(["player:b", "player:b/caster"]);
  const r = planSuspension(["npc1", "player:b"], new Set(["npc2", "player:b/caster"]), (id) => foreign.has(id));
  assert.deepEqual(r.toSuspend, ["npc1", "player:b"]);
  assert.deepEqual(r.toResume, ["npc2"]);
  assert.deepEqual([...r.next].sort(), ["npc1", "player:b", "player:b/caster"]);
  // teardown ([]) hands everything local back except foreign subtrees
  const off = planSuspension([], r.next, (id) => foreign.has(id));
  assert.deepEqual(off.toResume, ["npc1"]);
});

// -- intent and reconciliation -------------------------------------------------------------------

test("movementIntent mirrors the controller: camera-relative, speed, swim, lunge, dive keys", () => {
  const keys = (...down: string[]) => (code: string) => down.includes(code);
  assert.deepEqual(movementIntent(keys("KeyW"), [0, 1], {}, undefined), { v: [0, 6.5], jump: false, vy: 0 });
  const diag = movementIntent(keys("KeyW", "KeyD"), [0, 1], { speedMult: 0.5 }, { speed: 4 });
  assert.ok(Math.abs(Math.hypot(...diag.v) - 2) < 1e-9);
  assert.deepEqual(movementIntent(keys("KeyW"), [0, 1], { frozen: true }, undefined).v, [0, 0]);
  assert.deepEqual(movementIntent(keys("Space"), [1, 0], { swimming: "swimming", swimVelocity: [1, -2, 3] }, undefined), { v: [1, 3], jump: true, vy: -2 });
  assert.deepEqual(movementIntent(keys(), [1, 0], { advanceVel: [0.5, 0.25] }, undefined).v, [0.5, 0.25]);
  assert.equal(movementIntent(keys("KeyQ"), [1, 0], {}, { swimDownKey: "KeyQ" }).vy, -1);
  // on land the controller's own decision wins: a sprint (or a walk, a strafe slow-down) is sent as it is, lunge on top
  assert.deepEqual(movementIntent(keys("KeyW", "ShiftLeft"), [0, 1], { moveVelocity: [0, 9.5] }, undefined), { v: [0, 9.5], jump: false, vy: 0 });
  assert.deepEqual(movementIntent(keys(), [0, 1], { moveVelocity: [1, 2], advanceVel: [0.5, 0.25] }, undefined).v, [1.5, 2.25]);
  // frozen and swimming still come first
  assert.deepEqual(movementIntent(keys("KeyW"), [0, 1], { frozen: true, moveVelocity: [0, 9.5] }, undefined).v, [0, 0]);
  assert.deepEqual(movementIntent(keys(), [1, 0], { swimming: "swimming", swimVelocity: [1, -2, 3], moveVelocity: [9, 9] }, undefined).v, [1, 3]);
});

test("reconcileShift: the gap is measured where the authority describes, the same shift applied to now", () => {
  // ran ahead 3 m since; the authority agrees with where we were then -> nothing
  assert.equal(reconcileShift([3, 0, 0], [0, 0, 0], [0.3, 0, 0]).kind, "none");
  // 2 m off back then: nudge now by a fifth of it, keeping the motion since
  const n = reconcileShift([3, 0, 0], [0, 0, 0], [2, 0, 0]);
  assert.equal(n.kind, "nudge");
  assert.ok(Math.abs(n.to[0] - 3.4) < 1e-9);
  const snap = reconcileShift([3, 0, 0], [0, 0, 0], [NET_SNAP_DIST + 1, 0, 0]);
  assert.equal(snap.kind, "snap");
  assert.ok(Math.abs(snap.to[0] - (3 + NET_SNAP_DIST + 1)) < 1e-9);
});

test("reconcileShift: a 'then' far from the present is not trusted; the present is judged outright", () => {
  // a logged moment half a map away (another frame of reference): a shift built on it would throw the body
  // 500 m off; judged against the present instead it snaps onto the authority, once
  const far = reconcileShift([10, 0, 0], [-500, 0, 0], [11, 0, 0]);
  assert.equal(far.kind, "none");
  const snap = reconcileShift([10, 0, 0], [10 - NET_SHIFT_TRUST - 1, 0, 0], [20, 0, 0]);
  assert.equal(snap.kind, "snap");
  assert.deepEqual(snap.to, [20, 0, 0]);
});

test("reconcileCorrection: dead-band, nudge a fifth of the way, snap past the limit", () => {
  assert.deepEqual(reconcileCorrection([0, 0, 0], [NET_NUDGE_DIST * 0.9, 0, 0]), { kind: "none" });
  const nudge = reconcileCorrection([0, 0, 0], [2, 0, 0]);
  assert.equal(nudge.kind, "nudge");
  assert.ok(nudge.kind === "nudge" && Math.abs(nudge.to[0] - 0.4) < 1e-9);
  assert.deepEqual(reconcileCorrection([0, 0, 0], [0, NET_SNAP_DIST + 1, 0]), { kind: "snap", to: [0, NET_SNAP_DIST + 1, 0] });
});

// -- the link and what the player sees ---------------------------------------------------------

test("linkAfter: refused never re-dials; a lost link backs off; a welcome resets", () => {
  let l: ServerLink = linkAfter(INITIAL_LINK, { kind: "rehome", url: "ws://h:8801" });
  l = linkAfter(l, { kind: "dial", url: "ws://h:8801" });
  l = linkAfter(l, { kind: "closed", reason: "could not reach the server", now: 1000 });
  assert.equal(l.phase, "retrying");
  assert.equal(l.failures, 1);
  assert.equal(l.retryAt, 1000 + redialDelayMs(1));
  assert.equal(l.everConnected, false);
  l = linkAfter(linkAfter(l, { kind: "dial", url: "ws://h:8801" }), { kind: "closed", now: 5000 });
  assert.equal(l.failures, 2);
  l = linkAfter(linkAfter(l, { kind: "dial", url: "ws://h:8801" }), { kind: "welcome" });
  assert.equal(l.phase, "connected");
  assert.equal(l.failures, 0);
  assert.equal(l.everConnected, true);
  const lost = linkAfter(l, { kind: "closed", reason: "connection lost", now: 9000 });
  assert.equal(lost.failures, 1);
  const refused = linkAfter(linkAfter(lost, { kind: "dial", url: "ws://h:8801" }), { kind: "refused", reason: "ticket expired" });
  assert.equal(refused.phase, "refused");
  assert.equal(linkAfter(refused, { kind: "closed", now: 1 }), refused); // the close after a refusal
  assert.equal(linkAfter(refused, { kind: "rehome", url: "ws://h:8802" }).phase, "idle");
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(redialDelayMs), [1000, 2000, 4000, 8000, 10000, 10000]);
});

test("connectionView: a clear state and a way out for every failure", () => {
  const ctx = { wanted: true, hasSelf: false, gateway: true, transferring: null, now: 0 };
  assert.equal(connectionView(INITIAL_LINK, { ...ctx, wanted: false }).show, false);
  const dialing = connectionView({ ...INITIAL_LINK, phase: "dialing", url: "ws://h" }, ctx);
  assert.equal(dialing.title, "Connecting to the server…");
  assert.deepEqual(dialing.actions, []);
  const never = connectionView({ ...INITIAL_LINK, phase: "retrying", failures: 2, retryAt: 3500, reason: "could not reach the server" }, ctx);
  assert.equal(never.title, "Cannot reach the server");
  assert.match(never.detail, /in 4 s \(attempt 3\)/);
  assert.deepEqual(never.actions, ["retry", "signin"]);
  const lost = connectionView({ ...INITIAL_LINK, phase: "retrying", failures: 1, retryAt: 0, everConnected: true }, { ...ctx, gateway: false });
  assert.equal(lost.title, "Connection to the server lost");
  assert.deepEqual(lost.actions, ["retry"]);
  const refused = connectionView({ ...INITIAL_LINK, phase: "refused", reason: "ticket expired" }, ctx);
  assert.deepEqual(refused.actions, ["rejoin", "signin"]);
  assert.match(refused.detail, /ticket expired/);
  assert.deepEqual(connectionView({ ...INITIAL_LINK, phase: "refused", reason: "full" }, { ...ctx, gateway: false }).actions, ["retry"]);
  assert.equal(connectionView({ ...INITIAL_LINK, phase: "connected" }, ctx).title, "Entering the world…");
  assert.equal(connectionView({ ...INITIAL_LINK, phase: "connected" }, { ...ctx, hasSelf: true }).show, false);
  assert.equal(connectionView({ ...INITIAL_LINK, phase: "idle" }, { ...ctx, transferring: "layer-2" }).title, "Travelling to layer-2…");
});

test("pending grant survives a reload once, and only while its ticket is young", () => {
  const s = store();
  assert.equal(savePendingGrant(s, { scene: "crypt" }, { id: "c1" }, 1000), true);
  assert.deepEqual(takePendingGrant(s, 2000)?.grant, { scene: "crypt" });
  assert.equal(takePendingGrant(s, 2000), null); // taken
  savePendingGrant(s, { scene: "crypt" }, { id: "c1" }, 1000);
  assert.equal(takePendingGrant(s, 1000 + 120_000), null); // too old for its ticket
  assert.equal(takePendingGrant(null), null);
  s.map.set("hitreg:pending-grant", "{broken");
  assert.equal(takePendingGrant(s), null);
});
