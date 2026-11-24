// Runtime configuration, parsed once at startup. Fails fast on bad values.

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
  /** Where registered OAuth clients (not tokens) are persisted. */
  clientsFile: process.env.CLIENTS_FILE?.trim() || "data/clients.json",

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
