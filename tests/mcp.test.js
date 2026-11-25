// End-to-end tests: real OAuth sign-in (DCR + PKCE) and a real MCP client against the
// Express app, with a mock JournL API. Run with `npm test`.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startMockJournl, USERS } from "./mockJournl.js";

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

let journl, mcpServer, base;
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const LEGACY_CLIENT_ID = "legacy-evil-client"; // saved before the redirect allowlist existed

before(async () => {
  journl = await startMockJournl();
  const port = await freePort();
  base = `http://localhost:${port}`;
  const clientsFile = join(mkdtempSync(join(tmpdir(), "journl-mcp-")), "clients.json");
  writeFileSync(clientsFile, JSON.stringify({
    [LEGACY_CLIENT_ID]: { client_id: LEGACY_CLIENT_ID, client_name: "ChatGPT", redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none" },
  }));
  // Config is read at import time, so set the environment first.
  Object.assign(process.env, {
    PORT: String(port),
    PUBLIC_URL: base,
    JOURNL_API_BASE_URL: journl.url,
    JOURNL_TIMEOUT_MS: "5000",
    CLIENTS_FILE: clientsFile,
  });
  console.log = () => {}; // keep test output readable (structured logs are covered separately)
  const { start } = await import("../src/server.js");
  mcpServer = start(port);
  await new Promise((r) => mcpServer.once("listening", r));
});

after(() => {
  mcpServer?.close();
  journl?.server.close();
});

// --- OAuth helpers -------------------------------------------------------------

async function registerClient() {
  const res = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] }),
  });
  assert.equal(res.status, 201);
  return (await res.json()).client_id;
}

/** Runs authorize → login form; returns the login response. */
async function submitLogin(clientId, email, password) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL(`${base}/authorize`);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "st", resource: `${base}/mcp` })) {
    authorize.searchParams.set(k, v);
  }
  const page = await (await fetch(authorize)).text();
  const pending = page.match(/name="pending" value="([^"]+)"/)?.[1];
  assert.ok(pending, "login page should carry a pending id");
  const res = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ pending, email, password }),
  });
  return { res, verifier };
}

async function signIn(user) {
  const clientId = await registerClient();
  const { res, verifier } = await submitLogin(clientId, user.email, user.password);
  assert.equal(res.status, 302, "successful login redirects back to ChatGPT");
  const location = new URL(res.headers.get("location"));
  assert.equal(location.origin + location.pathname, REDIRECT);
  assert.equal(location.searchParams.get("state"), "st");

  const tokenRes = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: location.searchParams.get("code"), code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT, resource: `${base}/mcp` }),
  });
  assert.equal(tokenRes.status, 200);
  const tokens = await tokenRes.json();
  assert.equal(tokens.refresh_token, undefined);
  return tokens.access_token;
}

async function mcpClient(accessToken) {
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
  return client;
}

const journlJwts = () => [...journl.state.tokens.keys()];
const lastJournlRequest = () => journl.state.requests.at(-1);
const period = { startDate: "2025-04-01", endDate: "2025-04-30" };

// --- tests ---------------------------------------------------------------------

describe("authentication", () => {
  test("MCP endpoint rejects requests without a token and points to OAuth metadata", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate"), /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp"/);
  });

  test("discovery metadata advertises PKCE S256 and the MCP resource", async () => {
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
    const pr = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
    assert.equal(pr.resource, `${base}/mcp`);
  });

  test("wrong password is rejected without issuing a code", async () => {
    const { res } = await submitLogin(await registerClient(), USERS.owner.email, "wrong");
    assert.equal(res.status, 401);
    assert.match(await res.text(), /Invalid password/);
  });

  test("inactive (blocked) user cannot sign in, so cannot reach accounting data", async () => {
    const { res } = await submitLogin(await registerClient(), USERS.blocked.email, USERS.blocked.password);
    assert.equal(res.status, 401);
    assert.match(await res.text(), /blocked/);
  });

  test("a double-submitted login form gets the same redirect, and its code still works", async () => {
    const clientId = await registerClient();
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorize = new URL(`${base}/authorize`);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "st", resource: `${base}/mcp` })) {
      authorize.searchParams.set(k, v);
    }
    const pending = (await (await fetch(authorize)).text()).match(/name="pending" value="([^"]+)"/)[1];
    const submit = () =>
      fetch(`${base}/login`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ pending, email: USERS.owner.email, password: USERS.owner.password }),
      });
    const loginsBefore = journl.state.logins;
    const [a, b] = await Promise.all([submit(), submit()]); // overlapping submits
    const c = await submit(); // a late resubmit after success
    assert.deepEqual([a.status, b.status, c.status], [302, 302, 302]);
    assert.equal(a.headers.get("location"), b.headers.get("location"));
    assert.equal(a.headers.get("location"), c.headers.get("location"));
    assert.equal(journl.state.logins - loginsBefore, 1, "JournL login runs once for duplicate submits");

    const code = new URL(a.headers.get("location")).searchParams.get("code");
    const tokenRes = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT, resource: `${base}/mcp` }),
    });
    assert.equal(tokenRes.status, 200);
  });

  test("multi-account email is refused instead of using passwordless login", async () => {
    const { res } = await submitLogin(await registerClient(), USERS.multi.email, USERS.multi.password);
    assert.equal(res.status, 401);
    assert.ok(!journl.state.requests.some((r) => r.path.startsWith("/auth/login-")), "passwordless routes are never called");
  });
});

describe("OAuth redirect allowlist", () => {
  const register = (body) =>
    fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"], ...body }),
    });
  const authorizeUrl = (params) => {
    const url = new URL(`${base}/authorize`);
    const all = { response_type: "code", code_challenge: "x".repeat(43), code_challenge_method: "S256", state: "st", ...params };
    for (const [k, v] of Object.entries(all)) url.searchParams.set(k, v);
    return url;
  };

  test("registration refuses redirect URIs that are not ChatGPT callbacks", async () => {
    for (const uri of [
      "https://evil.example/cb",
      "https://chatgpt.com.evil.example/connector_platform_oauth_redirect",
      "https://chatgpt.com/somewhere-else",
      "https://chatgpt.com/connector/oauth/abc/../../evil",
      "https://chatgpt.com:8443/connector_platform_oauth_redirect",
      "http://chatgpt.com/connector_platform_oauth_redirect",
      "https://chatgpt.com/connector_platform_oauth_redirect?next=https://evil.example",
      "https://user@chatgpt.com/connector_platform_oauth_redirect",
    ]) {
      const res = await register({ client_name: "ChatGPT", redirect_uris: [uri] });
      assert.equal(res.status, 400, uri);
      assert.equal((await res.json()).error, "invalid_client_metadata", uri);
    }
    // One bad URI among good ones is still refused.
    const mixed = await register({ client_name: "ChatGPT", redirect_uris: [REDIRECT, "https://evil.example/cb"] });
    assert.equal(mixed.status, 400);
  });

  test("registration accepts both documented ChatGPT callback forms", async () => {
    const res = await register({ client_name: "ChatGPT", redirect_uris: [REDIRECT, "https://chatgpt.com/connector/oauth/AbC_123-x"] });
    assert.equal(res.status, 201);
  });

  test("a client saved before the allowlist cannot start sign-in, and nothing redirects to it", async () => {
    const res = await fetch(authorizeUrl({ client_id: LEGACY_CLIENT_ID, redirect_uri: "https://evil.example/cb" }), { redirect: "manual" });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("location"), null);
  });

  test("sign-in page ignores the client's self-declared name and shows the real destination", async () => {
    const { client_id } = await (await register({ client_name: "Your Bank <b>Security</b>", redirect_uris: [REDIRECT] })).json();
    const page = await (await fetch(authorizeUrl({ client_id, redirect_uri: REDIRECT, resource: `${base}/mcp` }))).text();
    assert.ok(!page.includes("Your Bank"), "client_name is not shown");
    assert.match(page, /Connect ChatGPT to JournL/);
    assert.match(page, /return to <strong>chatgpt\.com<\/strong>/);
  });
});

describe("tools through an MCP client", () => {
  let owner, staff, ownerToken;

  before(async () => {
    ownerToken = await signIn(USERS.owner);
    owner = await mcpClient(ownerToken);
    staff = await mcpClient(await signIn(USERS.staff));
  });

  test("lists all read-only tools with explicit annotations", async () => {
    const { tools } = await owner.listTools();
    assert.equal(tools.length, 19);
    for (const t of tools) {
      assert.equal(t.annotations.readOnlyHint, true, t.name);
      assert.equal(t.annotations.destructiveHint, false, t.name);
      assert.equal(t.annotations.openWorldHint, false, t.name);
      assert.ok(t.description.length > 20, t.name);
      assert.ok(t.outputSchema, `${t.name} declares an output schema`);
      assert.ok(!("companyId" in (t.inputSchema.properties ?? {})), `${t.name} must not accept a company ID`);
    }
    assert.equal(tools.find((t) => t.name === "get_profile")._meta["openai/profile"], true);
    // ChatGPT refused the whole tool list when a schema pattern used a Unicode property class.
    assert.ok(!/\\\\p\{/.test(JSON.stringify(tools)), "no \\p{…} classes in advertised JSON Schema patterns");
  });

  test("authenticated user retrieves authorised company data, projected without internal fields", async () => {
    const r = await owner.callTool({ name: "get_ledger_statement", arguments: { ledgerId: 5, ...period } });
    assert.equal(r.isError, undefined);
    assert.equal(r.structuredContent.company, "Demo Co");
    assert.deepEqual(r.structuredContent.result.openingBalance, { amount: 5000, side: "Cr" });
    const row = r.structuredContent.result.transactions[0];
    assert.deepEqual(Object.keys(row).sort(), ["credit", "date", "debit", "description", "ledger", "party", "voucherNumber", "voucherType"]);
  });

  test("ledger amounts follow JournL's sign convention: negative = Debit, positive = Credit", async () => {
    journl.state.statementOverride = { openingBalance: -2500, netTotal: -150, filteredTotal: -150, result: [
      { voucherDate: "2026-07-11", voucherTypeName: "Receipt", voucherNumber: "5", totalAmount: -200, balance: -2700 },
      { voucherDate: "2026-07-12", voucherTypeName: "Payment", voucherNumber: "6", totalAmount: 50, balance: -2650 },
    ] };
    const r = await owner.callTool({ name: "get_ledger_statement", arguments: { ledgerId: 46, ...period } });
    const res = r.structuredContent.result;
    assert.deepEqual(res.openingBalance, { amount: 2500, side: "Dr" });
    assert.deepEqual(res.netMovement, { amount: 150, side: "Dr" });
    assert.equal(res.filteredMovement, undefined);
    assert.deepEqual([res.transactions[0].debit, res.transactions[0].credit], [200, 0]);
    assert.deepEqual([res.transactions[1].debit, res.transactions[1].credit], [0, 50]);
    assert.deepEqual(res.transactions[0].balance, { amount: 2700, side: "Dr" });
    assert.deepEqual(res.totals, { debit: 200, credit: 50, transactions: 2 });
  });

  test("ledger totals cover every row even when the list is capped", async () => {
    const r = await owner.callTool({ name: "get_ledger_statement", arguments: { ledgerId: 5, ...period, maxRows: 1 } });
    assert.equal(r.structuredContent.result.transactions.length, 1);
    assert.deepEqual(r.structuredContent.result.totals, { debit: 0, credit: 6000, transactions: 3 });
  });

  test("company always comes from the session, never from tool arguments", async () => {
    await owner.callTool({ name: "search_ledgers", arguments: { search: "HDFC", companyId: 202, dbName: 202 } });
    const req = lastJournlRequest();
    assert.equal(req.companyId, 101);
    assert.equal(req.query.companyId, undefined);
    assert.equal(req.query.dbName, undefined);
  });

  test("profile identifies the signed-in user", async () => {
    const r = await staff.callTool({ name: "get_profile", arguments: {} });
    const { id, ...rest } = r.structuredContent;
    assert.deepEqual(rest, { name: "Staff Two", email: USERS.staff.email, nickname: "Demo Co" });
    assert.match(id, /^[0-9a-f]{32}$/, "profile id is opaque");
    assert.ok(!/company_user|owner|:/.test(id), "profile id does not expose role or user number");
    const again = await staff.callTool({ name: "get_profile", arguments: {} });
    assert.equal(again.structuredContent.id, id, "profile id is stable");
  });

  test("company user without the feature permission is refused before JournL is called", async () => {
    const before = journl.state.requests.length;
    const r = await staff.callTool({ name: "get_closing_stock", arguments: period });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /permission/);
    assert.equal(journl.state.requests.length, before);
  });

  test("company user with the feature permission can use that tool", async () => {
    const r = await staff.callTool({ name: "get_ledger_statement", arguments: { ledgerId: 5, ...period } });
    assert.equal(r.isError, undefined);
  });

  test("JournL's own permission refusal is passed on safely", async () => {
    const r = await staff.callTool({ name: "get_ageing_report", arguments: { type: "receivable" } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /^JournL: You do not have permission/);
  });

  test("ageing returns exact per-party totals so the model does not add bills itself", async () => {
    const r = await owner.callTool({ name: "get_ageing_report", arguments: { type: "receivable" } });
    const { parties, totals } = r.structuredContent.result;
    assert.deepEqual(parties.map((p) => [p.party, p.ledgerId, p.bills, p.outstanding]), [["Beta", 30, 1, 250], ["Acme", 26, 2, 0.3]]);
    assert.equal(parties.find((p) => p.party === "Acme").days90plus, 0.3); // 0.1 + 0.2 without float drift
    assert.equal(totals.outstanding, 250.3);
  });

  test("profit and loss returns JournL totals and a tree without internal fields", async () => {
    const r = await owner.callTool({ name: "get_profit_and_loss", arguments: period });
    const res = r.structuredContent.result;
    assert.deepEqual(res.totals, { totalIncome: 1000, totalExpense: 400, netProfitLoss: 600 });
    assert.deepEqual(res.sections[0].groups[0].children[0], { name: "Sales", amount: 1000, ledgerId: 9 });
  });

  test("trial balance has server-side grand totals and a balanced check", async () => {
    const r = await owner.callTool({ name: "get_trial_balance", arguments: period });
    assert.deepEqual(r.structuredContent.result.totals.closing, { debit: 100.1, credit: 100.1 });
    assert.equal(r.structuredContent.result.totals.balanced, true);
  });

  test("owner-only reports are refused for company users before JournL is called", async () => {
    const before = journl.state.requests.length;
    for (const [name, args] of [["get_trial_balance", period], ["get_top_customers", {}], ["get_customer_insights", { type: "inactive" }], ["get_stock_item_statement", { stockId: 1, ...period }]]) {
      const r = await staff.callTool({ name, arguments: args });
      assert.equal(r.isError, true, name);
      assert.match(r.content[0].text, /only to the company owner/, name);
    }
    assert.equal(journl.state.requests.length, before);
  });

  test("customer report search rejects SQL metacharacters before JournL is called", async () => {
    const before = journl.state.requests.length;
    for (const search of ["x' OR '1'='1", "a%", "a\\", "a; DROP TABLE x", 'a"b']) {
      const r = await owner.callTool({ name: "get_top_customers", arguments: { search } });
      assert.equal(r.isError, true, search);
      const r2 = await owner.callTool({ name: "get_customer_insights", arguments: { type: "inactive", search } });
      assert.equal(r2.isError, true, search);
    }
    assert.equal(journl.state.requests.length, before);
  });

  test("vouchers need Day Book view for company users", async () => {
    const r = await staff.callTool({ name: "search_vouchers", arguments: {} });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /permission/);
  });

  test("voucher search and detail drop addresses, phones and emails", async () => {
    const list = await owner.callTool({ name: "search_vouchers", arguments: { ...period, voucherType: "Sales" } });
    assert.equal(list.isError, undefined, JSON.stringify(list.content));
    const v = list.structuredContent.result.vouchers[0];
    assert.deepEqual(v.particulars, [{ name: "Acme Traders", amount: 118, side: "Dr" }]);
    assert.equal(list.structuredContent.result.debitTotal, 118);
    const one = await owner.callTool({ name: "get_voucher", arguments: { voucherId: v.voucherId } });
    const d = one.structuredContent.result;
    assert.equal(d.party, "Acme Traders");
    assert.deepEqual(d.items[0], { item: "Widget", stockId: 4, quantity: 2, unit: "Nos", rate: 50, taxPercent: 18, tax: 18, amount: 118 });
    const text = JSON.stringify([list, one]);
    for (const secret of ["buyer@example.com", "9999999999", "12 Secret St"]) assert.ok(!text.includes(secret), secret);
  });

  test("invalid date filters are rejected", async () => {
    const bad = await owner.callTool({ name: "get_cash_flow", arguments: { startDate: "2025-13-45", endDate: "2025-04-30" } });
    assert.equal(bad.isError, true);
    const reversed = await owner.callTool({ name: "get_cash_flow", arguments: { startDate: "2025-05-01", endDate: "2025-04-01" } });
    assert.equal(reversed.isError, true);
    assert.match(reversed.content[0].text, /startDate must be on or before endDate/);
  });

  test("empty results are returned as empty lists, not errors", async () => {
    const r = await owner.callTool({ name: "search_ledgers", arguments: { search: "nothing-matches" } });
    assert.equal(r.isError, undefined);
    assert.deepEqual(r.structuredContent.result.ledgers, []);
  });

  test("long lists are capped and reported as truncated", async () => {
    const r = await owner.callTool({ name: "get_ledger_statement", arguments: { ledgerId: 5, ...period, maxRows: 2 } });
    assert.equal(r.structuredContent.result.transactions.length, 2);
    assert.deepEqual(r.structuredContent.truncated, [{ list: "transactions", returned: 2, total: 3 }]);
  });

  test("JournL API failures return a safe message", async () => {
    // Some JournL handlers put raw database errors in `message`; they must never reach ChatGPT.
    journl.state.failNext = { status: 500, body: { success: false, message: "ER_PARSE_ERROR: You have an error in your SQL syntax near 'x' at line 1" } };
    const r = await owner.callTool({ name: "get_cash_flow", arguments: period });
    assert.equal(r.isError, true);
    assert.equal(r.content[0].text, "JournL had a problem completing this request. Please try again.");
    assert.doesNotMatch(r.content[0].text, /SQL|ER_/);
  });

  test("no JournL JWT, access token or password appears in any tool response", async () => {
    const outputs = [];
    for (const [name, args] of [
      ["get_profile", {}],
      ["search_ledgers", { search: "HDFC" }],
      ["get_ledger_statement", { ledgerId: 5, ...period }],
      ["get_cash_flow", period],
      ["get_ageing_report", { type: "payable" }],
    ]) {
      outputs.push(JSON.stringify(await owner.callTool({ name, arguments: args })));
    }
    const all = outputs.join("\n");
    for (const secret of [...journlJwts(), ownerToken, USERS.owner.password, "$2b$hash-should-never-leak"]) {
      assert.ok(!all.includes(secret), "a secret leaked into a tool response");
    }
  });

  test("an expired JournL session ends the MCP token so ChatGPT re-authenticates", async () => {
    const token = await signIn(USERS.owner);
    const client = await mcpClient(token);
    journl.state.tokens.clear(); // JournL now rejects every JWT (as when it expires)
    const r = await client.callTool({ name: "search_ledgers", arguments: {} });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /reconnect/);
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 401);
  });
});
