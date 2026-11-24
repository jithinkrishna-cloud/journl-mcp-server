// Vouchers (invoices, receipts, payments, journals): search like a day book, and open one.
// Billing/shipping addresses, phone numbers and emails are never returned.

import { z } from "zod";
import { FEATURE } from "../../services/permissions.js";
import { pick } from "../../utils/projection.js";
import { branch, branchQuery, isoDate, reportTool } from "../shared.js";

const list = (v) => (Array.isArray(v) ? v : []);
const drCr = (isDr) => (isDr === undefined || isDr === null ? undefined : Number(isDr) === 1 || isDr === true ? "Dr" : "Cr");

export function registerVoucherTools(server) {
  reportTool(server, {
    name: "search_vouchers",
    title: "Search vouchers",
    description:
      "Use this when the user asks for a list of vouchers or invoices: sales or purchase invoices for a period, receipts, payments, journals, a day book, or to find a voucher by number, party or amount. Results are paged and include JournL's debit and credit totals for all matches. Use get_voucher with a voucherId to see one voucher's lines.",
    inputSchema: {
      startDate: isoDate.optional().describe("Period start, YYYY-MM-DD (use with endDate)."),
      endDate: isoDate.optional().describe("Period end, YYYY-MM-DD."),
      voucherType: z.string().max(40).optional().describe("Voucher type name, e.g. Sales, Purchase, Receipt, Payment, Journal, Contra, Sales Return, Purchase Return."),
      search: z.string().max(100).optional().describe("Matches invoice/voucher number or party ledger name."),
      party: z.string().max(100).optional().describe("Party or particulars name contains this text."),
      voucherNo: z.string().max(50).optional().describe("Voucher or invoice number contains this text."),
      minAmount: z.number().nonnegative().optional().describe("Minimum voucher amount."),
      maxAmount: z.number().nonnegative().optional().describe("Maximum voucher amount."),
      sortBy: z.enum(["voucherDate", "amount", "vchNo"]).default("voucherDate"),
      sortOrder: z.enum(["asc", "desc"]).default("desc"),
      page: z.number().int().min(1).max(10_000).default(1),
      limit: z.number().int().min(1).max(50).default(20).describe("Vouchers per page (max 50)."),
      ...branch,
    },
    path: "/transaction/all-voucher",
    permission: [FEATURE.DAY_BOOK], // JournL only checks sign-in and branch on this route
    toQuery: (a) => ({
      startDate: a.startDate && a.endDate ? a.startDate : undefined,
      endDate: a.startDate && a.endDate ? a.endDate : undefined,
      voucherType: a.voucherType,
      searchQuery: a.search,
      particulars: a.party,
      voucherNo: a.voucherNo,
      minAmount: a.minAmount,
      maxAmount: a.maxAmount,
      sortBy: a.sortBy,
      sortOrder: a.sortOrder,
      page: a.page,
      limit: a.limit,
      ...branchQuery(a),
    }),
    project: (data) => ({
      ...pick(data, { totalVouchers: "total", page: "page", totalPages: "totalPages", debitTotal: "debitTotalAmount", creditTotal: "creditTotalAmount" }),
      vouchers: list(data?.result).map((v) => ({
        ...pick(v, {
          voucherId: "id",
          date: "voucherDate",
          voucherType: "voucherTypeName",
          voucherNo: "voucherNo",
          invoiceNo: "invoiceNo",
          party: "accountName",
          description: "description",
          taxAmount: "taxAmount",
          amount: "totalAmount",
          refNo: "refNo",
        }),
        particulars: list(v.particulars).map((p) => ({ name: p.particularsName, amount: p.amount, side: drCr(p.isDr) })),
      })),
    }),
    summarize: (a) => `Vouchers${a.voucherType ? ` of type ${a.voucherType}` : ""}${a.startDate && a.endDate ? `, ${a.startDate} to ${a.endDate}` : ""}, page ${a.page}.`,
  });

  reportTool(server, {
    name: "get_voucher",
    title: "Get voucher details",
    description:
      "Use this when the user wants the details of one voucher or invoice: items, quantities, rates, tax, ledger lines with Dr/Cr, totals and party. Needs a voucherId from search_vouchers.",
    inputSchema: { voucherId: z.number().int().positive().describe("Voucher ID from search_vouchers.") },
    path: (a) => `/transaction/single-voucher/${a.voucherId}`,
    permission: [FEATURE.DAY_BOOK],
    toQuery: () => ({}),
    project: (v) => {
      const ledgerLines = list(v?.ledgerItems).map((l) => ({
        ...pick(l, { ledger: "ledgerName", ledgerId: "ledgerId", amount: "totalAmount", description: "description" }),
        side: drCr(l.isDr),
        ...(Number(l.isParty) === 1 ? { isParty: true } : {}),
        ...(Number(l.isTax) === 1 ? { isTax: true } : {}),
      }));
      return {
        ...pick(v, {
          voucherId: "id",
          voucherType: "voucherTypeName",
          voucherNo: "voucherNo",
          invoiceNo: "invoiceNo",
          date: "voucherDate",
          invoiceDate: "invoiceDate",
          partyTaxType: "partyTaxType",
          partyGstin: "billGstNo",
          description: "description",
          refNo: "refNo",
          refDate: "refDate",
          salesman: "salesManName",
          totalQuantity: "totalQuantity",
          discount: "discountValue",
          amount: "amount",
          taxAmount: "taxAmount",
          totalAmount: "totalAmount",
        }),
        party: ledgerLines.find((l) => l.isParty)?.ledger,
        items: list(v?.stockItems).map((i) =>
          pick(i, {
            item: "stockItemName",
            stockId: "stockId",
            hsnCode: "hsnCode",
            quantity: "displayQuantity",
            unit: "unitName",
            rate: "ratePer",
            discount: "discValue",
            taxableValue: "taxAssValue",
            taxPercent: "taxPer",
            tax: "totalTaxAmount",
            amount: "totalAmount",
          }),
        ),
        ledgerLines,
      };
    },
    summarize: (a) => `Voucher ${a.voucherId}.`,
  });
}
