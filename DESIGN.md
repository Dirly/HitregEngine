# Design

> v0 — captured from the current editor overlay implementation
> (`packages/editor/src/overlay/`). Refine via `/impeccable` commands; when
> tokens change here, update the overlay styles to match. Dark-first by
> explicit preference; a light theme is not planned for the editor.

## Theme

Dark-first (and dark-only for now). Near-black surfaces, low-chroma text,
color reserved for meaning (selection, entity kinds, accents). The overlay
floats above a live 3D viewport — panels use slight translucency so the scene
reads through as context, never fully opaque walls.

## Color

| Token | Value | Use |
|---|---|---|
| `bg.canvas` | `#0b0e14` | viewport clear color / page background |
| `bg.panel` | `rgba(13, 17, 23, 0.94)` | overlay panels |
| `bg.surface` | `#161b22` | inputs, wells |
| `bg.raised` | `#21262d` | buttons |
| `border.default` | `#30363d` | panel and control borders |
| `text.primary` | `#c9d1d9` | body |
| `text.emphasis` | `#e6edf3` | headings |
| `text.muted` | `#8b949e` | labels, hints, secondary |
| `accent.selection` | `#1f3a5f` | selected row background |
| `accent.entity` | `#79c0ff` | prefab-instance rows (paired with ◆ glyph) |
| `accent.component` | `#d2a8ff` | component names in inspector |

Rules: color never carries meaning alone (AA + colorblind-safe — pair with
glyph/label, e.g. prefab rows are blue **and** marked ◆). Keep chroma low;
saturated color belongs to the scene, not the chrome.

## Typography

- Family: `ui-monospace, monospace` throughout — the overlay is a code-adjacent
  instrument; monospace reinforces "everything is data".
- Sizes: 12px base, 11px controls/labels, 10px meta/footnotes. No type above
  ~13px inside panels; hierarchy comes from weight and color, not size jumps.
- Weight: regular; `strong` (600) for section titles and component names only.

## Spacing & Layout

- Panel: fixed right dock, 340px wide, full height; sections split
  hierarchy/inspector with 1px borders. Density target: ~20px row height.
- Base unit 4px; paddings 4/6/8. Tree indent 14px per depth.
- Border radius 3px on controls; panels are square-edged.

## Components

- **Panel** — floating window (Unity-style layout: hierarchy left, inspector
  right, assets bottom, toolbar top): draggable title bar, corner resize,
  collapse chevron, position persisted per panel. Translucent dark, 1px
  border, internal scroll. Undock-to-OS-window is roadmap.
- **Context menu** — right-click, dark solid, hover rows use
  `accent.selection`; shortcut hints inline.
- **Tree row** — glyph + name, hover affordance, selected = `accent.selection`
  fill; delete affordance right-aligned, muted until hover.
- **Field row** — 80px muted label left, control fills remainder.
- **Input/select** — `bg.surface`, 1px border, 3px radius, 11px mono.
- **Button** — `bg.raised`, 1px border, quiet; no primary/filled buttons in
  the overlay (nothing screams).
- **Vector field** — N number inputs in a tight flex row (position/scale/quat).

## Motion

Minimal and fast: nothing animates over 150ms; no easing theatrics. Selection
and hover are instant state changes. Respect `prefers-reduced-motion` for the
few transitions that exist. The 3D viewport supplies all the motion this
product needs.

## Voice

Terse, lowercase-leaning utility copy ("add component…", "press ~ for
editor"). Keyboard hints shown inline where they matter. No exclamation
marks, no mascot energy.
