// The sign-in page shown inside ChatGPT's OAuth window.
// The CSP (see html.js) allows inline styles only: no scripts, images or web fonts.

import { config } from "../config/index.js";

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const privacyPolicyUrl = config.privacyPolicyUrl;

const baseStyles = `
  :root {
    color-scheme: light dark;
    --bg:#ffffff; --text:#111827; --muted:#6b7280; --line:#d1d5db;
    --accent:#111827; --accent-text:#ffffff; --ring:rgba(17,24,39,.15);
    --err:#b42318; --err-bg:#fef3f2;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#0d1117; --text:#e6e8eb; --muted:#8b949e; --line:#30363d;
      --accent:#e6e8eb; --accent-text:#0d1117; --ring:rgba(230,232,235,.2);
      --err:#ff9b93; --err-bg:#2a1414;
    }
  }
  * { box-sizing:border-box; }
  body {
    margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    padding:32px 16px; background:var(--bg); color:var(--text);
    font:15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  main { width:100%; max-width:340px; }
  h1 { font-size:20px; line-height:1.3; letter-spacing:-.01em; margin:0 0 6px; font-weight:600; }
  .muted { margin:0; color:var(--muted); font-size:14px; }
  a { color:inherit; }
`;

/** Host the user returns to after signing in (always chatgpt.com in production). */
function hostOf(uri) {
  try {
    return new URL(uri).host;
  } catch {
    return "";
  }
}

export function loginPage({ pendingId, returnTo, error, email }) {
  // Fixed name, not the client's self-declared client_name, which anyone can set at registration.
  const client = "ChatGPT";
  const returnHost = escapeHtml(hostOf(returnTo));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect JournL</title>
<style>
${baseStyles}
  header { margin-bottom:24px; }
  .alert { padding:10px 12px; margin:0 0 16px; border-radius:8px; background:var(--err-bg); color:var(--err); font-size:14px; }
  label { display:block; font-size:13px; font-weight:500; margin:0 0 6px; }
  input[type=email], input[type=password] {
    width:100%; height:42px; padding:0 12px; margin-bottom:14px;
    border:1px solid var(--line); border-radius:8px; background:transparent; color:inherit; font:inherit; outline:none;
  }
  input:focus { border-color:var(--text); box-shadow:0 0 0 3px var(--ring); }
  button {
    width:100%; height:42px; margin-top:4px; border:0; border-radius:8px; cursor:pointer;
    background:var(--accent); color:var(--accent-text); font:inherit; font-weight:600;
  }
  button:hover { opacity:.9; }
  button:focus-visible { outline:none; box-shadow:0 0 0 3px var(--ring); }
  footer { margin-top:20px; font-size:12.5px; color:var(--muted); }
</style>
</head>
<body>
<main>
  <header>
    <h1>Connect ${client} to JournL</h1>
    <p class="muted">${
      config.enableWriteTools
        ? `Access to your company's reports. ${client} can also create sales and purchase invoices, after you confirm each one; it cannot change or delete anything.`
        : `Read-only access to your company's reports. ${client} cannot create, change or delete anything.`
    }</p>
  </header>

  ${error ? `<div class="alert" role="alert">${escapeHtml(error)}</div>` : ""}

  <form method="post" action="/login">
    <input type="hidden" name="pending" value="${escapeHtml(pendingId)}">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="username" required autofocus value="${escapeHtml(email)}">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">Sign in</button>
  </form>

  <footer>
    ${returnHost ? `You'll return to <strong>${returnHost}</strong>. ` : ""}Your password goes only to JournL and is never stored.
    ${privacyPolicyUrl ? `<a href="${escapeHtml(privacyPolicyUrl)}" target="_blank" rel="noopener">Privacy</a>` : ""}
  </footer>
</main>
</body>
</html>`;
}

export function errorPage(message) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>JournL sign-in</title>
<style>
${baseStyles}
</style>
</head>
<body>
<main>
  <h1>Sign-in link expired</h1>
  <p class="muted">${escapeHtml(message)}</p>
</main>
</body>
</html>`;
}
