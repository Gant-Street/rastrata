import type { ApplicationInputs, ApplicationOutputs } from "@rastrata/application/client-contracts";
import type {
  AtBlockView,
  ChartStepView,
  GapView,
  MappingChoiceView,
  OpeningIssueView,
  TbRowView,
  TieoutReportView,
  XeroAccountView,
  XeroStatusView,
} from "@rastrata/ui/shadow/types";
import { formatDate, formatFiguresInText, transactionsIn } from "@rastrata/ui/format";

/** What the Xero screens show, worked out from what the service said. Pure: no browser, no
 * requests, so every rule here is unit tested. Text that came from a file is passed through
 * untouched (the components show it as text); amounts stay the wire strings. */

type ChartPreview = ApplicationOutputs["xero.chart.preview"];
type TbPreview = ApplicationOutputs["xero.trialBalance.preview"];
type AtPreview = ApplicationOutputs["xero.transactions.preview"];
type Status = ApplicationOutputs["xero.status"];
type TieoutReport = ApplicationOutputs["tieout.report"];
type Gaps = ApplicationOutputs["gaps.list"];
type Choice = NonNullable<ApplicationInputs["xero.mapping.set"]["choices"]>[number];

/** A file's text is held to this many characters before it is looked at. */
export const MAX_FILE_CHARACTERS = 120_000;
/** What one file's text may come to once it is in a request: the service takes 128 KiB for the whole
 * body, and a quote or a new line is written with a backslash, so the text is measured as it is sent. */
export const MAX_REQUEST_TEXT_BYTES = 124_000;
export const requestBytes = (text: string): number =>
  new TextEncoder().encode(JSON.stringify(text)).length;

const label = (code: string, name: string): string => `${code} · ${name}`;

/** The accounts of the book a Xero account may be mapped to: open ones, in code order. */
export function mappingChoices(
  accounts: readonly { id: string; code: string; name: string; closedOn: string | null }[],
): MappingChoiceView[] {
  return accounts
    .filter((account) => account.closedOn === null)
    .map((account) => ({ value: account.id, label: label(account.code, account.name) }))
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

/** A person's decisions: a Xero code to an account id, "skip", or "" for the match to stand. */
export type Decisions = Readonly<Record<string, string>>;

/** The choices to send as overrides: only the codes the person decided. */
export function overridesFrom(decisions: Decisions): Choice[] {
  return Object.entries(decisions)
    .filter(([, value]) => value !== "")
    .map(([xeroCode, value]) =>
      value === "skip" ? { xeroCode, skip: true } : { xeroCode, accountId: value },
    )
    .sort((a, b) => (a.xeroCode < b.xeroCode ? -1 : a.xeroCode > b.xeroCode ? 1 : 0));
}

/** What the choice for a row shows: the person's own decision, else a saved one, else "" (the match
 * as proposed stands). */
function choiceValue(row: ChartPreview["accounts"][number], decisions: Decisions): string {
  const decided = decisions[row.code];
  if (decided !== undefined && decided !== "") return decided;
  if (row.skip && row.basis === "saved") return "skip";
  if (row.basis === "saved" && row.accountId) return row.accountId;
  return "";
}

/** The reasons a Xero account could not be mapped as proposed, in the words the screen uses. */
export const PROBLEM_WORDS: Readonly<Record<string, string>> = {
  target_missing: "The account it was saved for is no longer in the chart.",
  target_closed: "That account is closed.",
  role_differs: "That account is a different kind of account.",
  target_taken: "Another Xero account is already mapped there.",
  unknown_role: "Xero's type is not one Rastrata knows.",
};

const ROLE_WORDS: Readonly<Record<string, string>> = {
  asset: "an asset",
  liability: "a liability",
  equity: "an equity",
  income: "an income",
  expense: "an expense",
};

function suggestionWords(row: ChartPreview["accounts"][number]): string | null {
  const suggestion = row.suggestion;
  if (!suggestion || row.accountId !== null || row.skip) return null;
  const kind = ROLE_WORDS[suggestion.role] ?? "an";
  const like = suggestion.like ? ` like ${suggestion.like}` : "";
  return `Nothing in your book resembles it. Create ${kind} account${like}, then choose it here.`;
}

export function accountViews(preview: ChartPreview, decisions: Decisions): XeroAccountView[] {
  return preview.accounts.map((row) => {
    const mapsTo =
      row.accountId !== null && row.accountCode !== null
        ? label(row.accountCode, row.accountName ?? "")
        : null;
    return {
      code: row.code,
      name: row.name,
      type: row.typeLabel ?? row.type,
      balance: row.balance,
      tags: [
        ...(row.archived ? (["archived"] as const) : []),
        ...(row.system ? (["system"] as const) : []),
        ...(row.bank ? (["bank"] as const) : []),
      ],
      confidence: row.confidence,
      basis: row.basis,
      problems: row.problems.map((problem) => PROBLEM_WORDS[problem] ?? problem),
      suggestion: suggestionWords(row),
      value: choiceValue(row, decisions),
      mapsTo,
      skip: row.skip,
      candidates: row.candidates.map((candidate) => ({
        value: candidate.accountId,
        label: label(candidate.code, candidate.name),
      })),
    };
  });
}

/** Issues in the shape the issue list shows. A file's rows carry the row number. */
export function xeroIssues(
  issues: readonly {
    severity: "error" | "warning" | "info";
    code: string;
    message: string;
    row?: number;
  }[],
): OpeningIssueView[] {
  return issues.map((issue) => ({
    severity: issue.severity,
    code: issue.code,
    message: issue.message,
    ...(issue.row !== undefined ? { row: issue.row } : {}),
  }));
}

/** The columns of a file as it was read, in the order the reader found them. */
export function columnViews(
  columns: readonly { readonly field: string; readonly header: string }[],
): { header: string; field: string }[] {
  return columns.map((column) => ({ header: column.header, field: column.field }));
}

export function chartPreviewView(
  preview: ChartPreview,
  decisions: Decisions,
): NonNullable<ChartStepView["preview"]> {
  return {
    source: preview.source,
    counts: {
      accounts: preview.counts.accounts,
      certain: preview.counts.certain,
      likely: preview.counts.likely,
      check: preview.counts.check,
    },
    rows: accountViews(preview, decisions),
    issues: xeroIssues(preview.issues),
    columns: columnViews(preview.columns),
  };
}

export function statusView(status: Status): XeroStatusView {
  return {
    chartImportedAt: status.chartImportedAt,
    counts: {
      accounts: status.counts.accounts,
      mapped: status.counts.mapped,
      skipped: status.counts.skipped,
      unmapped: status.counts.unmapped,
      unmappedWithBalance: status.counts.unmappedWithBalance,
    },
    trialBalances: status.trialBalances,
    transactions: status.transactions.map((range) => ({ ...range })),
    reconciled: status.reconciled.map((entry) => ({
      code: entry.code,
      name: entry.name,
      through: entry.through,
    })),
    notes: status.notes.map((note) => formatFiguresInText(note)),
  };
}

// ---- The trial balance ------------------------------------------------------------------------

export function tbRows(preview: TbPreview): TbRowView[] {
  return preview.rows.map((row) => ({
    row: row.row,
    xeroCode: row.xeroCode,
    name: row.name,
    net: row.net,
    status: row.status,
    mapsTo: row.accountCode !== null ? label(row.accountCode, row.accountName ?? "") : null,
    balance: row.balance,
  }));
}

/** What the trial balance's date means for the cutover, in words; null when there is no cutover. */
export function cutoverNote(preview: TbPreview): string | null {
  const cutover = preview.cutover;
  if (!cutover || preview.asOf === null) return null;
  return cutover.asOfIsDayBefore
    ? `That is the day before the start date, ${formatDate(cutover.date)}: right for opening balances.`
    : `The start date is ${formatDate(cutover.date)}, so opening balances want a trial balance as at ${formatDate(cutover.dayBefore)}. This one is as at ${formatDate(preview.asOf)}: it is right for the comparison, not for opening balances.`;
}

/** Whether the balances can be taken to the opening balances screen: the file balances, has
 * something mapped, and is as at the day before the cutover. */
export function canUseAsOpening(preview: TbPreview | undefined): boolean {
  return (
    preview?.balanced === true &&
    preview.balances.length > 0 &&
    preview.cutover?.asOfIsDayBefore === true &&
    !preview.issues.some((issue) => issue.severity === "error")
  );
}

/** A file that cannot be kept: it does not balance or has an error. Rows that could not be read are
 * the person's decision (see `skipUnreadable`), so they do not block the preview. */
export function canKeepTrialBalance(preview: TbPreview | undefined): boolean {
  return preview?.balanced === true && preview.rows.length > 0;
}

// ---- The account transactions -----------------------------------------------------------------

export function atBlocks(preview: AtPreview): AtBlockView[] {
  return preview.blocks.map((block) => {
    const hasTotals = block.fileDebit !== null && block.fileCredit !== null;
    return {
      heading: block.heading,
      xeroCode: block.xeroCode,
      name: block.name,
      status: block.status,
      mapsTo: block.accountCode !== null ? label(block.accountCode, block.accountName ?? "") : null,
      lines: block.lines,
      debit: block.debit,
      credit: block.credit,
      fileDebit: block.fileDebit,
      fileCredit: block.fileCredit,
      agrees: hasTotals
        ? block.fileDebit === block.debit && block.fileCredit === block.credit
        : null,
      sample: block.sample.map((line) => ({
        date: line.date,
        description: line.description,
        reference: line.reference,
        debit: line.debit,
        credit: line.credit,
      })),
    };
  });
}

// ---- Where Xero was reconciled ----------------------------------------------------------------

/** The Xero bank accounts to ask a date for: those the chart says are bank accounts, and any that
 * already have a date. The typed value is the person's; until they type, the saved one shows. */
export function reconciledRows(
  chart: ChartPreview | undefined,
  saved: readonly { code: string; name: string | null; through: string }[],
  typed: Readonly<Record<string, string>>,
): { code: string; name: string; through: string }[] {
  const byCode = new Map<string, { code: string; name: string; through: string }>();
  for (const account of chart?.accounts ?? [])
    if (account.bank)
      byCode.set(account.code, {
        code: account.code,
        name: account.name,
        through: typed[account.code] ?? "",
      });
  for (const entry of saved) {
    const known = byCode.get(entry.code);
    byCode.set(entry.code, {
      code: entry.code,
      name: known?.name ?? entry.name ?? entry.code,
      through: typed[entry.code] ?? entry.through,
    });
  }
  for (const [code, value] of Object.entries(typed))
    if (!byCode.has(code)) byCode.set(code, { code, name: code, through: value });
  return [...byCode.values()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const isDateText = (value: string): boolean => DATE.test(value);

/** The reconciled dates to save, and the ones to clear, from what was typed against what is saved.
 * An empty box clears a saved date; a changed one is saved; an unchanged one is left alone. */
export function reconciledChanges(
  saved: readonly { code: string; through: string }[],
  typed: Readonly<Record<string, string>>,
): { choices: { code: string; through: string }[]; clear: string[]; bad: string[] } {
  const known = new Map(saved.map((entry) => [entry.code, entry.through]));
  const choices: { code: string; through: string }[] = [];
  const clear: string[] = [];
  const bad: string[] = [];
  for (const [code, value] of Object.entries(typed)) {
    const was = known.get(code);
    if (value === "") {
      if (was !== undefined) clear.push(code);
    } else if (!isDateText(value)) bad.push(code);
    else if (value !== was) choices.push({ code, through: value });
  }
  return { choices, clear, bad };
}

// ---- The comparison -----------------------------------------------------------------------------

export function tieoutView(report: TieoutReport): TieoutReportView {
  return {
    currency: report.currency,
    basis: report.basis,
    cutoverDate: report.cutoverDate,
    summary: { ...report.summary },
    periods: report.periods.map((period) => ({
      from: period.from,
      to: period.to,
      xeroReconciled: period.xeroReconciled,
      notReconciled: period.notReconciled.map((bank) => ({
        code: bank.code,
        name: bank.name,
        through: bank.through,
      })),
      accounts: period.accounts.map((account) => ({
        accountId: account.accountId,
        code: account.code,
        name: account.name,
        basis: account.basis,
        status: account.status,
        reason: account.reason?.message ?? null,
        xero: account.xero,
        rastrata: account.rastrata,
        difference: account.difference,
        carried: account.carried,
        residual: account.residual,
        explained: account.explained,
        matched: account.matched,
        unmatchedCount: account.unmatchedCount,
        unmatched: (account.unmatched ?? []).map((line) => ({ ...line })),
      })),
      unmapped: period.unmapped.map((row) => ({ code: row.code, name: row.name, net: row.net })),
    })),
    notes: report.notes.map((note) => formatFiguresInText(note)),
  };
}

/** A days-apart box: a whole number from 0 to 14, or empty for the default. */
export function readTolerance(
  text: string,
): { ok: true; days: number | undefined } | { ok: false } {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, days: undefined };
  if (!/^\d{1,2}$/.test(trimmed)) return { ok: false };
  const days = Number(trimmed);
  return days >= 0 && days <= 14 ? { ok: true, days } : { ok: false };
}

// ---- The gap log --------------------------------------------------------------------------------

/** A gap that has not changed since the last reading is the same object as before, so the screen
 * does not make its card again (and lose a note being written in it) when another gap changes. */
export function stableGaps(): (gaps: readonly GapView[]) => GapView[] {
  let known = new Map<number, { readonly json: string; readonly gap: GapView }>();
  return (gaps) => {
    const next = new Map<number, { readonly json: string; readonly gap: GapView }>();
    const kept = gaps.map((gap) => {
      const json = JSON.stringify(gap);
      const before = known.get(gap.id);
      const same = before !== undefined && before.json === json ? before.gap : gap;
      next.set(gap.id, { json, gap: same });
      return same;
    });
    known = next;
    return kept;
  };
}

/** What a gap says. One the comparison found is written by the service, in its words and with year-month-day dates
 * ("a line in Xero and not in Rastrata, 2026-08-14"): the screen says it the way it says everything else. One a
 * person added is written by them, and stays as they typed it. */
const saidBy = (gap: Gaps["gaps"][number], text: string): string =>
  gap.source === "manual" ? text : formatFiguresInText(transactionsIn(text));

export function gapViews(list: Gaps): GapView[] {
  return list.gaps.map((gap) => ({
    id: gap.id,
    kind: gap.kind,
    title: saidBy(gap, gap.title),
    detail: saidBy(gap, gap.detail),
    source: gap.source,
    status: gap.status,
    openedAt: gap.openedAt,
    openedBy: gap.openedBy,
    closedAt: gap.closedAt,
    closedBy: gap.closedBy,
    resolution: gap.resolution,
  }));
}
