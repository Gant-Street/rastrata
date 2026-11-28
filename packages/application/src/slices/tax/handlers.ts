import type { BookState } from "@rastrata/kernel";

import { ApplicationError } from "../../errors.ts";
import {
  ACCOUNTANT_FORMAT,
  buildAccountantPack,
  buildAccountantSupplement,
} from "../../tax/accountant.ts";
import { type TaxFile, worksheetFiles, type WorksheetFileKind } from "../../tax/files.ts";
import { TAX_YEARS } from "../../chart/tax-lines.ts";
import { isWorksheetForm } from "../../tax/forms.ts";
import { closeStatement, yearClose } from "../../tax/close.ts";
import { buildPack, CPA_PACKET_FORMAT, PACK_FORMAT } from "../../tax/pack.ts";
import { readBookSettings } from "../entries/settings.ts";
import { analyzeSalesTax } from "../../tax/sales.ts";
import { TAX_DISCLAIMER_LONG } from "../../tax/sources.ts";
import {
  analyzeWorksheet,
  compileWorksheet,
  DEFAULT_MEALS_PERCENT,
  defaultWorksheetForm,
  type WorksheetRequest,
} from "../../tax/worksheet.ts";
import type { SliceContext, SliceHandlers } from "../types.ts";
import { taxChecks } from "./checks.ts";
import { journalProvenance, packContributions } from "./accountant.ts";
import { importAdjustments, previewOf, readAdjustments } from "./adjustments.ts";
import { booksStartOn, revisionOf, tagsOf, taxRange } from "./context.ts";
import { salesExportFile, salesPackFiles, salesRequest } from "./sales.ts";
import { readTaxState, taxRuntime } from "./store.ts";
import {
  analyzeVendors,
  inboxPayees,
  saveVendor,
  setReportableAccounts,
  vendorDetail,
  vendorPackFiles,
  type VendorsRequest,
} from "./vendors.ts";

/** A file this size is far past what a spreadsheet opens, and past the 16 MB the contract allows. */
const MAX_FILE_CHARACTERS = 16_000_000;

/** The worksheet request an operation's input describes, read from the book as it stands (or at a
 * pinned revision). */
async function worksheetRequest(
  input: Record<string, unknown>,
  { service }: SliceContext,
  /** The book, when the caller has already read it. */
  known?: BookState,
): Promise<{ state: BookState; request: WorksheetRequest }> {
  const { taxYear, from, to } = taxRange(input);
  const state = known ?? (await service.readAggregate(revisionOf(input))).aggregate.state;
  const tags = tagsOf(service, input);
  return {
    state,
    request: {
      taxYear,
      form: isWorksheetForm(input.form) ? input.form : defaultWorksheetForm(state, tags, to),
      from,
      to,
      mealsPercent:
        typeof input.mealsPercent === "number" ? input.mealsPercent : DEFAULT_MEALS_PERCENT,
      tags,
      today: service.today(),
      booksStartOn: booksStartOn(service),
    },
  };
}

/** What the 1099 vendor list is read from: the book, the tags, what a person recorded about vendors
 * (pinned to a recorded revision when asked) and the Inbox's payees. A caller that has already read
 * the book (the year-end pack) passes it, so every file of one pack is from one revision. */
async function vendorsRequest(
  input: Record<string, unknown>,
  context: SliceContext,
  base?: { readonly state: BookState; readonly tags: ReturnType<typeof tagsOf> },
): Promise<VendorsRequest> {
  const { service } = context;
  const { taxYear, from, to } = taxRange(input);
  const state = base?.state ?? (await service.readAggregate(revisionOf(input))).aggregate.state;
  const product = readTaxState(
    taxRuntime(service).store,
    typeof input.vendorsRevision === "string"
      ? { throughRevision: Number(input.vendorsRevision) }
      : {},
  );
  // With no account marked there are no payments to attribute, so the Inbox is not read at all.
  const { payees, read } =
    product.reportable.size > 0
      ? await inboxPayees(context, from, to)
      : { payees: new Map(), read: true };
  return {
    taxYear,
    from,
    to,
    state,
    tags: base?.tags ?? tagsOf(service, input),
    product,
    payees,
    payeesRead: read,
    today: service.today(),
  };
}

/** The close as the wire carries it: the state, the counts, the last current close and the sentence that
 * says it in plain words. */
function closeWire(close: ReturnType<typeof yearClose>, bookRevision: string) {
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
          closingRevision: close.last.closingRevision as string,
          reportPopulationHash: close.last.reportPopulationHash as string,
        }
      : null,
    statement: closeStatement(close, bookRevision),
  };
}

/** The sales-tax summary for the book a caller has already read, so every part of one answer is from
 * one revision. */
async function salesAnalysis(
  input: Record<string, unknown>,
  context: SliceContext,
  state: BookState,
  tags: ReturnType<typeof tagsOf>,
) {
  const { request } = await salesRequest(input, context, { state, tags });
  return analyzeSalesTax(state, request);
}

const salesSummary = async (
  input: Record<string, unknown>,
  context: SliceContext,
  state: BookState,
  tags: ReturnType<typeof tagsOf>,
) => (await salesAnalysis(input, context, state, tags)).summary;

/** The worksheet for the year and every readiness check, from one read of the book. */
async function readChecks(
  input: Record<string, unknown>,
  context: SliceContext,
  known?: BookState,
) {
  const { state, request } = await worksheetRequest(input, context, known);
  const worksheet = compileWorksheet(state, request);
  const checks = await taxChecks(context, {
    state,
    worksheet,
    today: request.today,
    booksStartOn: request.booksStartOn ?? null,
    vendors: analyzeVendors(await vendorsRequest(input, context, { state, tags: request.tags }))
      .wire,
    sales: await salesSummary(input, context, state, request.tags),
  });
  return { state, request, worksheet, checks };
}

/** The tax year a first read should show: among the verified years the book's calendar covers whole, the
 * one nearest the year the service's clock is in (the later when two are as near). A book opened in
 * 2027 is shown 2026, the last year Rastrata has verified; a book that only covers 2025 is shown 2025.
 * When the calendar covers none of them the nearest verified year is read, and the service says the
 * calendar must be extended. */
function defaultTaxYear(state: BookState, years: readonly number[], clockYear: number): number {
  const regular = state.periods.filter((period) => period.kind === "regular");
  const first = regular.map((period) => period.startsOn as string).sort()[0];
  const last = regular
    .map((period) => period.endsOn as string)
    .sort()
    .at(-1);
  const covered = years.filter(
    (year) =>
      first !== undefined &&
      last !== undefined &&
      first <= `${year}-01-01` &&
      `${year}-12-31` <= last,
  );
  const pool = covered.length > 0 ? covered : years;
  return pool.reduce((best, year) => {
    const nearer = Math.abs(year - clockYear) - Math.abs(best - clockYear);
    return nearer < 0 || (nearer === 0 && year > best) ? year : best;
  });
}

export const taxHandlers: SliceHandlers = {
  "taxVendors.list": async (input, context) =>
    analyzeVendors(await vendorsRequest(input, context)).wire,

  "taxVendors.export": async (input, context) => {
    const request = await vendorsRequest(input, context);
    const analysis = analyzeVendors(request);
    const [vendors, payments] = vendorPackFiles(analysis, {
      book: context.service.setupState()?.name ?? "",
      bookRevision: analysis.wire.bookRevision,
      tags: request.tags,
    }) as [TaxFile, TaxFile];
    const file = input.file === "payments" ? payments : vendors;
    if (file.content.length > MAX_FILE_CHARACTERS)
      throw new ApplicationError(
        "export_too_large",
        "This file is too large to return in one piece.",
        413,
      );
    return {
      filename: `${file.path.replace(/^tax\//, "").replace(/\.csv$/, "")}-${request.taxYear}.csv`,
      mediaType: file.mediaType,
      bookRevision: analysis.wire.bookRevision,
      populationHash: analysis.wire.populationHash,
      content: file.content,
    };
  },

  "taxVendors.get": async (input, context) =>
    vendorDetail(await vendorsRequest(input, context), String(input.vendorId)),

  "taxVendors.save": (input, context) => saveVendor(context, input, context.operationId),

  "taxVendors.setAccounts": (input, context) =>
    setReportableAccounts(context, input, context.operationId),

  "taxAccountant.build": async (input, context) => {
    const { taxYear, from, to } = taxRange(input);
    const { service } = context;
    const { aggregate } = await service.readAggregate(revisionOf(input));
    const tags = tagsOf(service, input);
    const { map, read } = await journalProvenance(context, from, to);
    const added = await packContributions(context, {
      taxYear,
      from,
      to,
      revision: aggregate.state.bookRevision,
    });
    const built = buildAccountantPack(
      aggregate.state,
      {
        taxYear,
        from,
        to,
        tags,
        today: service.today(),
        provenance: map,
        provenanceRead: read,
        extras: added.extras,
        extraNotes: added.notes,
      },
      service.setupState()?.name ?? "",
    );
    for (const file of built.files)
      if (file.content.length > MAX_FILE_CHARACTERS)
        throw new ApplicationError(
          "export_too_large",
          "A file in this pack is too large to return in one piece. Choose a shorter date range.",
          413,
        );
    return {
      format: ACCOUNTANT_FORMAT,
      folder: built.folder,
      taxYear,
      from,
      to,
      bookRevision: built.bookRevision,
      ledgerPopulationHash: built.ledgerPopulationHash,
      tagMapHash: tags.hash,
      files: built.files,
      manifestSha256: built.manifestSha256,
      close: closeWire(built.close, built.bookRevision),
      journals: built.journals,
      accounts: built.accounts,
      provenanceRead: read,
      disclaimer: TAX_DISCLAIMER_LONG,
    };
  },

  "taxAdjustments.preview": async (input, context) => {
    const { aggregate } = await context.service.readAggregate();
    return previewOf(readAdjustments(input, aggregate.state, context.service.store));
  },

  "taxAdjustments.import": async (input, context) => {
    const { aggregate } = await context.service.readAggregate();
    return importAdjustments(context, input, aggregate.state, context.operationId);
  },

  "taxSales.get": async (input, context) => {
    const { state, request } = await salesRequest(input, context);
    return analyzeSalesTax(state, request).summary;
  },

  "taxSales.export": async (input, context) => {
    const { state, request } = await salesRequest(input, context);
    const analysis = analyzeSalesTax(state, request);
    const file = salesExportFile(analysis, context.service.setupState()?.name ?? "", input.file);
    if (file.content.length > MAX_FILE_CHARACTERS)
      throw new ApplicationError(
        "export_too_large",
        "This file is too large to return in one piece. Choose a shorter date range.",
        413,
      );
    return {
      filename: `${file.path.replace(/^tax\//, "").replace(/\.csv$/, "")}-${request.taxYear}.csv`,
      mediaType: file.mediaType,
      bookRevision: analysis.summary.bookRevision,
      populationHash: analysis.summary.populationHash,
      content: file.content,
    };
  },

  "taxWorksheet.get": async (input, context) => {
    const { state, request } = await worksheetRequest(input, context);
    return compileWorksheet(state, request);
  },

  "taxWorksheet.export": async (input, context) => {
    const { state, request } = await worksheetRequest(input, context);
    const kind = (typeof input.file === "string" ? input.file : "worksheet") as WorksheetFileKind;
    const { worksheet, files } = worksheetFiles(
      state,
      request,
      context.service.setupState()?.name ?? "",
    );
    const file = files[kind];
    if (file.content.length > MAX_FILE_CHARACTERS)
      throw new ApplicationError(
        "export_too_large",
        "This file is too large to return in one piece. Choose a shorter date range.",
        413,
      );
    return {
      filename: `${file.path.replace(/\.csv$/, "")}-${request.taxYear}.csv`,
      mediaType: file.mediaType,
      bookRevision: worksheet.bookRevision,
      populationHash: worksheet.populationHash,
      content: file.content,
    };
  },

  "taxChecks.get": async (input, context) => {
    const read = await readChecks(input, context);
    return {
      taxYear: read.request.taxYear,
      from: read.worksheet.from,
      to: read.worksheet.to,
      bookRevision: read.worksheet.bookRevision,
      checks: read.checks,
      attention: read.checks.filter((check) => check.status !== "ok").length,
    };
  },

  "taxSummary.get": async (input, context) => {
    const years = [...TAX_YEARS];
    const { aggregate } = await context.service.readAggregate(revisionOf(input));
    const taxYear =
      typeof input.taxYear === "number"
        ? input.taxYear
        : defaultTaxYear(aggregate.state, years, Number(context.service.today().slice(0, 4)));
    const read = await readChecks({ ...input, taxYear }, context, aggregate.state);
    return {
      years,
      taxYear: read.request.taxYear,
      from: read.worksheet.from,
      to: read.worksheet.to,
      bookRevision: read.worksheet.bookRevision,
      form: read.worksheet.form,
      checks: read.checks,
      attention: read.checks.filter((check) => check.status !== "ok").length,
      disclaimer: TAX_DISCLAIMER_LONG,
    };
  },

  "taxPack.build": async (input, context) => {
    const { state, request } = await worksheetRequest(input, context);
    const analysis = analyzeWorksheet(state, request);
    const vendors = analyzeVendors(
      await vendorsRequest(input, context, { state, tags: request.tags }),
    );
    // The pack carries the whole range by month, so a filer of any frequency can add months up.
    const sales = await salesAnalysis({ ...input, period: "month" }, context, state, request.tags);
    const close = yearClose(state, request.from, request.to, request.today);
    const checks = await taxChecks(context, {
      state,
      worksheet: analysis.worksheet,
      today: request.today,
      booksStartOn: request.booksStartOn ?? null,
      vendors: vendors.wire,
      sales: sales.summary,
    });
    const bookName = context.service.setupState()?.name ?? "";
    const entity = readBookSettings(context.service).entity;
    const built = buildPack({
      state,
      request,
      bookName,
      ...(entity ? { entity } : {}),
      analysis,
      extra: [
        ...vendorPackFiles(vendors, {
          book: bookName,
          bookRevision: analysis.worksheet.bookRevision,
          tags: request.tags,
        }),
        // Only when an account is tagged: a business that collects no sales tax gets no empty file.
        ...(sales.summary.accounts.length > 0 ? salesPackFiles(sales, bookName) : []),
      ],
      checks,
      close,
    });
    const { worksheet } = built;
    return {
      format: PACK_FORMAT,
      folder: built.folder,
      taxYear: worksheet.taxYear,
      form: worksheet.form,
      from: worksheet.from,
      to: worksheet.to,
      bookRevision: worksheet.bookRevision,
      ledgerPopulationHash: worksheet.ledgerPopulationHash,
      worksheetPopulationHash: worksheet.populationHash,
      tagMapHash: worksheet.tagMapHash,
      close: closeWire(close, worksheet.bookRevision),
      files: built.files,
      manifestSha256: built.manifestSha256,
      checks,
      warnings: worksheet.warnings,
      disclaimer: TAX_DISCLAIMER_LONG,
    };
  },

  "taxCpaPacket.build": async (input, context) => {
    const { state, request } = await worksheetRequest(input, context);
    const analysis = analyzeWorksheet(state, request);
    const vendors = analyzeVendors(
      await vendorsRequest(input, context, { state, tags: request.tags }),
    );
    const sales = await salesAnalysis({ ...input, period: "month" }, context, state, request.tags);
    const close = yearClose(state, request.from, request.to, request.today);
    const checks = await taxChecks(context, {
      state,
      worksheet: analysis.worksheet,
      today: request.today,
      booksStartOn: request.booksStartOn ?? null,
      vendors: vendors.wire,
      sales: sales.summary,
    });
    const { map: provenance, read: provenanceRead } = await journalProvenance(
      context,
      request.from,
      request.to,
    );
    const added = await packContributions(context, {
      taxYear: request.taxYear,
      from: request.from,
      to: request.to,
      revision: state.bookRevision,
    });
    const bookName = context.service.setupState()?.name ?? "";
    const entity = readBookSettings(context.service).entity;
    const accounting = buildAccountantSupplement(
      state,
      {
        taxYear: request.taxYear,
        from: request.from,
        to: request.to,
        tags: request.tags,
        today: request.today,
        provenance,
        provenanceRead,
        extras: added.extras,
        extraNotes: added.notes,
      },
      bookName,
    );
    const built = buildPack({
      state,
      request,
      bookName,
      ...(entity ? { entity } : {}),
      format: CPA_PACKET_FORMAT,
      folder: `rastrata-cpa-packet-${request.taxYear}`,
      title: "CPA packet",
      analysis,
      extra: [
        ...accounting.files,
        ...vendorPackFiles(vendors, {
          book: bookName,
          bookRevision: analysis.worksheet.bookRevision,
          tags: request.tags,
        }),
        ...(sales.summary.accounts.length > 0 ? salesPackFiles(sales, bookName) : []),
      ],
      extraPopulations: accounting.populations,
      extraReadmes: accounting.extraReadmes,
      extraNotes: accounting.extraNotes,
      checks,
      close,
    });
    for (const file of built.files)
      if (file.content.length > MAX_FILE_CHARACTERS)
        throw new ApplicationError(
          "export_too_large",
          "A file in this packet is too large to return in one piece. Choose a shorter date range.",
          413,
        );
    const { worksheet } = built;
    return {
      format: CPA_PACKET_FORMAT,
      folder: built.folder,
      taxYear: worksheet.taxYear,
      form: worksheet.form,
      from: worksheet.from,
      to: worksheet.to,
      bookRevision: worksheet.bookRevision,
      ledgerPopulationHash: worksheet.ledgerPopulationHash,
      worksheetPopulationHash: worksheet.populationHash,
      tagMapHash: worksheet.tagMapHash,
      close: closeWire(close, worksheet.bookRevision),
      files: built.files,
      manifestSha256: built.manifestSha256,
      checks,
      warnings: worksheet.warnings,
      disclaimer: TAX_DISCLAIMER_LONG,
    };
  },
};
