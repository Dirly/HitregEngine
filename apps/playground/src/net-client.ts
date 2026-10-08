/**
 * net-client.ts — the networked session's BROWSER half, shared by both hosts.
 *
 * main.ts (the editor host in `?server=` / `?gateway=` mode) and play.ts (a
 * published `multiplayer: "server"` game) join a dedicated server through the
 * same code: the NetPresence hooks for the local body and replicated events
 * (`peerPresenceHooks`), the sign-in → character → Play flow with friends and
 * party (`mountGatewayFlow`), chat + voice (`createSessionComms`), and what the
 * player sees while the link is down (`mountConnectionOverlay`). The logic
 * underneath — where to connect, the `world` module, suspension, intent,
 * reconciliation, the link's states — is net-session.ts.
 *
 * Nothing here touches the dev server (`/__hitreg/*`), the editor or the
 * developer console: a published bundle ships all of it.
 */
import * as THREE from "three/webgpu";
import {
  registerCharacterNetState,
  registerTransferLockNetState,
  type CharacterCreation,
  type NetStateStore,
  type SceneDoc,
} from "@hitreg/core";
import { fitAction, type EventBus } from "@hitreg/scripting";
import type { AnimationSystem } from "@hitreg/render";
import type { PhysicsSim } from "@hitreg/physics";
import {
  clientLink,
  createComms,
  hostLink,
  localLink,
  netStateMembership,
  registerCommsNetState,
  type Comms,
  type CommsLink,
} from "@hitreg/comms";
import { mountCommsUI } from "@hitreg/comms/ui";
import type { NetPresence, NetPresenceOptions } from "./net-presence.js";
import { GatewayClient, mountGatewayPanel, type GatewayCharacter, type GatewayPanel, type PlayGrant } from "./gateway.js";
import type { CreationPreview } from "./character-creation.js";
import { mountSocialPanel, type SocialPanel } from "./social.js";
import { mountToasts } from "./toasts.js";
import {
  movementIntent,
  reconcileCorrection,
  reconcileShift,
  newReconcileStats,
  type BodyFlags,
  type ControllerParams,
  type NetRuntimeWorld,
  connectionView,
  type NetTransfer,
} from "./net-session.js";

type EntityDoc = SceneDoc["entities"][string];

// -- the local body + replicated events -------------------------------------------------

/** What a host exposes so the shared hooks can read and correct its local body. */
export interface PeerHost {
  /** Is a play session running (the editor host: play mode; a published game: always). */
  playing(): boolean;
  localPlayerId(): string | null;
  objectOf(id: string): THREE.Object3D | undefined;
  /** The entity doc behind an id — the scene's or a server-spawned one. */
  docOf(id: string): EntityDoc | undefined;
  sim(): PhysicsSim | null;
  /** Is this key held (the play session's InputService)? */
  isDown(code: string): boolean;
  /** The rig's flat aim, the same the controller steers by. */
  viewForward(): [number, number];
  animations: AnimationSystem;
  eventBus(): EventBus | null;
}

type PeerHooks = Required<
  Pick<
    NetPresenceOptions,
    | "getLocalPlayer"
    | "getLocalInput"
    | "reconcileLocalPlayer"
    | "setEntityAnim"
    | "collectNetEvents"
    | "onNetEvents"
    | "emitLocalEvent"
    | "collectPeerEvents"
    | "onPeerEvent"
  >
>;

/**
 * The NetPresence hooks every client fills the same way: where the local body
 * is, the movement intent it sends, reconciliation against the authority's
 * verdict, remote animation, and the event bus in both directions. A host
 * spreads these into its NetPresence options and adds its own (a P2P host's
 * replicas and proxies stay in main.ts).
 */
export function peerPresenceHooks(host: PeerHost): PeerHooks {
  // what reconciliation did, for probes and the console (net-session.ts ReconcileStats)
  const reconcileStats = newReconcileStats();
  (globalThis as { __hitregReconcile?: unknown }).__hitregReconcile = reconcileStats;
  let lastSnapshotAt = performance.now();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler(0, 0, 0, "YXZ");
  const { animations } = host;
  /**
   * A replicated layer played the way the authority plays it: a held guard
   * once and clamped, a channel looped at rate 1, a one-shot fitted to the
   * window it had when it STARTED here — the window shrinks every snapshot,
   * and refitting each frame would speed the clip up as it plays.
   */
  const remoteLayerOptions = (id: string, layer: string, opts?: { action?: number; mode?: "hold" | "loop"; lock?: number }) => {
    // a stance carry: looped, held in step with the legs like the owner's
    if (typeof opts?.lock === "number") return { fade: 0.2, loop: true, phaseLock: opts.lock };
    if (opts?.mode === "loop") return { fade: 0.08, loop: true, speed: 1 };
    if (opts?.mode === "hold") return { fade: 0.08, loop: false, speed: 1 };
    if (opts?.action === undefined) return { fade: 0.08, loop: true };
    if (animations.layerClip(id) === layer) {
      return { fade: 0.08, loop: false, speed: animations.layerSpeedOf(id) };
    }
    const fit = fitAction(animations.clipDuration(id, layer), opts.action);
    return { fade: 0.08, loop: fit.loop, speed: fit.rate };
  };
  return {
    getLocalPlayer: () => {
      if (!host.playing()) return null;
      const playerId = host.localPlayerId();
      const object = playerId ? host.objectOf(playerId) : undefined;
      if (!object) return null;
      object.getWorldQuaternion(quat);
      euler.setFromQuaternion(quat);
      // the BODY's position, not the drawn one: what is logged with each input (and compared with the authority's
      // answer) must be in the same frame reconciliation moves. The drawn position is smoothed between physics
      // steps, so for a frame after a snap it sits halfway between old and new — logged there, it read as a fresh
      // error, snapped again, and logged another half-way point: the body bounced across the map
      const body = playerId ? host.sim()?.getPosition(playerId) : null;
      if (body) return { position: body, yaw: euler.y };
      object.getWorldPosition(pos);
      return { position: [pos.x, pos.y, pos.z], yaw: euler.y };
    },
    // movement INTENT for the authority — the controller's own input mapping
    getLocalInput: () => {
      if (!host.playing()) return null;
      const playerId = host.localPlayerId();
      const object = playerId ? host.objectOf(playerId) : undefined;
      if (!playerId || !object) return null;
      const script = host.docOf(playerId)?.components["script"] as { params?: ControllerParams } | undefined;
      return movementIntent((code) => host.isDown(code), host.viewForward(), object.userData as BodyFlags, script?.params);
    },
    // client-side prediction reconciliation (net-session.ts reconcileShift; reconcileCorrection without `then`)
    reconcileLocalPlayer: (p, then) => {
      const sim = host.sim();
      if (!host.playing() || !sim) return;
      const playerId = host.localPlayerId();
      if (!playerId) return;
      const position = sim.getPosition(playerId);
      if (!position) return;
      const state = { position };
      const now = performance.now();
      const fix = then
        ? reconcileShift(state.position, then, p)
        : { ...reconcileCorrection(state.position, p), err: [p[0] - state.position[0], p[1] - state.position[1], p[2] - state.position[2]] as [number, number, number] };
      // how far the body moves: NetPresence moves its logged predictions with it (no double-applied correction)
      const moved: [number, number, number] | undefined =
        fix.kind === "none" ? undefined : [fix.to[0] - state.position[0], fix.to[1] - state.position[1], fix.to[2] - state.position[2]];
      if (fix.kind === "snap") sim.setPosition(playerId, fix.to);
      else if (fix.kind === "nudge") sim.setTranslation(playerId, fix.to);
      // the counters: how often, how far, and the likeliest why
      const size = Math.hypot(fix.err[0], fix.err[1], fix.err[2]);
      reconcileStats.snapshots++;
      if (size > 0.5) {
        reconcileStats.over05++;
        if (fix.kind === "nudge") reconcileStats.nudges++;
        if (fix.kind === "snap") reconcileStats.snaps++;
        reconcileStats.maxM = Math.max(reconcileStats.maxM, Math.round(size * 100) / 100);
        const ud = (host.objectOf(playerId)?.userData ?? {}) as { impulseVel?: unknown; frozen?: boolean };
        const reason = !then
          ? "legacy"
          : now - lastSnapshotAt > 150
            ? "late"
            : ud.frozen || ud.impulseVel !== undefined
              ? "skill"
              : Math.abs(fix.err[1]) > Math.hypot(fix.err[0], fix.err[2])
                ? "vertical"
                : "speed";
        reconcileStats.reasons[reason] = (reconcileStats.reasons[reason] ?? 0) + 1;
      }
      lastSnapshotAt = now;
      return moved;
    },
    setEntityAnim: (id, clip, layer, opts) => {
      animations.play(id, clip, 0.25);
      // the authority's gait rate, or every remote body skates
      animations.setSpeed(id, opts?.rate ?? 1);
      if (layer) animations.playLayer(id, layer, remoteLayerOptions(id, layer, opts));
      else animations.clearLayer(id, 0.15);
    },
    // replicated gameplay events ride the session event bus in both directions
    collectNetEvents: () => host.eventBus()?.takeOutbox() ?? [],
    onNetEvents: (events) => host.eventBus()?.injectRemote(events),
    emitLocalEvent: (name, payload) => host.eventBus()?.emit(name, payload),
    // peer→authority requests (to-authority events): out on peers, in on host
    collectPeerEvents: () => host.eventBus()?.takeCommandOutbox() ?? [],
    onPeerEvent: (from, events) => host.eventBus()?.injectFromPeer(from, events),
  };
}

/** The session's replicated namespaces both hosts register on the presence's store. */
export function registerSessionNetState(netState: NetStateStore): void {
  // comms membership (team/party) is plain netState so scripts assign it with the API they already have
  registerCommsNetState(netState);
  // character/<bodyId> sheets (character-sheet builtin) — validated, in the spec
  registerCharacterNetState(netState);
  registerTransferLockNetState(netState); // transferLock/<bodyId> — combat holds a body on its server
}

// -- sign in, pick a character, Play ----------------------------------------------------

export interface GatewayFlowOptions {
  /** Main's gateway (`http(s)://host:8780`). */
  url: string;
  presence: NetPresence;
  /** The game's own creation rules — used when main does not publish any. */
  localCreation?: () => CharacterCreation | null;
  textureUrl?: (id: string) => string | undefined;
  preview?: (canvas: HTMLCanvasElement, creation: CharacterCreation) => CreationPreview | null;
  /** A recipe zone id → its name (social lines, toasts). */
  zoneName(id: string): string;
  /** A system line in chat (comms is made after this flow; read it lazily). */
  say(text: string): void;
  /**
   * Main placed us, before anything is dialed: return false to take the grant
   * elsewhere (a published page reloads on the grant's scene with it).
   */
  accept?(grant: PlayGrant, character: GatewayCharacter): boolean;
  /** Main placed us: the host's own reaction (the editor enters play mode). */
  onPlay?(grant: PlayGrant, character: GatewayCharacter): void;
  /** Skip the panel and play this grant (a published page reloaded on another scene). */
  resume?: { grant: PlayGrant; character: GatewayCharacter } | undefined;
}

export interface GatewayFlow {
  client: GatewayClient;
  panel: GatewayPanel;
  social: SocialPanel;
  /** The layer main placed us on; null until Play (and after leaving). */
  grant(): PlayGrant | null;
  character(): { id: string; name: string } | null;
  /**
   * A `transfer` from the layer: bye here, dial there with the ticket. The
   * rendered world stays; `onSceneChange` runs when the destination hosts a
   * different scene (a portal into an instance) — it returns "reload" when the
   * page will reload on that scene and dial from there (nothing is dialed here).
   */
  transfer(t: NetTransfer, currentScene: string, onSceneChange: (scene: string, label: string, grant: PlayGrant) => "reload" | void): void;
  /** Ask main again for the same character (an expired or refused ticket). */
  rejoin(): Promise<void>;
  /** Drop the session and show the sign-in / character card again. */
  leave(): void;
  /** Status line text for the corner ("name · layer-1"). */
  setStatus(text: string): void;
  /** What the overlay is waiting for while a transfer is in flight, else null. */
  transferring(): string | null;
  /** Our body arrived: a transfer is complete. */
  arrived(): void;
}

/**
 * Gateway mode: sign in at main, pick (or create) a character, and Play dials
 * the layer main chose. Friends, party and guild events from the layer go to
 * the social panel (O) and to toasts.
 */
export function mountGatewayFlow(opts: GatewayFlowOptions): GatewayFlow {
  const client = new GatewayClient(opts.url);
  let grant: PlayGrant | null = null;
  let playing: { id: string; name: string } | null = null;
  let transferring: string | null = null;
  const play = (g: PlayGrant, character: GatewayCharacter): void => {
    if (opts.accept && !opts.accept(g, character)) return;
    grant = g;
    playing = { id: character.id, name: character.name };
    console.log(`[net] gateway placed ${character.name} on ${g.server} (${g.url})`);
    opts.presence.rehome(g.url, g.ticket);
    opts.onPlay?.(g, character);
    void social.refresh();
  };
  const panel = mountGatewayPanel({
    client,
    ...(opts.localCreation ? { localCreation: opts.localCreation } : {}),
    ...(opts.textureUrl ? { textureUrl: opts.textureUrl } : {}),
    ...(opts.preview ? { preview: opts.preview } : {}),
    ...(opts.resume ? { resume: opts.resume } : {}),
    onPlay: play,
  });
  // friends and party: main's facts, the layer's events, one panel (O) and the slash commands
  const social = mountSocialPanel({
    client,
    character: () => playing,
    say: (text) => opts.say(text),
    zoneName: (id) => opts.zoneName(id),
  });
  // the things worth a glance even with chat scrolled away: a friend arriving, an ask
  const toasts = mountToasts();
  opts.presence.onSession((session) => {
    if (session?.role !== "peer") return;
    session.client.onModule("social", (raw) => {
      const event = raw as { kind: string; name?: string; zone?: string | null };
      social.handleEvent(event);
      const zone = event.zone ? ` in ${opts.zoneName(event.zone)}` : "";
      if (event.kind === "friend.online") toasts.show(`${event.name} is online${zone}`, "friend");
      else if (event.kind === "friend.offline") toasts.show(`${event.name} went offline`, "friend");
      else if (event.kind === "friend.request") toasts.show(`${event.name} wants to be your friend — O to answer`, "friend", 8000);
      else if (event.kind === "friend.accepted") toasts.show(`${event.name} is now your friend`, "friend");
      else if (event.kind === "party.invite") toasts.show(`${event.name} invited you to a party — /accept or O`, "party", 8000);
      else if (event.kind === "party.joined") toasts.show(`${event.name} joined the party`, "party");
      else if (event.kind === "party.left") toasts.show(`${event.name} left the party`, "party");
      else if (event.kind === "party.kicked") toasts.show("You were removed from the party", "party");
      else if (event.kind === "guild.invite") toasts.show(`${event.name} invited you to ${(event as { guildName?: string }).guildName ?? "a guild"} — /guild accept or O`, "guild", 8000);
      else if (event.kind === "guild.joined") toasts.show(`${event.name} joined the guild`, "guild");
      else if (event.kind === "guild.left") toasts.show(`${event.name} left the guild`, "guild");
      else if (event.kind === "guild.kicked") toasts.show("You were removed from the guild", "guild");
      else if (event.kind === "guild.leader") toasts.show(`${event.name} now leads the guild`, "guild");
      else if (event.kind === "guild.motd") toasts.show(`Guild: ${(event as { text?: string }).text ?? ""}`, "guild", 8000);
      else if (event.kind === "guild.disbanded") toasts.show("The guild was disbanded", "guild");
    });
  });
  return {
    client,
    panel,
    social,
    grant: () => grant,
    character: () => playing,
    transfer: (t, currentScene, onSceneChange) => {
      console.log(`[net] transfer → ${t.url} (${t.reason})`);
      grant = { url: t.url, ticket: t.ticket, server: t.srv ?? "?", scene: grant?.scene ?? currentScene };
      transferring = t.srv ?? "another server";
      panel.setStatus(`${playing?.name ?? ""} · transferring (${t.reason})…`);
      // an instance of another scene (a portal): the rendered world changes too
      if (t.scene && t.scene !== currentScene) {
        grant = { ...grant, scene: t.scene };
        if (onSceneChange(t.scene, t.reason.startsWith("portal:back") ? "Leaving…" : "Entering…", grant) === "reload") return;
      }
      opts.presence.rehome(t.url, t.ticket);
    },
    rejoin: async () => {
      if (!playing) {
        panel.show();
        return;
      }
      const character = (client.session?.characters ?? []).find((c) => c.id === playing!.id) ?? { id: playing.id, name: playing.name, createdAt: "" };
      play(await client.play(character.id), character);
    },
    leave: () => {
      grant = null;
      transferring = null;
      playing = null;
      opts.presence.rehome("gateway", "");
      panel.show("characters");
    },
    setStatus: (text) => panel.setStatus(text),
    transferring: () => transferring,
    arrived: () => {
      transferring = null;
      panel.setStatus(`${playing?.name ?? ""} · ${grant?.server ?? "server"}`);
    },
  };
}

// -- chat + voice ---------------------------------------------------------------------

export interface SessionCommsOptions {
  presence: NetPresence;
  eventBus(): EventBus | null;
  playing(): boolean;
  /** Whichever camera rendered last frame — voice is heard from there. */
  listenerCamera(): THREE.Camera;
  /** Zone chat: the zone at a world position (a recipe region, the climate cell, the scene). */
  zoneOf(position: [number, number, number]): string | null;
  /** The social panel's slash commands get first refusal (gateway mode). */
  social?: SocialPanel | null;
  /** Player commands scripts declare (`static playerCommands`, e.g. /dance) — kept in published builds. */
  runPlayerCommand?(name: string, args: string[]): { text?: string } | null | undefined;
  /** The developer console's turn, when this build has one. */
  devCommand?(name: string, args: string[]): boolean;
}

export interface SessionComms {
  comms: Comms;
  /** The host-side link learns about joins/leaves from here (RoomHost has no roster hook). */
  notifyRoster(): void;
}

/**
 * Text chat + VoIP (@hitreg/comms), riding the room's module channel. Chat
 * routes on the host (a dedicated layer routes it server-side), voice gates on
 * the sender (docs/comms.md). The link follows the session: host / peer / alone.
 */
export function createSessionComms(opts: SessionCommsOptions): SessionComms {
  const { presence } = opts;
  const self = presence.self();
  const pos = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const up = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  let hostCommsLink: (CommsLink & { notifyRoster(): void }) | null = null;
  const comms = createComms({
    link: localLink(self.peerId, self.name),
    membership: netStateMembership(presence.netState),
    positionOf: (peerId) => presence.positionOf(peerId),
    // zone chat: the zone under the player (a P2P host routes it here; a dedicated layer routes it server-side)
    zoneOf: (peerId) => {
      const p = presence.positionOf(peerId);
      return p ? opts.zoneOf(p) : null;
    },
    listenerPose: () => {
      if (!opts.playing()) return null;
      const cam = opts.listenerCamera();
      cam.getWorldPosition(pos);
      cam.getWorldDirection(fwd);
      up.set(0, 1, 0).applyQuaternion(cam.getWorldQuaternion(quat));
      return { position: [pos.x, pos.y, pos.z], forward: [fwd.x, fwd.y, fwd.z], up: [up.x, up.y, up.z] };
    },
    // "/team red" from a player — dev/social default; a rules-driven game
    // passes chat.allowSelfAssign:false and writes these keys from a script
    assign: (peerId, kind, value) => {
      const key = `comms.${kind}/${peerId}`;
      if (value === null) {
        presence.netState.delete(key);
        return true;
      }
      return presence.netState.set(key, value);
    },
    emitEvent: (name, payload) => opts.eventBus()?.emit(name, payload),
    chat: { proximityRadius: 25 },
    voice: { proximityRadius: 25, fullVolumeRadius: 5, mode: "ptt" },
  });
  presence.onSession((session) => {
    hostCommsLink = null;
    if (!session) {
      comms.setLink(localLink(self.peerId, self.name));
    } else if (session.role === "host") {
      hostCommsLink = hostLink(session.host, session.selfId, session.selfName);
      comms.setLink(hostCommsLink);
    } else {
      // the host's display name isn't in the roster the client receives —
      // mirror the dev naming scheme (guest-<id tail>) until identities are real
      comms.setLink(clientLink(session.client, session.hostId, `guest-${session.hostId.slice(-4)}`, session.selfId, session.selfName));
    }
  });
  mountCommsUI({
    chat: comms.chat,
    voice: comms.voice,
    onCommand: (name, args) => {
      if (opts.social?.command(name, args)) return true;
      const played = opts.runPlayerCommand?.(name, args);
      if (played) {
        if (played.text) comms.chat.system(played.text);
        return true;
      }
      return opts.devCommand?.(name, args) ?? false;
    },
  }); // bottom-left overlay; Enter opens
  comms.voice.attachKeyboard(window); // V = say, B = team, N = party (push-to-talk)
  comms.chat.system(
    opts.social
      ? "Enter: chat · /s /z /g /t /p /gu pick a channel · O: friends, party & guild · /friend /invite /accept /decline /travel <name> · /guild … · /report <name> <reason> · mic button for voice"
      : "Enter: chat · /s /z /g /t /p pick a channel · /team x · /party x · mic button for voice",
  );
  return { comms, notifyRoster: () => hostCommsLink?.notifyRoster() };
}

// -- what the player sees while the link is down -------------------------------------------

const OVERLAY_STYLE = `
.hg-camp{position:fixed;left:50%;bottom:180px;transform:translateX(-50%);z-index:18500;max-width:calc(100vw - 48px);width:340px;box-sizing:border-box;padding:16px 20px;background:#14120ff2;border:1px solid #79603b;box-shadow:0 6px 24px #000b;font:14px/1.5 Georgia,serif;color:#efdcaf;text-align:center}
.hg-camp[hidden]{display:none}
.hg-camp p{font-size:12px;color:#baab90;margin:6px 0 12px}
.hg-camp button{font:inherit;background:#241d15;color:#efdcaf;border:1px solid #79603b;padding:6px 14px;cursor:pointer}
.hg-camp button:focus-visible{outline:2px solid #e0b970;outline-offset:2px}
body.mmo-ui-active .hg-camp{background:linear-gradient(#14120fea,#14120ff2),var(--stone)}
body.mmo-ui-active .hg-camp::before{content:"";position:absolute;inset:-12px;pointer-events:none;border:20px solid transparent;border-image:var(--panel) var(--panel-slice,58) / 20px var(--panel-repeat,repeat)}

.hg-conn{position:fixed;inset:0;z-index:19000;display:flex;align-items:center;justify-content:center;background:rgba(11,14,20,.55);font:13px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#c9d1d9}
.hg-conn[hidden]{display:none}
.hg-conn .hg-conn-card{width:min(360px,calc(100vw - 32px));box-sizing:border-box;background:#0d1117;border:1px solid #30363d;border-radius:10px;padding:16px 18px 14px;box-shadow:0 12px 40px rgba(0,0,0,.5)}
.hg-conn h2{margin:0 0 6px;font-size:15px;font-weight:600;color:#e6edf3}
.hg-conn p{margin:0;color:#8b949e;font-size:12px;white-space:pre-wrap;word-break:break-word}
.hg-conn .hg-conn-row{display:flex;gap:8px;margin-top:12px}
.hg-conn .hg-conn-row:empty{display:none}
.hg-conn button{background:#21262d;border:1px solid #30363d;color:#c9d1d9;border-radius:6px;padding:7px 12px;font:inherit;cursor:pointer}
.hg-conn button:hover{border-color:#8b949e}
.hg-conn button:focus-visible{outline:2px solid #58a6ff;outline-offset:1px}
.hg-conn button.hg-primary{background:#1f6feb;border-color:#1f6feb;color:#fff;font-weight:600}
`;

export interface ConnectionOverlayOptions {
  presence: NetPresence;
  world: NetRuntimeWorld;
  /** Should a session exist right now (granted / playing)? */
  wanted(): boolean;
  gateway?: GatewayFlow | null;
}

/**
 * The connection overlay: connecting, entering the world, lost (with the
 * re-dial countdown), refused (with the reason), travelling between servers —
 * each with a way out (retry now, ask the gateway for a fresh ticket, back to
 * the character card). Hidden whenever our body stands in the world.
 */
export function mountConnectionOverlay(opts: ConnectionOverlayOptions): { dispose(): void } {
  const style = document.createElement("style");
  style.textContent = OVERLAY_STYLE;
  document.head.appendChild(style);
  const root = document.createElement("div");
  root.className = "hg-conn";
  root.hidden = true;
  root.setAttribute("role", "status");
  root.setAttribute("aria-live", "polite");
  const card = document.createElement("div");
  card.className = "hg-conn-card";
  const title = document.createElement("h2");
  const detail = document.createElement("p");
  const row = document.createElement("div");
  row.className = "hg-conn-row";
  card.append(title, detail, row);
  root.appendChild(card);
  document.body.appendChild(root);
  let lastKey = "";
  let busy = false;
  let directLogout = false;
  const camp = document.createElement("div"); camp.className = "hg-camp"; camp.hidden = true;
  camp.setAttribute("role", "status"); camp.setAttribute("aria-live", "polite");
  const campTitle = document.createElement("strong");
  const campDetail = document.createElement("p"); campDetail.textContent = "Stay still. Movement, actions, or combat cancel camp.";
  const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "Cancel camp";
  const cancelCamp = (): void => {
    opts.presence.requestLogout(true);
  };
  cancel.onclick = cancelCamp;
  camp.append(campTitle, campDetail, cancel); document.body.append(camp);
  const escape = (event: KeyboardEvent): void => { if (!camp.hidden && event.code === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); cancelCamp(); } };
  window.addEventListener("keydown", escape, true);
  let unworld: (() => void) | null = null;
  const uncamp = opts.presence.onSession((session) => {
    unworld?.(); unworld = null; camp.hidden = true;
    if (session?.role !== "peer") return;
    directLogout = false;
    unworld = session.client.onModule("world", (raw) => {
      const message = raw as { t?: unknown; remaining?: unknown; reason?: unknown } | null;
      if (message?.t === "camp" && (message.remaining === null || (typeof message.remaining === "number" && Number.isFinite(message.remaining) && message.remaining >= 0))) {
        camp.hidden = message.remaining === null && !message.reason;
        campTitle.textContent = message.remaining === null ? "Camp ended" : message.remaining === 0 ? "Saving your character…" : `Making camp · ${message.remaining}s`;
        campDetail.textContent = typeof message.reason === "string" ? message.reason : "Stay still. Movement, actions, or combat cancel camp.";
        cancel.textContent = message.remaining === null ? "Dismiss" : "Cancel camp";
        cancel.onclick = message.remaining === null ? () => { camp.hidden = true; } : cancelCamp;
        if (!camp.hidden && document.pointerLockElement) document.exitPointerLock();
      } else if (message?.t === "logout") {
        camp.hidden = true;
        if (opts.gateway) opts.gateway.leave();
        else { opts.presence.rehome("gateway", ""); opts.world.clear(); directLogout = true; }
        render();
      }
    });
  });
  const labels = { retry: "Retry now", rejoin: "Rejoin", signin: "Back to characters" } as const;
  const act = (action: "retry" | "rejoin" | "signin"): void => {
    if (busy) return;
    if (action === "retry") opts.presence.retryNow();
    else if (action === "signin") opts.gateway?.leave();
    else if (action === "rejoin" && opts.gateway) {
      busy = true;
      detail.textContent = "Asking the gateway for a fresh ticket…";
      void opts.gateway
        .rejoin()
        .catch((error: unknown) => {
          detail.textContent = `The gateway said no: ${error instanceof Error ? error.message : String(error)}`;
        })
        .finally(() => {
          busy = false;
          lastKey = "";
        });
    }
    render();
  };
  const render = (): void => {
    if (busy) return;
    if (directLogout) {
      root.hidden = false; title.textContent = "Logged out"; detail.textContent = "Your character has left the server. Reload to rejoin this development server.";
      if (lastKey !== "logout") { lastKey = "logout"; const reload = document.createElement("button"); reload.textContent = "Rejoin server"; reload.onclick = () => location.reload(); row.replaceChildren(reload); }
      return;
    }
    const view = connectionView(opts.presence.serverLink(), {
      wanted: opts.wanted(),
      hasSelf: opts.world.selfId !== null,
      gateway: !!opts.gateway,
      transferring: opts.gateway?.transferring() ?? null,
      now: performance.now(),
    });
    root.hidden = !view.show;
    const key = `${view.title}|${view.detail}|${view.actions.join(",")}`;
    if (!view.show || key === lastKey) return;
    lastKey = key;
    title.textContent = view.title;
    detail.textContent = view.detail;
    const hadFocus = root.contains(document.activeElement);
    row.replaceChildren(
      ...view.actions.map((action, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = labels[action];
        if (i === 0) b.className = "hg-primary";
        b.onclick = () => act(action);
        return b;
      }),
    );
    if (hadFocus) (row.firstElementChild as HTMLButtonElement | null)?.focus();
  };
  const unsub = opts.presence.onServerLink(() => render());
  // the countdown, and "entering the world" clearing when the body lands
  const timer = setInterval(render, 250);
  return {
    dispose: () => {
      unsub();
      uncamp(); unworld?.();
      window.removeEventListener("keydown", escape, true); camp.remove();
      clearInterval(timer);
      root.remove();
      style.remove();
    },
  };
}
