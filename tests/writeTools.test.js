// Invoice write tools (ENABLE_WRITE_TOOLS=true), end to end through a real MCP client
// against the mock JournL API. Runs in its own process, so the flag does not affect
// mcp.test.js, which checks the default read-only server.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startMockJournl, USERS } from "./mockJournl.js";

const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
let journl, mcpServer, base, priceInvoice;

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

before(async () => {
  journl = await startMockJournl();
  const port = await freePort();
  base = `http://localhost:${port}`;
  Object.assign(process.env, {
    PORT: String(port),
    PUBLIC_URL: base,
    JOURNL_API_BASE_URL: journl.url,
    JOURNL_TIMEOUT_MS: "5000",
    CLIENT_ID_SECRET: "test-client-id-secret-0123456789abcdef",
    ENABLE_WRITE_TOOLS: "true",
  });
  console.log = () => {};
  const { start } = await import("../src/server.js");
  ({ priceInvoice } = await import("../src/tools/invoices/index.js"));
  mcpServer = start(port);
  await new Promise((r) => mcpServer.once("listening", r));
});

after(() => {
  mcpServer?.close();
  journl?.server.close();
});

async function signIn(user) {
  const reg = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] }),
  });
  const clientId = (await reg.json()).client_id;
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URL(`${base}/authorize`);
  for (const [k, v] of Object.entries({
    response_type: "code", client_id: clientId, redirect_uri: REDIRECT, state: "st", resource: `${base}/mcp`,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
  })) authorize.searchParams.set(k, v);
  const pending = (await (await fetch(authorize)).text()).match(/name="pending" value="([^"]+)"/)[1];
  const login = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ pending, email: user.email, password: user.password }),
  });
  const code = new URL(login.headers.get("location")).searchParams.get("code");
  const tokenRes = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT, resource: `${base}/mcp` }),
  });
  const client = new Client({ name: "test", version: "1" });
  const headers = { Authorization: `Bearer ${(await tokenRes.json()).access_token}` };
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
  return client;
}

const created = () => journl.state.vouchers;
const requestCount = () => journl.state.requests.length;
const total = (body) => Math.round((body.stockItems.reduce((s, i) => s + i.amount, 0) + body.taxSplit.reduce((s, t) => s + t.taxAmount, 0)) * 100) / 100;

// Widget 18% and Bolt 5%, for customer 30 in the company's own state (18).
const SALE = { partyLedgerId: 30, date: "2026-11-27", items: [{ stockId: 4, quantity: 2, rate: 50 }, { stockId: 7, quantity: 3, rate: 33.33 }] };

describe("invoice pricing", () => {
  const party = { name: "P", taxType: "registered", state: 18 };
  test("an odd-paisa GST splits into CGST and SGST halves that add up exactly", () => {
    const p = priceInvoice({ kind: "sales", party, companyStateId: 18, items: [{ stock: { taxPercentage: 18 }, quantity: 1, rate: 0.5 }] });
    assert.equal(p.taxPaise, 9);
    assert.deepEqual(p.taxSplit.map((t) => [t.taxName, t.taxPaise]), [["CGST 9%", 5], ["SGST 9%", 4]]);
  });

  test("other-state party gets one IGST line per rate", () => {
    const p = priceInvoice({
      kind: "sales", party: { ...party, state: 27 }, companyStateId: 18,
      items: [{ stock: { taxPercentage: 18 }, quantity: 1, rate: 10 }, { stock: { taxPercentage: 18 }, quantity: 2, rate: 10 }],
    });
    assert.deepEqual(p.taxSplit.map((t) => [t.taxName, t.taxPaise]), [["IGST 18%", 540]]);
    assert.equal(p.totalPaise, 3540);
  });
});

describe("landing page with write tools", () => {
  test("GET / explains how to create invoices", async () => {
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /Create invoices/);
    assert.match(html, /Create a sales invoice for/);
    assert.match(html, /Create purchase invoices/);
    assert.doesNotMatch(html, /Read-only/);
  });
});

describe("invoice write tools", () => {
  let owner, staff, clerk;

  before(async () => {
    [owner, staff, clerk] = await Promise.all([signIn(USERS.owner), signIn(USERS.staff), signIn(USERS.clerk)]);
  });

  test("the server tells ChatGPT it can create invoices, not that it is read-only", () => {
    const instructions = owner.getInstructions();
    assert.match(instructions, /create sales and purchase invoices/);
    assert.match(instructions, /confirm true only after the user agrees/);
    assert.doesNotMatch(instructions, /Read-only|cannot create/);
  });

  test("are listed as write tools that take no company ID", async () => {
    const { tools } = await owner.listTools();
    for (const name of ["create_sales_invoice", "create_purchase_invoice"]) {
      const t = tools.find((x) => x.name === name);
      assert.ok(t, `${name} is registered`);
      assert.equal(t.annotations.readOnlyHint, false);
      assert.equal(t.annotations.destructiveHint, false);
      assert.ok(!("companyId" in t.inputSchema.properties));
      assert.ok(!("createdBy" in t.inputSchema.properties));
    }
  });

  test("without confirm, a sales invoice is previewed and nothing is saved", async () => {
    const before = created().length;
    const r = await owner.callTool({ name: "create_sales_invoice", arguments: SALE });
    assert.equal(r.isError, undefined, r.content?.[0]?.text);
    assert.equal(created().length, before, "nothing posted to JournL");
    const inv = r.structuredContent.result;
    assert.equal(inv.saved, false);
    assert.equal(inv.invoiceNo, "INV/26");
    assert.equal(inv.placeOfSupply, "Within the state (CGST + SGST)");
    assert.deepEqual(inv.taxes, [
      { tax: "CGST 9%", amount: 9 },
      { tax: "SGST 9%", amount: 9 },
      { tax: "CGST 2.5%", amount: 2.5 },
      { tax: "SGST 2.5%", amount: 2.5 },
    ]);
    assert.deepEqual(inv.totals, { taxableValue: 199.99, tax: 23, total: 222.99 });
    assert.match(r.content[0].text, /Preview only, nothing saved/);
  });

  test("with confirm, the sales invoice JournL receives is balanced and signed by the session user", async () => {
    const r = await owner.callTool({ name: "create_sales_invoice", arguments: { ...SALE, confirm: true, narration: "Test sale" } });
    assert.equal(r.isError, undefined, r.content?.[0]?.text);
    assert.equal(r.structuredContent.result.saved, true);
    assert.equal(r.structuredContent.result.voucherId, 500 + created().length);

    const body = created().at(-1);
    assert.equal(body.primaryVoucherTypeId, "4");
    assert.equal(body.voucherTypeId, 4);
    assert.equal(body.voucherType, "Sales");
    assert.equal(body.invoiceNo, "INV/26");
    assert.equal(body.accountId, 30);
    assert.equal(body.createdBy, USERS.owner.id);
    assert.equal(body.description, "Test sale");
    assert.equal(body.amount, 199.99);
    assert.equal(body.taxAmount, 23);
    assert.equal(body.totalAmount, 222.99);
    assert.equal(total(body), body.totalAmount, "party total equals item lines plus GST lines");
    assert.ok(body.stockItems.every((i) => i.salesLedgerId === null && i.amount > 0), "JournL picks the ledgers; amounts are positive");
    assert.ok(body.taxSplit.every((t) => t.taxLedgerId === null));
  });

  test("a purchase from another state posts IGST and the supplier's bill number", async () => {
    const r = await owner.callTool({
      name: "create_purchase_invoice",
      arguments: { partyLedgerId: 40, date: "2026-11-27", refNo: "SB-778", items: [{ stockId: 4, quantity: 10, rate: 40 }], confirm: true },
    });
    assert.equal(r.isError, undefined, r.content?.[0]?.text);
    const body = created().at(-1);
    assert.equal(body.primaryVoucherTypeId, "6");
    assert.equal(body.voucherType, "Purchase");
    assert.equal(body.invoiceNo, "PUR/26");
    assert.equal(body.supplierBill_no, "SB-778");
    assert.equal(body.refNo, "SB-778");
    assert.deepEqual(body.taxSplit, [{ taxLedgerId: null, taxName: "IGST 18%", taxPer: 18, taxAmount: 72 }]);
    assert.equal(body.totalAmount, 472);
  });

  test("an unregistered supplier's bill cannot carry GST, but a GST-free bill is fine", async () => {
    const before = created().length;
    const taxed = await owner.callTool({ name: "create_purchase_invoice", arguments: { partyLedgerId: 41, date: "2026-11-27", items: [{ stockId: 4, quantity: 1, rate: 10 }], confirm: true } });
    assert.equal(taxed.isError, true);
    assert.match(taxed.content[0].text, /not registered for GST/);
    assert.equal(created().length, before);

    const free = await owner.callTool({ name: "create_purchase_invoice", arguments: { partyLedgerId: 41, date: "2026-11-27", items: [{ stockId: 8, quantity: 5, rate: 60 }], confirm: true } });
    assert.equal(free.isError, undefined, free.content?.[0]?.text);
    assert.equal(free.structuredContent.result.placeOfSupply, "No GST");
    assert.deepEqual(created().at(-1).taxSplit, []);
    assert.equal(created().at(-1).totalAmount, 300);
  });

  test("a party with an unknown GST type is refused", async () => {
    const r = await owner.callTool({ name: "create_sales_invoice", arguments: { ...SALE, partyLedgerId: 32, confirm: true } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /GST type of "Mystery Buyer" is not set/);
  });

  test("the party must be a customer for sales and a supplier for purchases", async () => {
    for (const [name, partyLedgerId] of [["create_sales_invoice", 40], ["create_sales_invoice", 5], ["create_purchase_invoice", 30]]) {
      const r = await owner.callTool({ name, arguments: { ...SALE, partyLedgerId } });
      assert.equal(r.isError, true, `${name} with ledger ${partyLedgerId}`);
      assert.match(r.content[0].text, /is not a (customer|supplier) ledger/);
    }
    const unknown = await owner.callTool({ name: "create_sales_invoice", arguments: { ...SALE, partyLedgerId: 999 } });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /not found/);
  });

  test("unknown or deleted stock items are refused", async () => {
    const r = await owner.callTool({ name: "create_sales_invoice", arguments: { ...SALE, items: [{ stockId: 4, quantity: 1, rate: 1 }, { stockId: 9, quantity: 1, rate: 1 }, { stockId: 77, quantity: 1, rate: 1 }] } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /Stock item 9, 77 was not found/);
  });

  test("a chosen voucher type must belong to the invoice kind", async () => {
    const ok = await owner.callTool({ name: "create_sales_invoice", arguments: { ...SALE, voucherTypeId: 104, confirm: true } });
    assert.equal(ok.isError, undefined, ok.content?.[0]?.text);
    assert.equal(created().at(-1).voucherTypeId, 104);
    assert.equal(created().at(-1).voucherType, "Sales B2B");
    const bad = await owner.callTool({ name: "create_sales_invoice", arguments: { ...SALE, voucherTypeId: 106 } });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /not a Sales voucher type/);
  });

  test("company users need the add right, checked before JournL is called", async () => {
    const before = requestCount();
    for (const name of ["create_sales_invoice", "create_purchase_invoice"]) {
      const r = await staff.callTool({ name, arguments: { ...SALE, confirm: true } });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /does not have permission to add/);
    }
    const purchase = await clerk.callTool({ name: "create_purchase_invoice", arguments: { ...SALE, partyLedgerId: 40, confirm: true } });
    assert.equal(purchase.isError, true);
    assert.equal(requestCount(), before, "refused before any JournL request");

    const sale = await clerk.callTool({ name: "create_sales_invoice", arguments: { ...SALE, confirm: true } });
    assert.equal(sale.isError, undefined, sale.content?.[0]?.text);
    assert.equal(created().at(-1).createdBy, USERS.clerk.id);
  });

  test("company, user and amounts cannot be supplied by the caller", async () => {
    await owner.callTool({ name: "create_sales_invoice", arguments: { ...SALE, confirm: true, companyId: 202, createdBy: 1, totalAmount: 1 } });
    const body = created().at(-1);
    assert.equal(body.createdBy, USERS.owner.id);
    assert.equal(body.totalAmount, 222.99);
    assert.equal(journl.state.requests.at(-1).companyId, USERS.owner.companyId);
  });

  test("the result carries no GSTIN, address or phone number", async () => {
    const r = await owner.callTool({ name: "create_sales_invoice", arguments: SALE });
    const out = JSON.stringify(r);
    for (const secret of ["32ABCDE1234F1Z5", "12 Secret St", "9999999999"]) assert.ok(!out.includes(secret), `${secret} leaked`);
  });

  test("JournL's own refusal, such as insufficient stock, is passed on", async () => {
    journl.state.failCreate = { status: 422, body: { success: false, negativeStockError: true, message: 'Insufficient stock: "Widget" (available: 1, requested: 2)' } };
    const r = await owner.callTool({ name: "create_sales_invoice", arguments: { ...SALE, confirm: true } });
    assert.equal(r.isError, true);
    assert.equal(r.content[0].text, 'JournL: Insufficient stock: "Widget" (available: 1, requested: 2)');
  });
});
