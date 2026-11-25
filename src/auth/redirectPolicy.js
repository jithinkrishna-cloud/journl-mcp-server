// Which OAuth redirect URIs this server will send authorization codes to.
//
// Dynamic client registration is open, so without this check anyone could register a
// client with their own redirect URI, send a victim the /authorize link, and receive
// the victim's code after they sign in. Only ChatGPT's documented callbacks are allowed:
//   https://chatgpt.com/connector_platform_oauth_redirect
//   https://chatgpt.com/connector/oauth/{callback_id}
// plus exact URIs listed in OAUTH_EXTRA_REDIRECT_URIS (e.g. MCP Inspector during testing).

import { config } from "../config/index.js";

const CHATGPT_ORIGIN = "https://chatgpt.com";
const CHATGPT_FIXED_PATH = "/connector_platform_oauth_redirect";
const CHATGPT_CALLBACK_PATH = /^\/connector\/oauth\/[A-Za-z0-9._~-]{1,200}$/;

/** True if an authorization code may be sent to this redirect URI. */
export function isAllowedRedirectUri(value) {
  if (typeof value !== "string") return false;
  if (config.extraRedirectUris.includes(value)) return true;

  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  // Compare the parsed URL with its own canonical form, so tricks such as
  // user-info, explicit ports, odd casing or dot segments never pass.
  if (url.href !== value || url.origin !== CHATGPT_ORIGIN) return false;
  if (url.username || url.password || url.search || url.hash) return false;
  return url.pathname === CHATGPT_FIXED_PATH || CHATGPT_CALLBACK_PATH.test(url.pathname);
}

/** True if every redirect URI a client registered is allowed. */
export const clientRedirectsAllowed = (client) =>
  Array.isArray(client?.redirect_uris) && client.redirect_uris.length > 0 && client.redirect_uris.every(isAllowedRedirectUri);
