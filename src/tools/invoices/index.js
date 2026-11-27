// Sales and purchase invoices: create one in JournL. Registered only when
// ENABLE_WRITE_TOOLS=true, for testing against a test company.
//
// JournL's create-voucher route trusts its caller with almost everything: it checks no
// permission, takes createdBy from the body and never checks that the voucher balances.
// So this module checks the user's add right, sets createdBy from the session, and prices
// every line, splits GST and totals the invoice itself. JournL still picks the
// Sales/Purchase and GST ledgers from each line's tax rate, and blocks negative stock.

import { z } from "zod";
import { get, JournlApiError, post } from "../../services/journlClient.js";
import { denyAddReason, FEATURE } from "../../services/permissions.js";
import { errorResult, failureResult, isoDate, logged, reportOutput, sessionOf } from "../shared.js";

// primaryVoucherTypeId and accounting group IDs are fixed seeds in every JournL company.
const KINDS = Object.freeze({
  sales: { label: "Sales", primaryVoucherTypeId: 4, feature: FEATURE.SALES, partyGroupId: 26, party: "customer" },
  purchase: { label: "Purchase", primaryVoucherTypeId: 6, feature: FEATURE.PURCHASE, partyGroupId: 22, party: "supplier" },
});

const WRITE = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });

/** The invoice cannot be built from these inputs; the message is safe to show. */
export class InvoiceInputError extends Error {}

const rupees = (paise) => paise / 100;
const sum = (values) => values.reduce((total, v) => total + v, 0);

/**
 * CGST+SGST ("intra") or IGST ("inter"), by JournL's bulk-import rules: the party needs a
 * known GST type and a state, and an unregistered supplier's bill carries no GST.
 */
function placeOfSupply(kind, party, companyStateId) {
  const taxType = String(party.taxType ?? "").trim().toLowerCase();
  if (!taxType || taxType === "unknown") {
    throw new InvoiceInputError(`The GST type of "${party.name}" is not set in JournL, so the GST cannot be posted. Set it on the ledger, then try again.`);
  }
  if (kind === "purchase" && taxType === "unregistered") {
    throw new InvoiceInputError(`"${party.name}" is not registered for GST, so a purchase from it cannot carry GST. Use items without GST, or correct the supplier's GST type.`);
  }
  if (!party.state) throw new InvoiceInputError(`The state of "${party.name}" is not set in JournL, so CGST/SGST or IGST cannot be chosen. Set it on the ledger, then try again.`);
  if (!companyStateId) throw new InvoiceInputError("JournL did not return your company's state. Set it in the company settings, then reconnect JournL in ChatGPT.");
  return String(party.state) === String(companyStateId) ? "intra" : "inter";
}

/**
 * Prices an invoice the way JournL's bulk import does: each line's taxable value and GST
 * rounded to the paisa, GST grouped per rate, and a CGST/SGST pair split so the halves add
 * up to the exact tax (CGST gets the rounded half, SGST the remainder).
 *
 * @param {object} p
 * @param {"sales" | "purchase"} p.kind
 * @param {object} p.party  JournL ledger (name, taxType, state)
 * @param {{stock: object, quantity: number, rate: number, description?: string}[]} p.items
 * @param {string | number | null} p.companyStateId
 */
export function priceInvoice({ kind, party, items, companyStateId }) {
  const lines = items.map(({ stock, quantity, rate, description }) => {
    const taxPer = Number(stock.taxPercentage) || 0;
    const amountPaise = Math.round(quantity * rate * 100);
    const taxPaise = Math.round((amountPaise * taxPer) / 100);
    return { stock, quantity, rate, description, taxPer, amountPaise, taxPaise };
  });
  const taxablePaise = sum(lines.map((l) => l.amountPaise));
  const taxPaise = sum(lines.map((l) => l.taxPaise));

  let supply = "none";
  const taxSplit = [];
  if (taxPaise > 0) {
    supply = placeOfSupply(kind, party, companyStateId);
    const byRate = new Map();
    for (const l of lines) if (l.taxPaise > 0) byRate.set(l.taxPer, (byRate.get(l.taxPer) ?? 0) + l.taxPaise);
    for (const [rate, paise] of byRate) {
      if (supply === "inter") {
        taxSplit.push({ taxName: `IGST ${rate}%`, taxPer: rate, taxPaise: paise });
      } else {
        const half = Math.round(paise / 2);
        taxSplit.push({ taxName: `CGST ${rate / 2}%`, taxPer: rate / 2, taxPaise: half });
        taxSplit.push({ taxName: `SGST ${rate / 2}%`, taxPer: rate / 2, taxPaise: paise - half });
      }
    }
  }
  return { lines, taxSplit, supply, taxablePaise, taxPaise, totalPaise: taxablePaise + taxPaise };
}

/** The create-voucher body. Amounts are positive; JournL applies the Dr/Cr signs itself. */
function voucherBody({ kind, session, voucherType, invoiceNo, party, priced, args }) {
  const k = KINDS[kind];
  return {
    voucherType: voucherType.name,
    voucherTypeId: Number(voucherType.id),
    primaryVoucherTypeId: String(k.primaryVoucherTypeId),
    invoiceNo,
    invoiceDate: args.date,
    voucherDate: args.date,
    accountId: Number(party.id),
    description: args.narration ?? "",
    quantity: sum(priced.lines.map((l) => l.quantity)),
    discountValue: 0,
    amount: rupees(priced.taxablePaise),
    taxAmount: rupees(priced.taxPaise),
    totalAmount: rupees(priced.totalPaise),
    billName: party.name,
    billGstNo: party.gstNumber || null,
    billState: party.state ?? null,
    billCountry: party.country ?? null,
    refNo: args.refNo ?? null,
    refDate: args.refNo ? args.date : null,
    ...(kind === "purchase" && args.refNo ? { supplierBill_no: args.refNo, supplierBill_date: args.date } : {}),
    createdBy: Number(session.userId),
    stockItems: priced.lines.map((l) => ({
      stockId: Number(l.stock.id),
      description: l.description ?? null,
      ratePer: l.rate,
      quantity: l.quantity,
      amount: rupees(l.amountPaise),
      taxPer: l.taxPer,
      taxAmount: rupees(l.taxPaise),
      finalAmount: rupees(l.amountPaise + l.taxPaise),
      unitId: l.stock.baseUnitId ?? null,
      discPer: 0,
      discValue: 0,
      salesLedgerId: null, // JournL picks the Sales/Purchase ledger for the line's tax rate
    })),
    ledgerItems: [],
    // JournL picks each GST ledger from taxName and taxPer.
    taxSplit: priced.taxSplit.map((t) => ({ taxLedgerId: null, taxName: t.taxName, taxPer: t.taxPer, taxAmount: rupees(t.taxPaise) })),
  };
}

/** What the user sees, before and after saving. No addresses, phone numbers or GSTINs. */
function invoiceSummary({ voucherType, invoiceNo, party, priced, args }) {
  return {
    invoiceNo,
    voucherType: voucherType.name,
    date: args.date,
    party: { ledgerId: Number(party.id), name: party.name },
    placeOfSupply: { intra: "Within the state (CGST + SGST)", inter: "Other state (IGST)", none: "No GST" }[priced.supply],
    items: priced.lines.map((l) => ({
      stockId: Number(l.stock.id),
      item: l.stock.name,
      hsnCode: l.stock.hsnCode ?? undefined,
      quantity: l.quantity,
      unit: l.stock.baseUnitName ?? undefined,
      rate: l.rate,
      taxableValue: rupees(l.amountPaise),
      taxPercent: l.taxPer,
      tax: rupees(l.taxPaise),
      amount: rupees(l.amountPaise + l.taxPaise),
    })),
    taxes: priced.taxSplit.map((t) => ({ tax: t.taxName, amount: rupees(t.taxPaise) })),
    totals: { taxableValue: rupees(priced.taxablePaise), tax: rupees(priced.taxPaise), total: rupees(priced.totalPaise) },
    ...(args.refNo ? { refNo: args.refNo } : {}),
    ...(args.narration ? { narration: args.narration } : {}),
  };
}

function registerInvoiceTool(server, kind) {
  const k = KINDS[kind];
  const name = `create_${kind}_invoice`;
  const title = `Create ${kind} invoice`;

  server.registerTool(
    name,
    {
      title,
      description:
        `Use this when the user asks to record a ${kind} invoice (a ${kind === "sales" ? "sale to a customer" : "purchase from a supplier"}) in JournL. ` +
        `First call it with confirm false: it prices the lines from each stock item's GST rate, splits CGST/SGST or IGST by the ${k.party}'s state, and returns a preview without saving. ` +
        `Show the preview to the user, and only after they agree call it again with the same inputs and confirm true to create the invoice. ` +
        `Find the ${k.party}'s ledgerId with search_ledgers and each stockId with get_closing_stock. Discounts and extra charges are not supported.`,
      inputSchema: {
        partyLedgerId: z.number().int().positive().describe(`The ${k.party}'s ledger ID, from search_ledgers.`),
        date: isoDate.describe("Invoice date, YYYY-MM-DD."),
        items: z
          .array(
            z.object({
              stockId: z.number().int().positive().describe("Stock item ID, from get_closing_stock."),
              quantity: z.number().positive().max(10_000_000).describe("Quantity in the item's base unit."),
              rate: z.number().nonnegative().max(1_000_000_000).describe("Rate per unit, before GST."),
              description: z.string().max(200).optional().describe("Optional line description."),
            }),
          )
          .min(1)
          .max(25)
          .describe("Invoice lines (at most 25)."),
        refNo: z.string().max(50).optional().describe(kind === "purchase" ? "The supplier's bill number." : "Optional reference, e.g. the customer's order number."),
        narration: z.string().max(500).optional().describe("Optional narration."),
        voucherTypeId: z.number().int().positive().optional().describe(`Optional ${k.label} voucher type (invoice series). Defaults to the main ${k.label} type.`),
        confirm: z
          .boolean()
          .default(false)
          .describe("false (default): preview only, nothing is saved. true: create the invoice in JournL. Set true only after the user has seen the preview and agreed."),
      },
      outputSchema: reportOutput,
      annotations: { title, ...WRITE },
    },
    logged(name, async (args, extra) => {
      let session;
      try {
        session = sessionOf(extra);
        const denied = denyAddReason(session, k.feature);
        if (denied) return errorResult(denied);
        const token = session.journlToken;

        const party = await get(`/companyLedgerMaster/id/${args.partyLedgerId}`, {}, token);
        if (!party || Number(party.primaryGroupId) !== k.partyGroupId) {
          return errorResult(`Ledger ${args.partyLedgerId} is not a ${k.party} ledger. Use search_ledgers to find the ${k.party}.`);
        }

        const stockIds = [...new Set(args.items.map((i) => i.stockId))];
        const stockById = new Map();
        for (const stock of await Promise.all(stockIds.map((id) => get(`/companyStockItem/${id}`, {}, token)))) {
          if (stock && Number(stock.isDeleted) !== 1) stockById.set(Number(stock.id), stock);
        }
        const missing = stockIds.filter((id) => !stockById.has(id));
        if (missing.length) return errorResult(`Stock item ${missing.join(", ")} was not found. Use get_closing_stock to find stock item IDs.`);

        const types = await get(`/company-voucher-types/primary-voucher-id/${k.primaryVoucherTypeId}`, {}, token);
        const typeList = (Array.isArray(types) ? types : []).filter((t) => Number(t.isDeleted ?? 0) !== 1);
        const voucherType = args.voucherTypeId
          ? typeList.find((t) => Number(t.id) === args.voucherTypeId)
          : (typeList.find((t) => Number(t.id) === k.primaryVoucherTypeId) ?? typeList[0]);
        if (!voucherType) {
          return errorResult(args.voucherTypeId ? `Voucher type ${args.voucherTypeId} is not a ${k.label} voucher type.` : `JournL has no ${k.label} voucher type for this company.`);
        }

        const priced = priceInvoice({
          kind,
          party,
          items: args.items.map((i) => ({ ...i, stock: stockById.get(i.stockId) })),
          companyStateId: session.companyStateId,
        });

        // A preview of the number; JournL keeps this invoice number and recomputes its own voucher number.
        const numbering = await get(`/transaction/getVoucherNo/${voucherType.id}`, { primaryVoucherTypeId: k.primaryVoucherTypeId }, token);
        const invoiceNo = String(numbering?.invoiceNumber ?? numbering?.voucherNo ?? "");

        const summary = invoiceSummary({ voucherType, invoiceNo, party, priced, args });
        const envelope = (result) => ({ company: session.companyName, currency: session.currency, result });
        const total = summary.totals.total;

        if (!args.confirm) {
          return {
            structuredContent: envelope({ saved: false, ...summary }),
            content: [{ type: "text", text: `Preview only, nothing saved: ${k.label} invoice ${invoiceNo} for ${party.name}, total ${total}. Show it to the user; call again with confirm true to create it.` }],
          };
        }

        let voucherId;
        try {
          voucherId = await post("/transaction/create-voucher", voucherBody({ kind, session, voucherType, invoiceNo, party, priced, args }), token);
        } catch (err) {
          // A timeout or dropped connection does not mean JournL did not save it.
          if (err instanceof JournlApiError && err.status === 0) {
            return errorResult(`${err.message} The invoice may still have been saved: check with search_vouchers before trying again.`);
          }
          throw err;
        }
        return {
          structuredContent: envelope({ saved: true, voucherId: Number(voucherId), ...summary }),
          content: [{ type: "text", text: `Created ${k.label} invoice ${invoiceNo} for ${party.name}, total ${total}.` }],
        };
      } catch (err) {
        if (err instanceof InvoiceInputError) return errorResult(err.message);
        return failureResult(name, session, err, "writing to");
      }
    }),
  );
}

export function registerInvoiceTools(server) {
  registerInvoiceTool(server, "sales");
  registerInvoiceTool(server, "purchase");
}
