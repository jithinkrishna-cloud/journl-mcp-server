// Verifies the running MCP server against a REAL JournL test account, the same way
// ChatGPT does: dynamic client registration → sign-in page → PKCE token → MCP tools.
//
// Read-only: only JournL's password login (POST /auth/login) and report GETs are called.
// Prints outcomes and response field names only, never amounts or names, so the output
// is safe to share. Use a TEST account on the TEST API, never production.
//
//   VERIFY_EMAIL=... VERIFY_PASSWORD=... npm run verify
// Optional: VERIFY_START=2025-04-01 VERIFY_END=2026-03-31 (period with data)
//           VERIFY_BASE=http://localhost:3100 (where to send requests; defaults to PUBLIC_URL)

import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const email = process.env.VERIFY_EMAIL;
const password = process.env.VERIFY_PASSWORD;
if (!email || !password) {
  console.error("Set VERIFY_EMAIL and VERIFY_PASSWORD (a JournL TEST account).");
  process.exit(2);
}

const publicUrl = (process.env.PUBLIC_URL ?? "http://localhost:3100").replace(/\/+$/, "");
const base = (process.env.VERIFY_BASE ?? publicUrl).replace(/\/+$/, "");
const resource = `${publicUrl}/mcp`;
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const headers = { "ngrok-skip-browser-warning": "1" };
const today = new Date();
const fyStartYear = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
const startDate = process.env.VERIFY_START ?? `${fyStartYear}-04-01`;
const endDate = process.env.VERIFY_END ?? today.toISOString().slice(0, 10);

/** How many object levels of field names to print (VERIFY_DEPTH, default 2). */
const SHAPE_DEPTH = Number(process.env.VERIFY_DEPTH ?? 2);

const step = (ok, label, detail = "") => console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);

/** Field names (with list lengths), never values. */
function shape(value, depth = 0) {
  if (Array.isArray(value)) return value.length ? `[${value.length}× ${shape(value[0], depth)}]` : "[]";
  if (value && typeof value === "object") {
    if (depth >= SHAPE_DEPTH) return "{…}";
    return `{${Object.entries(value).map(([k, v]) => `${k}:${shape(v, depth + 1)}`).join(", ")}}`;
  }
  return value === null ? "null" : typeof value;
}

async function signIn() {
  const reg = await fetch(`${base}/register`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ client_name: "JournL verify script", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] }),
  });
  if (reg.status !== 201) throw new Error(`client registration returned HTTP ${reg.status}`);
  const clientId = (await reg.json()).client_id;
  step(true, "dynamic client registration");

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL(`${base}/authorize`);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "verify", resource })) {
    authorize.searchParams.set(k, v);
  }
  const page = await (await fetch(authorize, { headers })).text();
  const pending = page.match(/name="pending" value="([^"]+)"/)?.[1];
  if (!pending) throw new Error("sign-in page did not load (check PUBLIC_URL matches the server's PUBLIC_URL)");
  step(true, "sign-in page");

  const login = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ pending, email, password }),
  });
  if (login.status !== 302) {
    const message = (await login.text()).match(/role="alert">([^<]+)/)?.[1] ?? `HTTP ${login.status}`;
    throw new Error(`JournL sign-in failed: ${message}`);
  }
  const code = new URL(login.headers.get("location")).searchParams.get("code");
  step(true, "JournL password login (POST /auth/login)");

  const token = await fetch(`${base}/token`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT, resource }),
  });
  if (token.status !== 200) throw new Error(`token exchange returned HTTP ${token.status}`);
  const { access_token: accessToken, expires_in: expiresIn } = await token.json();
  step(true, "PKCE token exchange", `expires in ${Math.round(expiresIn / 60)} min`);
  return accessToken;
}

async function main() {
  console.log(`Server: ${base}   Resource: ${resource}   Period: ${startDate} → ${endDate}\n`);
  const accessToken = await signIn();

  const client = new Client({ name: "journl-verify", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { ...headers, Authorization: `Bearer ${accessToken}` } } }));
  const { tools } = await client.listTools();
  step(tools.length >= 11, "MCP tools/list", `${tools.length} tools`);

  const outputs = [];
  let failures = 0;
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    outputs.push(JSON.stringify(r));
    const sc = r.structuredContent;
    const detail = r.isError ? r.content?.[0]?.text : shape(sc?.result ?? sc);
    // A permission refusal is a correct outcome for a restricted role; anything else is a failure.
    const refused = r.isError && /permission|only available/i.test(detail);
    if (r.isError && !refused) failures += 1;
    console.log(`${r.isError ? (refused ? "DENY" : "FAIL") : "PASS"}  ${name}  — ${detail}`);
    return r.isError ? undefined : sc;
  };

  console.log("");
  const profile = await call("get_profile", {});
  if (profile) console.log(`      role: ${profile.id.split(":")[0]}`);
  const period = { startDate, endDate };

  await call("search_ledgers", {});

  // Ledger statement with real rows: try bank, then cash ledgers until one has transactions.
  let found = false;
  for (const scope of ["bank", "cash"]) {
    const list = await call("search_ledgers", { scope });
    for (const ledger of (list?.result?.ledgers ?? []).slice(0, 10)) {
      const r = await client.callTool({ name: "get_ledger_statement", arguments: { ledgerId: ledger.ledgerId, ...period, maxRows: 5 } });
      outputs.push(JSON.stringify(r));
      if (r.isError) {
        failures += 1;
        console.log(`FAIL  get_ledger_statement (${scope} ledger ${ledger.ledgerId})  — ${r.content?.[0]?.text}`);
        continue;
      }
      const tx = r.structuredContent.result.transactions;
      if (tx.length) {
        const total = r.structuredContent.truncated?.[0]?.total ?? tx.length;
        console.log(`PASS  get_ledger_statement  — ${scope} ledger ${ledger.ledgerId}: ${total} transaction(s); row ${shape(tx[0])}`);
        found = true;
        break;
      }
    }
    if (found) break;
  }
  if (!found) console.log("INFO  get_ledger_statement  — no bank/cash ledger has transactions in this period");

  const groups = await call("list_ledger_groups", { maxRows: 50 });
  const groupId = groups?.result?.groups?.[0]?.groupId;
  if (groupId) await call("get_group_summary", { groupId, ...period });
  else console.log("SKIP  get_group_summary  — no group found");

  await call("get_ageing_report", { type: "receivable", endDate, maxRows: 5 });
  await call("get_ageing_report", { type: "payable", endDate, maxRows: 5 });
  await call("get_cash_flow", period);
  await call("get_gst_r1_report", { ...period, limit: 5 });
  await call("get_gst_r2b_report", { ...period, limit: 5 });
  const stock = await call("get_closing_stock", { ...period, maxRows: 5 });
  const stockId = stock?.result?.items?.[0]?.stockId;
  if (stockId) await call("get_stock_item_statement", { stockId, ...period, maxRows: 5 });
  else console.log("SKIP  get_stock_item_statement  — no stock item found");
  await call("get_business_summary", period);

  await call("get_profit_and_loss", period);
  await call("get_balance_sheet", period);
  await call("get_trial_balance", period);
  const vouchers = await call("search_vouchers", { ...period, limit: 3 });
  const voucherId = vouchers?.result?.vouchers?.[0]?.voucherId;
  if (voucherId) await call("get_voucher", { voucherId });
  else console.log("SKIP  get_voucher  — no voucher found");
  await call("get_top_customers", { ...period, maxRows: 5 });
  await call("get_customer_insights", { type: "inactive", maxRows: 5 });
  await call("get_customer_insights", { type: "payment_behaviour", maxRows: 5 });

  console.log("");
  const all = outputs.join("\n");
  const leaked = [accessToken, password].filter((s) => all.includes(s)).length + (/eyJ[\w-]+\.eyJ[\w-]+\./.test(all) ? 1 : 0);
  step(leaked === 0, "no access token, password or JWT in any tool response");

  const bad = await client.callTool({ name: "get_cash_flow", arguments: { startDate: "2025-13-45", endDate } });
  step(bad.isError === true, "invalid date rejected");

  await client.close();
  console.log(failures || leaked ? `\n${failures + leaked} problem(s) found.` : "\nAll checks passed.");
  process.exit(failures || leaked ? 1 : 0);
}

main().catch((err) => {
  step(false, err.message);
  process.exit(1);
});
