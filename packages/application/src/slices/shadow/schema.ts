import {
  array,
  date,
  hash,
  id,
  money,
  nullable,
  object,
  operation,
  ref,
  revision,
  role,
  signedMoney,
  text,
  type Schema,
} from "../../schema-kit.ts";
import type { SliceSchema } from "../types.ts";
import { xeroDefinitions, xeroOperations } from "./xero-schema.ts";

/** The most open periods a checklist lists. A book that brought in ten years of history has a hundred and
 * thirty open months at once, and a reply with more than its schema allows is refused as a whole. */
export const MAX_OPEN_PERIODS = 120;

/** The shadow lane: moving a real business onto Rastrata and proving it. Opening balances start the
 * book as one ordinary balanced journal at a cutover date; the cutover hands that date to the
 * Inbox's sources so earlier bank history is set aside where it can be seen; the checklist says,
 * per bank, card and Stripe account, whether the month can close. Money is a decimal string with
 * two places; nothing here is a number a client may parse. */
const count: Schema = { type: "integer", minimum: 0 };
const flag: Schema = { type: "boolean" };
const instant = text(40);
const oneOf = (...values: string[]): Schema => ({ type: "string", enum: values });
const row: Schema = { type: "integer", minimum: 1, maximum: 10_000_000 };

/** Largest CSV text one request carries: the 128 KiB request limit leaves a little less than this. */
export const OPENING_CSV_MAX = 120_000;

const definitions: Readonly<Record<string, Schema>> = {
  // ------------------------------------------------------------------------------------------
  // Opening balances
  OpeningSeverity: oneOf("error", "warning", "info"),
  OpeningBalanceEntry: object({
    accountId: id,
    /** The amount in the account's normal orientation, so a bank account holding 1,200.00 and a card
     * that owes 300.00 are both positive. A negative amount is the unusual side. */
    balance: signedMoney,
  }),
  OpeningInput: object(
    {
      /** The first day of the book: the entry is dated on it and the Inbox starts on it. */
      cutoverDate: date,
      /** The equity account that balances the entry. Omitted: the one named for opening balances. */
      offsetAccountId: id,
      /** Exactly one of balances and csv. */
      balances: array(ref("OpeningBalanceEntry"), 400),
      /** The balances as CSV text: a Code or Name column and a Balance, or Debit and Credit, column. */
      csv: text(OPENING_CSV_MAX),
    },
    ["cutoverDate"],
  ),
  OpeningIssue: object(
    {
      severity: ref("OpeningSeverity"),
      code: text(60),
      message: text(700),
      accountId: id,
      row,
    },
    ["severity", "code", "message"],
  ),
  OpeningLine: object(
    {
      accountId: id,
      code: id,
      name: text(120),
      role,
      /** The account's normal side. */
      side: oneOf("debit", "credit"),
      balance: signedMoney,
      debit: money,
      credit: money,
      row,
    },
    ["accountId", "code", "name", "role", "side", "balance", "debit", "credit"],
  ),
  OpeningOffset: object({
    accountId: id,
    code: id,
    name: text(120),
    debit: money,
    credit: money,
    /** True when the person named the account; false when it was found by its name. */
    chosen: flag,
  }),
  OpeningTotals: object({
    enteredDebit: money,
    enteredCredit: money,
    debit: money,
    credit: money,
    balanced: flag,
  }),
  OpeningExisting: object(
    {
      /** none: nothing planned. planned: a draft is waiting to be posted. posted: the book has its
       * opening entry. reversed: it was posted and then reversed, so a new one may be planned. */
      status: oneOf("none", "planned", "posted", "reversed"),
      sourceId: text(128),
      journalId: id,
      planId: id,
      /** The cutover date the entry was planned for. Absent for an entry made by hand. */
      cutoverDate: date,
      /** The date the entry is (or will be) posted on: the day before the cutover date when the
       * calendar allowed it, the cutover date itself otherwise. */
      entryDate: date,
      /** The opening balances were entered by hand, as one ordinary journal against the equity
       * account named for opening balances dated before the cutover, not through the opening tools. */
      byHand: flag,
      /** Who planned it: "owner" or "agent:<tokenId>". */
      by: text(100),
    },
    ["status"],
  ),
  OpeningCalendar: object({
    firstDate: date,
    lastDate: date,
    /** The period the cutover date falls in. */
    periodId: id,
    periodLabel: text(80),
    periodStatus: oneOf("open", "closed"),
    periodStart: flag,
    fiscalYearStart: flag,
  }),
  OpeningReview: object(
    {
      cutoverDate: date,
      /** The date the entry will be posted on: the day before the cutover date when the book's
       * calendar allows it (the books then start from the balances and the first day's own activity
       * is all the cutover month shows), the cutover date itself when it is the first day of the
       * calendar or the day before is in a closed period. Null while the date is not usable. */
      entryDate: nullable(date),
      currency: text(3),
      /** True when the entry can be planned: no error stands in the way. */
      valid: flag,
      lines: array(ref("OpeningLine"), 400),
      /** The calculated line that balances the entry; null when the balances need none. */
      offset: nullable(ref("OpeningOffset")),
      totals: ref("OpeningTotals"),
      zeroBalances: count,
      issues: array(ref("OpeningIssue"), 400),
      /** Identifies exactly this entry; null while there is an error. */
      contentHash: nullable(hash),
      sourceId: nullable(text(128)),
      calendar: nullable(ref("OpeningCalendar")),
      /** The cutover date recorded for the book, which the entry must match. */
      recordedCutover: nullable(date),
      existing: ref("OpeningExisting"),
    },
    [
      "cutoverDate",
      "entryDate",
      "currency",
      "valid",
      "lines",
      "offset",
      "totals",
      "zeroBalances",
      "issues",
      "contentHash",
      "sourceId",
      "calendar",
      "recordedCutover",
      "existing",
    ],
  ),
  OpeningDraft: object({ id, version: { type: "integer", minimum: 1 } }),
  OpeningPlan: object({
    review: ref("OpeningReview"),
    draft: ref("OpeningDraft"),
    /** The prepared posting: commit it with operations.commit and its planId and planHash. */
    plan: ref("PreparedOperation"),
  }),

  // ------------------------------------------------------------------------------------------
  // The cutover
  CutoverAccount: object({
    accountId: id,
    code: id,
    name: text(120),
    role,
    kind: oneOf("bank", "card", "stripe"),
    /** Why it is suggested as an account that has statements: reconciled before, has an import
     * source, tagged cash (an asset), called or tagged a credit card (a liability), or the Stripe
     * balance. Null for an account the person chose that nothing else says has statements. */
    reason: nullable(oneOf("reconciled", "imported", "cash", "card", "stripe")),
    /** It is among the accounts the cutover date is given to. */
    chosen: flag,
    hasSource: flag,
  }),
  CutoverSource: object(
    {
      provider: text(32),
      accountKey: text(200),
      ledgerAccountId: nullable(id),
      account: nullable(text(200)),
      /** Where the source starts now. */
      startOn: nullable(date),
      /** Where it would start with the cutover date applied; null when the date leaves it alone. */
      after: nullable(date),
      action: oneOf(
        "unchanged",
        "set",
        "move_later",
        "move_earlier",
        "create",
        "managed",
        "unmapped",
      ),
      /** Lines already set aside as "before the cutover date". */
      excluded: count,
      /** Queued lines before the cutover date that applying it would set aside. */
      wouldExclude: count,
      /** Lines set aside earlier that an earlier date would bring back. */
      wouldRestore: count,
      note: text(400),
    },
    [
      "provider",
      "accountKey",
      "ledgerAccountId",
      "account",
      "startOn",
      "after",
      "action",
      "excluded",
      "wouldExclude",
      "wouldRestore",
    ],
  ),
  CutoverRecord: object({
    cutoverDate: date,
    recordedAt: instant,
    accountIds: array(id, 200),
    by: text(100),
  }),
  CutoverStripe: object(
    {
      configured: flag,
      syncFrom: nullable(date),
      /** The first day to import matches the cutover date. Null when there is no cutover date. */
      matches: nullable(flag),
      /** Stripe has already imported lines, so its first day can no longer move. */
      fixed: flag,
      note: text(400),
    },
    ["configured", "syncFrom", "matches", "fixed"],
  ),
  CutoverGetInput: object({ cutoverDate: date, accountIds: array(id, 200) }, []),
  CutoverSetInput: object({ cutoverDate: date, accountIds: array(id, 200) }, ["cutoverDate"]),
  CutoverState: object(
    {
      cutover: nullable(ref("CutoverRecord")),
      /** The date and accounts the sources below were worked out for: the recorded cutover, or the
       * ones asked about. */
      forDate: nullable(date),
      opening: ref("OpeningExisting"),
      /** Accounts that have statements: the ones chosen, or what is suggested. */
      accounts: array(ref("CutoverAccount"), 200),
      sources: array(ref("CutoverSource"), 200),
      stripe: nullable(ref("CutoverStripe")),
      /** The cutover date can no longer move because the opening entry is posted. */
      locked: flag,
      notes: array(text(500), 20),
    },
    ["cutover", "forDate", "opening", "accounts", "sources", "stripe", "locked", "notes"],
  ),
  CutoverSetResult: object({
    state: ref("CutoverState"),
    /** Queued lines now set aside as before the cutover date. */
    excluded: count,
    /** Lines the date brought back into the queue. */
    restored: count,
    /** Sources given the date: created for an account with statements, or moved. */
    sourcesSet: count,
  }),

  // ------------------------------------------------------------------------------------------
  // The checklist
  ChecklistInput: object({ periodId: id }, []),
  ChecklistSection: oneOf(
    "accounts",
    "inbox",
    "stripe",
    "backups",
    "periods",
    "opening",
    "cutover",
  ),
  ChecklistReason: object(
    {
      code: text(60),
      section: ref("ChecklistSection"),
      message: text(600),
      accountId: id,
    },
    ["code", "section", "message"],
  ),
  ChecklistPeriod: object({
    id,
    label: text(80),
    startsOn: date,
    endsOn: date,
    status: oneOf("open", "closed"),
    /** The period's last day is before today. */
    ended: flag,
  }),
  ChecklistVerdict: object({
    /** ready: close the period. not_yet: something stands in the way. nothing_to_close: every
     * period of the calendar is already closed. */
    state: oneOf("ready", "not_yet", "nothing_to_close"),
    summary: text(500),
    blocking: array(ref("ChecklistReason"), 80),
    attention: array(ref("ChecklistReason"), 80),
  }),
  ChecklistReconciliation: object({
    date,
    balance: signedMoney,
    /** A completed reconciliation always closed at exactly 0.00: the service refuses to complete one
     * that does not. */
    closedAtZero: flag,
  }),
  ChecklistDraft: object({
    id,
    statementDate: date,
    statementBalance: signedMoney,
    difference: signedMoney,
  }),
  ChecklistWaiting: object({ count, oldestOn: nullable(date) }),
  ChecklistUncleared: object({ count, total: signedMoney, oldestOn: nullable(date) }),
  ChecklistStripePayouts: object({
    known: count,
    booked: count,
    /** Waiting for Stripe to finish itemising them. */
    waiting: count,
    /** Their transactions do not add up, or cannot be split. */
    mismatched: count,
    /** For a person to categorise: another currency, or made by hand. */
    held: count,
    /** Booked and not yet matched to a bank deposit. */
    unmatched: count,
    /** Of those, the ones whose deposit is overdue: past the arrival date and the matching window. */
    overdue: count,
    /** The arrival date of the oldest overdue payout, or null when none is. */
    oldestOverdueOn: nullable(date),
  }),
  /** Stripe is checked against its own balance, not a bank statement: the evidence is that it holds
   * nothing that has not been imported and that every payout adds up. The comparison is of Stripe's
   * balance now, so it says nothing about a past month except that nothing is missing. */
  ChecklistStripe: object({
    /** Stripe's own balance has been read and compared. */
    compared: flag,
    /** It equals what Rastrata expects Stripe to hold. */
    ties: flag,
    /** What Stripe holds that has not been imported; null until compared. */
    difference: nullable(signedMoney),
    /** Imported and not yet paid out. */
    unpaid: nullable(signedMoney),
    /** Payouts booked whose bank deposit is not matched yet. */
    inTransit: nullable(signedMoney),
    readAt: nullable(instant),
    stale: flag,
    explanation: text(1500),
    payouts: ref("ChecklistStripePayouts"),
    status: oneOf("ready", "attention", "blocked"),
    reasons: array(ref("ChecklistReason"), 12),
  }),
  ChecklistAccount: object(
    {
      accountId: id,
      code: id,
      name: text(120),
      role,
      kind: oneOf("bank", "card"),
      reason: oneOf("chosen", "reconciled", "imported", "cash"),
      bookBalance: signedMoney,
      hasActivity: flag,
      lastReconciliation: nullable(ref("ChecklistReconciliation")),
      /** The newest completed reconciliation is dated on or after the end of the period. */
      throughPeriodEnd: flag,
      draft: nullable(ref("ChecklistDraft")),
      /** Inbox lines dated through the end of the period that are still waiting (new, proposed or
       * drafted); null when the Inbox could not be read. */
      unreconciled: nullable(ref("ChecklistWaiting")),
      /** Postings not yet on a completed reconciliation, any date. */
      uncleared: ref("ChecklistUncleared"),
      status: oneOf("ready", "attention", "blocked", "no_activity"),
      reasons: array(ref("ChecklistReason"), 12),
    },
    [
      "accountId",
      "code",
      "name",
      "role",
      "kind",
      "reason",
      "bookBalance",
      "hasActivity",
      "lastReconciliation",
      "throughPeriodEnd",
      "draft",
      "unreconciled",
      "uncleared",
      "status",
      "reasons",
    ],
  ),
  ChecklistOtherAccount: object({
    accountId: id,
    code: id,
    name: text(120),
    role,
    balance: signedMoney,
  }),
  ChecklistDrill: object({ ranAt: instant, passed: flag }),
  ChecklistCutover: object({
    date,
    /** recorded: set with cutover.set. opening_entry: taken from the date of the posted opening entry. */
    basis: oneOf("recorded", "opening_entry"),
  }),
  ChecklistBackups: object(
    {
      available: flag,
      /** The service keeps the history of the books itself (a hosted workspace): there are no backups for a person to verify and no drill to run, so nothing about them stands in the way of a month. Absent means not. */
      keptByService: flag,
      /** Why the backups could not be read, when they could not. */
      reason: text(400),
      verifiedAt: nullable(instant),
      ageHours: nullable({ type: "integer", minimum: 0 }),
      limitHours: { type: "integer", minimum: 1 },
      drill: nullable(ref("ChecklistDrill")),
    },
    ["available", "verifiedAt", "ageHours", "limitHours", "drill"],
  ),
  ChecklistInbox: object({
    available: flag,
    /** Lines dated through the end of the period that still need a person or a posting. */
    waiting: count,
    oldestOn: nullable(date),
    /** Every line waiting, any date. */
    toReview: count,
  }),
  ChecklistMonth: object({
    periodId: id,
    label: text(80),
    endsOn: date,
    closed: flag,
    /** Every account with activity has a completed reconciliation dated on or after the period end. */
    proven: flag,
  }),
  ChecklistShadowRun: object({
    /** Month ends that must be closed and reconciled before the old system is set aside. */
    required: { type: "integer", minimum: 1 },
    provenCount: count,
    provenThrough: nullable(date),
    complete: flag,
    months: array(ref("ChecklistMonth"), 120),
  }),
  ChecklistUnavailable: object({ section: ref("ChecklistSection"), reason: text(400) }),
  /** One of the places the money of a catch-all account went in the period. */
  ChecklistNoteLargest: object({
    /** A payee's name, or a bank's text for a group not named yet. Untrusted text, cut short. */
    name: text(120),
    amount: signedMoney,
    kind: oneOf("payee", "unnamed", "ambiguous", "by_hand", "no_bank_text"),
  }),
  ChecklistNoteAccount: object({
    id,
    code: id,
    name: text(120),
    role: oneOf("expense", "income"),
  }),
  /** Something the period shows that is not a reason to wait. A note never holds up a close. */
  ChecklistNote: object(
    {
      /** catchall_holds_money: a catch-all account (marked with the role key catchall.expense or
       * catchall.income) took money in the period. catchall_not_checked: it is marked and what it took
       * could not be read, so whether money is collecting there is not known. */
      code: oneOf("catchall_holds_money", "catchall_not_checked"),
      /** One sentence a person can read, built from the figures below. */
      message: text(700),
      account: ref("ChecklistNoteAccount"),
      /** The period the figures cover. */
      from: date,
      to: date,
      /** What the account took in the period on its own side: spent for an expense account, received for
       * an income account. */
      amount: signedMoney,
      /** How many entries are in the account at the end of the period. An entry that was reversed by
       * then, and its reversal, are not counted: they add up to nothing. */
      transactions: count,
      /** The largest places it went, largest first (at most five). */
      largest: array(ref("ChecklistNoteLargest"), 5),
    },
    ["code", "message", "account"],
  ),
  CutoverChecklist: object(
    {
      asOf: date,
      bookRevision: revision,
      /** The book has posted journals. A book with nothing in it is the only one offered the move
       * from another system. */
      hasHistory: flag,
      /** A history was brought in (`history.import`): the books begin with entries, so there are no opening
       * balances to add. Absent from a reply of a release before histories. */
      historyImported: flag,
      currency: text(3),
      /** The cutover date, and where it came from: recorded, or taken from the opening entry. */
      cutover: nullable(ref("ChecklistCutover")),
      opening: ref("OpeningExisting"),
      /** The period being checked: the earliest open one on or after the cutover. */
      period: nullable(ref("ChecklistPeriod")),
      verdict: ref("ChecklistVerdict"),
      accounts: array(ref("ChecklistAccount"), 200),
      /** Asset and liability accounts with a balance that nothing tracks yet. */
      otherAccounts: array(ref("ChecklistOtherAccount"), 100),
      /** Stripe's own checks; null when the business does not use Stripe. */
      stripe: nullable(ref("ChecklistStripe")),
      inbox: ref("ChecklistInbox"),
      backups: ref("ChecklistBackups"),
      /** Open periods from the cutover on. */
      openPeriods: array(ref("ChecklistPeriod"), MAX_OPEN_PERIODS),
      shadowRun: nullable(ref("ChecklistShadowRun")),
      unavailable: array(ref("ChecklistUnavailable"), 10),
      /** What the period shows that is not a reason to wait (money collecting in a catch-all account).
       * Absent from a reply of a release before notes; empty when there is nothing to say. */
      notes: array(ref("ChecklistNote"), 10),
    },
    [
      "asOf",
      "bookRevision",
      "hasHistory",
      "currency",
      "cutover",
      "opening",
      "period",
      "verdict",
      "accounts",
      "otherAccounts",
      "stripe",
      "inbox",
      "backups",
      "openPeriods",
      "shadowRun",
      "unavailable",
    ],
  ),
};

export const shadowSchema: SliceSchema = {
  name: "shadow",
  definitions: { ...definitions, ...xeroDefinitions },
  operations: [
    operation(
      "opening.review",
      "Check opening balances without changing anything. Give the cutover date (the first day of the book) and the balance of each account, either as a list or as CSV text, and get back the one balanced entry that would start the book: each account stated as a debit or a credit, the calculated equity offset, the totals and every problem, each naming its account or row. Balances are in the account's normal orientation (a bank account holding 1,200.00 and a card owing 300.00 are both positive). Read this first, fix every error, then plan.",
      "read",
      "OpeningInput",
      false,
      "OpeningReview",
    ),
    operation(
      "opening.plan",
      "Turn reviewed opening balances into the one draft entry and prepare its exact posting, without posting. Requires the cutover date to be recorded (cutover.set) and to match. Returns the review and the prepared plan; commit it with operations.commit using the plan's planId and planHash, after the owner has seen the entry. Planning again with other balances replaces the unposted draft.",
      "post",
      "OpeningInput",
      true,
      "OpeningPlan",
    ),
    operation(
      "cutover.get",
      "Read the cutover: the recorded date, whether the opening entry is planned, posted or reversed, and, for each statement source of the Inbox, where it starts now and what the date would do (lines it would set aside, lines it would bring back). Pass a cutoverDate and accountIds to see what a date would do before setting it.",
      "read",
      "CutoverGetInput",
      false,
      "CutoverState",
    ),
    operation(
      "cutover.set",
      "Record the cutover date and give it to the Inbox as the start date of the bank and card accounts' import sources, so earlier history is set aside where it can be seen and restored, never dropped. Sources that do not exist yet are created for the accounts named, so a first import starts on the date. Stripe keeps its own first day, which is moved only while nothing from Stripe has been imported. Not allowed to move once the opening entry is posted.",
      "configure",
      "CutoverSetInput",
      true,
      "CutoverSetResult",
    ),
    operation(
      "cutover.checklist",
      "Say whether the period can close. Per bank and card account: the latest reconciliation and that it closed at exactly 0.00, Inbox lines and postings still waiting; Stripe against its own balance; then the Inbox, the last verified backup and restore drill, the open periods and how many month ends are closed and reconciled since the cutover. The verdict is ready, or not yet with every reason. It also carries notes, which are not reasons to wait: when the book marks a catch-all account (the role keys catchall.expense and catchall.income) and money collected there in the period, a note says how much, from how many transactions and which payees took the most; one that says an account could not be checked is not a pass either. A book that marks none has none. Reads the other lanes' operations only; a section that cannot be read says so and keeps the verdict at not yet.",
      "read",
      "ChecklistInput",
      false,
      "CutoverChecklist",
    ),
    ...xeroOperations,
  ],
};
