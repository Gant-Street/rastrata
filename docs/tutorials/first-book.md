# Your first local book

This tutorial creates one durable development book, posts three journals, checks
the statements, and reverses an expense. It uses only the browser. Authentication
and production hosting are outside this local workflow.

From the repository root, install dependencies with `bun ci`, then start the application service and frontend in separate terminals:

```sh
bun run dev:api
RASTRATA_API_URL=http://127.0.0.1:4010 bun run dev:web
```

Open `http://127.0.0.1:4000`. The development server binds to loopback. It stores
the book in `apps/web/.local/book.sqlite`; set `RASTRATA_LOCAL_DB` to an absolute
path before starting if you want a separate book. Restarting the server with the
same path reopens the same book.

1. On **Home**, enter `Example Co`, `USD`, and fiscal year `2026`. Review the
   displayed starting chart: Cash (`1000`), Owner capital (`3000`), Revenue
   (`4000`), and Expense (`5000`). Choose **Create book**. Setup creates an open,
   zero-balance book once; revisiting the page does not reseed it.
2. Open the opening-balances form at `/journal/new?opening=1` (on a new book's Home,
   **Bring in your books** leads to the guided screen for the same job). Set the date to `2026-01-15`.
   Enter Cash debit `1000.00` and Owner capital credit `1000.00`: the bar at the foot of the
   form shows the totals and says **Balanced**. Choose **Post**.
   The owner capital line is the visible offset. This is a
   balanced, traceable journal rather than a direct balance edit.
3. Open **Transactions**, choose **New journal entry** and create another entry dated `2026-01-16`.
   Describe it `Sale`, give it the reference `REV-1`, and enter Cash debit `200.00` and
   Revenue credit `200.00`. Choose **Save draft**. Return to **Transactions**, open `REV-1`
   under **Saved drafts**, and choose **Post**. Drafts do not affect balances before posting.
4. Create an expense dated `2026-01-16`: describe it, give it the reference `EXP-1`, and enter
   Expense debit `50.00` and Cash credit `50.00`. Choose **Post**. An entry with nothing in it
   to read is posted in the same step, and the list opens with a message that names its number; a
   warning or a refusal is shown under the lines, with what to do.
5. Open **Reports**, choose **Profit and loss**, set **Date range** to **Custom**, and choose From `2026-01-01` and To `2026-01-31`. Cash is `1150.00`,
   profit and loss shows net income `150.00`, and the balance sheet has assets
   `1150.00` and equity including current earnings `1150.00`. The trial balance
   totals tie. Choose the Cash row to see its dated, running-balance ledger, and
   choose a posting line to inspect the complete pinned journal. Under each
   report, **Report details** holds its book revision and fingerprint; CSV exports include them.
6. Return to **Transactions**, open the menu at the end of the `EXP-1` row (or open the
   entry and use its **Reverse** button) and choose **Reverse**. Enter `2026-01-17`
   and a reason, then choose **Reverse transaction**. The reversal is posted in the
   same step, and both entries remain visible and linked ("Reversed by No. 4",
   "Reverses No. 3"). Reports as of `2026-01-31` now show Cash `1200.00`
   and net income `200.00`.
7. In **Accounts**, choose **New account** to add a zero-balance account, or
   open a kind of the chart, choose an account's name, and under **Account details**
   choose **Edit account** to rename or close it. Account changes are prospective: the date they start is under
   **Advanced**, and it must be after the latest posted journal. The chart is one
   line a kind with its total; an open kind lists its accounts by name and balance,
   and counts the ones with nothing in them under it. A nonzero account cannot be closed. The form says what it
   will do ("This adds 1100 Savings as a Bank account, starting ...") and its
   button does it: there is no separate review. Choose an account's name to see its
   transactions with a running balance, for a range you choose; **Account details**
   under them has its code and type, and **Export**.
8. In **Close the books**, one card says "Through January 2026" and lists what is
   left. Do what it asks (a backup that has been checked is one of the lines), then choose
   **Close through January 2026**. The month closes in one step, and the first line says
   "Books are closed through ...". A transaction dated inside a closed month is
   refused, with the month and the way forward. To post one anyway, open **Closed
   months**, choose **Reopen** on January 2026, give a reason and review: the review
   says which later closes it supersedes (see
   [Close a fiscal year](../how-to/close-a-fiscal-year.md)). If another client
   changes the book while an entry is being posted, the posting can be rejected.
   Choose **Recover for editing** to reopen that same draft at a new version, then
   post it again. The original rejected plan and receipt remain inspectable.

If a write loses its response, choose **Resume original request** on its original
workflow page (Home, Journal, Accounts or Periods). The
browser retains its exact request and identity before sending; this recovery also
works after reload for setup, draft edits, posting, reversals, account changes
and period changes. Retention requires browser storage and Web Locks support;
the tested Chromium, Firefox and WebKit engines provide both. A pending or
unresolved posting cannot be copied into another
attempt. **Resolve original posting** inspects and retries its retained command.
Editing entry facts invalidates the displayed review until you request a new one.

Stop the server and start it again with the same database path. Home, the journal,
the account chart, period history, and reports should still reflect the work.

This first app supports one local book, one functional currency, and one fiscal
year with monthly or quarterly periods. It handles manual journals and reversal corrections.
It does not provide authentication, invoicing, bank feeds, tax filing, cash-flow
statements, foreign currency, or production operations. Large-book read models
remain an area for further work. The [core web goal](../reference/core-web-app-goal.md)
records the full milestone and acceptance criteria.
