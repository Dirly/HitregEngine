# Product

## Register

product

## Platform

web

## Users

- **Today:** Derek (game developer, Unity background) building and dogfooding the engine, working side-by-side with AI agents that edit the same live scene through MCP.
- **Later (metaverse phase):** hobbyist and kid creators making multiplayer games by talking to AI, then tweaking results by hand — often on modest hardware and school Chromebooks.
- **Always:** AI agents are first-class users. Every UI surface mirrors a JSON data model the AI edits through the same ops channel.

## Product Purpose

HitReg Engine is an AI-native game engine on Three.js: scenes, prefabs, and
assets are schema-validated JSON, mutated through an atomic ops protocol by
three equal frontends — editor panels, viewport gizmos, and AI tool calls.
The UI in question is the in-game editor overlay (press `~` over the running
game): hierarchy, inspector, gizmos, and future panels (state machines,
dialogue, assets). Success = a creator or an AI can make a change in seconds
and see it live, with the UI never becoming the bottleneck or the star.

## Brand Personality

Precise, fast, quietly confident. Dev-tool minimalism in the Linear/Vercel
lineage: dense but calm, keyboard-first, monospace accents, restrained color.
The scene being edited is the hero; the chrome recedes.

## Anti-references

- Bootstrap/admin-template genericism: cards-with-shadows grids, gradient
  buttons, badge soup.
- "AI slop" frontends: purple-to-blue gradients, glassmorphism everywhere,
  emoji-laden empty states.
- Consumer-app airiness: oversized paddings and 16px+ body text that waste
  the density a pro tool needs.

## Design Principles

1. **The scene is the hero.** Editor chrome recedes; never compete visually
   with the 3D viewport being edited.
2. **Speed is the brand.** Interactions feel instant; latency is surfaced,
   never hidden. Nothing in the UI may block the edit loop.
3. **One control surface.** Panels are views over the same schema/ops channel
   the AI uses — the inspector is the schema made visible, so UI structure
   should make the data model legible, not disguise it.
4. **Density with calm.** Pro-tool information density achieved through
   hierarchy and alignment, not clutter or noise.
5. **Legible to humans and AI alike.** Labels, states, and structure read
   unambiguously — both for people and for models reasoning about screenshots.

## Accessibility & Inclusion

WCAG AA (4.5:1 contrast, full keyboard operability, `prefers-reduced-motion`
respected) **plus colorblind-safe**: meaning is never encoded in color alone —
selection, entity kinds, and states always pair color with a shape, icon, or
label. Matters doubly for future graph editors (state machines, dialogue).
