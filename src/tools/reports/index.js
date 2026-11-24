// Financial reports: ageing, group summary, cash flow, business summary.

import { z } from "zod";
import { FEATURE } from "../../services/permissions.js";
import { capLists, pick, rows } from "../../utils/projection.js";
import { branch, branchQuery, isoDate, maxRows, period, reportTool } from "../shared.js";

const groupNode = (node) => ({
  ...pick(node, { id: "id", type: "type", name: "name", openingTotal: "openingTotal", currentTotal: "currentTotal", closingTotal: "closingTotal" }),
  ...(Array.isArray(node?.children) && node.children.length ? { children: node.children.map(groupNode) } : {}),
});

const cashLine = (l) => pick(l, { name: "name", amount: "amount" });
const cashBalance = (b) => pick(b, { cash: "cash", bank: "bank", bankOverdraft: "bankOverdraft", total: "total" });
const list = (value) => (Array.isArray(value) ? value : []);

// Sums JournL's per-bill ageing figures by party (ledger), largest outstanding first.
// Works in paise to avoid floating-point drift on rupee amounts.
const AGEING_FIELDS = { outstanding: "totalAmount", days0to30: "age0to30", days31to60: "age31to60", days61to90: "age61to90", days90plus: "age90plus" };
const paise = (v) => Math.round(Number(v || 0) * 100);

function partyTotals(bills) {
  const byParty = new Map();
  for (const b of list(bills)) {
    const key = b.ledgerId ?? b.ledgerName;
    const p = byParty.get(key) ?? { party: b.ledgerName, ledgerId: b.ledgerId, bills: 0, sums: {} };
    p.bills += 1;
    for (const [to, from] of Object.entries(AGEING_FIELDS)) p.sums[to] = (p.sums[to] ?? 0) + paise(b[from]);
    byParty.set(key, p);
  }
  return [...byParty.values()]
    .map(({ sums, ...p }) => ({ ...p, ...Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, v / 100])) }))
    .sort((x, y) => y.outstanding - x.outstanding);
}

export function registerReportTools(server) {
  reportTool(server, {
    name: "get_ageing_report",
    title: "Get receivables or payables ageing",
    description:
      "Use this when the user asks who owes the company money (receivable) or whom the company owes (payable), overdue bills, or outstanding amounts by age (0-30, 31-60, 61-90, 90+ days). Returns company totals, per-party totals (use these instead of adding bills) and the individual bills.",
    inputSchema: {
      type: z.enum(["receivable", "payable"]).describe("receivable = customers owe us; payable = we owe suppliers."),
      startDate: isoDate.optional().describe("Optional bill date range start, YYYY-MM-DD."),
      endDate: isoDate.optional().describe("Optional bill date range end and 'as of' date, YYYY-MM-DD."),
      ...branch,
      maxRows,
    },
    path: "/reports/ageing-report", // JournL checks feature 36 (payable) / 37 (receivable)
    toQuery: (a) => ({ type: a.type, startDate: a.startDate, endDate: a.endDate, ...branchQuery(a) }),
    project: (data, a, truncated) => ({
      totals: pick(data?.totals, { outstanding: "totalAmount", days0to30: "age0to30", days31to60: "age31to60", days61to90: "age61to90", days90plus: "age90plus" }),
      // Per-party totals over ALL bills, so the model never has to add bills up itself.
      parties: rows(partyTotals(data?.billEntries), a.maxRows, "parties", truncated, (p) => p),
      bills: rows(data?.billEntries, a.maxRows, "bills", truncated, (b) =>
        pick(b, {
          billNo: "billNo",
          party: "ledgerName",
          ledgerId: "ledgerId",
          billDate: "billDate",
          dueDate: "dueDate",
          ageDays: "ageDays",
          outstanding: "totalAmount",
          days0to30: "age0to30",
          days31to60: "age31to60",
          days61to90: "age61to90",
          days90plus: "age90plus",
        }),
      ),
    }),
    summarize: (a) => `${a.type === "receivable" ? "Receivables" : "Payables"} ageing${a.endDate ? ` as of ${a.endDate}` : ""}.`,
  });

  reportTool(server, {
    name: "get_group_summary",
    title: "Get group summary",
    description:
      "Use this when the user wants opening, period and closing totals for an accounting group and its sub-groups and ledgers, e.g. 'summarise indirect expenses this quarter'. Needs a groupId from list_ledger_groups.",
    inputSchema: {
      groupId: z.number().int().positive().describe("Accounting group ID from list_ledger_groups."),
      ...period,
      ...branch,
    },
    path: "/reports/group-summery-report", // JournL checks feature 38
    toQuery: (a) => ({ groupId: a.groupId, startDate: a.startDate, endDate: a.endDate, ...branchQuery(a) }),
    project: (data) => groupNode(data),
    summarize: (a) => `Group summary for group ${a.groupId}, ${a.startDate} to ${a.endDate}.`,
  });

  reportTool(server, {
    name: "get_cash_flow",
    title: "Get cash flow statement",
    description:
      "Use this when the user asks about cash flow, where cash came from or went, or operating, investing and financing activities for a period.",
    inputSchema: {
      ...period,
      overdraftTreatment: z.enum(["cashEquivalent", "financing"]).optional().describe("How bank overdraft ledgers are treated (default cashEquivalent)."),
      ...branch,
    },
    path: "/reports/cash-flow",
    permission: [FEATURE.CASH_FLOW],
    toQuery: (a) => ({ startDate: a.startDate, endDate: a.endDate, overdraftTreatment: a.overdraftTreatment, ...branchQuery(a) }),
    project: (data) => ({
      sections: list(data?.data).map((s) => ({
        ...pick(s, { title: "title", subtotalReceipts: "subtotalReceipts", subtotalPayments: "subtotalPayments", netCashFlow: "netCashFlow" }),
        receipts: list(s.receipts).map(cashLine),
        payments: list(s.payments).map(cashLine),
      })),
      totals: {
        ...pick(data?.totals, { totalReceipts: "totalReceipts", totalPayments: "totalPayments", netCashFlow: "netCashFlow" }),
        openingBalance: cashBalance(data?.totals?.openingBalance),
        closingBalance: cashBalance(data?.totals?.closingBalance),
        ...(data?.totals?.policy?.overdraftTreatment ? { overdraftTreatment: data.totals.policy.overdraftTreatment } : {}),
      },
    }),
    summarize: (a) => `Cash flow statement, ${a.startDate} to ${a.endDate}.`,
  });

  reportTool(server, {
    name: "get_business_summary",
    title: "Get business summary",
    description:
      "Use this when the user asks how the business is doing overall: profit and loss, financial position, working capital, trends and GST/TDS compliance for a period. Sections the user may not view in JournL are left out.",
    inputSchema: { ...period, ...branch },
    path: "/dashboard/summary", // JournL redacts sections the caller may not view (`restricted`)
    toQuery: (a) => ({ startDate: a.startDate, endDate: a.endDate, ...branchQuery(a) }),
    project: (data, _a, truncated) =>
      capLists(
        pick(data, {
          position: "position",
          profitability: "profitability",
          profitLoss: "profitLoss",
          workingCapital: "workingCapital",
          trend: "trend",
          compliance: "compliance",
          composition: "composition",
          restrictedSections: "restricted",
        }),
        12,
        "summary",
        truncated,
      ),
    summarize: (a) => `Business summary, ${a.startDate} to ${a.endDate}.`,
  });
}
