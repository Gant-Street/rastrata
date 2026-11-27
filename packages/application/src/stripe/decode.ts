import { isoCurrency } from "./amounts.ts";
import { safeText } from "./redact.ts";
import type {
  Account,
  Balance,
  BalanceAmount,
  BalanceTransaction,
  CheckoutSession,
  FeeDetail,
  Invoice,
  InvoicePayment,
  InvoiceTax,
  Page,
  Payout,
  Source,
} from "./types.ts";

/** Decoders for what Stripe sends. They never throw and never trust a shape: a response that is
 * not what the documented object looks like becomes a list of problems, and the caller stops
 * rather than guess about money. Free text from Stripe is not read here at all except where a
 * decoded field needs it, and then only after validation. */

export type Decoded<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problems: readonly string[] };

type Json = Record<string, unknown>;

const record = (value: unknown): Json | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;

const ID = /^[A-Za-z0-9_]{3,200}$/;
const NAME = /^[a-z0-9_.]{1,64}$/;

class Reader {
  readonly problems: string[] = [];
  constructor(
    private readonly path: string,
    readonly o: Json,
  ) {}

  private fail(key: string, what: string): void {
    this.problems.push(`${this.path}.${key} ${what}`);
  }

  integer(key: string, required = true): bigint | null {
    const v = this.o[key];
    if (v === undefined || v === null) {
      if (required) this.fail(key, "is missing");
      return null;
    }
    if (typeof v !== "number" || !Number.isSafeInteger(v)) {
      this.fail(key, "is not a whole number");
      return null;
    }
    return BigInt(v);
  }

  /** A timestamp or count that fits in a JavaScript integer. */
  seconds(key: string, required = true): number | null {
    const v = this.integer(key, required);
    return v === null ? null : Number(v);
  }

  boolean(key: string, required = true): boolean | null {
    const v = this.o[key];
    if (v === undefined || v === null) {
      if (required) this.fail(key, "is missing");
      return null;
    }
    if (typeof v !== "boolean") {
      this.fail(key, "is not true or false");
      return null;
    }
    return v;
  }

  /** A short enumerated word (a status, a type, a reporting category). */
  word(key: string, required = true): string | null {
    const v = this.o[key];
    if (v === undefined || v === null) {
      if (required) this.fail(key, "is missing");
      return null;
    }
    if (typeof v !== "string" || !NAME.test(v)) {
      this.fail(key, "is not a plain identifier");
      return null;
    }
    return v;
  }

  currency(key: string, required = true): string | null {
    const v = this.o[key];
    if (v === undefined || v === null) {
      if (required) this.fail(key, "is missing");
      return null;
    }
    const code = isoCurrency(v);
    if (code === null) this.fail(key, "is not a three-letter currency");
    return code;
  }

  /** A Stripe identifier, or the `id` of an expanded object in that place. */
  id(key: string, prefixes: readonly string[], required = true): string | null {
    const v = this.o[key];
    if (v === undefined || v === null) {
      if (required) this.fail(key, "is missing");
      return null;
    }
    const raw = typeof v === "string" ? v : (record(v)?.id ?? null);
    if (
      typeof raw !== "string" ||
      !ID.test(raw) ||
      (prefixes.length > 0 && !prefixes.some((p) => raw.startsWith(p)))
    ) {
      this.fail(key, "is not a recognised Stripe identifier");
      return null;
    }
    return raw;
  }
}

function listOf(
  json: unknown,
  path: string,
): { readonly data: readonly unknown[]; readonly hasMore: boolean } | readonly string[] {
  const o = record(json);
  if (!o) return [`${path} is not an object`];
  if (o.object !== "list") return [`${path}.object is not "list"`];
  if (!Array.isArray(o.data)) return [`${path}.data is not an array`];
  if (typeof o.has_more !== "boolean") return [`${path}.has_more is not true or false`];
  return { data: o.data as readonly unknown[], hasMore: o.has_more };
}

function decodeList<T>(
  json: unknown,
  path: string,
  one: (value: unknown, itemPath: string) => Decoded<T>,
): Decoded<Page<T>> {
  const list = listOf(json, path);
  if (Array.isArray(list)) return { ok: false, problems: list as readonly string[] };
  const { data, hasMore } = list as { data: readonly unknown[]; hasMore: boolean };
  const items: T[] = [];
  const problems: string[] = [];
  data.forEach((entry, index) => {
    const result = one(entry, `${path}.data[${index}]`);
    if (result.ok) items.push(result.value);
    else problems.push(...result.problems);
  });
  return problems.length > 0 ? { ok: false, problems } : { ok: true, value: { items, hasMore } };
}

function feeDetails(r: Reader, path: string): FeeDetail[] | null {
  const raw = r.o.fee_details;
  if (!Array.isArray(raw)) {
    r.problems.push(`${path}.fee_details is not an array`);
    return null;
  }
  const out: FeeDetail[] = [];
  raw.forEach((entry, index) => {
    const o = record(entry);
    if (!o) {
      r.problems.push(`${path}.fee_details[${index}] is not an object`);
      return;
    }
    const inner = new Reader(`${path}.fee_details[${index}]`, o);
    const amount = inner.integer("amount");
    const currency = inner.currency("currency");
    const type = inner.word("type");
    r.problems.push(...inner.problems);
    if (amount !== null && currency !== null && type !== null) out.push({ amount, currency, type });
  });
  return out;
}

function decodePayoutObject(o: Json, path: string): Decoded<Payout> {
  const r = new Reader(path, o);
  const id = r.id("id", ["po_"]);
  const amount = r.integer("amount");
  const currency = r.currency("currency");
  const created = r.seconds("created");
  const arrival = r.seconds("arrival_date");
  const automatic = r.boolean("automatic");
  const status = r.word("status");
  const method = r.word("method");
  const type = r.word("type");
  const reconciliation = r.word("reconciliation_status");
  const balanceTransaction = r.id("balance_transaction", ["txn_"], false);
  const failure = r.id("failure_balance_transaction", ["txn_"], false);
  if (
    r.problems.length > 0 ||
    id === null ||
    amount === null ||
    currency === null ||
    created === null ||
    arrival === null ||
    automatic === null ||
    status === null ||
    method === null ||
    type === null ||
    reconciliation === null
  )
    return { ok: false, problems: r.problems };
  return {
    ok: true,
    value: {
      object: "payout",
      id,
      amount,
      currency,
      created,
      arrivalDate: arrival,
      automatic,
      status,
      method,
      type,
      reconciliationStatus: reconciliation,
      balanceTransaction,
      failureBalanceTransaction: failure,
      ...(typeof o.livemode === "boolean" ? { livemode: o.livemode } : {}),
    },
  };
}

export function decodePayout(json: unknown, path = "payout"): Decoded<Payout> {
  const o = record(json);
  if (!o) return { ok: false, problems: [`${path} is not an object`] };
  if (o.object !== "payout") return { ok: false, problems: [`${path}.object is not "payout"`] };
  return decodePayoutObject(o, path);
}

export function decodePayoutPage(json: unknown): Decoded<Page<Payout>> {
  return decodeList(json, "payouts", decodePayout);
}

function decodeSource(value: unknown, path: string): Decoded<Source | null> {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value === "string") {
    return ID.test(value)
      ? { ok: true, value: { object: "bare", id: value } }
      : { ok: false, problems: [`${path} is not a recognised Stripe identifier`] };
  }
  const o = record(value);
  if (!o) return { ok: false, problems: [`${path} is neither an identifier nor an object`] };
  const r = new Reader(path, o);
  const kind = typeof o.object === "string" && NAME.test(o.object) ? o.object : "unknown";
  switch (kind) {
    case "charge": {
      const id = r.id("id", []);
      const paymentIntent = r.id("payment_intent", [], false);
      if (r.problems.length > 0 || id === null) return { ok: false, problems: r.problems };
      return { ok: true, value: { object: "charge", id, paymentIntent } };
    }
    case "refund": {
      const id = r.id("id", []);
      const charge = r.id("charge", [], false);
      const paymentIntent = r.id("payment_intent", [], false);
      if (r.problems.length > 0 || id === null) return { ok: false, problems: r.problems };
      return { ok: true, value: { object: "refund", id, charge, paymentIntent } };
    }
    case "dispute": {
      const id = r.id("id", []);
      const charge = r.id("charge", [], false);
      const paymentIntent = r.id("payment_intent", [], false);
      const reason = r.word("reason", false);
      if (r.problems.length > 0 || id === null) return { ok: false, problems: r.problems };
      return { ok: true, value: { object: "dispute", id, charge, paymentIntent, reason } };
    }
    case "payout": {
      return decodePayoutObject(o, path);
    }
    default: {
      const id = r.id("id", []);
      if (r.problems.length > 0 || id === null) return { ok: false, problems: r.problems };
      return { ok: true, value: { object: "other", id, stripeObject: kind } };
    }
  }
}

export function decodeBalanceTransaction(
  json: unknown,
  path = "balance_transaction",
): Decoded<BalanceTransaction> {
  const o = record(json);
  if (!o) return { ok: false, problems: [`${path} is not an object`] };
  if (o.object !== "balance_transaction")
    return { ok: false, problems: [`${path}.object is not "balance_transaction"`] };
  const r = new Reader(path, o);
  const id = r.id("id", ["txn_"]);
  const amount = r.integer("amount");
  const fee = r.integer("fee");
  const net = r.integer("net");
  const currency = r.currency("currency");
  const created = r.seconds("created");
  const availableOn = r.seconds("available_on");
  const status = r.word("status");
  const type = r.word("type");
  const reportingCategory = r.word("reporting_category");
  const balanceType = r.word("balance_type", false);
  const details = feeDetails(r, path);
  const source = decodeSource(o.source, `${path}.source`);
  const problems = [...r.problems];
  if (!source.ok) problems.push(...source.problems);
  if (
    problems.length > 0 ||
    id === null ||
    amount === null ||
    fee === null ||
    net === null ||
    currency === null ||
    created === null ||
    availableOn === null ||
    status === null ||
    type === null ||
    reportingCategory === null ||
    details === null ||
    !source.ok
  )
    return { ok: false, problems };
  return {
    ok: true,
    value: {
      id,
      amount,
      fee,
      net,
      currency,
      created,
      availableOn,
      status,
      type,
      reportingCategory,
      balanceType,
      description:
        typeof o.description === "string" && o.description.length > 0
          ? safeText(o.description, { max: 200 })
          : null,
      hasExchangeRate: o.exchange_rate !== null && o.exchange_rate !== undefined,
      feeDetails: details,
      source: source.value,
    },
  };
}

export function decodeBalanceTransactionPage(json: unknown): Decoded<Page<BalanceTransaction>> {
  return decodeList(json, "balance_transactions", decodeBalanceTransaction);
}

function balanceAmounts(o: Json, key: string, problems: string[]): BalanceAmount[] | null {
  const raw = o[key];
  if (!Array.isArray(raw)) {
    problems.push(`balance.${key} is not an array`);
    return null;
  }
  const out: BalanceAmount[] = [];
  raw.forEach((entry, index) => {
    const e = record(entry);
    if (!e) {
      problems.push(`balance.${key}[${index}] is not an object`);
      return;
    }
    const r = new Reader(`balance.${key}[${index}]`, e);
    const amount = r.integer("amount");
    const currency = r.currency("currency");
    problems.push(...r.problems);
    if (amount !== null && currency !== null) out.push({ amount, currency });
  });
  return out;
}

export function decodeBalance(json: unknown): Decoded<Balance> {
  const o = record(json);
  if (!o) return { ok: false, problems: ["balance is not an object"] };
  if (o.object !== "balance") return { ok: false, problems: ['balance.object is not "balance"'] };
  const problems: string[] = [];
  const available = balanceAmounts(o, "available", problems);
  const pending = balanceAmounts(o, "pending", problems);
  if (problems.length > 0 || !available || !pending) return { ok: false, problems };
  return {
    ok: true,
    value: {
      available,
      pending,
      ...(typeof o.livemode === "boolean" ? { livemode: o.livemode } : {}),
    },
  };
}

export function decodeAccount(json: unknown): Decoded<Account> {
  const o = record(json);
  if (!o) return { ok: false, problems: ["account is not an object"] };
  if (o.object !== "account") return { ok: false, problems: ['account.object is not "account"'] };
  const r = new Reader("account", o);
  const id = r.id("id", ["acct_"]);
  const defaultCurrency =
    typeof o.default_currency === "string" ? isoCurrency(o.default_currency) : null;
  const dashboard = record(record(o.settings)?.dashboard);
  const zone =
    typeof dashboard?.timezone === "string" && /^[A-Za-z0-9_+\-/]{1,64}$/.test(dashboard.timezone)
      ? dashboard.timezone
      : null;
  if (r.problems.length > 0 || id === null) return { ok: false, problems: r.problems };
  return { ok: true, value: { id, defaultCurrency, dashboardTimeZone: zone } };
}

function decodeCheckoutSession(json: unknown, path: string): Decoded<CheckoutSession> {
  const o = record(json);
  if (!o) return { ok: false, problems: [`${path} is not an object`] };
  if (o.object !== "checkout.session")
    return { ok: false, problems: [`${path}.object is not "checkout.session"`] };
  const r = new Reader(path, o);
  const id = r.id("id", []);
  const paymentIntent = r.id("payment_intent", [], false);
  const paymentStatus = r.word("payment_status");
  const status = r.word("status", false);
  const amountTotal = r.integer("amount_total", false);
  const currency = r.currency("currency", false);
  const totals = record(o.total_details);
  let amountTax: bigint | null = null;
  if (totals) {
    const t = new Reader(`${path}.total_details`, totals);
    amountTax = t.integer("amount_tax", false);
    r.problems.push(...t.problems);
  }
  if (r.problems.length > 0 || id === null || paymentStatus === null)
    return { ok: false, problems: r.problems };
  return {
    ok: true,
    value: { id, paymentIntent, paymentStatus, status, amountTotal, currency, amountTax },
  };
}

export function decodeCheckoutSessionPage(json: unknown): Decoded<Page<CheckoutSession>> {
  return decodeList(json, "checkout_sessions", decodeCheckoutSession);
}

function decodeInvoice(value: unknown, path: string): Decoded<Invoice | null> {
  if (typeof value === "string") return { ok: true, value: null };
  const o = record(value);
  if (!o) return { ok: false, problems: [`${path} is not an object`] };
  const r = new Reader(path, o);
  const id = r.id("id", []);
  const total = r.integer("total");
  const amountPaid = r.integer("amount_paid");
  const currency = r.currency("currency");
  const status = r.word("status", false);
  let taxes: InvoiceTax[] | null = null;
  const raw = o.total_taxes;
  if (Array.isArray(raw)) {
    taxes = [];
    raw.forEach((entry, index) => {
      const e = record(entry);
      if (!e) {
        r.problems.push(`${path}.total_taxes[${index}] is not an object`);
        return;
      }
      const t = new Reader(`${path}.total_taxes[${index}]`, e);
      const amount = t.integer("amount");
      const behavior = t.word("tax_behavior");
      r.problems.push(...t.problems);
      if (amount !== null && behavior !== null) taxes?.push({ amount, behavior });
    });
  }
  if (
    r.problems.length > 0 ||
    id === null ||
    total === null ||
    amountPaid === null ||
    currency === null
  )
    return { ok: false, problems: r.problems };
  return { ok: true, value: { id, total, amountPaid, currency, status, taxes } };
}

function decodeInvoicePayment(json: unknown, path: string): Decoded<InvoicePayment> {
  const o = record(json);
  if (!o) return { ok: false, problems: [`${path} is not an object`] };
  if (o.object !== "invoice_payment")
    return { ok: false, problems: [`${path}.object is not "invoice_payment"`] };
  const r = new Reader(path, o);
  const id = r.id("id", []);
  const status = r.word("status");
  const amountRequested = r.integer("amount_requested");
  const amountPaid = r.integer("amount_paid", false);
  const currency = r.currency("currency");
  const payment = record(o.payment);
  let paymentIntent: string | null = null;
  if (payment && payment.type === "payment_intent") {
    const p = new Reader(`${path}.payment`, payment);
    paymentIntent = p.id("payment_intent", ["pi_"]);
    r.problems.push(...p.problems);
  }
  const invoice = decodeInvoice(o.invoice, `${path}.invoice`);
  if (!invoice.ok) r.problems.push(...invoice.problems);
  if (
    r.problems.length > 0 ||
    id === null ||
    status === null ||
    amountRequested === null ||
    currency === null ||
    !invoice.ok
  )
    return { ok: false, problems: r.problems };
  return {
    ok: true,
    value: {
      id,
      status,
      paymentIntent,
      amountPaid,
      amountRequested,
      currency,
      invoice: invoice.value,
    },
  };
}

export function decodeInvoicePaymentPage(json: unknown): Decoded<Page<InvoicePayment>> {
  return decodeList(json, "invoice_payments", decodeInvoicePayment);
}
