// Customer insight reports: top customers by revenue, inactive customers, payment behaviour.

import { z } from "zod";
import { OWNER_ONLY } from "../../services/permissions.js";
import { pick, rows } from "../../utils/projection.js";
import { isoDate, maxRows, reportTool } from "../shared.js";

// JournL's customer report endpoints build SQL by string concatenation with `search`
// (`LIKE '%${search}%'`), so they are injectable. Until JournL parameterises those
// queries, the characters that can end or escape a MySQL string literal (quotes, backtick,
// backslash), `;` and the LIKE wildcard `%` are refused before anything reaches JournL.
// The pattern deliberately avoids Unicode property classes (\p{…}): ChatGPT rejected the
// whole tool list when the advertised JSON Schema contained one.
const customerSearch = z
  .string()
  .max(100)
  .regex(/^[^'"`\\;%]*$/, "Do not use quotes, backslash, semicolon or %")
  .optional()
  .describe("Customer name contains this text (no quotes, backslash, semicolon or %).");

export function registerCustomerTools(server) {
  reportTool(server, {
    name: "get_top_customers",
    title: "Get top customers",
    description:
      "Use this when the user asks who their biggest or best customers are by sales revenue, with invoice value, number of invoices and share of total, optionally for a period. For who owes money, use get_ageing_report instead.",
    inputSchema: {
      startDate: isoDate.optional().describe("Invoice date from, YYYY-MM-DD (use with endDate)."),
      endDate: isoDate.optional().describe("Invoice date to, YYYY-MM-DD."),
      search: customerSearch,
      maxRows,
    },
    path: "/companyLedgerMaster/top-customers",
    permission: OWNER_ONLY, // JournL only checks sign-in on this route; feature ID not yet confirmed
    toQuery: (a) => ({ startDate: a.startDate && a.endDate ? a.startDate : undefined, endDate: a.startDate && a.endDate ? a.endDate : undefined, search: a.search }),
    project: (data, a, truncated) => ({
      customers: rows(data, a.maxRows, "customers", truncated, (c) =>
        pick(c, { customer: "customerName", invoiceValue: "totalInvoiceValue", invoices: "numberOfInvoices", sharePercent: "percentage" }),
      ),
    }),
    summarize: (a) => `Top customers by revenue${a.startDate && a.endDate ? `, ${a.startDate} to ${a.endDate}` : ""}.`,
  });

  reportTool(server, {
    name: "get_customer_insights",
    title: "Get customer insights",
    description:
      "Use this when the user asks which customers have stopped buying (type 'inactive', with days since last purchase) or how quickly customers pay (type 'payment_behaviour', average payment days). For outstanding amounts use get_ageing_report.",
    inputSchema: {
      type: z.enum(["inactive", "payment_behaviour"]).describe("inactive = no purchase for a while; payment_behaviour = average days to pay."),
      inactiveDays: z.number().int().min(1).max(3650).default(60).describe("For type 'inactive': minimum days since last purchase."),
      search: customerSearch,
      maxRows,
    },
    path: (a) => (a.type === "inactive" ? "/companyLedgerMaster/inactive-customers" : "/companyLedgerMaster/payment-behavior-report"),
    permission: OWNER_ONLY,
    toQuery: (a) => ({ ...(a.type === "inactive" ? { threshold: a.inactiveDays } : {}), search: a.search }),
    project: (data, a, truncated) =>
      a.type === "inactive"
        ? {
            inactiveCustomers: rows(data, a.maxRows, "inactiveCustomers", truncated, (c) =>
              pick(c, { customer: "customerName", lastPurchaseDate: "lastPurchaseDate", daysSinceLastPurchase: "daysSinceLastPurchase", lastPurchaseValue: "lastPurchaseValue" }),
            ),
          }
        : {
            paymentBehaviour: rows(data, a.maxRows, "paymentBehaviour", truncated, (c) => ({
              ...pick(c, { customer: "customerName", averagePaymentDays: "avgPaymentDays" }),
              ...(Array.isArray(c.records) ? { paymentsCounted: c.records.length } : {}),
            })),
          },
    summarize: (a) => (a.type === "inactive" ? `Customers with no purchase for ${a.inactiveDays}+ days.` : "Customer payment behaviour."),
  });
}
