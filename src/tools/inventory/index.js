// Inventory: closing stock valuation and one item's stock statement.

import { z } from "zod";
import { FEATURE, OWNER_ONLY } from "../../services/permissions.js";
import { pick, rows } from "../../utils/projection.js";
import { branch, branchQuery, maxRows, period, reportTool } from "../shared.js";

const movement = (m) => pick(m, { quantity: "quantity", rate: "ratePer", amount: "amount" });

export function registerInventoryTools(server) {
  reportTool(server, {
    name: "get_closing_stock",
    title: "Get closing stock",
    description:
      "Use this when the user asks about stock or inventory value, or opening, inward, outward and closing stock per item for a period. Returns a stockId per item for get_stock_item_statement.",
    inputSchema: { ...period, ...branch, maxRows },
    path: "/reports/closing-stock-report",
    permission: [FEATURE.CLOSING_STOCK],
    toQuery: (a) => ({ startDate: a.startDate, endDate: a.endDate, ...branchQuery(a) }),
    project: (data, a, truncated) => ({
      totals: pick(data, { openingValue: "openingTotal", inwardValue: "inwardTotal", outwardValue: "outwardTotal", closingValue: "totalClosingBalanceAmount" }),
      items: rows(data?.result, a.maxRows, "items", truncated, (i) => ({
        ...pick(i, { stockId: "stockId", name: "stockName", unit: "unitName" }),
        opening: movement(i.opening),
        inward: movement(i.inward),
        outward: movement(i.outward),
        closing: movement(i.closing),
      })),
    }),
    summarize: (a) => `Closing stock, ${a.startDate} to ${a.endDate}.`,
  });

  reportTool(server, {
    name: "get_stock_item_statement",
    title: "Get stock item statement",
    description:
      "Use this when the user asks about the movements of one stock item for a period: each inward and outward entry with running closing quantity and value, plus opening, inward, outward and closing totals. Needs a stockId from get_closing_stock.",
    inputSchema: {
      stockId: z.number().int().positive().describe("Stock item ID from get_closing_stock."),
      ...period,
      search: z.string().max(100).optional().describe("Only entries whose description or voucher matches this text."),
      ...branch,
      maxRows,
    },
    path: (a) => `/reports/stock-item-report/${a.stockId}`,
    permission: OWNER_ONLY, // JournL only checks sign-in and branch on this route; feature ID not yet confirmed
    toQuery: (a) => ({ startDate: a.startDate, endDate: a.endDate, searchQuery: a.search, ...branchQuery(a) }),
    project: (data, a, truncated) => ({
      totals: pick(data, {
        openingQuantity: "openingQuantity",
        openingValue: "openingAmount",
        inwardQuantity: "totalInwardQuantity",
        inwardValue: "totalInwardAmount",
        outwardQuantity: "totalOutwardQuantity",
        outwardValue: "totalOutwardAmount",
        closingQuantity: "closingTotalQuantity",
        closingRate: "closingRate",
        averageRate: "averageRatePerUnit",
      }),
      entries: rows(data?.result, a.maxRows, "entries", truncated, (e) =>
        pick(e, {
          date: "voucherDate",
          voucherType: "voucherType",
          voucherNo: "voucherNo",
          quantity: "quantity",
          rate: "ratePer",
          amount: "totalAmount",
          closingQuantity: "closingQuantity",
          closingValue: "closingAmount",
        }),
      ),
    }),
    summarize: (a) => `Stock statement for item ${a.stockId}, ${a.startDate} to ${a.endDate}.`,
  });
}
