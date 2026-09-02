/// <reference lib="dom" />
/**
 * Default comms overlay — a chat log + input and a voice strip, vanilla DOM
 * so any game can mount it without a UI framework (`@hitreg/comms/ui`).
 *
 * Keys: Enter opens the input (when not typing elsewhere), Enter sends,
 * Esc closes, Tab cycles the active channel, "/t hi" sends on a channel
 * once, "/team red" / "/party blue" request membership. Meaning is never
 * carried by color alone: every channel has a text glyph ([S]/[G]/[T]/[P]),
 * speaking peers get a ◉ marker, and the mic button says its state.
 *
 * Styling follows DESIGN.md's dark token set; override with the
 * `.hitreg-comms` CSS hooks or pass `className`.
 */

import { CHANNEL_META, COMMS_CHANNELS, parseChatInput, type CommsChannel } from "./channels.js";
import type { ChatMessage, ChatService } from "./chat.js";
import type { VoiceService, VoiceState } from "./voice.js";

export interface CommsUIOptions {
  chat: ChatService;
  voice?: VoiceService;
  /** Mount point (default: document.body). */
  parent?: HTMLElement;
  /** KeyboardEvent.code that opens the input (default "Enter"). */
  openKey?: string;
  /** Extra class on the root. */
  className?: string;
  /** Lines kept in the log (default 80). */
  maxLines?: number;
  /** Seconds a line stays fully visible after arrival while the input is closed (default 8). */
  fadeAfter?: number;
  /** Slash commands the app handles ("/ready", "/vote 3"). Return true if consumed. */
  onCommand?(name: string, args: string[]): boolean;
  /** Starting channel (default "proximity"). */
  channel?: CommsChannel;
}

export interface CommsUI {
  root: HTMLElement;
  /** Whether the text input currently has focus (games pause hotkeys on this). */
  isTyping(): boolean;
  open(): void;
  close(): void;
  setChannel(channel: CommsChannel): void;
  dispose(): void;
}

const STYLE_ID = "hitreg-comms-style";

const CSS = `
.hitreg-comms{position:fixed;left:12px;bottom:12px;width:min(420px,calc(100vw - 24px));
  font:12px/1.45 ui-sans-serif,system-ui,sans-serif;color:#c9d1d9;z-index:40;
  display:flex;flex-direction:column;gap:6px;pointer-events:none}
.hitreg-comms *{box-sizing:border-box}
.hitreg-comms-voice{display:flex;align-items:center;gap:6px;flex-wrap:wrap;pointer-events:auto}
.hitreg-comms-btn{background:#21262d;border:1px solid #30363d;color:#c9d1d9;border-radius:4px;
  padding:2px 8px;font:inherit;cursor:pointer}
.hitreg-comms-btn:hover{background:#30363d}
.hitreg-comms-btn[aria-pressed="true"]{background:#1f3a5f;border-color:#3b5b8a;color:#e6edf3}
.hitreg-comms-btn:focus-visible{outline:2px solid #79c0ff;outline-offset:1px}
.hitreg-comms-speakers{display:flex;gap:6px;flex-wrap:wrap;color:#8b949e}
.hitreg-comms-speaker{background:rgba(13,17,23,.7);border:1px solid #30363d;border-radius:4px;padding:1px 6px}
.hitreg-comms-speaker[data-speaking="true"]{color:#e6edf3;border-color:#79c0ff}
.hitreg-comms-log{display:flex;flex-direction:column;gap:2px;max-height:38vh;overflow-y:auto;
  padding:6px 8px;background:rgba(13,17,23,.55);border-radius:6px;pointer-events:auto;
  scrollbar-width:thin;transition:opacity .4s}
.hitreg-comms[data-open="false"] .hitreg-comms-log{background:transparent;pointer-events:none}
.hitreg-comms-line{white-space:pre-wrap;word-break:break-word;text-shadow:0 1px 2px rgba(0,0,0,.8);
  transition:opacity .6s}
.hitreg-comms-line[data-faded="true"]{opacity:0}
.hitreg-comms[data-open="true"] .hitreg-comms-line[data-faded="true"]{opacity:1}
.hitreg-comms-tag{font-family:ui-monospace,monospace;font-weight:600;margin-right:4px}
.hitreg-comms-line[data-channel="proximity"] .hitreg-comms-tag{color:#c9d1d9}
.hitreg-comms-line[data-channel="global"] .hitreg-comms-tag{color:#ffd633}
.hitreg-comms-line[data-channel="team"] .hitreg-comms-tag{color:#79c0ff}
.hitreg-comms-line[data-channel="party"] .hitreg-comms-tag{color:#d2a8ff}
.hitreg-comms-line[data-channel="system"]{color:#8b949e;font-style:italic}
.hitreg-comms-name{font-weight:600;color:#e6edf3;margin-right:4px}
.hitreg-comms-input{display:none;align-items:center;gap:6px;pointer-events:auto}
.hitreg-comms[data-open="true"] .hitreg-comms-input{display:flex}
.hitreg-comms-chan{font-family:ui-monospace,monospace;font-weight:600;background:#21262d;
  border:1px solid #30363d;border-radius:4px;padding:3px 6px;min-width:64px;text-align:center;cursor:pointer}
.hitreg-comms-field{flex:1;background:#161b22;border:1px solid #30363d;color:#e6edf3;border-radius:4px;
  padding:4px 8px;font:inherit}
.hitreg-comms-field:focus{outline:none;border-color:#79c0ff}
.hitreg-comms-hint{color:#8b949e;font-size:11px}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function mountCommsUI(opts: CommsUIOptions): CommsUI {
  ensureStyle();
  const { chat, voice } = opts;
  const parent = opts.parent ?? document.body;
  const openKey = opts.openKey ?? "Enter";
  const maxLines = opts.maxLines ?? 80;
  const fadeAfterMs = (opts.fadeAfter ?? 8) * 1000;
  let channel: CommsChannel = opts.channel ?? "proximity";
  let open = false;
  const unsubs: Array<() => void> = [];

  const root = el("div", `hitreg-comms${opts.className ? ` ${opts.className}` : ""}`);
  root.dataset["open"] = "false";
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "chat");

  // -- voice strip -------------------------------------------------------------------
  const voiceRow = el("div", "hitreg-comms-voice");
  const micBtn = el("button", "hitreg-comms-btn", "mic: off");
  micBtn.type = "button";
  const muteBtn = el("button", "hitreg-comms-btn", "mute");
  muteBtn.type = "button";
  const deafBtn = el("button", "hitreg-comms-btn", "deafen");
  deafBtn.type = "button";
  const modeBtn = el("button", "hitreg-comms-btn", "push-to-talk");
  modeBtn.type = "button";
  const speakers = el("div", "hitreg-comms-speakers");
  speakers.setAttribute("aria-live", "polite");
  if (voice) {
    voiceRow.append(micBtn, muteBtn, deafBtn, modeBtn, speakers);
    root.appendChild(voiceRow);
    micBtn.addEventListener("click", () => {
      if (voice.state().enabled) voice.disable();
      else void voice.enable();
    });
    muteBtn.addEventListener("click", () => voice.setMuted(!voice.state().muted));
    deafBtn.addEventListener("click", () => voice.setDeafened(!voice.state().deafened));
    modeBtn.addEventListener("click", () =>
      voice.setMode(voice.state().mode === "ptt" ? "open" : "ptt"),
    );
    const renderVoice = (s: VoiceState) => {
      micBtn.textContent = s.enabled
        ? s.transmitting
          ? `mic: sending ${CHANNEL_META[s.speakChannel].glyph}`
          : `mic: on ${CHANNEL_META[s.speakChannel].glyph}`
        : s.error
          ? `mic: ${s.error}`
          : "mic: off";
      micBtn.setAttribute("aria-pressed", String(s.enabled));
      muteBtn.textContent = s.muted ? "muted" : "mute";
      muteBtn.setAttribute("aria-pressed", String(s.muted));
      deafBtn.textContent = s.deafened ? "deafened" : "deafen";
      deafBtn.setAttribute("aria-pressed", String(s.deafened));
      modeBtn.textContent = s.mode === "ptt" ? "push-to-talk" : "open mic";
      muteBtn.hidden = deafBtn.hidden = modeBtn.hidden = !s.enabled;
      speakers.replaceChildren(
        ...s.peers.map((p) => {
          const chip = el(
            "span",
            "hitreg-comms-speaker",
            `${p.speaking ? "◉ " : ""}${p.name} ${CHANNEL_META[p.channel].glyph}${p.connected ? "" : " …"}`,
          );
          chip.dataset["speaking"] = String(p.speaking);
          chip.title = p.connected ? `gain ${p.gain.toFixed(2)}` : "connecting";
          return chip;
        }),
      );
    };
    renderVoice(voice.state());
    unsubs.push(voice.onChange(renderVoice));
  }

  // -- log ------------------------------------------------------------------------------
  const log = el("div", "hitreg-comms-log");
  log.setAttribute("role", "log");
  log.setAttribute("aria-live", "polite");
  root.appendChild(log);
  const fadeTimers = new Set<ReturnType<typeof setTimeout>>();
  const addLine = (msg: ChatMessage) => {
    const line = el("div", "hitreg-comms-line");
    line.dataset["channel"] = msg.channel;
    if (msg.channel === "system") {
      line.append(el("span", "hitreg-comms-tag", "—"), document.createTextNode(msg.text));
    } else {
      line.append(
        el("span", "hitreg-comms-tag", CHANNEL_META[msg.channel].glyph),
        el("span", "hitreg-comms-name", `${msg.name}:`),
        document.createTextNode(msg.text),
      );
    }
    log.appendChild(line);
    while (log.childElementCount > maxLines) log.firstElementChild?.remove();
    log.scrollTop = log.scrollHeight;
    const timer = setTimeout(() => {
      fadeTimers.delete(timer);
      line.dataset["faded"] = "true";
    }, fadeAfterMs);
    fadeTimers.add(timer);
  };
  for (const msg of chat.history().slice(-maxLines)) addLine(msg);
  unsubs.push(chat.onMessage(addLine));

  // -- input ----------------------------------------------------------------------------
  const inputRow = el("div", "hitreg-comms-input");
  const chanBtn = el("button", "hitreg-comms-chan");
  chanBtn.type = "button";
  chanBtn.title = "Tab: next channel";
  const field = el("input", "hitreg-comms-field");
  field.type = "text";
  field.maxLength = 240;
  field.autocomplete = "off";
  field.spellcheck = false;
  field.setAttribute("aria-label", "chat message");
  const hint = el("span", "hitreg-comms-hint", "Esc");
  inputRow.append(chanBtn, field, hint);
  root.appendChild(inputRow);

  const renderChannel = () => {
    const meta = CHANNEL_META[channel];
    chanBtn.textContent = `${meta.glyph} ${meta.label}`;
    field.placeholder = `${meta.label}… (/g /t /p /s, /team x, /party x)`;
  };
  const setChannel = (next: CommsChannel) => {
    channel = next;
    renderChannel();
  };
  const cycle = () => {
    const i = COMMS_CHANNELS.indexOf(channel);
    setChannel(COMMS_CHANNELS[(i + 1) % COMMS_CHANNELS.length]!);
  };
  const setOpen = (next: boolean) => {
    open = next;
    root.dataset["open"] = String(next);
    if (next) {
      // a locked mouse (FPS-style play) routes every pointer event to the
      // canvas — release it so the channel/mic buttons are clickable while
      // typing; the game re-locks on the next canvas click as usual
      if (document.pointerLockElement) document.exitPointerLock?.();
      field.focus();
    } else {
      field.value = "";
      field.blur();
    }
  };
  const submit = () => {
    const parsed = parseChatInput(field.value, channel);
    field.value = "";
    switch (parsed.kind) {
      case "empty":
        setOpen(false);
        return;
      case "message": {
        const result = chat.send(parsed.channel, parsed.text);
        if (!result.ok) chat.system(result.reason);
        setOpen(false);
        return;
      }
      case "command":
        handleCommand(parsed.name, parsed.args);
        setOpen(false);
        return;
    }
  };
  const handleCommand = (name: string, args: string[]) => {
    if (name === "channel" && args[0]) {
      setChannel(args[0] as CommsChannel);
      return;
    }
    if (name === "team") {
      chat.requestTeam(args.length > 0 ? args.join(" ") : null);
      return;
    }
    if (name === "party") {
      chat.requestParty(args.length > 0 ? args.join(" ") : null);
      return;
    }
    if (opts.onCommand?.(name, args)) return;
    chat.system(`unknown command "/${name}"`);
  };

  chanBtn.addEventListener("click", () => {
    cycle();
    field.focus();
  });
  field.addEventListener("keydown", (e) => {
    if (e.code === "Enter" || e.code === "NumpadEnter") {
      e.preventDefault();
      submit();
    } else if (e.code === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.code === "Tab") {
      e.preventDefault();
      cycle();
    }
    e.stopPropagation(); // never reach game/editor hotkeys while typing
  });
  field.addEventListener("keyup", (e) => e.stopPropagation());
  const onGlobalKey = (e: KeyboardEvent) => {
    if (open || e.code !== openKey || isTypingTarget(e.target)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    setOpen(true);
  };
  window.addEventListener("keydown", onGlobalKey);
  unsubs.push(() => window.removeEventListener("keydown", onGlobalKey));

  renderChannel();
  parent.appendChild(root);

  return {
    root,
    isTyping: () => open && document.activeElement === field,
    open: () => setOpen(true),
    close: () => setOpen(false),
    setChannel,
    dispose: () => {
      for (const off of unsubs.splice(0)) off();
      for (const t of fadeTimers) clearTimeout(t);
      fadeTimers.clear();
      root.remove();
    },
  };
}
