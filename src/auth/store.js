// OAuth state. Owns registered clients, pending logins, authorization codes and
// access tokens. No accounting data is stored here.
//
// - Registered clients need no storage. ChatGPT registers once per connection and
//   reuses the client ID indefinitely, so the ID itself is signed and carries the
//   client's redirect URIs and auth method; any instance can rebuild the client after
//   a restart or redeploy. A confidential client's secret is derived from its ID.
// - Clients saved to CLIENTS_FILE by earlier versions, and IDs listed in
//   OAUTH_RESTORED_CLIENTS, are still accepted (read only).
// - Pending logins, codes and tokens (which hold the user's JournL JWT) live in
//   memory only. A restart signs users out; ChatGPT then re-runs the OAuth flow.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { InvalidClientMetadataError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { config } from "../config/index.js";
import { clientRedirectsAllowed } from "./redirectPolicy.js";

const CLIENTS_FILE = resolve(config.clientsFile);

export const newSecret = () => randomBytes(32).toString("base64url");
const hash = (value) => createHash("sha256").update(value).digest("base64url");

// --- signed client IDs: "jc1.<base64url JSON {r: redirect_uris, m: auth method}>.<mac>" ---

const SIGNED_PREFIX = "jc1.";
const MAX_CLIENT_ID_LENGTH = 4096;
const mac = (label, value) => createHmac("sha256", config.clientIdSecret).update(`${label}:${value}`).digest("base64url");
const safeEqual = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function signedClientId(client) {
  const payload = Buffer.from(JSON.stringify({ r: client.redirect_uris, m: client.token_endpoint_auth_method ?? "client_secret_post" })).toString("base64url");
  const body = SIGNED_PREFIX + payload;
  return `${body}.${mac("id", body)}`;
}

/** Rebuilds a client from a signed ID, or undefined if the ID is not ours or was altered. */
function clientFromSignedId(clientId) {
  if (typeof clientId !== "string" || !clientId.startsWith(SIGNED_PREFIX) || clientId.length > MAX_CLIENT_ID_LENGTH) return undefined;
  const dot = clientId.lastIndexOf(".");
  const body = clientId.slice(0, dot);
  if (!safeEqual(clientId.slice(dot + 1), mac("id", body))) return undefined;
  let data;
  try {
    data = JSON.parse(Buffer.from(body.slice(SIGNED_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!Array.isArray(data?.r) || typeof data?.m !== "string") return undefined;
  const client = { client_id: clientId, redirect_uris: data.r, token_endpoint_auth_method: data.m };
  if (data.m !== "none") Object.assign(client, { client_secret: mac("secret", clientId), client_secret_expires_at: 0 });
  return client;
}

// --- clients from earlier versions ------------------------------------------------

const restoredClients = new Map(
  config.restoredClients.map(({ clientId, redirectUri }) => [clientId, { client_id: clientId, redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }]),
);

function loadClients() {
  try {
    const parsed = JSON.parse(readFileSync(CLIENTS_FILE, "utf8"));
    return new Map(Object.entries(parsed));
  } catch (err) {
    if (err.code === "ENOENT") return new Map();
    throw new Error(`Cannot read ${CLIENTS_FILE}: ${err.message}`);
  }
}

const savedClients = loadClients();

export const clientsStore = {
  getClient(clientId) {
    const client = clientFromSignedId(clientId) ?? restoredClients.get(clientId) ?? savedClients.get(clientId);
    // Clients whose redirect URIs are not ChatGPT callbacks (e.g. saved before the
    // allowlist existed) are treated as unknown, so /authorize answers with a plain
    // error instead of redirecting to their URI.
    return client && clientRedirectsAllowed(client) ? client : undefined;
  },
  registerClient(client) {
    if (!clientRedirectsAllowed(client)) {
      throw new InvalidClientMetadataError("redirect_uris must be ChatGPT connector callback URLs");
    }
    const registered = { ...client, client_id: signedClientId(client) };
    if (registered.token_endpoint_auth_method !== "none") {
      registered.client_secret = mac("secret", registered.client_id);
      registered.client_secret_expires_at = 0;
    }
    return registered;
  },
};

// --- short-lived, in-memory state ------------------------------------------

const pendingLogins = new Map(); // pendingId -> { clientId, params, expiresAtMs, attempt?, redirect? }
const authCodes = new Map(); // hash(code) -> { clientId, params, session, expiresAtMs }
const accessTokens = new Map(); // hash(token) -> { clientId, resource, session }

export function putPendingLogin(entry) {
  const id = newSecret();
  pendingLogins.set(id, entry);
  return id;
}

export function getPendingLogin(id) {
  const entry = typeof id === "string" ? pendingLogins.get(id) : undefined;
  if (!entry || entry.expiresAtMs <= Date.now()) return undefined;
  return entry;
}


export function putAuthCode(entry) {
  const code = newSecret();
  authCodes.set(hash(code), entry);
  return code;
}

export function peekAuthCode(code) {
  const entry = authCodes.get(hash(code));
  if (!entry || entry.expiresAtMs <= Date.now()) return undefined;
  return entry;
}

/** Codes are single use: taking one removes it. */
export function takeAuthCode(code) {
  const entry = peekAuthCode(code);
  authCodes.delete(hash(code));
  return entry;
}

export function putAccessToken(entry) {
  const token = newSecret();
  accessTokens.set(hash(token), entry);
  return token;
}

export function getAccessToken(token) {
  const entry = accessTokens.get(hash(token));
  if (!entry || entry.session.expiresAt * 1000 <= Date.now()) return undefined;
  return entry;
}

export const deleteAccessToken = (token) => accessTokens.delete(hash(token));

/** Ends every MCP token that carries this JournL session (e.g. JournL rejected it). */
export function revokeSession(session) {
  for (const [key, entry] of accessTokens) if (entry.session === session) accessTokens.delete(key);
}

// Drop expired entries so memory stays bounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingLogins) if (v.expiresAtMs <= now) pendingLogins.delete(k);
  for (const [k, v] of authCodes) if (v.expiresAtMs <= now) authCodes.delete(k);
  for (const [k, v] of accessTokens) if (v.session.expiresAt * 1000 <= now) accessTokens.delete(k);
}, 60_000).unref();
