/** The price book: what each thing the hosted product uses costs, as `ops/pricebook.json` records
 * it. This module is pure. The file is read by the caller (the cost report, a test) and handed to
 * `parsePricebook`, which refuses a book that is malformed, that is missing a price the cost
 * function needs, or that has an entry without the page it was read from and the day it was read. */

/** The shape of one price. `price` is dollars per `unit` beyond `included`. */
export interface PriceEntry {
  readonly id: string;
  readonly label: string;
  /** What `price` and `included` count: "GB-month", "million operations", "OCPU-hour". */
  readonly unit: string;
  readonly price: number;
  /** What the plan includes free each month, in `unit`. */
  readonly included?: number;
  /** The part of `included` the infrastructure that exists today already uses, so is not ours. */
  readonly alreadyUsed?: number;
  /** Numbers that go with the price, such as the memory a Durable Object is charged for. */
  readonly params?: Readonly<Record<string, number>>;
  /** The page the price was read from: an https URL, or a repository document for a decision. */
  readonly source: string;
  /** The day it was read, YYYY-MM-DD. */
  readonly read: string;
  readonly quote?: string;
  readonly note?: string;
}

export interface Pricebook {
  readonly schema: "rastrata.pricebook/1";
  /** YYYY-MM-DD.n, changed whenever any entry changes. */
  readonly version: string;
  readonly currency: "USD";
  /** The length of the month every "per month" quantity is for. */
  readonly hoursPerMonth: number;
  readonly description?: string;
  readonly entries: readonly PriceEntry[];
}

/** The entries the cost function prices with. A book without one of them is refused, so a typo in a
 * price book cannot silently price something at nothing. */
export const REQUIRED_PRICES = [
  "r2.storage",
  "r2.class_a",
  "r2.class_b",
  "do.requests",
  "do.duration",
  "do.rows_written",
  "do.rows_read",
  "do.stored",
  "workers.requests",
  "workers.cpu",
  "workers.plan",
  "queues.operations",
  "oci.a1.ocpu_hour",
  "oci.a1.memory_gb_hour",
  "oci.block_volume",
  "grafana.free",
  "grafana.pro.platform",
  "grafana.pro.series",
  "grafana.pro.traces_gb",
] as const;

export class PricebookError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`the price book is not valid:\n- ${problems.join("\n- ")}`);
    this.name = "PricebookError";
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const VERSION = /^\d{4}-\d{2}-\d{2}\.\d+$/;
const SOURCE = /^(https:\/\/[^\s]+|docs\/[^\s]+|~\/oke\/docs\/[^\s]+)$/;
const ENTRY_KEYS = new Set([
  "id",
  "label",
  "unit",
  "price",
  "included",
  "alreadyUsed",
  "params",
  "source",
  "read",
  "quote",
  "note",
]);
const BOOK_KEYS = new Set([
  "schema",
  "version",
  "currency",
  "hoursPerMonth",
  "description",
  "entries",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isDate = (value: unknown): value is string =>
  typeof value === "string" && DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const isAmount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Check a parsed `ops/pricebook.json` and return it typed, or throw a PricebookError that lists
 * every problem at once. */
export function parsePricebook(value: unknown): Pricebook {
  const problems: string[] = [];
  if (!isRecord(value)) throw new PricebookError(["the price book is not an object"]);
  for (const key of Object.keys(value))
    if (!BOOK_KEYS.has(key)) problems.push(`unknown key ${key}`);
  if (value.schema !== "rastrata.pricebook/1")
    problems.push('schema must be "rastrata.pricebook/1"');
  if (typeof value.version !== "string" || !VERSION.test(value.version))
    problems.push("version must look like 2026-10-07.1");
  if (value.currency !== "USD") problems.push('currency must be "USD"');
  if (
    typeof value.hoursPerMonth !== "number" ||
    !(value.hoursPerMonth > 0 && value.hoursPerMonth <= 744)
  )
    problems.push("hoursPerMonth must be a number up to 744");
  if (!Array.isArray(value.entries)) problems.push("entries must be a list");
  const seen = new Set<string>();
  for (const [index, raw] of (Array.isArray(value.entries) ? value.entries : []).entries()) {
    const at = isRecord(raw) && typeof raw.id === "string" ? raw.id : `entries[${index}]`;
    if (!isRecord(raw)) {
      problems.push(`${at} is not an object`);
      continue;
    }
    for (const key of Object.keys(raw))
      if (!ENTRY_KEYS.has(key)) problems.push(`${at}: unknown key ${key}`);
    if (typeof raw.id !== "string" || !/^[a-z][a-z0-9_.]*$/.test(raw.id))
      problems.push(`${at}: id must be lower-case words joined by dots`);
    else if (seen.has(raw.id)) problems.push(`${at}: duplicate id`);
    else seen.add(raw.id);
    for (const key of ["label", "unit"] as const)
      if (typeof raw[key] !== "string" || raw[key] === "")
        problems.push(`${at}: ${key} is missing`);
    if (!isAmount(raw.price)) problems.push(`${at}: price must be a number, zero or more`);
    for (const key of ["included", "alreadyUsed"] as const)
      if (raw[key] !== undefined && !isAmount(raw[key]))
        problems.push(`${at}: ${key} must be a number, zero or more`);
    if (
      typeof raw.alreadyUsed === "number" &&
      (typeof raw.included !== "number" || raw.alreadyUsed > raw.included)
    )
      problems.push(`${at}: alreadyUsed cannot exceed included`);
    if (raw.params !== undefined) {
      if (!isRecord(raw.params)) problems.push(`${at}: params must be an object`);
      else
        for (const [name, amount] of Object.entries(raw.params))
          if (!isAmount(amount)) problems.push(`${at}: params.${name} must be a number`);
    }
    if (typeof raw.source !== "string" || !SOURCE.test(raw.source))
      problems.push(`${at}: source must be an https URL or a repository document`);
    if (!isDate(raw.read)) problems.push(`${at}: read must be the day it was read, YYYY-MM-DD`);
    for (const key of ["quote", "note"] as const)
      if (raw[key] !== undefined && typeof raw[key] !== "string")
        problems.push(`${at}: ${key} must be text`);
  }
  for (const id of REQUIRED_PRICES) if (!seen.has(id)) problems.push(`the entry ${id} is missing`);
  if (problems.length > 0) throw new PricebookError(problems);
  return value as unknown as Pricebook;
}

/** The entry with this id. It cannot be missing for a required id; any other id throws. */
export function priceOf(book: Pricebook, id: string): PriceEntry {
  const entry = book.entries.find((candidate) => candidate.id === id);
  if (!entry) throw new PricebookError([`the entry ${id} is missing`]);
  return entry;
}

/** A parameter of an entry, such as the memory a Durable Object is charged for. */
export function paramOf(book: Pricebook, id: string, name: string): number {
  const amount = priceOf(book, id).params?.[name];
  if (amount === undefined) throw new PricebookError([`the entry ${id} has no parameter ${name}`]);
  return amount;
}

/** The oldest day any price in the book was read: how stale the book is at worst. */
export function oldestRead(book: Pricebook): string {
  return book.entries.map((entry) => entry.read).reduce((a, b) => (a < b ? a : b));
}
