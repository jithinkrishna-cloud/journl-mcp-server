// OAuth 2.1 authorization server for ChatGPT, backed by JournL's password login.
// The SDK's mcpAuthRouter handles discovery metadata, dynamic client registration,
// PKCE (S256) verification and the token endpoint; this module supplies the JournL parts.

import { InvalidGrantError, InvalidRequestError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { config } from "../config/index.js";
import { loginPage } from "./loginPage.js";
import { sendHtml } from "./html.js";
import { clientsStore, deleteAccessToken, getAccessToken, peekAuthCode, putAccessToken, putPendingLogin, takeAuthCode } from "./store.js";

export const sameResource = (a, b) => String(a).replace(/\/+$/, "") === String(b).replace(/\/+$/, "");

export const oauthProvider = {
  clientsStore,

  /** Start of the OAuth flow: show the JournL sign-in page. */
  async authorize(client, params, res) {
    if (params.resource && !sameResource(params.resource, config.mcpResourceUrl)) {
      throw new InvalidRequestError(`Unknown resource ${params.resource}`);
    }
    const pendingId = putPendingLogin({
      clientId: client.client_id,
      clientName: client.client_name,
      params,
      expiresAtMs: Date.now() + config.pendingLoginTtlMs,
    });
    sendHtml(res, 200, loginPage({ pendingId, clientName: client.client_name }));
  },

  async challengeForAuthorizationCode(client, code) {
    const entry = peekAuthCode(code);
    if (!entry || entry.clientId !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code");
    return entry.params.codeChallenge;
  },

  async exchangeAuthorizationCode(client, code, _codeVerifier, redirectUri, resource) {
    const entry = takeAuthCode(code);
    if (!entry || entry.clientId !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code");
    if (redirectUri && redirectUri !== entry.params.redirectUri) throw new InvalidGrantError("redirect_uri does not match");
    if (resource && !sameResource(resource, config.mcpResourceUrl)) throw new InvalidGrantError("resource does not match");

    const expiresIn = entry.session.expiresAt - Math.floor(Date.now() / 1000);
    if (expiresIn <= 0) throw new InvalidGrantError("JournL session already expired");

    const accessToken = putAccessToken({ clientId: client.client_id, resource: config.mcpResourceUrl, session: entry.session });
    // No refresh token: a JournL session cannot be renewed without the user's password,
    // so when it ends ChatGPT gets a 401 and asks the user to sign in again.
    return { access_token: accessToken, token_type: "bearer", expires_in: expiresIn };
  },

  async exchangeRefreshToken() {
    throw new InvalidGrantError("Refresh tokens are not supported; please sign in again");
  },

  async verifyAccessToken(token) {
    const entry = getAccessToken(token);
    if (!entry) throw new InvalidTokenError("Invalid or expired access token");
    return {
      token,
      clientId: entry.clientId,
      scopes: [],
      expiresAt: entry.session.expiresAt,
      resource: entry.resource,
      extra: { session: entry.session },
    };
  },

  async revokeToken(_client, request) {
    deleteAccessToken(request.token);
  },
};
