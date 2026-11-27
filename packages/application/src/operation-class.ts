import type { OperationClass } from "@rastrata/telemetry";

/** What an application operation costs to run, as one of the telemetry catalog's classes. The
 * classes are for measuring and for pricing: a request is not a "read" because of its name but
 * because it is cheap to answer, and a report is not because it is a read but because it walks the
 * whole book. So the heavy ones are listed by name, and the rest follow their permission.
 *
 *   report    reads that walk the whole journal list: statements, ledgers, tax builders, tie-outs
 *   prepare   previews of a kernel command (a draft of a posting, an account, a year-end)
 *   post      commits to the kernel: the one write that appends to the ledger
 *   ingest    imports and connector syncs: many rows from outside, parsed and matched
 *   job       maintenance that runs for a long time: backups, drills, exports
 *   draft     writes to product state: drafts, rules, inbox decisions, reconciliation edits
 *   maintain  settings, accounts, periods, tokens: rare, and cheap
 *   read      every other read
 *
 * A new operation is classified by its permission until somebody lists it here; the test in
 * test/operation-class.test.ts prints the table and fails if a class is empty or an operation named
 * here no longer exists. */
const LISTED: Readonly<Record<string, OperationClass>> = {
  // Whole-book reads.
  "reports.get": "report",
  "reports.cashFlow": "report",
  "reports.generalLedger": "report",
  "reports.largest": "report",
  "reports.export": "report",
  "reports.calendar": "report",
  "activity.get": "report",
  "journal.list": "report",
  "tieout.report": "report",
  "periods.yearEndReview": "report",
  "cutover.checklist": "report",
  "taxWorksheet.get": "report",
  "taxWorksheet.export": "report",
  "taxChecks.get": "report",
  "taxSummary.get": "report",
  "taxPack.build": "report",
  "taxVendors.list": "report",
  "taxVendors.export": "report",
  "taxVendors.get": "report",
  "taxSales.get": "report",
  "taxSales.export": "report",
  "taxAccountant.build": "report",
  "payees.totals": "report",
  "payees.get": "report",
  "payees.test": "report",
  "payees.export": "report",
  "reconcile.report": "report",
  // Previews of kernel commands.
  "accounts.prepareCreate": "prepare",
  "accounts.prepareChange": "prepare",
  "journal.prepare": "prepare",
  "journal.prepareReverse": "prepare",
  "periods.prepare": "prepare",
  "periods.yearEnd": "prepare",
  "opening.review": "prepare",
  "opening.plan": "prepare",
  "taxAdjustments.preview": "prepare",
  // Commits.
  "operations.commit": "post",
  "periods.commitYearEnd": "post",
  "inbox.post": "post",
  "inbox.undo": "post",
  // Imports and connectors.
  "import.preview": "ingest",
  "import.commit": "ingest",
  "bankfeed.sync": "ingest",
  "bankfeed.accounts": "ingest",
  "banks.receive": "ingest",
  "stripe.sync": "ingest",
  "stripe.receive": "ingest",
  "inbox.refresh": "ingest",
  "xero.chart.preview": "ingest",
  "xero.chart.import": "ingest",
  "xero.trialBalance.preview": "ingest",
  "xero.trialBalance.import": "ingest",
  "xero.transactions.preview": "ingest",
  "xero.transactions.import": "ingest",
  "taxAdjustments.import": "ingest",
  "classifier.train": "ingest",
  // Long maintenance.
  "backup.create": "job",
  "backup.verify": "job",
  "backup.drill": "job",
  "export.create": "job",
};

const BY_PERMISSION: Readonly<Record<string, OperationClass>> = {
  read: "read",
  draft: "draft",
  post: "post",
  configure: "maintain",
  correct: "maintain",
  close: "maintain",
  provision: "maintain",
};

/** The names the table lists, for the test that keeps it honest. */
export const LISTED_OPERATIONS: readonly string[] = Object.keys(LISTED);

export function operationClassOf(name: string | undefined, permission?: string): OperationClass {
  if (name === undefined) return "other";
  const listed = Object.hasOwn(LISTED, name) ? LISTED[name] : undefined;
  if (listed) return listed;
  return (permission !== undefined && BY_PERMISSION[permission]) || "other";
}
