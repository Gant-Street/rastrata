/** The Xero import: reading a chart, a trial balance and account transactions that were exported from
 * Xero, mapping Xero's accounts onto the book's chart, and keeping what is needed for the tie-out.
 *
 * Every file is hostile text read by the pure readers in `shadow/xero/`, which report what they could
 * not read row by row. A preview changes nothing. An import stores what was read, refuses a file
 * that has errors unless the caller says to skip the unreadable rows, and never refuses by guessing:
 * a file that does not balance, or has no header, is not imported at all.
 *
 * Mappings are the owner's decisions about which account of the book each Xero account is. They are
 * kept apart from the files, so a new export of the same chart does not lose them. */
import { describePrincipal } from "../../agent/principal.ts";
import type {
  XeroAccountRow,
  XeroAtBlock,
  XeroAtImported,
  XeroAtInput,
  XeroAtPreview,
  XeroChartImportInput,
  XeroChartImported,
  XeroChartInput,
  XeroChartPreview,
  XeroChoice,
  XeroMappingCounts,
  XeroMappingInput,
  XeroMappingResult,
  XeroReconciled,
  XeroReconciledInput,
  XeroStatus,
  XeroTbImported,
  XeroTbInput,
  XeroTbPreview,
  XeroTbRow,
} from "../../client-contracts.gen.ts";
import { ApplicationError } from "../../errors.ts";
import { sha256Hex } from "../../ingest/hash.ts";
import { formatMoney } from "../../money.ts";
import { addDays } from "../../reports/dates.ts";
import { isCalendarDate, isProfitLoss, resolveOffset, sideOf } from "../../shadow/opening.ts";
import { type XeroAccount, parseXeroChart } from "../../shadow/xero/chart.ts";
import {
  type BookAccount,
  type Choice,
  type Proposal,
  matchChart,
} from "../../shadow/xero/mapping.ts";
import type { XeroIssue } from "../../shadow/xero/report.ts";
import { parseXeroTrialBalance } from "../../shadow/xero/trial-balance.ts";
import { parseXeroTransactions } from "../../shadow/xero/transactions.ts";
import { xeroType } from "../../shadow/xero/types.ts";
import type { SliceContext } from "../types.ts";
import { type Chart, readChart } from "./chart.ts";
import { shadowStore, xeroStore } from "./store.ts";
import type { FileInput } from "./xero-store.ts";

// ---- Shared -------------------------------------------------------------------------------------

const lower = (code: string): string => code.trim().toLowerCase();
const normalName = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, " ");
const money = (cents: bigint): string => formatMoney(cents);

/** Errors the caller may choose to skip: rows that were left out. Everything else about a file that
 * is wrong makes it unusable, so it is never imported. */
const SKIPPABLE = new Set([
  "amount_unreadable",
  "missing_code_or_name",
  "duplicate_code",
  "row_unrecognised",
  "line_outside_block",
]);

function bookAccounts(chart: Chart): BookAccount[] {
  return chart.accounts.map((account) => ({
    id: account.id,
    code: account.code,
    name: account.name,
    role: account.role,
    closedOn: account.closedOn,
    roleKey: account.roleKey,
  }));
}

function choices(list: readonly XeroChoice[] | undefined): Map<string, Choice> {
  const map = new Map<string, Choice>();
  for (const item of list ?? []) {
    if ((item.accountId === undefined) === (item.skip !== true))
      throw new ApplicationError(
        "invalid_input",
        `Give either an accountId or skip for ${item.xeroCode}, not both and not neither`,
        400,
      );
    map.set(lower(item.xeroCode), {
      accountId: item.skip === true ? null : (item.accountId ?? null),
      skip: item.skip === true,
    });
  }
  return map;
}

function refuseUnusable(issues: readonly XeroIssue[], skipUnreadable: boolean, what: string): void {
  const errors = issues.filter((issue) => issue.severity === "error");
  if (errors.length === 0) return;
  const unskippable = errors.filter((issue) => !SKIPPABLE.has(issue.code.replace(/_more$/, "")));
  if (unskippable.length > 0 || !skipUnreadable)
    throw new ApplicationError(
      unskippable.length > 0 ? "xero_file_unusable" : "xero_file_has_errors",
      `The ${what} was not imported. ${errors[0]?.message ?? ""}${
        errors.length > 1 ? ` (${errors.length} problems in all; preview the file to see them)` : ""
      }${unskippable.length === 0 ? " To import it without the rows that cannot be read, set skipUnreadable to true (--skip-unreadable on the command line)." : ""}`,
      422,
    );
}

function fileInput(
  context: SliceContext,
  kind: FileInput["kind"],
  fields: {
    readonly text: string;
    readonly name: string | undefined;
    readonly organisation: string | null;
    readonly rows: number;
    readonly asOf?: string | null;
    readonly from?: string | null;
    readonly to?: string | null;
  },
): FileInput {
  return {
    kind,
    sha256: sha256Hex(fields.text),
    name: fields.name ?? "",
    organisation: fields.organisation,
    asOf: fields.asOf ?? null,
    from: fields.from ?? null,
    to: fields.to ?? null,
    rows: fields.rows,
    importedAt: context.service.now(),
    operationId: context.operationId,
    principal: describePrincipal(context.access.principal),
  };
}

const safeName = (name: string | undefined): string | null =>
  name === undefined ? null : name.replace(/[^\p{L}\p{N} ._()-]/gu, "_").slice(0, 200);

// ---- The chart ----------------------------------------------------------------------------------

function countOf(proposals: readonly Proposal[]): XeroMappingCounts {
  const mapped = proposals.filter((item) => item.accountId !== null);
  const skipped = proposals.filter((item) => item.skip);
  const unmapped = proposals.filter((item) => item.accountId === null && !item.skip);
  return {
    accounts: proposals.length,
    mapped: mapped.length,
    skipped: skipped.length,
    unmapped: unmapped.length,
    unmappedWithBalance: unmapped.filter(
      (item) => item.xero.balance !== null && item.xero.balance !== "0.00",
    ).length,
    bank: proposals.filter((item) => item.xero.bank).length,
    certain: mapped.filter((item) => item.confidence === "certain").length,
    likely: mapped.filter((item) => item.confidence === "likely").length,
    check: unmapped.filter((item) => item.candidates.length > 0).length,
  };
}

function accountRow(proposal: Proposal, byId: ReadonlyMap<string, BookAccount>): XeroAccountRow {
  const target = proposal.accountId === null ? undefined : byId.get(proposal.accountId);
  return {
    row: proposal.xero.row,
    code: proposal.xero.code,
    name: proposal.xero.name,
    type: proposal.xero.type,
    typeLabel: proposal.xero.typeLabel,
    role: proposal.xero.role,
    bank: proposal.xero.bank,
    system: proposal.xero.system,
    taxCode: proposal.xero.taxCode,
    balance: proposal.xero.balance,
    archived: proposal.xero.archived,
    accountId: target?.id ?? null,
    accountCode: target?.code ?? null,
    accountName: target?.name ?? null,
    skip: proposal.skip,
    basis: proposal.basis,
    confidence: proposal.confidence,
    candidates: proposal.candidates.flatMap((id) => {
      const found = byId.get(id);
      return found ? [{ accountId: found.id, code: found.code, name: found.name }] : [];
    }),
    problems: [...proposal.problems],
    suggestion: proposal.suggestion
      ? {
          role: proposal.suggestion.role,
          cashFlowClass: proposal.suggestion.cashFlowClass,
          roleKey: proposal.suggestion.roleKey,
          like: proposal.suggestion.like,
        }
      : null,
  };
}

function storedAccounts(context: SliceContext): XeroAccount[] {
  return xeroStore(context.service)
    .accounts()
    .map((account) => ({ ...account }));
}

interface ChartRead {
  readonly accounts: readonly XeroAccount[];
  readonly issues: readonly XeroIssue[];
  readonly columns: Readonly<Record<string, string>>;
  readonly rows: number;
}

function readChartInput(text: string, decimal: "." | "," | undefined): ChartRead {
  const parsed = parseXeroChart(text, decimal ? { decimal } : {});
  return {
    accounts: parsed.accounts,
    issues: parsed.issues,
    columns: parsed.columns,
    rows: parsed.rows,
  };
}

async function chartPreview(
  context: SliceContext,
  input: XeroChartInput,
  extra: { readonly saved?: ReadonlyMap<string, Choice> } = {},
): Promise<XeroChartPreview> {
  const store = xeroStore(context.service);
  const book = await readChart(context);
  const accounts = bookAccounts(book);
  let read: ChartRead;
  let sha: string | null = null;
  let importedAt: string | null = null;
  const source = input.text !== undefined ? "file" : "stored";
  if (input.text !== undefined) {
    read = readChartInput(input.text, input.decimal);
    sha = sha256Hex(input.text);
  } else {
    const stored = storedAccounts(context);
    if (stored.length === 0)
      throw new ApplicationError(
        "xero_chart_missing",
        "No Xero chart has been imported yet. Give the chart's CSV text.",
        404,
      );
    read = { accounts: stored, issues: [], columns: {}, rows: stored.length };
    const latest = store.files(1000).find((file) => file.kind === "chart");
    sha = latest?.sha256 ?? null;
    importedAt = latest?.importedAt ?? null;
  }
  const proposals = matchChart({
    xero: read.accounts,
    book: accounts,
    saved: extra.saved ?? store.mapping(),
    overrides: choices(input.overrides),
    flowOf: (account) => xeroType(account.type)?.flow ?? null,
  });
  const byId = new Map(accounts.map((account) => [account.id, account]));
  return {
    source,
    name: safeName(input.name),
    sha256: sha,
    importedAt,
    rows: read.rows,
    columns: Object.entries(read.columns).map(([field, header]) => ({ field, header })),
    accounts: proposals.map((proposal) => accountRow(proposal, byId)),
    counts: countOf(proposals),
    issues: read.issues.map((issue) => ({ ...issue })),
  };
}

export const previewChart = (
  context: SliceContext,
  input: XeroChartInput,
): Promise<XeroChartPreview> => chartPreview(context, input);

export async function importChart(
  context: SliceContext,
  input: XeroChartImportInput,
): Promise<XeroChartImported> {
  const store = xeroStore(context.service);
  const read = readChartInput(input.text, input.decimal);
  refuseUnusable(read.issues, input.skipUnreadable === true, "Xero chart");
  const before = await chartPreview(context, { ...input });
  const accept = input.accept ?? "certain";
  const meta = {
    setAt: context.service.now(),
    principal: describePrincipal(context.access.principal),
  };
  const toSave: { code: string; choice: Choice }[] = [];
  const overrides = choices(input.overrides);
  for (const row of before.accounts) {
    const decided = overrides.get(lower(row.code));
    if (decided) {
      toSave.push({ code: row.code, choice: decided });
      continue;
    }
    const sure =
      row.accountId !== null &&
      row.basis !== "saved" &&
      (row.confidence === "certain" || (accept === "likely" && row.confidence === "likely"));
    if (accept !== "none" && sure && row.accountId !== null)
      toSave.push({ code: row.code, choice: { accountId: row.accountId, skip: false } });
  }
  const latest = store.files(1000).find((file) => file.kind === "chart");
  const sha = sha256Hex(input.text);
  const replaced = latest !== undefined;
  if (latest?.sha256 !== sha)
    store.replaceChart(
      fileInput(context, "chart", {
        text: input.text,
        name: safeName(input.name) ?? "",
        organisation: null,
        rows: read.rows,
      }),
      read.accounts,
    );
  // Choices are saved against the chart just stored, so every code is known.
  store.saveChoices(toSave, meta);
  const after = await chartPreview(context, {});
  return {
    preview: {
      ...after,
      source: "file",
      name: safeName(input.name),
      sha256: sha,
      rows: before.rows,
      columns: before.columns,
      issues: before.issues,
    },
    saved: toSave.length,
    replaced,
  };
}

export async function setMapping(
  context: SliceContext,
  input: XeroMappingInput,
): Promise<XeroMappingResult> {
  const store = xeroStore(context.service);
  const known = new Set(store.accounts().map((account) => lower(account.code)));
  const book = await readChart(context);
  const byId = new Map(book.accounts.map((account) => [account.id, account]));
  const wanted = choices(input.choices);
  if (known.size === 0 && (wanted.size > 0 || (input.clear ?? []).length > 0))
    throw new ApplicationError(
      "xero_chart_missing",
      "Import the Xero chart before mapping its accounts.",
      409,
    );
  const toSave: { code: string; choice: Choice }[] = [];
  for (const [code, choice] of wanted) {
    if (!known.has(code))
      throw new ApplicationError("xero_code_unknown", `The Xero chart has no account ${code}`, 404);
    if (!choice.skip) {
      const target = choice.accountId === null ? undefined : byId.get(choice.accountId);
      if (!target)
        throw new ApplicationError(
          "account_not_found",
          `The book has no account ${choice.accountId}`,
          404,
        );
      if (target.closedOn !== null)
        throw new ApplicationError(
          "account_closed",
          `Account ${target.code} ${target.name} is closed`,
          409,
        );
    }
    toSave.push({ code, choice });
  }
  store.saveChoices(toSave, {
    setAt: context.service.now(),
    principal: describePrincipal(context.access.principal),
  });
  const cleared = store.clearChoices(input.clear ?? []);
  const preview = await chartPreview(context, {});
  return { saved: toSave.length, cleared, counts: preview.counts };
}

// ---- Resolving the accounts of a trial balance or a transaction report -------------------------

interface Resolved {
  readonly xero: XeroAccount;
  /** The account the file named, by the chart's code. */
  readonly known: boolean;
}

/** The Xero account a line of a report is: by its code, else by its name in the chart; with no chart,
 * an account made from what the report says. A report row with no code that the chart does not
 * name cannot be mapped (the mapping is by code). */
function resolveXero(
  chart: readonly XeroAccount[],
  code: string | null,
  name: string,
  typeText: string | null,
  row: number,
): Resolved {
  const byCode = new Map(chart.map((account) => [lower(account.code), account]));
  const byName = new Map(chart.map((account) => [normalName(account.name), account]));
  const found =
    (code !== null ? byCode.get(lower(code)) : undefined) ?? byName.get(normalName(name));
  if (found) return { xero: found, known: true };
  const type = typeText ? xeroType(typeText) : null;
  return {
    known: false,
    xero: {
      code: code ?? "",
      name,
      type: typeText ?? "",
      typeLabel: type?.label ?? null,
      role: type?.role ?? null,
      bank: type?.bank ?? false,
      system: type?.system ?? false,
      taxCode: "",
      description: "",
      balance: null,
      archived: false,
      row,
    },
  };
}

// ---- The trial balance --------------------------------------------------------------------------

const RETAINED = /\bretained earnings\b/i;

async function trialBalancePreview(
  context: SliceContext,
  input: XeroTbInput,
): Promise<{
  readonly preview: XeroTbPreview;
  readonly parsed: ReturnType<typeof parseXeroTrialBalance>;
}> {
  const parsed = parseXeroTrialBalance(input.text, {
    ...(input.decimal ? { decimal: input.decimal } : {}),
    ...(input.dateOrder ? { dateOrder: input.dateOrder } : {}),
  });
  const store = xeroStore(context.service);
  const book = await readChart(context);
  const accounts = bookAccounts(book);
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const chart = storedAccounts(context);
  const issues: XeroIssue[] = [...parsed.issues];
  const asOf = input.asOf ?? parsed.asOf;
  if (input.asOf !== undefined && parsed.asOf !== null && input.asOf !== parsed.asOf)
    issues.push({
      severity: "warning",
      code: "date_differs",
      message: `The file says it is as at ${parsed.asOf}; ${input.asOf} was given and is used.`,
    });

  // Which Xero account each row is, and which account of the book it maps to.
  const resolved = parsed.rows.map((row) =>
    resolveXero(chart, row.code, row.name, row.type, row.row),
  );
  const present: XeroAccount[] = [];
  const seen = new Set<string>();
  for (const item of resolved)
    if (item.xero.code !== "" && !seen.has(lower(item.xero.code))) {
      seen.add(lower(item.xero.code));
      present.push(item.xero);
    }
  const proposals = new Map(
    matchChart({
      xero: present,
      book: accounts,
      saved: store.mapping(),
      overrides: choices(input.overrides),
      flowOf: (account) => xeroType(account.type)?.flow ?? null,
    }).map((proposal) => [lower(proposal.xero.code), proposal]),
  );

  const useYear = parsed.layout !== "period" && parsed.layout !== null;
  // The account that will carry what the balances do not explain; no balance may be put on it.
  const offsetChoice = resolveOffset(
    accounts.map((account) => ({ ...account, openedOn: "0000-01-01" })),
    undefined,
  );
  const offset = "account" in offsetChoice ? offsetChoice.account : null;
  const rows: XeroTbRow[] = [];
  const balances = new Map<string, bigint>();
  const left = {
    profitLoss: 0,
    profitLossNet: 0n,
    unmapped: 0,
    unmappedNet: 0n,
    skipped: 0,
    skippedNet: 0n,
    retainedEarnings: 0n,
  };
  const banks: string[] = [];
  let sumNet = 0n;
  parsed.rows.forEach((row, index) => {
    const item = resolved[index];
    const net = useYear ? row.ytdDebit - row.ytdCredit : row.debit - row.credit;
    sumNet += net;
    const proposal =
      item && item.xero.code !== "" ? proposals.get(lower(item.xero.code)) : undefined;
    const target = proposal?.accountId ? byId.get(proposal.accountId) : undefined;
    let status: XeroTbRow["status"];
    let balance: string | null = null;
    if (net === 0n) status = "zero";
    else if (proposal?.skip) {
      status = "skipped";
      left.skipped++;
      left.skippedNet += net;
    } else if (target) {
      if (isProfitLoss(target.role) && input.includeProfitLoss !== true) {
        status = "profit_loss";
        left.profitLoss++;
        left.profitLossNet += net;
      } else if (offset && target.id === offset.id) {
        status = "unmapped";
        left.unmapped++;
        left.unmappedNet += net;
        issues.push({
          severity: "warning",
          code: "mapped_to_offset",
          message: `Row ${row.row}: ${row.name} is mapped to ${target.code} ${target.name}, the account that carries the difference, which cannot take a balance of its own. Map it to another account or leave it out.`,
          row: row.row,
        });
      } else {
        status = "mapped";
        const natural = sideOf(target.role) === "debit" ? net : -net;
        balance = money(natural);
        balances.set(target.id, (balances.get(target.id) ?? 0n) + natural);
      }
    } else if (
      RETAINED.test(row.name) ||
      (item?.xero.type ?? "").toLowerCase() === "retained earnings"
    ) {
      status = "retained_earnings";
      left.retainedEarnings += net;
    } else {
      status = "unmapped";
      left.unmapped++;
      left.unmappedNet += net;
    }
    if (item?.xero.bank && net !== 0n) banks.push(row.name);
    rows.push({
      row: row.row,
      section: row.section,
      xeroCode: item && item.xero.code !== "" ? item.xero.code : null,
      name: row.name,
      type: row.type,
      net: money(net),
      status,
      accountId: target?.id ?? null,
      accountCode: target?.code ?? null,
      accountName: target?.name ?? null,
      balance,
    });
  });

  if (left.unmapped > 0)
    issues.push({
      severity: "warning",
      code: "unmapped_balances",
      message: `${left.unmapped} Xero account${left.unmapped === 1 ? "" : "s"} with a balance (${money(left.unmappedNet)} net, debits less credits) ${left.unmapped === 1 ? "is" : "are"} not mapped to an account of the book. Map ${left.unmapped === 1 ? "it" : "them"} or leave ${left.unmapped === 1 ? "it" : "them"} out; until then the balance lands in the offset account.`,
    });
  if (banks.length > 0)
    issues.push({
      severity: "warning",
      code: "bank_balances_are_books",
      message: `${banks.slice(0, 4).join(", ")}${banks.length > 4 ? " and more" : ""} ${banks.length === 1 ? "is a bank account" : "are bank accounts"} in Xero. Xero's balance is the books' balance, not the statement's: for each bank, card and Stripe account, use the statement balance at the end of the day before the cutover date.`,
    });
  const cutover = shadowStore(context.service).cutover();
  let cutoverView: XeroTbPreview["cutover"] = null;
  if (cutover) {
    const dayBefore = addDays(cutover.cutoverOn, -1);
    cutoverView = {
      date: cutover.cutoverOn,
      dayBefore,
      asOfIsDayBefore: asOf === dayBefore,
    };
    if (asOf !== null && asOf !== dayBefore)
      issues.push({
        severity: "warning",
        code: "date_is_not_the_day_before",
        message: `The trial balance is as at ${asOf}. The opening entry is dated ${cutover.cutoverOn} and holds the balances at the end of ${dayBefore}: use a trial balance as at ${dayBefore}.`,
      });
  } else
    issues.push({
      severity: "info",
      code: "no_cutover",
      message:
        "No cutover date is recorded yet, so the date of this trial balance was not checked.",
    });

  const total = (value: bigint): string => money(value);
  const preview: XeroTbPreview = {
    name: safeName(input.name),
    sha256: sha256Hex(input.text),
    organisation: parsed.organisation,
    asOf,
    layout: parsed.layout,
    rows,
    sums: {
      debit: total(parsed.sums.debit),
      credit: total(parsed.sums.credit),
      ytdDebit: total(parsed.sums.ytdDebit),
      ytdCredit: total(parsed.sums.ytdCredit),
    },
    fileTotals: parsed.fileTotals
      ? {
          debit: total(parsed.fileTotals.debit),
          credit: total(parsed.fileTotals.credit),
          ytdDebit: total(parsed.fileTotals.ytdDebit),
          ytdCredit: total(parsed.fileTotals.ytdCredit),
        }
      : null,
    balanced: parsed.balanced && sumNet === 0n,
    balances: [...balances.entries()]
      .filter(([, cents]) => cents !== 0n)
      .map(([accountId, cents]) => ({ accountId, balance: money(cents) })),
    leftOut: {
      profitLoss: left.profitLoss,
      profitLossNet: money(left.profitLossNet),
      unmapped: left.unmapped,
      unmappedNet: money(left.unmappedNet),
      skipped: left.skipped,
      skippedNet: money(left.skippedNet),
      retainedEarnings: money(left.retainedEarnings),
    },
    cutover: cutoverView,
    columns: Object.entries(parsed.columns).map(([field, header]) => ({ field, header })),
    issues: issues.map((issue) => ({ ...issue })),
  };
  return { preview, parsed };
}

export async function previewTrialBalance(
  context: SliceContext,
  input: XeroTbInput,
): Promise<XeroTbPreview> {
  return (await trialBalancePreview(context, input)).preview;
}

export async function importTrialBalance(
  context: SliceContext,
  input: XeroTbInput,
): Promise<XeroTbImported> {
  const { preview, parsed } = await trialBalancePreview(context, input);
  refuseUnusable(preview.issues, input.skipUnreadable === true, "trial balance");
  if (preview.asOf === null || !isCalendarDate(preview.asOf))
    throw new ApplicationError(
      "xero_date_missing",
      "The file does not say what date the trial balance is as at. Give it as asOf.",
      422,
    );
  if (!preview.balanced)
    throw new ApplicationError(
      "xero_file_unusable",
      "The trial balance does not balance, so it was not imported. Preview it to see why.",
      422,
    );
  const store = xeroStore(context.service);
  const { replaced } = store.replaceTrialBalance(
    fileInput(context, "trial_balance", {
      text: input.text,
      name: safeName(input.name) ?? "",
      organisation: parsed.organisation,
      rows: parsed.rows.length,
      asOf: preview.asOf,
    }),
    preview.asOf,
    parsed.rows,
  );
  return { preview, replaced };
}

// ---- The account transactions -------------------------------------------------------------------

async function transactionsPreview(
  context: SliceContext,
  input: XeroAtInput,
): Promise<{
  readonly preview: XeroAtPreview;
  readonly parsed: ReturnType<typeof parseXeroTransactions>;
  readonly keyed: readonly { readonly xeroCode: string | null }[];
}> {
  const parsed = parseXeroTransactions(input.text, {
    ...(input.decimal ? { decimal: input.decimal } : {}),
    ...(input.dateOrder ? { dateOrder: input.dateOrder } : {}),
  });
  const store = xeroStore(context.service);
  const book = await readChart(context);
  const accounts = bookAccounts(book);
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const chart = storedAccounts(context);
  const issues: XeroIssue[] = [...parsed.issues];
  const resolved = parsed.blocks.map((block) =>
    resolveXero(chart, block.code, block.name, null, block.row),
  );
  const present: XeroAccount[] = [];
  const seen = new Set<string>();
  for (const item of resolved)
    if (item.xero.code !== "" && !seen.has(lower(item.xero.code))) {
      seen.add(lower(item.xero.code));
      present.push(item.xero);
    }
  const proposals = new Map(
    matchChart({
      xero: present,
      book: accounts,
      saved: store.mapping(),
      overrides: new Map(),
      flowOf: () => null,
    }).map((proposal) => [lower(proposal.xero.code), proposal]),
  );
  const blocks: XeroAtBlock[] = parsed.blocks.map((block, index) => {
    const item = resolved[index];
    const code = item && item.xero.code !== "" ? item.xero.code : null;
    const proposal = code ? proposals.get(lower(code)) : undefined;
    const target = proposal?.accountId ? byId.get(proposal.accountId) : undefined;
    return {
      heading: block.heading,
      xeroCode: code,
      name: block.name,
      status: proposal?.skip ? "skipped" : target ? "mapped" : "unmapped",
      accountId: target?.id ?? null,
      accountCode: target?.code ?? null,
      accountName: target?.name ?? null,
      lines: block.lines.length,
      debit: money(block.debit),
      credit: money(block.credit),
      fileDebit: block.fileDebit === null ? null : money(block.fileDebit),
      fileCredit: block.fileCredit === null ? null : money(block.fileCredit),
      sample: block.lines.slice(0, 4).map((line) => ({
        row: line.row,
        date: line.date,
        source: line.source,
        description: line.description,
        reference: line.reference,
        debit: money(line.debit),
        credit: money(line.credit),
      })),
    };
  });
  const unmapped = blocks.filter((block) => block.status === "unmapped" && block.lines > 0);
  if (unmapped.length > 0)
    issues.push({
      severity: "warning",
      code: "unmapped_accounts",
      message: `${unmapped.length} account${unmapped.length === 1 ? "" : "s"} in the file ${unmapped.length === 1 ? "is" : "are"} not mapped to an account of the book (${unmapped
        .slice(0, 3)
        .map((block) => block.name)
        .join(
          ", ",
        )}${unmapped.length > 3 ? ", and more" : ""}). The tie-out cannot compare ${unmapped.length === 1 ? "it" : "them"} until mapped.`,
    });
  if (chart.length === 0 && parsed.blocks.length > 0)
    issues.push({
      severity: "warning",
      code: "no_chart",
      message:
        "No Xero chart has been imported, so accounts are matched by the name the file gives. Import the chart first to map them reliably.",
    });
  const preview: XeroAtPreview = {
    name: safeName(input.name),
    sha256: sha256Hex(input.text),
    organisation: parsed.organisation,
    periodFrom: parsed.periodFrom,
    periodTo: parsed.periodTo,
    blocks,
    lineCount: parsed.lineCount,
    columns: Object.entries(parsed.columns).map(([field, header]) => ({ field, header })),
    issues: issues.map((issue) => ({ ...issue })),
  };
  return { preview, parsed, keyed: blocks.map((block) => ({ xeroCode: block.xeroCode })) };
}

export async function previewTransactions(
  context: SliceContext,
  input: XeroAtInput,
): Promise<XeroAtPreview> {
  return (await transactionsPreview(context, input)).preview;
}

export async function importTransactions(
  context: SliceContext,
  input: XeroAtInput,
): Promise<XeroAtImported> {
  const { preview, parsed, keyed } = await transactionsPreview(context, input);
  refuseUnusable(preview.issues, input.skipUnreadable === true, "account transactions file");
  const dates = parsed.blocks.flatMap((block) => block.lines.map((line) => line.date)).sort();
  const from = parsed.periodFrom ?? dates[0] ?? null;
  const to = parsed.periodTo ?? dates[dates.length - 1] ?? null;
  if (from === null || to === null)
    throw new ApplicationError(
      "xero_file_unusable",
      "The file has no transactions and no period, so there is nothing to import.",
      422,
    );
  const store = xeroStore(context.service);
  const blocks = parsed.blocks.map((block, index) => ({
    ...block,
    code: keyed[index]?.xeroCode ?? block.code,
    key: block.heading,
  }));
  const result = store.replaceTransactions(
    fileInput(context, "transactions", {
      text: input.text,
      name: safeName(input.name) ?? "",
      organisation: parsed.organisation,
      rows: parsed.lineCount,
      from,
      to,
    }),
    blocks,
    from,
    to,
  );
  return { preview, stored: result.stored, replaced: result.replaced };
}

// ---- Where Xero was reconciled ----------------------------------------------------------------

function reconciledState(context: SliceContext): XeroReconciled {
  const store = xeroStore(context.service);
  const names = new Map(store.accounts().map((account) => [lower(account.code), account.name]));
  return {
    entries: store.reconciled().map((row) => ({
      code: row.code,
      name: names.get(lower(row.code)) ?? null,
      through: row.through,
      note: row.note,
      setAt: row.setAt,
    })),
  };
}

export function setReconciled(context: SliceContext, input: XeroReconciledInput): XeroReconciled {
  const store = xeroStore(context.service);
  const known = new Set(store.accounts().map((account) => lower(account.code)));
  for (const choice of input.choices ?? []) {
    if (!isCalendarDate(choice.through))
      throw new ApplicationError("invalid_input", `${choice.through} is not a date`, 400);
    if (known.size > 0 && !known.has(lower(choice.code)))
      throw new ApplicationError(
        "xero_code_unknown",
        `The Xero chart has no account ${choice.code}`,
        404,
      );
  }
  store.setReconciled(
    (input.choices ?? []).map((choice) => ({
      code: choice.code,
      through: choice.through,
      note: choice.note ?? "",
    })),
    {
      setAt: context.service.now(),
      principal: describePrincipal(context.access.principal),
    },
  );
  store.clearReconciled(input.clear ?? []);
  return reconciledState(context);
}

// ---- Status -----------------------------------------------------------------------------------

export async function xeroStatus(context: SliceContext): Promise<XeroStatus> {
  const store = xeroStore(context.service);
  const chart = storedAccounts(context);
  const book = await readChart(context);
  const accounts = bookAccounts(book);
  const proposals = matchChart({
    xero: chart,
    book: accounts,
    saved: store.mapping(),
    overrides: new Map(),
    flowOf: () => null,
  });
  const counts = countOf(proposals);
  const files = store.files(100);
  const ranges = store.transactionRanges();
  const notes: string[] = [];
  if (chart.length === 0) notes.push("No Xero chart has been imported.");
  else if (counts.unmapped > 0)
    notes.push(
      `${counts.unmapped} Xero account${counts.unmapped === 1 ? " is" : "s are"} not mapped (${counts.unmappedWithBalance} with a balance).`,
    );
  const banks = chart.filter((account) => account.bank && !account.archived);
  const reconciled = new Set(store.reconciled().map((row) => lower(row.code)));
  const missing = banks.filter((account) => !reconciled.has(lower(account.code)));
  if (missing.length > 0)
    notes.push(
      `${missing.length} Xero bank account${missing.length === 1 ? " has" : "s have"} no reconciled-through date, so ${missing.length === 1 ? "it" : "they"} cannot be compared.`,
    );
  if (store.trialBalanceDates().length === 0 && store.lineCount() === 0)
    notes.push("No trial balance or account transactions have been imported.");
  return {
    chartImportedAt: store.chartImportedAt(),
    counts,
    files: files.map((file) => ({
      seq: file.seq,
      kind: file.kind,
      name: file.name,
      sha256: file.sha256,
      organisation: file.organisation,
      asOf: file.asOf,
      from: file.from,
      to: file.to,
      rows: file.rows,
      importedAt: file.importedAt,
    })),
    trialBalances: store.trialBalanceDates(),
    transactions: ranges.flatMap((range, index) => {
      // A file imported again for the same dates is one range in the list.
      if (ranges.findIndex((other) => other.from === range.from && other.to === range.to) !== index)
        return [];
      const lines = store.lines(range.from, range.to);
      return [
        {
          from: range.from,
          to: range.to,
          accounts: new Set(lines.map((line) => line.code ?? line.name)).size,
          lines: lines.length,
        },
      ];
    }),
    reconciled: reconciledState(context).entries,
    cutoverDate: shadowStore(context.service).cutover()?.cutoverOn ?? null,
    notes,
  };
}
