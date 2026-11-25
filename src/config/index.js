// Runtime configuration, parsed once at startup. Fails fast on bad values.

import { randomBytes } from "node:crypto";

function parseUrl(name, value) {
  try {
    return new URL(String(value).replace(/\/+$/, ""));
  } catch {
    throw new Error(`${name} must be an absolute URL, got "${value}"`);
  }
}

function positiveNumber(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

const port = positiveNumber("PORT", 3100);

/** Public base URL ChatGPT uses to reach this server (https, or http://localhost for local testing). */
const publicUrl = parseUrl("PUBLIC_URL", process.env.PUBLIC_URL?.trim() || `http://localhost:${port}`);
const base = publicUrl.href.replace(/\/$/, "");

/** Required outside localhost; a random per-process value is used for local runs. */
function clientIdSecret() {
  const value = process.env.CLIENT_ID_SECRET?.trim() ?? "";
  if (value.length >= 32) return value;
  if (value) throw new Error("CLIENT_ID_SECRET must be at least 32 characters");
  if (publicUrl.hostname === "localhost" || publicUrl.hostname === "127.0.0.1") return randomBytes(32).toString("base64url");
  throw new Error("CLIENT_ID_SECRET is required (32+ random characters, kept the same across deploys)");
}

export const config = Object.freeze({
  port,
  /** OAuth issuer is this server's public base URL. */
  issuerUrl: publicUrl,
  /** The protected MCP resource. ChatGPT sends this exact value as the OAuth `resource` parameter. */
  mcpResourceUrl: new URL(`${base}/mcp`),
  /** JournL backend API base, e.g. https://testapi.bizpolebooks.com */
  journlApiBaseUrl: parseUrl("JOURNL_API_BASE_URL", process.env.JOURNL_API_BASE_URL?.trim() || "https://testapi.bizpolebooks.com"),
  /** Timeout for each call to the JournL API. */
  journlTimeoutMs: positiveNumber("JOURNL_TIMEOUT_MS", 30_000),
  /** Shown on the sign-in page; required for a public ChatGPT listing. */
  privacyPolicyUrl: process.env.PRIVACY_POLICY_URL?.trim() || "",
  /** Domain-verification token from the OpenAI plugin portal (served at /.well-known/openai-apps-challenge). */
  openaiAppsChallenge: process.env.OPENAI_APPS_CHALLENGE?.trim() || "",
  /**
   * Extra exact OAuth redirect URIs allowed besides ChatGPT's (comma-separated), for
   * testing tools such as MCP Inspector. Leave empty in production.
   */
  extraRedirectUris: Object.freeze(
    (process.env.OAUTH_EXTRA_REDIRECT_URIS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ),
  /** Clients saved by earlier versions (read only; new clients are not written here). */
  clientsFile: process.env.CLIENTS_FILE?.trim() || "data/clients.json",
  /**
   * Signs OAuth client IDs so registered clients survive restarts and redeploys without
   * storage. Must stay the same across deploys: changing it disconnects every ChatGPT user.
   */
  clientIdSecret: clientIdSecret(),
  /**
   * Client IDs ChatGPT still holds from before signed IDs, re-admitted as public clients:
   * comma-separated `clientId=redirectUri`. The redirect must still be a ChatGPT callback.
   */
  restoredClients: Object.freeze(
    (process.env.OAUTH_RESTORED_CLIENTS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((entry) => {
        const at = entry.indexOf("=");
        if (at < 1) throw new Error(`OAUTH_RESTORED_CLIENTS entry must be clientId=redirectUri, got "${entry}"`);
        return Object.freeze({ clientId: entry.slice(0, at).trim(), redirectUri: entry.slice(at + 1).trim() });
      }),
  ),

  /** How long a user has to submit the login form after ChatGPT starts authorization. */
  pendingLoginTtlMs: 10 * 60_000,
  /** Authorization codes are single-use and short-lived. */
  authCodeTtlMs: 60_000,

  /** Failed sign-ins allowed per client IP per window. */
  loginFailureLimit: positiveNumber("LOGIN_FAILURE_LIMIT", 10),
  loginFailureWindowMs: 15 * 60_000,
  /** MCP requests allowed per signed-in user per minute. */
  mcpRequestsPerMinute: positiveNumber("MCP_REQUESTS_PER_MINUTE", 120),
  /** Incoming HTTP request timeout (must exceed journlTimeoutMs). */
  httpRequestTimeoutMs: positiveNumber("HTTP_REQUEST_TIMEOUT_MS", 60_000),
});
