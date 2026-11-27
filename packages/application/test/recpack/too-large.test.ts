/** A report is never cut short. A reconciliation holds at most 5,000 lines, so what it leaves outstanding is no
 * more than that and what was posted while its draft was open; a report that would list more than it can carry
 * says so and is not made, instead of leaving lines out. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WRITE_OPERATIONS } from "../../src/client-contracts.gen.ts";
import { ApplicationHttp } from "../../src/http.ts";
import { LocalBookService } from "../../src/local.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS } from "../../src/schema.ts";
import { REPORT_OUTSTANDING_LINES } from "../../src/slices/reconcile/schema.ts";
import { BULK_BOOK, postBulk } from "../support/bulk-book.ts";
import type { Json } from "./support.ts";

const WRITES: ReadonlySet<string> = new Set(WRITE_OPERATIONS);
let directory: string;
let service: LocalBookService;
let http: ApplicationHttp;

async function call(name: string, input: unknown = {}): Promise<{ status: number; body: Json }> {
  const response = await http.fetch(
    new Request(`http://127.0.0.1:4010/v1/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: APPLICATION_API_VERSION,
        bookId: "local-book",
        input,
        ...(WRITES.has(name) ? { operationId: crypto.randomUUID() } : {}),
      }),
    }),
  );
  return { status: response.status, body: (await response.json()) as Json };
}
async function ok(name: string, input: unknown = {}): Promise<Json> {
  const reply = await call(name, input);
  if (reply.status !== 200) throw new Error(`${name}: ${JSON.stringify(reply.body.error)}`);
  return reply.body.data;
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "rastrata-recpack-large-"));
  const now = () => new Date(Date.UTC(2027, 0, 5, 12, 0, 0));
  service = await LocalBookService.open(join(directory, "book.sqlite"), { now });
  http = new ApplicationHttp(
    service,
    { bookId: service.bookId, permissions: BUSINESS_PERMISSIONS },
    { clock: now },
  );
  await service.setup(BULK_BOOK);
  await postBulk(service, 100);
  // The book is read once, as a person's first screen would, so that the calls below are not the replay of it.
  await service.readAggregate();
}, 300_000);

afterAll(() => {
  service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

test("a statement that left more outstanding than a report lists is refused with the reason, and nothing is left out", async () => {
  // A draft holds at most 5,000 lines, so the one way to leave more outstanding is for entries to arrive while
  // it is open. The service lets a stale draft be finished (the screen does not), and the books at that
  // revision hold every entry: a statement that shows none of them reaches a balance of 0.00 with none ticked.
  const draft = await ok("reconcile.start", {
    accountId: "1000",
    statementDate: "2026-12-30",
    statementBalance: "0.00",
  });
  expect(draft.lines).toHaveLength(100);
  await postBulk(service, REPORT_OUTSTANDING_LINES);
  const stale = await ok("reconcile.get", { id: draft.id });
  expect(stale.stale).toBe(true);
  const done = await ok("reconcile.complete", { id: stale.id, expectedVersion: stale.version });
  expect(done.selectedCount).toBe(0);
  const refused = await call("reconcile.report", { id: done.id });
  expect(refused.status).toBe(409);
  expect(refused.body.error.code).toBe("reconcile_report_too_large");
  expect(refused.body.error.message).toContain(String(REPORT_OUTSTANDING_LINES + 100));
  expect(refused.body.error.message).toContain("Nothing is left out of a report");
  // The pack names it too, and still makes the rest.
  const pack = await ok("taxAccountant.build", { taxYear: 2026 });
  const names = (pack.files as Json[]).map((file) => file.path);
  expect(names).not.toContain("reconciliations.csv");
  expect(names).toContain("journal.csv");
  const readme = (pack.files as Json[]).find((file) => file.path === "README.md")
    ?.content as string;
  expect(readme).toContain("could not be made");
  expect(readme).toContain("more than the 10000 one report lists");
});
