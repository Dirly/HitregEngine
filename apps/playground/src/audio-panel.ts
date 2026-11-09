/**
 * The Audio panel's controls, shared by both hosts: the same arrangement as `graphics-panel.ts`. A game's HUD owns the
 * window and hands over an element on `hitreg:audio-panel` with `detail.parent`; this fills it, in the HUD's `gfx-*` classes.
 */
import { AUDIO_LEVELS, type AudioLevel, type AudioSettingsController } from "./audio-settings.js";
import { el, row } from "./graphics-panel.js";

export const AUDIO_PANEL_EVENT = "hitreg:audio-panel";

const LEVEL_TEXT: Record<AudioLevel, readonly [label: string, note: string]> = {
  master: ["Master", "Everything below passes through this."],
  music: ["Music", "Zone, town and combat tracks."],
  ambience: ["Ambience", "Wind, rain, fires, water, wildlife and bells."],
  effects: ["Effects", "Footsteps, combat and spells."],
  interface: ["Interface", "Windows, buttons and equipping gear."],
  voice: ["Voice", "Other players on voice chat."],
};

/** Fill `parent` with the controls; they follow the settings until the panel is rebuilt or leaves the document. */
export function mountAudioPanel(parent: HTMLElement, audio: AudioSettingsController): () => void {
  parent.replaceChildren();
  const root = el("div", "gfx-panel");
  // keys typed on a control must not walk the character or fire hotbar slots; Esc still closes the window
  root.addEventListener("keydown", (event) => { if (event.key !== "Escape") event.stopPropagation(); });

  const mute = el("button", "gfx-mute");
  mute.type = "button";
  mute.onclick = () => audio.change({ muted: !audio.settings.muted });
  root.append(mute);

  const sliders = AUDIO_LEVELS.map((level) => {
    const control = el("input", "gfx-range");
    Object.assign(control, { type: "range", min: "0", max: "100", step: "5" });
    const output = el("output", "gfx-value");
    // a gain change costs nothing, so the player hears the slider while dragging it
    control.oninput = () => audio.change({ [level]: Number(control.value) / 100 });
    const [label, note] = LEVEL_TEXT[level];
    root.append(row(label, note, control, output));
    return { level, control, output };
  });
  root.append(el("p", "gfx-note", "Settings apply at once and are kept on this device."));
  parent.append(root);

  const refresh = (): void => {
    const s = audio.settings;
    mute.textContent = s.muted ? "Sound is muted: unmute" : "Mute all sound";
    mute.classList.toggle("active", s.muted);
    mute.setAttribute("aria-pressed", String(s.muted));
    for (const { level, control, output } of sliders) {
      const percent = Math.round(s[level] * 100);
      control.value = String(percent);
      output.textContent = `${percent}%`;
    }
  };
  refresh();
  const unsubscribe = audio.subscribe(() => {
    if (root.isConnected) refresh();
    else unsubscribe();
  });
  return unsubscribe;
}

/** Answer the HUD's request for the panel. A second request (the window reopened) rebuilds it. */
export function listenForAudioPanel(audio: AudioSettingsController): void {
  let release: (() => void) | null = null;
  window.addEventListener(AUDIO_PANEL_EVENT, (event) => {
    const parent = (event as CustomEvent<{ parent?: HTMLElement }>).detail?.parent;
    if (!parent) return;
    release?.();
    release = mountAudioPanel(parent, audio);
  });
}
