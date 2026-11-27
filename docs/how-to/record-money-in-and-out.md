# Record money you spent, received or moved

For a payment that is not on a bank statement yet (a cash purchase, a check you handed over, a payment someone made
to you outside your bank), and for money you move between your own accounts. Each one becomes an ordinary entry in
your books, made without writing a debit or a credit.

If the transaction is on a bank statement or in a feed, do not record it here: it arrives in **For review**, and you
accept it there. Recording it in both places counts the payment twice (when the bank line arrives, For review
notices an entry for the same amount and offers to match it, which books nothing new).

## Spend money

1. Choose **+ New**, then **Transaction**. The form opens on **Spend money**; **Receive money** and **Transfer**
   are the other two choices at its top. (From the keyboard: Ctrl+K or Cmd+K, type "spend", Enter.)
2. Fill in:
   - **Date**. It starts at today.
   - **Paid from**: the bank, card or cash account the money came out of. With one bank account it is already chosen.
   - **Category**: what it was for. Type to search; expenses come first.
   - **Amount**: dollars and cents. "25" is 25.00. A minus sign is refused: money out is what Spend money means.
   - **Paid to** and **Description** are optional. They are what the Transactions list shows.
3. Read the line **This will record**. For $25 of software paid from checking it says "Software and subscriptions
   +25.00, Business checking -25.00": each account's balance, going up or down. It is the entry, in plain words.
4. **Post** records it. **Save draft** keeps it without changing your books; it waits in Transactions, where you can
   open it and post it later. **Cancel** closes the dialog and records nothing.

## Receive money

The same, with **Deposit to** (the bank account the money went into) and **Category** (where it came from: income
comes first). **Received from** is optional.

## Transfer

**From** and **To** are two accounts of your own: checking to savings, or checking to a credit card to pay it. There
is no category, because nothing was earned or spent.

## Two common cases for an owner

If you are a sole proprietor, two choices are one click:

- **Owner took money out** (in Spend money) records it against your owner's draw account. It is not an expense, so it
  does not lower your profit.
- **Owner put money in** (in Receive money) records it against your owner's investment account. It is not income.

Rastrata finds the account by its name (a draw, a distribution, an investment, a contribution). If your chart has none
it says so and you choose the account yourself.

## When the books say no

- A date in a month you have **closed** is refused, with the month named. Reopen it on Close the books, post, and close
  it again.
- A date after the end of your calendar posts as usual: the calendar grows to hold it, and Changes says so. A
  date before the day your books began cannot be posted; the message names the earliest day.
- If the connection drops while you post, the dialog says the request may not have finished and offers **Resume
  original request**. Nothing is recorded twice, even if you reload the page first.

## Take it back

An entry made here is an ordinary entry. To take it back, reverse it from Transactions: the original and its reversal
both stay in your books. Transactions that came from a bank statement or a feed have **Undo** in For review (see
[Work through For review](work-through-the-inbox.md#undo)).

## From the terminal or an agent

An entry is the same two-line draft, prepared and committed: `rastrata drafts create`, `journal prepare`, then
`operations commit` (see [Set up your books](set-up-your-books.md)). There is no separate command for Spend money.
