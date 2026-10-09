# Audio: generating sounds and the soundscape

Two halves: **`tools/sfx-request.mjs`** makes the files (ElevenLabs sound
effects + music) from a project's sound template and catalog, and the
**`soundscape` / `sound-zone` builtins** play the world's background audio
(beds, spot emitters, music) at runtime. One-shot gameplay sounds (a swing, a
spell impact, a UI click) are played by whatever script owns the moment,
through `ctx.playSound`.

## The house style is a template, not a habit

Every prompt is composed, never written whole:

```
<catalog entry prompt> . <category style> . <global style> . No <avoid list>.
```

`projects/<game>/authoring/audio/template.json` holds the global style line
(for the MMO: polished AAA high-fantasy MMORPG sound, the World of Warcraft
school: rich, layered, weighty, warm, never retro), the avoid list, and per
**category** rules: style words, loudness target (LUFS), loop or one-shot,
mono (positional) or stereo, default length and variant count, output
extension. A catalog entry (`authoring/audio/catalog/*.json`) describes ONLY
its own sound. Change a template line and every file it touches goes STALE,
so a restyle is one edit and one `gen`.

- SFX prompts are capped at **450 characters** by the API. Keep an entry's own
  prompt to about 220. The tool drops the avoid list, then the global line, before it refuses.
- Never name a game, franchise, composer or artist in a prompt. The music API
  rejects them, and the sound comes from describing its sources anyway.
- Music categories append `musicStyle`. A category with `"globalStyle": false`
  (the tavern band) opts out of the orchestra line.

## Commands (run from `apps/playground`)

```
node tools/sfx-request.mjs status --project foundation [--category ui] [--next]   # ok / STALE / MISSING / REJECTED
node tools/sfx-request.mjs gen    --project foundation [--category ui] [--only 'ui/equip-*'] [--dry] [--force] [--concurrency 2]
node tools/sfx-request.mjs one    --project foundation --id ui/click --category ui --prompt "…" [--variants 2]
node tools/sfx-request.mjs refit  --project foundation [--category ambience]  # re-level installed files, no API
node tools/sfx-request.mjs board  --project foundation     # authoring/audio/board.html: listen, tick rejects, copy commands
node tools/sfx-request.mjs reject --project foundation --file ui/click.mp3 --note "too shrill"
```

`gen` only makes what is not ok, so it is safe to re-run. Output goes to
`assets/audio/<id>.<ext>`, with variants 2..n at `<id>-2.<ext>` …. Loops and
music are `.ogg`: mp3 encoder padding puts a gap in a loop. Provenance for
each file (prompt, hash, measured LUFS/peak/length) is kept in
`authoring/audio/generated.json`. Several `gen`s may run at once, because the
record is merged under a lock.

Post-processing (ffmpeg): one-shots are trimmed of leading and trailing
silence and get a short fade-out. Loops are left sample-exact. Everything is
gain-matched to its category's LUFS with a -1 dBTP ceiling and no limiter,
so loop seams survive. Short hits (< 0.4 s) are peak-normalised instead,
because they have no gated loudness.

**Hum guard.** LUFS is K-weighted and nearly deaf below 100 Hz, so a generated bed
that is mostly rumble gets gained up about 15 dB into an audible hum (the first town
beds did exactly this). The template's `highpass` and `rmsHeadroom` (per category or
per entry) cut the sub-bass and cap the unweighted mean. They stay out of the hash:
`refit` re-applies them to installed files with no API calls. `gen` prints
`HUM?` for a loop whose energy is mostly below 150 Hz. Reword it (bright, light
sources), reroll, or give that entry a higher `highpass`.

**Nobody can listen but the owner.** An agent checks what it can measure
(length after trim, LUFS near the target, dead air via `silencedetect`), then
hands over `board.html`. Rejections come back as `reject` commands with a
note. Revise the prompt, then `gen`.

Key permissions: the ElevenLabs key (repo-root `.env`, `ELEVENLABS_API_KEY`)
needs **Sound Effects**, plus **Music Generation** for the music categories.
A 401 "missing the permission …" is the key's scope, not a bug. The account
runs **4 requests at once** in total, so parallel agents should each use
`--concurrency 1` or `2`. A 429 is waited out, with up to 12 retries.

## Runtime: `soundscape` (one entity per scene) and `sound-zone`

`soundscape` follows the local player and drives:

- **Beds.** `bedPattern` (`ambience/biome/{biome}-{band}.ogg`) is filled from the
  biome blend averaged over `biomeRadius` (the top two biomes with at least
  `biomeMinShare`) and the time-of-day band (dawn/day/dusk/night, handed over
  across `bandFadeHours` of the `day-night` clock). A missing biome falls back
  through `biomeAlias` and then `fallbackBiome`. Town zones (region tag `town`)
  add `townBed` and thin the biome bed. Water within `waterRadius` adds
  river/lake/ocean beds: flowing water is a river, and still water in
  beach/seabed country is the sea. Altitude adds wind. With the head under
  water, everything ducks to the underwater bed.
- **Levels.** Owner-tuned 2026-09-27, in two rounds: beds at 0.25, spots at 0.25, and the
  town layer at 0.4 of the beds. Town spots are the bell plus an occasional distant bark,
  on `townSpotChance` (30%) of turns. **Nothing that moves near the player plays in a town**
  (hooves, carts, footsteps, doors): it reads as somebody who isn't there. Keep ambience
  UNDER everything else; loud and busy were the first two complaints.
- **Silence while loading.** `SettleLatch`: the soundscape, weather and footsteps stay
  silent until `ctx.worldLoading()` has been quiet for `settleSeconds`. It latches, so
  later streaming while walking never mutes anything. AudioSystem drops a one-shot that
  took over 900 ms to load, so a hitch can't release a burst of stale sounds.
- **Spot emitters.** Positional one-shots placed 10–45 m away every few
  seconds, taken from `spots[biome][band]` (`town` inside towns). An id without
  an extension is a variant family.
- **Music.** Priority is combat (`userData.combatUntil` on the player), then a
  sound zone's music, then the town (`townMusicById`, else by country:
  coastal/mountain/desert/village), then the biome's `musicPattern`. An
  exploration track plays once, fades, and leaves `musicGapMin`–`musicGapMax`
  seconds of silence, the long-session MMO pattern. Combat comes in over
  `combatFadeIn` and leaves over `combatFadeOut`. `/music next|off|on` and
  `/soundscape` report what it hears.

**Town clock.** In a zone tagged `town`, `clockBell` (`spot/clock-bell-strike`, one
strike per file) tolls the hour, 1–12 strikes `clockBellSpacing` apart, from the
zone's `hub` (the square) and heard across town (`clockBellRefDistance`). Only the
clock passing an hour strikes it (a `/time` jump or a spawn does not), and it keeps
quiet through `clockBellQuiet` (22-6). The bell is never a random spot sound.

**Workshops: `sound-emitter`.** Place an entity at the anvil or bench and give it
`sound-emitter` with `preset: blacksmith | carpenter | woodcutter`. The preset is a
quiet positional bed plus bursts of work at a rhythm: one activity per burst
(`family@beat`, e.g. `workshop/wood/saw-stroke@0.72`), repeated a few times, then a
rest that sometimes carries an extra (quench, bellows, a plank set down). It only
works during `hours` (7-19). Every field of a preset can be overridden. The sound
set is `workshop/smith/*` (anvil strike and tap, hot-metal blow, quench, bellows,
grindstone, tongs, set-down) and `workshop/wood/*` (saw stroke and cut-through,
hand plane, chisel and mallet, nail, rasp, auger, plank, axe split), plus
`ambience/workshop/{forge,carpentry}-bed`. Catalog: `authoring/audio/catalog/workshop.json`.

`sound-zone` is a sphere (`radius`, `fade`, `priority`) that swaps in its own
`ambience` loop, `music` list and `spots`, keeping `outdoorMix` of the
outdoors. Use it for taverns, caves, crypts and forges. A fire, torch or
waterfall that should come from a point is an `audio` component (loop,
positional) on that entity, not a zone.

Host hooks it relies on (all optional, so a dedicated server is silent):
`biomeAt`, `regionAt`, `waterAt`, `hasSound`, `soundDuration`,
`setSoundLoop`, `playSound({ at })`.
