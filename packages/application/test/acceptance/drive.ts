/** Mechanics the acceptance test shares: reading the whole Inbox, finding the item each statement
 * row became, and driving the bounded `inbox.post` to its end. Nothing here asserts. */
import type { Json, World } from "./world.ts";
import { type Row, cents, dec } from "./month.ts";

export const neg = (amount: string): string => dec(-cents(amount));

/** Every Inbox item, paged. */
export async function allItems(w: World, filter: Json = {}): Promise<Json[]> {
  const items: Json[] = [];
  for (let page = 1; page < 50; page++) {
    const data = await w.ok("inbox.list", { filter, page, pageSize: 200, sort: "date_asc" });
    items.push(...data.items);
    if (items.length >= data.count || data.items.length === 0) break;
  }
  return items;
}

/** The identity a line is found by: its account, day and amount. Two lines may share it (a pair of
 * identical purchases), so the matching below pairs them off in order. */
const keyOf = (account: string, date: string, amount: string): string =>
  `${account}|${date}|${amount}`;

/** Pair each statement row with the Inbox item it became, in file order. Rows with the same key are
 * interchangeable, so the nth such row takes the nth such item. A row with no item, or an item with
 * no row, is a bug in the import and the caller asserts there are none. */
export function pairRows(
  items: readonly Json[],
  account: string,
  rows: readonly Row[],
): { readonly paired: Map<Row, Json>; readonly unmatchedRows: Row[]; readonly spare: Json[] } {
  const pool = new Map<string, Json[]>();
  for (const item of items) {
    if (item.ledgerAccountId !== account || item.line.provider !== "csv") continue;
    const key = keyOf(account, item.line.date, item.line.amount);
    pool.set(key, [...(pool.get(key) ?? []), item]);
  }
  for (const list of pool.values()) list.sort((a, b) => a.line.rawIndex - b.line.rawIndex);
  const paired = new Map<Row, Json>();
  const unmatchedRows: Row[] = [];
  for (const row of rows) {
    const list = pool.get(keyOf(account, row.date, row.amount));
    const item = list?.shift();
    if (item) paired.set(row, item);
    else unmatchedRows.push(row);
  }
  return { paired, unmatchedRows, spare: [...pool.values()].flat() };
}

/** `inbox.post` is bounded per call (a count and a time budget) and says what remains: ask again. */
export async function postAll(
  w: World,
  filter: Json,
): Promise<{
  applied: number;
  skipped: number;
  failed: number;
  calls: number;
  problems: string[];
}> {
  const total = { applied: 0, skipped: 0, failed: 0, calls: 0, problems: [] as string[] };
  for (let call = 0; call < 200; call++) {
    const report = await w.ok("inbox.post", { filter });
    total.applied += report.applied;
    total.skipped += report.skipped;
    total.failed += report.failed;
    total.calls += 1;
    for (const result of report.results as Json[])
      if (result.outcome !== "applied")
        total.problems.push(
          `${result.itemId} ${result.outcome} ${result.code ?? ""} ${result.message ?? ""}`.slice(
            0,
            200,
          ),
        );
    if (report.remaining === 0 || report.applied + report.failed === 0) break;
  }
  return total;
}

/** What a person does on the Journal screen: an entry written by hand, prepared and posted. Returns
 * the entry's id. */
export async function enterByHand(
  w: World,
  entry: {
    readonly date: string;
    readonly reference: string;
    readonly narration: string;
    readonly lines: readonly { accountId: string; debit: string; credit: string }[];
  },
): Promise<string> {
  const draft = await w.ok("drafts.create", { data: entry });
  const plan = await w.ok("journal.prepare", { draftId: draft.id, expectedVersion: draft.version });
  if (!plan.valid) throw new Error(`the entry did not prepare: ${JSON.stringify(plan.problems)}`);
  const done = await w.ok("operations.commit", { planId: plan.planId, planHash: plan.planHash });
  if (done.disposition !== "committed")
    throw new Error(`the entry did not post: ${done.disposition}`);
  return plan.effects.journals[0].id as string;
}

/** A journal's lines as a debit-positive map of account id to cents. */
export function legsOf(journal: Json): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const line of journal.lines as Json[]) {
    const amount = cents(line.debit) - cents(line.credit);
    out.set(line.accountId, (out.get(line.accountId) ?? 0n) + amount);
  }
  return out;
}

/** Page through the register: every journal, newest first as the service lists them. */
export async function allJournals(w: World): Promise<Json[]> {
  const out: Json[] = [];
  for (let page = 1; page < 100; page++) {
    const data = await w.ok("journal.list", { page, status: "Posted" });
    out.push(...data.entries);
    if (out.length >= data.count || data.entries.length === 0) break;
  }
  return out;
}

/** A CSV file as rows of cells (RFC 4180: quoted cells, doubled quotes, CRLF or LF), so a test reads
 * what a spreadsheet would. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let at = 0; at < text.length; at++) {
    const char = text.charAt(at);
    if (quoted) {
      if (char !== '"') cell += char;
      else if (text.charAt(at + 1) === '"') {
        cell += '"';
        at += 1;
      } else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") cell += char;
    else if (text.charAt(at + 1) !== "\n") cell += char; // a bare carriage return is data
  }
  if (cell !== "" || row.length > 0) rows.push([...row, cell]);
  return rows;
}

/** A cell a spreadsheet would run as a formula if it were text: it starts with one of these. */
export const FORMULA_START = /^[=+\-@\t\r]/;
/** What an exact money cell looks like: the one kind of cell allowed to start with a minus sign. */
export const MONEY = /^-?\d+\.\d{2}$/;

/** The cells of a table a spreadsheet could be fooled by: text that starts as a formula (only an
 * exact money amount may start with a minus sign) or that carries disguised characters. */
export function unsafeCells(table: readonly (readonly string[])[]): string[] {
  const found: string[] = [];
  for (const cells of table)
    for (const cell of cells)
      if ((FORMULA_START.test(cell) && !MONEY.test(cell)) || DISGUISES.test(cell))
        found.push(cell.slice(0, 60));
  return found;
}

/** Characters that disguise text: controls, the bidirectional overrides and isolates, and the
 * invisible format characters. None may survive into anything the books derive from a memo. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point.
export const DISGUISES = /[\u0000-\u0008\u000B-\u001F\u007F​-‏‪-‮⁠-⁯﻿]/;
