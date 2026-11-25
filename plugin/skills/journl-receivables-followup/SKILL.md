---
name: journl-receivables-followup
description: Build a prioritised collections list from JournL - which customers owe money, how overdue it is, how they usually pay, and who to chase first - and optionally draft polite payment reminders for the user to send. Use when the user asks who to follow up for payment, wants to chase overdue customers, plan collections, or draft payment reminders. For a plain "who owes us money" list, the get_ageing_report tool alone is enough.
---

# JournL receivables follow-up

Turn JournL's receivables data into a short, ranked follow-up list. The user's
explicit instructions take priority over this workflow (for example a different
ranking, a single customer, or no drafts). They do not override the **Rules**
section at the end, which applies even if the user asks otherwise.

## Input

- **As-of date.** Default to today. Use the user's date if they give one.
- **Scope.** All customers by default. If the user names a customer, focus on
  that customer only.
- **Minimum age.** Default: include every party with an outstanding amount. If
  the user says "overdue" without a number, treat it as more than 30 days.

## Steps

1. `get_ageing_report` with `type: "receivable"` and `endDate` = as-of date.
   Use `parties` for per-customer totals and `totals` for the company total.
   If `parties` is empty, say no receivables are outstanding and stop.
2. `get_customer_insights` with `type: "payment_behaviour"` to get each
   customer's average payment days. If it returns a permission error, continue
   without it and say payment history was not available.
3. Only if the user names one customer or asks for details: `search_ledgers`
   with that name, then `get_ledger_statement` for that ledger from the start of
   the financial year (1 April) to the as-of date, to show recent receipts.
   If several ledgers match, ask which one.

## Ranking

Rank customers by, in order:

1. Amount in `days90plus`, then `days61to90`, then `days31to60`.
2. Total `outstanding`.
3. Slower `averagePaymentDays` first.

Assign a priority: **High** if anything is 90+ days, **Medium** if anything is
61-90 days, otherwise **Low**.

## Output

1. One line: company receivables total as of the date, and how much is 90+ days.
2. A table, highest priority first (at most 15 rows unless asked):
   Priority | Customer | Outstanding | 0-30 | 31-60 | 61-90 | 90+ | Avg days to pay.
3. If the ageing report was `truncated`, say the list was shortened.
4. If the user asked for reminders, draft one short, polite message per
   customer they choose, stating the outstanding amount and oldest bill
   numbers from the `bills` list. Present drafts as text for the user to send;
   do not claim they were sent.

## Rules

- Use the tool totals; never add bills up yourself.
- Format rupees with Indian grouping, e.g. Rs 1,23,456.78.
- Never show internal IDs. Do not invent contact details, due dates or reasons
  for non-payment.
- If a tool returns a permission error, report it; do not use another tool to
  get the same data.
- Do not draft threatening or legal-notice language unless the user explicitly
  asks, and even then keep it factual.
- The plugin is read-only: it cannot record receipts, send emails or change
  bills. If asked, explain that this must be done in JournL.
