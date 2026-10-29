# armor-helm-shoulder-variety — several helms and several shoulders per set, different pieces each

Engine root `D:\Users\Derek\Desktop\HitRegStudios\Engine`; tools from `apps/playground`; project `foundation`.

## Why (Derek, 2026-10-29)

"for the shoulders and the helm you are supposed to pick a few helms and a few shoulders, you can make it so that
you are using different pieces for each of them. that way they dont look similar." Today `tools/armor-codex/` gives a
set ONE helm configuration and ONE shoulder configuration reused across its tiers, and the overnight run (11 Wrackmoor
sets + 5 earlier) shared helm bases between sets (only 8 bases). Each set's helm and shoulder SHEETS already paint
every part of `mmo/human-helm.glb` / `mmo/human-shoulder.glb` (their key-labelled covers the whole ubermesh), so more
pieces need NO new Codex art: this is a brief/items change.

Read `docs/armor-sets.md` (incl. "Breaking a set into items", the model rules: one helm base; one shoulder base,
one rim, one accent; hides; ornaments rare+), `tools/armor-codex/` (brief schema, items, review, lint), the briefs
and review sheets in `projects/foundation/authoring/armor-sets/`, `ledger.md`, `wrackmoor-drops.md`, the models'
`rules`/`partProblems` in core.

## Deliverable

1. **Brief schema**: `helms[]` and `shoulders[]` lists (2-4 each, `.describe()`), each entry a full part pick
   (helm: base + extras like nose guard / crown / hood over a helm / bandana; shoulder: base + rim + accent) with the
   tiers and item ids it goes to (e.g. a cap-and-coif at common, a nasal helm at uncommon, a closed helm with the
   ornate crown at rare). Lint: every entry distinct within the set (different base, or same base with clearly
   different extras: say how distinct is measured), ornaments only rare+, the models' rules hold, and across ALL sets
   no two sets share an identical helm or shoulder pick (warn when two sets share a base, fail on identical picks).
2. **Items**: one helm item and one shoulder item per entry (named per piece, e.g. "Shackle Coif", "Shackle Nasal
   Helm"), schema-validated into `assets/items/`, old single helm/shoulder items replaced in place (same ids where an
   entry keeps a tier, so nothing referencing them breaks; list any id that changes); icons re-rendered
   (`item-icon`); `wrackmoor-drops.md` updated with the new item ids.
3. **Re-pick all 16 sets** (the 11 Wrackmoor + 5 earlier) with 2-3 helms and 2-3 shoulders each, matched to the
   set's character (cloth: hoods, cowls, bandanas, light caps; leather: caps, hoods over coifs; mail: coifs, nasal
   helms; plate: closed helms, great helms; cult/rare: crowns and ornaments), spreading bases across sets.
4. **Review sheets** re-rendered with a row per helm and shoulder piece on both sexes, overwriting
   `review/<set>.png`; OPEN every sheet with the Read tool and confirm the pieces read as different.
5. Tests for the lint; playground tests and tools typecheck green; docs (`docs/armor-sets.md`, the `armor-sets`
   skill) say a set ships several helms and shoulders.

Rules: no Codex regeneration (the sheets already cover every part; if a part reads badly on a sheet, list it, do
not regenerate); no Blender; never :5173; no iteration files; no commits; do not touch other agents' files
(worldgen, town, terrace, recipe). Budget 250k. Report once, under 15 lines, with the review-sheet paths.
