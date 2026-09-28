/**
 * The character creation screen — name, archetype, birth trait and looks,
 * with the body turning in a live preview between the choices.
 *
 * Everything on it comes from a `creation` data asset (core
 * `characterCreationSchema`): the archetypes, the traits, the appearance
 * slots, their icons — and its LOOK. The asset's optional `ui` block names the
 * game's own UI pieces (9-slice panel/slot/button frames, crest, divider,
 * stepper arrow, backdrop, font, colours), so the screen sits in the game's
 * world instead of the engine's; without one it draws the engine's plain dark
 * look. This file knows no game. Validation that matters happens on main and
 * again on the sheet authority — the screen only keeps the player from picking
 * what the rules already forbid (an option whose `requires` fails).
 *
 * A chosen card is marked by a "✓ Chosen" label and `aria-pressed`, not by
 * its lit frame alone.
 */

import {
  ATTRIBUTES,
  availableOptions,
  defaultBuild,
  settleAppearance,
  settleTraits,
  traitsFor,
  type Attribute,
  type CharacterBuild,
  type CharacterCreation,
  type CreationFrame,
} from "@hitreg/core";

/** The 3D half of the screen, supplied by the host (it owns the renderer and the model loader). */
export interface CreationPreview {
  /** Show this build (body model, socketed pieces). Called on every change. */
  update(build: CharacterBuild): void;
  /** Turn the model (radians) — the screen drags it. */
  setYaw(radians: number): void;
  dispose(): void;
}

export interface CreationScreenOptions {
  creation: CharacterCreation;
  /** Name typed before the screen opened, if any. */
  name?: string;
  /** Texture asset id → URL, for the skin and the icons. Without it the screen is unskinned. */
  textureUrl?: (id: string) => string | undefined;
  /** Mount the preview into the canvas; null/absent = the screen runs without one. */
  preview?: (canvas: HTMLCanvasElement) => CreationPreview | null;
  /** Make the character. Reject with a readable error to show it on the screen. */
  onCreate(name: string, build: CharacterBuild): Promise<void>;
  onCancel(): void;
}

export interface CreationScreen {
  close(): void;
}

const ATTRIBUTE_NAME: Record<Attribute, string> = {
  strength: "Strength",
  dexterity: "Dexterity",
  constitution: "Constitution",
  intelligence: "Intelligence",
  wisdom: "Wisdom",
};

/*
 * Layout and the plain look. Every colour/frame is a custom property on the
 * root so a skin only swaps values; `.hg-cc-skin` switches the frames on.
 * Panel frame geometry follows the game HUD's windows: the frame is drawn in
 * ::before over a transparent border, the darkened backdrop in ::after.
 */
const STYLE = `
.hg-cc{--cc-text:#c9d1d9;--cc-muted:#8b949e;--cc-heading:#e6edf3;--cc-accent:#58a6ff;--cc-surface:#161b22;--cc-font:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
position:fixed;inset:0;z-index:20001;display:flex;flex-direction:column;background:#0b0e14;font:13px/1.45 var(--cc-font);color:var(--cc-text);overflow:hidden}
.hg-cc *{box-sizing:border-box}
.hg-cc img{image-rendering:pixelated}
.hg-cc-back{position:absolute;inset:0;z-index:0;pointer-events:none}
.hg-cc-title{position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;padding:14px 0 4px}
.hg-cc-title h1{margin:0;font-size:22px;font-weight:600;color:var(--cc-heading);letter-spacing:.02em}
.hg-cc-title .hg-cc-crest{display:none}
.hg-cc-title .hg-cc-rule{display:none}
.hg-cc-main{position:relative;z-index:1;flex:1;min-height:0;width:100%;max-width:1560px;margin:0 auto;display:grid;grid-template-columns:minmax(360px,480px) 1fr minmax(290px,350px);gap:18px;padding:8px 22px 0}
.hg-cc-panel{position:relative;min-height:0;display:flex;flex-direction:column;background:#0d1117;border:1px solid #30363d;border-radius:8px}
.hg-cc-scroll{flex:1;min-height:0;overflow-y:auto;padding:14px 14px 10px;scrollbar-width:thin}
.hg-cc-sec{margin:0 0 16px}
.hg-cc-sec:last-child{margin-bottom:0}
.hg-cc-sec h2{margin:0 0 9px;font-size:11px;font-weight:600;color:var(--cc-muted);text-transform:uppercase;letter-spacing:.1em}
.hg-cc-sec h2 small{display:block;margin-top:2px;text-transform:none;letter-spacing:0;font-weight:400;font-size:11px;opacity:.85}
.hg-cc-icon{flex:none;width:58px;height:58px;display:grid;place-items:center;background:#0a0908;border-radius:5px}
.hg-cc-icon img{width:48px;height:48px;display:block}
.hg-cc-stage{position:relative;min-height:0;display:flex;flex-direction:column;align-items:center}
.hg-cc-stage canvas{flex:1;min-height:0;width:100%;cursor:grab;touch-action:none}
.hg-cc-stage canvas:active{cursor:grabbing}
.hg-cc-plinth{position:absolute;left:18%;right:18%;bottom:118px;height:40px;border-radius:50%;background:radial-gradient(ellipse at center,#000a 0%,transparent 70%);pointer-events:none}
.hg-cc-who{margin:2px 0 0;font-size:20px;color:var(--cc-heading);min-height:1.4em;text-align:center}
.hg-cc-whosub{color:var(--cc-muted);font-size:12px;text-align:center;min-height:1.4em}
.hg-cc-hint{color:var(--cc-muted);font-size:11px;opacity:.8;margin:2px 0 6px}
.hg-cc-actions{display:flex;gap:10px;align-items:center;justify-content:center;padding:4px 0 16px}
.hg-cc-err{min-height:1.4em;color:#ffa198;font-size:12px;text-align:center;margin-top:2px}
.hg-cc-btn{background:#21262d;border:1px solid #30363d;color:var(--cc-text);border-radius:6px;padding:8px 16px;font:inherit;cursor:pointer;min-width:120px}
.hg-cc-btn:hover{filter:brightness(1.25)}
.hg-cc-btn.hg-cc-primary{background:#1f6feb;border-color:#1f6feb;color:#fff;font-weight:600;min-width:190px}
.hg-cc-btn:disabled{opacity:.55;cursor:default;filter:none}
.hg-cc-name{width:100%;background:var(--cc-surface);border:1px solid #30363d;border-radius:6px;color:var(--cc-heading);padding:9px 11px;font:inherit;font-size:15px;outline:none}
.hg-cc-name:focus{border-color:var(--cc-accent)}
.hg-cc-rows{display:flex;flex-direction:column;gap:8px}
.hg-cc-row{display:grid;grid-template-columns:62px 1fr;align-items:center;gap:8px}
.hg-cc-row .hg-cc-label{color:var(--cc-muted);font-size:12px}
.hg-cc-step{display:flex;align-items:center;gap:4px}
.hg-cc-step .hg-cc-val{flex:1;text-align:center;color:var(--cc-heading);background:var(--cc-surface);border:1px solid #30363d;padding:5px 4px;min-height:32px;line-height:20px}
.hg-cc-step .hg-cc-n{display:block;color:var(--cc-muted);font-size:10px;line-height:11px}
.hg-cc-arrow{flex:none;width:32px;height:32px;padding:0;background:#21262d;border:1px solid #30363d;border-radius:5px;color:var(--cc-text);font:16px/1 var(--cc-font);cursor:pointer}
.hg-cc-arrow:hover{filter:brightness(1.35)}
.hg-cc-arrow:disabled{opacity:.35;cursor:default;filter:none}
.hg-cc-close{position:absolute;right:18px;top:14px;z-index:2;width:34px;height:34px;padding:0;background:#21262d;border:1px solid #30363d;border-radius:6px;color:var(--cc-text);font-size:16px;cursor:pointer}
.hg-cc-sum{display:flex;flex-direction:column;gap:3px;font-size:12px}
.hg-cc-sum div{display:flex;justify-content:space-between;gap:10px;border-bottom:1px solid #ffffff10;padding:2px 0}
.hg-cc-sum span:first-child{color:var(--cc-muted)}
.hg-cc-sum b{font-weight:normal;color:var(--cc-heading)}
.hg-cc-sum .hg-cc-up{color:var(--cc-accent)}

/* -- skinned: the game's own frames -------------------------------------- */
.hg-cc.hg-cc-skin{background:#070606;text-shadow:0 1px 2px #000}
.hg-cc-skin .hg-cc-back{background:radial-gradient(ellipse at 50% 55%,#2a221899 0%,#0a0908f2 62%,#050404 100%),var(--cc-backdrop,none);background-size:auto,198px 176px;image-rendering:pixelated}
.hg-cc-skin .hg-cc-title{padding:6px 0 0}
.hg-cc-skin .hg-cc-title .hg-cc-crest{display:block;width:45px;height:48px;margin-bottom:-2px;filter:drop-shadow(0 3px 4px #000)}
.hg-cc-skin .hg-cc-title h1{font-weight:normal;font-size:24px;text-transform:uppercase;letter-spacing:.2em}
.hg-cc-skin .hg-cc-title .hg-cc-rule{display:block;width:min(380px,60vw);height:auto;margin-top:-8px}
.hg-cc-skin .hg-cc-panel{isolation:isolate;background:none;border-radius:0;border:calc(var(--cc-panel-border) - 12px) solid transparent;margin:6px 0 22px;align-self:start;max-height:calc(100% - 28px)}
.hg-cc-skin .hg-cc-panel::before{content:"";position:absolute;inset:calc(12px - var(--cc-panel-border));pointer-events:none;border:var(--cc-panel-border) solid transparent;border-image:var(--cc-panel) var(--cc-panel-slice) / var(--cc-panel-border) var(--cc-panel-repeat);z-index:-1;image-rendering:pixelated}
.hg-cc-skin .hg-cc-panel::after{content:"";position:absolute;inset:-4px -13px;background:linear-gradient(#121110eb,#121110f0),var(--cc-backdrop,none);background-size:auto,198px 176px;z-index:-2;pointer-events:none}
.hg-cc-skin .hg-cc-scroll{padding:6px 8px 6px 4px;scrollbar-color:#826844 #15120e}
.hg-cc-skin .hg-cc-sec h2{font-weight:normal;font-size:15px;color:var(--cc-heading);letter-spacing:.14em;border-bottom:1px solid #645039;padding-bottom:6px}
.hg-cc-skin .hg-cc-sec h2 small{font-size:12px;letter-spacing:.02em;font-style:italic;color:var(--cc-muted)}
.hg-cc-skin .hg-cc-icon{background:none;border-radius:0;border:var(--cc-card-border) solid transparent;border-image:var(--cc-card) var(--cc-card-slice) / var(--cc-card-border) stretch;padding:0}
.hg-cc-skin .hg-cc-who{font-size:22px;letter-spacing:.08em}
.hg-cc-skin .hg-cc-btn{border-radius:0;color:var(--cc-text);font:13px var(--cc-font);text-transform:uppercase;letter-spacing:.08em;background:#191714;background-clip:padding-box;border:var(--cc-button-border) solid transparent;border-image:var(--cc-button) var(--cc-button-slice) / var(--cc-button-border) stretch;min-height:44px;padding:4px 18px}
.hg-cc-skin .hg-cc-btn:hover{filter:brightness(1.5);color:#ffe5a9}
.hg-cc-skin .hg-cc-btn.hg-cc-primary{font-weight:normal;color:#f4dca8;background:#2b1c10;border-image:var(--cc-button-on) var(--cc-button-on-slice) / var(--cc-button-border) stretch}
.hg-cc-skin .hg-cc-name{border-radius:0;background:#080807;border:1px solid #655036;color:#e9d9b8;font:16px var(--cc-font);letter-spacing:.04em}
.hg-cc-skin .hg-cc-name:focus{border-color:#b18b4b;box-shadow:0 0 8px #bd803a44}
.hg-cc-skin .hg-cc-step .hg-cc-val{border-radius:0;background:#0d0c0a;border:1px solid #57442a;font-size:14px}
.hg-cc-skin.hg-cc-arrows .hg-cc-arrow{width:30px;height:28px;border:0;border-radius:0;background:var(--cc-arrow) center/100% 100% no-repeat;font-size:0;image-rendering:pixelated;filter:drop-shadow(0 2px 2px #000)}
.hg-cc-skin.hg-cc-arrows .hg-cc-arrow.hg-cc-left{transform:scaleX(-1)}
.hg-cc-skin.hg-cc-arrows .hg-cc-arrow:hover{filter:brightness(1.45) drop-shadow(0 2px 2px #000)}
.hg-cc-skin .hg-cc-arrow{border-radius:0;background:#191714;border:1px solid #6c5130;color:#e4c080}
.hg-cc-skin .hg-cc-close{border:0;border-radius:0;background:var(--cc-close) center/100% 100% no-repeat;font-size:0;width:44px;height:44px;image-rendering:pixelated;filter:drop-shadow(0 2px 3px #000)}
.hg-cc-skin .hg-cc-close:hover{filter:brightness(1.5) drop-shadow(0 2px 3px #000)}
.hg-cc-skin .hg-cc-sum div{border-color:#56462f66}
.hg-cc-skin .hg-cc-err{color:#eeb88a}
@media (max-width:1100px){.hg-cc-main{grid-template-columns:minmax(300px,1fr) minmax(220px,.8fr) minmax(260px,.9fr);gap:10px;padding:6px 10px 0}}
@media (max-width:820px){.hg-cc{overflow-y:auto}.hg-cc-main{display:flex;flex-direction:column}.hg-cc-stage{min-height:50vh}.hg-cc-panel{flex:none}}
@media (max-height:820px){
.hg-cc-tile{padding:8px 4px 6px!important;gap:4px!important}
.hg-cc-detail{margin-top:6px!important;padding:6px 10px!important}
.hg-cc-skin .hg-cc-title .hg-cc-crest{display:none}
.hg-cc-skin .hg-cc-title h1,.hg-cc-title h1{font-size:19px}
.hg-cc-skin .hg-cc-title .hg-cc-rule{width:min(300px,50vw);margin-top:-10px}
.hg-cc-sec h2 small{display:none}
.hg-cc-sec{margin-bottom:10px}
.hg-cc-actions{padding-bottom:10px}}
@media (prefers-reduced-motion:reduce){.hg-cc *{transition:none!important}}

/* -- choices: 9-slice buttons with the icon centred, details underneath -- */
.hg-cc-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:10px}
.hg-cc-swatchrow{grid-template-columns:62px 1fr}
.hg-cc-swatchname{text-align:right;color:var(--cc-heading);font-size:13px}
.hg-cc-swatches{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:5px;margin-top:-2px}
.hg-cc-swatch{position:relative;width:27px;height:27px;padding:0;border:2px solid #30363d;border-radius:4px;cursor:pointer}
.hg-cc-swatch:hover{filter:brightness(1.15)}
.hg-cc-swatch[aria-pressed="true"]{border-color:var(--cc-accent);box-shadow:0 0 0 1px #000,0 0 8px var(--cc-accent)}
.hg-cc-swatch[aria-pressed="true"]::after{content:"✓";position:absolute;inset:0;display:grid;place-items:center;color:#fff;font-size:13px;text-shadow:0 0 2px #000,0 1px 2px #000}
.hg-cc-swatch[data-light][aria-pressed="true"]::after{color:#1a120c;text-shadow:0 0 2px #fff,0 0 3px #fff}
.hg-cc-skin .hg-cc-swatch{border-radius:0;border-color:#57442a;box-shadow:inset 0 2px 0 #ffffff2a,inset 0 -2px 0 #00000055}
.hg-cc-skin .hg-cc-swatch[aria-pressed="true"]{border-color:#f0cd85;box-shadow:inset 0 2px 0 #ffffff2a,inset 0 -2px 0 #00000055,0 0 8px #d7a445aa}
.hg-cc-skin .hg-cc-swatchname{font-size:14px;color:#e4c080}
.hg-cc-tick{position:absolute;top:3px;right:6px;font-size:14px;line-height:1;color:var(--cc-accent)}
.hg-cc-skin .hg-cc-tick{color:#f0cd85;text-shadow:0 0 6px #d7a445aa,0 1px 2px #000}
.hg-cc-tile{position:relative;display:flex;flex-direction:column;align-items:center;gap:7px;padding:12px 6px 10px;background:var(--cc-surface);border:1px solid #30363d;border-radius:7px;color:inherit;font:inherit;cursor:pointer;text-align:center}
.hg-cc-tile:hover{filter:brightness(1.2)}
.hg-cc-tile[aria-pressed="true"]{border-color:var(--cc-accent);box-shadow:inset 0 0 0 1px var(--cc-accent)}
.hg-cc-tile .hg-cc-icon{width:72px;height:72px}.hg-cc-tile .hg-cc-icon img{width:64px;height:64px}
.hg-cc-tname{font-size:14px;line-height:1.2;color:var(--cc-muted)}
.hg-cc-tile[aria-pressed="true"] .hg-cc-tname{color:var(--cc-heading)}
.hg-cc-detail{margin-top:10px;padding:9px 12px;background:#ffffff08;border-left:2px solid var(--cc-accent)}
.hg-cc-detail+.hg-cc-detail{margin-top:6px}
.hg-cc-detail strong{display:block;font-size:15px;color:var(--cc-heading)}
.hg-cc-detail p{margin:3px 0 5px;color:var(--cc-muted);font-size:13px;line-height:1.4}
.hg-cc-dl{display:flex;gap:10px;font-size:12px;line-height:1.5}.hg-cc-dl span{flex:0 0 44px;color:var(--cc-muted)}.hg-cc-dl b{font-weight:normal;color:var(--cc-text)}
.hg-cc-skin .hg-cc-tile{border-radius:0;box-shadow:none;border:var(--cc-card-border) solid transparent;border-image:var(--cc-card) var(--cc-card-slice) / var(--cc-card-border) stretch;background:linear-gradient(#0d0b09e8,#0d0b09e8),var(--cc-backdrop,none);background-size:auto,198px 176px;background-clip:padding-box;padding:10px 4px 9px}
.hg-cc-skin .hg-cc-tile:hover{filter:brightness(1.3)}
.hg-cc-skin .hg-cc-tile[aria-pressed="true"]{border-image:var(--cc-card-on) var(--cc-card-on-slice) / var(--cc-card-border) stretch;background:radial-gradient(ellipse at 50% 38%,#d7a44533,transparent 68%),linear-gradient(#120e09e8,#120e09e8),var(--cc-backdrop,none);background-size:auto,auto,198px 176px;box-shadow:0 0 10px #d7a44533}
.hg-cc-skin .hg-cc-tile .hg-cc-icon{width:calc(64px + 2 * var(--cc-card-border));height:calc(64px + 2 * var(--cc-card-border))}
.hg-cc-skin .hg-cc-tile[aria-pressed="true"] .hg-cc-icon{border-image:var(--cc-card-on) var(--cc-card-on-slice) / var(--cc-card-border) stretch}
.hg-cc-skin .hg-cc-tname{font-size:15px;letter-spacing:.04em;color:#b8ac96}
.hg-cc-skin .hg-cc-tile[aria-pressed="true"] .hg-cc-tname{color:#f0cd85}
.hg-cc-skin .hg-cc-detail{background:#0a0908c0;border:1px solid #56462f;border-left:2px solid #b18b4b}
.hg-cc-skin .hg-cc-detail strong{font-weight:normal;font-size:17px;letter-spacing:.03em;color:#e4c080}
.hg-cc-skin .hg-cc-detail p{color:#b8ac96}
.hg-cc-skin .hg-cc-dl span{color:#a99b83;font-style:italic}.hg-cc-skin .hg-cc-dl b{color:#c8ae79}
`;

let styled = false;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** "+2 Strength · +1 Constitution", biggest first — or "no lean". */
export function describeLean(bonus: Partial<Record<Attribute, number>>): string {
  const parts = ATTRIBUTES.filter((a) => (bonus[a] ?? 0) !== 0)
    .sort((x, y) => bonus[y]! - bonus[x]!)
    .map((a) => `${bonus[a]! > 0 ? "+" : "−"}${Math.abs(bonus[a]!)} ${ATTRIBUTE_NAME[a]}`);
  return parts.length > 0 ? parts.join(" · ") : "no lean";
}

/**
 * The screens are laid out for 1080p; on a bigger monitor the whole thing is
 * scaled up (CSS zoom) so a 1440p or 4K screen sees the same composition,
 * not the same pixels spread thin. Never scaled DOWN — short screens have
 * their own compact rules. Returns the unsubscribe.
 */
export function watchUiScale(el: HTMLElement): () => void {
  const apply = (): void => {
    const scale = Math.max(1, Math.min(window.innerWidth / 1920, window.innerHeight / 1080));
    el.style.setProperty("zoom", String(Math.round(scale * 100) / 100));
  };
  apply();
  window.addEventListener("resize", apply);
  return () => window.removeEventListener("resize", apply);
}

/**
 * Apply the creation asset's `ui` block as custom properties + the
 * `hg-cc-skin` class on any root (the creation screen, the gateway card).
 */
export function applyCreationSkin(root: HTMLElement, creation: CharacterCreation, textureUrl: (id: string) => string | undefined): boolean {
  return applySkin(root, creation, (id) => (id ? textureUrl(id) : undefined));
}

function applySkin(root: HTMLElement, creation: CharacterCreation, url: (id: string | undefined) => string | undefined): boolean {
  const ui = creation.ui;
  if (!ui) return false;
  const set = (k: string, v: string | undefined): void => {
    if (v !== undefined) root.style.setProperty(k, v);
  };
  const img = (id: string | undefined): string | undefined => {
    const u = url(id);
    return u ? `url("${u}")` : undefined;
  };
  const frame = (name: string, f: CreationFrame | undefined, fallback?: CreationFrame): void => {
    const use = f ?? fallback;
    if (!use) return;
    set(`--cc-${name}`, img(use.texture));
    set(`--cc-${name}-slice`, String(use.slice));
    set(`--cc-${name}-border`, `${use.border}px`);
    set(`--cc-${name}-repeat`, use.repeat);
  };
  frame("panel", ui.panel);
  frame("button", ui.button);
  frame("button-on", ui.buttonActive, ui.button);
  frame("card", ui.card);
  frame("card-on", ui.cardActive, ui.card);
  set("--cc-backdrop", img(ui.backdrop));
  set("--cc-arrow", img(ui.arrow));
  // the image arrows only when the image exists; otherwise the text chevrons stay
  if (img(ui.arrow)) root.classList.add("hg-cc-arrows");
  set("--cc-close", img(ui.close));
  if (ui.font) set("--cc-font", ui.font);
  const c = ui.colors ?? {};
  set("--cc-text", c.text);
  set("--cc-muted", c.muted);
  set("--cc-heading", c.heading);
  set("--cc-accent", c.accent);
  set("--cc-surface", c.surface);
  root.classList.add("hg-cc-skin");
  return true;
}

export function mountCreationScreen(opts: CreationScreenOptions): CreationScreen {
  const { creation } = opts;
  if (!styled) {
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.appendChild(style);
    styled = true;
  }
  const url = (id: string | undefined): string | undefined => (id ? opts.textureUrl?.(id) : undefined);
  let build: CharacterBuild = defaultBuild(creation);
  let busy = false;

  const root = el("div", "hg-cc");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Create a character");
  // keys typed here are the player's, not the game's
  root.addEventListener("keydown", (e) => e.stopPropagation());
  const skinned = applySkin(root, creation, url);
  const unscale = watchUiScale(root);
  root.appendChild(el("div", "hg-cc-back"));

  // -- title
  const title = el("header", "hg-cc-title");
  const crestUrl = skinned ? url(creation.ui?.crest) : undefined;
  if (crestUrl) {
    const crest = el("img", "hg-cc-crest");
    crest.src = crestUrl;
    crest.alt = "";
    title.appendChild(crest);
  }
  title.appendChild(el("h1", "", "Create your character"));
  const ruleUrl = skinned ? url(creation.ui?.divider) : undefined;
  if (ruleUrl) {
    const rule = el("img", "hg-cc-rule");
    rule.src = ruleUrl;
    rule.alt = "";
    title.appendChild(rule);
  }
  const close = el("button", "hg-cc-close", "✕");
  close.type = "button";
  close.setAttribute("aria-label", "Back");
  close.title = "Back";

  // -- left: archetype + birth trait
  const left = el("section", "hg-cc-panel");
  left.setAttribute("aria-label", "Archetype and birth trait");
  const leftScroll = el("div", "hg-cc-scroll");
  left.appendChild(leftScroll);

  const archSec = el("section", "hg-cc-sec");
  const archHead = el("h2", "", "Archetype");
  archHead.appendChild(el("small", "", "A starting lean, not a class — every path stays open."));
  const archList = el("div", "hg-cc-choices");
  archList.setAttribute("role", "group");
  archList.setAttribute("aria-label", "Archetype");
  archSec.append(archHead, archList);

  const traitSec = el("section", "hg-cc-sec");
  const traitHead = el("h2", "", "Birth trait");
  const traitNote = el("small");
  traitHead.appendChild(traitNote);
  const traitList = el("div", "hg-cc-choices");
  traitList.setAttribute("role", "group");
  traitList.setAttribute("aria-label", "Birth trait");
  traitSec.append(traitHead, traitList);
  if (creation.traits.length === 0 || creation.traitPicks === 0) traitSec.hidden = true;
  leftScroll.append(archSec, traitSec);

  // -- centre: the model
  const stage = el("section", "hg-cc-stage");
  stage.setAttribute("aria-label", "Preview");
  const canvas = el("canvas");
  canvas.setAttribute("aria-label", "Character preview — drag to turn");
  const who = el("div", "hg-cc-who");
  const whoSub = el("div", "hg-cc-whosub");
  const hint = el("div", "hg-cc-hint", "drag to turn");
  const err = el("div", "hg-cc-err");
  err.setAttribute("role", "alert");
  const back = el("button", "hg-cc-btn", "Back");
  back.type = "button";
  const create = el("button", "hg-cc-btn hg-cc-primary", "Create character");
  create.type = "button";
  const actions = el("div", "hg-cc-actions");
  actions.append(back, create);
  stage.append(el("div", "hg-cc-plinth"), canvas, who, whoSub, hint, err, actions);

  // -- right: name, looks, what the lean does
  const right = el("section", "hg-cc-panel");
  right.setAttribute("aria-label", "Name and appearance");
  const rightScroll = el("div", "hg-cc-scroll");
  right.appendChild(rightScroll);
  const nameSec = el("section", "hg-cc-sec");
  const name = el("input", "hg-cc-name");
  name.placeholder = "3–20 letters";
  name.maxLength = 20;
  name.value = opts.name ?? "";
  name.setAttribute("aria-label", "Character name");
  name.autocomplete = "off";
  name.spellcheck = false;
  nameSec.append(el("h2", "", "Name"), name);
  const lookSec = el("section", "hg-cc-sec");
  const lookRows = el("div", "hg-cc-rows");
  lookSec.append(el("h2", "", "Appearance"), lookRows);
  if (creation.appearance.length === 0) lookSec.hidden = true;
  const sumSec = el("section", "hg-cc-sec");
  const sum = el("div", "hg-cc-sum");
  sum.setAttribute("aria-live", "polite");
  sumSec.append(el("h2", "", "Born"), sum);
  rightScroll.append(nameSec, lookSec, sumSec);

  const main = el("div", "hg-cc-main");
  main.append(left, stage, right);
  root.append(title, close, main);
  document.body.appendChild(root);

  // -- preview
  const preview = opts.preview?.(canvas) ?? null;
  let yaw = 0;
  let dragX: number | null = null;
  canvas.addEventListener("pointerdown", (e) => {
    dragX = e.clientX;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (dragX === null) return;
    yaw += (e.clientX - dragX) * 0.012;
    dragX = e.clientX;
    preview?.setYaw(yaw);
  });
  const endDrag = (): void => {
    dragX = null;
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  // -- render
  /**
   * One choice as a 9-slice button: the icon centred in its own slot, the
   * name under it. Chosen = the lit frame AND a ✓ before the name.
   */
  const tile = (opt: { name: string; blurb: string; icon?: string | undefined; pressed: boolean; pick: () => void }): HTMLButtonElement => {
    const b = el("button", "hg-cc-tile");
    b.type = "button";
    b.setAttribute("aria-pressed", opt.pressed ? "true" : "false");
    b.setAttribute("aria-label", `${opt.name}${opt.pressed ? " (chosen)" : ""}${opt.blurb ? `: ${opt.blurb}` : ""}`);
    const frame = el("span", "hg-cc-icon");
    const iconUrl = url(opt.icon);
    if (iconUrl) {
      const img = el("img");
      img.src = iconUrl;
      img.alt = "";
      frame.appendChild(img);
    } else frame.textContent = opt.name.slice(0, 1);
    b.append(frame, el("span", "hg-cc-tname", opt.name));
    if (opt.pressed) {
      const tick = el("span", "hg-cc-tick", "✓");
      tick.setAttribute("aria-hidden", "true");
      b.appendChild(tick);
    }
    b.onclick = opt.pick;
    return b;
  };

  /** What the chosen tile means, under the row. */
  const detail = (name: string, blurb: string, lines: Array<[string, string]>): HTMLElement => {
    const d = el("div", "hg-cc-detail");
    d.append(el("strong", "", name));
    if (blurb) d.append(el("p", "", blurb));
    for (const [label, value] of lines) {
      const row = el("div", "hg-cc-dl");
      row.append(el("span", "", label), el("b", "", value));
      d.append(row);
    }
    return d;
  };

  const renderArchetypes = (): void => {
    const row = el("div", "hg-cc-tiles");
    row.append(
      ...creation.archetypes.map((a, i) =>
        tile({
          name: a.name,
          blurb: a.blurb,
          icon: a.icon,
          pressed: build.archetype === a.id,
          pick: () => {
            build = { ...build, archetype: a.id, traits: settleTraits(creation, a.id, build.traits) };
            changed();
            (archList.querySelectorAll(".hg-cc-tile")[i] as HTMLButtonElement | undefined)?.focus();
          },
        }),
      ),
    );
    const a = creation.archetypes.find((x) => x.id === build.archetype);
    const lines: Array<[string, string]> = [];
    if (a) {
      lines.push(["Lean", describeLean(a.attributes)]);
      if (a.branches.length > 0) lines.push(["Paths", a.branches.join(" · ")]);
    }
    archList.replaceChildren(row, ...(a ? [detail(a.name, a.blurb, lines)] : []));
  };

  const renderTraits = (): void => {
    const arch = creation.archetypes.find((a) => a.id === build.archetype);
    const gifts = creation.traitPicks === 1 ? "One gift" : `${creation.traitPicks} gifts`;
    traitNote.textContent = `${gifts} you are born with${arch && creation.traits.some((t) => t.archetypes) ? ` — the ${arch.name} births` : ""}.`;
    const offered = traitsFor(creation, build.archetype);
    const row = el("div", "hg-cc-tiles");
    row.append(
      ...offered.map((t, i) => {
        const chosen = build.traits.includes(t.id);
        return tile({
          name: t.name,
          blurb: t.blurb,
          icon: t.icon,
          pressed: chosen,
          pick: () => {
            let traits: string[];
            if (creation.traitPicks === 1) traits = [t.id];
            else if (chosen) traits = build.traits.filter((id) => id !== t.id);
            else traits = [...build.traits, t.id].slice(-creation.traitPicks); // over the limit drops the oldest pick
            build = { ...build, traits };
            changed();
            (traitList.querySelectorAll(".hg-cc-tile")[i] as HTMLButtonElement | undefined)?.focus();
          },
        });
      }),
    );
    const details = build.traits.flatMap((id) => {
      const t = creation.traits.find((d) => d.id === id);
      return t ? [detail(t.name, t.blurb, [])] : [];
    });
    traitList.replaceChildren(row, ...details);
  };

  const renderLooks = (focus?: { slot: string; dir?: -1 | 1; option?: string }): void => {
    lookRows.replaceChildren(
      ...creation.appearance.flatMap((slot) => {
        const offered = availableOptions(slot, build.appearance);
        // a slot nothing is offered in (lip colour on a male body) is not a choice right now
        if (offered.length === 0) return [];
        const pick = (id: string, f: { slot: string; dir?: -1 | 1; option?: string }): void => {
          build = { ...build, appearance: settleAppearance(creation, { ...build.appearance, [slot.id]: id }) };
          changed(f);
        };
        if (offered.every((o) => o.color)) {
          // colour choices: swatches, the chosen one named beside the label
          const row = el("div", "hg-cc-row hg-cc-swatchrow");
          const chosen = offered.find((o) => o.id === build.appearance[slot.id]);
          row.append(el("span", "hg-cc-label", slot.label), el("span", "hg-cc-swatchname", chosen?.label ?? ""));
          const swatches = el("div", "hg-cc-swatches");
          swatches.setAttribute("role", "group");
          swatches.setAttribute("aria-label", slot.label);
          for (const o of offered) {
            const b = el("button", "hg-cc-swatch");
            b.type = "button";
            b.style.background = o.color!;
            // the ✓ must read on porcelain and on ebony alike
            const hex = parseInt(o.color!.slice(1), 16);
            const luma = 0.299 * (hex >> 16) + 0.587 * ((hex >> 8) & 255) + 0.114 * (hex & 255);
            if (luma > 150) b.dataset["light"] = "";
            b.title = o.label;
            b.setAttribute("aria-label", o.label);
            b.setAttribute("aria-pressed", o.id === chosen?.id ? "true" : "false");
            b.onclick = () => pick(o.id, { slot: slot.id, option: o.id });
            swatches.appendChild(b);
            if (focus?.slot === slot.id && focus.option === o.id) queueMicrotask(() => b.focus());
          }
          row.appendChild(swatches);
          return [row];
        }
        const row = el("div", "hg-cc-row");
        row.appendChild(el("span", "hg-cc-label", slot.label));
        const step = el("div", "hg-cc-step");
        const at = Math.max(0, offered.findIndex((o) => o.id === build.appearance[slot.id]));
        const prev = el("button", "hg-cc-arrow hg-cc-left", "‹");
        const next = el("button", "hg-cc-arrow", "›");
        prev.type = next.type = "button";
        prev.setAttribute("aria-label", `previous ${slot.label.toLowerCase()}`);
        next.setAttribute("aria-label", `next ${slot.label.toLowerCase()}`);
        prev.disabled = next.disabled = offered.length < 2;
        const val = el("span", "hg-cc-val", offered[at]?.label ?? "—");
        val.appendChild(el("span", "hg-cc-n", `${at + 1} of ${offered.length}`));
        val.setAttribute("aria-live", "polite");
        const go = (dir: -1 | 1): void => {
          const option = offered[(at + dir + offered.length) % offered.length];
          if (option) pick(option.id, { slot: slot.id, dir });
        };
        prev.onclick = () => go(-1);
        next.onclick = () => go(1);
        step.append(prev, val, next);
        row.appendChild(step);
        if (focus?.slot === slot.id && focus.dir) queueMicrotask(() => (focus.dir! < 0 ? prev : next).focus());
        return [row];
      }),
    );
  };

  const renderSummary = (): void => {
    const arch = creation.archetypes.find((a) => a.id === build.archetype);
    const traits = build.traits.map((id) => creation.traits.find((t) => t.id === id)?.name ?? id);
    who.textContent = name.value.trim() || "Unnamed";
    whoSub.textContent = [arch?.name, ...traits].filter(Boolean).join(" · ");
    sum.replaceChildren(
      ...ATTRIBUTES.map((a) => {
        const bonus = arch?.attributes[a] ?? 0;
        const row = el("div");
        row.appendChild(el("span", "", ATTRIBUTE_NAME[a]));
        const v = el("b", bonus !== 0 ? "hg-cc-up" : "", bonus === 0 ? "—" : `${bonus > 0 ? "+" : "−"}${Math.abs(bonus)}`);
        if (bonus !== 0) v.setAttribute("aria-label", `${bonus > 0 ? "plus" : "minus"} ${Math.abs(bonus)}`);
        row.appendChild(v);
        return row;
      }),
    );
  };

  const ready = (): string | null => {
    const n = name.value.trim();
    if (!/^[A-Za-z][A-Za-z' -]{1,18}[A-Za-z]$/.test(n)) return "Your name must be 3–20 letters (spaces, ' and - inside are fine).";
    if (creation.traitPicks > 0 && build.traits.length !== creation.traitPicks) {
      return `Pick ${creation.traitPicks === 1 ? "a birth trait" : `${creation.traitPicks} birth traits`}.`;
    }
    return null;
  };

  const changed = (focus?: { slot: string; dir?: -1 | 1; option?: string }): void => {
    renderArchetypes();
    renderTraits();
    renderLooks(focus);
    renderSummary();
    err.textContent = "";
    preview?.update(build);
  };

  name.addEventListener("input", () => {
    renderSummary();
    err.textContent = "";
  });

  const submit = async (): Promise<void> => {
    if (busy) return;
    const problem = ready();
    if (problem) {
      err.textContent = problem;
      if (problem.startsWith("Your name")) name.focus();
      return;
    }
    busy = true;
    create.disabled = back.disabled = close.disabled = true;
    err.textContent = "";
    try {
      await opts.onCreate(name.value.trim(), build);
    } catch (error) {
      err.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
      create.disabled = back.disabled = close.disabled = false;
    }
  };
  const cancel = (): void => {
    if (!busy) opts.onCancel();
  };
  create.onclick = () => void submit();
  back.onclick = cancel;
  close.onclick = cancel;
  name.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void submit();
  });
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") cancel();
  });

  changed();
  name.focus();

  return {
    close: () => {
      unscale();
      preview?.dispose();
      root.remove();
    },
  };
}
