// Thin client for JournL's existing backend API. This module owns the
// interpretation of JournL responses; callers receive parsed facts or typed errors.

import { config } from "../config/index.js";

/** The JournL token was rejected or has expired; the user must sign in again. */
export class JournlAuthError extends Error {
  constructor(message = "Your JournL session has expired. Please reconnect JournL in ChatGPT.") {
    super(message);
    this.name = "JournlAuthError";
  }
}

/** JournL answered, but refused or failed the request. `message` is JournL's own text. */
export class JournlApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "JournlApiError";
    this.status = status;
  }
}

/** Roles that own company books and may connect. Platform admin roles are not supported. */
const COMPANY_ROLES = new Set(["company", "company_user"]);

async function request(method, path, { query, body, token } = {}) {
  const url = new URL(path.replace(/^\//, ""), `${config.journlApiBaseUrl.href.replace(/\/$/, "")}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(config.journlTimeoutMs),
    });
  } catch (err) {
    const reason = err?.name === "TimeoutError" ? "timed out" : "could not be reached";
    throw new JournlApiError(`JournL ${reason}. Please try again.`, 0);
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    // Non-JSON body (proxy error page etc.); handled by the status checks below.
  }

  if (res.status === 401) throw new JournlAuthError(payload?.code === "ACCOUNT_DELETED" ? payload.message : undefined);
  if (!res.ok || payload?.success === false || payload === null) {
    // Server errors can carry internal details (some JournL handlers return raw database
    // error text), so only refusals (4xx and success:false) pass JournL's own message on.
    const own = typeof payload?.message === "string" ? payload.message.trim() : "";
    const message =
      res.status >= 500 || !own ? "JournL had a problem completing this request. Please try again." : own.slice(0, 300);
    throw new JournlApiError(message, res.status);
  }
  return payload;
}

/** Reads the `exp` claim of a JournL JWT (expiry only; JournL itself verifies the signature). */
function jwtExpiresAt(token) {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof claims.exp === "number" ? claims.exp : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Signs in with JournL's password-checking login (POST /auth/login).
 * Never uses the passwordless /auth/login-user or /auth/login-company-user routes.
 *
 * @returns {Promise<{ok: true, session: object} | {ok: false, message: string}>}
 */
export async function login(email, password) {
  let payload;
  try {
    payload = await request("POST", "/auth/login", { body: { email, password } });
  } catch (err) {
    if (err instanceof JournlApiError || err instanceof JournlAuthError) return { ok: false, message: err.message };
    throw err;
  }

  const accounts = Array.isArray(payload.data) ? payload.data : [];
  const account = accounts[0];
  if (!account?.token) {
    // JournL returns several accounts without a token when one email has more than one
    // account. Picking one would need the passwordless login routes, which we refuse to use.
    return accounts.length > 1
      ? { ok: false, message: "This email has more than one JournL account. Signing in to multi-account emails is not supported yet." }
      : { ok: false, message: "JournL did not return a session for this login." };
  }
  if (!COMPANY_ROLES.has(account.role)) {
    return { ok: false, message: "Only JournL company owners and company users can connect to ChatGPT." };
  }

  const company = Array.isArray(account.companyDetails) ? account.companyDetails[0] : account.companyDetails;
  const companyId = company?.id ?? account.companyId;
  if (companyId === undefined || companyId === null) return { ok: false, message: "JournL did not return a company for this login." };

  const expiresAt = jwtExpiresAt(account.token);
  if (!expiresAt || expiresAt * 1000 <= Date.now()) return { ok: false, message: "JournL returned an expired session." };

  return {
    ok: true,
    session: {
      journlToken: account.token,
      expiresAt,
      userId: String(account.id),
      name: account.name ?? null,
      email: account.email ?? email,
      role: account.role,
      companyId: String(companyId),
      companyName: company?.name ?? account.companyName ?? null,
      currency: company?.countrySymbol ?? null,
      branchId: account.branchId ?? null,
      // The company's GST state; decides CGST+SGST or IGST on invoices created through the write tools.
      companyStateId: company?.stateId ?? null,
      // Per-feature rights for company users, as JournL returned them at login.
      permissions: Array.isArray(account.permissionData) ? account.permissionData : [],
    },
  };
}

/** GET a JournL endpoint with the user's JournL token; returns the response `data`. */
export async function get(path, query, journlToken) {
  const payload = await request("GET", path, { query, token: journlToken });
  return payload.data;
}

/** POST a JSON body to a JournL endpoint with the user's JournL token; returns the response `data`. */
export async function post(path, body, journlToken) {
  const payload = await request("POST", path, { body, token: journlToken });
  return payload.data;
}
