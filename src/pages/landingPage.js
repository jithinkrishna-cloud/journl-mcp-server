// Public landing page at GET /: what the JournL ChatGPT connector does and how to connect it.
// Inline styles only; the one image is the server's own icon.

import { config } from "../config/index.js";

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const READ_FEATURES = [
  ["Profit &amp; loss and balance sheet", "Ask for any period and get the totals in plain language."],
  ["Ledger statements", "Opening balance, every entry and the closing balance for a customer, supplier or bank."],
  ["Outstanding and ageing", "Who owes you, whom you owe, and for how long."],
  ["Stock", "Closing stock and item-wise movement."],
  ["Vouchers", "Find an invoice, receipt or payment and see its details."],
  ["Cash flow and trial balance", "Where the money came from and went, and every ledger's balance."],
  ["Top customers", "Your biggest customers and how their buying has changed."],
];

const WRITE_FEATURES = [
  ["Create sales invoices", "Bill a customer for stock items; GST is worked out from the item and the customer's state."],
  ["Create purchase invoices", "Record a supplier bill with its bill number; ChatGPT saves only after you say yes."],
];

const WRITE_EXAMPLES = [
  "Create a sales invoice for Acme Traders: 2 Widget at 500, dated today. Show me the preview first.",
  "Create a purchase invoice from Steel Suppliers, bill no PB-101: 10 Bolt at 20, dated today.",
];

// Shown only when the write tools are enabled.
const createSection = () => `
  <section>
    <h2>Create invoices</h2>
    <ol class="steps">
      <li>Ask ChatGPT to create a sales or purchase invoice: the party, the items with quantity and rate, and the date.</li>
      <li>ChatGPT shows a <strong>preview</strong>: invoice number, lines, GST (CGST + SGST or IGST) and the total. Nothing is saved yet.</li>
      <li>Reply <strong>"Yes, create it"</strong> to save it in JournL, or tell ChatGPT what to change.</li>
    </ol>
    <p class="hint">The party and items must already exist in JournL. Saved invoices cannot be edited or deleted from ChatGPT; do that in JournL.</p>
  </section>`;

const EXAMPLES = [
  "What was my profit last month?",
  "Show the ledger statement of Acme Traders for this financial year.",
  "Which customers have been outstanding for more than 90 days?",
  "What is the closing stock of each item today?",
];

const featureList = (items) =>
  items.map(([title, body]) => `<li><strong>${title}</strong><span>${body}</span></li>`).join("\n        ");

export function landingPage() {
  const mcpUrl = escapeHtml(config.mcpResourceUrl.href);
  const features = config.enableWriteTools ? [...READ_FEATURES, ...WRITE_FEATURES] : READ_FEATURES;
  const examples = config.enableWriteTools ? [...EXAMPLES, ...WRITE_EXAMPLES] : EXAMPLES;
  const accessLine = config.enableWriteTools
    ? "Read your reports, and create sales and purchase invoices after you confirm each one. Nothing is ever edited or deleted."
    : "Read-only: ChatGPT can read your reports but cannot create, change or delete anything.";
  const privacy = config.privacyPolicyUrl
    ? `<a href="${escapeHtml(config.privacyPolicyUrl)}" target="_blank" rel="noopener">Privacy policy</a>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>JournL for ChatGPT</title>
<meta name="description" content="Connect ChatGPT to your JournL books and ask about your accounts in plain language.">
<link rel="icon" href="/icon.png">
<style>
  :root {
    color-scheme: light dark;
    --bg:#ffffff; --surface:#f6f7f9; --text:#111827; --muted:#5b6472; --line:#e3e6ea;
    --accent:#111827; --accent-text:#ffffff; --code:#eef0f3;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#0d1117; --surface:#151b23; --text:#e6e8eb; --muted:#9aa4af; --line:#262d36;
      --accent:#e6e8eb; --accent-text:#0d1117; --code:#1c232c;
    }
  }
  * { box-sizing:border-box; }
  body {
    margin:0; background:var(--bg); color:var(--text);
    font:17px/1.65 "Tiempos Text", "Source Serif 4", "Source Serif Pro", ui-serif, Georgia, Cambria, "Times New Roman", serif;
    -webkit-font-smoothing:antialiased;
  }
  .wrap { max-width:900px; margin:0 auto; padding:0 16px; }
  header.top { display:flex; align-items:center; gap:10px; padding:20px 0; font-weight:600; }
  header.top img { width:28px; height:28px; border-radius:7px; }
  .hero { padding:48px 0 40px; }
  .hero h1 { font-size:clamp(32px, 6vw, 48px); line-height:1.15; letter-spacing:-.015em; margin:0 0 16px; font-weight:500; }
  h1, h2 { font-family:"Copernicus", "Tiempos Headline", "Source Serif 4", ui-serif, Georgia, serif; }
  .pill, .hint, header.top, footer { font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif; }
  .hero p { font-size:18px; color:var(--muted); margin:0 0 12px; max-width:600px; }
  .pill { display:inline-block; font-size:13px; padding:4px 10px; border:1px solid var(--line); border-radius:999px; color:var(--muted); margin-bottom:20px; }
  section { padding:32px 0; border-top:1px solid var(--line); }
  h2 { font-size:24px; margin:0 0 16px; font-weight:500; }
  ol.steps { margin:0; padding-left:20px; }
  ol.steps li { margin-bottom:10px; }
  .url { display:block; margin:8px 0 4px; padding:10px 12px; background:var(--code); border-radius:8px;
         font:14px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap:anywhere; user-select:all; }
  .hint { font-size:13px; color:var(--muted); }
  code { font:14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background:var(--code); padding:1px 5px; border-radius:4px; }
  code.url { padding:10px 12px; border-radius:8px; }
  ol.stepcards { list-style:none; margin:0 0 16px; padding:0; display:grid; gap:16px; }
  .stepcard { display:grid; grid-template-columns:36px 1fr; gap:12px 16px; padding:20px; background:var(--surface); border:1px solid var(--line); border-radius:12px; }
  .stepcard > img { grid-column:2; display:block; width:100%; max-width:340px; height:auto; border-radius:10px; border:1px solid var(--line); background:#000; }
  @media (min-width:720px) {
    .stepcard { grid-template-columns:36px 1fr 280px; align-items:start; }
    .stepcard > img { grid-column:3; grid-row:1; }
  }
  .stepnum { width:32px; height:32px; border-radius:50%; background:var(--accent); color:var(--accent-text);
             display:flex; align-items:center; justify-content:center; font-weight:600; font-size:15px;
             font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; }
  .steptext h3 { margin:2px 0 8px; font-size:19px; font-weight:500; }
  .steptext p { margin:0 0 8px; }
  dl.fields { margin:0 0 12px; display:grid; grid-template-columns:max-content 1fr; gap:8px 12px; }
  dl.fields dt { font-weight:600; }
  dl.fields dd { margin:0; min-width:0; }
  dl.fields code.url { font-size:13px; margin-top:6px; }
  @media (max-width:480px) { dl.fields { grid-template-columns:1fr; gap:2px; } dl.fields dd { margin-bottom:8px; } }
  ul.features { list-style:none; margin:0; padding:0; display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:12px; }
  ul.features li { background:var(--surface); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  ul.features strong { display:block; margin-bottom:4px; }
  ul.features span { color:var(--muted); font-size:14px; }
  ul.examples { margin:0; padding:0; list-style:none; }
  ul.examples li { padding:10px 14px; margin-bottom:8px; border-left:3px solid var(--line); background:var(--surface); border-radius:0 8px 8px 0; }
  .safety p { margin:0 0 10px; color:var(--muted); }
  footer { padding:28px 0 40px; border-top:1px solid var(--line); font-size:13px; color:var(--muted); display:flex; gap:16px; flex-wrap:wrap; }
  a { color:inherit; }
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <img src="/icon.png" alt="" width="28" height="28">
    <span>JournL</span>
  </header>

  <div class="hero">
    <span class="pill">ChatGPT connector</span>
    <h1>${config.enableWriteTools ? "Ask ChatGPT about your books, and create invoices." : "Ask ChatGPT about your books."}</h1>
    <p>Connect your JournL company to ChatGPT and get answers about profit, balances, outstanding and stock in plain language.</p>
    <p>${accessLine}</p>
  </div>

  <section>
    <h2>Connect in ChatGPT</h2>
    <ol class="stepcards">
      <li class="stepcard">
        <div class="stepnum">1</div>
        <div class="steptext">
          <h3>Open Plugins</h3>
          <p>In ChatGPT's left sidebar, click <strong>Plugins</strong>.</p>
        </div>
        <img src="/steps/1-plugins.png" width="337" height="231" loading="lazy"
             alt="ChatGPT sidebar with New chat, Images, Scheduled, Library, Plugins (highlighted) and Explore">
      </li>
      <li class="stepcard">
        <div class="stepnum">2</div>
        <div class="steptext">
          <h3>Add a custom MCP server</h3>
          <p>Click <strong>Add</strong> at the top right, then <strong>Add custom MCP server</strong>.</p>
        </div>
        <img src="/steps/2-add-menu.png" width="290" height="264" loading="lazy"
             alt="The Add menu open, showing Create plugin, Upload plugin archive and Add custom MCP server">
      </li>
      <li class="stepcard">
        <div class="stepnum">3</div>
        <div class="steptext">
          <h3>Fill in the form</h3>
          <dl class="fields">
            <dt>Icon</dt><dd>Optional. <a href="/icon.png" download="journl-icon.png">Download the JournL icon</a> and upload it.</dd>
            <dt>Name</dt><dd><code>JournL</code></dd>
            <dt>Description</dt><dd><code>${config.enableWriteTools ? "Reports and invoices from my JournL books" : "Reports from my JournL books"}</code></dd>
            <dt>Connection</dt><dd>Keep <strong>Server URL</strong> selected and paste:<code class="url">${mcpUrl}</code></dd>
            <dt>Authentication</dt><dd><strong>OAuth</strong>. Leave Advanced OAuth settings as they are.</dd>
          </dl>
          <p>Tick <strong>I understand and want to continue</strong>, then click <strong>Create as a plugin</strong>.</p>
        </div>
        <img src="/steps/3-add-server.png" width="598" height="757" loading="lazy"
             alt="The Add custom MCP server dialog with Icon, Name, Description, Connection (Server URL), Authentication (OAuth) and the Create as a plugin button">
      </li>
      <li class="stepcard">
        <div class="stepnum">4</div>
        <div class="steptext">
          <h3>Sign in and ask</h3>
          <p>Sign in with your JournL email and password when asked. Then, in a new chat, pick <strong>JournL</strong> from the tools menu and ask a question.</p>
        </div>
      </li>
    </ol>
    <p class="hint">Opening the server URL in a browser does nothing; it only answers ChatGPT.</p>
  </section>

  <section>
    <h2>What you can ask</h2>
    <ul class="features">
        ${featureList(features)}
    </ul>
  </section>

  <section>
    <h2>Try asking</h2>
    <ul class="examples">
      ${examples.map((q) => `<li>${escapeHtml(q)}</li>`).join("\n      ")}
    </ul>
  </section>
${config.enableWriteTools ? createSection() : ""}

  <section class="safety">
    <h2>Your data</h2>
    <p>ChatGPT sees only the company you sign in to, with the same permissions as your JournL user.</p>
    <p>Your password goes only to JournL and is never stored here. Disconnect the connector in ChatGPT at any time to revoke access.</p>
  </section>

  <footer>
    <span>JournL</span>
    ${privacy}
  </footer>
</div>
</body>
</html>`;
}
