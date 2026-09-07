/**
 * The social panel — friends, requests, party, invitations — for a tab
 * playing through the gateway (docs/hosting.md → "Parties and friends").
 *
 * Main owns every fact here: the panel READS `/social` and `/party` and
 * asks for changes over the same REST calls the gateway sign-in uses; the
 * layer the player stands on pushes `social` module events (a friend
 * request, an invitation, a member joining), each of which also arrives as
 * a chat line, so the panel refreshes on an event and polls slowly while
 * open. Slash commands in chat (`/friend <name>`, `/invite <name>`,
 * `/accept`, `/decline`, `/kick <name>`, `/leader <name>`, `/leave`,
 * `/travel <name>`, `/unfriend <name>`, `/social`) are the keyboard route
 * to the same calls.
 */

import type { GatewayClient } from "./gateway.js";

export interface SocialEvent {
  kind: string;
  characterId?: string;
  name?: string;
  code?: string;
  zone?: string | null;
}

interface Presence {
  characterId: string;
  name: string;
  online: boolean;
  server: string | null;
  zone: string | null;
}

interface SocialView {
  friends: Presence[];
  incoming: Array<{ characterId: string; name: string }>;
  outgoing: Array<{ characterId: string; name: string }>;
  party: { code: string; leader: string; members: Presence[] } | null;
  invites: Array<{ code: string; from: string; name: string }>;
}

export interface SocialPanelOptions {
  client: GatewayClient;
  /** The character this tab is playing (null before Play). */
  character(): { id: string; name: string } | null;
  /** A line into the chat log (results of commands, errors). */
  say(text: string): void;
  /** Zone name lookup for the friend list (a region id → its name); optional. */
  zoneName?(id: string): string;
}

export interface SocialPanel {
  root: HTMLElement;
  toggle(): void;
  open(): void;
  close(): void;
  refresh(): Promise<void>;
  /** A `social` module event from the layer. */
  handleEvent(event: SocialEvent): void;
  /** A chat slash command; true when it was one of ours. */
  command(name: string, args: string[]): boolean;
  dispose(): void;
}

const CSS = `
.hg-social{position:fixed;top:56px;right:16px;width:340px;max-height:calc(100vh - 80px);overflow:auto;background:#0d1117;border:1px solid #30363d;border-radius:10px;padding:14px 16px 12px;box-shadow:0 12px 40px rgba(0,0,0,.5);font:13px/1.45 ui-sans-serif,system-ui,sans-serif;color:#e6edf3;z-index:9000}
.hg-social[hidden]{display:none}
.hg-social h1{margin:0 0 8px;font-size:14px;font-weight:600;display:flex;justify-content:space-between;align-items:center}
.hg-social h1 span{color:#8b949e;font-weight:400;font-size:11px}
.hg-social h2{margin:12px 0 4px;font-size:11px;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:.06em}
.hg-social ul{list-style:none;margin:0;padding:0}
.hg-social li{display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid #161b22}
.hg-social li .who{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hg-social li .where{color:#8b949e;font-size:11px}
.hg-social .dot{width:8px;height:8px;border-radius:50%;background:#484f58;flex:none}
.hg-social .dot.on{background:#3fb950}
.hg-social .lead{color:#d29922;margin-right:2px}
.hg-social button{background:#21262d;border:1px solid #30363d;border-radius:6px;color:#e6edf3;padding:2px 8px;font:inherit;font-size:11px;cursor:pointer}
.hg-social button:hover{border-color:#58a6ff}
.hg-social button.hg-primary{background:#1f6feb;border-color:#1f6feb;font-weight:600}
.hg-social button.hg-danger:hover{border-color:#f85149;color:#f85149}
.hg-social .row{display:flex;gap:6px;margin-top:8px}
.hg-social input{flex:1;min-width:0;background:#161b22;border:1px solid #30363d;border-radius:6px;color:#e6edf3;padding:5px 8px;font:inherit;outline:none}
.hg-social input:focus{border-color:#58a6ff}
.hg-social .muted{color:#8b949e;font-size:12px;padding:4px 0}
.hg-social .err{color:#f85149;font-size:12px;min-height:1em;margin-top:6px}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { text?: string } = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { text, ...rest } = props;
  Object.assign(node, rest);
  if (text !== undefined) node.textContent = text;
  for (const c of children) node.append(c);
  return node;
}

export function mountSocialPanel(opts: SocialPanelOptions): SocialPanel {
  if (!document.getElementById("hg-social-css")) {
    const style = document.createElement("style");
    style.id = "hg-social-css";
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  const root = el("div", { className: "hg-social" });
  root.hidden = true;
  root.setAttribute("aria-label", "Friends and party");
  const title = el("h1", {}, "Friends & party", el("span", { text: "O to close" }));
  const body = el("div");
  const nameInput = el("input", { placeholder: "character name" });
  const addBtn = el("button", { text: "Add friend" });
  const inviteBtn = el("button", { text: "Invite" });
  const err = el("div", { className: "err" });
  root.append(title, body, el("div", { className: "row" }, nameInput, addBtn, inviteBtn), err);
  document.body.appendChild(root);

  let view: SocialView | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let busy = false;
  const zoneName = (id: string | null): string => (id ? (opts.zoneName?.(id) ?? id) : "");

  const api = async (path: string, extra: Record<string, unknown> = {}, method: "GET" | "POST" = "POST"): Promise<any> => {
    const character = opts.character();
    if (!character) throw new Error("not playing");
    if (method === "GET") return opts.client.api(`${path}?characterId=${encodeURIComponent(character.id)}`);
    return opts.client.api(path, { characterId: character.id, ...extra });
  };

  const act = async (label: string, run: () => Promise<string | void>): Promise<void> => {
    if (busy) return;
    busy = true;
    err.textContent = "";
    try {
      const line = await run();
      if (line) opts.say(line);
      await refresh();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      err.textContent = `${label}: ${text}`;
      opts.say(`${label}: ${text}`);
    } finally {
      busy = false;
    }
  };

  // -- the calls, shared by buttons and slash commands --------------------------------
  const calls = {
    friend: (name: string) => act("add friend", async () => {
      const r = await api("/social/friend/request", { name });
      return r.outcome === "sent" ? `Friend request sent to ${r.name}.` : r.outcome === "accepted" ? `${r.name} is now your friend.` : r.outcome === "already-friends" ? `${r.name} is already your friend.` : r.outcome === "already-sent" ? `${r.name} already has your request.` : "Your friend list is full.";
    }),
    acceptFriend: (name?: string) => act("accept", async () => `${(await api("/social/friend/accept", name ? { name } : {})).friend} is now your friend.`),
    declineFriend: (name?: string) => act("decline", async () => `Declined ${(await api("/social/friend/decline", name ? { name } : {})).declined}.`),
    unfriend: (name: string) => act("remove friend", async () => `Removed ${(await api("/social/friend/remove", { name })).removed}.`),
    invite: (name: string) => act("invite", async () => {
      const r = await api("/party/invite", { name });
      return `Invited ${r.invited} to the party${r.online ? "" : " (they are offline; the invitation waits)"}.`;
    }),
    acceptInvite: (code?: string) => act("accept", async () => {
      const r = await api("/party/accept", code ? { code } : {});
      return r.pulled ? "Joined the party — moving to your party's server." : "Joined the party.";
    }),
    declineInvite: (code?: string) => act("decline", async () => {
      await api("/party/decline", code ? { code } : {});
      return "Invitation declined.";
    }),
    leave: () => act("leave", async () => {
      await api("/party/leave");
      return "You left the party.";
    }),
    kick: (name: string) => act("kick", async () => {
      await api("/party/kick", { name });
      return `${name} was removed from the party.`;
    }),
    leader: (name: string) => act("leader", async () => {
      await api("/party/leader", { name });
      return `${name} is now the party leader.`;
    }),
    travel: (name: string) => act("travel", async () => {
      const r = await api("/social/travel", { name });
      return r.moved ? `Travelling to ${name}…` : r.reason === "already there" ? `You are already where ${name} is.` : `Could not travel to ${name}.`;
    }),
  };

  // -- rendering ------------------------------------------------------------------------
  const presenceLine = (p: Presence): string => (p.online ? (p.zone ? zoneName(p.zone) : "online") : "offline");
  const render = (): void => {
    body.replaceChildren();
    const me = opts.character();
    if (!view || !me) {
      body.append(el("div", { className: "muted", text: me ? "Loading…" : "Play a character to see friends and party." }));
      return;
    }
    const party = view.party;
    body.append(el("h2", { text: party ? `Party · ${party.members.length}/8 · code ${party.code}` : "Party" }));
    if (party) {
      const isLeader = party.leader === me.id;
      const list = el("ul");
      for (const m of party.members) {
        const li = el("li", {}, el("span", { className: `dot${m.online ? " on" : ""}` }), el("span", { className: "who" }, party.leader === m.characterId ? el("span", { className: "lead", text: "★ " }) : "", m.name, " ", el("span", { className: "where", text: presenceLine(m) })));
        if (isLeader && m.characterId !== me.id) {
          const lead = el("button", { text: "leader" });
          lead.onclick = () => void calls.leader(m.name);
          const kick = el("button", { className: "hg-danger", text: "kick" });
          kick.onclick = () => void calls.kick(m.name);
          li.append(lead, kick);
        }
        list.append(li);
      }
      body.append(list);
      const leave = el("button", { className: "hg-danger", text: "Leave party" });
      leave.onclick = () => void calls.leave();
      body.append(el("div", { className: "row" }, leave));
    } else body.append(el("div", { className: "muted", text: "Not in a party. Invite a friend below, or accept an invitation." }));
    if (view.invites.length > 0) {
      body.append(el("h2", { text: "Invitations" }));
      const list = el("ul");
      for (const inv of view.invites) {
        const yes = el("button", { className: "hg-primary", text: "join" });
        yes.onclick = () => void calls.acceptInvite(inv.code);
        const no = el("button", { text: "decline" });
        no.onclick = () => void calls.declineInvite(inv.code);
        list.append(el("li", {}, el("span", { className: "who", text: `${inv.name}'s party` }), yes, no));
      }
      body.append(list);
    }
    body.append(el("h2", { text: `Friends · ${view.friends.filter((f) => f.online).length} online` }));
    if (view.friends.length === 0) body.append(el("div", { className: "muted", text: "No friends yet — add one by character name." }));
    else {
      const list = el("ul");
      const sorted = [...view.friends].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
      for (const f of sorted) {
        const li = el("li", {}, el("span", { className: `dot${f.online ? " on" : ""}` }), el("span", { className: "who" }, f.name, " ", el("span", { className: "where", text: presenceLine(f) })));
        if (f.online) {
          const inv = el("button", { text: "invite" });
          inv.onclick = () => void calls.invite(f.name);
          const go = el("button", { text: "travel" });
          go.onclick = () => void calls.travel(f.name);
          li.append(inv, go);
        }
        const rm = el("button", { className: "hg-danger", text: "×", title: "remove friend" });
        rm.onclick = () => void calls.unfriend(f.name);
        li.append(rm);
        list.append(li);
      }
      body.append(list);
    }
    if (view.incoming.length > 0) {
      body.append(el("h2", { text: "Friend requests" }));
      const list = el("ul");
      for (const r of view.incoming) {
        const yes = el("button", { className: "hg-primary", text: "accept" });
        yes.onclick = () => void calls.acceptFriend(r.name);
        const no = el("button", { text: "decline" });
        no.onclick = () => void calls.declineFriend(r.name);
        list.append(el("li", {}, el("span", { className: "who", text: r.name }), yes, no));
      }
      body.append(list);
    }
    if (view.outgoing.length > 0) {
      body.append(el("h2", { text: "Sent" }));
      const list = el("ul");
      for (const r of view.outgoing) {
        const cancel = el("button", { text: "cancel" });
        cancel.onclick = () => void calls.declineFriend(r.name);
        list.append(el("li", {}, el("span", { className: "who", text: `${r.name} — waiting` }), cancel));
      }
      body.append(list);
    }
  };

  const refresh = async (): Promise<void> => {
    if (!opts.character()) {
      view = null;
      render();
      return;
    }
    try {
      view = (await api("/social", {}, "GET")) as SocialView;
      err.textContent = "";
    } catch (error) {
      err.textContent = error instanceof Error ? error.message : String(error);
    }
    render();
  };

  const open = (): void => {
    root.hidden = false;
    void refresh();
    timer ??= setInterval(() => void refresh(), 15_000);
    nameInput.focus();
  };
  const close = (): void => {
    root.hidden = true;
    if (timer) clearInterval(timer);
    timer = null;
  };
  addBtn.onclick = () => {
    const name = nameInput.value.trim();
    if (name) void calls.friend(name).then(() => (nameInput.value = ""));
  };
  inviteBtn.onclick = () => {
    const name = nameInput.value.trim();
    if (name) void calls.invite(name).then(() => (nameInput.value = ""));
  };
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addBtn.click();
    if (e.key === "Escape") close();
    e.stopPropagation();
  });

  const command = (name: string, args: string[]): boolean => {
    const rest = args.join(" ").trim();
    const need = (what: string): string | null => {
      if (rest) return rest;
      opts.say(`/${name} needs a ${what}`);
      return null;
    };
    switch (name) {
      case "friend":
      case "addfriend": {
        const n = need("character name");
        if (n) void calls.friend(n);
        return true;
      }
      case "unfriend": {
        const n = need("character name");
        if (n) void calls.unfriend(n);
        return true;
      }
      case "invite": {
        const n = need("character name");
        if (n) void calls.invite(n);
        return true;
      }
      case "accept":
        // a party invitation first, else the latest friend request
        void (view?.invites.length ? calls.acceptInvite() : calls.acceptFriend(rest || undefined));
        return true;
      case "decline":
        void (view?.invites.length ? calls.declineInvite() : calls.declineFriend(rest || undefined));
        return true;
      case "kick": {
        const n = need("member name");
        if (n) void calls.kick(n);
        return true;
      }
      case "leader": {
        const n = need("member name");
        if (n) void calls.leader(n);
        return true;
      }
      case "leave":
        void calls.leave();
        return true;
      case "travel": {
        const n = need("friend's name");
        if (n) void calls.travel(n);
        return true;
      }
      case "social":
      case "friends":
        toggle();
        return true;
      default:
        return false;
    }
  };

  const toggle = (): void => (root.hidden ? open() : close());
  const handleEvent = (event: SocialEvent): void => {
    // keep the cached view current between polls so /accept knows what is waiting
    if (view) {
      if (event.kind === "party.invite" && event.code && event.characterId && event.name) view.invites.push({ code: event.code, from: event.characterId, name: event.name });
      if (event.kind === "friend.request" && event.characterId && event.name) view.incoming.push({ characterId: event.characterId, name: event.name });
    }
    if (!root.hidden) void refresh();
    else void refresh(); // cheap, and the next open shows the truth without a flash
  };

  render();
  return {
    root,
    toggle,
    open,
    close,
    refresh,
    handleEvent,
    command,
    dispose: () => {
      close();
      root.remove();
    },
  };
}
