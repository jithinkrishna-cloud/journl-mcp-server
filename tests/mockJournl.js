// A stand-in for JournL's API, so tests never touch real or production accounting data.
// Mirrors the response shapes of JournL's OpenAPI spec, plus extra internal fields
// (createdAt, voucherId, ...) that the MCP server must not pass through.

import express from "express";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const fakeJwt = (claims) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ exp: Math.floor(Date.now() / 1000) + 8 * 3600, ...claims })}.sig`;

export const USERS = {
  owner: { email: "owner@demo.test", password: "owner-pass", role: "company", id: 11, companyId: 101 },
  staff: { email: "staff@demo.test", password: "staff-pass", role: "company_user", id: 22, companyId: 101, permissions: [{ featureId: 26, view: true }] },
  // May add sales invoices (feature 14) but not purchase invoices (feature 16).
  clerk: { email: "clerk@demo.test", password: "clerk-pass", role: "company_user", id: 33, companyId: 101, permissions: [{ featureId: 14, view: true, add: true }, { featureId: 16, view: true, add: false }] },
  blocked: { email: "blocked@demo.test", password: "blocked-pass" },
  multi: { email: "multi@demo.test", password: "multi-pass" },
};

export function startMockJournl() {
  const app = express();
  app.use(express.json());
  const tokens = new Map(); // JournL JWT -> user
  const state = { requests: [], tokens, failNext: null, logins: 0 };

  app.post("/auth/login", (req, res) => {
    state.logins += 1;
    const { email, password } = req.body ?? {};
    if (email === USERS.blocked.email && password === USERS.blocked.password) {
      return res.json({ success: false, message: "User is blocked. Please contact your administrator." });
    }
    if (email === USERS.multi.email && password === USERS.multi.password) {
      return res.json({ success: true, message: "Multiple users found", data: [{ id: 1, role: "company" }, { id: 2, role: "company_user" }] });
    }
    const user = Object.values(USERS).find((u) => u.email === email);
    if (!user) return res.json({ success: false, message: "User not found" });
    if (user.password !== password) return res.json({ success: false, message: "Invalid password" });

    const token = fakeJwt({ id: user.id, role: user.role, dbName: user.companyId });
    tokens.set(token, user);
    res.json({
      success: true,
      data: [
        {
          sessionId: "s",
          id: user.id,
          name: user.role === "company" ? "Owner One" : "Staff Two",
          email: user.email,
          password: "$2b$hash-should-never-leak",
          role: user.role,
          branchId: user.role === "company_user" ? 1 : null,
          token,
          companyDetails: [{ id: user.companyId, name: "Demo Co", countrySymbol: "INR", stateId: 18 }],
          permissionData: user.permissions ?? [],
        },
      ],
    });
  });

  // JournL's authMiddleware: Bearer JWT required; the JWT decides the company.
  app.use((req, res, next) => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const user = tokens.get(token);
    state.requests.push({ method: req.method, path: req.path, query: { ...req.query }, body: req.body, user: user?.email ?? null, companyId: user?.companyId ?? null });
    if (!user) return res.status(401).json({ success: false, message: "jwt expired" });
    if (state.failNext) {
      const { status, body } = state.failNext;
      state.failNext = null;
      return res.status(status).json(body);
    }
    req.user = user;
    next();
  });

  app.get("/dashboard/lookups/ledgers", (req, res) => {
    if (req.query.search === "nothing-matches") return res.json({ success: true, data: [] });
    res.json({ success: true, data: [{ id: 5, name: "HDFC Bank", primaryGroupId: 9, groupName: "Bank Accounts", createdAt: "2025-01-01T00:00:00Z" }] });
  });

  app.get("/reports/ledger-statement", (req, res) => {
    if (state.statementOverride) {
      const data = state.statementOverride;
      state.statementOverride = null;
      return res.json({ success: true, data });
    }
    const result = Array.from({ length: 3 }, (_, i) => ({
      id: 900 + i,
      voucherId: 700 + i,
      voucherDate: `2025-04-0${i + 1}`,
      voucherTypeName: "Receipt",
      voucherType: "receipt",
      voucherTypeId: 3,
      voucherDescription: `Payment ${i + 1}`,
      voucherNumber: String(i + 1),
      accountId: 44,
      ledgerName: "HDFC Bank",
      primaryGroupId: 9,
      partyName: "Acme Traders",
      totalAmount: 1000 * (i + 1),
      createdBy: 11,
    }));
    res.json({ success: true, data: { openingBalance: 5000, netTotal: 6000, filteredTotal: 6000, result } });
  });

  app.get("/reports/ageing-report", (req, res) => {
    // JournL enforces features 36/37 itself; the staff user has neither.
    if (req.user.role === "company_user") return res.status(403).json({ success: false, message: "You do not have permission to view this report." });
    const bill = (billNo, ledgerId, ledgerName, amount, bucket) => ({
      billNo, ledgerId, ledgerName, entryType: "On Account", billDate: "2026-01-01", dueDate: "2026-01-31", ageDays: 120, createdAt: "x",
      totalAmount: amount, age0to30: 0, age31to60: 0, age61to90: bucket === 61 ? amount : 0, age90plus: bucket === 90 ? amount : 0,
    });
    res.json({
      success: true,
      data: {
        billEntries: [bill("A1", 26, "Acme", 0.1, 90), bill("A2", 26, "Acme", 0.2, 90), bill("B1", 30, "Beta", 250, 61)],
        totals: { totalAmount: 250.3, age0to30: 0, age31to60: 0, age61to90: 250, age90plus: 0.3 },
      },
    });
  });

  app.get("/defaultAccountingGroups/profit-loss", (_req, res) =>
    res.json({
      success: true,
      data: {
        data: [{ nature: "Income", groups: [{ id: "g1", name: "Sales Accounts", totalAmount: 1000, children: [{ id: 9, ledgerId: 9, ledgerName: "Sales", totalAmount: 1000, createdAt: "x" }] }] }],
        totals: { totalIncome: 1000, totalExpense: 400, netProfitLoss: 600 },
      },
    }),
  );

  app.get("/defaultAccountingGroups/trial-balance", (req, res) => {
    if (!req.query.companyStartDate) return res.status(400).json({ success: false, message: "Both startDate, endDate and companyStartDate are required" });
    const g = (id, name, closeDebit, closeCredit) => ({ id, name, primaryGroupId: 1, openingDebit: 0, openingCredit: 0, currentDebit: closeDebit, currentCredit: closeCredit, closeDebit, closeCredit, children: [] });
    res.json({ success: true, data: [g(1, "Bank Accounts", 100.1, 0), g(2, "Sales Accounts", 0, 100.1)] });
  });

  app.get("/transaction/all-voucher", (_req, res) =>
    res.json({
      success: true,
      data: {
        total: 1, page: 1, limit: 20, totalPages: 1, debitTotalAmount: 118, creditTotalAmount: 118,
        result: [{
          id: 109, voucherNo: "25", voucherTypeName: "Sales", invoiceNo: "INV-25", voucherDate: "2026-05-30", accountName: "Acme Traders",
          totalAmount: 118, taxAmount: 18, description: "", billMobile: "9999999999", billAddress1: "12 Secret St", createdBy: 11,
          particulars: [{ particularsName: "Acme Traders", amount: 118, isDr: 1 }],
        }],
      },
    }),
  );

  app.get("/transaction/single-voucher/:id", (req, res) =>
    res.json({
      success: true,
      data: {
        id: Number(req.params.id), voucherTypeName: "Sales", voucherNo: "25", voucherDate: "2026-05-30", amount: 100, taxAmount: 18, totalAmount: 118,
        accountEmail: "buyer@example.com", billMobile: "9999999999", billGstNo: "32ABCDE1234F1Z5", createdBy: 11,
        stockItems: [{ stockItemName: "Widget", stockId: 4, displayQuantity: 2, unitName: "Nos", ratePer: 50, taxPer: 18, totalTaxAmount: 18, totalAmount: 118, createdAt: "x" }],
        ledgerItems: [
          { ledgerName: "Acme Traders", ledgerId: 30, totalAmount: 118, isDr: 1, isParty: 1, isTax: 0 },
          { ledgerName: "Sales", ledgerId: 9, totalAmount: 100, isDr: 0, isParty: 0, isTax: 0 },
        ],
      },
    }),
  );

  app.get("/reports/cash-flow", (_req, res) => res.json({ success: true, data: { data: [], totals: { totalReceipts: 0, totalPayments: 0, netCashFlow: 0 } } }));

  app.get("/reports/closing-stock-report", (_req, res) => res.json({ success: true, data: { openingTotal: 0, result: [] } }));

  // --- masters and create-voucher, for the invoice write tools ---------------------
  // The company (login stateId 18) is in state 18.
  const LEDGERS = {
    30: { id: 30, name: "Acme Traders", primaryGroupId: 26, taxType: "registered", state: 18, country: 1, gstNumber: "32ABCDE1234F1Z5", billAddress: "12 Secret St", mobile: "9999999999" },
    31: { id: 31, name: "Far Away Retail", primaryGroupId: 26, taxType: "unregistered", state: 27, country: 1 },
    32: { id: 32, name: "Mystery Buyer", primaryGroupId: 26, taxType: "unknown", state: null, country: 1 },
    40: { id: 40, name: "Steel Suppliers", primaryGroupId: 22, taxType: "registered", state: 27, country: 1, gstNumber: "27ABCDE1234F1Z5" },
    41: { id: 41, name: "Local Vendor", primaryGroupId: 22, taxType: "unregistered", state: 18, country: 1 },
    5: { id: 5, name: "HDFC Bank", primaryGroupId: 28 },
  };
  app.get("/companyLedgerMaster/id/:id", (req, res) => {
    const ledger = LEDGERS[req.params.id];
    if (!ledger) return res.status(404).json({ success: false, message: "Company Ledger Master not found" });
    res.json({ success: true, data: { ...ledger, isDeleted: 0, openingBillEntry: [] } });
  });

  const STOCK = {
    4: { id: 4, name: "Widget", taxPercentage: 18, baseUnitId: 2, baseUnitName: "Nos", hsnCode: "8471", isDeleted: 0 },
    7: { id: 7, name: "Bolt", taxPercentage: 5, baseUnitId: 2, baseUnitName: "Nos", hsnCode: "7318", isDeleted: 0 },
    8: { id: 8, name: "Rice", taxPercentage: 0, baseUnitId: 3, baseUnitName: "Kg", isDeleted: 0 },
    9: { id: 9, name: "Old Item", taxPercentage: 18, isDeleted: 1 },
  };
  // Like JournL's getStockItemById, an unknown id answers success with no data.
  app.get("/companyStockItem/:id", (req, res) => res.json({ success: true, data: STOCK[req.params.id] }));

  app.get("/company-voucher-types/primary-voucher-id/:id", (req, res) => {
    const id = Number(req.params.id);
    const name = id === 4 ? "Sales" : id === 6 ? "Purchase" : "Other";
    res.json({ success: true, data: [{ id, name, primaryVoucherId: id, isDeleted: 0 }, { id: 100 + id, name: `${name} B2B`, primaryVoucherId: id, isDeleted: 0 }] });
  });

  app.get("/transaction/getVoucherNo/:voucherTypeId", (req, res) => {
    const prefix = Number(req.params.voucherTypeId) === 6 ? "PUR" : "INV";
    res.json({ success: true, data: { voucherNo: 26, invoiceNumber: `${prefix}/26` } });
  });

  state.vouchers = [];
  app.post("/transaction/create-voucher", (req, res) => {
    if (state.failCreate) {
      const { status, body } = state.failCreate;
      state.failCreate = null;
      return res.status(status).json(body);
    }
    state.vouchers.push(req.body);
    res.status(201).json({ success: true, message: "Voucher added successfully", data: 500 + state.vouchers.length });
  });

  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ url: `http://127.0.0.1:${server.address().port}`, server, state }));
  });
}
