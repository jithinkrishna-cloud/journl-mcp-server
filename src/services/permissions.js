// JournL feature IDs (from JournL's permissionMiddleware / dashboard catalogue).
//
// Most report routes are permission-checked by JournL itself. Some read routes only
// check that the user is signed in. For those, this server requires the matching
// feature's `view` right for company users, so connecting ChatGPT never shows a user
// more than JournL's own screens would. Company owners (role "company") have full access,
// exactly as in JournL.

export const FEATURE = Object.freeze({
  GENERAL_LEDGER: 2,
  PROFIT_LOSS: 22,
  BALANCE_SHEET: 23,
  DAY_BOOK: 24,
  LEDGER_STATEMENT: 26,
  CLOSING_STOCK: 28,
  GROUP_SUMMARY: 38,
  CASH_FLOW: 48,
  // Permission IDs, not the plan-quota IDs that JournL's featureLimitMiddleware uses (5 / 14).
  SALES: 14,
  PURCHASE: 16,
});

/**
 * For routes JournL leaves unchecked when no JournL feature ID is confirmed for the data.
 * Fails closed: company users are refused until the right feature ID is known.
 */
export const OWNER_ONLY = "owner-only";

/**
 * @param {object} session  signed-in session
 * @param {number[] | typeof OWNER_ONLY} rule  feature IDs (any one with view=true grants access)
 * @returns {string | null} a reason when access is denied, otherwise null
 */
export function denyReason(session, rule) {
  if (session.role === "company") return null;
  if (rule === OWNER_ONLY) return "This report is currently available only to the company owner through ChatGPT.";
  const allowed = session.permissions.some((p) => rule.includes(Number(p.featureId)) && p.view === true);
  return allowed ? null : "Your JournL role does not have view permission for this report. Ask your company admin for access.";
}

/**
 * JournL's create-voucher route checks no permission at all, so this server requires
 * the feature's `add` right for company users before creating anything.
 *
 * @param {object} session  signed-in session
 * @param {number} featureId  feature the new record belongs to (FEATURE.SALES, FEATURE.PURCHASE)
 * @returns {string | null} a reason when access is denied, otherwise null
 */
export function denyAddReason(session, featureId) {
  if (session.role === "company") return null;
  const allowed = session.permissions.some((p) => Number(p.featureId) === featureId && p.add === true);
  return allowed ? null : "Your JournL role does not have permission to add these invoices. Ask your company admin for access.";
}
