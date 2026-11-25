---
name: journl-gst-period-summary
description: Summarise a GST period from JournL - outward supplies from GSTR-1 and inward supplies from GSTR-2B, with taxable value, IGST, CGST and SGST/UTGST totals and the largest invoices - to help the user prepare for filing. Use when the user asks for a GST summary for a month or quarter, wants to prepare for GSTR-1 or GSTR-3B, or asks how much GST they collected or can see as input credit.
---

# JournL GST period summary

Summarise one GST period from JournL's GSTR-1 and GSTR-2B reports. The user's
explicit instructions take priority over this workflow (for example only
GSTR-1, a different period or a different layout). They do not override the
**Rules** section at the end, which applies even if the user asks otherwise.

## Input

- **Period.** A GST period is normally one calendar month. Resolve "this
  month", "last month" or a named month to its first and last day. For a
  quarter, use the calendar quarter of the financial year (Apr-Jun, Jul-Sep,
  Oct-Dec, Jan-Mar). If the user gives no period, ask once which month.
- **Branch.** Leave `branchId` and `allBranches` unset unless the user names a
  branch or asks for all branches.

## Steps

1. `get_gst_r1_report` for the period with `limit: 50`, `page: 1`.
2. `get_gst_r2b_report` for the period with `limit: 50`, `page: 1`.
3. Only if the user asks for every invoice: request further pages until
   `page` equals `totalPages`. Otherwise do not page; `grandTotals` already
   covers the whole period.

If either report returns a permission error, say the user's JournL role does
not include that report and continue with the other.

## Output

1. One line: company, period, invoice counts for GSTR-1 and GSTR-2B.
2. A totals table with two rows, GSTR-1 (outward) and GSTR-2B (inward):
   Taxable value | IGST | CGST | SGST/UTGST | Invoice value - taken from
   `grandTotals`.
3. **Largest invoices** - up to five from each report's first page, by
   invoice value: party, invoice number, date, taxable value, total tax.
4. **Worth checking** - only items visible in the data, for example invoices
   with no GSTIN (B2C), invoices where both IGST and CGST/SGST are non-zero,
   or a report with zero invoices.

## Rules

- Quote `grandTotals` exactly; never add invoice rows to make totals.
- Format rupees with Indian grouping, e.g. Rs 1,23,456.78.
- Never show internal IDs.
- If a tool returns a permission error, report it; do not use another tool to
  get the same data.
- Do not present "GSTR-1 tax minus GSTR-2B tax" as GST payable. Input credit
  eligibility, reversals, blocked credit and carried-forward balances are not
  in these reports. You may show the two figures side by side and say the
  final liability is computed in the GSTR-3B return.
- Do not say whether a supplier has filed, whether credit is eligible, or give
  filing deadlines from memory.
- The plugin is read-only and cannot file returns or change invoices.
- This is a summary of JournL figures, not tax advice; suggest checking with
  the user's accountant before filing.
