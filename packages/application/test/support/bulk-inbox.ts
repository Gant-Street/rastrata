/** A book with a large history and an Inbox that has lines waiting, made the way `bench/reads.ts` makes one, for
 * the slow tier's tests of how a read grows with the book and of what the application keeps current at the size
 * a business reaches: journals posted straight to the ledger, a twentieth of them reversed, each with the posted
 * draft the screens leave behind, and bank lines waiting in the Inbox. Test support. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chart } from "../../bench/book.ts";
import { ApplicationHttp } from "../../src/http.ts";
import type { BankLine } from "../../src/ingest-types.ts";
import { LocalBookService } from "../../src/local.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS } from "../../src/schema.ts";
import { ingestPort } from "../../src/slices/ingest/port.ts";
import { type BulkEntry, postBulk, reverseBulk } from "./bulk-book.ts";
import { clearMostOfCash } from "./reconcile-status.ts";

/** The nth journal of the book: dates all over the year, as the bench posts them. */
export const bulkEntry = (n: number): BulkEntry => ({
  date: `2026-${String(1 + (n % 12)).padStart(2, "0")}-${String(1 + (n % 27)).padStart(2, "0")}`,
  debit: "1000",
  credit: "4000",
  cents: 1000n + BigInt(n),
});

export interface BulkInboxOptions {
  /** How many accounts the chart has (the bench's default is four). */
  readonly accounts?: number;
  /** What a waiting line says, from its position. The bench's lines are one vendor in four hundred. */
  readonly description?: (index: number) => string;
  /** The share of the cash account's postings that a completed reconciliation has cleared, as a book that is
   * reconciled every month has (none by default). */
  readonly cleared?: number;
}

export interface BulkInboxBook {
  readonly service: LocalBookService;
  /** An operation by name, as a client calls it (with no input unless one is given). Throws when it fails. */
  call(name: string, input?: unknown): Promise<void>;
  /** One posting and then the first look at the new state, in milliseconds: the read of the ledger the look
   * begins with, and the operation. The input may be made from the journal just posted (its id). */
  firstLook(name: string, input?: unknown | ((posted: string) => unknown)): Promise<number>;
}

/** Make the book. `cleanup` is given the work that closes it and removes its files. */
export async function bulkInboxBook(
  journals: number,
  lines: number,
  cleanup: (work: () => void) => void,
  options: BulkInboxOptions = {},
): Promise<BulkInboxBook> {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-bulk-inbox-"));
  const service = await LocalBookService.open(join(directory, "book.sqlite"), { snapshots: false });
  cleanup(() => {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await service.setup(chart(options.accounts ?? 4));
  await postBulk(service, journals, { entry: bulkEntry });
  const every = 20;
  const ids: string[] = [];
  for (let n = every; n <= journals; n += every) ids.push(`bulk-${n}`);
  await reverseBulk(service, ids);
  // biome-ignore lint/suspicious/noExplicitAny: test support reaching the service's product store
  const store = (service as any).db as {
    query(sql: string): { run(...args: unknown[]): unknown };
    transaction<T>(work: () => T): T;
  };
  store.transaction(() => {
    const insert = store.query(
      "INSERT INTO app_drafts (id, version, status, body, outcome_sequence) VALUES (?, 1, 'posted', ?, ?)",
    );
    for (let n = 1; n <= journals; n += 1)
      insert.run(
        `bulk-${n}`,
        JSON.stringify({
          date: "2026-06-15",
          reference: `INV-${n}`,
          narration: `Bulk journal ${n}`,
          lines: [
            { accountId: "1000", debit: "10.00", credit: "" },
            { accountId: "4000", debit: "", credit: "10.00" },
          ],
        }),
        String(n + 1),
      );
  });
  const describe =
    options.description ?? ((index) => `VENDOR ${index % 400} CARD PURCHASE ${index}`);
  const port = ingestPort(service);
  const bankLines: BankLine[] = Array.from({ length: lines }, (_, index) => ({
    kind: "bankLine",
    provider: "csv",
    accountKey: "csv:1000",
    rawIndex: index,
    postedOn: `2026-${String(1 + (index % 12)).padStart(2, "0")}-${String(1 + (index % 27)).padStart(2, "0")}`,
    amount: `-${(1 + (index % 300)).toString()}.${String(index % 100).padStart(2, "0")}`,
    currency: "USD",
    description: describe(index),
  }));
  const raw = port.archive(
    new TextEncoder().encode(JSON.stringify(bankLines)),
    "text/csv",
    "inbox.csv",
  );
  port.submit({
    provider: "csv",
    sourceKey: "csv:1000",
    raw,
    lines: bankLines,
    balances: [],
    fetchedAt: new Date().toISOString(),
    ledgerAccountId: "1000",
  });
  await service.readAggregate();
  if (options.cleared) clearMostOfCash(service, journals, options.cleared);
  const http = new ApplicationHttp(service, {
    bookId: service.bookId,
    permissions: BUSINESS_PERMISSIONS,
  });
  const call = async (name: string, input: unknown = {}): Promise<void> => {
    const response = await http.fetch(
      new Request(`http://127.0.0.1:4010/v1/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: APPLICATION_API_VERSION, bookId: "local-book", input }),
      }),
    );
    const body = (await response.json()) as { ok: boolean };
    if (!body.ok) throw new Error(`${name} failed: ${JSON.stringify(body).slice(0, 300)}`);
  };
  const firstLook = async (
    name: string,
    input: unknown | ((posted: string) => unknown) = {},
  ): Promise<number> => {
    const [posted] = await postBulk(service, 1, { entry: bulkEntry });
    const asked = typeof input === "function" ? input(posted as string) : input;
    const started = performance.now();
    await service.readAggregate();
    await call(name, asked);
    return performance.now() - started;
  };
  return { service, call, firstLook };
}
