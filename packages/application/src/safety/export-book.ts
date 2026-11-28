import type { BookState } from "@rastrata/kernel";
import { ApplicationError } from "../errors.ts";
import { formatMoney } from "../money.ts";
import { amount as moneyCell, render, text as textCell } from "../reports/csv.ts";
import type { RecordFile } from "./export-records.ts";
import type { ExportSink } from "./host.ts";
import { sealExportManifest, sha256Hex } from "./manifest.ts";
import {
  EXPORT_FORMAT,
  LEDGER_FORMAT_ID,
  type ExportCounts,
  type ExportFileInfo,
  type ExportManifest,
  type LedgerHead,
  type Progress,
} from "./types.ts";

/** One retained outcome of the ledger, in order: the sealed command and where the chain stood. */
export interface OutcomeLine {
  readonly sequence: string;
  readonly bookRevision: string;
  readonly previousChainHash: string;
  readonly chainHash: string;
  readonly disposition: "committed" | "rejected";
  readonly commandId: string;
  readonly type: string;
  /** The command exactly as the ledger sealed and stored it. */
  readonly command: string;
}

/** A source event the book posted from, with the facts the application kept about it. */
export interface SourceLine {
  readonly id: string;
  readonly description: string;
  readonly evidenceReference?: string;
  readonly contentHash: string;
  readonly postingOperationId: string | null;
}

export interface OpenExportInput {
  readonly id: string;
  readonly createdAt: string;
  readonly book: {
    readonly id: string;
    readonly name: string;
    readonly currency: string;
    readonly entity?: unknown;
  };
  /** The book's setup as the application stores it. */
  readonly setup: unknown;
  readonly ledger: { readonly head: LedgerHead; readonly genesis: string };
  /** The state at `ledger.head`. */
  readonly state: BookState;
  readonly outcomes: AsyncIterable<OutcomeLine>;
  /** Source facts by id; a journal whose source is not here is exported with the hash only. */
  readonly sources: ReadonlyMap<string, SourceLine>;
  /** The reference a person gave each posted journal, by the id of the command that posted it. */
  readonly references: ReadonlyMap<string, string>;
  /** Files of the business's own records that go beside the ledger (the reconciliations, the rules, the payees, the account tags, the changes). They are read when
   * they are written, and one that cannot be read is left out and named in the README: the books themselves are the promise. */
  readonly records?: readonly RecordFile[];
}

/** A file of records as it was written, for the README. */
export interface WrittenRecord {
  readonly path: string;
  readonly what: string;
}

const SOURCE_SYSTEM = "rastrata-source-v1";
const ROWS_PER_WRITE = 500;

const json = (value: unknown): string => `${JSON.stringify(value)}\n`;
const debit = (cents: bigint): string => formatMoney(cents > 0n ? cents : 0n);
const credit = (cents: bigint): string => formatMoney(cents < 0n ? -cents : 0n);

async function writeFile(
  sink: ExportSink,
  path: string,
  lineOriented: boolean,
  produce: (write: (text: string) => Promise<void>) => Promise<void>,
): Promise<ExportFileInfo> {
  const writer = await sink.file(path);
  await produce((text) => writer.write(text));
  const done = await writer.close();
  return { path, bytes: done.bytes, sha256: done.sha256, lines: lineOriented ? done.lines : null };
}

/** Write one CSV in batches so a large book is streamed, not held as one string. */
async function csv(
  write: (text: string) => Promise<void>,
  header: readonly string[],
  rows: Iterable<readonly string[]>,
): Promise<void> {
  await write(render([header.map((cell) => textCell(cell))]));
  let batch: (readonly string[])[] = [];
  for (const row of rows) {
    batch.push(row);
    if (batch.length >= ROWS_PER_WRITE) {
      await write(render(batch));
      batch = [];
    }
  }
  if (batch.length > 0) await write(render(batch));
}

export function exportReadme(info: {
  readonly id: string;
  readonly createdAt: string;
  readonly bookName: string;
  readonly currency: string;
  readonly head: LedgerHead;
  readonly counts: ExportCounts;
  /** The files of records written beside the ledger, and the ones that could not be read. Absent for an export made without any. */
  readonly records?: {
    readonly written: readonly WrittenRecord[];
    readonly leftOut: readonly { readonly path: string; readonly reason: string }[];
  };
}): string {
  const records = info.records;
  const recordRows = (records?.written ?? [])
    .map((record) => `| \`${record.path}\` | ${record.what.replace(/\|/g, "\\|")} |\n`)
    .join("");
  const leftOut =
    records && records.leftOut.length > 0
      ? `\n\nThese could not be read, and are not in this export: ${records.leftOut
          .map((left) => `\`${left.path}\` (${left.reason})`)
          .join(
            ", ",
          )}. Export again to try them once more; the books above are complete without them.`
      : "";
  const around = records
    ? `## The records around the books

The files whose names begin \`records-\` are the business's own records, copied as they stood when this export was written, which can be a moment after the ledger position above. Each is
the reply of one of Rastrata's read operations, so \`rastrata schema OPERATION\` describes every field. They are for reading, for an accountant and for keeping: rebuilding the book (below) uses
\`commands.jsonl\` and \`book.json\` alone. The \`.jsonl\` files hold one record to a line; the \`.json\` files are one document.${leftOut}

`
    : "";
  const notHere = records
    ? "Drafts, imported statement lines waiting in the Inbox, connections to banks and payment providers, who has access and other settings are working state and are not in this export."
    : "Drafts, imported statement lines waiting in the Inbox, rules, reconciliation records, settings and\nother working state are not accounting records and are not in this export. A backup holds all of\nthem; an export holds the books.";
  return `# Rastrata open export (${EXPORT_FORMAT})

This folder is a complete copy of one book's accounting records. It is written so that you can read
every journal without Rastrata, check that nothing was altered, and rebuild the same book with it.

- Book: ${info.bookName.replace(/\s+/g, " ")} (${info.currency})
- Exported: ${info.createdAt}
- Export id: ${info.id}
- Ledger position: ${info.head.sequence} retained outcomes, book revision ${info.head.bookRevision}
- Chain hash at that position: ${info.head.chainHash}
- Journals: ${info.counts.journals}, postings: ${info.counts.postings}, accounts: ${info.counts.accounts}, sealed commands: ${info.counts.commands}, source events: ${info.counts.sources}

## Files

| File | What it holds |
| --- | --- |
| \`manifest.json\` | Every other file with its size and SHA-256, the ledger position the export was taken at, and its own hash. |
| \`SHA256SUMS\` | The same hashes in the format \`shasum -a 256 -c SHA256SUMS\` checks. |
| \`book.json\` | The book's name, currency, setup, fiscal periods, and the ledger's starting record (\`ledger.genesis\`). |
| \`journals.jsonl\` | One JSON object per line: every journal ever posted, with its lines, the source event it came from, and the corrections that reverse or replace it. |
| \`chart.csv\` | The chart of accounts as it stands. |
| \`general-ledger.csv\` | Every posting, grouped by account, with a running balance. |
| \`trial-balance.csv\` | The balance of every account at the end of the ledger, with totals. |
| \`sources.jsonl\` | The source events (bank lines, receipts, entries from other systems) that posted journals, with their evidence references. |
| \`commands.jsonl\` | Every command the ledger retained, in order, exactly as it was sealed, with the chain hash it produced. Rejected commands are included: they are part of the history. |
${recordRows}
## Conventions

- Money is a decimal string with exactly two places, for example \`-12.34\`. In the journal files a
  line has a \`debit\` and a \`credit\`, one of them \`0.00\`, and a \`signed\` amount (debits positive).
- Dates are \`YYYY-MM-DD\` local dates with no time zone. Instants are UTC.
- CSV files are UTF-8 with CRLF line ends and RFC 4180 quoting. A text cell that begins with
  \`=\`, \`+\`, \`-\`, \`@\`, a tab or a line break has a single quote put in front of it, so a spreadsheet
  shows it as text instead of running it. The JSON files hold the text exactly as it was recorded.
- Nothing in these files is a tax return or tax advice; they are the books as recorded.

## Check that nothing was altered

    shasum -a 256 -c SHA256SUMS

\`manifest.json\` carries a \`manifestSha256\`: the SHA-256 of its own compact JSON without that
member. Each line of \`commands.jsonl\` carries \`previousChainHash\` and \`chainHash\`; the chain hash of
line N is the \`previousChainHash\` of line N+1, and the last line's \`chainHash\` is \`ledger.head.chainHash\`
in the manifest.

## Rebuild the book

    rastrata import-export <this folder> --to <new database file>

re-runs every command in \`commands.jsonl\` on the starting record in \`book.json\` and stops unless the
chain hash after each command equals the one recorded here. It writes a new database only if the last
chain hash equals \`ledger.head.chainHash\`, so a rebuilt book is the same book, proved by that hash.
It refuses to overwrite an existing database.

${around}## What is not here

${notHere} The export folder is not encrypted: keep it where you would keep the
books themselves.
`;
}

/**
 * Write the open export of a book into `sink` and return its manifest. Every file is written once,
 * hashed as it is written, and listed in the manifest; the manifest and `SHA256SUMS` come last.
 * Journals, the general ledger and the trial balance come from one pinned state, and the commands
 * from the ledger's own retained outcomes up to the same head.
 */
export async function writeOpenExport(
  input: OpenExportInput,
  sink: ExportSink,
  progress: Progress = () => {},
): Promise<ExportManifest> {
  const { state } = input;
  const files: ExportFileInfo[] = [];
  const accounts = new Map(
    state.admissionSnapshot.accounts.map((account) => [account.id, account]),
  );
  const reversedBy = new Map<string, string>();
  const reverses = new Map<string, { kind: string; of: string }>();
  const supersededIds = new Set<string>();
  for (const link of state.corrections) {
    reversedBy.set(link.originalJournalId, link.correctionJournalId);
    reverses.set(link.correctionJournalId, { kind: link.kind, of: link.originalJournalId });
    if (link.kind === "supersession") supersededIds.add(link.originalJournalId);
  }
  const kindOf = new Map(state.corrections.map((link) => [link.originalJournalId, link.kind]));

  let postings = 0;
  const sourceIds = new Set<string>();
  const usedSources: SourceLine[] = [];
  progress({ stage: "Writing journals", done: 0, total: state.journals.length, model: "linear" });

  files.push(
    await writeFile(sink, "journals.jsonl", true, async (write) => {
      let batch = "";
      let done = 0;
      for (const booked of state.journals) {
        const journal = booked.journal;
        const evidence = booked.derivations
          .flatMap((item) => item.evidence)
          .find((item) => item.sourceSystem === SOURCE_SYSTEM);
        const known = evidence ? input.sources.get(evidence.sourceRecordId) : undefined;
        if (evidence && !sourceIds.has(evidence.sourceRecordId)) {
          sourceIds.add(evidence.sourceRecordId);
          usedSources.push(
            known ?? {
              id: evidence.sourceRecordId,
              description: "",
              contentHash: evidence.contentHash.digest,
              postingOperationId: booked.commandId,
            },
          );
        }
        const asOriginal = kindOf.get(journal.id);
        const status = reverses.has(journal.id)
          ? reverses.get(journal.id)?.kind === "supersession"
            ? "replacement"
            : "reversal"
          : asOriginal === "supersession"
            ? "superseded"
            : asOriginal === "reversal"
              ? "reversed"
              : "posted";
        const lines = journal.postings.map((posting) => {
          const cents = posting.bookValue.amount.coefficient;
          const account = accounts.get(posting.accountId);
          postings += 1;
          return {
            id: posting.id,
            ordinal: Number(posting.ordinal),
            accountId: posting.accountId,
            accountCode: account?.code ?? posting.accountId,
            accountName: account?.name ?? "",
            debit: debit(cents),
            credit: credit(cents),
            signed: formatMoney(cents),
          };
        });
        batch += json({
          id: journal.id,
          kind: journal.kind,
          date: String(journal.accountingDate),
          economicAt: String(journal.economicAt),
          recordedAt: String(journal.recordedAt),
          narration: journal.narration,
          reference: input.references.get(booked.commandId) ?? null,
          bookRevision: booked.bookRevision.toString(),
          postingSequence: booked.postingSequence.toString(),
          commandId: booked.commandId,
          fiscalPeriodId: booked.fiscalPeriodId,
          currency: journal.functionalCommodityId,
          status,
          reverses: reverses.get(journal.id)?.of ?? null,
          reversedBy: reversedBy.get(journal.id) ?? null,
          source: evidence
            ? {
                id: evidence.sourceRecordId,
                contentHash: evidence.contentHash.digest,
                description: known?.description ?? null,
                evidenceReference: known?.evidenceReference ?? null,
              }
            : null,
          canonicalHash: booked.canonicalHash.digest,
          lines,
        });
        done += 1;
        if (done % 200 === 0) {
          await write(batch);
          batch = "";
          progress({ done });
        }
      }
      if (batch) await write(batch);
    }),
  );

  progress({ stage: "Writing the chart and the general ledger", done: null, total: null });
  const ordered = [...accounts.values()].sort((a, b) =>
    a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
  );
  files.push(
    await writeFile(sink, "chart.csv", true, (write) =>
      csv(
        write,
        [
          "account_id",
          "code",
          "name",
          "role",
          "normal_side",
          "parent_id",
          "opened_on",
          "closed_on",
          "posting_allowed",
        ],
        ordered.map((account) => [
          textCell(account.id),
          textCell(account.code),
          textCell(account.name),
          textCell(account.role),
          textCell(account.normalSide),
          textCell(account.parentId ?? ""),
          textCell(String(account.openedOn)),
          textCell(account.closedOn ? String(account.closedOn) : ""),
          textCell(account.postingAllowed ? "true" : "false"),
        ]),
      ),
    ),
  );

  interface Row {
    readonly date: string;
    readonly sequence: bigint;
    readonly ordinal: bigint;
    readonly journalId: string;
    readonly postingId: string;
    readonly narration: string;
    readonly sourceId: string;
    readonly status: string;
    readonly cents: bigint;
    readonly counted: boolean;
  }
  const byAccount = new Map<string, Row[]>();
  const totals = new Map<string, bigint>();
  for (const booked of state.journals) {
    const evidence = booked.derivations
      .flatMap((item) => item.evidence)
      .find((item) => item.sourceSystem === SOURCE_SYSTEM);
    const superseded = supersededIds.has(booked.journal.id);
    const status = reverses.has(booked.journal.id)
      ? reverses.get(booked.journal.id)?.kind === "supersession"
        ? "replacement"
        : "reversal"
      : superseded
        ? "superseded"
        : kindOf.get(booked.journal.id) === "reversal"
          ? "reversed"
          : "posted";
    for (const posting of booked.journal.postings) {
      const list = byAccount.get(posting.accountId) ?? [];
      list.push({
        date: String(booked.journal.accountingDate),
        sequence: booked.postingSequence,
        ordinal: posting.ordinal,
        journalId: booked.journal.id,
        postingId: posting.id,
        narration: booked.journal.narration,
        sourceId: evidence?.sourceRecordId ?? "",
        status,
        cents: posting.bookValue.amount.coefficient,
        counted: !superseded,
      });
      byAccount.set(posting.accountId, list);
      if (!superseded)
        totals.set(
          posting.accountId,
          (totals.get(posting.accountId) ?? 0n) + posting.bookValue.amount.coefficient,
        );
    }
  }
  files.push(
    await writeFile(sink, "general-ledger.csv", true, (write) =>
      csv(
        write,
        [
          "account_code",
          "account_name",
          "date",
          "journal_id",
          "posting_id",
          "narration",
          "source_id",
          "status",
          "debit",
          "credit",
          "running_balance",
        ],
        (function* () {
          for (const account of ordered) {
            const rows = byAccount.get(account.id);
            if (!rows) continue;
            rows.sort((a, b) =>
              a.date < b.date
                ? -1
                : a.date > b.date
                  ? 1
                  : a.sequence !== b.sequence
                    ? a.sequence < b.sequence
                      ? -1
                      : 1
                    : a.ordinal < b.ordinal
                      ? -1
                      : 1,
            );
            let running = 0n;
            for (const row of rows) {
              if (row.counted) running += row.cents;
              yield [
                textCell(account.code),
                textCell(account.name),
                textCell(row.date),
                textCell(row.journalId),
                textCell(row.postingId),
                textCell(row.narration),
                textCell(row.sourceId),
                textCell(row.status),
                moneyCell(debit(row.cents)),
                moneyCell(credit(row.cents)),
                row.counted ? moneyCell(formatMoney(running)) : "",
              ];
            }
          }
        })(),
      ),
    ),
  );

  files.push(
    await writeFile(sink, "trial-balance.csv", true, (write) =>
      csv(
        write,
        ["account_id", "code", "name", "role", "debit", "credit", "signed_balance"],
        (function* () {
          let totalDebit = 0n;
          let totalCredit = 0n;
          for (const account of ordered) {
            const cents = totals.get(account.id) ?? 0n;
            totalDebit += cents > 0n ? cents : 0n;
            totalCredit += cents < 0n ? -cents : 0n;
            yield [
              textCell(account.id),
              textCell(account.code),
              textCell(account.name),
              textCell(account.role),
              moneyCell(debit(cents)),
              moneyCell(credit(cents)),
              moneyCell(formatMoney(cents)),
            ];
          }
          yield [
            textCell("TOTAL"),
            "",
            "",
            "",
            moneyCell(formatMoney(totalDebit)),
            moneyCell(formatMoney(totalCredit)),
            moneyCell(formatMoney(totalDebit - totalCredit)),
          ];
        })(),
      ),
    ),
  );

  files.push(
    await writeFile(sink, "sources.jsonl", true, async (write) => {
      let batch = "";
      for (const source of [...usedSources].sort((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      ))
        batch += json({
          id: source.id,
          description: source.description,
          evidenceReference: source.evidenceReference ?? null,
          contentHash: source.contentHash,
          postingOperationId: source.postingOperationId,
        });
      if (batch) await write(batch);
    }),
  );

  progress({
    stage: "Writing the sealed commands",
    done: 0,
    total: Number(input.ledger.head.sequence),
    model: "linear",
  });
  let commands = 0;
  files.push(
    await writeFile(sink, "commands.jsonl", true, async (write) => {
      let batch = "";
      for await (const outcome of input.outcomes) {
        batch += json({
          sequence: outcome.sequence,
          bookRevision: outcome.bookRevision,
          previousChainHash: outcome.previousChainHash,
          chainHash: outcome.chainHash,
          disposition: outcome.disposition,
          commandId: outcome.commandId,
          type: outcome.type,
          command: outcome.command,
        });
        commands += 1;
        if (commands % 100 === 0) {
          await write(batch);
          batch = "";
          progress({ done: commands });
        }
      }
      if (batch) await write(batch);
    }),
  );

  // The business's own records, beside the ledger. Each is read in full before its file is opened, so one that cannot be read leaves no half-written file and the
  // export goes on without it: the books above are what the export promises.
  const written: WrittenRecord[] = [];
  const leftOut: { path: string; reason: string }[] = [];
  if (input.records && input.records.length > 0)
    progress({ stage: "Writing the records around the books", done: null, total: null });
  for (const record of input.records ?? []) {
    let text: string;
    try {
      text = await record.produce();
    } catch (error) {
      leftOut.push({
        path: record.path,
        reason:
          error instanceof ApplicationError
            ? error.message.replace(/\s+/g, " ").replace(/\.$/, "").slice(0, 160)
            : "it could not be read",
      });
      continue;
    }
    files.push(await writeFile(sink, record.path, record.lineOriented, (write) => write(text)));
    written.push({ path: record.path, what: record.what });
  }

  const counts: ExportCounts = {
    journals: state.journals.length,
    postings,
    accounts: ordered.length,
    commands,
    sources: usedSources.length,
  };
  const genesisSha256 = await sha256Hex(input.ledger.genesis);

  files.push(
    await writeFile(sink, "book.json", false, async (write) => {
      await write(
        `${JSON.stringify(
          {
            format: EXPORT_FORMAT,
            book: {
              id: input.book.id,
              name: input.book.name,
              currency: input.book.currency,
              ...(input.book.entity ? { entity: input.book.entity } : {}),
            },
            setup: input.setup,
            periods: state.periods.map((period) => ({
              id: period.id,
              label: period.label,
              fiscalYear: period.fiscalYear.toString(),
              sequence: period.sequence.toString(),
              startsOn: String(period.startsOn),
              endsOn: String(period.endsOn),
            })),
            ledger: {
              formatId: LEDGER_FORMAT_ID,
              head: input.ledger.head,
              genesisSha256,
              outcomes: commands,
              genesis: input.ledger.genesis,
            },
          },
          null,
          2,
        )}\n`,
      );
    }),
  );
  files.push(
    await writeFile(sink, "README.md", false, (write) =>
      write(
        exportReadme({
          id: input.id,
          createdAt: input.createdAt,
          bookName: input.book.name,
          currency: input.book.currency,
          head: input.ledger.head,
          counts,
          ...(input.records ? { records: { written, leftOut } } : {}),
        }),
      ),
    ),
  );

  progress({ stage: "Sealing the manifest", done: null, total: null });
  const manifest = await sealExportManifest({
    id: input.id,
    createdAt: input.createdAt,
    book: input.book,
    ledger: {
      formatId: LEDGER_FORMAT_ID,
      head: input.ledger.head,
      genesisSha256,
      outcomes: commands,
    },
    counts,
    files,
  });
  const manifestFile = await writeFile(sink, "manifest.json", false, (write) =>
    write(`${JSON.stringify(manifest, null, 2)}\n`),
  );
  await writeFile(sink, "SHA256SUMS", true, (write) =>
    write(
      [...files, manifestFile]
        .sort((a, b) => (a.path < b.path ? -1 : 1))
        .map((file) => `${file.sha256}  ${file.path}\n`)
        .join(""),
    ),
  );
  return manifest;
}
