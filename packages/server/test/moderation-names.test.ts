import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryPlayerDataBackend } from "@hitreg/core";
import { startMain, type MainHandle } from "../src/main/main.js";
import { MemoryAccountStore } from "../src/persistence/accounts.js";
import { JevJudge, RuleJudge, jevRequest, judgeFromEnv, withDecisionLog, type JudgeQuestion, type ModerationJudge } from "../src/moderation/judge.js";
import { NAME_OPTIONS, NameModeration, foldName, listHit, reservedNamesFromEntities, type NameOption } from "../src/moderation/names.js";

/**
 * Moderation step 1 (docs/moderation.md §1, §5): the name word list with
 * letter-swap folding and whole-word matching, the rule judge, the judge
 * threshold with its review list, the Jev adapter's answer guard, and the
 * check wired into main's POST /characters.
 */

/** A judge that always gives the same answer. */
const fixed = (answer: NameOption, probability: number): ModerationJudge => ({
  async decide<O extends string>(_q: JudgeQuestion<O>) {
    return { answer: answer as unknown as O, probability, model: "fake" };
  },
});

describe("folding", () => {
  it("undoes letter swaps, strips separators and collapses repeats", () => {
    expect(foldName("G.M")).toBe("gm");
    expect(foldName("4dm1n")).toBe("admin");
    expect(foldName("M0d3r4t0r")).toBe("moderator");
    expect(foldName("$y5op")).toBe("sysop");
    expect(foldName("Fuuu-ck")).toBe("fuck");
    expect(foldName("7h3 B@nk")).toBe("thebank");
    expect(foldName("Lll ee", { collapse: false })).toBe("lllee");
  });
});

describe("word list", () => {
  it("refuses staff titles in any disguise", () => {
    for (const n of ["GM Bob", "G M Bob", "Bob the GM", "Admin", "4dm1n", "Xadminx", "Game Master", "Moderat0r", "Dev Steve", "Official"]) {
      expect(listHit(n)?.category, n).toBe("staff");
    }
  });
  it("refuses obscenities, stretched and swapped", () => {
    for (const n of ["Fuuuck", "F u c k", "Ass Kicker", "Big Shit", "Sh1t", "Bitchy"]) {
      expect(listHit(n)?.category, n).toBe("obscene");
    }
  });
  it("lets ordinary names that merely contain a listed word pass", () => {
    for (const n of ["Cassandra", "Bass", "Devon", "Modred", "Gmork", "Ashita", "Hancock", "Grapes", "Dickens", "Nigeria", "Kassim", "Glass", "Supporter"]) {
      expect(listHit(n), n).toBeNull();
    }
  });
  it("reserves the game's own names as whole names only", () => {
    const reserved = ["Wynna Coyle", "Gorrak"];
    expect(listHit("Wynna Coyle", { reserved })?.category).toBe("reserved");
    expect(listHit("wynna-coyle", { reserved })?.category).toBe("reserved");
    expect(listHit("G0rrak", { reserved })?.category).toBe("reserved");
    expect(listHit("Wynna Smith", { reserved })).toBeNull();
    expect(listHit("Gorrakson", { reserved })).toBeNull();
  });
  it("reads reserved names from npc builtins and boss-tagged entities", () => {
    const names = reservedNamesFromEntities([
      { name: "npc-1", tags: [], components: { script: { name: "npc", params: { name: "Wynna Coyle" } } } },
      { name: "Old Harl", tags: [], components: { script: { name: "npc", params: {} } } },
      { name: "Gorrak", tags: ["mob", "boss"], components: {} },
      { name: "rock", tags: [], components: {} },
    ]);
    expect(names.sort()).toEqual(["Gorrak", "Old Harl", "Wynna Coyle"]);
  });
});

describe("RuleJudge", () => {
  const judge = new RuleJudge();
  const ask = <O extends string>(task: JudgeQuestion<O>["task"], options: readonly O[], evidence: unknown) => judge.decide({ task, question: "?", options, evidence });
  it("names: accept or the matching reject, both at 0.99", async () => {
    expect(await ask("name", NAME_OPTIONS, { name: "Cassandra" })).toEqual({ answer: "accept", probability: 0.99, model: "rules" });
    expect((await ask("name", NAME_OPTIONS, { name: "GM Bob" })).answer).toBe("reject_impersonation");
    expect((await ask("name", NAME_OPTIONS, { name: "Fuuuck" })).answer).toBe("reject_offensive");
  });
  it("audits: no_action below three distinct reporters, else escalate", async () => {
    const opts = ["no_action", "warn", "mute_1h", "escalate"] as const;
    expect((await ask("audit", opts, { reports: [{ reporter: "a" }, { reporter: "a" }, { reporter: "b" }] })).answer).toBe("no_action");
    expect((await ask("audit", opts, { reports: [{ reporter: "a" }, { reporter: "b" }, { reporter: "c" }] })).answer).toBe("escalate");
    expect((await ask("audit", opts, {})).answer).toBe("escalate");
  });
  it("item claims: always escalate", async () => {
    expect((await ask("item-claim", ["restore", "deny", "escalate"] as const, { log: [] })).answer).toBe("escalate");
  });
});

describe("name check: judge threshold", () => {
  it("refuses a judge reject above the threshold", async () => {
    const names = new NameModeration({ judge: fixed("reject_real_person", 0.93) });
    const v = await names.check("Some Person");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toBe("That name isn't allowed: it is the name of a real person.");
    expect(names.review).toHaveLength(0);
  });
  it("accepts and queues a judge reject below the threshold", async () => {
    const names = new NameModeration({ judge: fixed("reject_offensive", 0.6) });
    expect(await names.check("Borderline", { accountId: "acct_1" })).toEqual({ ok: true, queued: true });
    expect(names.review[0]).toMatchObject({ name: "Borderline", why: "below_threshold", answer: "reject_offensive", probability: 0.6, accountId: "acct_1" });
  });
  it("honours a configured threshold", async () => {
    const names = new NameModeration({ judge: fixed("reject_other", 0.9), threshold: 0.95 });
    expect((await names.check("Whatever")).ok).toBe(true);
  });
  it("accepts and queues when the judge fails", async () => {
    const names = new NameModeration({
      judge: {
        decide: async () => {
          throw new Error("down");
        },
      },
    });
    expect(await names.check("Aldric")).toEqual({ ok: true, queued: true });
    expect(names.review[0]).toMatchObject({ why: "judge_unavailable", error: "down" });
  });
  it("refuses at the word list without asking the judge", async () => {
    let asked = 0;
    const names = new NameModeration({ judge: { decide: async () => (asked++, { answer: "accept" as never, probability: 1, model: "x" }) } });
    const v = await names.check("GM Bob");
    expect(v).toMatchObject({ ok: false, stage: "list" });
    expect(asked).toBe(0);
  });
  it("logs every decision", async () => {
    const lines: string[] = [];
    const judge = withDecisionLog(fixed("accept", 0.97), (l) => lines.push(l));
    await new NameModeration({ judge }).check("Aldric");
    expect(lines[0]).toMatch(/task=name options=accept\|reject_offensive.*"Aldric".*-> accept p=0\.970 model=fake \d+ms/);
  });
  it("judgeFromEnv picks the rules without a key", async () => {
    const judge = judgeFromEnv({ env: {}, log: () => undefined });
    expect((await judge.decide({ task: "name", question: "?", options: NAME_OPTIONS, evidence: { name: "Aldric" } })).model).toBe("rules");
  });
});

describe("JevJudge", () => {
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const q: JudgeQuestion<NameOption> = { task: "name", question: "ok?", options: NAME_OPTIONS, evidence: { name: "Aldric" } };

  it("sends a choice question and reads the chosen label's probability", async () => {
    let sent: any = null;
    const judge = new JevJudge({
      apiKey: "k",
      fetch: (async (_url: string, init: RequestInit) => {
        sent = { auth: (init.headers as Record<string, string>)["authorization"], body: JSON.parse(String(init.body)) };
        return reply({ model: "jev-1.13.0", answers: { decision: { type: "choice", choice: "accept", probabilities: { accept: 0.91, reject_other: 0.09 }, confidence: 0.8 } } });
      }) as typeof fetch,
    });
    expect(await judge.decide(q)).toEqual({ answer: "accept", probability: 0.91, model: "jev-1.13.0" });
    expect(sent.auth).toBe("Bearer k");
    expect(sent.body).toEqual(jevRequest(q, "jev-latest"));
    expect(Object.keys(sent.body.questions.decision.criteria)).toEqual([...NAME_OPTIONS]);
  });
  it("throws on an answer outside the declared options", async () => {
    const judge = new JevJudge({ apiKey: "k", fetch: (async () => reply({ answers: { decision: { choice: "ban_forever", confidence: 0.99 } } })) as typeof fetch });
    await expect(judge.decide(q)).rejects.toThrow(/not one of the declared options/);
  });
  it("retries 429 / 5xx, then answers", async () => {
    let calls = 0;
    const judge = new JevJudge({
      apiKey: "k",
      backoffMs: 1,
      fetch: (async () => (++calls < 3 ? reply({}, calls === 1 ? 429 : 503) : reply({ answers: { decision: { choice: "reject_other", probabilities: { reject_other: 0.7 } } } }))) as typeof fetch,
    });
    expect((await judge.decide(q)).answer).toBe("reject_other");
    expect(calls).toBe(3);
  });
  it("does not retry a 400", async () => {
    let calls = 0;
    const judge = new JevJudge({ apiKey: "k", backoffMs: 1, fetch: (async () => (calls++, reply({ error: "bad" }, 400))) as typeof fetch });
    await expect(judge.decide(q)).rejects.toThrow(/HTTP 400/);
    expect(calls).toBe(1);
  });
});

describe("main: POST /characters runs the name check", () => {
  let main: MainHandle | null = null;
  let session = "";
  const post = async (path: string, body: unknown, token?: string) => {
    const res = await fetch(`${main!.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  beforeAll(async () => {
    main = await startMain({
      port: 0,
      host: "127.0.0.1",
      secret: "test-moderation",
      experienceId: "test-moderation",
      accounts: new MemoryAccountStore(),
      playerData: new MemoryPlayerDataBackend(),
      world: { scene: "field", cap: 5, min: 0, max: 0 },
      supervisor: null,
      scaleEverySeconds: 3600,
      moderation: { judge: { decide: async (q) => ({ answer: (q.evidence as { name: string }).name === "Lowconf" ? ("reject_offensive" as never) : ("accept" as never), probability: 0.5, model: "fake" }) }, reservedNames: ["Wynna Coyle"] },
      log: () => undefined,
    });
    session = (await post("/auth/register", { name: "tester", password: "secret1" })).json.session;
  });
  afterAll(async () => {
    await main?.close();
  });

  it("refuses a blocked name with a plain message", async () => {
    const r = await post("/characters", { name: "GM Bob" }, session);
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/^That name isn't allowed: it looks like a staff title/);
    const reserved = await post("/characters", { name: "Wynna Coyle" }, session);
    expect(reserved.status).toBe(400);
    expect(reserved.json.error).toMatch(/belongs to a character in the game/);
  });
  it("creates a clean name, and accepts a low-confidence reject onto the review list", async () => {
    expect((await post("/characters", { name: "Cassandra" }, session)).status).toBe(200);
    const second = (await post("/auth/register", { name: "reviewTester", password: "secret1" })).json.session;
    expect((await post("/characters", { name: "Lowconf" }, second)).status).toBe(200);
    const unauth = await fetch(`${main!.url}/admin/moderation/names`);
    expect(unauth.status).toBe(401);
    const res = await fetch(`${main!.url}/admin/moderation/names`, { headers: { authorization: "Bearer test-moderation" } });
    const body = (await res.json()) as any;
    expect(body.threshold).toBe(0.8);
    expect(body.names.map((n: { name: string }) => n.name)).toEqual(["Lowconf"]);
  });
  it("the as-you-type name check reports a list hit", async () => {
    const res = await fetch(`${main!.url}/characters/name?name=${encodeURIComponent("Admin")}`, { headers: { authorization: `Bearer ${session}` } });
    expect(((await res.json()) as any).reason).toMatch(/staff title/);
  });
});
