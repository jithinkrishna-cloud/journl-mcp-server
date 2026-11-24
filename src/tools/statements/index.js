// Financial statements: profit & loss, balance sheet, trial balance.

import { FEATURE, OWNER_ONLY } from "../../services/permissions.js";
import { pick } from "../../utils/projection.js";
import { branch, branchQuery, period, reportTool } from "../shared.js";

const list = (v) => (Array.isArray(v) ? v : []);
const paise = (v) => Math.round(Number(v || 0) * 100);

/** Group/ledger tree for P&L and balance sheet: name, amount, children (internal IDs dropped). */
function statementNode(node) {
  const out = { name: node?.name ?? node?.ledgerName, amount: node?.totalAmount ?? node?.amount };
  if (typeof node?.id === "number" && node?.ledgerName === undefined) out.groupId = node.id;
  if (typeof node?.ledgerId === "number") out.ledgerId = node.ledgerId;
  const children = list(node?.children);
  if (children.length) out.children = children.map(statementNode);
  return out;
}

const statementSections = (data) =>
  list(data?.data).map((section) => ({ nature: section.nature, groups: list(section.groups).map(statementNode) }));

const side = (n, prefix) => ({ debit: Number(n?.[`${prefix}Debit`] ?? 0), credit: Number(n?.[`${prefix}Credit`] ?? 0) });

function trialNode(n) {
  const out = {
    name: n.ledgerName ?? n.name,
    ...(typeof n.ledgerId === "number" ? { ledgerId: n.ledgerId } : { groupId: n.id }),
    opening: side(n, "opening"),
    period: side(n, "current"),
    closing: side(n, "close"),
  };
  const children = list(n.children);
  if (children.length) out.children = children.map(trialNode);
  return out;
}

/** Grand totals over the top-level groups, in paise to avoid float drift. */
function trialTotals(groups) {
  const t = { openingDebit: 0, openingCredit: 0, currentDebit: 0, currentCredit: 0, closeDebit: 0, closeCredit: 0 };
  for (const g of groups) for (const k of Object.keys(t)) t[k] += paise(g[k]);
  const r = (k) => t[k] / 100;
  return {
    opening: { debit: r("openingDebit"), credit: r("openingCredit") },
    period: { debit: r("currentDebit"), credit: r("currentCredit") },
    closing: { debit: r("closeDebit"), credit: r("closeCredit") },
    balanced: t.closeDebit === t.closeCredit,
  };
}

export function registerStatementTools(server) {
  reportTool(server, {
    name: "get_profit_and_loss",
    title: "Get profit and loss statement",
    description:
      "Use this when the user asks for the profit and loss (P&L / income statement) with income and expense groups and ledgers for a period, or 'am I making money'. Returns JournL's totals (total income, total expense, net profit or loss). For a quick overall health check use get_business_summary instead.",
    inputSchema: { ...period, ...branch },
    path: "/defaultAccountingGroups/profit-loss",
    permission: [FEATURE.PROFIT_LOSS],
    toQuery: (a) => ({ startDate: a.startDate, endDate: a.endDate, ...branchQuery(a) }),
    project: (data) => ({
      sections: statementSections(data),
      totals: pick(data?.totals, { totalIncome: "totalIncome", totalExpense: "totalExpense", netProfitLoss: "netProfitLoss" }),
    }),
    summarize: (a) => `Profit and loss, ${a.startDate} to ${a.endDate}.`,
  });

  reportTool(server, {
    name: "get_balance_sheet",
    title: "Get balance sheet",
    description:
      "Use this when the user asks for the balance sheet, assets and liabilities, capital, or net worth as of a date. Returns asset and liability groups with ledgers and JournL's totals (total assets, total liabilities, difference, net profit or loss).",
    inputSchema: { ...period, ...branch },
    path: "/defaultAccountingGroups/balance-sheet",
    permission: [FEATURE.BALANCE_SHEET],
    toQuery: (a) => ({ startDate: a.startDate, endDate: a.endDate, ...branchQuery(a) }),
    project: (data) => ({
      sections: statementSections(data),
      totals: pick(data?.totals, { totalAssets: "totalAssets", totalLiabilities: "totalLiabilities", difference: "difference", netProfitLoss: "netProfitLoss" }),
    }),
    summarize: (a) => `Balance sheet as of ${a.endDate} (period from ${a.startDate}).`,
  });

  reportTool(server, {
    name: "get_trial_balance",
    title: "Get trial balance",
    description:
      "Use this when the user asks for the trial balance: opening, period and closing debit and credit for every accounting group and ledger. Grand totals and a balanced check are included; use them instead of adding rows.",
    inputSchema: { ...period, ...branch },
    path: "/defaultAccountingGroups/trial-balance",
    permission: OWNER_ONLY, // JournL only checks sign-in on this route; feature ID not yet confirmed
    // JournL requires companyStartDate but computes opening balances without it.
    toQuery: (a) => ({ startDate: a.startDate, endDate: a.endDate, companyStartDate: a.startDate, ...branchQuery(a) }),
    project: (data) => ({ totals: trialTotals(list(data)), groups: list(data).map(trialNode) }),
    summarize: (a) => `Trial balance, ${a.startDate} to ${a.endDate}.`,
  });
}
