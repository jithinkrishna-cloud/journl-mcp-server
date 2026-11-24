// OAuth state. Owns registered clients, pending logins, authorization codes and
// access tokens. No accounting data is stored here.
//
// - Registered clients are persisted to a JSON file: ChatGPT registers once per
//   connection and reuses the client, so losing it would break the connection.
// - Pending logins, codes and tokens (which hold the user's JournL JWT) live in
//   memory only. A restart signs users out; ChatGPT then re-runs the OAuth flow.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config } from "../config/index.js";

const CLIENTS_FILE = resolve(config.clientsFile);

export const newSecret = () => randomBytes(32).toString("base64url");
const hash = (value) => createHash("sha256").update(value).digest("base64url");

function loadClients() {
  try {
    const parsed = JSON.parse(readFileSync(CLIENTS_FILE, "utf8"));
    return new Map(Object.entries(parsed));
  } catch (err) {
    if (err.code === "ENOENT") return new Map();
    throw new Error(`Cannot read ${CLIENTS_FILE}: ${err.message}`);
  }
}

const clients = loadClients();

function saveClients() {
  mkdirSync(dirname(CLIENTS_FILE), { recursive: true });
  const tmp = `${CLIENTS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(clients), null, 2));
  renameSync(tmp, CLIENTS_FILE);
}

export const clientsStore = {
  getClient(clientId) {
    return clients.get(clientId);
  },
  registerClient(client) {
    clients.set(client.client_id, client);
    saveClients();
    return client;
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
