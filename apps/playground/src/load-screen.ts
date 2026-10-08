/**
 * The load-in screen (Derek, 2026-10-07: "we also need to create a proper load
 * in, the game is super super laggy"): instead of dropping the player into a
 * world still streaming its ground, uploading its models and compiling its
 * shaders — every one of which is a hitch — a full-screen painting holds until
 * the world is actually ready to play:
 *
 *   1. the server link is up (networked play) and this tab's body has arrived;
 *   2. streaming has gone quiet: no terrain cell or sub-scene still loading;
 *   3. the frame rate has SETTLED: no frame longer than SETTLE_FRAME_MS for
 *      SETTLE_SECONDS in a row. Shader compiles, GPU uploads and first-draw
 *      stalls all show up as long frames, so this one signal covers them all
 *      without hooking each.
 *
 * It never waits forever (MAX_SECONDS), shows at least MIN_SECONDS so it does
 * not flash, and fades out. It re-arms itself whenever the world goes away
 * again (a scene switch, a server transfer, the body lost) so a portal or a
 * zone hop gets the same treatment. Skinned with the game's own art: the
 * creation screen's painting and its bronze panel frame (creation `ui`).
 */
import type { CharacterCreation } from "@hitreg/core";

/** A frame longer than this is a hitch (ms). */
export const SETTLE_FRAME_MS = 50;
/** Seconds of no hitches that count as settled. */
export const SETTLE_SECONDS = 1.0;
/** The screen shows at least this long, so a fast load does not flash. */
export const MIN_SECONDS = 1.2;
/** ...and never longer than this: a world that never settles is let through. */
export const MAX_SECONDS = 45;

export interface LoadSignals {
  /** The player means to be in the world now (playing; a networked tab with a grant). */
  wanted(): boolean;
  /** Networked: the link to the server is up. Local play: always true. */
  connected(): boolean;
  /** This tab's body exists in the world. */
  hasBody(): boolean;
  /** Streaming work still in flight (terrain cells, sub-scenes): 0 = quiet. */
  loading(): number;
  /** The world is being torn down / switched (a scene switch in progress). */
  switching(): boolean;
  /** Where the player is going, for the title ("Ironspur Shore"); "" = the scene's name is used. */
  place(): string;
}

export interface LoadScreenOptions {
  signals: LoadSignals;
  /** The game's creation rules (its `ui` gives the painting and the frame); null = a plain dark screen. */
  creation: () => CharacterCreation | null;
  textureUrl: (id: string) => string | undefined;
}

type Phase = "connect" | "body" | "stream" | "settle" | "done";

const STYLE = `
.hg-load{position:fixed;inset:0;z-index:19990;display:flex;align-items:flex-end;justify-content:center;background:#070606 center/cover no-repeat;font:14px/1.45 Georgia,'Times New Roman',serif;color:#dfd2b8;text-shadow:0 1px 3px #000;transition:opacity .6s ease;pointer-events:auto}
.hg-load[hidden]{display:none}
.hg-load.out{opacity:0;pointer-events:none}
.hg-load::before{content:"";position:absolute;inset:0;background:radial-gradient(ellipse at 50% 45%,transparent 30%,#050404a0 75%,#050404e0 100%)}
.hg-load-card{position:relative;isolation:isolate;margin-bottom:9vh;width:min(560px,86vw);padding:16px 22px 18px;border:34px solid transparent;text-align:center}
.hg-load-card::before{content:"";position:absolute;inset:-34px;pointer-events:none;border:46px solid transparent;border-image:var(--load-panel) 58 / 46px repeat;z-index:-1}
.hg-load-card::after{content:"";position:absolute;inset:-4px -13px;background:linear-gradient(#121110e6,#121110ee);z-index:-2;pointer-events:none}
.hg-load h1{margin:0 0 2px;font-weight:normal;font-size:24px;letter-spacing:.18em;text-transform:uppercase;color:#ead2a7}
.hg-load .hg-load-sub{margin:0 0 14px;color:#a69c89;font-size:13px;letter-spacing:.04em;min-height:1.4em}
.hg-load-track{position:relative;height:16px;background:#0b0907;border:1px solid #6a5434;box-shadow:inset 0 1px 4px #000}
.hg-load-fill{position:absolute;inset:1px;transform-origin:left center;background:linear-gradient(#e2b25e,#9a6a2a);transition:transform .25s ease-out}
.hg-load-pct{margin-top:6px;font-size:12px;color:#b79c6b;letter-spacing:.1em;font-variant-numeric:tabular-nums}
`;

/** Mount the load-in screen; it watches the signals itself (every animation frame) until disposed. */
export function mountLoadScreen(opts: LoadScreenOptions): { dispose(): void; showing(): boolean } {
  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.appendChild(style);
  const root = document.createElement("div");
  root.className = "hg-load";
  root.hidden = true;
  root.setAttribute("role", "status");
  root.setAttribute("aria-live", "polite");
  const card = document.createElement("div");
  card.className = "hg-load-card";
  const title = document.createElement("h1");
  const sub = document.createElement("p");
  sub.className = "hg-load-sub";
  const track = document.createElement("div");
  track.className = "hg-load-track";
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  const fill = document.createElement("div");
  fill.className = "hg-load-fill";
  track.appendChild(fill);
  const pct = document.createElement("div");
  pct.className = "hg-load-pct";
  card.append(title, sub, track, pct);
  root.appendChild(card);
  document.body.appendChild(root);
  // swallow input while loading: no swings into an unfinished world
  for (const type of ["keydown", "keyup", "pointerdown", "wheel"]) {
    root.addEventListener(type, (e) => e.stopPropagation());
  }

  let skinned = false;
  const skin = (): void => {
    if (skinned) return;
    const creation = opts.creation();
    if (!creation?.ui) return;
    skinned = true;
    const painting = creation.ui.scene ? opts.textureUrl(creation.ui.scene) : undefined;
    if (painting) root.style.backgroundImage = `url("${painting}")`;
    const panel = creation.ui.panel ? opts.textureUrl(creation.ui.panel.texture) : undefined;
    if (panel) root.style.setProperty("--load-panel", `url("${panel}")`);
  };

  let armed = false; // the screen is up (or fading)
  let startedAt = 0;
  let calmSince = 0; // performance.now() since which no frame was a hitch
  let maxLoading = 1; // the most streaming work seen this load, for the bar
  let lastFrame = performance.now();
  let raf = 0;
  let fadeTimer: ReturnType<typeof setTimeout> | undefined;
  let shownProgress = 0;
  let wasWanted = false;

  const arm = (): void => {
    armed = true;
    startedAt = performance.now();
    calmSince = startedAt;
    maxLoading = 1;
    shownProgress = 0;
    clearTimeout(fadeTimer);
    skin();
    root.classList.remove("out");
    root.hidden = false;
  };
  const release = (): void => {
    armed = false;
    root.classList.add("out");
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
      if (!armed) root.hidden = true;
    }, 650);
  };

  const phaseOf = (s: LoadSignals): Phase => {
    if (!s.connected()) return "connect";
    if (!s.hasBody() || s.switching()) return "body";
    if (s.loading() > 0) return "stream";
    return "settle";
  };

  const tick = (): void => {
    raf = requestAnimationFrame(tick);
    const now = performance.now();
    const frame = now - lastFrame;
    lastFrame = now;
    const s = opts.signals;
    if (!s.wanted()) {
      wasWanted = false;
      if (armed) release();
      return;
    }
    const phase = phaseOf(s);
    // entering the world, or the world went away again (a switch, a transfer, the body or the link lost) — but
    // never for ordinary streaming as the player walks: that is the world working, not loading
    if (!armed && (!wasWanted || phase === "connect" || phase === "body")) arm();
    wasWanted = true;
    if (!armed) return;
    if (frame > SETTLE_FRAME_MS || phase !== "settle") calmSince = now;
    const loading = s.loading();
    maxLoading = Math.max(maxLoading, loading);
    const calm = Math.min(1, (now - calmSince) / 1000 / SETTLE_SECONDS);
    // the bar: connect 15 · body 15 · streaming 45 · settling 25
    const target =
      phase === "connect"
        ? 0.05
        : phase === "body"
          ? 0.2
          : phase === "stream"
            ? 0.3 + 0.45 * (1 - loading / maxLoading)
            : 0.75 + 0.25 * calm;
    shownProgress = Math.max(shownProgress, target); // never goes backwards
    fill.style.transform = `scaleX(${shownProgress.toFixed(3)})`;
    track.setAttribute("aria-valuenow", String(Math.round(shownProgress * 100)));
    pct.textContent = `${Math.round(shownProgress * 100)}%`;
    const place = s.place();
    title.textContent = place || "Entering the world";
    sub.textContent =
      phase === "connect"
        ? "Reaching the server…"
        : phase === "body"
          ? "Waiting for your character…"
          : phase === "stream"
            ? `Raising the land… ${loading} part${loading === 1 ? "" : "s"} left`
            : "Settling in…";
    const elapsed = (now - startedAt) / 1000;
    const settled = phase === "settle" && (now - calmSince) / 1000 >= SETTLE_SECONDS;
    if ((settled && elapsed >= MIN_SECONDS) || elapsed >= MAX_SECONDS) {
      if (!settled) console.warn(`[load-screen] let through after ${MAX_SECONDS}s (phase ${phase}, ${loading} still loading)`);
      shownProgress = 1;
      fill.style.transform = "scaleX(1)";
      release();
    }
  };
  raf = requestAnimationFrame(tick);

  return {
    showing: () => armed,
    dispose: () => {
      cancelAnimationFrame(raf);
      clearTimeout(fadeTimer);
      root.remove();
      style.remove();
    },
  };
}
