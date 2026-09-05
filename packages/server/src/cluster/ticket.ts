/**
 * Play tickets — the credential a client presents to a layer.
 *
 * The MAIN server (login, placement) mints one per play session; a LAYER
 * verifies it with the shared cluster secret and takes the identity from
 * it, never from the tab. Tickets are short-lived, bound to one server, and
 * carry the persistence revisions the destination must load before it
 * spawns the body — that binding is what makes a transfer between two layers
 * safe: the source commits, the ticket names the revision, the destination
 * refuses to start from anything older. HMAC-SHA256 over a JSON body,
 * base64url on the wire; no library.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface TicketClaims {
  /** Account id. */
  sub: string;
  /** Character id — also the peer id the layer assigns. */
  chr: string;
  /** Display name. */
  name: string;
  /** Server id this ticket admits to (a layer or an instance). */
  srv: string;
  /** Persistence revisions per namespace the destination must load at least (transfer safety). */
  rev?: Record<string, number>;
  /** Why the holder is arriving (join, transfer, instance) — informational. */
  reason?: string;
  /** Issued-at / expiry, unix seconds. */
  iat: number;
  exp: number;
  /** Random per ticket so two tickets for the same claims differ. */
  nonce: string;
}

const b64 = (s: string | Buffer): string => Buffer.from(s).toString("base64url");

function mac(secret: string, body: string): Buffer {
  return createHmac("sha256", secret).update(body).digest();
}

export function signTicket(secret: string, claims: Omit<TicketClaims, "iat" | "exp" | "nonce"> & { ttlSeconds?: number; now?: number }): string {
  const now = claims.now ?? Math.floor(Date.now() / 1000);
  const { ttlSeconds, now: _now, ...rest } = claims;
  const full: TicketClaims = {
    ...rest,
    iat: now,
    exp: now + (ttlSeconds ?? 120),
    nonce: Math.random().toString(36).slice(2, 12),
  };
  const body = b64(JSON.stringify(full));
  return `${body}.${b64(mac(secret, body))}`;
}

export type TicketVerdict = { ok: true; claims: TicketClaims } | { ok: false; reason: string };

/** Verify signature, expiry and audience. `now` in unix seconds (tests). */
export function verifyTicket(secret: string, ticket: string, expect: { srv: string; now?: number }): TicketVerdict {
  const dot = ticket.indexOf(".");
  if (dot <= 0) return { ok: false, reason: "malformed ticket" };
  const body = ticket.slice(0, dot);
  const sig = Buffer.from(ticket.slice(dot + 1), "base64url");
  const want = mac(secret, body);
  if (sig.length !== want.length || !timingSafeEqual(sig, want)) return { ok: false, reason: "bad ticket signature" };
  let claims: TicketClaims;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TicketClaims;
  } catch {
    return { ok: false, reason: "malformed ticket" };
  }
  if (typeof claims.sub !== "string" || typeof claims.chr !== "string" || typeof claims.srv !== "string" || typeof claims.exp !== "number") {
    return { ok: false, reason: "malformed ticket" };
  }
  const now = expect.now ?? Math.floor(Date.now() / 1000);
  if (now > claims.exp) return { ok: false, reason: "ticket expired" };
  if (claims.srv !== expect.srv) return { ok: false, reason: "ticket is for another server" };
  return { ok: true, claims };
}

/**
 * Session tokens (a logged-in account talking to the gateway HTTP) use the
 * same scheme with a longer life and no server audience.
 */
export function signSession(secret: string, sub: string, ttlSeconds = 24 * 3600, now = Math.floor(Date.now() / 1000)): string {
  return signTicket(secret, { sub, chr: "", name: "", srv: "gateway", ttlSeconds, now });
}

export function verifySession(secret: string, token: string, now?: number): { ok: true; sub: string } | { ok: false; reason: string } {
  const v = verifyTicket(secret, token, { srv: "gateway", ...(now !== undefined ? { now } : {}) });
  return v.ok ? { ok: true, sub: v.claims.sub } : v;
}
