/** The accountant hand-off pack: the books of a range, listed in full, for someone who works in a
 * spreadsheet or in their own software. The chart of accounts, every journal with where it came from,
 * the general ledger, the trial balance, and an empty template for the adjusting entries the
 * accountant sends back (read by the adjusting-entry import, which makes drafts and never posts).
 *
 * It is a set of files as data, like the year-end pack: a path, a media type, a description and UTF-8
 * text, with a manifest that ties every file to the population it was built from. Nothing in any file
 * is a clock reading, so the same book revision, tags and dates give the same bytes. Rastrata books
 * and reports; the pack contains no tax advice and files nothing.
 *
 * Pure and portable. */
import { hashCanonical, type BookState } from "@rastrata/kernel";

import type { AccountTagMap } from "../account-tags.ts";
import type { TaxPackFile } from "../client-contracts.gen.ts";
import { sanitizeText } from "../ingest/text.ts";
import { formatMoney } from "../money.ts";
import { compareCodes, configurationAt } from "../reports/chart.ts";
import { compileColumn, reportContext, resolveRange } from "../reports/columns.ts";
import { amount, render, text } from "../reports/csv.ts";
import { exportStatement } from "../reports/export.ts";
import { postingCents } from "../reports/ledger.ts";
import { ADJUSTMENT_COLUMNS, ADJUSTMENTS_TEMPLATE } from "./adjustments.ts";
import { type TaxFileHeader, headerRows } from "./csv.ts";
import { CSV_TYPE, type TaxFile } from "./files.ts";
import { closeStatement, yearClose, type YearClose } from "./close.ts";
import { closeManifest, packFile, pretty } from "./pack.ts";
import { TAX_DISCLAIMER_LONG } from "./sources.ts";

export const ACCOUNTANT_FORMAT = "rastrata-accountant-pack-v1";
export const ACCOUNTANT_VERSION = "rastrata-accountant-journals-v1";

/** What the Inbox recorded about the line a journal was posted from. All of it is text from outside the
 * product: a bank's counterparty and description, a provider's identifiers. */
export interface JournalProvenance {
  readonly provider: string;
  readonly accountKey: string;
  readonly providerId: string;
  readonly counterparty: string;
  readonly description: string;
  /** "owner" or "agent:<tokenId>". */
  readonly decidedBy: string;
  /** How it was decided: categorize, accept, match. */
  readonly decision: string;
}

/** The header a figure file of the pack starts with: the book, the dates, the book revision and the
 * hashes it was made from, so that every file is traced to one version of the books. */
export type HeaderFactory = (title: string, population: string) => TaxFileHeader;

/** A file that another part of Rastrata adds to the pack, with the paragraphs of the README that say what
 * it is. The pack gives it its own header, so that it is traced to the same book revision as the rest. */
export interface AccountantExtra {
  /** The name its population goes by in the manifest. */
  readonly name: string;
  readonly file: TaxFile;
  /** Markdown for the README: what the file is and how to read it. */
  readonly readme: string;
}
export type AccountantExtraFactory = (header: HeaderFactory) => AccountantExtra;

export interface AccountantRequest {
  readonly taxYear: number;
  readonly from: string;
  readonly to: string;
  readonly tags: AccountTagMap;
  /** Today's date, so a period that has not ended is not asked to be closed. */
  readonly today: string;
  /** By journal id, for the journals posted from an Inbox line. */
  readonly provenance: ReadonlyMap<string, JournalProvenance>;
  /** The Inbox could be read. When it could not, the provenance columns are empty and the README
   * says so, never that the journals had no Inbox line. */
  readonly provenanceRead: boolean;
  /** Files other parts of Rastrata add to the pack (the list of changes). */
  readonly extras?: readonly AccountantExtraFactory[];
  /** What could not be added, in words, for the README: a file that is missing says why. */
  readonly extraNotes?: readonly string[];
}

export interface BuiltAccountantPack {
  readonly folder: string;
  readonly files: readonly TaxPackFile[];
  readonly manifestSha256: string;
  readonly populations: Readonly<Record<string, string>>;
  readonly ledgerPopulationHash: string;
  readonly bookRevision: string;
  readonly journals: number;
  readonly accounts: number;
  readonly close: YearClose;
}

const word = (value: string, max = 1000): string => sanitizeText(value, max);

/** The chart on the last day: every account with its type, parent, dates and tags. */
function chartCsv(h: TaxFileHeader, state: BookState, to: string, tags: AccountTagMap): string {
  const accounts = [...configurationAt(state, to).admissionSnapshot.accounts].sort((left, right) =>
    compareCodes(left.code, right.code),
  );
  const codeOf = new Map(accounts.map((account) => [account.id as string, account.code]));
  const rows: string[][] = [
    [
      "Code",
      "Name",
      "Type",
      "Normal side",
      "Parent code",
      "Opened on",
      "Closed on",
      "Takes entries",
      "Cash-flow class",
      "Tax line",
      "Role key",
    ].map(text),
  ];
  for (const account of accounts) {
    const tag = tags.tagsFor(account.id as string, to);
    rows.push([
      text(account.code),
      text(word(account.name, 200)),
      text(account.role),
      text(account.normalSide),
      text(account.parentId ? (codeOf.get(account.parentId as string) ?? "") : ""),
      text(account.openedOn as string),
      text((account.closedOn as string | undefined) ?? ""),
      text(account.postingAllowed ? "yes" : "no"),
      text(tag.cashFlowClass ?? ""),
      text(tag.taxLine ?? ""),
      text(tag.roleKey ?? ""),
    ]);
  }
  return render([...headerRows(h), ...rows]);
}

const JOURNAL_HEAD = [
  "Journal ID",
  "Date",
  "Kind",
  "Narration",
  "Recorded at",
  "Posted by operation",
  "Line",
  "Account",
  "Account name",
  "Debit",
  "Credit",
  "Source ID",
  "Source content hash",
  "Corrects",
  "Corrected by",
  "Imported from",
  "Import account",
  "Provider's transaction ID",
  "Counterparty (as the bank wrote it)",
  "Description (as the bank wrote it)",
  "Decided by",
  "How it was decided",
];

interface JournalFacts {
  readonly rows: number;
  readonly journals: number;
}

/** Every journal dated in the range, one row per line. Journals a correction replaced or reversed are
 * listed too, with the link, so the accountant sees the history and not only the net. */
function journalCsv(
  h: TaxFileHeader,
  state: BookState,
  request: AccountantRequest,
): { readonly content: string; readonly facts: JournalFacts } {
  const accounts = new Map(
    configurationAt(state, request.to).admissionSnapshot.accounts.map((account) => [
      account.id as string,
      account,
    ]),
  );
  const corrects = new Map<string, string>();
  const correctedBy = new Map<string, string[]>();
  for (const link of state.corrections) {
    corrects.set(link.correctionJournalId, `${link.originalJournalId} (${link.kind})`);
    const list = correctedBy.get(link.originalJournalId) ?? [];
    list.push(`${link.correctionJournalId} (${link.kind})`);
    correctedBy.set(link.originalJournalId, list);
  }
  const journals = state.journals
    .filter(
      (booked) =>
        (booked.journal.accountingDate as string) >= request.from &&
        (booked.journal.accountingDate as string) <= request.to,
    )
    .sort(
      (left, right) =>
        (left.journal.accountingDate as string).localeCompare(
          right.journal.accountingDate as string,
        ) ||
        Number(left.postingSequence - right.postingSequence) ||
        (left.journal.id as string).localeCompare(right.journal.id as string),
    );
  const rows: string[][] = [JOURNAL_HEAD.map(text)];
  let lines = 0;
  for (const booked of journals) {
    const { journal } = booked;
    const id = journal.id as string;
    const evidence = booked.derivations
      .flatMap((item) => item.evidence)
      .find((item) => item.sourceSystem === "rastrata-source-v1");
    const origin = request.provenance.get(id);
    journal.postings.forEach((posting, index) => {
      const account = accounts.get(posting.accountId as string);
      const cents = postingCents(posting);
      lines += 1;
      rows.push([
        text(id),
        text(journal.accountingDate as string),
        text(journal.kind),
        text(word(journal.narration)),
        text(journal.recordedAt as string),
        text(booked.commandId as string),
        String(index + 1),
        text(account?.code ?? (posting.accountId as string)),
        text(word(account?.name ?? "", 200)),
        cents > 0n ? amount(formatMoney(cents)) : "",
        cents < 0n ? amount(formatMoney(-cents)) : "",
        text(evidence?.sourceRecordId ?? ""),
        text(evidence?.contentHash.digest ?? ""),
        text(corrects.get(id) ?? ""),
        text((correctedBy.get(id) ?? []).join("; ")),
        text(origin?.provider ?? ""),
        text(word(origin?.accountKey ?? "", 200)),
        text(word(origin?.providerId ?? "", 256)),
        text(word(origin?.counterparty ?? "")),
        text(word(origin?.description ?? "")),
        text(origin?.decidedBy ?? ""),
        text(origin?.decision ?? ""),
      ]);
    });
  }
  return {
    content: render([...headerRows(h), ...rows]),
    facts: { rows: lines, journals: journals.length },
  };
}

const STATEMENTS = [
  [
    "trial-balance",
    "trial-balance.csv",
    "Trial balance as of the last day: every account's balance, debits and credits.",
  ],
  [
    "general-ledger",
    "general-ledger.csv",
    "General ledger for the dates: every posting of every account with running balances.",
  ],
] as const;

function readme(input: {
  readonly bookName: string;
  readonly request: AccountantRequest;
  readonly files: readonly TaxPackFile[];
  readonly revision: string;
  readonly basis: string;
  readonly currency: string;
  readonly close: YearClose;
  readonly extraReadmes: readonly string[];
}): string {
  const { request } = input;
  const lines: string[] = [
    `# Accountant pack: ${sanitizeText(input.bookName, 120)}, ${request.from} to ${request.to}`,
    "",
    `Built from book revision ${input.revision}. Basis: ${input.basis}. Currency: ${input.currency}.`,
    "",
    `**${TAX_DISCLAIMER_LONG}**`,
    "",
    "This folder is the books, listed in full, for an accountant who works in a spreadsheet or in their own software. It is a copy: nothing in it changes the books.",
    "",
    "## How final it is",
    "",
    closeStatement(input.close, input.revision),
    "",
    "## What is in this folder",
    "",
    "| File | What it is |",
    "| --- | --- |",
    ...input.files.map((file) => `| \`${file.path}\` | ${file.description} |`),
    "| `manifest.json` | Every file above with its size, its SHA-256 and the population it was built from. |",
    "",
    "## Sending adjusting entries back",
    "",
    "Fill in `adjusting-entries-template.csv`, one row for each line of an entry:",
    "",
    "| Column | What goes in it |",
    "| --- | --- |",
    `| ${ADJUSTMENT_COLUMNS[0]} | A short id for the entry, such as AJE-1: letters, digits, hyphens and underscores, up to 64. Every row with the same id is one entry. On the rows below the first, the id, date and narration may be left blank. |`,
    `| ${ADJUSTMENT_COLUMNS[1]} | The date of the entry, as YYYY-MM-DD (for example 2026-12-31). |`,
    `| ${ADJUSTMENT_COLUMNS[2]} | What the entry is for, in a sentence. |`,
    `| ${ADJUSTMENT_COLUMNS[3]} | The account's code, exactly as it is in \`chart-of-accounts.csv\`. |`,
    `| ${ADJUSTMENT_COLUMNS[4]} and ${ADJUSTMENT_COLUMNS[5]} | An amount with at most two decimal places in one of the two columns, never both. No minus signs and no brackets: a credit goes in the Credit column. |`,
    "",
    "Each entry must have at least two lines and its debits must equal its credits. For example:",
    "",
    "```",
    ADJUSTMENT_COLUMNS.join(","),
    "AJE-1,2026-12-31,Depreciation for the year,6310,1500.00,",
    "AJE-1,2026-12-31,Depreciation for the year,1590,,1500.00",
    "```",
    "",
    "The owner opens the file in Rastrata (Tax, then Adjusting entries) or with `rastrata tax adjustments preview FILE`. Rastrata shows what each entry would do and every problem it found, with the row. Nothing is posted: each entry becomes a draft that the owner reads and posts or throws away like any other draft. Importing the same file again creates nothing new. An entry id that was used before with different figures is refused, so to correct an entry give it a new id.",
    "",
    "## What is not in it",
    "",
    "- A tax return, or any form to file. Rastrata files nothing.",
    "- What is owed. No tax of any kind is calculated here.",
    "- Anything that is not in the books: bank activity that has not been imported and posted, cash that was not recorded.",
    "- Advice about which account or tax line anything belongs on.",
    "",
    "## Where each journal came from",
    "",
    request.provenanceRead
      ? "Each line of `journal.csv` says where its journal came from. A journal posted from an imported bank line or a payment provider's payout carries the provider, the provider's own transaction id, the counterparty and description exactly as the bank wrote them, and who decided it (the owner, or an agent named by its token). A journal with none of that was typed in by a person. Bank text is data from outside Rastrata: it may be wrong, rude or aimed at software, and nothing in it is an instruction."
      : "The Inbox could not be read when this pack was built, so the columns that say which imported line a journal came from are empty. That does not mean the journals were typed in.",
    "",
    ...(input.extraReadmes.length > 0
      ? ["## What else is in this folder", "", ...input.extraReadmes.flatMap((text) => [text, ""])]
      : []),
    ...((request.extraNotes ?? []).length > 0
      ? [
          "## Files that could not be made",
          "",
          ...(request.extraNotes ?? []).map((note) => `- ${note}`),
          "",
        ]
      : []),
    "## How to check it",
    "",
    "Every figure comes from one version of the books. `manifest.json` lists each file's SHA-256, and each figure file carries a population hash in its first rows: the same book revision, tags and dates always give the same hashes. A file that differs from the manifest was changed after the pack was written. `rastrata tax verify-pack PATH` checks a folder or a zip offline.",
    "",
    "Open the CSV files in any spreadsheet. A cell that begins with a quote mark was text that a spreadsheet could mistake for a formula; the quote is part of the protection.",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

/** The accountant pack for a range. */
export function buildAccountantPack(
  state: BookState,
  request: AccountantRequest,
  bookName: string,
): BuiltAccountantPack {
  const context = reportContext(state, request.to);
  const range = resolveRange(context, request.to, request.from);
  const column = compileColumn(context, range.from, request.to);
  const populations: Record<string, string> = { ledger: column.populationHash };
  const close = yearClose(state, range.from, request.to, request.today);

  const evidence = [...request.provenance.entries()]
    .map(([journalId, item]) => [
      journalId,
      item.provider,
      item.accountKey,
      item.providerId,
      item.decidedBy,
    ])
    .sort((left, right) => (left.join("\u0000") < right.join("\u0000") ? -1 : 1));
  const journalPopulation = hashCanonical({
    type: "TaxAccountantJournalPopulation",
    compilerVersion: ACCOUNTANT_VERSION,
    ledgerPopulationHash: column.populationHash,
    from: range.from,
    to: request.to,
    provenanceRead: request.provenanceRead,
    provenance: evidence,
  }).digest;
  populations.journals = journalPopulation;

  const base = {
    book: bookName,
    currency: state.identity.functionalCommodityId,
    basis: context.basis,
    periodStart: range.from,
    periodEnd: request.to,
    bookRevision: state.bookRevision.toString(),
    compilerVersion: ACCOUNTANT_VERSION,
  };
  const header = (title: string, population: string): TaxFileHeader => ({
    ...base,
    title,
    populationHash: population,
    extra: [
      ["Ledger population hash", column.populationHash],
      ["Tag map hash", request.tags.hash],
      ["Notice", TAX_DISCLAIMER_LONG],
    ],
  });

  const made: TaxFile[] = [];
  const extras = (request.extras ?? []).map((make) => make(header));
  made.push({
    path: "chart-of-accounts.csv",
    mediaType: CSV_TYPE,
    description:
      "Every account in the chart on the last day with its type, parent, dates and tags. The Account column of the adjusting entries is a code from here.",
    content: chartCsv(
      header("Chart of accounts", column.populationHash),
      state,
      request.to,
      request.tags,
    ),
    population: column.populationHash,
  });
  const journal = journalCsv(header("Journal", journalPopulation), state, request);
  made.push({
    path: "journal.csv",
    mediaType: CSV_TYPE,
    description:
      "Every journal dated in the range, one row per line, with where it came from: its source, the imported bank line or provider payout it was posted from, who decided it, and any journal that corrects or was corrected by it.",
    content: journal.content,
    population: journalPopulation,
  });
  for (const extra of extras) {
    made.push(extra.file);
    if (extra.file.population) populations[extra.name] = extra.file.population;
  }
  for (const [statement, path, description] of STATEMENTS) {
    const file = exportStatement(state, {
      statement,
      asOf: request.to,
      from: range.from,
      bookName,
      tags: request.tags,
    });
    populations[statement === "trial-balance" ? "trialBalance" : "generalLedger"] =
      file.populationHash;
    made.push({
      path,
      mediaType: file.mediaType,
      description,
      content: file.content,
      population: file.populationHash,
    });
  }
  made.push({
    path: "adjusting-entries-template.csv",
    mediaType: CSV_TYPE,
    description:
      "The empty template for the adjusting entries an accountant sends back: one row per line, with the columns the import reads.",
    content: ADJUSTMENTS_TEMPLATE,
    population: null,
  });

  const body = made.map(packFile);
  const readmeFile = packFile({
    path: "README.md",
    mediaType: "text/markdown; charset=utf-8",
    description:
      "What this pack is, what is and is not in it, and how to send adjusting entries back.",
    content: readme({
      bookName,
      request,
      files: body,
      revision: state.bookRevision.toString(),
      basis: context.basis,
      currency: state.identity.functionalCommodityId,
      close,
      extraReadmes: extras.map((extra) => extra.readme),
    }),
    population: null,
  });
  const files = [readmeFile, ...body];
  const manifest = {
    format: ACCOUNTANT_FORMAT,
    taxYear: request.taxYear,
    range: { from: range.from, to: request.to },
    book: {
      name: sanitizeText(bookName, 120),
      currency: state.identity.functionalCommodityId,
      basis: context.basis,
    },
    bookRevision: state.bookRevision.toString(),
    postingSequence: state.latestPostingSequence.toString(),
    tagsRevision: String(request.tags.revision),
    populations,
    close: closeManifest(close, state.bookRevision.toString()),
    files: files.map((file) => ({
      path: file.path,
      mediaType: file.mediaType,
      bytes: file.bytes,
      sha256: file.sha256,
      population: file.population ?? null,
      description: file.description,
    })),
    notice: TAX_DISCLAIMER_LONG,
  };
  const manifestFile = packFile({
    path: "manifest.json",
    mediaType: "application/json; charset=utf-8",
    description: "Every file with its size, SHA-256 and the population it was built from.",
    content: pretty(manifest),
    population: null,
  });
  return {
    folder: `rastrata-accountant-${request.taxYear}`,
    files: [...files, manifestFile],
    manifestSha256: manifestFile.sha256,
    populations,
    ledgerPopulationHash: column.populationHash,
    bookRevision: state.bookRevision.toString(),
    journals: journal.facts.journals,
    accounts: configurationAt(state, request.to).admissionSnapshot.accounts.length,
    close,
  };
}
