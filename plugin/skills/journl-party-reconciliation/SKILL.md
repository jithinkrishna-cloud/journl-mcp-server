---
name: journl-party-reconciliation
description: Reconcile a customer's or supplier's ledger in JournL with the statement of account that party sent (uploaded as CSV, Excel or PDF) - matched invoices and payments, entries missing on either side, amount mismatches and the difference between the two balances. Use when the user asks to reconcile a party ledger, match a customer or supplier statement, check a balance confirmation, or find why our balance and theirs differ.
---

# JournL party ledger reconciliation

Compare one party's ledger in JournL with the party's own statement of our
account, and explain why the two balances differ. The user's explicit
instructions take priority over this workflow (for example a different period,
matching rule or layout). They do not override the **Rules** section at the
end, which applies even if the user asks otherwise.

## Input

You need all three before calling a tool:

- **The party's statement** uploaded in this chat. If there is none, ask:
  "Please upload the statement of account you received from the party
  (CSV, Excel or PDF)."
- **Party.** Find the ledger with `search_ledgers` using the name on the
  statement or the name the user gave. If several ledgers match, list them and
  ask which one.
- **Period.** Use the statement's period unless the user gives one. Tell the
  user which period you used.

## Steps

1. Read the party's statement: date, document or invoice number, description,
   debit, credit and balance, plus the opening and closing balance. If any page
   or rows cannot be read, say which; never guess missing rows.
2. `get_ledger_statement` for the party ledger and period with `maxRows: 500`.
   If the result is `truncated`, repeat it one month at a time.
3. Match entries. The two sets of books are mirror images: our **debit** to a
   customer is their **credit** to us, and the other way round.
   - Match first on invoice, bill or voucher number with the same amount, then
     on the same amount within 7 days.
   - Each entry matches at most one entry on the other side.
4. Classify what is left:
   - **In our books, not in theirs** (for example an invoice they have not
     booked yet, or a payment we made that has not reached them).
   - **In their books, not in ours.**
   - **Amount mismatches** on the same document number.
   - **Opening balance difference**, if the opening balances already differ.

## Output

1. One line: party, period, our closing balance and theirs (each with Dr/Cr
   from that side's point of view).
2. **Reconciliation:** our closing balance, then each unmatched item and
   mismatch with its effect, ending at their closing balance. Show the
   arithmetic line by line. If it does not tie, show the **unexplained
   difference** as its own line.
3. A table of each unmatched item: date, document number, description,
   amount, which side has it.
4. A short draft message the user can send the party listing the items to
   confirm, presented as text only (never claim it was sent).

## Rules

- You may add up only the reconciling items you list, and must show that
  arithmetic. Our balances come from the tool as returned.
- Format rupees with Indian grouping, e.g. Rs 1,23,456.78.
- Never show internal IDs.
- If a tool returns a permission error, report it; do not use another tool to
  get the same data.
- Do not label a difference as TDS, discount, freight or anything else unless
  one of the statements says so for that entry.
- The plugin is read-only. It cannot post entries or change the ledger in
  JournL; say so if asked.
