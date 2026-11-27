/** Reading the book as its owner, for seeding and for grading. Everything the grader says about a
 * run comes from here: the Inbox, the posted entries, the reconciliations, the periods, the rules
 * and the token's trail. Nothing comes from what an agent said it did. */
import type { Json, OwnerClient } from "./owner.ts";
import type { LineExpectation, World } from "./world.ts";

/** Every Inbox item, paged. */
export async function allItems(owner: OwnerClient, filter: Json = {}): Promise<Json[]> {
  const items: Json[] = [];
  for (let page = 1; page < 100; page++) {
    const data = await owner.call("inbox.list", { filter, page, pageSize: 200, sort: "date_asc" });
    items.push(...data.items);
    if (items.length >= data.count || data.items.length === 0) break;
  }
  return items;
}

/** Every posted journal entry, each read in full (its lines, source and narration). */
export async function allJournals(owner: OwnerClient): Promise<Json[]> {
  const heads: Json[] = [];
  for (let page = 1; page < 200; page++) {
    const data = await owner.call("journal.list", { page, status: "Posted" });
    heads.push(...data.entries);
    if (heads.length >= data.count || data.entries.length === 0) break;
  }
  const journals: Json[] = [];
  for (const head of heads) journals.push(await owner.call("journal.get", { journalId: head.id }));
  return journals;
}

/** The identity a line is found by: its account, day and amount. Two lines may share it (a pair of
 * identical purchases), so matching pairs them off in file order. */
const keyOf = (account: string, date: string, amount: string): string =>
  `${account}|${date}|${amount}`;

export interface Paired {
  readonly expectation: LineExpectation;
  readonly item: Json | undefined;
}

/** Pair each imported line of the world with the Inbox item it became. Rows that never reach the
 * Inbox (pending ones) have no item. `spare` are items no row explains. */
export function pairLines(
  items: readonly Json[],
  world: World,
): { readonly paired: Paired[]; readonly spare: Json[] } {
  const pool = new Map<string, Json[]>();
  for (const item of items) {
    if (item.line?.provider !== "csv") continue;
    const key = keyOf(String(item.ledgerAccountId), item.line.date, item.line.amount);
    pool.set(key, [...(pool.get(key) ?? []), item]);
  }
  for (const list of pool.values()) list.sort((a, b) => a.line.rawIndex - b.line.rawIndex);
  const paired: Paired[] = [];
  for (const expectation of world.lines) {
    if (expectation.kind === "pending") {
      paired.push({ expectation, item: undefined });
      continue;
    }
    const list = pool.get(keyOf(expectation.account, expectation.row.date, expectation.row.amount));
    paired.push({ expectation, item: list?.shift() });
  }
  return { paired, spare: [...pool.values()].flat() };
}

/** Everything the grader reads, in one place. */
export interface BookSnapshot {
  readonly takenAt: string;
  readonly items: Json[];
  /** Detail of each drafted or posted item: `inbox.get`'s `item`, with its decision's legs. */
  readonly detail: Record<string, Json>;
  readonly journals: Json[];
  readonly accounts: Record<string, { name: string; balance: string; role: string }>;
  readonly rules: Json[];
  readonly reconciliations: Json[];
  readonly periods: Json[];
  readonly drafts: Json[];
  readonly summary: Json;
  readonly tokenEvents: Json[];
  readonly importHistory: Json[];
  /** `stripe.status`, `cutover.checklist` and `classifier.status`, when the book answers them. */
  readonly stripe: Json | null;
  readonly checklist: Json | null;
  readonly classifier: Json | null;
}

async function pages(
  owner: OwnerClient,
  operation: string,
  input: Json,
  field: string,
  limit = 100,
): Promise<Json[]> {
  const out: Json[] = [];
  for (let page = 1; page <= limit; page++) {
    const data = await owner.call(operation, { ...input, page });
    const rows = (data?.[field] as Json[] | undefined) ?? [];
    out.push(...rows);
    if (rows.length === 0 || (typeof data.count === "number" && out.length >= data.count)) break;
  }
  return out;
}

export async function readBook(owner: OwnerClient, tokenId?: string): Promise<BookSnapshot> {
  const items = await allItems(owner);
  const detail: Record<string, Json> = {};
  for (const item of items) {
    if (item.status === "drafted" || item.status === "posted") {
      const got = await owner.call("inbox.get", { itemId: item.id });
      detail[item.id] = got.item;
    }
  }
  const accountList = await owner.call("accounts.list");
  const accounts: BookSnapshot["accounts"] = {};
  for (const account of accountList.accounts as Json[])
    accounts[account.code] = { name: account.name, balance: account.balance, role: account.role };
  const reconciliations = await pages(owner, "reconcile.list", {}, "items").catch(
    () => [] as Json[],
  );
  const full: Json[] = [];
  for (const record of reconciliations)
    full.push(await owner.call("reconcile.get", { id: record.id }).catch(() => record));
  const tokenEvents: Json[] = [];
  if (tokenId)
    for (let page = 1; page < 400; page++) {
      const data = await owner.call("tokens.activity", { tokenId, page });
      tokenEvents.push(...data.events);
      if (data.events.length === 0 || tokenEvents.length >= data.count) break;
    }
  return {
    takenAt: new Date().toISOString(),
    items,
    detail,
    journals: await allJournals(owner),
    accounts,
    rules: [
      ...(((await owner.call("rules.list", { usage: true })).rules as Json[]) ?? []),
      ...(((await owner.call("rules.list", { status: "deleted" })).rules as Json[]) ?? []),
    ],
    reconciliations: full,
    periods: ((await owner.call("periods.list")).periods as Json[]) ?? [],
    drafts: await pages(owner, "drafts.list", {}, "drafts").catch(() => [] as Json[]),
    summary: await owner.call("inbox.summary"),
    tokenEvents,
    importHistory:
      ((await owner.call("import.history", {}).catch(() => ({}))).runs as Json[]) ?? [],
    stripe: await owner.call("stripe.status").catch(() => null),
    checklist: await owner.call("cutover.checklist").catch(() => null),
    classifier: await owner.call("classifier.status").catch(() => null),
  };
}

/** A debit-positive map of account id to cents from a journal's lines. */
export function legsOf(journal: Json): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const toCents = (text: string): bigint => {
    const match = /^(-?)(\d+)\.(\d{2})$/.exec(text);
    if (!match) throw new Error(`Not exact money: ${text}`);
    const value = BigInt(match[2] as string) * 100n + BigInt(match[3] as string);
    return match[1] === "-" ? -value : value;
  };
  for (const line of journal.lines as Json[]) {
    const amount =
      (line.debit ? toCents(line.debit) : 0n) - (line.credit ? toCents(line.credit) : 0n);
    out.set(line.accountId, (out.get(line.accountId) ?? 0n) + amount);
  }
  return out;
}
