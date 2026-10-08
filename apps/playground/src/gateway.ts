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
  world?: { id: string; name: string };
  /** Deleted characters still restorable (main keeps them DELETE_GRACE_DAYS). */
  deleted?: GatewayCharacter[];
}

export interface GatewayCharacter {
  id: string;
  name: string;
  createdAt: string;
  world?: string;
  /** Creation choices; absent on characters made before creation existed. */
  build?: CharacterBuild;
  /** When it was deleted (only on a restorable one). */
  deletedAt?: string;
}

export interface GatewayWorld {
  id: string;
  name: string;
  url: string | null;
  status: "online" | "offline" | "unknown";
  players: number | null;
  capacity: number | null;
  character: { id: string; name: string; archetype?: string } | null;
}
export interface GatewayWorldList { current: string; worlds: GatewayWorld[] }

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

  base: string;
  /** The entry gateway remains the world directory even after selecting another main. */
  readonly directory: string;

  constructor(base: string) {
    this.base = this.directory = base.replace(/\/+$/, "");
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (raw) this.session = JSON.parse(raw) as GatewaySession;
      const selected = localStorage.getItem(`hitreg:gateway-world:${this.directory}`);
      if (selected && this.session?.world) {
        const remembered = JSON.parse(selected) as { id?: string; url?: string };
        if (remembered.id === this.session.world.id && typeof remembered.url === "string" && /^https?:\/\//.test(remembered.url)) this.base = remembered.url;
      }
    } catch {
      this.session = null;
    }
  }

  private async call<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST", base = this.base): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(this.session ? { authorization: `Bearer ${this.session.session}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      // "Failed to fetch" tells a player nothing: say which server, and that it is not them
      throw new Error(`Cannot reach the game server at ${base} — it may be down. Try again in a moment.`);
    }
    const json = (await res.json().catch(() => ({}))) as { error?: string; code?: string } & T;
    if (!res.ok) {
      if (res.status === 401 && this.session && (base === this.base || (base === this.directory && path === "/worlds")) && !path.startsWith("/auth/")) this.forget();
      // a 404 without a JSON error is not main at all (a static host, a wrong port)
      const error = new Error(json.error ?? (res.status === 404 ? `No game server answers at ${this.base} (HTTP 404) — check the gateway address.` : `${res.status} ${res.statusText}`));
      // main's machine-readable refusal ("rename_required"), for callers that act on it
      throw Object.assign(error, { status: res.status, ...(typeof json.code === "string" ? { code: json.code } : {}) });
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

  worlds(): Promise<GatewayWorldList> {
    return this.call("/worlds", undefined, "GET", this.directory);
  }

  async selectWorld(world: GatewayWorld): Promise<void> {
    const target = new URL(world.url ?? this.directory);
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.search || target.hash) throw new Error("This world has an invalid gateway address.");
    const base = target.href.replace(/\/+$/, "");
    const roster = await this.call<{ world: { id: string; name: string }; characters: GatewayCharacter[]; deleted?: GatewayCharacter[] }>("/characters", undefined, "GET", base);
    if (roster.world?.id !== world.id) throw new Error("That gateway serves a different world. Please refresh the world list.");
    if (!this.session) throw new Error("Sign in first.");
    this.base = base;
    this.remember({ ...this.session, ...roster, deleted: roster.deleted ?? [] });
    try { localStorage.setItem(`hitreg:gateway-world:${this.directory}`, JSON.stringify({ id: world.id, url: base })); } catch { /* tab-only selection */ }
  }

  async characters(): Promise<GatewayCharacter[]> {
    const r = await this.call<{ world?: { id: string; name: string }; characters: GatewayCharacter[]; deleted?: GatewayCharacter[] }>("/characters");
    if (this.session) this.remember({ ...this.session, characters: r.characters, deleted: r.deleted ?? [], ...(r.world ? { world: r.world } : {}) });
    return r.characters;
  }

  /** Delete a character (restorable for a while; main says how long). `confirm` must be its name. */
  async deleteCharacter(characterId: string, confirm: string): Promise<void> {
    const r = await this.call<{ characters: GatewayCharacter[]; deleted?: GatewayCharacter[] }>(`/characters/${encodeURIComponent(characterId)}`, { confirm }, "DELETE");
    if (this.session) this.remember({ ...this.session, characters: r.characters, deleted: r.deleted ?? [] });
  }

  /** Bring a deleted character back (inside the grace period, with a free slot). */
  async restoreCharacter(characterId: string): Promise<void> {
    const r = await this.call<{ characters: GatewayCharacter[]; deleted?: GatewayCharacter[] }>(`/characters/${encodeURIComponent(characterId)}/restore`, {});
    if (this.session) this.remember({ ...this.session, characters: r.characters, deleted: r.deleted ?? [] });
  }

  /** Whether a new character may take this name (asked while typing; creating decides). */
  async nameFree(name: string): Promise<{ ok: boolean; reason?: string }> {
    try {
      return await this.call<{ ok: boolean; reason?: string }>(`/characters/name?name=${encodeURIComponent(name)}`);
    } catch {
      return { ok: true };
    }
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
    const r = await this.call<{ character: GatewayCharacter; characters: GatewayCharacter[]; deleted?: GatewayCharacter[] }>("/characters", { name, ...(build ? { build } : {}) });
    if (this.session) this.remember({ ...this.session, characters: r.characters, ...(r.deleted ? { deleted: r.deleted } : {}) });
    return r.character;
  }

  /** A new name for a character whose name moderation refused (`/play` answered `rename_required`). */
  async renameCharacter(characterId: string, name: string): Promise<void> {
    const r = await this.call<{ characters: GatewayCharacter[]; deleted?: GatewayCharacter[] }>(`/characters/${encodeURIComponent(characterId)}/rename`, { name });
    if (this.session) this.remember({ ...this.session, characters: r.characters, deleted: r.deleted ?? [] });
  }

  play(characterId: string): Promise<PlayGrant> {
    try {
      localStorage.setItem(`${CHARACTER_KEY}:${this.session?.world?.id ?? this.base}`, characterId);
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
      return localStorage.getItem(`${CHARACTER_KEY}:${this.session?.world?.id ?? this.base}`) ?? localStorage.getItem(CHARACTER_KEY);
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
.hg-world-list{display:flex;flex-direction:column;gap:10px;max-height:52vh;overflow:auto;scrollbar-width:thin;scrollbar-color:#79603b #15120f}
.hg-world{display:flex;flex-direction:column;gap:5px;text-align:left;font:inherit;color:inherit;background:#161b22;border:1px solid #655036;padding:14px;cursor:pointer}
.hg-world:hover,.hg-world:focus-visible{background:#302418;outline:2px solid #b18b4b;outline-offset:1px}
.hg-world:disabled{opacity:.5;cursor:default}
.hg-world strong{font-weight:normal;font-size:17px}
.hg-world span{font-size:12px}
.hg-gate .hg-card.hg-worlds,.hg-gate.hg-cc-skin .hg-card.hg-worlds{width:min(560px,calc(100vw - 80px));box-sizing:border-box}
.hg-gate.hg-cc-skin .hg-world{color:var(--cc-heading);background:#15120f;font-family:var(--cc-font)}

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
/* over the painted scene (showScene): see-through, the panels take the pointer */
.hg-gate.hg-layered{background:transparent;pointer-events:none}
.hg-gate.hg-layered .hg-card,.hg-gate.hg-layered .hg-who{pointer-events:auto}
.hg-gate.hg-cc-skin .hg-signin{margin-left:auto;margin-right:9vw}
/* character select: the roster on the right, the chosen one's name and the way in at the bottom */
.hg-gate.hg-select{justify-content:flex-end;align-items:stretch}
.hg-gate.hg-select .hg-roster{position:fixed;right:5vw;top:9vh;bottom:9vh;width:380px;display:flex;flex-direction:column}
.hg-gate.hg-select .hg-roster .hg-list{flex:0 1 auto;overflow-y:auto;min-height:60px}
.hg-gate.hg-select .hg-roster .hg-newrow{margin-top:auto}
.hg-gate.hg-select .hg-roster .hg-wide{width:100%;margin-top:8px}
.hg-gate.hg-cc-skin .hg-deleted-head{margin:14px 0 4px;font:normal 12px var(--cc-font);letter-spacing:.12em;text-transform:uppercase;color:#b79c6b}
.hg-gate.hg-cc-skin .hg-list.hg-deleted li{opacity:.7;cursor:default}
.hg-gate.hg-cc-skin .hg-list.hg-deleted li .hg-link{margin-left:8px}
.hg-gate.hg-cc-skin .hg-list li .hg-li-name{color:var(--cc-heading)}
.hg-gate .hg-who{position:fixed;left:50%;bottom:5vh;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:2px;text-align:center}
.hg-gate .hg-who[hidden]{display:none}
.hg-gate.hg-cc-skin .hg-who-name{font:30px var(--cc-font);letter-spacing:.06em;color:var(--cc-heading);text-shadow:0 2px 8px #000,0 0 2px #000}
.hg-gate.hg-cc-skin .hg-who-sub{font:14px var(--cc-font);letter-spacing:.14em;text-transform:uppercase;color:#d8bf8c;text-shadow:0 1px 4px #000}
.hg-gate .hg-who-actions{gap:12px;margin-top:10px}
.hg-gate.hg-cc-skin .hg-enter{min-width:240px;min-height:52px;font-size:15px;letter-spacing:.14em}
.hg-gate.hg-cc-skin .hg-danger-btn{color:#f0b0a0}
.hg-gate .hg-card.hg-confirm,.hg-gate.hg-cc-skin .hg-card.hg-confirm{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:3;width:420px}
.hg-gate .hg-confirm[hidden]{display:none}
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
  /** Play this grant without showing the card (a published page reloaded on the grant's scene). */
  resume?: { grant: PlayGrant; character: GatewayCharacter };
}

export interface GatewayPanel {
  show(screen?: "worlds" | "characters"): void;
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
    root.setAttribute("aria-label", "Sign in");
    root.replaceChildren();
    root.classList.remove("hg-select");
    let mode: "login" | "register" = "login";
    const card = el("div", { className: "hg-card hg-signin" });
    // the painted clearing behind the sign-in panel, no one standing in it yet
    void creationRules().then((creation) => {
      if (root.contains(card)) showScene(creation, false);
    });
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
        renderWorlds();
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

  /**
   * The painted scene behind sign-in and character select (creation `ui.scene`): the painting, and on the
   * select screen the chosen character standing in the clearing (the creation preview, same stage).
   */
  let scene: { layer: HTMLElement; canvas: HTMLCanvasElement | null; preview: CreationPreview | null } | null = null;
  const dropScene = (): void => {
    scene?.preview?.dispose();
    scene?.layer.remove();
    scene = null;
    root.classList.remove("hg-layered");
  };
  const showScene = (creation: CharacterCreation | null, withModel: boolean): CreationPreview | null => {
    const painting = creation?.ui?.scene && opts.textureUrl ? opts.textureUrl(creation.ui.scene) : undefined;
    if (!painting) return null;
    if (scene && (scene.canvas !== null) === withModel) return scene.preview;
    dropScene();
    const layer = document.createElement("div");
    layer.className = "hg-scene-layer";
    layer.style.cssText = `position:fixed;inset:0;z-index:19999;background:#070606 url("${painting}") center/cover no-repeat`;
    let canvas: HTMLCanvasElement | null = null;
    let preview: CreationPreview | null = null;
    if (withModel && opts.preview && creation) {
      canvas = document.createElement("canvas");
      canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;cursor:grab;touch-action:none";
      canvas.setAttribute("aria-label", "Your character — drag to turn");
      layer.appendChild(canvas);
      preview = opts.preview(canvas, creation);
      let yaw = 0;
      let dragX: number | null = null;
      canvas.addEventListener("pointerdown", (e) => {
        dragX = e.clientX;
        canvas!.setPointerCapture(e.pointerId);
      });
      canvas.addEventListener("pointermove", (e) => {
        if (dragX === null) return;
        yaw += (e.clientX - dragX) * 0.012;
        dragX = e.clientX;
        preview?.setYaw(yaw);
      });
      const end = (): void => {
        dragX = null;
      };
      canvas.addEventListener("pointerup", end);
      canvas.addEventListener("pointercancel", end);
    }
    const shade = document.createElement("div");
    shade.style.cssText = "position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at 50% 55%,transparent 38%,#05040470 80%,#050404c8 100%)";
    layer.appendChild(shade);
    root.before(layer);
    root.classList.add("hg-layered");
    scene = { layer, canvas, preview };
    return preview;
  };

  const renderWorlds = (): void => {
    root.replaceChildren();
    root.classList.remove("hg-select", "hg-rules");
    root.setAttribute("aria-label", "Choose a world");
    if (!opts.client.session) return renderAuth();
    const card = el("div", { className: "hg-card hg-worlds" });
    const title = el("h1", { text: "Choose a world" });
    const sub = el("p", { className: "hg-sub", text: "One character on each world. Your progress stays with that character." });
    const list = el("div", { className: "hg-world-list" });
    const err = el("div", { className: "hg-err" }); err.setAttribute("role", "alert");
    const loading = el("p", { className: "hg-muted", text: "Finding worlds…" });
    const refresh = el("button", { className: "hg-link", text: "Refresh worlds" });
    const out = el("button", { className: "hg-link", text: "Sign out" });
    out.onclick = () => { opts.client.forget(); dropScene(); renderAuth(); };
    card.append(title, sub, loading, list, err, el("div", { className: "hg-row" }, refresh, out));
    root.append(card);
    void creationRules().then((creation) => { if (root.contains(card)) showScene(creation, false); });
    const load = async (): Promise<void> => {
      refresh.disabled = true; err.textContent = ""; loading.hidden = false;
      try {
        const catalogue = await opts.client.worlds();
        if (!root.contains(card)) return;
        list.replaceChildren();
        for (const world of catalogue.worlds) {
          const b = el("button", { className: "hg-world", type: "button" });
          const population = world.players === null ? "Population unavailable" : `${world.players} / ${world.capacity ?? "—"} adventurers`;
          b.append(el("strong", { text: world.name }), el("span", { className: "hg-muted", text: `${world.status === "unknown" ? "Connect to check availability" : world.status === "online" ? "Online" : "Offline"} · ${population}` }), el("span", { text: world.character ? `Continue as ${world.character.name}` : "Create your character here" }));
          b.disabled = world.status === "offline";
          b.onclick = async () => {
            if (busy) return;
            busy = true; b.disabled = true; err.textContent = "";
            try {
              await opts.client.selectWorld(world);
              rules = null;
              const creation = await creationRules();
              if (!root.contains(card)) return;
              if (creation && opts.textureUrl) applyCreationSkin(root, creation, opts.textureUrl);
              dropScene(); renderCharacters();
            } catch (error) {
              if (!opts.client.session) renderAuth();
              else err.textContent = error instanceof Error ? error.message : String(error);
            } finally { busy = false; b.disabled = world.status === "offline"; }
          };
          list.append(b);
        }
        if (!catalogue.worlds.length) list.append(el("p", { className: "hg-muted", text: "No worlds are available yet." }));
      } catch (error) {
        if (!opts.client.session) renderAuth();
        else err.textContent = error instanceof Error ? error.message : String(error);
      } finally { refresh.disabled = false; loading.hidden = true; }
    };
    refresh.onclick = () => void load();
    void load();
  };

  const renderCharacters = (): void => {
    root.replaceChildren();
    const session = opts.client.session;
    if (!session) {
      renderAuth();
      return;
    }
    root.classList.add("hg-select");
    root.setAttribute("aria-label", "Choose a character");
    // -- the roster: a bronze panel on the right
    const roster = el("div", { className: "hg-card hg-roster" });
    const title = el("h1", { text: opts.client.session?.world?.name ?? "Characters" });
    const sub = el("p", { className: "hg-sub", text: `${session.account.name} · ` });
    const out = el("button", { className: "hg-link", text: "sign out" });
    out.onclick = () => {
      opts.client.forget();
      dropScene();
      root.classList.remove("hg-select");
      renderAuth();
    };
    const worlds = el("button", { className: "hg-link", text: "Change world" });
    worlds.onclick = () => { if (!busy) { dropScene(); renderWorlds(); } };
    sub.append(out, document.createTextNode(" · "), worlds);
    const list = el("ul", { className: "hg-list" });
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Your characters");
    const deletedHead = el("h2", { className: "hg-deleted-head", text: "Recently deleted" });
    const deletedList = el("ul", { className: "hg-list hg-deleted" });
    const create = el("button", { className: "hg-btn hg-wide", text: "Create new character" });
    const newName = el("input", { placeholder: "new character name" });
    newName.setAttribute("aria-label", "new character name");
    newName.classList.add("hg-newname");
    roster.append(title, sub, list, deletedHead, deletedList, el("div", { className: "hg-row hg-newrow" }, newName), create);

    // -- the chosen one, standing in the clearing; its name and the way in at the bottom
    const who = el("div", { className: "hg-who" });
    const whoName = el("div", { className: "hg-who-name" });
    const whoSub = el("div", { className: "hg-who-sub" });
    const err = el("div", { className: "hg-err" });
    err.setAttribute("role", "alert");
    const play = el("button", { className: "hg-btn hg-primary hg-enter", text: "Enter world" });
    const del = el("button", { className: "hg-btn hg-danger-btn", text: "Delete" });
    who.append(whoName, whoSub, err, el("div", { className: "hg-row hg-who-actions" }, del, play));
    // a confirmation that asks for the name, over everything
    const confirm = el("div", { className: "hg-card hg-confirm" });
    confirm.hidden = true;
    root.append(roster, who, confirm);

    let archetypeNames = new Map<string, string>();
    const archetypeName = (id: string): string => archetypeNames.get(id) ?? "";
    let selected: string | null = opts.client.lastCharacter();
    let preview: CreationPreview | null = null;
    let creationLoaded: CharacterCreation | null = null;
    const chars = (): GatewayCharacter[] => (opts.client.session?.characters ?? []).filter((c) => !c.world || c.world === opts.client.session?.world?.id);
    const refresh = (): void => {
      list.replaceChildren();
      const all = chars();
      if (all.length === 0) list.appendChild(el("li", { className: "hg-muted hg-empty", text: "No characters yet — create one." }));
      if (!all.some((c) => c.id === selected)) selected = all[0]?.id ?? null;
      for (const c of all) {
        const li = el("li", { className: c.id === selected ? "hg-selected" : "" });
        li.append(el("span", { className: "hg-li-name", text: c.name }), el("span", { className: "hg-muted", text: c.build ? archetypeName(c.build.archetype) : "" }));
        li.setAttribute("role", "option");
        li.tabIndex = 0;
        li.setAttribute("aria-selected", c.id === selected ? "true" : "false");
        li.onclick = () => {
          selected = c.id;
          refresh();
        };
        li.ondblclick = () => void enter();
        li.onkeydown = (e) => {
          if (e.key === "Enter") void enter();
        };
        list.appendChild(li);
      }
      create.disabled = all.length > 0;
      create.textContent = all.length > 0 ? "One character per world" : "Create new character";
      const gone = (opts.client.session?.deleted ?? []).filter((c) => !c.world || c.world === opts.client.session?.world?.id);
      deletedHead.hidden = deletedList.hidden = gone.length === 0;
      deletedList.replaceChildren(
        ...gone.map((c) => {
          const li = el("li", { className: "hg-gone" });
          const days = c.deletedAt ? Math.max(0, 7 - Math.floor((Date.now() - Date.parse(c.deletedAt)) / 86_400_000)) : 0;
          const back = el("button", { className: "hg-link", text: "restore" });
          back.onclick = async (e) => {
            e.stopPropagation();
            err.textContent = "";
            try {
              await opts.client.restoreCharacter(c.id);
              selected = c.id;
              refresh();
            } catch (error) {
              err.textContent = error instanceof Error ? error.message : String(error);
            }
          };
          li.append(el("span", { className: "hg-li-name", text: c.name }), el("span", { className: "hg-muted", text: `${days} day${days === 1 ? "" : "s"} left` }), back);
          return li;
        }),
      );
      const chosenOne = all.find((c) => c.id === selected);
      whoName.textContent = chosenOne?.name ?? "";
      whoSub.textContent = chosenOne?.build ? archetypeName(chosenOne.build.archetype) : "";
      play.disabled = del.disabled = !chosenOne;
      who.hidden = !chosenOne;
      if (chosenOne?.build && preview) preview.update(chosenOne.build);
      if (scene?.layer) scene.layer.style.visibility = "visible";
    };

    const enter = async (): Promise<void> => {
      if (busy || !selected) return;
      busy = true;
      play.disabled = true;
      err.textContent = "";
      try {
        const character = chars().find((c) => c.id === selected)!;
        const grant = await opts.client.play(character.id);
        chosen = character;
        status.textContent = `${character.name} · ${grant.server}`;
        panel.hide();
        opts.onPlay(grant, character);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (code === "rename_required") askRename(chars().find((c) => c.id === selected)!, error instanceof Error ? error.message : "");
        else err.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        busy = false;
        play.disabled = false;
      }
    };
    play.onclick = () => void enter();

    /** Moderation refused this character's name: pick a new one (the full name check runs on main), then enter. */
    const askRename = (character: GatewayCharacter, message: string): void => {
      confirm.replaceChildren();
      const typed = el("input", { placeholder: "new name" });
      typed.setAttribute("aria-label", `new name for ${character.name}`);
      const why = el("div", { className: "hg-err" });
      const yes = el("button", { className: "hg-btn", text: "Rename and play" });
      const no = el("button", { className: "hg-btn", text: "Not now" });
      yes.disabled = true;
      typed.oninput = () => {
        yes.disabled = typed.value.trim().length < 3;
      };
      no.onclick = () => {
        confirm.hidden = true;
      };
      yes.onclick = async () => {
        why.textContent = "";
        yes.disabled = true;
        try {
          await opts.client.renameCharacter(character.id, typed.value.trim());
          confirm.hidden = true;
          refresh();
          void enter();
        } catch (error) {
          why.textContent = error instanceof Error ? error.message : String(error);
          yes.disabled = false;
        }
      };
      confirm.append(
        el("h1", { text: `A new name for ${character.name}` }),
        el("p", { className: "hg-sub", text: message || `The name "${character.name}" was refused. Choose a new name to keep playing.` }),
        typed,
        why,
        el("div", { className: "hg-row" }, no, yes),
      );
      confirm.hidden = false;
      typed.focus();
    };

    del.onclick = () => {
      const character = chars().find((c) => c.id === selected);
      if (!character) return;
      confirm.replaceChildren();
      const typed = el("input", { placeholder: character.name });
      typed.setAttribute("aria-label", `type ${character.name} to delete`);
      const why = el("div", { className: "hg-err" });
      const yes = el("button", { className: "hg-btn hg-danger-btn", text: "Delete" });
      const no = el("button", { className: "hg-btn", text: "Keep" });
      yes.disabled = true;
      typed.oninput = () => {
        yes.disabled = typed.value.trim().toLowerCase() !== character.name.toLowerCase();
      };
      no.onclick = () => {
        confirm.hidden = true;
      };
      yes.onclick = async () => {
        why.textContent = "";
        try {
          await opts.client.deleteCharacter(character.id, typed.value.trim());
          confirm.hidden = true;
          selected = null;
          refresh();
        } catch (error) {
          why.textContent = error instanceof Error ? error.message : String(error);
        }
      };
      confirm.append(
        el("h1", { text: `Delete ${character.name}?` }),
        el("p", { className: "hg-sub", text: "They can be restored for 7 days, then they are gone for good. Type the name to confirm." }),
        typed,
        why,
        el("div", { className: "hg-row" }, no, yes),
      );
      confirm.hidden = false;
      typed.focus();
    };

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
    refresh();
    // with creation rules: the clearing behind, the character standing in it, and "create" is the creation screen
    void creationRules().then((creation) => {
      if (!creation || !root.contains(roster)) return;
      creationLoaded = creation;
      archetypeNames = new Map(creation.archetypes.map((a) => [a.id, a.name]));
      preview = showScene(creation, true);
      refresh();
      root.classList.add("hg-rules");
      create.onclick = () => {
        if (busy) return;
        root.hidden = true;
        // one 3D view at a time: the creation screen brings its own
        dropScene();
        preview = null;
        const reopen = (): void => {
          root.hidden = false;
          preview = showScene(creationLoaded, true);
          refresh();
        };
        const screen = mountCreationScreen({
          creation,
          name: newName.value.trim(),
          ...(opts.textureUrl ? { textureUrl: opts.textureUrl } : {}),
          ...(opts.preview ? { preview: (canvas: HTMLCanvasElement) => opts.preview!(canvas, creation) } : {}),
          nameCheck: (name) => opts.client.nameFree(name),
          onCreate: async (name, build) => {
            const c = await opts.client.createCharacter(name, build);
            selected = c.id;
            newName.value = "";
            screen.close();
            reopen();
          },
          onCancel: () => {
            screen.close();
            reopen();
          },
        });
      };
    });
    void opts.client.characters().then(() => { if (root.contains(roster)) refresh(); }, (error: unknown) => {
      if (!opts.client.session) renderAuth();
      else err.textContent = error instanceof Error ? error.message : String(error);
    });
  };

  const panel: GatewayPanel = {
    show: (screen = "worlds") => {
      root.hidden = false;
      if (opts.client.session) { if (screen === "characters") renderCharacters(); else renderWorlds(); }
      else renderAuth();
    },
    hide: () => {
      root.hidden = true;
      dropScene();
    },
    character: () => chosen,
    setStatus: (text) => {
      status.textContent = text;
    },
  };
  if (opts.resume) {
    const { grant, character } = opts.resume;
    chosen = character;
    status.textContent = `${character.name} · ${grant.server}`;
    panel.hide();
    // after the caller has its panel handle
    queueMicrotask(() => opts.onPlay(grant, character));
  } else panel.show();
  return panel;
}
