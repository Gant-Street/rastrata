/** The year-end pack: the year's statements, the tax worksheet and its detail, the 1099 vendor totals
 * and the sales-tax summary where they exist, a README that says plainly what is and is not in it, and
 * a manifest that ties every file to the population it was built from.
 *
 * It is a set of files as data: a path, a media type, a description and UTF-8 text. The service
 * returns them and the person's own machine writes them (the CLI to a folder or a zip, the browser to a
 * download), so this code stays portable. Everything in it is a function of one book revision, the tags
 * in force, the dates and the form, and nothing in any file is a clock reading: building the pack again
 * from the same book gives the same bytes, which is what lets an accountant, or a test, check it.
 *
 * Rastrata books and reports. The pack contains no tax advice, files nothing and calculates no tax.
 * Pure and portable. */
import type { BookState } from "@rastrata/kernel";

import type {
  BookEntityProfile,
  TaxCheck,
  TaxPackFile,
  TaxWorksheet,
} from "../client-contracts.gen.ts";
import { sha256Hex } from "../ingest/hash.ts";
import { sanitizeText } from "../ingest/text.ts";
import { exportStatement } from "../reports/export.ts";
import { closeStatement, type YearClose } from "./close.ts";
import { type TaxFile, worksheetFiles } from "./files.ts";
import { TAX_DISCLAIMER_LONG } from "./sources.ts";
import type { analyzeWorksheet, WorksheetRequest } from "./worksheet.ts";

export const PACK_FORMAT = "rastrata-year-end-pack-v1";
export const CPA_PACKET_FORMAT = "rastrata-cpa-packet-v1";

const STATEMENTS = [
  [
    "profit-loss",
    "statements/profit-and-loss.csv",
    "Profit and loss for the dates of the tax year: income, gains and expenses by account, and net income.",
  ],
  [
    "balance-sheet",
    "statements/balance-sheet.csv",
    "Balance sheet as of the last day: assets, liabilities and equity, with the accounting-equation check.",
  ],
  [
    "cash-flow",
    "statements/cash-flow.csv",
    "Cash-flow statement for the dates, tied to the accounts tagged as cash. It says so if no account is.",
  ],
  [
    "trial-balance",
    "statements/trial-balance.csv",
    "Trial balance as of the last day: every account's balance, debits and credits.",
  ],
  [
    "general-ledger",
    "statements/general-ledger.csv",
    "General ledger for the dates: every posting of every account with running balances.",
  ],
] as const;

/** Sorted keys and two-space indentation, so the same value is always the same text. */
export function pretty(value: unknown): string {
  const sorted = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(sorted)
      : item && typeof item === "object"
        ? Object.fromEntries(
            Object.entries(item as Record<string, unknown>)
              .filter(([, member]) => member !== undefined)
              .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
              .map(([key, member]) => [key, sorted(member)]),
          )
        : item;
  return `${JSON.stringify(sorted(value), null, 2)}\n`;
}

const utf8 = new TextEncoder();

export function packFile(file: TaxFile): TaxPackFile {
  return {
    path: file.path,
    mediaType: file.mediaType,
    description: file.description,
    bytes: utf8.encode(file.content).length,
    sha256: sha256Hex(file.content),
    ...(file.population ? { population: file.population } : {}),
    content: file.content,
  };
}

export interface PackInput {
  readonly state: BookState;
  readonly request: WorksheetRequest;
  readonly bookName: string;
  /** Optional legal entity profile recorded on the book. */
  readonly entity?: BookEntityProfile | undefined;
  /** Optional format override (defaults to `PACK_FORMAT`; CPA packet uses `CPA_PACKET_FORMAT`). */
  readonly format?: string;
  /** Optional top-level folder name override. */
  readonly folder?: string;
  /** Optional title prefix for README.md ("Year-end pack" by default, "CPA packet" for unified bundle). */
  readonly title?: string;
  /** The worksheet and its postings, when the caller has already compiled them (the checks need the
   * worksheet too): the pack then does not read the book a second time for it. */
  readonly analysis: ReturnType<typeof analyzeWorksheet>;
  /** Files the other parts of the lane add (the 1099 vendor totals, the sales-tax summary, accounting files). */
  readonly extra: readonly TaxFile[];
  /** Additional population hashes contributed by `extra` files (for manifest.json). */
  readonly extraPopulations?: Readonly<Record<string, string>>;
  /** Optional extra README paragraphs (e.g. from accountant contributors). */
  readonly extraReadmes?: readonly string[];
  /** Optional notes about files that could not be made. */
  readonly extraNotes?: readonly string[];
  readonly checks: readonly TaxCheck[];
  /** Whether the books for the range are closed, and the last current close to tie the pack to. */
  readonly close: YearClose;
}

export interface BuiltPack {
  readonly folder: string;
  readonly worksheet: TaxWorksheet;
  readonly files: readonly TaxPackFile[];
  readonly manifestSha256: string;
  readonly populations: Readonly<Record<string, string>>;
}

const STATUS_WORD: Readonly<Record<TaxCheck["status"], string>> = {
  ok: "ok",
  attention: "needs a look",
  unknown: "could not be checked",
};

function entityReadmeLines(entity: BookEntityProfile | undefined): string[] {
  if (!entity) return [];
  const rows: string[] = [];
  if (entity.legalName) rows.push(`Legal name: ${sanitizeText(entity.legalName, 200)}`);
  if (entity.ein) rows.push(`EIN: ${entity.ein}`);
  if (entity.entityType) rows.push(`Entity type: ${entity.entityType}`);
  if (entity.formationState) rows.push(`Formation state: ${entity.formationState}`);
  if (entity.address) {
    const cityState = [entity.address.city, entity.address.state].filter(Boolean).join(", ");
    const locality = [cityState, entity.address.postalCode].filter(Boolean).join(" ");
    const addr = [entity.address.line1, entity.address.line2, locality, entity.address.country]
      .filter(Boolean)
      .join(", ");
    if (addr) rows.push(`Address: ${sanitizeText(addr, 300)}`);
  }
  if (entity.contactEmail) rows.push(`Contact email: ${entity.contactEmail}`);
  return rows.length > 0 ? ["", ...rows] : [];
}

function readme(input: {
  readonly title: string;
  readonly bookName: string;
  readonly entity?: BookEntityProfile | undefined;
  readonly worksheet: TaxWorksheet;
  readonly files: readonly TaxPackFile[];
  readonly checks: readonly TaxCheck[];
  readonly close: YearClose;
  readonly extraReadmes?: readonly string[];
  readonly extraNotes?: readonly string[];
}): string {
  const { worksheet } = input;
  const sources = new Map<string, string>();
  for (const note of worksheet.notes)
    for (const source of note.sources ?? [])
      sources.set(source.url, `${source.title}, read on ${source.readOn ?? "an earlier day"}`);
  for (const form of worksheet.forms)
    for (const source of form.sources)
      if (!sources.has(source.url))
        sources.set(source.url, `${source.title}, read on ${form.verifiedOn}`);
  const lines: string[] = [
    `# ${input.title}: ${sanitizeText(input.bookName, 120)}, tax year ${worksheet.taxYear}`,
    "",
    `Covers ${worksheet.from} to ${worksheet.to}. Basis: ${worksheet.basis}. Currency: ${worksheet.currency}.`,
    `Built from book revision ${worksheet.bookRevision}.`,
    ...entityReadmeLines(input.entity),
    "",
    `**${TAX_DISCLAIMER_LONG}**`,
    "",
    "This pack is your books, totalled and listed, for you or for whoever prepares your return.",
    "",
    "## How final it is",
    "",
    closeStatement(input.close, worksheet.bookRevision),
    "",
    "## What is in this folder",
    "",
    "| File | What it is |",
    "| --- | --- |",
    ...input.files.map((file) => `| \`${file.path}\` | ${file.description} |`),
    "| `manifest.json` | Every file above with its size, its SHA-256 and the population it was built from. |",
    "",
    ...((input.extraReadmes ?? []).length > 0
      ? [
          "## What else is in this folder",
          "",
          ...(input.extraReadmes ?? []).flatMap((text) => [text, ""]),
        ]
      : []),
    ...((input.extraNotes ?? []).length > 0
      ? [
          "## Files that could not be made",
          "",
          ...(input.extraNotes ?? []).map((note) => `- ${note}`),
          "",
        ]
      : []),
    "## What is not in it",
    "",
    "- A tax return, or any form to file. Rastrata files nothing.",
    "- What you owe. No tax of any kind is calculated here: not income tax, self-employment tax or sales tax.",
    "- Anything that is not in your books: bank activity you have not imported and posted (see the checks below), cash you did not record, inventory counts, depreciation schedules, the home-office deduction, payroll or any tax form such as a W-2 or a 1099.",
    "- Advice about which tax line anything belongs on. A tax line is a suggestion taken from the IRS form; accounts with no line from the form are listed as not mapped, never guessed.",
    "",
    "## Before you rely on it",
    "",
    ...input.checks.map(
      (check) => `- **${check.title}** (${STATUS_WORD[check.status]}): ${check.detail}`,
    ),
    "",
    "## How to check it",
    "",
    "Every figure comes from one version of the books. `manifest.json` lists each file's SHA-256, and each figure file carries a population hash in its first rows: the same book revision, tags, dates and form always give the same hashes. A file that differs from the manifest was changed after the pack was written.",
    "",
    `The profit and loss in \`statements/\` and the worksheet agree to the cent: the worksheet's last section reconciles its net to the profit and loss's net income (${worksheet.reconciliation.netIncomeBooks}).`,
    "",
    "Open the CSV files in any spreadsheet. A cell that begins with a quote mark was text that a spreadsheet could mistake for a formula; the quote is part of the protection.",
    "",
    "## Where the rules in the worksheet come from",
    "",
    ...[...sources.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([url, title]) => `- ${title}: ${url}`),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

/** What a manifest records about the close: the state, the counts and the last current close, so the pack
 * can be tied to the books as they were closed. */
export function closeManifest(close: YearClose, bookRevision: string) {
  return {
    state: close.state,
    periods: close.periods.length,
    closed: close.closed,
    superseded: close.superseded,
    open: close.open,
    last: close.last
      ? {
          periodId: close.last.id,
          label: close.last.label,
          startsOn: close.last.startsOn,
          endsOn: close.last.endsOn,
          closingRevision: close.last.closingRevision,
          reportPopulationHash: close.last.reportPopulationHash,
        }
      : null,
    statement: closeStatement(close, bookRevision),
  };
}

export function buildPack(input: PackInput): BuiltPack {
  const { state, request, bookName } = input;
  const made: TaxFile[] = [];
  const populations: Record<string, string> = {};
  const exports = STATEMENTS.map(([statement, path, description]) => {
    const file = exportStatement(state, {
      statement,
      asOf: request.to,
      from: request.from,
      bookName,
      tags: request.tags,
    });
    populations[statement === "cash-flow" ? "cashFlow" : "ledger"] = file.populationHash;
    return { path, description, file };
  });
  for (const { path, description, file } of exports)
    made.push({
      path,
      mediaType: file.mediaType,
      description,
      content: file.content,
      population: file.populationHash,
    });
  const { worksheet, files: sheets } = worksheetFiles(
    state,
    request,
    bookName,
    "tax/",
    input.analysis,
  );
  populations.worksheet = worksheet.populationHash;
  populations.tagMap = worksheet.tagMapHash;
  if (input.extraPopulations)
    for (const [key, value] of Object.entries(input.extraPopulations)) populations[key] = value;
  made.push(sheets.worksheet, sheets.accounts, sheets.postings, ...input.extra);
  const body = made.map(packFile);
  const readmeFile = packFile({
    path: "README.md",
    mediaType: "text/markdown; charset=utf-8",
    description: "What this pack is, what is and is not in it, and the checks to look at first.",
    content: readme({
      title: input.title ?? "Year-end pack",
      bookName,
      ...(input.entity ? { entity: input.entity } : {}),
      worksheet,
      files: body,
      checks: input.checks,
      close: input.close,
      ...(input.extraReadmes ? { extraReadmes: input.extraReadmes } : {}),
      ...(input.extraNotes ? { extraNotes: input.extraNotes } : {}),
    }),
    population: null,
  });
  const files = [readmeFile, ...body];
  const manifest = {
    format: input.format ?? PACK_FORMAT,
    taxYear: worksheet.taxYear,
    form: {
      id: worksheet.form.id,
      name: worksheet.form.name,
      status: worksheet.form.status,
    },
    range: { from: worksheet.from, to: worksheet.to },
    book: {
      name: sanitizeText(bookName, 120),
      currency: worksheet.currency,
      basis: worksheet.basis,
      ...(input.entity ? { entity: input.entity } : {}),
    },
    bookRevision: worksheet.bookRevision,
    postingSequence: worksheet.postingSequence,
    tagsRevision: worksheet.tagsRevision,
    populations,
    close: closeManifest(input.close, worksheet.bookRevision),
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
    folder: input.folder ?? `rastrata-year-end-${worksheet.taxYear}`,
    worksheet,
    files: [...files, manifestFile],
    manifestSha256: manifestFile.sha256,
    populations,
  };
}
