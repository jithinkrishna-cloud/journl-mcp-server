---
name: journl-month-end-review
description: Review a JournL company's books for a month, quarter or financial year and flag what needs attention before closing - profit, balance sheet and trial balance checks, overdue receivables and payables, cash movement and GST totals. Use when the user asks for a month-end or period-end review, a books health check, "are my books in order", or "what should I look at before closing the month".
---

# JournL month-end review

Produce a short, checked review of one period of the signed-in company's books,
using only the read-only JournL tools. The user's explicit instructions take
priority over this workflow: if they ask for fewer sections, a different period
or a different format, do that. They do not override the **Rules** section at
the end, which applies even if the user asks otherwise.

## Input

- **Period.** Resolve it to `startDate` and `endDate` (YYYY-MM-DD).
  - "this month" / "last month" / a named month: first to last day of that month.
    If the month is not over yet, end on today.
  - "this quarter": Indian financial quarters (Apr-Jun, Jul-Sep, Oct-Dec, Jan-Mar).
  - "this year" / "FY": the Indian financial year, 1 April to 31 March.
  - If the user gives no period at all, ask once: "Which period should I review -
    last month, this month so far, or the financial year to date?" Do not guess.
- **Branch.** Leave `branchId` and `allBranches` unset unless the user names a
  branch or asks for all branches.

## Steps

Call the tools in this order. If a tool returns an error, note the section as
unavailable and continue with the next step; do not retry with other
parameters to get around a permission error.

1. `get_business_summary` for the period - headline position and compliance.
2. `get_profit_and_loss` for the period - total income, total expense, net
   profit or loss.
3. `get_balance_sheet` with the same `startDate` and `endDate` - check that
   `totals.difference` is zero.
4. `get_trial_balance` for the period - check `totals.balanced`.
5. `get_ageing_report` with `type: "receivable"` and `endDate` = period end.
6. `get_ageing_report` with `type: "payable"` and `endDate` = period end.
7. `get_cash_flow` for the period - opening balance, net cash flow, closing
   balance.
8. `get_gst_r1_report` and `get_gst_r2b_report` for the period with `limit: 1`
   - you only need `grandTotals` and `totalInvoices`, not the invoice pages.

Skip steps 5-8 if the user asked only for a quick check.

## What to flag

Raise a flag only when the tool data shows it:

- Balance sheet `difference` is not zero.
- Trial balance `balanced` is false.
- Net loss for the period.
- Receivables or payables with a non-zero `days90plus` - name the top three
  parties from `parties` (already sorted by outstanding).
- Closing cash and bank balance below zero, or a bank overdraft balance.
- Sections listed in `restrictedSections`, or tools that returned a permission
  error - say the user's JournL role does not include that report.
- Any `truncated` list - say the list was shortened.

Do not flag anything you would have to infer, such as missing entries,
unreconciled bank statements, depreciation not booked or GST mismatches between
specific invoices. You may suggest the user check those in JournL.

## Output

Reply with:

1. One line: company name, period, and an overall verdict ("No issues found",
   or "N items need attention").
2. **Needs attention** - the flags above, most serious first, one line each with
   the figure that triggered it.
3. **Key figures** - a compact table: income, expense, net profit/loss, total
   assets, receivables outstanding (and 90+), payables outstanding (and 90+),
   net cash flow, closing cash and bank, GSTR-1 taxable value and tax,
   GSTR-2B taxable value and tax.
4. **Suggested next steps** - at most three, each something the user can do or
   check in JournL.

## Rules

- Quote amounts exactly as the tools return them; use the tool totals and never
  add up rows yourself. Format rupees with Indian grouping, e.g. Rs 1,23,456.78.
- Never show internal IDs (ledger, group, voucher, stock or profile IDs).
- If a tool returns a permission error, report it; do not use another tool to
  get the same data.
- Do not explain a difference or flag with causes the data does not show (for
  example missing entries), even if the user suggests one. Say what the data
  shows and suggest checking in JournL.
- Do not compare GSTR-1 tax with GSTR-2B tax as a payable GST liability; they
  are reported separately and the actual liability depends on the return.
- The plugin is read-only. If the user asks to post an adjusting entry or fix
  something, explain that JournL for ChatGPT cannot change records and that the
  entry must be made in JournL.
- This is a review of figures, not tax or audit advice.
