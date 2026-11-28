/** The operations behind the 1099 vendor list: reading the totals (which joins the book, the vendors a
 * person recorded and the Inbox's payees), recording a vendor, and marking accounts reportable.
 *
 * Writes are retained: the same operation identity with the same input returns the first answer and
 * never repeats the effect, and a refused request leaves nothing behind. A vendor's history is
 * append-only, with who and when. Rastrata files nothing, fills in no form and never stores a
 * taxpayer identification number. */
import { hashCanonical, type BookState } from "@rastrata/kernel";

import type { AccountTagMap } from "../../account-tags.ts";
import { describePrincipal } from "../../agent/principal.ts";
import { knownTaxLine } from "../../chart/tax-lines.ts";
import type {
  InboxPage,
  TaxNote,
  TaxPaymentRow,
  TaxPayeeRow,
  TaxVendor,
  TaxVendorDetail,
  TaxVendorRow,
  TaxVendors,
} from "../../client-contracts.gen.ts";
import { ApplicationError } from "../../errors.ts";
import { deriveId } from "../../ingest/hash.ts";
import { sanitizeText } from "../../ingest/text.ts";
import { formatMoney } from "../../money.ts";
import { compileColumn, reportContext, resolveRange } from "../../reports/columns.ts";
import { addDays, isDate } from "../../reports/dates.ts";
import type { ApplicationService } from "../../service.ts";
import type { TaxFileHeader } from "../../tax/csv.ts";
import { CSV_TYPE, type TaxFile } from "../../tax/files.ts";
import { PAYEE_KEY_MAX, PAYEE_KEY_MIN, payeeKey } from "../../tax/payees.ts";
import { TAX_DISCLAIMER_LONG } from "../../tax/sources.ts";
import {
  CARD_AND_NETWORK_RULE,
  NOT_FILING_RULE,
  NOT_REPORTED_RULE,
  THRESHOLD_EXCEPTIONS,
  W9_RULE,
  W9_SOURCES,
  reportingThreshold,
} from "../../tax/thresholds.ts";
import {
  CLASSIFICATIONS,
  EXEMPT_REASONS,
  PAID_BY,
  TIN_STATUSES,
  VENDOR_REPORTING,
  W9_STATES,
  compileVendorTotals,
  type PayeeSource,
  type Payment,
  type Vendor,
  type VendorAddress,
  type VendorTotals,
} from "../../tax/vendors.ts";
import { paymentsCsv, vendorsCsv } from "../../tax/vendors-csv.ts";
import { type PayeeState, appendPayee, payeesRuntime, readPayeeState } from "../payees/store.ts";
import type { SliceContext } from "../types.ts";
import { callOperation } from "./operations.ts";
import { type TaxState, type VendorBody, appendEvent, readTaxState, taxRuntime } from "./store.ts";

export const VENDORS_VERSION = "rastrata-1099-vendors-v1";

/** Schedule C lines whose instructions tie them to Form 1099-NEC reporting (lines 10 and 11 say "You
 * must file Form 1099-NEC to report certain commissions and fees [contract labor payments] of $600 or
 * more"), plus legal and professional services and rent. A hint on the account picker, never a
 * decision. */
const SUGGESTED_LINES: ReadonlySet<string> = new Set([
  "scheduleC.line10",
  "scheduleC.line11",
  "scheduleC.line17",
  "scheduleC.line20a",
  "scheduleC.line20b",
]);

/** The Inbox's lines for the journals in the range: the counterparty and description a bank wrote. A
 * line is matched to its journal by the journal id the Inbox recorded when it posted. The window is a
 * little wider than the range because a journal's date can be edited after a line is imported. */
export async function inboxPayees(
  context: SliceContext,
  from: string,
  to: string,
): Promise<{ readonly payees: Map<string, PayeeSource>; readonly read: boolean }> {
  const payees = new Map<string, PayeeSource>();
  try {
    for (let page = 1; ; page++) {
      const result = await callOperation<InboxPage>(context, "inbox.list", {
        filter: {
          status: ["posted"],
          kind: "bankLine",
          from: addDays(from, -31),
          to: addDays(to, 31),
        },
        sort: "date_asc",
        page,
        pageSize: 200,
      });
      for (const item of result.items)
        if (item.journalId)
          payees.set(item.journalId, {
            counterparty: item.line.counterparty ?? "",
            description: item.line.description,
          });
      if (result.items.length === 0 || page * result.pageSize >= result.count) break;
    }
    return { payees, read: true };
  } catch (error) {
    if (error instanceof ApplicationError) return { payees: new Map(), read: false };
    throw error;
  }
}

const vendorWire = (vendor: Vendor): TaxVendor => ({
  id: vendor.id,
  version: vendor.version,
  name: vendor.name,
  payeeKeys: [...vendor.payeeKeys],
  reporting: vendor.reporting,
  reason: vendor.reason,
  w9: vendor.w9,
  w9On: vendor.w9On,
  classification: vendor.classification,
  paidBy: vendor.paidBy,
  notes: vendor.notes,
  ...(vendor.legalName ? { legalName: vendor.legalName } : {}),
  ...(vendor.address ? { address: { ...vendor.address } } : {}),
  ...(vendor.email ? { email: vendor.email } : {}),
  ...(vendor.tinStatus ? { tinStatus: vendor.tinStatus } : {}),
  recordedAt: vendor.recordedAt,
  principal: vendor.principal,
});

export interface VendorsRequest {
  readonly taxYear: number;
  readonly from: string;
  readonly to: string;
  readonly state: BookState;
  readonly tags: AccountTagMap;
  readonly product: TaxState;
  readonly payees: ReadonlyMap<string, PayeeSource>;
  readonly payeesRead: boolean;
  readonly today: string;
}

export interface VendorsAnalysis {
  readonly totals: VendorTotals;
  readonly wire: TaxVendors;
  readonly thresholdCents: bigint;
}

export function analyzeVendors(request: VendorsRequest): VendorsAnalysis {
  const threshold = reportingThreshold(request.taxYear);
  if (!threshold)
    throw new ApplicationError(
      "tax_year_unsupported",
      "The reporting threshold for that year has not been verified. The IRS adjusts it for inflation from 2027.",
      400,
    );
  const totals = compileVendorTotals({
    state: request.state,
    tags: request.tags,
    from: request.from,
    to: request.to,
    reportable: request.product.reportable,
    vendors: request.product.vendors,
    payees: request.payees,
    threshold: threshold.cents,
  });
  const context = reportContext(request.state, request.to);
  const range = resolveRange(context, request.to, request.from);
  const column = compileColumn(context, range.from, request.to);
  const accounts = context.accounts
    .filter((account) => account.role === "expense")
    .map((account) => {
      const line = request.tags.tagsFor(account.id, request.to).taxLine;
      return {
        accountId: account.id,
        code: account.code,
        name: account.name,
        marked: request.product.reportable.has(account.id),
        suggested: line !== undefined && SUGGESTED_LINES.has(line),
        ...(line !== undefined && knownTaxLine(line) ? { taxLine: line } : {}),
      };
    });
  const rows: TaxVendorRow[] = totals.vendors.map((entry) => ({
    vendor: vendorWire(entry.vendor),
    payments: entry.payments,
    counted: formatMoney(entry.counted),
    card: formatMoney(entry.card),
    other: formatMoney(entry.other),
    meetsThreshold: entry.meetsThreshold,
    attention: [...entry.attention],
  }));
  const payees: TaxPayeeRow[] = totals.payees.slice(0, 500).map((entry) => ({
    payee: entry.payee,
    payments: entry.payments,
    counted: formatMoney(entry.counted),
    card: formatMoney(entry.card),
    other: formatMoney(entry.other),
    ambiguous: entry.ambiguous,
    firstOn: entry.firstOn,
    lastOn: entry.lastOn,
  }));
  const warnings: { code: string; message: string }[] = [];
  if (totals.markedAccounts.length === 0)
    warnings.push({
      code: "no_accounts_marked",
      message:
        "No account is marked as holding payments that may need a 1099, so nothing is counted. Mark the accounts that hold payments to contractors, lawyers, landlords and similar payees.",
    });
  if (!request.payeesRead)
    warnings.push({
      code: "inbox_unreadable",
      message:
        "The Inbox could not be read, so payments are matched to vendors on the text of their entries only.",
    });
  if (totals.noCashTags && totals.markedAccounts.length > 0)
    warnings.push({
      code: "no_cash_tags",
      message:
        "No asset account is tagged as cash, so every asset account is read as a bank account. Tag your bank accounts in your chart of accounts so card and other payments are told apart.",
    });
  if (context.basis === "accrual")
    warnings.push({
      code: "accrual_basis",
      message:
        "This book is kept on the accrual basis, so a payment is read from the date an expense was booked, which may not be the date it was paid. Compare the totals with your payment records.",
    });
  if (request.to > request.today)
    warnings.push({
      code: "year_not_ended",
      message: `The range ends on ${request.to}, after today (${request.today}): these are the payments so far.`,
    });
  const cited = (...sources: readonly (typeof threshold.sources)[number][]) =>
    sources.map((source) => ({ ...source }));
  // The instructions for Forms 1099-MISC and 1099-NEC of the year, which state the card and network
  // rule and the exceptions.
  const instructions = threshold.sources.find((source) => source.title.includes("Instructions"));
  const notes: TaxNote[] = [
    {
      key: "threshold",
      text: `${threshold.note} ${THRESHOLD_EXCEPTIONS}`,
      sources: cited(...threshold.sources),
    },
    {
      key: "card_and_network",
      text: CARD_AND_NETWORK_RULE,
      sources: instructions ? cited(instructions) : [],
    },
    {
      key: "not_reported",
      text: NOT_REPORTED_RULE,
      sources: instructions ? cited(instructions) : [],
    },
    { key: "w9", text: W9_RULE, sources: cited(...W9_SOURCES) },
    { key: "not_filing", text: NOT_FILING_RULE },
  ];
  const populationHash = hashCanonical({
    type: "TaxVendorPopulation",
    version: VENDORS_VERSION,
    ledgerPopulationHash: column.populationHash,
    tagMapHash: request.tags.hash,
    vendorsHash: request.product.hash,
    payeesHash: totals.payeesHash,
    taxYear: BigInt(request.taxYear),
    from: request.from,
    to: request.to,
    threshold: threshold.cents,
  }).digest;
  const wire: TaxVendors = {
    taxYear: request.taxYear,
    from: request.from,
    to: request.to,
    currency: request.state.identity.functionalCommodityId,
    basis: context.basis,
    bookRevision: request.state.bookRevision.toString(),
    ledgerPopulationHash: column.populationHash,
    vendorsRevision: String(request.product.revision),
    vendorsHash: request.product.hash,
    populationHash,
    threshold: {
      taxYear: request.taxYear,
      amount: formatMoney(threshold.cents),
      note: `${threshold.note} ${THRESHOLD_EXCEPTIONS}`,
      sources: cited(...threshold.sources),
    },
    accounts,
    vendors: rows,
    payees,
    totals: {
      payments: totals.totals.payments,
      counted: formatMoney(totals.totals.counted),
      card: formatMoney(totals.totals.card),
      other: formatMoney(totals.totals.other),
    },
    overThreshold: rows.filter((row) => row.meetsThreshold && row.vendor.reporting !== "no").length,
    needW9: rows.filter((row) => row.attention.includes("w9_missing")).length,
    undecided: rows.filter((row) => row.attention.includes("undecided")).length,
    notes,
    warnings,
    disclaimer: TAX_DISCLAIMER_LONG,
  };
  return { totals, wire, thresholdCents: threshold.cents };
}

const PAID_FROM_REASON: Readonly<Record<Payment["reason"], string>> = {
  counted: "Counts toward the threshold",
  card: "Paid from a card or other liability account: reported by the card processor",
  vendor_card_or_network: "The vendor is recorded as paid by card or payment app",
  owner: "Paid with the owner's own money",
  other_asset: "Paid from an account that is not a bank account",
  reclass: "A move between income or expense accounts, not a payment",
  mixed: "Paid from both a bank and a card or other account",
};

export function vendorDetail(request: VendorsRequest, vendorId: string): TaxVendorDetail {
  const { totals, wire } = analyzeVendors(request);
  const row = wire.vendors.find((entry) => entry.vendor.id === vendorId);
  if (!row)
    throw new ApplicationError(
      "vendor_not_found",
      "No vendor has that id. List them with taxVendors.list.",
      404,
    );
  const own = totals.payments.filter((payment) => payment.vendorId === vendorId);
  const payments: TaxPaymentRow[] = own.slice(0, 500).map((payment) => ({
    date: payment.date,
    journalId: payment.journalId,
    payee: payment.payee,
    accounts: payment.accounts
      .map((account) => `${account.code} ${account.name}`)
      .join("; ")
      .slice(0, 400),
    amount: formatMoney(payment.cents),
    paidFrom: payment.paidFrom,
    counted: payment.counts,
    reason: PAID_FROM_REASON[payment.reason],
  }));
  const history = (request.product.history.get(vendorId) ?? []).map(
    (entry): TaxVendor => ({
      id: vendorId,
      version: entry.version,
      name: entry.name,
      payeeKeys: [...entry.payeeKeys],
      reporting: entry.reporting,
      reason: entry.reason,
      w9: entry.w9,
      w9On: entry.w9On,
      classification: entry.classification,
      paidBy: entry.paidBy,
      notes: entry.notes,
      recordedAt: entry.recordedAt,
      principal: entry.principal,
    }),
  );
  return {
    vendor: row,
    history,
    payments,
    truncated: own.length > payments.length,
    taxYear: request.taxYear,
    from: request.from,
    to: request.to,
  };
}

/** The two files the year-end pack carries: the vendor totals and every payment behind them. */
export function vendorPackFiles(
  analysis: VendorsAnalysis,
  common: { readonly book: string; readonly bookRevision: string; readonly tags: AccountTagMap },
): TaxFile[] {
  const { wire, totals, thresholdCents } = analysis;
  const header: TaxFileHeader = {
    title: `1099 vendor totals ${wire.taxYear}`,
    book: common.book,
    currency: wire.currency,
    basis: wire.basis,
    periodStart: wire.from,
    periodEnd: wire.to,
    bookRevision: common.bookRevision,
    populationHash: wire.populationHash,
    compilerVersion: VENDORS_VERSION,
    extra: [
      ["Ledger population hash", wire.ledgerPopulationHash],
      ["Vendors revision", wire.vendorsRevision],
      ["Vendors hash", wire.vendorsHash],
      ["Threshold", `${wire.threshold.amount} (${wire.threshold.note})`],
      [
        "Accounts counted",
        totals.markedAccounts.map((account) => `${account.code} ${account.name}`).join("; "),
      ],
      ["Notice", `${NOT_FILING_RULE} ${TAX_DISCLAIMER_LONG}`],
    ],
  };
  const names = new Map(totals.vendors.map((entry) => [entry.vendor.id, entry.vendor.name]));
  return [
    {
      path: "tax/1099-vendors.csv",
      mediaType: CSV_TYPE,
      description:
        "1099 vendor totals: each vendor's payments for the year split into what counts toward the IRS threshold and what is left out, with the W-9 and what needs attention. A list for you or your accountant, not a form.",
      content: vendorsCsv(header, totals, thresholdCents),
      population: wire.populationHash,
    },
    {
      path: "tax/1099-payments.csv",
      mediaType: CSV_TYPE,
      description:
        "Every payment behind the 1099 vendor totals, with its journal, where the money came from and whether it counts.",
      content: paymentsCsv(header, totals, (id) => names.get(id) ?? ""),
      population: wire.populationHash,
    },
  ];
}

// ------------------------------------------------------------------------------------------------
// Writes
// ------------------------------------------------------------------------------------------------

function refuse(code: string, message: string, status = 400, path?: string): never {
  throw new ApplicationError(code, message, status, path ? [{ path, message }] : []);
}

function cleanName(value: unknown): string {
  const name = typeof value === "string" ? sanitizeText(value, 120) : "";
  if (name.length < 1) refuse("invalid_input", "A vendor needs a name.", 400, "input.name");
  return name;
}

function cleanKeys(
  value: unknown,
  owner: string | null,
  state: TaxState,
  people: PayeeState,
): string[] {
  if (!Array.isArray(value)) return [];
  const keys: string[] = [];
  for (const raw of value) {
    const key = payeeKey(typeof raw === "string" ? raw : "").slice(0, PAYEE_KEY_MAX);
    if (key.length < PAYEE_KEY_MIN)
      refuse(
        "invalid_input",
        `A payee text needs at least ${PAYEE_KEY_MIN} letters or digits: "${sanitizeText(String(raw), 40)}" is too short and would match too many payments.`,
        400,
        "input.payeeKeys",
      );
    if (!keys.includes(key)) keys.push(key);
  }
  for (const key of keys) {
    const holder = state.vendors.find(
      (vendor) => vendor.id !== owner && vendor.payeeKeys.includes(key),
    );
    if (holder)
      refuse(
        "payee_key_in_use",
        `"${key}" already belongs to ${holder.name}. A payee text names one vendor.`,
        409,
        "input.payeeKeys",
      );
    // A vendor is a payee, and a payee's words name one payee: the other payees count too.
    const payee = people.payees.find((entry) => entry.id !== owner && entry.words.includes(key));
    if (payee)
      refuse(
        "payee_key_in_use",
        `"${key}" already belongs to ${payee.name}. A set of words names one payee.`,
        409,
        "input.payeeKeys",
      );
  }
  return keys;
}

const sameWords = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((word, index) => word === b[index]);

function oneOf<T extends string>(list: readonly T[], value: unknown, field: string): T {
  if (typeof value === "string" && (list as readonly string[]).includes(value)) return value as T;
  return refuse(
    "invalid_input",
    `${field} must be one of ${list.join(", ")}.`,
    400,
    `input.${field}`,
  );
}

const VENDOR_EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

function cleanVendorAddress(value: unknown): VendorAddress | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value))
    return refuse("invalid_input", "address must be an object or null.", 400, "input.address");
  const raw = value as Record<string, unknown>;
  const out: Record<string, string> = {};
  const specs = [
    ["line1", 200],
    ["line2", 200],
    ["city", 120],
    ["state", 40],
    ["postalCode", 20],
  ] as const;
  for (const [key, max] of specs) {
    if (raw[key] === undefined || raw[key] === null) continue;
    const text = sanitizeText(String(raw[key]), max);
    if (text !== "") out[key] = text;
  }
  return Object.keys(out).length > 0 ? (out as VendorAddress) : null;
}

const bodyOfVendor = (vendor: Vendor): VendorBody => ({
  name: vendor.name,
  payeeKeys: vendor.payeeKeys,
  reporting: vendor.reporting,
  reason: vendor.reason,
  w9: vendor.w9,
  w9On: vendor.w9On,
  classification: vendor.classification,
  paidBy: vendor.paidBy,
  notes: vendor.notes,
  ...(vendor.legalName ? { legalName: vendor.legalName } : {}),
  ...(vendor.address ? { address: vendor.address } : {}),
  ...(vendor.email ? { email: vendor.email } : {}),
  ...(vendor.tinStatus ? { tinStatus: vendor.tinStatus } : {}),
});

export function saveVendor(
  context: SliceContext,
  input: Record<string, unknown>,
  operationId: string,
) {
  const service: ApplicationService = context.service;
  const runtime = taxRuntime(service);
  // The list of payees is where a vendor's name and words are kept as well: opening it also gives a
  // vendor recorded before the list existed its payee.
  const payees = payeesRuntime(service);
  const principal = describePrincipal(context.access.principal);
  return service.retainRequest(operationId, "taxVendors.save", input, () => {
    const state = readTaxState(runtime.store);
    const people = readPayeeState(payees.store);
    const id = typeof input.vendorId === "string" ? input.vendorId : null;
    const current = id === null ? undefined : state.vendors.find((vendor) => vendor.id === id);
    // A payee that is not a vendor yet can be made one: a vendor is a payee with 1099 details, and
    // has the payee's id.
    const payee = id === null ? undefined : people.payees.find((entry) => entry.id === id);
    if (id !== null && !current && !payee)
      return refuse(
        "vendor_not_found",
        "No vendor has that id. List them with taxVendors.list.",
        404,
      );
    if (current && input.expectedVersion !== current.version)
      return refuse(
        "vendor_version_conflict",
        `${current.name} changed since you read it (it is at version ${current.version}). Read it again and apply your change to that.`,
        409,
        "input.expectedVersion",
      );
    // Before it is a vendor, the version being changed is the payee's.
    if (!current && payee && input.expectedVersion !== payee.version)
      return refuse(
        "vendor_version_conflict",
        `${payee.name} changed since you read it (it is at version ${payee.version}). Read it again and apply your change to that.`,
        409,
        "input.expectedVersion",
      );
    if (!current && !payee && input.name === undefined)
      return refuse("invalid_input", "A new vendor needs a name.", 400, "input.name");
    const base: VendorBody = current
      ? bodyOfVendor(current)
      : {
          name: payee?.name ?? "",
          payeeKeys: payee?.words ?? [],
          reporting: "undecided",
          reason: null,
          w9: "not_requested",
          w9On: null,
          classification: null,
          paidBy: "unknown",
          notes: "",
        };
    const name = input.name === undefined ? base.name : cleanName(input.name);
    if (
      state.vendors.some(
        (vendor) => vendor.id !== id && vendor.name.toLowerCase() === name.toLowerCase(),
      )
    )
      refuse("vendor_name_in_use", `A vendor named ${name} already exists.`, 409, "input.name");
    // A vendor is a payee, and a payee has one name in the book.
    if (
      people.payees.some(
        (entry) => entry.id !== id && entry.name.toLowerCase() === name.toLowerCase(),
      )
    )
      refuse("payee_name_in_use", `A payee named ${name} already exists.`, 409, "input.name");
    const reporting =
      input.reporting === undefined
        ? base.reporting
        : oneOf(VENDOR_REPORTING, input.reporting, "reporting");
    const reason =
      input.reason === undefined
        ? base.reason
        : input.reason === null
          ? null
          : oneOf(EXEMPT_REASONS, input.reason, "reason");
    if (reporting === "no" && reason === null)
      refuse(
        "reason_required",
        "Say why this vendor does not need a 1099: it helps whoever looks next.",
        400,
        "input.reason",
      );
    const w9 = input.w9 === undefined ? base.w9 : oneOf(W9_STATES, input.w9, "w9");
    const w9On = input.w9On === undefined ? base.w9On : (input.w9On as string | null);
    if (w9On !== null && !isDate(w9On))
      refuse("invalid_input", "w9On must be a real date (YYYY-MM-DD).", 400, "input.w9On");
    const legalName =
      input.legalName === undefined
        ? (base.legalName ?? null)
        : input.legalName === null
          ? null
          : sanitizeText(String(input.legalName), 200) || null;
    const address =
      input.address === undefined ? (base.address ?? null) : cleanVendorAddress(input.address);
    let email = base.email ?? null;
    if (input.email !== undefined) {
      if (input.email === null) email = null;
      else {
        const cleaned = String(input.email).trim().toLowerCase();
        if (cleaned === "") email = null;
        else if (!VENDOR_EMAIL_RE.test(cleaned) || cleaned.length > 254)
          refuse("invalid_input", "email must be a valid email address.", 400, "input.email");
        else email = cleaned;
      }
    }
    const tinStatus =
      input.tinStatus === undefined
        ? base.tinStatus
        : oneOf(TIN_STATUSES, input.tinStatus, "tinStatus");
    const body: VendorBody = {
      name,
      payeeKeys:
        input.payeeKeys === undefined
          ? base.payeeKeys
          : cleanKeys(input.payeeKeys, id, state, people),
      reporting,
      reason,
      w9,
      w9On,
      classification:
        input.classification === undefined
          ? base.classification
          : input.classification === null
            ? null
            : oneOf(CLASSIFICATIONS, input.classification, "classification"),
      paidBy: input.paidBy === undefined ? base.paidBy : oneOf(PAID_BY, input.paidBy, "paidBy"),
      notes: input.notes === undefined ? base.notes : sanitizeText(String(input.notes), 500),
      ...(legalName !== null ? { legalName } : {}),
      ...(address !== null ? { address } : {}),
      ...(email !== null ? { email } : {}),
      ...(tinStatus !== undefined ? { tinStatus } : {}),
    };
    if (current && JSON.stringify(body) === JSON.stringify(bodyOfVendor(current)))
      return {
        vendor: vendorWire(current),
        changed: false,
        vendorsRevision: String(state.revision),
        vendorsHash: state.hash,
      };
    const subject = current ? current.id : payee ? payee.id : deriveId("ven_", [operationId]);
    appendEvent(runtime, { kind: "vendor", subject, body, principal, operationId });
    // The name and words are the payee's too: written to the list in the same transaction, so the
    // list of payees and the 1099 list cannot say different things about who a vendor is.
    if (!payee || payee.name !== body.name || !sameWords(payee.words, body.payeeKeys))
      appendPayee(payees, {
        payee: subject,
        body: {
          name: body.name,
          words: body.payeeKeys,
          defaultAccountId: payee?.defaultAccountId ?? null,
          note: payee?.note ?? "",
          retired: payee?.retired ?? false,
        },
        principal,
        operationId,
        via: "taxVendors.save",
      });
    const after = readTaxState(runtime.store);
    const saved = after.vendors.find((vendor) => vendor.id === subject) as Vendor;
    return {
      vendor: vendorWire(saved),
      changed: true,
      vendorsRevision: String(after.revision),
      vendorsHash: after.hash,
    };
  });
}

export async function setReportableAccounts(
  context: SliceContext,
  input: Record<string, unknown>,
  operationId: string,
) {
  const service = context.service;
  const runtime = taxRuntime(service);
  const principal = describePrincipal(context.access.principal);
  const { aggregate } = await service.readAggregate();
  const chart = new Map(
    aggregate.state.admissionSnapshot.accounts.map((account) => [account.id as string, account]),
  );
  const add = Array.isArray(input.add) ? (input.add as string[]) : [];
  const remove = Array.isArray(input.remove) ? (input.remove as string[]) : [];
  for (const id of [...add, ...remove])
    if (!chart.has(id))
      refuse(
        "account_not_found",
        `No account has the id ${id}. Use accounts.list to find an account's id.`,
        404,
        "input.add",
      );
  for (const id of add) {
    const account = chart.get(id);
    if (account?.role !== "expense")
      refuse(
        "account_not_reportable_kind",
        `${account?.code} ${account?.name} is not an expense account. Mark the expense accounts that hold payments to people or businesses.`,
        400,
        "input.add",
      );
  }
  if (add.some((id) => remove.includes(id)))
    refuse(
      "invalid_input",
      "An account cannot be added and removed in one request.",
      400,
      "input.add",
    );
  return service.retainRequest(operationId, "taxVendors.setAccounts", input, () => {
    const before = readTaxState(runtime.store);
    let changed = 0;
    for (const [list, on] of [
      [add, true],
      [remove, false],
    ] as const)
      for (const id of new Set(list)) {
        if (before.reportable.has(id) === on) continue;
        appendEvent(runtime, {
          kind: "account",
          subject: id,
          body: { reportable: on },
          principal,
          operationId,
        });
        changed++;
      }
    const after = readTaxState(runtime.store);
    return {
      reportable: [...after.reportable].sort(),
      changed,
      vendorsRevision: String(after.revision),
      vendorsHash: after.hash,
    };
  });
}
