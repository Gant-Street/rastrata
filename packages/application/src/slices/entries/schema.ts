import {
  array,
  date,
  id,
  nullable,
  object,
  operation,
  ref,
  revision,
  signedMoney,
  text,
  version,
  type Schema,
} from "../../schema-kit.ts";
import type { SliceSchema } from "../types.ts";

/** Posting an entry in one request, taking an entry back, changing the account of posted transactions,
 * and the book's display settings.
 *
 * `journal.post` is what a form that is already the review (the quick entry) sends instead of a draft, a
 * preparation and a commit in turn: the same three steps, by the same service calls, in one request, under
 * one identity. A client that shows the plan between the preparation and the commit (an agent, the full
 * entry page) keeps `journal.prepare` and `operations.commit`.
 *
 * `inbox.undo` belongs to the Inbox (it undoes what `inbox.post` did) but is declared here: it needs
 * the permission to correct the books (`correct`), where every other Inbox action that writes needs
 * `draft` or `post`. `inbox.recategorize` is undo, categorize and post in turn for each transaction, so it
 * needs `correct` and checks for `draft` and `post` as well. `book.update` changes product state, never
 * the ledger: the business name and how the app shows things. */

const count: Schema = { type: "integer", minimum: 0 };
const outcome: Schema = { type: "string", enum: ["applied", "skipped", "failed"] };
/** What a change of account says of a transaction: `would_apply` is what a plan (`dryRun`) says, in the
 * place of `applied`. */
const moveOutcome: Schema = {
  type: "string",
  enum: ["would_apply", "applied", "skipped", "failed"],
};

/** How the app writes a date: "Mar 20, 2026", "03/20/2026" or "2026-03-20". The CLI, the API, the
 * exports and every tooltip keep year-month-day whatever is chosen. */
export const DATE_FORMATS = ["medium", "numeric", "iso"] as const;
/** What accepting a suggestion does: post the entry at once (with Undo), or save it as a draft that
 * waits in Ready to post. */
export const ACCEPT_MODES = ["post", "draft"] as const;
/** Legal entity classifications for the business profile (Act 2 compliance seam). */
export const ENTITY_TYPES = [
  "sole_proprietorship",
  "single_member_llc",
  "multi_member_llc",
  "s_corp",
  "c_corp",
  "partnership",
  "nonprofit",
  "other",
] as const;

const definitions: Record<string, Schema> = {
  JournalPostInput: object(
    {
      data: ref("JournalDraftData"),
      /** The draft the caller already holds (a second try after a refusal), with the version it holds. Both
       * or neither. The draft is edited to `data` if it differs, and left as it is if it does not. */
      draftId: id,
      expectedVersion: version,
    },
    ["data"],
  ),
  PostRefusalDetail: object({ path: text(200), message: text(500) }),
  /** What the books or the service said no to after the draft was kept: the code, message and details the
   * operation that raised it would have answered (for a date outside the calendar, `calendar_not_configured`
   * and the year to extend through), so that the draft the caller now holds is never lost to an error. */
  PostRefusal: object({
    code: text(80),
    message: text(2000),
    details: array(ref("PostRefusalDetail"), 20),
    retryable: { type: "boolean" },
  }),
  JournalPostResult: object({
    /** The draft as it stands: saved, posted, or (after the books refused it) reopened for a second try. */
    draft: ref("SavedDraft"),
    /** The prepared posting, valid or with its problems; null when it could not be prepared (see `refusal`). */
    plan: nullable(ref("PreparedOperation")),
    /** The outcome of committing it; null when the plan was not valid, or could not be committed. */
    receipt: nullable(ref("MutationReceipt")),
    refusal: nullable(ref("PostRefusal")),
  }),
  InboxUndoInput: object(
    {
      itemIds: { ...array(id, 100), minItems: 1 },
      /** Why, for the line's history. The entry's reversal always carries the same plain reason. */
      reason: { ...text(500), minLength: 1, pattern: "\\S" },
    },
    ["itemIds"],
  ),
  InboxUndoResult: object(
    {
      itemId: id,
      outcome,
      /** The line's status afterwards: "new" once it is back in review. */
      status: ref("InboxStatus"),
      /** Why a line was skipped or refused. `fiscal_period_admission` is the ledger's own code for a
       * closed month: the entry sits in one, so it cannot be reversed until that month is reopened. */
      code: text(80),
      message: text(500),
      /** The entry that was taken back (or, for a line matched to an entry booked by hand, the entry
       * it was linked to, which is left as it was). */
      journalId: id,
      /** The linked reversal that took it back. */
      reversalJournalId: id,
      operationId: id,
      outcomeSequence: revision,
      /** Advisory notes from the books, such as "this entry is on a finished reconciliation". They
       * never stop the undo. */
      warnings: array(ref("PlanWarning"), 50),
    },
    ["itemId", "outcome"],
  ),
  InboxUndoReport: object({
    results: array(ref("InboxUndoResult"), 100),
    applied: count,
    skipped: count,
    failed: count,
    /** Lines in the request this call did not reach (it stops after a few seconds). Call again. */
    remaining: count,
  }),
  InboxRecategorizeInput: object(
    {
      /** Which transactions: exactly one of the Inbox lines (`itemIds`), the entries they made
       * (`journalIds`: how every other read names a transaction), or everything a filter selects
       * (`filter`, with the `expectedCount` the person saw). */
      itemIds: { ...array(id, 500), minItems: 1 },
      journalIds: { ...array(id, 500), minItems: 1 },
      filter: ref("InboxFilter"),
      /** With a filter: how many transactions it selected when the person looked. The request is
       * refused when the count has changed, so "all 240" never quietly acts on 260. */
      expectedCount: count,
      /** How many transactions this call looks at (100 if not given). A call that is cut short says how
       * many remain. */
      limit: { type: "integer", minimum: 1, maximum: 1000 },
      /** With a filter: carry on after this line (the `next` of the call before). */
      after: id,
      /** The account the transactions go to. */
      accountId: id,
      /** Only the transactions that are on this account now; any other is skipped. A guard for "move
       * what is in Other expenses" that holds when someone has changed one in the meantime. */
      fromAccountId: id,
      /** Why, for the history of each transaction. */
      reason: { ...text(500), minLength: 1, pattern: "\\S" },
      /** Plan and change nothing: every transaction with what would happen to it. The same plan is what
       * a call without it carries out, if nothing has changed. */
      dryRun: { type: "boolean" },
    },
    ["accountId"],
  ),
  InboxRecategorizeResult: object(
    {
      /** The transaction as the For review list knows it; absent for an entry that did not come from there. */
      itemId: id,
      /** The entry that was on the old account. */
      journalId: id,
      outcome: moveOutcome,
      /** Where the transaction is now: `posted` once it is on the new account, back in review (`new`) or
       * ready to post (`drafted`) when a step after the first failed. */
      status: ref("InboxStatus"),
      /** The account it was on, and the account it is on (or would be on). */
      fromAccountId: id,
      toAccountId: id,
      date,
      /** Signed from the bank's view: money out is negative. */
      amount: signedMoney,
      /** What the bank wrote, cut short. Untrusted text from outside. */
      description: text(200),
      /** The linked reversal of the old entry, and the entry now on the new account. */
      reversalJournalId: id,
      newJournalId: id,
      /** Why a transaction was skipped or refused. `fiscal_period_admission` is the ledger's own code for a
       * closed month. */
      code: text(80),
      message: text(500),
      /** Advisory notes, such as "this transaction is on a finished reconciliation". They never stop a move. */
      warnings: array(ref("PlanWarning"), 50),
    },
    ["outcome"],
  ),
  InboxRecategorizeTarget: object({ accountId: id, code: id, name: text(120) }),
  InboxRecategorizeReport: object({
    dryRun: { type: "boolean" },
    target: ref("InboxRecategorizeTarget"),
    results: array(ref("InboxRecategorizeResult"), 1000),
    /** What a plan says would happen. */
    would: count,
    applied: count,
    skipped: count,
    failed: count,
    /** Transactions in the request this call did not reach. Call again. */
    remaining: count,
    /** With a filter: pass as `after` to carry on; null when nothing remains. */
    next: nullable(id),
  }),
  EntityAddress: object(
    {
      line1: text(200),
      line2: text(200),
      city: text(120),
      state: text(40),
      postalCode: text(20),
      country: { type: "string", minLength: 2, maxLength: 2, pattern: "^[A-Za-z]{2}$" },
    },
    [],
  ),
  /** Optional legal entity metadata for a workspace's books (used in exports, CPA packets and future filings). */
  BookEntityProfile: object(
    {
      legalName: nullable(text(200)),
      ein: nullable({ type: "string", maxLength: 10, pattern: "^\\d{2}-?\\d{7}$" }),
      entityType: nullable({ type: "string", enum: ENTITY_TYPES }),
      formationState: nullable({
        type: "string",
        minLength: 2,
        maxLength: 2,
        pattern: "^[A-Za-z]{2}$",
      }),
      address: nullable(ref("EntityAddress")),
      contactEmail: nullable({
        type: "string",
        minLength: 3,
        maxLength: 254,
        pattern: "^[^\\s@]+@[^\\s@]+$",
      }),
    },
    [],
  ),
  BookSettings: object(
    {
      dateFormat: { type: "string", enum: DATE_FORMATS },
      /** Whether lists show an account's number beside its name. Pickers and the chart always can. */
      showAccountNumbers: { type: "boolean" },
      acceptMode: { type: "string", enum: ACCEPT_MODES },
      /** Optional legal entity metadata when recorded for this book. */
      entity: ref("BookEntityProfile"),
    },
    ["dateFormat", "showAccountNumbers", "acceptMode"],
  ),
  BookUpdateInput: object(
    {
      name: { ...text(120), minLength: 2, pattern: "\\S[\\s\\S]*\\S" },
      dateFormat: { type: "string", enum: DATE_FORMATS },
      showAccountNumbers: { type: "boolean" },
      acceptMode: { type: "string", enum: ACCEPT_MODES },
      entity: ref("BookEntityProfile"),
    },
    [],
  ),
  BookUpdateResult: object({
    name: text(120),
    settings: ref("BookSettings"),
    /** What this call changed, by input name. Empty when everything it asked for was already so. */
    changed: array(text(40), 8),
    /** The name before the call, when this call renamed the business. */
    previousName: nullable(text(120)),
  }),
};

export const entriesSchema: SliceSchema = {
  name: "entries",
  definitions,
  operations: [
    operation(
      "journal.post",
      "Post an entry in one request: save the draft (or edit the one you hold), prepare its exact posting, and, when the plan is valid, commit it under that plan's own hash; a posting the books refuse reopens the draft for a second try. The same three steps as drafts.create or drafts.save, journal.prepare and operations.commit, by the same checks, under one operation identity (retry with the same one). Use it when the form you are posting from is already the review; an agent that shows the plan between preparing and committing keeps those operations. Needs both draft and post permission.",
      "post",
      "JournalPostInput",
      true,
      "JournalPostResult",
    ),
    operation(
      "inbox.undo",
      "Take back posted Inbox lines: reverse each one's entry with a linked reversal (the original stays in the books, so the trail is kept) and return the line to review, where it can be decided and posted again. Refused for an entry in a closed month. A line matched to an entry that was booked by hand is only unlinked; that entry is left alone.",
      "correct",
      "InboxUndoInput",
      true,
      "InboxUndoReport",
    ),
    operation(
      "inbox.recategorize",
      "Change the account of posted transactions that came from For review: for each, reverse its entry with a linked reversal (the original stays in the books), categorize the transaction to the new account and post the new entry, each step under an identity derived from the request's, so a request that was cut short and is sent again with the same identity carries on and repeats nothing. Name the transactions by itemIds, by journalIds (the entries, as journal.list and payees.get give them) or by a filter with the expectedCount you saw; give the account to move them to. Set dryRun first: it changes nothing and lists every transaction with the account it is on, the account it would go to, and why any cannot move. It moves only a transaction booked to one account from a bank line: a split, a transfer, a payout and an entry made by hand are skipped with the reason, and so is anything in a closed month. Nothing is edited or deleted: the old entry, its reversal and the new entry all stay. If a step after the reversal fails, the transaction is left in For review and the result says so. A call does a bounded number and reports how many remain. Needs correct, draft and post permission.",
      "correct",
      "InboxRecategorizeInput",
      true,
      "InboxRecategorizeReport",
    ),
    operation(
      "book.update",
      "Change the business name and the display settings (date format, account numbers, what accepting a suggestion does). Product state only: nothing in the ledger changes.",
      "configure",
      "BookUpdateInput",
      true,
      "BookUpdateResult",
    ),
  ],
};
