/**
 * Gateway mode — the hosted-world client (`?gateway=http://host:8780`, or
 * localStorage "hitreg:gateway").
 *
 * The tab never dials a layer by itself: it signs in at MAIN (@hitreg/server
 * `bin/main.ts`), picks a character, asks `/play`, and is handed a layer url
 * plus a signed ticket — those go to NetPresence.rehome(). A `transfer`
 * message from the layer later (a party pull, a dungeon door, a rebalance)
 * takes exactly the same path with a fresh url + ticket, so the world keeps
 * rendering while the body hops servers.
 *
 * This file owns the small sign-in panel too. Design: DESIGN.md dark
 * tokens, product register — a card, not a splash screen. With creation
 * rules (main's GET /creation, else the game's local `creation` asset) a new
 * character goes through the full creation screen (character-creation.ts).
 */

import type { CharacterBuild, CharacterCreation } from "@hitreg/core";
import { applyCreationSkin, mountCreationScreen, watchUiScale, type CreationPreview } from "./character-creation.js";

export interface GatewaySession {
  session: string;
  account: { id: string; name: string };
  characters: GatewayCharacter[];
}

export interface GatewayCharacter {
  id: string;
  name: string;
  createdAt: string;
  /** Creation choices; absent on characters made before creation existed. */
  build?: CharacterBuild;
}

export interface PlayGrant {
  url: string;
  ticket: string;
  server: string;
  scene: string;
}

const SESSION_KEY = "hitreg:gateway-session";
const CHARACTER_KEY = "hitreg:gateway-character";

/** `?gateway=` wins; then the remembered one. Null = not in gateway mode. */
export function resolveGateway(): string | null {
  const fromQuery = new URLSearchParams(location.search).get("gateway");
  if (fromQuery) return fromQuery.replace(/\/+$/, "");
  try {
    return localStorage.getItem("hitreg:gateway");
  } catch {
    return null;
  }
}

export class GatewayClient {
  session: GatewaySession | null = null;

  constructor(readonly base: string) {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (raw) this.session = JSON.parse(raw) as GatewaySession;
    } catch {
      this.session = null;
    }
  }

  private async call<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.session ? { authorization: `Bearer ${this.session.session}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string } & T;
    if (!res.ok) {
      if (res.status === 401 && this.session && !path.startsWith("/auth/")) this.forget();
      throw new Error(json.error ?? `${res.status} ${res.statusText}`);
    }
    return json;
  }

  private remember(session: GatewaySession): void {
    this.session = session;
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch {
      // private mode — the session lives for the tab
    }
  }

  forget(): void {
    this.session = null;
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      // ignore
    }
  }

  /** Any signed-in call on main (the social panel's friends/party routes): GET without a body, POST with one. */
  api<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.call<T>(path, body);
  }

  async register(name: string, password: string): Promise<GatewaySession> {
    const s = await this.call<GatewaySession>("/auth/register", { name, password });
    this.remember(s);
    return s;
  }

  async login(name: string, password: string): Promise<GatewaySession> {
    const s = await this.call<GatewaySession>("/auth/login", { name, password });
    this.remember(s);
    return s;
  }

  async characters(): Promise<GatewayCharacter[]> {
    const r = await this.call<{ characters: GatewayCharacter[] }>("/characters");
    if (this.session) this.remember({ ...this.session, characters: r.characters });
    return r.characters;
  }

  /** The creation rules main validates against; null when main has none (or is too old to say). */
  async creation(): Promise<CharacterCreation | null> {
    try {
      return (await this.call<{ creation: CharacterCreation | null }>("/creation")).creation;
    } catch {
      return null;
    }
  }

  async createCharacter(name: string, build?: CharacterBuild): Promise<GatewayCharacter> {
    const r = await this.call<{ character: GatewayCharacter; characters: GatewayCharacter[] }>("/characters", { name, ...(build ? { build } : {}) });
    if (this.session) this.remember({ ...this.session, characters: r.characters });
    return r.character;
  }

  play(characterId: string): Promise<PlayGrant> {
    try {
      localStorage.setItem(CHARACTER_KEY, characterId);
    } catch {
      // ignore
    }
    return this.call<PlayGrant>("/play", { characterId });
  }

  status(): Promise<{ players: number; layers: Array<{ id: string; players: number; cap: number }> }> {
    return this.call("/status");
  }

  party(characterId: string): Promise<{ party: PartyView | null }> {
    return this.call(`/party?characterId=${encodeURIComponent(characterId)}`);
  }
  createParty(characterId: string): Promise<{ party: PartyView }> {
    return this.call("/party/create", { characterId });
  }
  joinParty(characterId: string, code: string): Promise<{ party: PartyView; pulled: boolean }> {
    return this.call("/party/join", { characterId, code });
  }
  leaveParty(characterId: string): Promise<{ party: null }> {
    return this.call("/party/leave", { characterId });
  }

  lastCharacter(): string | null {
    try {
      return localStorage.getItem(CHARACTER_KEY);
    } catch {
      return null;
    }
  }
}

export interface PartyView {
  code: string;
  leader: string;
  members: Array<{ characterId: string; server: string | null }>;
}

// -- the panel ------------------------------------------------------------------------

const STYLE = `
.hg-gate{position:fixed;inset:0;z-index:20000;display:flex;align-items:center;justify-content:center;background:rgba(11,14,20,.55);font:13px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#c9d1d9}
.hg-gate[hidden]{display:none}
.hg-card{width:340px;background:#0d1117;border:1px solid #30363d;border-radius:10px;padding:18px 20px 16px;box-shadow:0 12px 40px rgba(0,0,0,.5)}
.hg-card h1{margin:0 0 2px;font-size:15px;font-weight:600;color:#e6edf3;letter-spacing:.01em}
.hg-card .hg-sub{margin:0 0 14px;color:#8b949e;font-size:12px}
.hg-card label{display:block;margin:10px 0 4px;color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.hg-card input{width:100%;box-sizing:border-box;background:#161b22;border:1px solid #30363d;border-radius:6px;color:#e6edf3;padding:7px 9px;font:inherit;outline:none}
.hg-card input:focus{border-color:#58a6ff;box-shadow:0 0 0 2px rgba(88,166,255,.25)}
.hg-row{display:flex;gap:8px;margin-top:14px;align-items:center}
.hg-btn{background:#21262d;border:1px solid #30363d;color:#c9d1d9;border-radius:6px;padding:7px 12px;font:inherit;cursor:pointer}
.hg-btn:hover{border-color:#8b949e}
.hg-btn.hg-primary{background:#1f6feb;border-color:#1f6feb;color:#fff;font-weight:600}
.hg-btn.hg-primary:hover{background:#388bfd}
.hg-btn:disabled{opacity:.55;cursor:default}
.hg-link{background:none;border:none;color:#58a6ff;cursor:pointer;font:inherit;padding:0}
.hg-err{margin-top:10px;color:#ffa198;font-size:12px;min-height:1.2em}
.hg-list{margin:6px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}
.hg-list li{display:flex;align-items:center;justify-content:space-between;gap:8px;background:#161b22;border:1px solid #30363d;border-radius:6px;padding:7px 9px}
.hg-list li.hg-selected{border-color:#58a6ff;background:#1f3a5f}
.hg-list li button{margin-left:auto}
.hg-muted{color:#8b949e}
/* the game's look, when its creation rules carry a ui block (character-creation.ts sets the vars) */
.hg-gate.hg-cc-skin{background:radial-gradient(ellipse at 50% 50%,#2a221880 0%,#0a0908f0 65%,#050404 100%),var(--cc-backdrop,none);background-size:auto,198px 176px;font:14px/1.45 var(--cc-font);color:var(--cc-text);text-shadow:0 1px 2px #000;image-rendering:pixelated}
.hg-gate.hg-cc-skin .hg-card{position:relative;isolation:isolate;width:400px;background:none;border-radius:0;box-shadow:none;border:calc(var(--cc-panel-border) - 12px) solid transparent;padding:4px 6px 6px}
.hg-gate.hg-cc-skin .hg-card::before{content:"";position:absolute;inset:calc(12px - var(--cc-panel-border));pointer-events:none;border:var(--cc-panel-border) solid transparent;border-image:var(--cc-panel) var(--cc-panel-slice) / var(--cc-panel-border) var(--cc-panel-repeat);z-index:-1}
.hg-gate.hg-cc-skin .hg-card::after{content:"";position:absolute;inset:-4px -13px;background:linear-gradient(#121110eb,#121110f0),var(--cc-backdrop,none);background-size:auto,198px 176px;z-index:-2;pointer-events:none}
.hg-gate.hg-cc-skin .hg-card h1{font-weight:normal;font-size:19px;text-transform:uppercase;letter-spacing:.16em;color:var(--cc-heading);border-bottom:1px solid #645039;padding-bottom:8px;margin-bottom:6px}
.hg-gate.hg-cc-skin .hg-card .hg-sub,.hg-gate.hg-cc-skin .hg-muted{color:var(--cc-muted)}
.hg-gate.hg-cc-skin .hg-card label{color:#b79c6b;font-size:12px;letter-spacing:.12em}
.hg-gate.hg-cc-skin .hg-card input{border-radius:0;background:#080807;border:1px solid #655036;color:#e9d9b8;font:15px var(--cc-font)}
.hg-gate.hg-cc-skin .hg-card input:focus{border-color:#b18b4b;box-shadow:0 0 8px #bd803a44}
.hg-gate.hg-cc-skin .hg-btn{border-radius:0;color:var(--cc-text);font:12px var(--cc-font);text-transform:uppercase;letter-spacing:.08em;background:#191714;background-clip:padding-box;border:var(--cc-button-border) solid transparent;border-image:var(--cc-button) var(--cc-button-slice) / var(--cc-button-border) stretch;min-height:40px;padding:2px 14px}
.hg-gate.hg-cc-skin .hg-btn:hover{filter:brightness(1.5);color:#ffe5a9}
.hg-gate.hg-cc-skin .hg-btn.hg-primary{background:#2b1c10;color:#f4dca8;font-weight:normal;border-image:var(--cc-button-on) var(--cc-button-on-slice) / var(--cc-button-border) stretch}
.hg-gate.hg-cc-skin .hg-link{color:#e4c080;font-family:var(--cc-font)}
.hg-gate.hg-cc-skin .hg-list li{justify-content:flex-start;gap:8px;padding:7px 14px 7px 10px;border-radius:0;background:#15120f;background-clip:padding-box;border:var(--cc-card-border) solid transparent;border-image:var(--cc-card) var(--cc-card-slice) fill / var(--cc-card-border) stretch;color:var(--cc-heading);cursor:pointer}
.hg-gate.hg-cc-skin .hg-list li.hg-selected{border-image:var(--cc-card-on) var(--cc-card-on-slice) fill / var(--cc-card-border) stretch;background:#15120f;filter:brightness(1.12)}
.hg-gate.hg-cc-skin .hg-list li.hg-selected::before{content:"✓ ";color:#f0cd85}
.hg-gate.hg-cc-skin .hg-err{color:#eeb88a}
.hg-gate.hg-cc-skin .hg-list li .hg-muted{margin-left:auto;font-style:italic}
.hg-gate .hg-btn{white-space:nowrap}
.hg-gate.hg-rules .hg-newname{display:none}
.hg-gate.hg-rules .hg-newrow .hg-btn{flex:1}
.hg-status{position:fixed;left:8px;bottom:8px;z-index:9999;font:11px ui-monospace,Menlo,Consolas,monospace;color:#8b949e;background:rgba(10,14,20,.72);padding:6px 9px;border-radius:6px;pointer-events:none;white-space:pre}
`;

export interface GatewayPanelOptions {
  client: GatewayClient;
  /** Called with a fresh grant: the app dials the layer and enters play. */
  onPlay(grant: PlayGrant, character: GatewayCharacter): void;
  /** The game's own creation rules — used when main does not publish any. */
  localCreation?: () => CharacterCreation | null;
  /** The creation screen's 3D preview (the host owns renderer + models). */
  preview?: (canvas: HTMLCanvasElement, creation: CharacterCreation) => CreationPreview | null;
  /** Texture id → URL, so the creation screen can wear the game's UI pieces. */
  textureUrl?: (id: string) => string | undefined;
}

export interface GatewayPanel {
  show(): void;
  hide(): void;
  /** The chosen character, once Play was pressed. */
  character(): GatewayCharacter | null;
  /** A one-line status the app can update ("layer-2 · transferring…"). */
  setStatus(text: string): void;
}

export function mountGatewayPanel(opts: GatewayPanelOptions): GatewayPanel {
  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.appendChild(style);
  const root = document.createElement("div");
  root.className = "hg-gate";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Sign in");
  document.body.appendChild(root);
  watchUiScale(root); // lives as long as the page
  const status = document.createElement("div");
  status.className = "hg-status";
  status.textContent = `gateway ${opts.client.base}`;
  document.body.appendChild(status);

  let chosen: GatewayCharacter | null = null;
  let busy = false;
  // main's rules win (they are what /characters validates against); fetched once per panel
  let rules: Promise<CharacterCreation | null> | null = null;
  const creationRules = (): Promise<CharacterCreation | null> =>
    (rules ??= opts.client.creation().then((fromMain) => fromMain ?? opts.localCreation?.() ?? null));
  // the game's look on this card too, as soon as its rules are known
  void creationRules().then((creation) => {
    if (creation && opts.textureUrl) applyCreationSkin(root, creation, opts.textureUrl);
  });

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { text?: string } = {}, ...children: Node[]): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    const { text, ...rest } = props;
    Object.assign(node, rest);
    if (text !== undefined) node.textContent = text;
    for (const c of children) node.appendChild(c);
    return node;
  };

  const renderAuth = (): void => {
    root.replaceChildren();
    let mode: "login" | "register" = "login";
    const card = el("div", { className: "hg-card" });
    const title = el("h1", { text: "Sign in" });
    const sub = el("p", { className: "hg-sub", text: `to ${new URL(opts.client.base).host}` });
    const name = el("input", { placeholder: "name", autocomplete: "username" });
    name.setAttribute("aria-label", "name");
    const password = el("input", { placeholder: "password", type: "password", autocomplete: "current-password" });
    password.setAttribute("aria-label", "password");
    const err = el("div", { className: "hg-err" });
    const go = el("button", { className: "hg-btn hg-primary", text: "Sign in" });
    const swap = el("button", { className: "hg-link", text: "Create an account" });
    swap.onclick = () => {
      mode = mode === "login" ? "register" : "login";
      title.textContent = mode === "login" ? "Sign in" : "Create an account";
      go.textContent = mode === "login" ? "Sign in" : "Create";
      swap.textContent = mode === "login" ? "Create an account" : "I have an account";
      err.textContent = "";
    };
    const submit = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      go.disabled = true;
      err.textContent = "";
      try {
        if (mode === "login") await opts.client.login(name.value.trim(), password.value);
        else await opts.client.register(name.value.trim(), password.value);
        renderCharacters();
      } catch (error) {
        err.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        busy = false;
        go.disabled = false;
      }
    };
    go.onclick = () => void submit();
    card.onkeydown = (e) => {
      if (e.key === "Enter") void submit();
    };
    card.append(title, sub, el("label", { text: "name" }), name, el("label", { text: "password" }), password, err, el("div", { className: "hg-row" }, go, swap));
    root.appendChild(card);
    name.focus();
  };

  const renderCharacters = (): void => {
    root.replaceChildren();
    const session = opts.client.session;
    if (!session) {
      renderAuth();
      return;
    }
    const card = el("div", { className: "hg-card" });
    const title = el("h1", { text: "Choose a character" });
    const sub = el("p", { className: "hg-sub", text: `${session.account.name} · ` });
    const out = el("button", { className: "hg-link", text: "sign out" });
    out.onclick = () => {
      opts.client.forget();
      renderAuth();
    };
    sub.appendChild(out);
    const list = el("ul", { className: "hg-list" });
    const err = el("div", { className: "hg-err" });
    let archetypeNames = new Map<string, string>();
    const archetypeName = (id: string): string => archetypeNames.get(id) ?? "";
    let selected: string | null = opts.client.lastCharacter();
    const play = el("button", { className: "hg-btn hg-primary", text: "Play" });
    const refresh = (): void => {
      list.replaceChildren();
      const chars = opts.client.session?.characters ?? [];
      if (chars.length === 0) list.appendChild(el("li", { className: "hg-muted", text: "No characters yet — make one below." }));
      if (!chars.some((c) => c.id === selected)) selected = chars[0]?.id ?? null;
      for (const c of chars) {
        const li = el("li", { className: c.id === selected ? "hg-selected" : "" }, el("span", { text: c.name }));
        if (c.build) li.appendChild(el("span", { className: "hg-muted", text: archetypeName(c.build.archetype) }));
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", c.id === selected ? "true" : "false");
        li.onclick = () => {
          selected = c.id;
          refresh();
        };
        list.appendChild(li);
      }
      play.disabled = selected === null;
    };
    const newName = el("input", { placeholder: "new character name" });
    newName.setAttribute("aria-label", "new character name");
    const create = el("button", { className: "hg-btn", text: "Create" });
    create.onclick = async () => {
      if (busy) return;
      busy = true;
      err.textContent = "";
      try {
        const c = await opts.client.createCharacter(newName.value.trim());
        selected = c.id;
        newName.value = "";
        refresh();
      } catch (error) {
        err.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        busy = false;
      }
    };
    play.onclick = async () => {
      if (busy || !selected) return;
      busy = true;
      play.disabled = true;
      err.textContent = "";
      try {
        const character = (opts.client.session?.characters ?? []).find((c) => c.id === selected)!;
        const grant = await opts.client.play(character.id);
        chosen = character;
        status.textContent = `${character.name} · ${grant.server}`;
        panel.hide();
        opts.onPlay(grant, character);
      } catch (error) {
        err.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        busy = false;
        play.disabled = false;
      }
    };
    newName.classList.add("hg-newname");
    const createRow = el("div", { className: "hg-row hg-newrow" }, newName, create);
    createRow.style.marginTop = "0";
    card.append(title, sub, list, el("label", { text: "new character" }), createRow, err, el("div", { className: "hg-row" }, play));
    root.appendChild(card);
    refresh();
    // with creation rules, "new character" is the creation screen instead of a bare name
    void creationRules().then((creation) => {
      if (!creation || !root.contains(card)) return;
      archetypeNames = new Map(creation.archetypes.map((a) => [a.id, a.name]));
      refresh();
      create.textContent = "New character…";
      // the creation screen asks for the name itself
      root.classList.add("hg-rules");
      create.onclick = () => {
        if (busy) return;
        root.hidden = true;
        const screen = mountCreationScreen({
          creation,
          name: newName.value.trim(),
          ...(opts.textureUrl ? { textureUrl: opts.textureUrl } : {}),
          ...(opts.preview ? { preview: (canvas: HTMLCanvasElement) => opts.preview!(canvas, creation) } : {}),
          onCreate: async (name, build) => {
            const c = await opts.client.createCharacter(name, build);
            selected = c.id;
            newName.value = "";
            screen.close();
            root.hidden = false;
            refresh();
          },
          onCancel: () => {
            screen.close();
            root.hidden = false;
          },
        });
      };
    });
    void opts.client.characters().then(refresh, (error: unknown) => {
      if (!opts.client.session) renderAuth();
      else err.textContent = error instanceof Error ? error.message : String(error);
    });
  };

  const panel: GatewayPanel = {
    show: () => {
      root.hidden = false;
      if (opts.client.session) renderCharacters();
      else renderAuth();
    },
    hide: () => {
      root.hidden = true;
    },
    character: () => chosen,
    setStatus: (text) => {
      status.textContent = text;
    },
  };
  panel.show();
  return panel;
}
