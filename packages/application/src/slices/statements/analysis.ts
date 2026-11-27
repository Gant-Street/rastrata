import { ApplicationError } from "../../errors.ts";
import type {
  BalanceCheckResult,
  IngestBatch,
  IngestPort,
  IngestReport,
  LineDisposition,
  RawRef,
} from "../../ingest-types.ts";
import { parseMoney } from "../../money.ts";
import type { ApplicationService } from "../../service.ts";
import type { LineSummary } from "../../statements/balance.ts";
import type { CsvMapping, StatementLine } from "../../statements/csv-mapping.ts";
import { hostileFlags } from "../../statements/hostile.ts";
import { presetById } from "../../statements/presets.ts";
import { parseStatement, type SavedMapping, type StatementParse } from "../../statements/parse.ts";
import { sha256Hex } from "../../statements/sha256.ts";
import { assertMapping } from "./mappings.ts";
import { ingestFor } from "./ports.ts";
import { getProfile, listProfiles, type StatementsState, type StoredProfile } from "./store.ts";

/** What an import is, worked out once and used by both the preview and the commit, so the preview
 * is exactly what the commit will do: same file, same mapping, same parse, same batch. */

export interface ImportInput {
  readonly sha256: string;
  readonly ledgerAccountId: string;
  readonly presetId?: string;
  readonly profileId?: string;
  readonly mapping?: CsvMapping;
  readonly ofxAccount?: string;
  readonly ignoreProviderIds?: boolean;
  readonly invertBalance?: boolean;
  readonly startOn?: string;
  readonly catchUp?: boolean;
}

export interface ChartAccount {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly role: "asset" | "liability";
}

export interface FileInfo {
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
  readonly name?: string;
}

/** Errors that mean "this row could not be read" and nothing wider. A person may choose to import
 * the rest of the file and leave these rows out; every other error is about the file itself. */
const ROW_ERRORS = new Set(["bad_row", "short_row", "fitid_conflict"]);

export interface Analysis {
  readonly input: ImportInput;
  readonly account: ChartAccount;
  readonly bookCurrency: string;
  readonly file: FileInfo;
  readonly parsed: StatementParse;
  readonly profile: StoredProfile | null;
  readonly batch: IngestBatch | null;
  readonly report: IngestReport | null;
  readonly dispositions: ReadonlyMap<number, LineDisposition>;
  readonly rowOf: ReadonlyMap<number, number>;
  /** Errors from the pipeline about lines the parser let through; none is expected. */
  readonly refused: readonly { row: number; message: string }[];
  /** Nothing blocks a commit: no error, and at least one line. */
  readonly valid: boolean;
  /** Every error is about a single row, so the rest could be imported if the person agrees. */
  readonly skippable: boolean;
}

/** The bank or card accounts of the chart. Anything else cannot be what a statement describes. */
export async function chartAccount(
  service: ApplicationService,
  id: string,
): Promise<{ account: ChartAccount; currency: string }> {
  const chart = await service.accounts();
  const account = chart.accounts.find((item) => item.id === id);
  if (!account)
    throw new ApplicationError(
      "account_not_found",
      "That account is not in your chart. Choose the account the statement belongs to.",
      404,
    );
  if (account.role !== "asset" && account.role !== "liability")
    throw new ApplicationError(
      "account_not_importable",
      "A statement belongs to a bank or card account. Choose an asset account (a bank) or a liability account (a credit card).",
      400,
    );
  if (account.closedOn !== null && account.closedOn <= service.today())
    throw new ApplicationError(
      "account_closed",
      `That account was closed on ${account.closedOn}. Choose an open account.`,
      409,
    );
  return {
    account: {
      id: account.id,
      code: account.code,
      name: account.name,
      role: account.role,
    },
    currency: chart.currency,
  };
}

function selection(state: StatementsState, input: ImportInput) {
  const chosen = [input.mapping, input.profileId, input.presetId].filter(
    (value) => value !== undefined,
  );
  if (chosen.length > 1)
    throw new ApplicationError(
      "invalid_input",
      "Choose one way to read the columns: a mapping, a saved profile, or a preset",
      400,
    );
  let profile: StoredProfile | null = null;
  let mapping = input.mapping;
  if (input.profileId !== undefined) {
    profile = getProfile(state, input.profileId);
    if (!profile)
      throw new ApplicationError(
        "profile_not_found",
        "That saved profile does not exist. List the profiles and choose another.",
        404,
      );
    mapping = profile.mapping;
  }
  if (mapping) assertMapping(mapping);
  if (input.presetId !== undefined && !presetById(input.presetId))
    throw new ApplicationError(
      "unknown_preset",
      "That preset does not exist. List the presets and choose one.",
      400,
    );
  const candidates: SavedMapping[] =
    chosen.length === 0
      ? listProfiles(state, input.ledgerAccountId).map((item) => ({
          id: item.id,
          name: item.name,
          mapping: item.mapping,
        }))
      : [];
  return { profile, mapping, candidates };
}

const CACHE_SIZE = 2;

/** Read the file and parse it, with the parse remembered for the next page of the same preview. */
function parseCached(
  state: StatementsState,
  file: { bytes: Uint8Array },
  key: string,
  work: () => StatementParse,
): StatementParse {
  const cached = state.parsed.get(key) as StatementParse | undefined;
  if (cached) {
    state.parsed.delete(key);
    state.parsed.set(key, cached);
    return cached;
  }
  const parsed = work();
  // Only what a person is likely to page through again is worth keeping.
  if (file.bytes.length <= 8 * 1024 * 1024) {
    state.parsed.set(key, parsed);
    while (state.parsed.size > CACHE_SIZE) {
      const oldest = state.parsed.keys().next().value as string;
      state.parsed.delete(oldest);
    }
  }
  return parsed;
}

export interface AnalyseOptions {
  /** The instant the batch is stamped with; a retried commit passes the first one back. */
  readonly fetchedAt: string;
}

export async function analyse(
  service: ApplicationService,
  state: StatementsState,
  input: ImportInput,
  options: AnalyseOptions,
): Promise<Analysis> {
  const { account, currency: bookCurrency } = await chartAccount(service, input.ledgerAccountId);
  const ingest: IngestPort = ingestFor(service);
  const stored = ingest.readArchive(input.sha256);
  if (!stored)
    throw new ApplicationError(
      "upload_not_found",
      "That file is not stored, or was never uploaded. Upload it again.",
      404,
    );
  const { profile, mapping, candidates } = selection(state, input);
  const file: FileInfo = {
    sha256: input.sha256,
    size: stored.bytes.byteLength,
    mediaType: stored.mediaType,
    ...(stored.name !== undefined ? { name: stored.name } : {}),
  };
  const accountKey = `csv:${account.id}`;
  const request = {
    defaultCurrency: bookCurrency,
    accountKey,
    ...(mapping ? { mapping } : {}),
    ...(input.presetId !== undefined ? { preset: input.presetId } : {}),
    ...(candidates.length > 0 ? { profiles: candidates } : {}),
    ...(input.ofxAccount !== undefined ? { ofxAccount: input.ofxAccount } : {}),
    ...(input.ignoreProviderIds ? { ignoreProviderIds: true } : {}),
    ...(input.invertBalance ? { invertBalance: true } : {}),
  };
  const key = sha256Hex(JSON.stringify([input.sha256, request]));
  const parsed = parseCached(state, stored, key, () =>
    parseStatement({ bytes: stored.bytes, ...request }),
  );

  const rowOf = new Map<number, number>();
  for (const { line, row } of parsed.lines) rowOf.set(line.rawIndex, row);
  let batch: IngestBatch | null = null;
  let report: IngestReport | null = null;
  const dispositions = new Map<number, LineDisposition>();
  const refused: { row: number; message: string }[] = [];
  if (parsed.provider !== null && parsed.accountKey !== null && parsed.lines.length > 0) {
    const raw: RawRef = {
      sha256: file.sha256,
      size: file.size,
      mediaType: file.mediaType,
      ...(file.name !== undefined ? { name: file.name } : {}),
    };
    batch = {
      provider: parsed.provider,
      sourceKey: parsed.accountKey,
      raw,
      lines: parsed.lines.map(({ line }) => line),
      balances: parsed.balances,
      fetchedAt: options.fetchedAt,
      ledgerAccountId: account.id,
      ...(input.startOn !== undefined ? { startOn: input.startOn } : {}),
      ...(input.catchUp ? { catchUp: true } : {}),
    };
    report = ingest.preview(batch);
    for (const disposition of report.dispositions) {
      dispositions.set(disposition.rawIndex, disposition);
      if (disposition.status === "invalid")
        refused.push({
          row: rowOf.get(disposition.rawIndex) ?? 1,
          message: `The import pipeline refused this line: ${(disposition.reason ?? "it is not valid").slice(0, 300)}`,
        });
    }
  }
  const kinds = [...parsed.diagnostics.errorKinds().keys()];
  const skippable = kinds.every((kind) => ROW_ERRORS.has(kind)) && refused.length === 0;
  const valid =
    parsed.diagnostics.counts.errors === 0 && refused.length === 0 && parsed.lines.length > 0;
  return {
    input,
    account,
    bookCurrency,
    file,
    parsed,
    profile,
    batch,
    report,
    dispositions,
    rowOf,
    refused,
    valid,
    skippable,
  };
}

/** The balance the file reports, set against the book. The pipeline reads the ledger for this. */
export async function balanceChecks(
  service: ApplicationService,
  analysis: Analysis,
): Promise<readonly BalanceCheckResult[]> {
  if (!analysis.batch || analysis.batch.balances.length === 0) return [];
  return ingestFor(service).checkBalances(analysis.batch);
}

export interface TotalsView {
  readonly moneyIn: string;
  readonly moneyOut: string;
  readonly net: string;
  readonly inCount: number;
  readonly outCount: number;
}

export const totalsOf = (summary: LineSummary): TotalsView => ({
  moneyIn: summary.moneyIn,
  moneyOut: summary.moneyOut,
  net: summary.net,
  inCount: summary.inCount,
  outCount: summary.outCount,
});

/** Totals of the lines the pipeline will add to the queue. */
export function newLines(analysis: Analysis): StatementLine[] {
  return analysis.parsed.lines.filter(
    ({ line }) => analysis.dispositions.get(line.rawIndex)?.status === "new",
  );
}

/** Things to look at before committing, in plain words. None blocks anything. */
export async function hintsFor(service: ApplicationService, analysis: Analysis): Promise<string[]> {
  const hints: string[] = [];
  const { parsed, account, bookCurrency } = analysis;
  const lines = parsed.lines;
  if (lines.length === 0) return hints;
  if (parsed.currency && parsed.currency !== bookCurrency)
    hints.push(
      `This file is in ${parsed.currency} but your book is in ${bookCurrency}. Lines in another currency are held for review and are not converted.`,
    );
  if (account.role === "liability" && lines.length >= 5) {
    const positive = lines.filter(({ line }) => parseMoney(line.amount) > 0n).length;
    if (positive * 100 > lines.length * 60)
      hints.push(
        "Most lines are positive, but on a credit card most lines are charges, which are negative here. If these are charges, the issuer shows them as positive: choose to flip the signs (American Express does this).",
      );
  }
  if (parsed.ofx) {
    const selected = parsed.ofx.accounts.find((item) => item.key === parsed.ofx?.selected);
    if (selected?.type === "card" && account.role !== "liability")
      hints.push(
        `This is a credit card statement, but ${account.name} is an asset account. A card belongs on a liability account.`,
      );
    if (selected?.type === "bank" && account.role === "liability")
      hints.push(
        `This is a bank statement, but ${account.name} is a liability account. Check that you chose the right account.`,
      );
    if (selected?.balance && account.role === "liability") {
      const owed = parseMoney(selected.balance.balance);
      const negatives = lines.filter(({ line }) => parseMoney(line.amount) < 0n).length;
      if (owed > 0n && negatives * 2 > lines.length)
        hints.push(
          "The statement's balance is positive, but charges are negative here, so it probably shows what you owe as a positive number. If the balance check below disagrees, import again with the balance sign flipped.",
        );
    }
  }
  const today = service.today();
  const future = lines.filter(({ line }) => line.postedOn > today).length;
  if (future > 0)
    hints.push(
      `${future} line${future === 1 ? " is" : "s are"} dated after today (${today}). Check that the date order is right.`,
    );
  try {
    const periods = (await service.periods()).periods ?? [];
    if (periods.length > 0) {
      const first = periods.reduce(
        (low, period) => (period.startsOn < low ? period.startsOn : low),
        "9999-12-31",
      );
      const last = periods.reduce(
        (high, period) => (period.endsOn > high ? period.endsOn : high),
        "0000-01-01",
      );
      const outside = lines.filter(
        ({ line }) => line.postedOn < first || line.postedOn > last,
      ).length;
      if (outside > 0)
        hints.push(
          `${outside} line${outside === 1 ? " is" : "s are"} dated outside the periods your book covers (${first} to ${last}). They can be imported, but cannot be posted until the calendar is extended.`,
        );
    }
  } catch {
    // The calendar is a courtesy here; a failure to read it must not fail the preview.
  }
  if (analysis.report && analysis.report.newCount === 0 && analysis.report.excludedCount === 0)
    hints.push("Every line in this file was already imported. Nothing new would be added.");
  return hints;
}

export function flagsOf(line: StatementLine["line"]): string[] {
  const flags = new Set<string>();
  for (const text of [line.description, line.counterparty ?? "", line.reference ?? ""])
    for (const flag of hostileFlags(text)) flags.add(flag);
  return [...flags];
}
