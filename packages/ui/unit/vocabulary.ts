/** The vocabulary of the application, as data: the words a person reads on every screen, and the old
 * words that must not come back. `glossary.test.ts` reads it and fails the build when a string a person
 * reads says one of them, the way `format-guard.test.ts` fails a figure that formats itself.
 *
 * The law is the plan's "One vocabulary" table (docs/reference/ux-rework-plan.md): the words of Xero and
 * QuickBooks (For review, Transactions, Chart of accounts, Close the books, Spend money), and no machine
 * detail on the surface. The CLI, the API, the MCP text and the explanation pages keep their own names
 * and are not read here: only `packages/ui/src` and `apps/web/src` are. Kept as they are: Reconcile,
 * Rules, Reverse, Posted, Ready to post, Excluded, Draft, Close, Reopen.
 *
 * To say a banned word where it is right, add an `unless` pattern to its rule (a context that makes the
 * word right everywhere), or an exemption below (one file, and one string if you can) with the reason.
 * An exemption that no longer matches anything fails too, so the list can only get shorter. */

export interface Rule {
  /** A short name, used in messages and in exemptions. */
  readonly id: string;
  /** What the application says now. */
  readonly say: string;
  /** What it said, as a person would have read it. */
  readonly was: string;
  /** The words or patterns that fail in a string a person reads. */
  readonly banned: readonly RegExp[];
  /** Contexts in which a banned pattern is right: a string that matches any of these passes. */
  readonly unless?: readonly RegExp[];
  /** Where the rule applies, as paths, path prefixes (ending in "/") or patterns from the repository root; left
   * out, everywhere. A word that is only wrong as the name of a screen (a label in the navigation) applies to
   * the files that name the screens. */
  readonly in?: readonly (string | RegExp)[];
}

/** The files that name the application's screens: the router, the core routes and each lane's registration. */
export const screenNames: readonly (string | RegExp)[] = [
  "apps/web/src/router.tsx",
  "apps/web/src/nav.ts",
  "apps/web/src/routes/registry.ts",
  "apps/web/src/routes/core.ts",
  /^apps\/web\/src\/routes\/[^/]+\/index\.ts$/,
];

export const rules: readonly Rule[] = [
  {
    // The founder, 2026-10-29: nothing a person reads is about building Rastrata. The development API and the
    // scripts of this repository are for whoever works on it, never words of the product.
    id: "development",
    say: "nothing: the product never speaks of a development build",
    was: "Local development application, bun run dev:mcp, RASTRATA_OWNER_KEY_FILE",
    banned: [
      /\bdevelopment (application|build|server|API|mode)\b/i,
      /\bbun (run|x)\b|\bdev:[a-z]+\b/,
      /\bnot configured\b/i,
      /\bRASTRATA_OWNER_KEY_FILE\b/,
    ],
  },
  {
    id: "inbox",
    say: "For review",
    was: "Inbox",
    banned: [/\binbox\b/i],
  },
  {
    id: "lines",
    say: "transactions",
    was: "lines (bank lines, statement lines, lines to review)",
    banned: [/\blines?\b/i],
    // Some lines are lines: a journal entry has them (a debit or a credit against an account), a tax
    // form has them (Schedule C line 27b), a text can break between them and a command is typed on
    // one. The word is the accountant's or the form's there, and a bank's transaction is never one.
    unless: [
      // A line of an entry: the string says it is about an entry, a debit or a credit.
      /\b(journal|entry|entries|debit|credit|ledger|offset|accounting)\b.*\blines?\b|\blines?\b.*\b(journal|entry|entries|debit|credit|ledger|offset)\b/i,
      /\b(tax|form|schedule \w+)\s+lines?\b/i,
      /\blines? (of|on|in|from) .{0,30}\b(form|return|schedule)\b/i,
      /\b(IRS|form) .*\blines?\b|\blines? .*\b(IRS|the form)\b/,
      /\bline (breaks?|by line|numbers?)\b|\bcommand.line\b|\bone per line\b|\bnew line\b|\bline items?\b/i,
      /^Line\s*$|\bline \{\}|\bline \d|^Add (a )?line$|\bRemove line\b|\bone side of the line\b/i,
    ],
  },
  {
    id: "journal",
    say: "Transactions (the list), entry (one of them)",
    was: "Journal",
    banned: [/\bjournal\b(?!\s+entr)/i],
  },
  {
    id: "narration",
    say: "Description",
    was: "Narration",
    banned: [/\bnarration\b/i],
  },
  {
    id: "accounts-label",
    say: "Chart of accounts",
    was: "Accounts (as the name of the screen)",
    banned: [/^Accounts$/],
    in: screenNames,
  },
  {
    id: "periods-label",
    say: "Close the books",
    was: "Periods (as the name of the screen)",
    banned: [/^Periods$/],
    in: screenNames,
  },
  {
    id: "periods",
    say: "Close the books, month checklist",
    was: "Fiscal periods, Cutover checklist",
    banned: [/\bfiscal periods\b/i, /\bcutover checklist\b/i],
  },
  {
    id: "cutover",
    say: "Start date",
    was: "Cutover date",
    banned: [/\bcutover\b/i],
  },
  {
    id: "opening",
    say: "Opening balances",
    was: "Opening (as the name of the screen)",
    banned: [/^Opening$/],
    in: screenNames,
  },
  {
    id: "source-id",
    say: "Where this entry came from (a disclosure, shown only when the form is opened for a source)",
    was: "Source event, Source ID, Advanced: duplicate protection",
    banned: [/\bsource (event|id)\b/i, /\bduplicate protection\b/i],
  },
  {
    id: "machine-detail",
    say: "Details (a disclosure one click away)",
    was: "Population, Book revision, Chart revision, Fingerprint",
    banned: [
      /\bpopulation( hash)?\b/i,
      /\b(book|chart) revision\b/i,
      /\bfingerprint\b/i,
      /\bat revision\b/i,
    ],
  },
  {
    id: "chart-advanced",
    say: "Advanced (behind a toggle in the chart)",
    was: "Lifecycle, Cash flow class, Role key, Tags in force",
    banned: [/\blifecycle\b/i, /\bcash.flow class\b/i, /\brole keys?\b/i, /\btags in force\b/i],
  },
  {
    id: "gap-log",
    say: "Things to check",
    was: "Gap log",
    banned: [/\bgap log\b/i],
  },
  {
    id: "agent-access",
    say: "Agents",
    was: "Agent access",
    banned: [/\bagent access\b/i],
  },
  {
    id: "bank-feed",
    say: "Bank connection",
    was: "Bank feed",
    banned: [/\bbank feed\b/i],
  },
  {
    id: "book-to",
    say: "Category",
    was: 'Book to accounts, "Book to ..."',
    banned: [/^Book to\b/, /\bBook to accounts\b/i],
  },
  {
    id: "rule-percent",
    say: "Category: Sales, from rule Stripe transfers",
    was: '"Rule 100%"',
    banned: [/\brule \d+%/i],
  },
  {
    id: "iso-date",
    say: "Mar 20, 2026",
    was: "2026-03-20",
    banned: [/\b\d{4}-\d{2}-\d{2}\b/],
  },
  {
    id: "hash",
    say: "nothing: a hash is under Details",
    was: "a 64-character hash in the open",
    banned: [/\b[0-9a-f]{64}\b/i],
  },
  {
    // The founder, 2026-11-22, of "each payout arrives in For review": "You can't just reference UI components in
    // the middle of a sentence, it's really hard to read." A sentence says the thing in plain words; the name of a
    // screen or a control is the text of its link, its button, its tab or its heading, and nowhere else.
    id: "screen-in-sentence",
    say: "the thing in plain words: waiting for review, in your chart of accounts, save again",
    was: "arrives in For review, on the Accounts screen, under Options, press Save",
    banned: [
      // The tab's name inside a sentence, after a preposition or as the subject of one.
      /\b(in|into|on|from|under|at|through|of|out of) For review\b/,
      /\b(goes|go|went|sent|moved|back) to For review\b/,
      /^For review (could|is|has|needs|was|will)\b/,
      /\bFor review\b.+\.$/,
      // A screen named as a screen.
      /\b(on|from|in|under|to) (the )?[A-Z][A-Za-z ]{2,24} (screen|page|tab)\b/,
      // A fold or a place of Settings pointed at.
      /\bunder (Options|Advanced|Settings|Report details)\b/,
      /\b(in|from) Settings, [A-Z]/,
      // A place named after a lower-case preposition, in the middle of a sentence.
      /\b(from|on|in) (Home|Transactions|Accounts|Reports|Rules|Changes|Reconcile|Members|Agents|Billing)\b/,
      // A button named in a sentence.
      /\b(press|click|tap|choose|select) (the )?[“"][A-Z]/,
      /\b(press|click|tap) (the )?(Save|Accept|Post|Connect|Sync now|Read now|Resume|Finish|Continue|Done|Undo)\b/,
    ],
    unless: [
      // The label of a link or a button, standing alone: a verb and the place, with no sentence around it.
      /^(Open|Back to|Go to|Review|See|Show|Work through) [A-Z][A-Za-z ]{1,30}$/,
    ],
  },
  {
    id: "us-spelling",
    say: "American English: categorize, color, behavior, itemized, check",
    was: "categorise, colour, behaviour, itemised, cheque",
    banned: [
      /\b(categoris|organis|recognis|itemis|summaris|authoris|finalis|customis)(e|es|ed|ing|ation)\b/i,
      /\b(colour|behaviour|favour|honour|cheque|centre|licence|judgement|catalogue|programme)s?\b/i,
      /\b(cancelled|labelled|travelled)\b/i,
    ],
  },
];

export interface Exemption {
  /** The rule's id. */
  readonly rule: string;
  /** The file, relative to the repository root; a trailing "/" means every file under it. */
  readonly file: string;
  /** Part of the string; left out, every string of the file that breaks the rule. */
  readonly text?: string;
  readonly reason: string;
  /** Set when the string is waiting for a lane to rebuild its screen and is not right: the lane that
   * will remove it. A pending exemption is a debt, and the test names it. */
  readonly pending?: string;
}

export const exemptions: readonly Exemption[] = [
  // Where the old word is right.
  {
    rule: "accounts-label",
    file: "apps/web/src/nav.ts",
    text: "Accounts",
    reason:
      "the name of the place, one of the four the founder ruled on 2026-11-11 (Home, Transactions, Accounts, Reports); the list of categories on it is still the Chart of accounts",
  },
  {
    rule: "accounts-label",
    file: "apps/web/src/routes/core.ts",
    text: "Accounts",
    reason:
      "the place is one page since step 4 of the plan of 2026-11-11 (the bank and card accounts, then the Chart of accounts as its second section), so the page carries the place's name",
  },
  {
    rule: "narration",
    file: "packages/ui/src/tax/words.ts",
    text: "Columns: Entry, Date, Narration",
    reason: "the column names of the adjusting-entries file, which keeps its own names",
  },
  {
    rule: "lines",
    file: "packages/ui/src/tax/words.ts",
    text: "1 line",
    reason: "the lines of an adjusting entry ('2 entries, 4 lines'): an entry has lines",
  },
  {
    rule: "lines",
    file: "packages/ui/src/tax/words.ts",
    text: "{} lines",
    reason: "the lines of an adjusting entry ('2 entries, 4 lines'): an entry has lines",
  },
  {
    rule: "machine-detail",
    file: "packages/ui/src/shadow/words.ts",
    text: "Book revision",
    reason: "the label of a fact shown under Details, one click from the prepared entry",
  },
  {
    rule: "machine-detail",
    file: "packages/ui/src/reports/monthly-csv.ts",
    reason: "the rows of a CSV file keep their own names (Book revision, Population hash)",
  },
  {
    rule: "machine-detail",
    file: "packages/ui/src/reports/messages.ts",
    reason:
      "labels and help for a fact shown under Details (Report details: Book revision, Fingerprint)",
  },
  {
    rule: "machine-detail",
    file: "packages/ui/src/tax/words.ts",
    reason:
      "labels and help for a fact shown under Details (Pack details: Book revision, the manifest's SHA-256)",
  },
  {
    rule: "machine-detail",
    file: "packages/ui/src/accounting/words.ts",
    reason:
      "labels for the facts under Details on the Transactions list and the entry page (revision, population, source)",
  },
  {
    rule: "source-id",
    file: "packages/ui/src/accounting/words.ts",
    reason: "the label of the source event under Details on the entry page",
  },
  {
    rule: "chart-advanced",
    file: "packages/ui/src/chart/messages.ts",
    reason:
      "the advanced columns of the chart (behind Show advanced columns) and the tag editor's fields name the tags",
  },
  {
    rule: "machine-detail",
    file: "packages/ui/src/ingest/parts.tsx",
    text: "Fingerprint of those transactions",
    reason: "the label of a fact shown under Details on a transaction in For review",
  },
  {
    rule: "machine-detail",
    file: "apps/web/src/routes/reconcile/detail.tsx",
    text: "Record fingerprint",
    reason: "the label of a fact shown under Details on a finished reconciliation",
  },
  {
    rule: "machine-detail",
    file: "apps/web/src/routes/reconcile/detail.tsx",
    text: "Book revision",
    reason:
      "the label of the books' own count of changes the record was finished against, shown under Details on a finished reconciliation",
  },
  {
    rule: "machine-detail",
    file: "packages/ui/src/accounting/chart-words.ts",
    reason: "the label of the chart's revision, shown under Details on the Chart of accounts page",
  },
  {
    rule: "chart-advanced",
    file: "packages/ui/src/accounting/chart-words.ts",
    reason:
      "the tags in force are under Details, and the cash-flow class and role key are under Advanced in the New account drawer, shut until asked for",
  },
  {
    rule: "iso-date",
    file: "packages/ui/src/statements/words.ts",
    text: "Year-month-day (2026-03-25)",
    reason: "the example of a file's date format, written the way the file writes it",
  },
  // pending:begin
  {
    rule: "source-id",
    file: "packages/ui/src/accounting/entry-words.ts",
    reason:
      "the label of the source's ID, inside the disclosure 'Where this entry came from', which only a form opened for a source shows",
  },
  // pending:end
];

/** An account is its name in a list and in a sentence. Its code stays, muted, in the chart of accounts, in the
 * pickers and in the reports (the plan's "One vocabulary": "Business checking", not "1000 · Business
 * checking"). So a template that writes `${account.code} ${account.name}` is a place a person reads a code
 * first, and it is listed here with the reason, or it is changed to the name. */
export interface CodeFirst {
  /** The file, relative to the repository root. */
  readonly file: string;
  /** Part of the line; left out, every line of the file that writes a code before a name. */
  readonly line?: string;
  readonly why: string;
  /** Set when it is waiting for a lane to rebuild its screen and is not right: the lane that will change it. */
  readonly pending?: string;
}

export const codeFirstIsFine: readonly CodeFirst[] = [
  // The reports show an account's code, muted, beside its name.
  {
    file: "packages/ui/src/reports/ledger-table.tsx",
    why: "a report names an account with its code",
  },
  {
    file: "packages/ui/src/reports/view-model.ts",
    why: "a report row names an account with its code",
  },
  { file: "packages/ui/src/reports/views.tsx", why: "a report names an account with its code" },
  {
    file: "packages/ui/src/reports/activity-view.tsx",
    why: "the account's activity report is titled with its code",
  },
  // The chart of accounts shows every code.
  {
    file: "packages/ui/src/accounting/chart-words.ts",
    line: "This adds",
    why: "the New account drawer says what it adds with the code the chart will list it by",
  },
  // The tie-out is a report that compares the books with Xero's, and Xero names an account by its code.
  {
    file: "packages/ui/src/shadow/tieout-screen.tsx",
    why: "the tie-out is a report; it matches the accounts of Xero and of the books by their codes",
  },
  // A picker shows the code, muted, beside the name.
  {
    file: "apps/web/src/banks-controller.ts",
    line: "label:",
    why: "the picker of the account in the books that a bank account is booked to shows the code",
  },
  {
    file: "apps/web/src/routes/shadow/logic.ts",
    line: "label:",
    why: "an account picker shows the code",
  },
  {
    file: "apps/web/src/routes/shadow/xero-logic.ts",
    line: "const label",
    why: "the account picker of the Xero chart mapping",
  },
  {
    file: "apps/web/src/routes/stripe/controller.ts",
    line: "label:",
    why: "an account picker shows the code",
  },
  {
    file: "apps/web/src/routes/bankfeed/controller.ts",
    line: "label:",
    why: "an account picker shows the code",
  },
  // The owner's own setting: the number shows before the name only when they asked for it.
  {
    file: "packages/ui/src/entries/display.ts",
    why: "the owner's Show account numbers setting puts the number before the name in lists",
  },
  // The accessible name of a link in a report's table says what the row says, and the table keeps its codes.
  {
    file: "packages/ui/src/tax/words.ts",
    why: "the accessible name of a report-table link says what the row says; the worksheet's table keeps its codes like the other report tables",
  },
  // The rule editor's account selects show the code, muted, beside the name; its sentences say the name.
  {
    file: "apps/web/src/routes/rules/chart.ts",
    line: "const nameOf",
    why: "the account choices of the rule editor show the code; the rule list says the account with its name",
  },
];
