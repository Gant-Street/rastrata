/** The operations behind the adjusting-entry import: reading an accountant's CSV into a preview that says
 * exactly what an import would do, and making drafts from it.
 *
 * An import never posts. It saves drafts for the owner to open, read, edit and post or discard like any
 * other draft, and it refuses a file as a whole if any row has a problem: an accountant's entries are a
 * set. Each entry carries a source event named by its entry id, so importing the same file again is
 * recognised (nothing new is made) and the ledger itself refuses to post one source twice; an entry id
 * used again with different figures is a conflict, never a quiet second version.
 *
 * Writes are retained: the same operation identity with the same input returns the first answer and never
 * repeats the effect, and a refused request leaves nothing behind. The file is hostile data (see
 * tax/adjustments.ts). */
import { hashCanonical } from "@rastrata/kernel";

import type {
  TaxAdjustmentCreated,
  TaxAdjustmentEntry,
  TaxAdjustmentImported,
  TaxAdjustmentPreview,
  TaxAdjustmentProblem,
  TaxAdjustmentSkipped,
} from "../../client-contracts.gen.ts";
import { ApplicationError } from "../../errors.ts";
import { sanitizeText } from "../../ingest/text.ts";
import { formatMoney } from "../../money.ts";
import {
  ADJUSTMENT_COLUMNS,
  type AdjustmentEntry,
  type AdjustmentProblem,
  ADJUSTMENTS_VERSION,
  draftOf,
  hasErrors,
  lookupsOf,
  parseAdjustments,
  SOURCE_PREFIX,
  sourceOf,
} from "../../tax/adjustments.ts";
import { TAX_DISCLAIMER_LONG } from "../../tax/sources.ts";
import type { ApplicationStore } from "../../storage.ts";
import type { SliceContext } from "../types.ts";

type Status = TaxAdjustmentEntry["status"];

/** At most this many problems are listed for one entry or for the file; the count says the rest. */
const MAX_PROBLEMS = 40;
const MAX_FILE_PROBLEMS = 60;

interface Known {
  /** The facts the source was registered with. */
  readonly description: string;
  readonly evidenceReference: string;
  /** Drafts that carry this source, oldest first. */
  readonly drafts: readonly { id: string; version: number; status: string }[];
}

/** The adjusting-entry sources the book already has, with their drafts: one read of two tables the
 * service owns (the same facts `sources.get` returns), taken inside the caller's transaction so a
 * check and a write cannot be separated by another request. */
function knownSources(store: ApplicationStore): Map<string, Known> {
  const sources = store
    .query("SELECT id, body FROM app_sources WHERE id LIKE ? ESCAPE '\\'")
    .all(`${SOURCE_PREFIX}%`) as { id: string; body: string }[];
  const drafts = store
    .query(
      "SELECT id, version, status, json_extract(body, '$.source.id') AS source FROM app_drafts WHERE json_extract(body, '$.source.id') LIKE ? ESCAPE '\\' ORDER BY rowid",
    )
    .all(`${SOURCE_PREFIX}%`) as { id: string; version: number; status: string; source: string }[];
  const known = new Map<string, Known>();
  for (const row of sources) {
    let facts: { description?: unknown; evidenceReference?: unknown };
    try {
      facts = JSON.parse(row.body) as typeof facts;
    } catch {
      continue;
    }
    known.set(row.id, {
      description: typeof facts.description === "string" ? facts.description : "",
      evidenceReference: typeof facts.evidenceReference === "string" ? facts.evidenceReference : "",
      drafts: drafts
        .filter((draft) => draft.source === row.id)
        .map(({ id, version, status }) => ({ id, version, status })),
    });
  }
  return known;
}

interface Classified {
  readonly entry: AdjustmentEntry;
  readonly status: Status;
  readonly problems: readonly AdjustmentProblem[];
  readonly draft: Known["drafts"][number] | null;
}

const problemOf = (code: string, message: string, entry: AdjustmentEntry): AdjustmentProblem => ({
  severity: "error",
  code,
  message,
  row: entry.firstRow,
  entry: entry.id,
  column: null,
});

/** What an import would do with each entry. `invalid` entries have a problem; a `conflict` is an entry id
 * that was imported before with different facts; `already_imported` has a draft (or a posted entry) from
 * an earlier import of the same entry; `new` would make a draft. */
function classify(
  entries: readonly AdjustmentEntry[],
  known: ReadonlyMap<string, Known>,
): Classified[] {
  return entries.map((entry): Classified => {
    if (hasErrors(entry.problems))
      return { entry, status: "invalid", problems: entry.problems, draft: null };
    const wanted = sourceOf(entry);
    const seen = known.get(wanted.id);
    if (!seen) return { entry, status: "new", problems: entry.problems, draft: null };
    if (
      seen.description !== wanted.description ||
      seen.evidenceReference !== wanted.evidenceReference
    )
      return {
        entry,
        status: "conflict",
        problems: [
          ...entry.problems,
          problemOf(
            "entry_conflict",
            `Entry ${entry.id} was imported before with different figures (date, narration or lines). Nothing was changed. To import the new version, give it a new entry id.`,
            entry,
          ),
        ],
        draft: null,
      };
    const draft = seen.drafts.at(-1) ?? null;
    // No draft left: the owner threw the earlier one away, and importing the same entry again makes a
    // new draft rather than being refused for a draft that is not there.
    return draft
      ? { entry, status: "already_imported", problems: entry.problems, draft }
      : { entry, status: "new", problems: entry.problems, draft: null };
  });
}

const view = (item: Classified): TaxAdjustmentEntry => {
  const { entry } = item;
  const problems = item.problems.slice(0, MAX_PROBLEMS).map(wireProblem);
  if (item.problems.length > MAX_PROBLEMS)
    problems.push({
      severity: "warning",
      code: "more_problems",
      message: `${item.problems.length - MAX_PROBLEMS} more problems on this entry are not listed.`,
      row: null,
      entry: entry.id,
      column: null,
    });
  return {
    entry: entry.id,
    firstRow: entry.firstRow,
    date: entry.date,
    narration: entry.narration,
    lines: entry.lines.map((line) => ({
      row: line.row,
      account: line.account,
      accountName: line.accountName,
      debit: formatMoney(line.debit),
      credit: formatMoney(line.credit),
    })),
    debit: formatMoney(entry.debit),
    credit: formatMoney(entry.credit),
    status: item.status,
    sourceId: entry.sourceId,
    draft: item.draft
      ? { id: item.draft.id, version: item.draft.version, status: item.draft.status }
      : null,
    problems,
  };
};

const wireProblem = (item: AdjustmentProblem): TaxAdjustmentProblem => ({
  severity: item.severity,
  code: item.code,
  message: item.message,
  row: item.row,
  entry: item.entry,
  column: item.column,
});

/** A fingerprint of what the preview said would happen: each entry's id, what it says and what an import
 * would do with it. The import is told the preview it was shown and refuses if the file or the book has
 * moved since, so what is made is what was looked at. It does not include the book's revision: an
 * unrelated posting does not make a preview stale. */
function fingerprint(
  items: readonly Classified[],
  fileProblems: readonly AdjustmentProblem[],
): string {
  return hashCanonical({
    type: "TaxAdjustmentPreview",
    version: ADJUSTMENTS_VERSION,
    entries: items.map((item) => [item.entry.id, item.entry.digest, item.status]),
    problems: [...fileProblems, ...items.flatMap((item) => item.problems)].map((item) => [
      item.code,
      item.severity,
    ]),
  }).digest;
}

export interface Reading {
  readonly fileName: string;
  readonly rows: number;
  readonly delimiter: string;
  readonly items: readonly Classified[];
  readonly fileProblems: readonly AdjustmentProblem[];
  readonly previewHash: string;
}

/** Read a file against the book as it stands: the chart and the calendar from the state, and what an
 * earlier import left behind from the product's own tables. */
export function readAdjustments(
  input: Record<string, unknown>,
  state: Parameters<typeof lookupsOf>[0],
  store: ApplicationStore,
): Reading {
  const csv = typeof input.csv === "string" ? input.csv : "";
  const fileName = sanitizeText(typeof input.fileName === "string" ? input.fileName : "", 200);
  const parsed = parseAdjustments(csv, lookupsOf(state));
  const fileProblems = [...parsed.problems];
  if (parsed.entries.length === 0 && !hasErrors(fileProblems))
    fileProblems.push({
      severity: "error",
      code: "no_entries",
      message: "The file has a header and no entries to import.",
      row: null,
      entry: null,
      column: null,
    });
  const items = classify(parsed.entries, knownSources(store));
  return {
    fileName,
    rows: parsed.rows,
    delimiter: parsed.delimiter,
    items,
    fileProblems,
    previewHash: fingerprint(items, fileProblems),
  };
}

export function previewOf(reading: Reading): TaxAdjustmentPreview {
  const count = (status: Status) => reading.items.filter((item) => item.status === status).length;
  const fileProblems = reading.fileProblems.slice(0, MAX_FILE_PROBLEMS).map(wireProblem);
  return {
    fileName: reading.fileName,
    rows: reading.rows,
    columns: [...ADJUSTMENT_COLUMNS],
    entries: reading.items.map(view),
    counts: {
      entries: reading.items.length,
      lines: reading.items.reduce((sum, item) => sum + item.entry.lines.length, 0),
      new: count("new"),
      alreadyImported: count("already_imported"),
      conflict: count("conflict"),
      invalid: count("invalid"),
    },
    problems: fileProblems,
    // Something new to make, and nothing in the way: no problem on the file and no entry that is
    // invalid or in conflict.
    canImport:
      !hasErrors(reading.fileProblems) &&
      count("invalid") === 0 &&
      count("conflict") === 0 &&
      count("new") > 0,
    previewHash: reading.previewHash,
    notice: `Importing saves drafts for the owner to review. Nothing is posted. ${TAX_DISCLAIMER_LONG}`,
  };
}

const refusal = (reading: Reading): ApplicationError => {
  const all = [...reading.fileProblems, ...reading.items.flatMap((item) => item.problems)].filter(
    (item) => item.severity === "error",
  );
  return new ApplicationError(
    "adjustment_file_invalid",
    `The file was not imported: ${all.length} ${all.length === 1 ? "problem" : "problems"} to fix first. Nothing was changed. Run the preview to see each one with its row.`,
    422,
    all.slice(0, 20).map((item) => ({
      path: item.row === null ? "file" : `row ${item.row}`,
      message: `${item.code}: ${item.message}`,
    })),
  );
};

/** Make the drafts. Everything is decided from one reading taken inside the transaction, so the entries
 * that exist when it runs are the ones it classified. */
export function importAdjustments(
  context: SliceContext,
  input: Record<string, unknown>,
  state: Parameters<typeof lookupsOf>[0],
  operationId: string,
): TaxAdjustmentImported {
  const { service } = context;
  return service.retainRequest(operationId, "taxAdjustments.import", input, () => {
    const reading = readAdjustments(input, state, service.store);
    if (typeof input.previewHash === "string" && input.previewHash !== reading.previewHash)
      throw new ApplicationError(
        "adjustment_preview_changed",
        "The file or the book changed since it was previewed, so nothing was imported. Preview it again.",
        409,
      );
    if (
      hasErrors(reading.fileProblems) ||
      reading.items.some((item) => item.status === "invalid" || item.status === "conflict")
    )
      throw refusal(reading);
    const created: TaxAdjustmentCreated[] = [];
    const skipped: TaxAdjustmentSkipped[] = [];
    for (const item of reading.items) {
      if (item.status === "new") {
        const draft = service.createDraft(draftOf(item.entry));
        created.push({ entry: item.entry.id, draftId: draft.id, version: draft.version });
      } else
        skipped.push({
          entry: item.entry.id,
          draftId: item.draft?.id ?? null,
          draftStatus: item.draft?.status ?? null,
        });
    }
    return {
      fileName: reading.fileName,
      created,
      skipped,
      previewHash: reading.previewHash,
      nextStep:
        created.length > 0
          ? `${created.length} ${created.length === 1 ? "draft was" : "drafts were"} saved. Read each one, then post it or discard it. Nothing has been posted.`
          : "Every entry in the file was imported before, so nothing new was made.",
      disclaimer: TAX_DISCLAIMER_LONG,
    };
  });
}
