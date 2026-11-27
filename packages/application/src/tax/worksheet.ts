/** The tax worksheet: the book's income and expense accounts totalled by the tax line each is tagged
 * with, for a tax year and a form.
 *
 * What it is and is not. It reports; it does not advise. A line is the sum of the postings of the
 * accounts tagged with it, where each posting takes the tag in force on its own date (an owner may
 * re-tag an account from a date, and the date-versioned tags keep both). An account with activity and
 * no line from this form is listed as "not mapped" with its amount; it is never guessed into a line.
 * Computed lines are the arithmetic the IRS form prints, over those sums. Schedule C line 24b takes
 * the meals percentage and shows what it took off, because the books record the full cost.
 *
 * Exactness. Everything is integer cents in a bigint. The one percentage rounds half a cent away from
 * zero and says so. The worksheet is built from the postings by tax line and checked against the same
 * range's per-account sums that the statements use, and a worksheet whose net does not reconcile to
 * the profit and loss to the cent is refused, never shown.
 *
 * Pure and portable: a function of a book state, a tag map and a request. */
import { hashCanonical, type BookState } from "@rastrata/kernel";

import type { AccountTagMap } from "../account-tags.ts";
import type {
  TaxLineAccount,
  TaxLineAdjustment,
  TaxReconciliation,
  TaxUnmappedAccount,
  TaxWorksheet,
  TaxWorksheetForm,
  TaxWorksheetLine,
  TaxWorksheetPart,
} from "../client-contracts.gen.ts";
import {
  formOfLine,
  taxForm,
  TAX_DISCLAIMER,
  type TaxForm,
  type TaxLine,
} from "../chart/tax-lines.ts";
import { ApplicationError } from "../errors.ts";
import { formatMoney } from "../money.ts";
import { compareCodes, isProfitLossRole, presented, type ChartAccount } from "../reports/chart.ts";
import {
  compileColumn,
  reportContext,
  resolveRange,
  type Column,
  type ReportContext,
} from "../reports/columns.ts";
import { postingCents } from "../reports/ledger.ts";
import { profitLossFigures } from "../reports/statements.ts";
import {
  worksheetLayout,
  type ComputedItem,
  type FormLayout,
  type LayoutItem,
  type WorksheetFormId,
} from "./forms.ts";
import { worksheetNotes } from "./notes.ts";
import { TAX_DISCLAIMER_LONG } from "./sources.ts";

/** Version of the algorithm. It is part of every worksheet's population hash, so a figure from a
 * different algorithm can never be mistaken for a reproduction. */
export const WORKSHEET_VERSION = "rastrata-tax-worksheet-v1";

/** The percentage of booked meals the form takes when nobody says otherwise: the IRS instructions
 * for Schedule C line 24b ("in most cases, the percentage is 50%"). */
export const DEFAULT_MEALS_PERCENT = 50;

export interface WorksheetRequest {
  readonly taxYear: number;
  readonly form: WorksheetFormId;
  readonly from: string;
  readonly to: string;
  readonly mealsPercent: number;
  readonly tags: AccountTagMap;
  /** Today's date, so a range that has not ended says it is the figures so far. */
  readonly today: string;
  /** The first day the books hold, when a cutover date is recorded: earlier activity is elsewhere. */
  readonly booksStartOn?: string | null;
}

/** Lines whose accounts are credit-normal income. Every other tagged line is read from debits:
 * returns and allowances, cost of goods sold and expenses. */
const CREDIT_LINES: ReadonlySet<string> = new Set([
  "scheduleC.line1",
  "scheduleC.line6",
  "form1120S.line1a",
  "form1120S.line4",
  "form1120S.line5",
  "form1065.line1a",
  "form1065.line6",
  "form1065.line7",
]);

/** The amount of a tagged line, in the line's own sign, from ledger-signed cents (debit positive). */
export const lineAmount = (lineId: string, ledgerCents: bigint): bigint =>
  CREDIT_LINES.has(lineId) ? -ledgerCents : ledgerCents;

/** A percentage of an amount in cents, rounding half a cent away from zero. 50% of 10005 cents is
 * 5003, and 50% of -10005 is -5003. */
export function percentOf(cents: bigint, percent: number): bigint {
  const scaled = cents * BigInt(percent);
  return scaled >= 0n ? (scaled + 50n) / 100n : -((-scaled + 50n) / 100n);
}

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

const doesNotTie = (message: string) => new ApplicationError("report_does_not_tie", message, 500);

/** Where a posting goes: a line of the form, or nowhere, and why. */
export type Bucket =
  | { readonly kind: "line"; readonly id: string }
  | {
      readonly kind: "unmapped";
      readonly reason: TaxUnmappedAccount["reason"];
      readonly taxLine: string | null;
    };

const bucketKey = (bucket: Bucket): string =>
  bucket.kind === "line"
    ? `line:${bucket.id}`
    : `unmapped:${bucket.reason}:${bucket.taxLine ?? ""}`;

/** One posting of an income or expense account in the range, with where it goes. */
export interface ClassifiedPosting {
  readonly date: string;
  readonly journalId: string;
  readonly postingId: string;
  readonly narration: string;
  readonly account: ChartAccount;
  /** Ledger-signed: a debit is positive. */
  readonly cents: bigint;
  readonly bucket: Bucket;
}

/** What a worksheet is read from, resolved once: the report context and range, the forms, and the
 * rule that sends a posting to a line. */
interface Basis {
  readonly context: ReportContext;
  readonly range: { readonly from: string; readonly fiscalYear: TaxWorksheet["fiscalYear"] };
  readonly column: Column;
  readonly layout: FormLayout;
  readonly forms: readonly TaxForm[];
  readonly catalog: ReadonlyMap<string, TaxLine>;
  classify(account: ChartAccount, date: string): Bucket;
}

function basisOf(state: BookState, request: WorksheetRequest): Basis {
  const { taxYear, tags } = request;
  const context = reportContext(state, request.to);
  const range = resolveRange(context, request.to, request.from);
  const column = compileColumn(context, range.from, request.to);
  const layout = worksheetLayout(request.form, taxYear);
  const forms = layout.forms.map((id) => {
    const found = taxForm(id, taxYear);
    if (!found)
      throw new ApplicationError(
        "tax_year_unsupported",
        `Rastrata's verified tax-line catalog has no ${id} for ${taxYear}.`,
        400,
      );
    return found;
  });
  const catalog = new Map<string, TaxLine>(
    forms.flatMap((form) => form.lines.map((line) => [line.id, line] as const)),
  );
  const formIds = new Set<string>(layout.forms);
  return {
    context,
    range,
    column,
    layout,
    forms,
    catalog,
    classify(account, date) {
      const taxLine = tags.tagsFor(account.id, date).taxLine;
      if (taxLine === undefined) return { kind: "unmapped", reason: "no_tax_line", taxLine: null };
      const form = formOfLine(taxLine);
      if (form === undefined || !formIds.has(form))
        return { kind: "unmapped", reason: "other_form", taxLine };
      const line = catalog.get(taxLine);
      if (!line) return { kind: "unmapped", reason: "not_on_this_year", taxLine };
      if (!line.roles.includes(account.role))
        return { kind: "unmapped", reason: "role_not_accepted", taxLine };
      return { kind: "line", id: line.id };
    },
  };
}

/** Every posting of an income or expense account in the range, in date order, with where it goes.
 * The same function feeds the worksheet and its posting-level detail, so the two cannot disagree. */
function classifiedPostings(basis: Basis, request: WorksheetRequest): ClassifiedPosting[] {
  const accounts = new Map(basis.context.accounts.map((account) => [account.id, account]));
  const result: ClassifiedPosting[] = [];
  for (const booked of basis.context.view.included(request.to).journals) {
    const date = booked.journal.accountingDate as string;
    if (date < basis.range.from) continue;
    for (const posting of booked.journal.postings) {
      const account = accounts.get(posting.accountId as string);
      if (!account) throw new Error("Journal references an unknown account");
      if (!isProfitLossRole(account.role)) continue;
      result.push({
        date,
        journalId: booked.journal.id as string,
        postingId: posting.id as string,
        narration: booked.journal.narration,
        account,
        cents: postingCents(posting),
        bucket: basis.classify(account, date),
      });
    }
  }
  return result;
}

/** Consecutive postings of one account that go to the same place. An account's postings are read in
 * date order, so a tag that changes on a date starts a new run on that date. */
interface Run {
  readonly account: ChartAccount;
  readonly bucket: Bucket;
  cents: bigint;
  postings: number;
  from: string;
  to: string;
}

function runsOf(postings: readonly ClassifiedPosting[]): Run[] {
  const runs: Run[] = [];
  const open = new Map<string, Run>();
  for (const posting of postings) {
    let run = open.get(posting.account.id);
    if (!run || bucketKey(run.bucket) !== bucketKey(posting.bucket)) {
      run = {
        account: posting.account,
        bucket: posting.bucket,
        cents: 0n,
        postings: 0,
        from: posting.date,
        to: posting.date,
      };
      open.set(posting.account.id, run);
      runs.push(run);
    }
    run.cents += posting.cents;
    run.postings += 1;
    run.to = posting.date;
  }
  return runs;
}

function formInfo(form: TaxForm): TaxWorksheetForm {
  return {
    id: form.id,
    name: form.name,
    subject: form.subject,
    taxYear: form.taxYear,
    status: form.status,
    verifiedOn: form.verifiedOn,
    sources: form.sources.map((source) => ({ title: source.title, url: source.url })),
  };
}

/** A fingerprint of the catalog's lines for the forms used, so a population changes if the verified
 * captions or numbers do. */
function catalogHash(forms: readonly TaxForm[]): string {
  return hashCanonical({
    type: "TaxCatalogFingerprint",
    forms: forms.map((form) => ({
      id: form.id,
      taxYear: BigInt(form.taxYear),
      status: form.status,
      verifiedOn: form.verifiedOn,
      lines: form.lines.map((line) => [line.id, line.number, line.label, line.kind]),
    })),
  }).digest;
}

/** The form a book's tags point at, when the caller does not say: the one with the most tagged
 * accounts as of the end of the range, ties going to Schedule C. A book with no tax-line tags gets
 * Schedule C, and every account is then listed as not mapped. */
export function defaultWorksheetForm(
  state: BookState,
  tags: AccountTagMap,
  asOf: string,
): WorksheetFormId {
  const counts: Record<WorksheetFormId, number> = { scheduleC: 0, form1120S: 0, form1065: 0 };
  for (const account of state.admissionSnapshot.accounts) {
    // A Form 1125-A account belongs to a corporation or a partnership, and the other tags say which,
    // so it does not vote.
    const form = formOfLine(tags.tagsFor(account.id as string, asOf).taxLine ?? "");
    if (form === "scheduleC" || form === "form1120S" || form === "form1065") counts[form] += 1;
  }
  let best: WorksheetFormId = "scheduleC";
  for (const form of ["form1120S", "form1065"] as const)
    if (counts[form] > counts[best]) best = form;
  return best;
}

/** The posting-level detail behind a worksheet: every posting of every income and expense account in
 * the range and the line it fed (or why it fed none). */
export interface WorksheetPostingRow {
  /** The line key ("scheduleC.line8"), or null for a posting that is not mapped. */
  readonly line: string | null;
  readonly lineNumber: string;
  /** "mapped", or the reason an account is not mapped. */
  readonly status: string;
  readonly taxLine: string | null;
  readonly account: ChartAccount;
  readonly date: string;
  readonly journalId: string;
  readonly postingId: string;
  readonly narration: string;
  /** In the sign of the line (income and returns positive, expenses positive) or, for a posting
   * that is not mapped, a normal balance's sign. */
  readonly amount: bigint;
}

export function worksheetPostings(
  state: BookState,
  request: WorksheetRequest,
): readonly WorksheetPostingRow[] {
  const basis = basisOf(state, request);
  return postingRows(basis, classifiedPostings(basis, request));
}

function postingRows(
  basis: Basis,
  postings: readonly ClassifiedPosting[],
): readonly WorksheetPostingRow[] {
  return postings.map((posting): WorksheetPostingRow => {
    const { bucket } = posting;
    if (bucket.kind === "line")
      return {
        line: bucket.id,
        lineNumber: basis.catalog.get(bucket.id)?.number ?? "",
        status: "mapped",
        taxLine: bucket.id,
        account: posting.account,
        date: posting.date,
        journalId: posting.journalId,
        postingId: posting.postingId,
        narration: posting.narration,
        amount: lineAmount(bucket.id, posting.cents),
      };
    return {
      line: null,
      lineNumber: "",
      status: bucket.reason,
      taxLine: bucket.taxLine,
      account: posting.account,
      date: posting.date,
      journalId: posting.journalId,
      postingId: posting.postingId,
      narration: posting.narration,
      amount: presented(posting.account.role, posting.cents),
    };
  });
}

export function compileWorksheet(state: BookState, request: WorksheetRequest): TaxWorksheet {
  return analyzeWorksheet(state, request).worksheet;
}

/** The worksheet and the postings behind it, from one pass over the book. */
export function analyzeWorksheet(
  state: BookState,
  request: WorksheetRequest,
): { readonly worksheet: TaxWorksheet; readonly postings: readonly WorksheetPostingRow[] } {
  const basis = basisOf(state, request);
  const classified = classifiedPostings(basis, request);
  return {
    worksheet: buildWorksheet(state, request, basis, classified),
    postings: postingRows(basis, classified),
  };
}

function buildWorksheet(
  state: BookState,
  request: WorksheetRequest,
  basis: Basis,
  postings: readonly ClassifiedPosting[],
): TaxWorksheet {
  const { taxYear, tags } = request;
  const { context, range, column, layout, forms, catalog } = basis;
  const main = forms[0] as TaxForm;

  // The same range's per-account sums that the statements read must equal the ones just built.
  const perAccount = new Map<string, bigint>();
  for (const posting of postings)
    perAccount.set(posting.account.id, (perAccount.get(posting.account.id) ?? 0n) + posting.cents);
  for (const account of context.accounts) {
    if (!isProfitLossRole(account.role)) continue;
    if ((perAccount.get(account.id) ?? 0n) !== (column.accumulated.range.get(account.id) ?? 0n))
      throw doesNotTie(`The worksheet does not tie to the ledger for account ${account.code}`);
  }

  // Tagged lines: the runs that go to a line, summed, with the accounts behind them.
  const bookedByLine = new Map<string, bigint>();
  const accountRows = new Map<string, TaxLineAccount[]>();
  const unmapped: TaxUnmappedAccount[] = [];
  let unmappedIncome = 0n;
  let unmappedExpenses = 0n;
  const ordered = runsOf(postings).sort(
    (a, b) => compareCodes(a.account.code, b.account.code) || compareText(a.from, b.from),
  );
  for (const run of ordered) {
    if (run.cents === 0n) continue;
    if (run.bucket.kind === "line") {
      const id = run.bucket.id;
      bookedByLine.set(id, (bookedByLine.get(id) ?? 0n) + run.cents);
      const rows = accountRows.get(id) ?? [];
      accountRows.set(id, rows);
      rows.push({
        accountId: run.account.id,
        code: run.account.code,
        name: run.account.name,
        role: run.account.role,
        amount: formatMoney(lineAmount(id, run.cents)),
        from: run.from,
        to: run.to,
        postings: run.postings,
      });
      continue;
    }
    const shown = presented(run.account.role, run.cents);
    if (run.account.role === "expense") unmappedExpenses += shown;
    else unmappedIncome += shown;
    unmapped.push({
      accountId: run.account.id,
      code: run.account.code,
      name: run.account.name,
      role: run.account.role,
      amount: formatMoney(shown),
      reason: run.bucket.reason,
      taxLine: run.bucket.taxLine,
      from: run.from,
      to: run.to,
      postings: run.postings,
    });
  }

  // Evaluate the layout. Lines refer to each other (line 4 takes line 42), so each is worked out on
  // demand and remembered. A value carries the amount as booked and the amount for the form, and
  // `removed` is always booked less form.
  const items = new Map<string, LayoutItem>();
  for (const part of layout.parts) for (const item of part.items) items.set(item.id, item);
  interface Value {
    readonly booked: bigint;
    readonly form: bigint;
    readonly removed: bigint;
  }
  const memo = new Map<string, Value>();
  const working = new Set<string>();
  const evaluate = (id: string): Value => {
    const known = memo.get(id);
    if (known) return known;
    const item = items.get(id);
    if (!item) throw new Error(`The layout has no line ${id}`);
    if (working.has(id)) throw new Error(`The layout refers to line ${id} from itself`);
    working.add(id);
    let value: Value;
    if (item.kind === "untracked") value = { booked: 0n, form: 0n, removed: 0n };
    else if (item.kind === "computed") {
      let booked = 0n;
      let form = 0n;
      for (const [sign, term] of item.terms) {
        const part = evaluate(term);
        const factor = BigInt(sign);
        booked += factor * part.booked;
        form += factor * part.form;
      }
      value = { booked, form, removed: booked - form };
    } else {
      const own = lineAmount(item.id, bookedByLine.get(item.id) ?? 0n);
      let booked = own;
      let form = layout.meals === item.id ? percentOf(own, request.mealsPercent) : own;
      for (const more of item.plus ?? []) {
        const part = evaluate(more);
        booked += part.booked;
        form += part.form;
      }
      value = { booked, form, removed: booked - form };
    }
    working.delete(id);
    memo.set(id, value);
    return value;
  };

  const adjustmentOf = (id: string): TaxLineAdjustment | undefined =>
    layout.meals === id
      ? {
          kind: "meals",
          percent: request.mealsPercent,
          removed: formatMoney(evaluate(id).removed),
          reason: `${request.mealsPercent}% of the cost booked to this line is taken; the instructions give 50% in most cases.`,
        }
      : undefined;

  const lineFor = (item: LayoutItem): TaxWorksheetLine => {
    const value = evaluate(item.id);
    const form = item.id.split(".")[0] ?? "";
    if (item.kind === "tagged") {
      const line = catalog.get(item.id);
      if (!line) throw new Error(`The catalog has no line ${item.id} for ${taxYear}`);
      const note = [line.note, item.more].filter((text) => text).join(" ");
      const adjustment = adjustmentOf(item.id);
      return {
        key: line.id,
        number: line.number,
        label: line.label,
        kind: "tagged",
        form,
        booked: formatMoney(value.booked),
        amount: formatMoney(value.form),
        ...(item.plus && item.plus.length > 0
          ? {
              formula: `Includes ${item.plus
                .map((id) => `Form 1125-A line ${(items.get(id) as ComputedItem).number}`)
                .join(" and ")}`,
            }
          : {}),
        ...(note ? { note } : {}),
        ...(adjustment ? { adjustment } : {}),
        accounts: accountRows.get(item.id) ?? [],
      };
    }
    return {
      key: item.id,
      number: item.number,
      label: item.label,
      kind: item.kind,
      form,
      booked: formatMoney(value.booked),
      amount: formatMoney(value.form),
      ...(item.kind === "computed" ? { formula: item.formula } : { note: item.note }),
      ...(item.id === layout.net ? { net: true } : {}),
      accounts: [],
    };
  };

  const parts: TaxWorksheetPart[] = layout.parts.map((part) => ({
    key: part.key,
    label: part.label,
    form: part.form,
    lines: part.items.map(lineFor),
  }));

  // Reconciliation to the profit and loss of the same range. The net as booked, plus the income and
  // less the expenses of accounts with no line, is the net income the statements print. Every term
  // is exact cents: it either ties or the worksheet is refused.
  const net = evaluate(layout.net);
  const books = profitLossFigures(context.accounts, column).netIncome;
  if (net.booked + unmappedIncome - unmappedExpenses !== books)
    throw doesNotTie("The tax worksheet does not reconcile to the profit and loss");
  const reconciliation: TaxReconciliation = {
    rows: [
      { key: "netProfit", label: netLabel(layout, parts), amount: formatMoney(net.form) },
      ...(layout.meals
        ? [
            {
              key: "meals",
              label: `Less: meals not taken on line 24b (the ${request.mealsPercent}% limit)`,
              amount: formatMoney(net.removed),
            },
          ]
        : []),
      {
        key: "unmappedIncome",
        label: "Add: income on accounts with no line from this form",
        amount: formatMoney(unmappedIncome),
      },
      {
        key: "unmappedExpenses",
        label: "Less: expenses on accounts with no line from this form",
        amount: formatMoney(-unmappedExpenses),
      },
    ],
    netIncomeBooks: formatMoney(books),
    netProfit: formatMoney(net.form),
    ties: true,
  };

  const populationHash = hashCanonical({
    type: "TaxWorksheetPopulation",
    compilerVersion: WORKSHEET_VERSION,
    ledgerPopulationHash: column.populationHash,
    tagMapHash: tags.hash,
    catalogHash: catalogHash(forms),
    form: request.form,
    taxYear: BigInt(taxYear),
    from: range.from,
    to: request.to,
    mealsPercent: BigInt(request.mealsPercent),
  }).digest;

  return {
    compilerVersion: WORKSHEET_VERSION,
    populationHash,
    ledgerPopulationHash: column.populationHash,
    tagMapHash: tags.hash,
    tagsRevision: String(tags.revision),
    bookRevision: state.bookRevision.toString(),
    postingSequence: state.latestPostingSequence.toString(),
    currency: state.identity.functionalCommodityId,
    basis: context.basis,
    taxYear,
    form: formInfo(main),
    forms: forms.map(formInfo),
    from: range.from,
    to: request.to,
    fiscalYear: range.fiscalYear,
    mealsPercent: request.mealsPercent,
    parts,
    unmapped,
    unmappedIncome: formatMoney(unmappedIncome),
    unmappedExpenses: formatMoney(unmappedExpenses),
    reconciliation,
    notes: worksheetNotes({
      form: request.form,
      taxYear,
      basis: context.basis,
      mealsPercent: request.mealsPercent,
      formName: main.name,
      draft: main.status === "draft",
    }),
    warnings: worksheetWarnings({
      request,
      form: main,
      from: range.from,
      unmapped,
      unmappedIncome,
      unmappedExpenses,
    }),
    disclaimer: `${TAX_DISCLAIMER} ${TAX_DISCLAIMER_LONG}`,
  };
}

/** What a person reads next to the last line: "Net profit or (loss), line 31" or "Ordinary business
 * income (loss), line 22", from the layout. */
function netLabel(layout: FormLayout, parts: readonly TaxWorksheetPart[]): string {
  for (const part of parts)
    for (const line of part.lines)
      if (line.key === layout.net) return `${line.label}, line ${line.number}`;
  return "Net";
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

function worksheetWarnings(input: {
  readonly request: WorksheetRequest;
  readonly form: TaxForm;
  readonly from: string;
  readonly unmapped: readonly TaxUnmappedAccount[];
  readonly unmappedIncome: bigint;
  readonly unmappedExpenses: bigint;
}): { code: string; message: string }[] {
  const { request, form } = input;
  const warnings: { code: string; message: string }[] = [];
  if (form.status === "draft")
    warnings.push({
      code: "draft_form",
      message: `The ${request.taxYear} ${form.name} is an IRS early-release draft, not the final form. Confirm the line numbers against the final form before relying on them.`,
    });
  if (input.unmapped.length > 0) {
    const accountCount = new Set(input.unmapped.map((row) => row.accountId)).size;
    warnings.push({
      code: "unmapped_accounts",
      message: `${accountCount} ${plural(accountCount, "account has", "accounts have")} activity in this range and no line from ${form.name} for ${request.taxYear}: income of ${formatMoney(input.unmappedIncome)} and expenses of ${formatMoney(input.unmappedExpenses)} are not on any line above. They are listed below, never guessed. Tag them in your chart of accounts, or take them to whoever prepares the return.`,
    });
  }
  if (request.to > request.today)
    warnings.push({
      code: "year_not_ended",
      message: `This range ends on ${request.to}, after today (${request.today}), so these are the figures so far.`,
    });
  if (request.booksStartOn && request.booksStartOn > input.from)
    warnings.push({
      code: "books_start_late",
      message: `The books start on ${request.booksStartOn} (the cutover date). Activity from ${input.from} to the day before is not in Rastrata, so this covers only part of the range.`,
    });
  if (input.from !== `${request.taxYear}-01-01` || request.to !== `${request.taxYear}-12-31`)
    warnings.push({
      code: "range_not_calendar_year",
      message: `The range is ${input.from} to ${request.to}, not 1 January to 31 December ${request.taxYear}. Check it is the tax year of the return.`,
    });
  return warnings;
}
