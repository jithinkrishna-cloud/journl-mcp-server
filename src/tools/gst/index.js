// GST returns: GSTR-1 (outward supplies) and GSTR-2B (inward supplies).

import { z } from "zod";
import { pick } from "../../utils/projection.js";
import { branch, branchQuery, period, reportTool } from "../shared.js";

const INVOICE_FIELDS = {
  gstin: "GSTIN_UIN",
  partyName: "PartyName",
  transactionType: "TransactionType",
  invoiceNo: "InvoiceNo",
  supplierInvoiceNo: "SupplierInvoiceNo",
  invoiceDate: "InvoiceDate",
  invoiceValue: "InvoiceValue",
  rate: "Rate",
  taxableValue: "TaxableValue",
  igst: "IntegratedTaxAmount",
  cgst: "CentralTaxAmount",
  sgstUtgst: "StateUTTaxAmount",
  placeOfSupply: "PlaceOfSupply",
};
const TOTAL_FIELDS = { invoiceValue: "InvoiceValue", taxableValue: "TaxableValue", igst: "IntegratedTaxAmount", cgst: "CentralTaxAmount", sgstUtgst: "StateUTTaxAmount" };

export function registerGstTools(server) {
  for (const [kind, label, path, direction] of [
    ["r1", "GSTR-1", "/reports/gst-r1-report", "outward supplies (sales)"], // JournL checks feature 39
    ["r2b", "GSTR-2B", "/reports/gst-r2b-report", "inward supplies (purchases)"], // JournL checks feature 40
  ]) {
    reportTool(server, {
      name: `get_gst_${kind}_report`,
      title: `Get ${label} report`,
      description: `Use this when the user asks for the ${label} report, GST on ${direction}, taxable value or tax totals for a period. Invoices are paged; grand totals cover the whole period.`,
      inputSchema: {
        ...period,
        page: z.number().int().min(1).max(10_000).default(1).describe("Page number."),
        limit: z.number().int().min(1).max(50).default(20).describe("Invoices per page (max 50)."),
        ...branch,
      },
      path,
      toQuery: (a) => ({ startDate: a.startDate, endDate: a.endDate, page: a.page, limit: a.limit, ...branchQuery(a) }),
      project: (data) => ({
        grandTotals: pick(data?.grandTotals, TOTAL_FIELDS),
        ...pick(data, { totalInvoices: "total", page: "page", totalPages: "totalPages" }),
        invoices: (Array.isArray(data?.result) ? data.result : []).map((r) => pick(r, INVOICE_FIELDS)),
      }),
      summarize: (a) => `${label} report, ${a.startDate} to ${a.endDate}, page ${a.page}.`,
    });
  }
}
