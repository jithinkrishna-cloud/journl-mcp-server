---
name: journl-bank-reconciliation
description: Reconcile a JournL bank ledger with a bank statement the user uploads (CSV, Excel or PDF) and prepare a bank reconciliation statement (BRS) - matched entries, cheques issued but not presented, deposits not yet credited, bank charges or credits not in the books, and any unexplained difference. Use when the user asks for a bank reconciliation, BRS, or to match their bank statement with JournL.
---

# JournL bank reconciliation

Compare one bank ledger in JournL with the bank's own statement and explain
the difference between the two balances. The user's explicit instructions take
priority over this workflow (for example a different period, matching rule or
layout). They do not override the **Rules** section at the end, which applies
even if the user asks otherwise.

## Input

You need all three before calling a tool:

- **Bank statement file** uploaded in this chat. If there is none, ask:
  "Please upload the bank statement for this period (CSV, Excel or PDF)."
- **Bank ledger.** If the user named the bank, find it with `search_ledgers`
  (`scope: "bank"`). If several ledgers match or none was named, list the bank
  ledger names and ask which one.
- **Period.** Use the first and last transaction dates on the statement unless
  the user gives a period. Tell the user which period you used.

## Steps

1. Read the statement: date, description, reference or cheque number,
   withdrawal, deposit and balance columns, plus the closing balance. If any
   page or rows cannot be read, say which and continue only with what you could
   read; never guess missing rows.
2. `get_ledger_statement` for the bank ledger and period with `maxRows: 500`.
   If the result is `truncated`, repeat it one month at a time so every
   transaction is covered.
3. Match each book entry to at most one statement row:
   - In the books, a **debit** to the bank ledger is money in (a statement
     **deposit**); a **credit** is money out (a statement **withdrawal**).
   - Match first on cheque or reference number with the same amount, then on
     the same amount within 7 days. When several rows could match, pick the
     closest date and mention the ambiguity.
4. Classify everything left over:
   - **Cheques/payments issued, not yet presented:** book credits with no
     statement withdrawal.
   - **Deposits not yet credited:** book debits with no statement deposit.
   - **In the bank, not in the books:** statement rows with no book entry
     (bank charges, interest, direct credits, failed payments).
   - **Amount mismatches:** same reference or date, different amount.

## Output

1. One line: bank ledger, period, how many entries matched out of how many
   on each side.
2. **Bank reconciliation statement:**
   - Balance as per books: the running balance on the last transaction of the
     period from `get_ledger_statement` (Dr means money in the bank).
   - Add cheques issued not presented; less deposits not credited; add or less
     items in the bank not in the books.
   - = Balance as per bank statement (closing balance on the file).
   - Show this arithmetic line by line. If it does not tie, show the
     **unexplained difference** as its own line; do not force it to zero.
3. A table of each unmatched item: date, description or voucher, reference,
   amount, category.
4. **Suggested entries** for bank-only items (for example bank charges), as
   suggestions the user can post in JournL, clearly labelled as not done.

## Rules

- You may add up only the reconciling items you list, and must show that
  arithmetic. Book totals and balances come from the tool as returned.
- Format rupees with Indian grouping, e.g. Rs 1,23,456.78.
- Never show internal IDs. Show bank account numbers from the file with only
  the last four digits.
- If a tool returns a permission error, report it; do not use another tool to
  get the same data.
- Do not explain a difference with causes the data does not show (for example
  "probably a duplicate entry") unless both rows are listed as evidence.
- The plugin is read-only. It cannot post entries or mark anything as
  reconciled in JournL; say so if asked.
