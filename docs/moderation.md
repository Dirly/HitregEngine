# Moderation, names and the item log

**Status (2026-10-07): steps 1-3 built (names, reports, audits and sanctions); the rest per the build order at
the bottom.** Owner rulings are marked **(ruling)**; each step works on its own, and each built section ends with
what was actually built.

A cluster (docs/hosting.md) has one main and many game servers — layers, zone copies, instances — and a player
hops between them all the time. So everything here lives at **main**, keyed by **account** (a new character is
not a clean slate), and follows a player wherever main puts them. Game servers only gather evidence and
enforce what main tells them, the way they already do for parties and block lists.

The judge is a **decision model**: given a bundle of evidence and a closed list of answers, it returns one answer
with a calibrated probability. The intended provider is **Jev** (TypeSafe AI) **(ruling)**; the engine talks to an
interface (`ModerationJudge`, below), so a stand-in judge runs the same code in tests and until a key exists.

## 1. Names

Checked when a character is made (`POST /characters` on main) and when one is renamed.

1. Shape: the existing `CHARACTER_NAME` rule (3-20 letters) and uniqueness.
2. **Word list** (cheap, local): a reserved/blocked list in a data file — staff titles ("gm", "admin",
   "moderator"), the game's own NPC and boss names, and an obscenity list with letter-swap folding
   (`1→i`, `0→o`, `3→e`, `$→s`, repeated letters collapsed). A hit is refused with a plain reason.
3. **Judge**: everything that passed the list. Answers: `accept | reject_offensive | reject_impersonation |
   reject_real_person | reject_other`. Refuse only above the confidence threshold (default 0.80); below it the
   name is accepted and queued for review.

A name REPORTED in play skips the report threshold: it goes straight to the judge, and the outcome is "rename
required" (the character keeps playing; at next login it must pick a new name), never a ban.

**As built (step 1, with the rename from step 3):**
- `moderation/names.ts`: `NameModeration.check(name, {accountId, characterId})` runs the list, then the judge;
  `checkList(name)` is the list alone. The list is `moderation/names-blocklist.json` (entries match as a whole
  `word`, a `substring`, or the whole `name`, so "Cassandra" is not refused for "ass") plus the game's reserved
  names (`MainOptions.moderation.reservedNames`, from `reservedNamesFromEntities`: every `npc` builtin's name and
  every entity tagged `boss` or `named`). A judge failure accepts the name and lists it for review.
- Routes on main: `POST /characters` (full check), `GET /characters/name?name=` (list only, for the creation
  screen as you type), `POST /characters/:id/rename {name}` (only while a `rename` sanction is in force on that
  character; shape, uniqueness, list and judge, as at creation; clears the sanction).
- The review list is persisted in main's queue record (§3) and read at `GET /admin/moderation/names`
  (`{threshold, names}`) or with the escalations at `GET /admin/moderation/queue`.
- Options: `MainOptions.moderation.{judge, nameThreshold (0.80), reservedNames}`.

## 2. Chat history and `/report`

**(ruling)** Chat moderation is self-reporting: nothing reads chat on its own.

- Every game server keeps a **rolling buffer of the chat lines it routed** (~15 minutes: proximity, zone, party,
  global — with channel, sender account/character, recipients' zone, timestamp). Zone, global and party lines
  also pass through main, which keeps its own buffer of those.
- `/report <name> <reason>` (and a button on the social panel's player menu) calls main
  (`POST /reports {characterId, target, reason, kind}` with the session; `kind`: `chat | name | cheating | other`).
- Main asks the reporter's current server for **evidence** over the cluster link (`evidence.request`): the
  buffered lines involving the reporter or the reported in the last 15 minutes, both positions, zone, server
  id. It adds its own bridged lines. The bundle is stored WITH the report.
- Only chat attached to a report is kept beyond the buffer (default 30 days). The rest is never written down.
  The game's terms say chat is kept for moderation.

**As built (step 2):**
- Buffers: `moderation/chat-buffer.ts`, 15 minutes, capped at 5,000 lines on a layer and 20,000 at main. A
  layer buffers every line it delivers (`chat.ts`); main buffers the zone, global, party and guild lines it bridges.
- `POST /reports {characterId, target, reason, kind}` → `{ok, id, name}`. `target` is a character NAME; `kind`
  defaults to `other`. Refused: yourself, an empty reason, reporting the same account again within the hour
  (429), more than 10 reports an hour from one account (429).
- Evidence: main sends `{t: "evidence.request", requestId, reporter, target, minutes}` to the reporter's server
  and, when different, the reported's; each answers with rpc `evidence.result` (3 s, or the report is filed
  without it). Only the two characters' own lines are kept, with whether each heard them; other players appear
  as a count, never an id.
- The report is stored in the REPORTED account's `moderation` record (§3), with its evidence bundle.

## 3. Reports, audits and sanctions (main)

Stored per **account** in player data (namespace `moderation`, compare-and-swap like `social`): reports
received (reporter account, reason, kind, evidence id, time), sanctions (kind, until, why, by: judge | staff),
name status.

**Audit rule (ruling: multiple reports require an audit):** an audit opens when **3 reports from 3 different
accounts** arrive within **24 hours** (tunable). Reports from an account the reported has blocked, or from
accounts created in the last hour, count for less (brigading). One report never acts on its own.

**The judge decides (ruling):** the audit bundle — every open report and its evidence, the account's sanction
history — goes to the judge. Answers: `no_action | warn | mute_1h | mute_24h | temp_ban_24h | temp_ban_7d |
escalate`. Act only when the answer's probability clears its threshold (defaults: warn 0.70, mutes 0.85, bans
0.95); anything below goes to the **escalation queue** for staff, as does every `escalate`. Option names are
written out in full on purpose: a decision model leans on the option NAME (arXiv 2609.26758), so `temp_ban_24h`,
never `B`.

**Enforcement across servers:**
- Mute: main pushes `{t: "sanction", characterId, mute: until}` to the server the account is on (same path as
  `blocks`); that server's chat drops the player's lines and tells them why and until when. Re-sent on every join
  and transfer.
- Ban: `/play` refuses to place the account (a clear message with the end time); a player currently in game is
  told and disconnected.
- Warn: a system chat line and a mark on the record.

**Staff surface (main admin, bearer token):** `GET /admin/moderation/queue` (escalations and low-confidence
names), `POST /admin/moderation/decide {auditId, action}`, `POST /admin/moderation/sanction`,
`DELETE /admin/moderation/sanction`, `GET /admin/moderation/account/:id` (record + evidence). Appeals are a staff
decision.

**As built (step 3):** `moderation/audit.ts` (`ModerationDesk`: the rule, the verdict, staff actions) and
`moderation/sanctions.ts` (record shapes, the queue record, the lines players read).

- **When it runs.** After `POST /reports` has stored a report and answered, main calls
  `moderation.afterReport(report, account)`. Audits of one account run one at a time; a report filed while one
  runs is weighed by the next.
- **The rule.** Open reports (not `name`) of the last 24 h, one vote per distinct reporter account. A vote counts
  0.5 when the reporter's account was created less than an hour before the report (`AccountRecord.createdAt`;
  missing counts as old) or when the reported account has blocked the reporter (its `social` record). An audit
  opens at a total of 3. The bundle holds EVERY open report, old ones too.
- **The verdict.** The judge gets `task: "audit"`, the seven answers above and `{account, reports: [{id, reporter,
  reporterAccount, reporterName, reported, kind, reason, at, weight, reporterAccountIsNew,
  reporterBlockedByReported, evidence}], sanctionHistory: [{kind, reason, by, at, until?, lifted?}],
  earlierAudits}` (`RuleJudge` reads `reports[].reporter`). An answer is applied when its probability is ABOVE its
  threshold: warn 0.70, `mute_*` 0.85, `temp_ban_*` 0.95, and `no_action` 0.70 (not in the ruling; a hesitant
  "no" goes to staff too). Below it, `escalate`, a judge error or no judge at all: the audit is escalated. Either
  way the audited reports close (`outcome: "audit:<id>:<action|escalated>"`), so the same reports never audit twice.
- **Name reports** skip the rule: `NameModeration.check` on the reported character's name. Refused → a `rename`
  sanction on that character, and they are told at once ("The name "X" was refused. You can keep playing now…").
  Accepted below the threshold → the review list. Every open name report on that character closes
  (`outcome: "name:rename|review|accepted"`).
- **Thresholds** are options: `MainOptions.moderation.audit {windowMs, reporters, newAccountMs, lightWeight}` and
  `MainOptions.moderation.thresholds {no_action, warn, mute, ban}`.

The account's `moderation` record (one per account, compare-and-swap; reports.ts carries these fields through):

```ts
{
  reports: Report[];                 // step 2; status "open" until an audit closes it
  evidence: Record<string, EvidenceBundle>;
  sanctions: Array<{
    id; kind: "warn" | "mute" | "ban" | "rename";
    until?: number;                  // epoch ms (mute, ban)
    reason: string;                  // shown to the player
    by: "judge" | "staff"; auditId?: string; at: number;
    characterId?: string; name?: string;          // rename: whose name, which one
    liftedAt?: number; liftedBy?: "staff" | "rename"; newName?: string;
    deliveredAt?: number;            // a warn reached the player
  }>;                                // never deleted: the history the next audit reads
  audits: Array<{ id; at; reportIds; weight; status: "decided" | "escalated"; answer?; probability?; model?;
                  why?: "escalate" | "below_threshold" | "judge_error"; error?; action?; decidedBy?; decidedAt?;
                  sanctionId? }>;
}
```

In force = not lifted and `until` in the future (rename: until the rename). Main's own record (player data
`moderation-main` / `moderation-queue`) holds `{escalations: [{auditId, account, at, why, answer?, probability?,
error?, reports, names}], names: NameReview[]}` — the index staff work from.

Enforcement as built:
- **Mute.** Main → layer `{t: "sanction", characterId, muteUntil: number | null, reason?, notice?}` to every
  character of the account that is in game, when a mute is given or lifted, and again on EVERY `player.joined`
  (a login, a transfer, a zone crossing). The layer (`serve.ts` → `mountLayerChat({muted})`) drops each `say` of a
  muted player before routing — nobody hears it, nothing is buffered or bridged — and answers that try with
  "You are muted until 2026-10-07 15:04 UTC (reported by 3 players for abusive chat)." `notice` is a system line
  shown on arrival of the message (the mute itself, "Your mute was lifted.", a warn). Voice is not muted.
- **Ban.** `/play` answers 403 "This account is banned until … UTC (reason)." A player in game gets main → layer
  `{t: "kick", characterId, text, refuseUntil}`: the line is shown, a quarter second later the session ends
  (`GameServer.expel`: socket dropped, body saved and removed, no reconnect grace), and that layer refuses the
  character's tickets until `refuseUntil` (the ticket lifetime plus 30 s; new tickets need `/play`).
- **Warn.** A system line ("Warning from the moderators: … Further reports can lead to a mute or a ban.") through
  the same `sanction` message; `deliveredAt` marks it. One given while the player is away is shown at their next
  arrival.
- **Rename.** `/play` answers 409 `{code: "rename_required", renameRequired: true, characterId, name, error}`;
  the playground's character screen (`gateway.ts`) asks for a new name and calls
  `POST /characters/:id/rename {name}`, then enters.

Staff routes (bearer = the admin token):

| route | does |
|---|---|
| `GET /admin/moderation/queue` | `{escalations, names, nameThreshold, thresholds, audit}` |
| `POST /admin/moderation/decide {auditId, action}` | applies one of the six non-`escalate` answers (`by: "staff"`), takes it off the queue |
| `POST /admin/moderation/sanction {account \| characterId \| character, kind, minutes?, reason}` | gives a sanction; mute/ban need `minutes`, rename needs the character |
| `DELETE /admin/moderation/sanction {account \| characterId \| character, kind}` | lifts every one of that kind in force (`{lifted}`) |
| `GET /admin/moderation/account/:id` | `{account, active, online, record}` — the whole record, evidence included |

## 4. The item log

**(ruling)** Record what a player HAS and LOSES, not what drops: "if they don't get it, they don't get it".

Append-only log per character at main (namespace `items-log`, rotated): one entry per event —
`equip | unequip | pickup | lost (death, failed extraction, destroyed) | vault_in | vault_out | trade_in |
trade_out | restored` — with the item's instance id, item id, count, server, time. Drops never appear.
Game servers send the entries over the cluster link in small batches (with the periodic save).

Uses:
- **Lost-item claims**: a ticket for an item answers from the log — when it arrived, where it went. The judge
  answers `restore | deny | escalate` from the log alone; a restore writes `restored`.
- **Dupe flag**: an item instance id that appears in two inventories at once, or arrives twice without leaving,
  opens a staff case at once (real-money rule: dupes are never tolerated).

**Built (2026-10-07)** — `packages/server/src/moderation/items-log.ts`, tests `test/items-log.test.ts`.
- **Detection is generic, no game calls.** Each layer's `ItemsLogCollector` diffs what the authority already
  writes — `character/<bodyId>` and `vault/<bodyId>` — per tracked character, once per synchronous run (so a
  deposit's sheet + vault writes are one `vault_in`, and a hand-over's two sheets name each other). Losses are
  labelled from the same state: into the own corpse = `death`, into an own dropped bag = `dropped`, onto another
  character = `to <id>`; anything else (sold, consumed, quest) is a bare `lost`.
- **Instance ids.** Unique items (item `stack` 1) get a cluster-wide `iid` (core `itemStackSchema`), stamped by
  the collector the first time it sees the stack; it is ordinary instance data, so it rides the vault, bags,
  corpses, the shop shelf, transfers and saves. Stackable goods are logged by count (`instanceId: null`).
- **Transport.** Its own small RPC, `items.log { batchId, batches }`, sent from inside the layer's commit hook
  (serve.ts wraps persistence): every periodic save, every leave, and before a transfer ticket is minted. A
  failed send is kept and re-sent with the next flush; main applies a `batchId` once. The first flush for a
  character on a layer carries `holding` (every iid it holds), which rebuilds main's index after a restart.
- **Store.** Player data scope `{ playerId: <characterId> }`, namespace `items-log` (newest 500), older halves
  rotate into a ring of 40 `items-log.<n>` records (~10k entries per character; the oldest archive is overwritten).
- **Dupes.** Main keeps an in-memory index instanceId → character (200k, oldest forgotten). Arriving while held by
  the same character = `arrived-twice` case at once; held by another = `two-characters` case if the first
  holder's leave does not follow within 2 minutes (two layers flush on their own clocks). Cases persist in
  `items-dupes` (scope `moderation-items`). Nothing is punished automatically.
- **Staff + claims.** `GET /admin/items-log/:characterId?item=&since=&limit=` (item = item id or instance id),
  `GET /admin/moderation/dupes[?all=1]`, `POST /admin/moderation/dupes/:id/close` (bearer). The judge's
  evidence: `MainHandle.itemsLog.claimEvidence(characterId, item)` (or `itemClaimEvidence(store, …)`); a granted
  claim calls `itemsLog.restore(characterId, { instanceId, itemId })`, which writes `restored`.
- Not seen: what never reaches a tracked character (drops, a bag's contents) — by ruling. `trade_in/out` are
  defined but unused (no trade window; looting a body is `lost`/`pickup` naming the other side).

## 5. The judge interface

```ts
interface ModerationJudge {
  decide<Option extends string>(q: {
    task: "name" | "audit" | "item-claim";
    question: string;          // what is being decided, in plain words
    options: readonly Option[]; // the only valid answers
    evidence: unknown;          // JSON: the name / the bundle / the log slice
  }): Promise<{ answer: Option; probability: number; model: string }>;
}
```

- `JevJudge`: the provider adapter (HTTP, key from the environment; endpoint and payload per TypeSafe's API docs).
- `RuleJudge`: a deterministic stand-in (word list for names, report count for audits, always `escalate` for
  item claims) — tests, and any cluster without a key.
- Every decision is logged with its inputs, answer, probability and model, so a wrong call can be traced.
- An eval set (`packages/server/test/moderation-cases/`): made-up names, chat bundles and item logs with the
  expected answer, run against a judge before it is allowed to act.

## Build order

| step | what | where | status |
|---|---|---|---|
| 1 | Judge interface + RuleJudge + JevJudge adapter + name check at creation/rename | `packages/server/src/moderation/` (judge, names), main `/characters` | built (`test/moderation-names.test.ts`) |
| 2 | Chat buffer on game servers and at main, `evidence.request`, `POST /reports`, client `/report` | `packages/server/src/chat.ts`, cluster protocol, main, playground social panel | built (`test/moderation-reports.test.ts`) |
| 3 | Reports/sanctions store, audit rule, judge verdicts, enforcement (mute push, ban at `/play`), staff queue | `packages/server/src/moderation/` (audit, sanctions), main, `chat.ts`/`serve.ts`, playground `gateway.ts` | built (`test/moderation-sanctions.test.ts`) |
| 4 | Item log: entries from game servers, store at main, claims, dupe flag | `packages/server/src/moderation/items-log.ts`, cluster protocol, the game's loot/inventory hooks | see §4 |
| 5 | Eval set + thresholds review before any automatic ban | `packages/server/test/moderation-cases/` | not started — until then the judge's bans run on the default thresholds |
