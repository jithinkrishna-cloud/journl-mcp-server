// The sign-in page shown inside ChatGPT's OAuth window.
// The CSP (see html.js) allows inline styles only: no scripts, images or web fonts,
// so icons are inline SVG and everything else is plain CSS.

import { config } from "../config/index.js";

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const privacyPolicyUrl = config.privacyPolicyUrl;

const icon = {
  check: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 10.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  cross: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 6l8 8M14 6l-8 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  lock: `<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4" y="9" width="12" height="8" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M7 9V6.5a3 3 0 016 0V9" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`,
  alert: `<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 6.2v4.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="10" cy="13.6" r="1" fill="currentColor"/></svg>`,
  link: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h12M12 6l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  ledger: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 8h8M8 12h8M8 16h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
};

const baseStyles = `
  :root {
    color-scheme: light dark;
    --bg:#f3f5f8; --bg-grad:#e8eefb; --card:#ffffff; --text:#111827; --muted:#5b6472; --subtle:#8a93a2;
    --line:#e3e7ee; --field:#ffffff; --field-line:#cfd5df;
    --accent:#1f5eff; --accent-hover:#1a4fd6; --accent-soft:#eaf0ff; --ring:rgba(31,94,255,.22);
    --ok:#0f8a5f; --ok-soft:#e6f6ef; --no:#b42318; --no-soft:#fdecea;
    --err:#b42318; --err-bg:#fef3f2; --err-line:#fecdca;
    --shadow:0 1px 2px rgba(16,24,40,.04), 0 12px 32px -8px rgba(16,24,40,.12);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#0d1117; --bg-grad:#131c2e; --card:#161b23; --text:#e8ecf2; --muted:#a1aab8; --subtle:#7b8494;
      --line:#262d38; --field:#0f141b; --field-line:#323a47;
      --accent:#4d86ff; --accent-hover:#6a9aff; --accent-soft:#1a2540; --ring:rgba(77,134,255,.3);
      --ok:#3ccf91; --ok-soft:#12291f; --no:#ff8a80; --no-soft:#2d1717;
      --err:#ff9b93; --err-bg:#2a1414; --err-line:#5a2723;
      --shadow:0 1px 2px rgba(0,0,0,.3), 0 16px 40px -12px rgba(0,0,0,.6);
    }
  }
  * { box-sizing:border-box; }
  body {
    margin:0; min-height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center;
    padding:32px 16px; color:var(--text);
    background:radial-gradient(1200px 500px at 50% -10%, var(--bg-grad), transparent 70%), var(--bg);
    font:15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  svg { width:100%; height:100%; display:block; }
  .card {
    flex:none; width:100%; max-width:420px; background:var(--card); border:1px solid var(--line);
    border-radius:16px; box-shadow:var(--shadow); overflow:hidden;
  }
  .card-body { padding:32px 32px 28px; }
  .brand { display:flex; align-items:center; gap:10px; margin-bottom:24px; }
  .mark {
    width:36px; height:36px; border-radius:10px; display:grid; place-items:center; flex:none;
    background:linear-gradient(135deg, var(--accent), #6d4dff); color:#fff; padding:8px;
  }
  .wordmark { font-weight:700; font-size:17px; letter-spacing:-.01em; }
  h1 { font-size:22px; line-height:1.3; letter-spacing:-.02em; margin:0 0 6px; font-weight:650; }
  .lead { margin:0; color:var(--muted); font-size:14.5px; }
  a { color:var(--accent); text-decoration:none; font-weight:500; }
  a:hover { text-decoration:underline; }
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
  const clientInitial = "C";
  const returnHost = escapeHtml(hostOf(returnTo));

  const canRead = [
    "Ledger names and statements",
    "Receivables and payables ageing",
    "Account group totals and cash flow",
    "GSTR-1 and GSTR-2B reports",
    "Stock values and business summary",
  ];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect JournL</title>
<style>
${baseStyles}
  .connect { display:flex; align-items:center; justify-content:center; gap:12px; margin:0 0 22px; }
  .app {
    width:52px; height:52px; border-radius:14px; display:grid; place-items:center;
    font-weight:700; font-size:20px; border:1px solid var(--line); background:var(--card);
    box-shadow:0 1px 2px rgba(16,24,40,.06);
  }
  .app.client { color:var(--text); }
  .app.journl { background:linear-gradient(135deg, var(--accent), #6d4dff); color:#fff; border-color:transparent; padding:13px; }
  .bridge { display:flex; align-items:center; gap:6px; color:var(--subtle); }
  .bridge i { width:4px; height:4px; border-radius:50%; background:currentColor; opacity:.6; }
  .bridge .arrow { width:22px; height:22px; border-radius:50%; background:var(--accent-soft); color:var(--accent); padding:4px; }
  .head { text-align:center; margin-bottom:24px; }
  .pill {
    display:inline-flex; align-items:center; gap:6px; margin-top:12px; padding:4px 10px; border-radius:999px;
    background:var(--ok-soft); color:var(--ok); font-size:12.5px; font-weight:600;
  }
  .pill span { width:14px; height:14px; }
  .dest { margin:10px 0 0; font-size:13px; color:var(--muted); }

  .alert {
    display:flex; gap:10px; align-items:flex-start; padding:11px 12px; margin:0 0 18px;
    border:1px solid var(--err-line); background:var(--err-bg); color:var(--err);
    border-radius:10px; font-size:14px;
  }
  .alert span { width:18px; height:18px; flex:none; margin-top:1px; }

  .field { margin-bottom:16px; }
  label { display:block; font-weight:600; font-size:13.5px; margin:0 0 6px; }
  input[type=email], input[type=password] {
    width:100%; height:44px; padding:0 14px; border:1px solid var(--field-line); border-radius:10px;
    background:var(--field); color:inherit; font:inherit; outline:none;
    transition:border-color .15s, box-shadow .15s;
  }
  input::placeholder { color:var(--subtle); }
  input:hover { border-color:var(--subtle); }
  input:focus { border-color:var(--accent); box-shadow:0 0 0 4px var(--ring); }
  button {
    width:100%; height:46px; margin-top:6px; border:0; border-radius:10px; cursor:pointer;
    background:var(--accent); color:#fff; font:inherit; font-weight:600; font-size:15px;
    box-shadow:0 1px 2px rgba(16,24,40,.1), inset 0 1px 0 rgba(255,255,255,.12);
    transition:background .15s, transform .05s;
  }
  button:hover { background:var(--accent-hover); }
  button:active { transform:translateY(1px); }
  button:focus-visible { outline:none; box-shadow:0 0 0 4px var(--ring); }

  .perms { border-top:1px solid var(--line); background:color-mix(in srgb, var(--bg) 55%, var(--card)); padding:22px 32px 24px; }
  .perms h2 { font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:var(--subtle); margin:0 0 4px; font-weight:650; }
  .perms .note { margin:0 0 12px; font-size:13px; color:var(--muted); }
  .perms ul { list-style:none; margin:0; padding:0; display:grid; gap:8px; }
  .perms li { display:flex; align-items:center; gap:10px; font-size:14px; }
  .perms li .ic { width:20px; height:20px; border-radius:50%; flex:none; padding:3px; }
  .perms li.yes .ic { background:var(--ok-soft); color:var(--ok); }
  .perms li.no { margin-top:4px; padding-top:10px; border-top:1px dashed var(--line); }
  .perms li.no .ic { background:var(--no-soft); color:var(--no); }

  .foot { max-width:420px; width:100%; margin-top:18px; display:flex; gap:8px; align-items:flex-start; color:var(--subtle); font-size:12.5px; line-height:1.55; padding:0 4px; }
  .foot .lock { width:15px; height:15px; flex:none; margin-top:2px; }
  .foot p { margin:0; }

  @media (max-width:440px) {
    body { padding:20px 12px; justify-content:flex-start; }
    .card-body { padding:26px 22px 22px; }
    .perms { padding:20px 22px; }
  }
</style>
</head>
<body>
<main class="card">
  <div class="card-body">
    <div class="connect" aria-hidden="true">
      <div class="app client">${clientInitial}</div>
      <div class="bridge"><i></i><i></i><span class="arrow">${icon.link}</span><i></i><i></i></div>
      <div class="app journl">${icon.ledger}</div>
    </div>

    <div class="head">
      <h1>Connect ${client} to JournL</h1>
      <p class="lead">Sign in to give <strong>${client}</strong> access to your company books.</p>
      <div class="pill"><span>${icon.lock}</span>Read-only access</div>
      ${returnHost ? `<p class="dest">After you sign in, you'll return to <strong>${returnHost}</strong></p>` : ""}
    </div>

    ${error ? `<div class="alert" role="alert"><span>${icon.alert}</span><div>${escapeHtml(error)}</div></div>` : ""}

    <form method="post" action="/login">
      <input type="hidden" name="pending" value="${escapeHtml(pendingId)}">
      <div class="field">
        <label for="email">Work email</label>
        <input id="email" name="email" type="email" autocomplete="username" placeholder="you@company.com" required autofocus value="${escapeHtml(email)}">
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" placeholder="Enter your JournL password" required>
      </div>
      <button type="submit">Sign in and allow access</button>
    </form>
  </div>

  <section class="perms" aria-labelledby="perms-title">
    <h2 id="perms-title">${client} will be able to view</h2>
    <p class="note">For your company only, and only where your JournL role allows.</p>
    <ul>
      ${canRead.map((item) => `<li class="yes"><span class="ic">${icon.check}</span>${item}</li>`).join("\n      ")}
      <li class="no"><span class="ic">${icon.cross}</span>Cannot create, change or delete anything</li>
    </ul>
  </section>
</main>

<div class="foot">
  <span class="lock">${icon.lock}</span>
  <p>
    Your password is sent only to JournL and is never stored. You can disconnect at any time from ${client}'s settings.
    ${privacyPolicyUrl ? `<a href="${escapeHtml(privacyPolicyUrl)}" target="_blank" rel="noopener">Privacy policy</a>` : ""}
  </p>
</div>
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
  .ic { width:44px; height:44px; border-radius:50%; padding:10px; margin:0 auto 16px; background:var(--err-bg); color:var(--err); }
  .card-body { text-align:center; }
  .brand { justify-content:center; }
</style>
</head>
<body>
<main class="card">
  <div class="card-body">
    <div class="brand"><span class="mark">${icon.ledger}</span><span class="wordmark">JournL</span></div>
    <div class="ic">${icon.alert}</div>
    <h1>Sign-in link expired</h1>
    <p class="lead">${escapeHtml(message)}</p>
  </div>
</main>
</body>
</html>`;
}
