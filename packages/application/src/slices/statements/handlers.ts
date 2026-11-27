import { ApplicationError } from "../../errors.ts";
import type {
  BalanceCheckResult,
  IngestBatch,
  IngestReport,
  LineDisposition,
} from "../../ingest-types.ts";
import type { ApplicationService } from "../../service.ts";
import { summarizeLines } from "../../statements/balance.ts";
import type { CsvMapping } from "../../statements/csv-mapping.ts";
import { CSV_PRESETS } from "../../statements/presets.ts";
import type { SliceHandler, SliceHandlers } from "../types.ts";
import {
  analyse,
  balanceChecks,
  chartAccount,
  flagsOf,
  hintsFor,
  newLines,
  totalsOf,
  type Analysis,
  type ImportInput,
} from "./analysis.ts";
import { assertMapping } from "./mappings.ts";
import { ingestFor, nowOf } from "./ports.ts";
import {
  deleteProfile,
  finishRun,
  listProfiles,
  listRuns,
  saveProfile,
  startRun,
  statementsState,
  type StoredProfile,
} from "./store.ts";

const optionalString = (input: Record<string, unknown>, key: string) =>
  typeof input[key] === "string" ? { [key]: input[key] as string } : {};

function toInput(input: Record<string, unknown>): ImportInput {
  return {
    sha256: input.sha256 as string,
    ledgerAccountId: input.ledgerAccountId as string,
    ...optionalString(input, "presetId"),
    ...optionalString(input, "profileId"),
    ...(input.mapping !== undefined ? { mapping: input.mapping as CsvMapping } : {}),
    ...optionalString(input, "ofxAccount"),
    ...(input.ignoreProviderIds === true ? { ignoreProviderIds: true } : {}),
    ...(input.invertBalance === true ? { invertBalance: true } : {}),
    ...optionalString(input, "startOn"),
    ...(input.catchUp === true ? { catchUp: true } : {}),
  };
}

const profileView = (profile: StoredProfile) => ({
  id: profile.id,
  name: profile.name,
  ledgerAccountId: profile.ledgerAccountId,
  presetId: profile.presetId,
  mapping: profile.mapping,
  version: profile.version,
  createdAt: profile.createdAt,
  updatedAt: profile.updatedAt,
});

const balanceView = (check: BalanceCheckResult) => ({
  accountKey: check.accountKey,
  asOf: check.asOf,
  reported: check.reported,
  ledger: check.ledger,
  waiting: check.waiting,
  excluded: check.excluded,
  difference: check.difference,
});

function countsView(analysis: Analysis, report: IngestReport | null) {
  const { parsed } = analysis;
  const rows = parsed.csv ? (parsed.csv.stats?.rows ?? 0) : (parsed.ofx?.transactions ?? 0);
  return {
    rows,
    lines: parsed.lines.length,
    new: report?.newCount ?? 0,
    duplicate: report?.duplicateCount ?? 0,
    overlap: report?.overlapCount ?? 0,
    excluded: report?.excludedCount ?? 0,
    invalid: report?.invalidCount ?? 0,
    skipped: Math.max(0, rows - parsed.lines.length),
  };
}

function skippedView(analysis: Analysis) {
  const { parsed } = analysis;
  const stats = parsed.csv?.stats;
  return {
    notFinal: Object.entries(stats?.filtered ?? {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([value, count]) => ({ value: value.slice(0, 60), count })),
    noAmount: stats?.noAmount ?? 0,
    zero: stats?.zero ?? parsed.diagnostics.count("zero_amount"),
    unreadable: stats?.invalid ?? parsed.diagnostics.count("bad_row"),
  };
}

function detectionView(analysis: Analysis) {
  const { parsed, profile } = analysis;
  const csv = parsed.csv;
  const how = csv
    ? profile
      ? ("profile" as const)
      : csv.source
    : parsed.format === "ofx"
      ? ("ofx" as const)
      : ("none" as const);
  const used = profile ?? csv?.profile ?? null;
  return {
    how,
    ...(csv?.preset
      ? { preset: { id: csv.preset.id, name: csv.preset.name, verified: csv.preset.verified } }
      : {}),
    ...(used ? { profile: { id: used.id, name: used.name } } : {}),
    ...(csv ? { delimiter: csv.delimiter, headerRow: csv.headerRow } : {}),
    ...(csv?.dateOrder ? { dateOrder: csv.dateOrder } : {}),
  };
}

function ofxView(analysis: Analysis) {
  const ofx = analysis.parsed.ofx;
  if (!ofx) return {};
  return {
    ofx: {
      version: ofx.version,
      ...(ofx.institution ? { institution: ofx.institution } : {}),
      accounts: ofx.accounts.map((item) => ({
        key: item.key,
        label: item.label,
        type: item.type,
        accountType: item.accountType,
        currency: item.currency,
        count: item.count,
        from: item.from,
        to: item.to,
      })),
      ...(ofx.selected ? { selected: ofx.selected } : {}),
    },
  };
}

function chainView(analysis: Analysis) {
  const chain = analysis.parsed.csv?.chain;
  if (!chain) return {};
  return {
    chain: {
      order: chain.order,
      flipped: chain.flipped,
      compared: chain.compared,
      breakCount: chain.breakCount,
      breaks: [...chain.breaks],
      opening: chain.opening,
      closing: { asOf: chain.closing.asOf, balance: chain.closing.balance },
    },
  };
}

function diagnosticsView(analysis: Analysis) {
  const list = analysis.parsed.diagnostics.list().map((item) => ({
    severity: item.severity,
    ...(item.row !== undefined ? { row: item.row } : {}),
    message: item.message,
  }));
  const refused = analysis.refused.map((item) => ({
    severity: "error" as const,
    row: item.row,
    message: item.message,
  }));
  const all = [...refused, ...list];
  const rank = { error: 0, warning: 1, info: 2 } as const;
  all.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return all.slice(0, 500);
}

const PAGE_SIZE = 25;

function sampleView(analysis: Analysis, show: string, page: number, pageSize: number) {
  const { parsed, dispositions } = analysis;
  const statusOf = (rawIndex: number): LineDisposition["status"] =>
    dispositions.get(rawIndex)?.status ?? "new";
  const selected = parsed.lines.filter(({ line }) => {
    if (show === "all") return true;
    const status = statusOf(line.rawIndex);
    if (show === "problems") return status === "invalid" || flagsOf(line).length > 0;
    return status === show;
  });
  const start = (page - 1) * pageSize;
  const lines = selected.slice(start, start + pageSize).map(({ line, row }) => {
    const disposition = dispositions.get(line.rawIndex);
    return {
      rawIndex: line.rawIndex,
      row,
      postedOn: line.postedOn,
      amount: line.amount,
      currency: line.currency,
      description: line.description,
      ...(line.counterparty !== undefined ? { counterparty: line.counterparty } : {}),
      ...(line.reference !== undefined ? { reference: line.reference } : {}),
      ...(line.runningBalance !== undefined ? { runningBalance: line.runningBalance } : {}),
      ...(line.providerId !== undefined ? { providerId: line.providerId } : {}),
      status: statusOf(line.rawIndex),
      ...(disposition?.reason ? { reason: disposition.reason.slice(0, 300) } : {}),
      flags: flagsOf(line),
    };
  });
  return { count: selected.length, page, pageSize, lines };
}

async function preview(
  service: ApplicationService,
  input: Record<string, unknown>,
): Promise<unknown> {
  const state = statementsState(service);
  const request = toInput(input);
  const analysis = await analyse(service, state, request, {
    fetchedAt: nowOf(service).toISOString(),
  });
  const [balances, hints] = await Promise.all([
    balanceChecks(service, analysis),
    hintsFor(service, analysis),
  ]);
  const { parsed, report, file, account } = analysis;
  const counts = parsed.diagnostics.counts;
  const lineTotals = summarizeLines(parsed.lines);
  const range = { from: lineTotals.from, to: lineTotals.to };
  return {
    valid: analysis.valid,
    skippable: !analysis.valid && analysis.skippable && parsed.lines.length > 0,
    file,
    format: parsed.format,
    ...(parsed.encoding ? { encoding: parsed.encoding } : {}),
    account,
    ...(parsed.provider && parsed.accountKey
      ? { source: { provider: parsed.provider, accountKey: parsed.accountKey } }
      : {}),
    ...(parsed.currency ? { currency: parsed.currency } : {}),
    detection: detectionView(analysis),
    ...(parsed.csv?.effective ? { mapping: parsed.csv.effective } : {}),
    columns: (parsed.csv?.columns ?? []).map((column) => ({
      index: column.index,
      header: column.header,
      samples: [...column.samples],
    })),
    ...ofxView(analysis),
    counts: countsView(analysis, report),
    skipped: skippedView(analysis),
    range,
    totals: totalsOf(lineTotals),
    newTotals: totalsOf(summarizeLines(newLines(analysis))),
    balances: balances.map(balanceView),
    ...chainView(analysis),
    errors: counts.errors + analysis.refused.length,
    warnings: counts.warnings,
    infos: counts.infos,
    diagnostics: diagnosticsView(analysis),
    hints,
    sample: sampleView(
      analysis,
      typeof input.show === "string" ? input.show : "all",
      typeof input.page === "number" ? input.page : 1,
      typeof input.pageSize === "number" ? input.pageSize : PAGE_SIZE,
    ),
  };
}

function blocked(analysis: Analysis): ApplicationError {
  const problems = diagnosticsView(analysis).filter((item) => item.severity === "error");
  const first = problems.slice(0, 5).map((item) => ({
    path: "row" in item && item.row !== undefined ? `row ${item.row}` : "file",
    message: item.message,
  }));
  return new ApplicationError(
    "import_blocked",
    analysis.parsed.lines.length === 0
      ? "Nothing can be imported from this file. Run the preview to see why."
      : `This file cannot be imported as it stands (${problems.length} problem${problems.length === 1 ? "" : "s"}). Fix the mapping or the file, or import the rest and skip the unreadable rows.`,
    409,
    first,
  );
}

function commitMessage(report: IngestReport): string {
  const waiting = report.newCount;
  const parts: string[] = [];
  if (waiting > 0)
    parts.push(`${waiting} line${waiting === 1 ? " is" : "s are"} waiting in your Inbox.`);
  else parts.push("Nothing new: every line in this file was already imported.");
  const already = report.duplicateCount + report.overlapCount;
  if (waiting > 0 && already > 0)
    parts.push(
      `${already} line${already === 1 ? " was" : "s were"} already imported and ${already === 1 ? "was" : "were"} skipped.`,
    );
  const kept = report.excludedCount ?? 0;
  if (kept > 0)
    parts.push(
      `${kept} line${kept === 1 ? " was" : "s were"} kept out on purpose (before the start date, or caught up).`,
    );
  return parts.join(" ");
}

async function commit(
  service: ApplicationService,
  input: Record<string, unknown>,
  operationId: string,
): Promise<unknown> {
  const state = statementsState(service);
  const request = toInput(input);
  return service.retainAsyncRequest(operationId, "import.commit", input, async () => {
    const now = nowOf(service).toISOString();
    // The instant the batch is stamped with is written down before anything is sent, so a retry
    // after a crash builds the same batch and the pipeline recognises it.
    const run = startRun(
      state,
      {
        operationId,
        sha256: request.sha256,
        ledgerAccountId: request.ledgerAccountId,
        fetchedAt: now,
      },
      now,
    );
    const analysis = await analyse(service, state, request, { fetchedAt: run.fetchedAt });
    if (!analysis.valid) {
      const skipping =
        input.skipInvalidRows === true && analysis.skippable && analysis.parsed.lines.length > 0;
      if (!skipping) throw blocked(analysis);
    }
    const batch = analysis.batch as IngestBatch;
    const ingest = ingestFor(service);
    // The pipeline's own write and the record of it succeed or fail together.
    const counts = (report: IngestReport) => countsView(analysis, report);
    const submitted = service.store.transaction(() => {
      const result = ingest.submit(batch);
      finishRun(state, operationId, {
        batchId: result.batchId,
        fileName: analysis.file.name ?? null,
        sourceKey: batch.sourceKey,
        counts: counts(result),
        completedAt: nowOf(service).toISOString(),
        completedOn: service.today(),
      });
      return result;
    });
    const balances = await balanceChecks(service, analysis);
    const lineTotals = summarizeLines(analysis.parsed.lines);
    // Totals of what was new to the book: the lines the pipeline had not seen before this batch.
    const newSet = new Set(
      submitted.dispositions.filter((item) => item.status === "new").map((item) => item.rawIndex),
    );
    const added = analysis.parsed.lines.filter(({ line }) => newSet.has(line.rawIndex));
    return {
      batchId: submitted.batchId,
      file: analysis.file,
      account: analysis.account,
      source: {
        provider: batch.provider,
        accountKey: batch.sourceKey,
      },
      counts: counts(submitted),
      waiting: submitted.newCount,
      range: { from: lineTotals.from, to: lineTotals.to },
      newTotals: totalsOf(summarizeLines(added)),
      balances: balances.map(balanceView),
      warnings: analysis.parsed.diagnostics.counts.warnings,
      message: commitMessage(submitted),
    };
  });
}

const HISTORY_PAGE = 10;

const history: SliceHandler = async (input, { service }) => {
  const page = typeof input.page === "number" ? input.page : 1;
  const { count, rows } = listRuns(statementsState(service), page, HISTORY_PAGE);
  const chart = rows.length > 0 ? (await service.accounts()).accounts : [];
  return {
    count,
    page,
    pageSize: HISTORY_PAGE,
    runs: rows.map((row) => {
      const account = chart.find((item) => item.id === row.ledgerAccountId);
      const provider = row.sourceKey.split(":")[0] ?? "";
      const stat = (key: string) => row.counts[key] ?? 0;
      return {
        operationId: row.operationId,
        batchId: row.batchId,
        on: row.completedOn,
        at: row.completedAt,
        file: { sha256: row.sha256, ...(row.fileName ? { name: row.fileName } : {}) },
        account: {
          id: row.ledgerAccountId,
          code: account?.code ?? row.ledgerAccountId,
          name: account?.name ?? row.ledgerAccountId,
        },
        source: { provider, accountKey: row.sourceKey },
        counts: {
          rows: stat("rows"),
          lines: stat("lines"),
          new: stat("new"),
          duplicate: stat("duplicate"),
          overlap: stat("overlap"),
          excluded: stat("excluded"),
          invalid: stat("invalid"),
          skipped: stat("skipped"),
        },
      };
    }),
  };
};

const presets: SliceHandler = () => ({
  presets: CSV_PRESETS.map((preset) => ({
    id: preset.id,
    name: preset.name,
    bank: preset.bank,
    kind: preset.kind,
    summary: preset.summary,
    verified: preset.verified,
    basis: preset.basis,
    detectable: preset.autoDetect || (preset.detectWith?.length ?? 0) > 0,
    mapping: preset.mapping,
  })),
});

const profileList: SliceHandler = (input, { service }) => ({
  profiles: listProfiles(
    statementsState(service),
    typeof input.ledgerAccountId === "string" ? input.ledgerAccountId : undefined,
  ).map(profileView),
});

const profileSave: SliceHandler = async (input, { service, operationId }) => {
  const mapping = input.mapping as CsvMapping;
  assertMapping(mapping);
  const ledgerAccountId = typeof input.ledgerAccountId === "string" ? input.ledgerAccountId : null;
  if (ledgerAccountId !== null) await chartAccount(service, ledgerAccountId);
  const presetId = typeof input.presetId === "string" ? input.presetId : null;
  if (presetId !== null && !CSV_PRESETS.some((preset) => preset.id === presetId))
    throw new ApplicationError("unknown_preset", "That preset does not exist", 400);
  const state = statementsState(service);
  return service.retainRequest(operationId, "import.profileSave", input, () =>
    profileView(
      saveProfile(
        state,
        { name: input.name as string, ledgerAccountId, presetId, mapping },
        nowOf(service).toISOString(),
      ),
    ),
  );
};

const profileDelete: SliceHandler = (input, { service, operationId }) => {
  const state = statementsState(service);
  return service.retainRequest(operationId, "import.profileDelete", input, () => {
    if (!deleteProfile(state, input.profileId as string))
      throw new ApplicationError("profile_not_found", "That saved profile does not exist", 404);
    return { disposition: "deleted", profileId: input.profileId as string };
  });
};

export const statementsHandlers: SliceHandlers = {
  "import.presets": presets,
  "import.history": history,
  "import.profileList": profileList,
  "import.profileSave": profileSave,
  "import.profileDelete": profileDelete,
  "import.preview": (input, { service }) => preview(service, input),
  "import.commit": (input, { service, operationId }) => commit(service, input, operationId),
};
