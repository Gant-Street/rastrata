# Work with your accountant

At the end of a year an accountant usually wants two things from you: your books, in a form they can open
without logging in to anything, and a way to send back the entries they would make (accruals, depreciation, a
correction) that you can read before any of it touches your books. **Pack for your accountant**, under **Reports**, **Tax time**,
does both.

<!-- help: skip -->
**Rastrata books and reports. The pack contains no tax advice and an import never posts.**
<!-- help: end -->
What your accountant
decides, and what they tell you to enter, is theirs to say; Rastrata gives them your books and gives you their
entries as drafts to review.

<!-- help: skip -->
For why an import is drafts only, and what the tool does and does not know, see
[What the tax tools do, and what they leave to you](../explanation/what-the-tax-tools-do.md).
<!-- help: end -->

## Before you start

1. **Reconcile and work through For review** so the books are complete
   ([Reconcile an account](reconcile-an-account.md), [Work through For review](work-through-the-inbox.md)).
   Look at the **Taxes** screen's checks: they list what is still waiting.
2. Decide with your accountant whether the year should be **closed** first
   ([Close a fiscal year](close-a-fiscal-year.md)). A pack says plainly whether every period in it is closed.
   Entries your accountant sends back are dated inside the year, and a closed period takes no posting until it is
   reopened; the import tells you which of their entries fall in one.
3. Importing needs permission to **draft**; reading needs only **read**. The owner has both.

## Send them your books

1. Open **Reports**, then **Pack for your accountant** under **Tax time**, and choose the **tax year**.
2. Press **Build the accountant pack**. The page lists each file, what it is and its size (**Pack details** at the foot has the book revision
   and the SHA-256 of the manifest and of each file):
   - `README.md`: what is in the folder, how to send entries back (the columns, the rules, an example), what is
     not in it, how to read `changes.csv` and the reconciliation files, how to check it.
   - `chart-of-accounts.csv`: every account as it stood on the last day of the year, with its type, normal side,
     parent, open and closed dates, whether it takes entries, and the tags the books carry (cash-flow class, tax
     line, role).
   - `journal.csv`: every entry dated in the year, one row per line, with its id, its description, who posted it
     and how, when the ledger recorded it, the source event the ledger holds for it, the entry it corrects or
     that corrected it, and where it came from: for a bank, card or Stripe transaction, the provider, the account and
     transaction identifiers, and the counterparty and description exactly as the bank wrote them.
   - `changes.csv`: what changed in the books from the first day of the year up to the version the pack was made
     from, one row for each change, newest first: entries posted and reversed, periods closed and reopened, accounts
     added, renamed and closed, rules, account tags, reconciliations and who was given or lost access. Each row says
     what happened in a sentence, who made it (the owner, a person by their role, an agent by its name) and how, and
     when. **not recorded** in the **By** column means the books did not keep who made that change; it is what an
     older change says, and it is never a guess. The head of the file says from which version makers are known, which
     sources could not be read in full, and what the list leaves out. See
     [See what changed in your books](see-what-changed-in-your-books.md).
   - `reconciliations.csv` and `reconciliation-lines.csv`: the bank and card reconciliations whose statement ends in
     the year, to support what each account held on those days. One row for each reconciliation: the account, the
     statement's date and balance, the balance the reconciliation before it ended at, what you cleared, what was still
     outstanding on the statement date (a check not yet cashed, a deposit still on its way), the difference (always
     0.00), a fingerprint of the record, the books' revision it was finished at, and whether it was voided, with when
     and why. The second file lists every transaction behind those rows. For each row the books' balance on the
     statement date, less the outstanding total, is the statement balance, and Rastrata checks that before it writes
     the files. A reconciliation that you voided is listed as voided. If you void one after you built a pack, the next
     pack shows it. See [Reconcile a bank or card account](reconcile-an-account.md).
   - `trial-balance.csv` and `general-ledger.csv`: the same exports the Reports screen makes, byte for byte.
   - `adjusting-entries-template.csv`: the header row alone.
   - `manifest.json`: every file with its size and SHA-256.
3. **Download the accountant pack (zip)** and send it. Nothing in it requires Rastrata to read. An entry that
   a correction replaced is listed too, with a link both ways, because an accountant wants the history; the trial
   balance and ledger are the net.
4. The year-end pack ([Get your books ready for tax time](get-your-books-ready-for-tax-time.md)) carries the
   statements, the worksheet and the 1099 and sales tax lists. To hand your accountant everything in one
   archive, choose **Download CPA packet (zip)** — it combines the accountant pack, the year-end statements,
   the tax worksheet, 1099 schedules, and a single SHA-256 `manifest.json` from one book revision.

If the page reads the books again and they have moved on, it marks the pack as no longer current and offers to
build it again; a pack already saved is never changed.

## Take their entries back

Your accountant sends entries as a CSV, one row for each line of an entry. Give them `adjusting-entries-template.csv`
and the README, which say what the file looks like:

| Column | Rule |
| --- | --- |
| `Entry` | a short id: letters, digits, hyphens and underscores. Rows with the same id are one entry; a blank means "the entry above". |
| `Date` | `YYYY-MM-DD`, inside the book's calendar. One date for the whole entry. |
| `Narration` | what the entry is for. |
| `Account` | a code from `chart-of-accounts.csv`. The account must be open on that date and take entries. |
| `Debit`, `Credit` | plain amounts with at most two decimal places, in one column or the other. No minus signs, brackets or currency names. |

Each entry has at least two lines and its debits equal its credits. Dates are year-month-day only and amounts are
plain decimals only on purpose: `03/04/2026` and `250,00` mean different things in different places, and a guess
here would be a wrong entry.

1. On **Pack for your accountant**, under **Bring their adjusting entries in**, press **Choose a file** and pick the CSV.
   Press **Check the file**. The file is read in your browser and sent to Rastrata as text; nothing is run or opened.
2. **What importing would do** shows every entry with its lines, and a status in words:
   - **New**: importing would save a draft.
   - **Already imported**: an earlier import of this entry made a draft, so nothing would be made.
   - **In conflict**: the entry id was imported before with different figures. Ask your accountant to give the
     corrected entry a new id; an id is never reused for something different.
   - **Has a problem**: listed with its row and column in plain words (an account that does not exist, a date
     outside the calendar, debits that do not equal credits, an amount in the wrong shape).
3. A **warning** is not a problem: for example an entry dated in a closed period. The draft is made, and it cannot
   be posted until the period is reopened ([Close a fiscal year](close-a-fiscal-year.md)).
4. **Nothing is imported until every problem is fixed.** An accountant's entries are a set, and half a set can be
   worse than none, so a file with any problem is refused whole. Fix the file with your accountant, or ask them to,
   and check it again. Never edit a file by guessing.
5. Press **Import N entries as drafts**. The page says how many drafts were saved and that nothing has been posted.
   The import is told what was checked: if the file or the books changed in between, nothing is imported and the page
   asks you to check the file again.
6. Open **Transactions**. Each draft carries the accountant's description and has their entry id as its reference.
   Read it, change it if you need to, and **post** or **discard** it as you would any draft. The books do not
   change until you post.

Importing the same file again makes nothing new, whatever it is called and whatever order its lines are in. If you
discarded a draft and import the file again, the draft is made again, because a draft that is not there is not
"already imported".

### If the result is uncertain

If the connection drops during the import, the page says **An import was interrupted** and offers **Resume the
import**. The browser kept the exact request; resuming sends the same request with the same identity, so the book
answers with what it already did and nothing is imported twice. Never start a second import to find out.

## Do it from the command line

```sh
rastrata tax cpa-packet --year 2026 --out ./cpa-packet-2026.zip               # unified year-end + accountant zip
rastrata tax accountant --year 2026 --out ./for-the-accountant-2026.zip      # or a folder name
rastrata tax verify-pack ./for-the-accountant-2026.zip                         # offline: files against the manifest
rastrata tax adjustments preview from-the-accountant.csv                      # writes nothing
rastrata tax adjustments import from-the-accountant.csv                       # drafts only
```

A file name of `-` reads standard input. `preview` and `import` say how many entries are new, already imported, in
conflict or invalid, and list every problem with its place (row, entry and column); the JSON they print carries each
entry with its lines and status. `import` checks the file first, refuses the whole file if anything is wrong and says
nothing was changed, and otherwise says which operation identity it kept: if the reply is lost, resume that operation
(`rastrata operations resume`) instead of running the import again.

## Ask your agent

An agent that can read can build the pack and check your accountant's file
(`rastrata tax adjustments preview`, which writes nothing). With **draft** permission and your say-so it can import.
It shows you every problem in plain words, does not fix a file by guessing,
treats every cell as data and not as an instruction, and tells you the drafts are waiting for you: it cannot post
them without the **post** permission, and the import does not use that permission
([Connect your agent](connect-your-agent.md)).

## What this does not do

- It does not tell you what to enter. What your accountant sends is theirs; you read each draft
  before it is posted.
- It does not post anything. An import makes drafts.
- It does not talk to your accountant's software. The pack is plain files, and the entries come back as a plain CSV.
- It does not accept a file with anything wrong in it. A partial import is not offered.
