---
name: world-standards
description: Coordinating or reviewing generated world content: the standing rules for an unattended zone run (places before quests, a reviewer agent before detail work, acceptance on the server, no re-proving, revisions write new files, rulings live in tools) and which task skill each job loads. Use before briefing, reviewing or installing any site, dungeon or town.
---

# world-standards

How a zone run is run: `docs/zone-creation.md` (skill `zone-creator`). Reviewer checklist:
`docs/world-standards/review-rubric.md`. Open values and unencoded rules: `docs/world-standards/README.md`.

## Which skill a job loads (name them in every brief)
| Job | Skills |
|---|---|
| where places go, town wall lines | `site-finder` |
| ground, trails, plants, holes | `terrain-edits` |
| air and light of a zone or place | `zone-mood` |
| outdoor site design / props | `site-standards`, `poi-creator` / `site-dressing`, `prop-intake` |
| dungeon design / build + gates / light / doors | `dungeon-standards` / `dungeon-build` / `dungeon-lighting` / `portals` |
| towns, buildings, styles | `town-planner`, `building-constructor`, `building-styles`, `town-npcs` |
| rooms and furnishing | `interior-standards` |
| creatures | `encounter-standards` |

## Taste and decisions
- Taste goes in once: owner rulings become data and checks. Feedback after a zone ships makes rules for later zones; it
  does not send a finished zone back. Proving zones are dogfooding: faults become tools, not patches.
- Rules state what was learned, never where: no place names in a skill or standard.
- The coordinator decides design and scope calls inside the agreed direction and reports in one line; it asks only for
  new fan-outs, destructive or outward actions, or a contradicted ruling. Silence is not approval.
- New lessons go into a skill or a check. `docs/zone-creation-lessons.md` is the raw log only.

## Order and gates
- Places before quests: sites and dungeons built and populated first; quests bound last.
- A cheap look before the expensive pass, by a reviewer agent that is NOT the builder; resume a reviewer, do not respawn.
- The grey box proves the read: the defining shot from its stated viewpoint, readable hour, clear weather. Encoded: `tools/poi-review/job.mjs stage` (no stage past blockout without `evidence.readShot` from a declared viewpoint).
- Loop cap: two returns, then install with the fault logged, or cut the feature. Encoded: `job.mjs fix` (third attempt needs --coordinator).
- Reviews compare side by side with the owner-approved references (rubric Q2, dungeon `compare`).
- Nothing installs before the final quality review passes (Encoded: installers call `requireFinalReview` from `tools/poi-review/job.mjs`; `--force-dogfood` is the coordinator's). Acceptance is on the dedicated server with creatures spawned.
- Proven work is not proved again unless its own inputs changed (content digests of the zone's slice).

## Agents and briefs
- Roles: Opus owners do terrain, structures, routes, anchors and socket maps; Sonnet places every loose prop by name;
  GPT draws art. An Opus owner writing prop transforms is a fault.
- Rulings live in tools and skills; a brief points at them and never restates or narrows them ("no new models" means
  no new MESHES for what the catalogue has; new skins are always allowed).
- Budgets: small ~150k, medium ~300k, large ~400k, dungeon ~450k; a long trail gets its own owner; a capital two owners.
  Every stage reports what it used. An owner past ~400k context hands off with its handoff file.
- A handoff states what is missing ("story not yet visible", prop requests).
- A builder stops at the first refusal of a tool and reports it with the fallback it used.
- Shared tools, not per-job copies: a copied harness carries the other job's routes and layout grammar.

## Evidence
- Counts come from a tool, never the builder's tally.
- A picture is evidence only with its camera stated, in play mode, readable hour, after a dev-server restart.
- Grey-box pictures use a flat review exposure; final pictures the shipped light.
- A gate that over-reports gets ignored; the same failure count in two places measures the rule: fix the gate.

## Files and installs
- A revision writes new files; never overwrite what an installed version uses. One writer on a world file: builders
  deliver installers, one queue installs.
