/**
 * Inline toolbar iconography — 16px, stroke-based, drawn in `currentColor`
 * so they inherit button text color (and the active/disabled states) for
 * free. Hand-rolled instead of an icon package: the editor overlay has no
 * build step of its own, and a dozen glyphs don't justify a dependency.
 *
 * Every icon is decorative (`aria-hidden`); the owning control carries the
 * accessible name via its label or `title`/`aria-label`.
 */

export type IconName =
  | "play"
  | "pause"
  | "stop"
  | "plus"
  | "move"
  | "rotate"
  | "scale"
  | "terrain"
  | "draw"
  | "mesh"
  | "path"
  | "object"
  | "vertex"
  | "edge"
  | "face"
  | "snap"
  | "grid"
  | "physics"
  | "bones"
  | "lights"
  | "stats"
  | "profiler"
  | "sun"
  | "undo"
  | "redo"
  | "keyboard";

const PATHS: Record<IconName, React.ReactNode> = {
  play: <path d="M4.5 2.5v11L13 8z" fill="currentColor" stroke="none" />,
  pause: (
    <>
      <rect x="3.5" y="2.5" width="3" height="11" fill="currentColor" stroke="none" />
      <rect x="9.5" y="2.5" width="3" height="11" fill="currentColor" stroke="none" />
    </>
  ),
  stop: <rect x="3" y="3" width="10" height="10" fill="currentColor" stroke="none" />,
  plus: <path d="M8 3v10M3 8h10" />,
  move: (
    <path d="M8 1.5v13M1.5 8h13M5.5 4l2.5-2.5L10.5 4M5.5 12l2.5 2.5 2.5-2.5M4 5.5L1.5 8 4 10.5M12 5.5 14.5 8 12 10.5" />
  ),
  rotate: <path d="M13 8A5 5 0 1 1 10.7 3.8M13.5 1.5v3.5H10" />,
  scale: <path d="M2 14V9M2 14h5M14 2h-5M14 2v5M14 2 6 10" />,
  terrain: <path d="M1.5 13 6 5l3 4.5 2-3 3.5 6.5zM6 5l-1 1.5" />,
  draw: <path d="M10.5 2.5 13.5 5.5 5.5 13.5H2.5v-3zM9 4l3 3" />,
  mesh: (
    <>
      <path d="M8 2l6 3.5v5L8 14l-6-3.5v-5zM2 5.5l6 3.5 6-3.5M8 9v5" />
      <circle cx="8" cy="2" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
  path: (
    <>
      <path d="M2.5 13.5c3-9 6 0 11-8" />
      <circle cx="2.5" cy="13.5" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="13.5" cy="5.5" r="1.5" fill="currentColor" stroke="none" />
    </>
  ),
  object: <path d="M8 2l6 3.5v5L8 14l-6-3.5v-5zM2 5.5l6 3.5 6-3.5M8 9v5" />,
  vertex: (
    <>
      <path d="M3.5 3.5h9v9h-9z" opacity="0.6" />
      <circle cx="3.5" cy="3.5" r="2" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="12.5" r="2" fill="currentColor" stroke="none" />
    </>
  ),
  edge: (
    <>
      <path d="M3.5 3.5h9v9h-9z" opacity="0.6" />
      <path d="M3.5 3.5v9" strokeWidth="3" />
    </>
  ),
  face: (
    <>
      <path d="M3.5 3.5h9v9h-9z" fill="currentColor" fillOpacity="0.45" />
    </>
  ),
  snap: <path d="M4 2v6a4 4 0 0 0 8 0V2M2.5 5H5.5M10.5 5h3" />,
  grid: <path d="M2 2h12v12H2zM6 2v12M10 2v12M2 6h12M2 10h12" />,
  physics: (
    <>
      <circle cx="8" cy="8" r="6" />
      <ellipse cx="8" cy="8" rx="6" ry="2.5" />
      <path d="M8 2v12" />
    </>
  ),
  bones: (
    <>
      <path d="M5 11 11 5" strokeWidth="2.2" />
      <circle cx="4" cy="12" r="2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="4" r="2" fill="currentColor" stroke="none" />
    </>
  ),
  lights: <path d="M6 12.5h4M6.5 14.5h3M5 8.5a4.2 4.2 0 1 1 6 0c-.8.8-1 1.5-1 2.5H6c0-1-.2-1.7-1-2.5z" />,
  stats: <path d="M3.5 13V8M7.5 13V3.5M11.5 13V6M1.5 13h13" />,
  profiler: <path d="M1.5 8.5h3l2-5 3 9.5 2-6 1.5 1.5h2.5" />,
  sun: (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6 13 13M3 13l1.4-1.4M11.6 4.4 13 3" />
    </>
  ),
  undo: <path d="M4.5 6.5H10a3.25 3.25 0 0 1 0 6.5H6.5M7 4 4.5 6.5 7 9" />,
  redo: <path d="M11.5 6.5H6a3.25 3.25 0 0 0 0 6.5h3.5M9 4l2.5 2.5L9 9" />,
  keyboard: (
    <>
      <rect x="1.5" y="4" width="13" height="8.5" rx="1.5" />
      <path d="M4 7h1M7 7h1M10 7h1M4 9.5h1M6.5 9.5h3M11 9.5h1" />
    </>
  ),
};

export function Icon(props: { name: IconName; size?: number }) {
  const size = props.size ?? 14;
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block", flexShrink: 0 }}
    >
      {PATHS[props.name]}
    </svg>
  );
}
