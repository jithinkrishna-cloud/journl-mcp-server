// Ledgers (accounts) and accounting groups.

import { z } from "zod";
import { FEATURE } from "../../services/permissions.js";
import { pick, rows } from "../../utils/projection.js";
import { branch, branchQuery, maxRows, period, reportTool } from "../shared.js";

// JournL stores ledger amounts signed: negative = Debit, positive = Credit (as its own
// ledger-statement screen shows them). Convert once here so the model never has to guess.
const toNumber = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

function debitCredit(signed) {
  const n = toNumber(signed);
  if (n === null || Number.isNaN(n)) return {};
  return { debit: n < 0 ? Math.abs(n) : 0, credit: n > 0 ? n : 0 };
}

/** Total debit, total credit and row count, summed in paise to avoid float drift. */
function debitCreditTotals(list) {
  let debit = 0;
  let credit = 0;
  const all = Array.isArray(list) ? list : [];
  for (const r of all) {
    const p = Math.round((toNumber(r.totalAmount) ?? 0) * 100);
    if (p < 0) debit -= p;
    else credit += p;
  }
  return { debit: debit / 100, credit: credit / 100, transactions: all.length };
}

/** A balance as { amount, side: "Dr" | "Cr" }; null when JournL has none. */
function drCrBalance(signed) {
  const n = toNumber(signed);
  if (n === null || Number.isNaN(n)) return null;
  return { amount: Math.abs(n), side: n < 0 ? "Dr" : n > 0 ? "Cr" : "Nil" };
}

export function registerLedgerTools(server) {
  reportTool(server, {
    name: "search_ledgers",
    title: "Search ledgers",
    description:
      "Use this when you need a ledger's ID or want to find ledgers (accounts) by name, e.g. a bank, cash, customer, supplier or expense account. Call this before get_ledger_statement. Returns at most 50 matches.",
    inputSchema: {
      search: z.string().max(100).optional().describe("Part of the ledger name, e.g. 'HDFC' or 'rent'."),
      scope: z.enum(["all", "cash", "bank"]).default("all").describe("Limit to cash or bank ledgers."),
    },
    path: "/dashboard/lookups/ledgers", // JournL checks ledger view permission
    toQuery: (a) => ({ search: a.search, scope: a.scope }),
    project: (data) => ({ ledgers: (Array.isArray(data) ? data : []).map((l) => pick(l, { ledgerId: "id", name: "name", group: "groupName" })) }),
    summarize: (a) => `Ledgers matching ${a.search ? `"${a.search}"` : "any name"} (${a.scope}).`,
  });

  reportTool(server, {
    name: "get_ledger_statement",
    title: "Get ledger statement",
    description:
      "Use this when the user wants the transactions, opening balance or net movement of one ledger (account) for a period, e.g. 'show my HDFC bank ledger for October'. Needs a ledgerId from search_ledgers. Can filter by exact amount or voucher number. Each transaction has debit and credit amounts and a running balance marked Dr or Cr, as in JournL; totals gives total debit, total credit and transaction count for the whole period (use them instead of adding rows). Do not use for company-wide reports.",
    inputSchema: {
      ledgerId: z.number().int().positive().describe("Ledger ID from search_ledgers."),
      ...period,
      amount: z.number().positive().optional().describe("Only rows whose debit or credit equals this amount."),
      voucherNumber: z.string().max(50).optional().describe("Only rows with this exact voucher number."),
      ...branch,
      maxRows,
    },
    path: "/reports/ledger-statement",
    permission: [FEATURE.LEDGER_STATEMENT, FEATURE.GENERAL_LEDGER],
    toQuery: (a) => ({ ledgerId: a.ledgerId, startDate: a.startDate, endDate: a.endDate, amount: a.amount, voucherNumber: a.voucherNumber, ...branchQuery(a) }),
    project: (data, a, truncated) => ({
      openingBalance: drCrBalance(data?.openingBalance),
      netMovement: drCrBalance(data?.netTotal),
      ...(data?.filteredTotal !== undefined && data.filteredTotal !== data.netTotal ? { filteredMovement: drCrBalance(data.filteredTotal) } : {}),
      // Over ALL returned rows (not just maxRows), so the model never adds rows up itself.
      totals: debitCreditTotals(data?.result),
      transactions: rows(data?.result, a.maxRows, "transactions", truncated, (r) => ({
        ...pick(r, {
          date: "voucherDate",
          voucherType: "voucherTypeName",
          voucherNumber: "voucherNumber",
          description: "voucherDescription",
          ledger: "ledgerName",
          party: "partyName",
        }),
        ...debitCredit(r.totalAmount),
        ...(r.balance !== undefined ? { balance: drCrBalance(r.balance) } : {}),
      })),
    }),
    summarize: (a) => `Ledger statement for ledger ${a.ledgerId}, ${a.startDate} to ${a.endDate}.`,
  });

  reportTool(server, {
    name: "list_ledger_groups",
    title: "List ledger groups",
    description:
      "Use this when you need an accounting group's ID (e.g. Indirect Expenses, Current Assets) before calling get_group_summary, or when the user asks which account groups exist.",
    inputSchema: { maxRows },
    path: "/ledgerGroup/general-ledger-groups",
    permission: [FEATURE.GROUP_SUMMARY, FEATURE.GENERAL_LEDGER],
    toQuery: () => ({}),
    project: (data, a, truncated) => ({
      groups: rows(data, a.maxRows, "groups", truncated, (g) => pick(g, { groupId: "id", name: "name", nature: "nature", parentGroupId: "parentId" })),
    }),
    summarize: () => "Accounting groups in this company.",
  });
}
