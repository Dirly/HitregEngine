/**
 * The curtain a portal trip draws over the scene swap (docs/hosting.md →
 * "Portals"). A walk-through portal reads as walking into darkness: `ramp`
 * darkens the screen as the body goes down the passage toward the trigger,
 * `show` takes it the rest of the way to black and holds it across the swap,
 * `hide` fades the destination in once it has landed. The destination's name
 * only appears when the swap takes a while. Above every editor panel, so the
 * editor the swap passes through is never seen.
 *
 * Loading art (docs/hosting.md → "Loading art"): a destination with a
 * `loadingScreen` gets its painted cover over the black, full-screen (cover),
 * with its name and a thin progress line along the bottom. The art is drawn
 * with SMOOTH filtering on purpose: it is a painting stored at about half the
 * display resolution and scaled by whatever non-integer factor the window
 * needs, where nearest-neighbour would stair-step it unevenly; the house look
 * (2026-10-04) keeps pixel textures in the world but has no pixelate pass for
 * a full-screen image to match.
 */
export interface PortalCurtain {
  show(text: string): Promise<void>;
  setText(text: string): void;
  /**
   * Put loading art over the black (null takes it away). Resolves once the
   * image has decoded and started fading in, or after `waitMs` if it is slow
   * (it then fades in whenever it arrives, while the curtain still holds).
   */
  setArt(art: { url: string; title: string } | null, waitMs?: number): Promise<void>;
  /** 0..1 fills the progress line; null hides it (the plain curtain's sweep is unaffected). */
  setProgress(p: number | null): void;
  hide(): void;
  /** Partial darkness (0..1) while walking toward a trigger; ignored while a trip holds the curtain. */
  ramp(alpha: number): void;
  readonly visible: boolean;
}

const FADE_MS = 280;
/** the name fades in only when black lasts longer than this */
const TEXT_DELAY_MS = 700;

/**
 * Loading art for a scene document's text (its `loadingScreen` component), as
 * the URL `assetUrl` makes of `loading/<file>`. Parsed loosely: a scene that
 * fails to parse has no art, never a failed trip.
 */
export function loadingArtOf(
  sceneText: string | null,
  assetUrl: (rel: string) => string,
): { url: string; title: string | null } | null {
  if (!sceneText) return null;
  try {
    const doc = JSON.parse(sceneText) as { entities?: Record<string, { components?: Record<string, unknown> }> };
    for (const e of Object.values(doc.entities ?? {})) {
      const ls = e.components?.["loadingScreen"] as { image?: unknown; title?: unknown } | undefined;
      if (ls && typeof ls.image === "string" && /^loading\/[^\\]+\.(png|jpe?g|webp)$/i.test(ls.image)) {
        return { url: assetUrl(ls.image), title: typeof ls.title === "string" ? ls.title : null };
      }
    }
  } catch {
    /* no art */
  }
  return null;
}

export function mountPortalCurtain(): PortalCurtain {
  const el = document.createElement("div");
  el.className = "hr-portal-curtain";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.style.cssText =
    "position:fixed;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;gap:10px;pointer-events:none;" +
    `background:#000;color:#e6edf3;font:600 15px ui-monospace,monospace;letter-spacing:.04em;z-index:2000;opacity:0;transition:opacity ${FADE_MS}ms ease`;
  const label = document.createElement("div");
  label.style.cssText = `display:flex;flex-direction:column;align-items:center;gap:10px;opacity:0;transition:opacity ${FADE_MS}ms ease`;
  const text = document.createElement("div");
  const bar = document.createElement("div");
  bar.className = "hr-portal-sweep";
  bar.style.cssText = "width:120px;height:2px;background:linear-gradient(90deg,transparent,#8b9bb4,transparent);background-size:200% 100%";

  // -- loading art: the painting, a floor shade for the name, the name, a progress line
  const art = document.createElement("div");
  art.style.cssText = `position:absolute;inset:0;opacity:0;transition:opacity ${FADE_MS * 2}ms ease`;
  const img = document.createElement("img");
  img.alt = "";
  img.decoding = "async";
  img.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;image-rendering:auto;user-select:none";
  const shade = document.createElement("div");
  shade.style.cssText = "position:absolute;left:0;right:0;bottom:0;height:34%;background:linear-gradient(180deg,rgba(0,0,0,0),rgba(0,0,0,.78))";
  const foot = document.createElement("div");
  foot.style.cssText = "position:absolute;left:50%;bottom:7%;transform:translateX(-50%);width:min(560px,76vw);display:flex;flex-direction:column;align-items:center;gap:12px";
  const artTitle = document.createElement("div");
  artTitle.style.cssText = "font:600 18px ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:#e6edf3;text-shadow:0 1px 3px #000,0 0 14px rgba(0,0,0,.9);text-align:center";
  const track = document.createElement("div");
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  track.style.cssText = "width:100%;height:2px;background:rgba(48,54,61,.85);box-shadow:0 0 0 1px rgba(0,0,0,.6);overflow:hidden";
  const fill = document.createElement("div");
  fill.style.cssText = "height:100%;width:0%;background:#c9d1d9;transition:width 140ms linear";
  track.append(fill);
  foot.append(artTitle, track);
  art.append(img, shade, foot);

  const style = document.createElement("style");
  style.textContent =
    "@keyframes hr-portal-sweep{from{background-position:200% 0}to{background-position:-200% 0}}" +
    ".hr-portal-sweep{animation:hr-portal-sweep 1.1s linear infinite}" +
    "@media (prefers-reduced-motion: reduce){.hr-portal-sweep{animation:none}.hr-portal-curtain,.hr-portal-curtain *{transition-duration:0ms!important}}";
  label.append(text, bar);
  el.append(art, label, style);
  document.body.append(el);
  let visible = false;
  let rampAlpha = 0;
  let hasArt = false;
  let artToken = 0;
  let labelTimer: ReturnType<typeof setTimeout> | null = null;
  const clearArt = (): void => {
    artToken++;
    hasArt = false;
    art.style.opacity = "0";
    const old = img.src;
    img.removeAttribute("src");
    if (old.startsWith("blob:")) URL.revokeObjectURL(old);
    fill.style.width = "0%";
  };
  return {
    get visible() {
      return visible;
    },
    show(t: string): Promise<void> {
      text.textContent = t;
      const from = rampAlpha;
      visible = true;
      rampAlpha = 0;
      el.style.display = "flex";
      el.style.pointerEvents = "auto";
      el.style.transition = `opacity ${Math.round(FADE_MS * (1 - from))}ms ease`;
      // next frame, so the transition runs from where the walk left it
      requestAnimationFrame(() => (el.style.opacity = "1"));
      if (labelTimer) clearTimeout(labelTimer);
      labelTimer = setTimeout(() => {
        if (!hasArt) label.style.opacity = "1";
      }, TEXT_DELAY_MS);
      return new Promise((resolve) => setTimeout(resolve, FADE_MS * (1 - from) + 40));
    },
    setText(t: string): void {
      text.textContent = t;
    },
    async setArt(a, waitMs = 1500): Promise<void> {
      clearArt();
      if (!a) return;
      const token = artToken;
      artTitle.textContent = a.title;
      track.setAttribute("aria-label", `Loading ${a.title}`);
      // fetched as bytes: the dev asset bridge serves every file as octet-stream
      const load = (async () => {
        const res = await fetch(a.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const type = /\.jpe?g$/i.test(a.url) ? "image/jpeg" : /\.webp$/i.test(a.url) ? "image/webp" : "image/png";
        const blob = new Blob([await res.arrayBuffer()], { type });
        if (token !== artToken) return;
        img.src = URL.createObjectURL(blob);
        await img.decode();
        if (token !== artToken) return;
        hasArt = true;
        label.style.opacity = "0";
        art.style.opacity = "1";
      })().catch((e) => console.warn(`[portal] loading art ${a.url} did not load:`, e));
      await Promise.race([load, new Promise((r) => setTimeout(r, waitMs))]);
    },
    setProgress(p: number | null): void {
      if (p === null) {
        track.style.visibility = "hidden";
        return;
      }
      const v = Math.min(1, Math.max(0, p));
      track.style.visibility = "visible";
      fill.style.width = `${(v * 100).toFixed(1)}%`;
      track.setAttribute("aria-valuenow", String(Math.round(v * 100)));
    },
    hide(): void {
      visible = false;
      if (labelTimer) clearTimeout(labelTimer);
      labelTimer = null;
      label.style.opacity = "0";
      el.style.transition = `opacity ${FADE_MS * 2}ms ease`;
      el.style.opacity = "0";
      el.style.pointerEvents = "none";
      setTimeout(() => {
        if (visible) return;
        clearArt();
        if (rampAlpha === 0) el.style.display = "none";
      }, FADE_MS * 2);
    },
    ramp(alpha: number): void {
      if (visible) return;
      const a = Math.min(1, Math.max(0, alpha));
      if (Math.abs(a - rampAlpha) < 0.004) return;
      rampAlpha = a;
      el.style.transition = "none";
      if (a <= 0) {
        el.style.opacity = "0";
        el.style.display = "none";
        return;
      }
      el.style.display = "flex";
      el.style.opacity = String(a);
    },
  };
}
