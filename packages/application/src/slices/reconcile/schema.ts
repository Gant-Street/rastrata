import {
  array,
  date,
  hash,
  id,
  nullable,
  object,
  operation,
  page,
  ref,
  revision,
  role,
  signedMoney,
  text,
  version,
  type Schema,
} from "../../schema-kit.ts";
import type { SliceSchema } from "../types.ts";

/** A statement balance as the statement prints it: an optional minus, at most sixteen digits and
 * exactly two places. Never a float, never rounded. */
const statementMoney: Schema = { type: "string", pattern: "^-?(0|[1-9][0-9]{0,15})\\.[0-9]{2}$" };
const count: Schema = { type: "integer", minimum: 0 };
const yes: Schema = { type: "boolean" };
const normalSide: Schema = { type: "string", enum: ["debit", "credit"] };
const lifecycle: Schema = { type: "string", enum: ["draft", "completed", "voided"] };
const reason: Schema = { ...text(500), minLength: 1, pattern: "\\S" };

/** The most lines one reconciliation holds; see MAX_LINES in reconcile/engine.ts. */
const LINES = 5000;

/** The most outstanding lines one report lists. A reconciliation starts from at most `LINES` lines, so what
 * it leaves over is no more than that plus what was posted while the draft was open; past this the report
 * is refused, never cut short. */
export const REPORT_OUTSTANDING_LINES = 10000;

const reportProperties: Record<string, Schema> = {
  id,
  status: { type: "string", enum: ["completed", "voided"] },
  /** The account as it was named and typed when it was reconciled. */
  account: ref("ReconcileAccount"),
  currency: text(3),
  statementDate: date,
  statementBalance: signedMoney,
  /** What the reconciliations before this one cleared: the statement balance of the one it continues from. */
  openingBalance: signedMoney,
  previous: nullable(ref("ReconcilePrevious")),
  completedAt: text(80),
  recordHash: hash,
  previousHash: nullable(hash),
  /** The revision of the books the reconciliation finished at, and the one every figure in the report is read at. */
  bookRevision: revision,
  void: nullable(ref("ReconcileVoid")),
  /** The lines the reconciliation cleared, as it froze them. */
  cleared: ref("ReconcileReportPart"),
  /** The books' postings on or before the statement date that the statement did not show yet. Worked out, not stored. */
  outstanding: ref("ReconcileReportPart"),
  /** The books' balance on the statement date, at bookRevision. Less the outstanding total, it is the statement balance. */
  bookBalance: signedMoney,
  /** statementBalance less (openingBalance and the cleared total): 0.00 for every finished reconciliation. */
  difference: signedMoney,
  /** Only when asked for with file: the same report as a spreadsheet. */
  file: ref("ReconcileReportFile"),
};

export const reconcileSchema: SliceSchema = {
  name: "reconcile",
  definitions: {
    ReconcileAccount: object({ id, code: id, name: text(120), role, normalSide }),
    ReconcileLine: object({
      postingId: id,
      journalId: id,
      date,
      narration: text(240),
      /** Its effect on the statement balance: negative lowers it (money out, a payment), positive
       * raises it (money in, a charge). */
      amount: signedMoney,
      selected: yes,
    }),
    ReconcileWarning: object({ code: text(80), message: text(500) }),
    ReconcilePrevious: object({ id, statementDate: date, statementBalance: signedMoney }),
    ReconcileVoid: object({ id, reason: text(500), voidedAt: text(80), hash }),
    Reconciliation: object({
      id,
      status: lifecycle,
      /** Counts edits to a draft. Every write to a draft carries the version it was based on. */
      version,
      account: ref("ReconcileAccount"),
      currency: text(3),
      statementDate: date,
      statementBalance: signedMoney,
      /** What earlier reconciliations of this account have already cleared. */
      openingBalance: signedMoney,
      selectedCount: count,
      selectedTotal: signedMoney,
      clearedBalance: signedMoney,
      /** statementBalance - clearedBalance. A reconciliation completes at exactly 0.00. */
      difference: signedMoney,
      canComplete: yes,
      /** Drafts only: the books' own balance through the statement date, cleared or not. */
      bookBalance: nullable(signedMoney),
      selectionHash: hash,
      /** Drafts only: the book has moved since these lines were read. Refresh to include new ones. */
      stale: yes,
      snapshotRevision: revision,
      previous: nullable(ref("ReconcilePrevious")),
      lines: array(ref("ReconcileLine"), LINES),
      warnings: array(ref("ReconcileWarning"), 50),
      createdAt: text(80),
      updatedAt: text(80),
      completedAt: nullable(text(80)),
      recordHash: nullable(hash),
      previousHash: nullable(hash),
      void: nullable(ref("ReconcileVoid")),
    }),
    ReconciliationSummary: object({
      id,
      status: lifecycle,
      account: ref("ReconcileAccount"),
      statementDate: date,
      statementBalance: signedMoney,
      openingBalance: signedMoney,
      lineCount: count,
      createdAt: text(80),
      completedAt: nullable(text(80)),
      recordHash: nullable(hash),
      void: nullable(ref("ReconcileVoid")),
    }),
    ReconcileProgress: object({
      id,
      version,
      selectedCount: count,
      selectedTotal: signedMoney,
      clearedBalance: signedMoney,
      difference: signedMoney,
      canComplete: yes,
      selectionHash: hash,
    }),
    ReconcileDiscardResult: object({
      disposition: { type: "string", enum: ["discarded"] },
      id,
    }),
    ReconcileList: object({
      count,
      page,
      pageSize: { type: "integer", minimum: 1 },
      items: array(ref("ReconciliationSummary"), 25),
    }),
    ReconcileAccountStatus: object({
      account: ref("ReconcileAccount"),
      /** Reconciled before, being reconciled now, or tagged as a cash account. */
      tracked: yes,
      lastReconciledDate: nullable(date),
      lastReconciledBalance: nullable(signedMoney),
      lastReconciliationId: nullable(id),
      openReconciliationId: nullable(id),
      unclearedCount: count,
      unclearedTotal: signedMoney,
      oldestUnclearedDate: nullable(date),
      bookBalance: signedMoney,
    }),
    ReconcileStatus: object({
      bookRevision: revision,
      accounts: array(ref("ReconcileAccountStatus")),
    }),
    ReconcileClearedPosting: object({
      journalId: id,
      postingId: id,
      accountId: id,
      reconciliationId: id,
      statementDate: date,
    }),
    ReconcileCleared: object({ postings: array(ref("ReconcileClearedPosting"), 10000) }),
    ReconcileStartInput: object({
      accountId: id,
      statementDate: date,
      statementBalance: statementMoney,
    }),
    ReconcileIdInput: object({ id }),
    ReconcileSetClearedInput: object(
      {
        id,
        expectedVersion: version,
        /** Start from every line, or from none, before select and deselect apply. */
        reset: { type: "string", enum: ["all", "none"] },
        select: array(id, 500),
        deselect: array(id, 500),
      },
      ["id", "expectedVersion"],
    ),
    ReconcileSetStatementInput: object({
      id,
      expectedVersion: version,
      statementDate: date,
      statementBalance: statementMoney,
    }),
    ReconcileVersionInput: object({ id, expectedVersion: version }),
    ReconcileVoidInput: object({ id, reason }),
    ReconcileListInput: object({ accountId: id, status: lifecycle, page }, []),
    ReconcileStatusInput: object({ accountId: id, all: yes }, []),
    ReconcileClearedInput: object({ journalIds: { ...array(id, 100), minItems: 1 } }),
    ReconcileReportLine: object({
      postingId: id,
      journalId: id,
      date,
      narration: text(240),
      /** Its effect on the statement balance: negative lowers it (money out, a payment), positive raises it. */
      amount: signedMoney,
    }),
    ReconcileReportPart: object({
      count,
      /** The lines added up. */
      total: signedMoney,
      lines: array(ref("ReconcileReportLine"), REPORT_OUTSTANDING_LINES),
    }),
    ReconcileReportFile: object({
      filename: text(200),
      mediaType: text(80),
      content: { type: "string", maxLength: 16_000_000 },
    }),
    ReconcileReportInput: object({ id, file: { type: "string", enum: ["csv"] } }, ["id"]),
    ReconcileReport: object(
      reportProperties,
      Object.keys(reportProperties).filter((name) => name !== "file"),
    ),
  },
  operations: [
    operation(
      "reconcile.start",
      "Start reconciling an account against a bank or card statement. Give the account, the statement date and the ending balance exactly as the statement prints it (a card's balance owed is positive). Creates a retained draft and returns every line not yet on a completed reconciliation that is dated on or before the statement date, with the balance already cleared by earlier statements. Only one draft per account; the statement date must be after the previous reconciliation's.",
      "draft",
      "ReconcileStartInput",
      true,
      "Reconciliation",
    ),
    operation(
      "reconcile.get",
      "Read one reconciliation: a draft with its lines, selection and live difference, or a completed or voided record with the lines it cleared. For a draft, stale says the book has new postings since the lines were read.",
      "read",
      "ReconcileIdInput",
      false,
      "Reconciliation",
    ),
    operation(
      "reconcile.setCleared",
      "Change which lines a draft has selected, using the draft's version. reset starts from every line or none; select and deselect then add or remove up to 500 posting ids each. Returns the exact difference. A draft is working state; nothing is cleared until reconcile.complete.",
      "draft",
      "ReconcileSetClearedInput",
      true,
      "ReconcileProgress",
    ),
    operation(
      "reconcile.setStatement",
      "Change a draft's statement date or ending balance, or refresh its lines from the book when the values are unchanged. Keeps every selected line that is still a candidate. Uses the draft's version.",
      "draft",
      "ReconcileSetStatementInput",
      true,
      "Reconciliation",
    ),
    operation(
      "reconcile.discard",
      "Abandon a draft. Nothing was cleared, so nothing changes in the books or in any completed reconciliation.",
      "draft",
      "ReconcileVersionInput",
      true,
      "ReconcileDiscardResult",
    ),
    operation(
      "reconcile.complete",
      "Freeze a draft as a completed reconciliation. Requires a difference of exactly 0.00 and the draft's current version. The lines become cleared; the record can never be edited, only voided with a reason.",
      "close",
      "ReconcileVersionInput",
      true,
      "Reconciliation",
    ),
    operation(
      "reconcile.void",
      "Void the most recent completed reconciliation of an account, with a reason. Appends a voiding entry; nothing is edited or deleted, and its lines become uncleared again. Earlier statements are voided only after later ones.",
      "close",
      "ReconcileVoidInput",
      true,
      "Reconciliation",
    ),
    operation(
      "reconcile.list",
      "Page reconciliations, newest first, optionally for one account or one lifecycle state (draft, completed, voided). Lines are not included; read one with reconcile.get.",
      "read",
      "ReconcileListInput",
      false,
      "ReconcileList",
    ),
    operation(
      "reconcile.status",
      "For each tracked account: the last reconciled date and balance, the open draft if any, and how many postings are still uncleared. Tracked means reconciled before, being reconciled, or tagged as a cash account; all: true adds every asset and liability account.",
      "read",
      "ReconcileStatusInput",
      false,
      "ReconcileStatus",
    ),
    operation(
      "reconcile.cleared",
      "Which postings of the given journals are cleared, and on which reconciliation. A posting is cleared if it is on a completed reconciliation that has not been voided.",
      "read",
      "ReconcileClearedInput",
      false,
      "ReconcileCleared",
    ),
    operation(
      "reconcile.report",
      "Report on one finished (completed or voided) reconciliation, from records that never change: the record, the lines it cleared, the transactions still outstanding on its statement date and the book balance that results. Outstanding is worked out, not stored: the account's postings in the books on or before the statement date, as they stood at the revision the reconciliation finished at, less the lines it cleared and the lines of every earlier reconciliation that was in force then. The books' balance on the statement date, less the outstanding lines, equals the statement balance; the report checks that and fails with reconcile_report_mismatch rather than return figures that do not. Everything is read as of bookRevision, so a posting made later, or a later void of an earlier statement, does not change it. A voided reconciliation is reported as voided, with its reason and time, and its lines as they were. file: csv adds the same report as a spreadsheet. A draft has no report.",
      "read",
      "ReconcileReportInput",
      false,
      "ReconcileReport",
    ),
  ],
};
