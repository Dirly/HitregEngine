/**
 * The Graphics panel's controls, shared by both hosts. A game's HUD owns the window (its frame, close button, dragging,
 * Esc) and hands over an element on `hitreg:graphics-panel` with `detail.parent`; this fills it. The game styles the
 * `gfx-*` classes to match itself; the host never needs to know what the HUD looks like.
 */
import { PRESET_TIERS, RENDER_SCALES, SHADOW_LEVELS, type GraphicsController, type GraphicsPreset, type GraphicsValues, type RenderScaleChoice, type ShadowLevel } from "./graphics-settings.js";

export const GRAPHICS_PANEL_EVENT = "hitreg:graphics-panel";

const PRESET_LABEL: Record<GraphicsPreset, string> = { auto: "Auto", low: "Low", medium: "Medium", high: "High", ultra: "Ultra", custom: "Custom" };
const SHADOW_LABEL: Record<ShadowLevel, string> = { off: "Off", low: "Low", medium: "Medium", high: "High", ultra: "Ultra" };
const percent = (value: number): string => `${Math.round(value * 100)}%`;
const scaleLabel = (value: RenderScaleChoice): string => (value === "auto" ? "Auto (follows the frame)" : percent(value));

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  node.textContent = text;
  return node;
}

export function row(label: string, note: string, control: HTMLElement, value?: HTMLElement): HTMLElement {
  const wrap = el("label", "gfx-row");
  const head = el("span", "gfx-head");
  head.append(el("span", "gfx-name", label));
  if (value) head.append(value);
  wrap.append(head, control, el("small", "gfx-note", note));
  return wrap;
}

function select<T extends string | number>(options: readonly T[], label: (value: T) => string, onPick: (value: T) => void): { control: HTMLSelectElement; set(value: T): void } {
  const control = el("select", "gfx-select");
  for (const [i, option] of options.entries()) control.append(Object.assign(el("option", "", label(option)), { value: String(i) }));
  control.onchange = () => onPick(options[Number(control.value)]!);
  return {
    control,
    set(value) {
      const i = options.indexOf(value);
      if (i >= 0) control.value = String(i);
      else {
        // a value no list offers (hand-edited storage): show it rather than claim another
        control.append(Object.assign(el("option", "", label(value)), { value: "-1" }));
        control.value = "-1";
      }
    },
  };
}

/**
 * Slider. The label follows the thumb; the engine hears only the release, since each change re-places the grass or moves
 * the streamed rings.
 */
function slider(min: number, max: number, onCommit: (value: number) => void): { control: HTMLInputElement; output: HTMLElement; set(value: number): void } {
  const control = el("input", "gfx-range");
  Object.assign(control, { type: "range", min: String(min * 100), max: String(max * 100), step: "5" });
  const output = el("output", "gfx-value");
  control.oninput = () => { output.textContent = `${control.value}%`; };
  control.onchange = () => onCommit(Number(control.value) / 100);
  return {
    control,
    output,
    set(value) {
      control.value = String(Math.round(value * 100));
      output.textContent = percent(value);
    },
  };
}

/** Fill `parent` with the controls; they follow the settings until `parent` empties or leaves the document. */
export function mountGraphicsPanel(parent: HTMLElement, graphics: GraphicsController): () => void {
  parent.replaceChildren();
  const root = el("div", "gfx-panel");
  // keys typed on a control must not walk the character or fire hotbar slots; Esc still closes the window
  root.addEventListener("keydown", (event) => { if (event.key !== "Escape") event.stopPropagation(); });

  const presets = el("div", "gfx-presets");
  presets.setAttribute("role", "group");
  presets.setAttribute("aria-label", "Graphics preset");
  const presetButtons = new Map<GraphicsPreset, HTMLButtonElement>();
  for (const preset of ["auto", ...PRESET_TIERS] as GraphicsPreset[]) {
    const button = el("button", "gfx-preset", PRESET_LABEL[preset]);
    button.type = "button";
    button.onclick = () => graphics.choosePreset(preset);
    presets.append(button);
    presetButtons.set(preset, button);
  }
  const status = el("p", "gfx-status");
  status.setAttribute("role", "status");

  const change = (field: Partial<GraphicsValues>): void => graphics.change(field);
  const renderScale = select<RenderScaleChoice>(RENDER_SCALES, scaleLabel, (value) => change({ renderScale: value }));
  const shadows = select<ShadowLevel>(SHADOW_LEVELS, (value) => SHADOW_LABEL[value], (value) => change({ shadows: value }));
  const ao = select<"on" | "off">(["on", "off"], (value) => (value === "on" ? "On" : "Off"), (value) => change({ ao: value === "on" }));
  const grass = slider(0, 1, (value) => change({ grass: value }));
  const weather = slider(0, 1, (value) => change({ weather: value }));
  const lod = slider(0.5, 1.25, (value) => change({ lod: value }));
  const drawDistance = slider(0.5, 1.25, (value) => change({ drawDistance: value }));

  const reload = el("p", "gfx-note gfx-reload", "Shadow sharpness changes the next time the game loads. Shadow distance has already changed.");
  reload.setAttribute("role", "status");
  const scaleRow = row("Render scale", "Fewer pixels: the biggest gain on a weak graphics card. The HUD stays sharp.", renderScale.control);
  root.append(
    presets,
    status,
    scaleRow,
    row("Shadows", "Off stops the sun's shadow passes; cloud shade stays.", shadows.control),
    row("Ambient occlusion", "Soft shading in corners and creases. Off saves a little on a weak graphics card.", ao.control),
    row("Grass", "Off clears ground cover. Thins the field, never moves it.", grass.control, grass.output),
    row("Rain and weather", "Falling particles only. The sky still turns.", weather.control, weather.output),
    row("Level of detail", "Lower: trees turn flat and small props drop out closer to you.", lod.control, lod.output),
    row("Draw distance", "How far the world streams in. Takes a few seconds to settle. Far hills stay.", drawDistance.control, drawDistance.output),
    el("p", "gfx-note", "Settings apply at once and are kept on this device."),
    reload,
  );
  parent.append(root);

  const refresh = (): void => {
    const s = graphics.settings;
    for (const [preset, button] of presetButtons) {
      const active = preset === s.preset;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    status.textContent = s.preset === "auto"
      ? `Auto is on ${PRESET_LABEL[graphics.autoTier]}: it steps down if frames stay slow.`
      : s.preset === "custom" ? "Custom: your own mix." : "";
    reload.hidden = !graphics.shadowMapNeedsReload;
    renderScale.set(s.renderScale);
    renderScale.control.disabled = graphics.renderScalePinnedByUrl;
    shadows.set(s.shadows);
    ao.set(s.ao ? "on" : "off");
    grass.set(s.grass);
    weather.set(s.weather);
    lod.set(s.lod);
    drawDistance.set(s.drawDistance);
  };
  refresh();
  const unsubscribe = graphics.subscribe(() => {
    if (root.isConnected) refresh();
    else unsubscribe();
  });
  return unsubscribe;
}

/** Answer the HUD's request for the panel. A second request (the window reopened) rebuilds it. */
export function listenForGraphicsPanel(graphics: GraphicsController): void {
  let release: (() => void) | null = null;
  window.addEventListener(GRAPHICS_PANEL_EVENT, (event) => {
    const parent = (event as CustomEvent<{ parent?: HTMLElement }>).detail?.parent;
    if (!parent) return;
    release?.();
    release = mountGraphicsPanel(parent, graphics);
  });
}
