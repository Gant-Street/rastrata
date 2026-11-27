import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationHttp } from "../../src/http.ts";
import { LocalBookService } from "../../src/local.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS } from "../../src/schema.ts";
import type { BusinessPermission } from "../../src/schema.ts";
import { useClock, useIngestPort } from "../../src/slices/statements/ports.ts";
import { FakeIngest } from "./fake-ingest.ts";

export const book = {
  name: "Statements Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1010", name: "Chase Checking", role: "asset" },
    { code: "1020", name: "Rho Checking", role: "asset" },
    { code: "2100", name: "Business Card", role: "liability" },
    { code: "3000", name: "Owner capital", role: "equity" },
    { code: "4000", name: "Sales", role: "income" },
    { code: "5000", name: "Expenses", role: "expense" },
  ],
};

/** The day the tests run on: after every date in the fixtures, so nothing looks future-dated. */
export const FIXED_NOW = new Date(2026, 2, 5, 9, 30, 0);

/** A book on a private database, an `ApplicationHttp` in front of it, and the ingestion pipeline:
 * a fake that can be told to fail (the default), or the real one with `real: true`. Every call goes
 * through the same HTTP boundary a client uses. */
export async function statementsFixture(options: { setup?: boolean; real?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-statements-"));
  const path = join(directory, "book.sqlite");
  let service = await LocalBookService.open(path, { now: () => FIXED_NOW });
  const ingest = new FakeIngest();
  // The instant of each import moves forward a second at a time, as a real clock does, so two
  // imports of one file are two batches rather than one batch sent twice.
  let tick = 0;
  const wire = (target: LocalBookService) => {
    useClock(target, () => new Date(FIXED_NOW.getTime() + tick++ * 1000));
    if (!options.real) useIngestPort(target, ingest);
  };
  wire(service);
  const httpFor = (permissions: readonly BusinessPermission[]) =>
    new ApplicationHttp(service, { bookId: service.bookId, permissions });
  const call = async (
    name: string,
    input: unknown = {},
    operationId?: string,
    permissions?: readonly BusinessPermission[],
  ) => {
    const response = await httpFor(permissions ?? BUSINESS_PERMISSIONS).fetch(
      new Request(`http://127.0.0.1:4010/v1/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: APPLICATION_API_VERSION,
          bookId: "local-book",
          input,
          ...(operationId ? { operationId } : {}),
        }),
      }),
    );
    return { status: response.status, body: await response.json() };
  };
  const upload = async (
    body: Uint8Array | string,
    headers: Record<string, string> = { "content-type": "text/csv" },
    permissions?: readonly BusinessPermission[],
  ) => {
    const response = await httpFor(permissions ?? BUSINESS_PERMISSIONS).fetch(
      new Request("http://127.0.0.1:4010/v1/uploads", {
        method: "POST",
        headers,
        body: body as BodyInit,
      }),
    );
    return { status: response.status, body: await response.json() };
  };
  if (options.setup !== false) {
    const response = await call("book.setup", book, crypto.randomUUID());
    if (!response.body.ok) throw new Error(`setup failed: ${JSON.stringify(response.body)}`);
  }
  return {
    call,
    upload,
    ingest,
    path,
    get service() {
      return service;
    },
    /** The HTTP boundary with every permission, for tests that build their own requests. */
    get http() {
      return httpFor(BUSINESS_PERMISSIONS);
    },
    /** Upload a file and return its receipt's sha256. */
    async store(body: Uint8Array | string, name = "statement.csv", type = "text/csv") {
      const result = await upload(body, { "content-type": type, "x-upload-name": name });
      if (result.status !== 200) throw new Error(`upload failed: ${JSON.stringify(result.body)}`);
      return result.body.data.sha256 as string;
    },
    /** Close and reopen the same database, as a restart would. */
    async restart() {
      service.close();
      service = await LocalBookService.open(path, { now: () => FIXED_NOW });
      wire(service);
    },
    close() {
      service.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export type StatementsFixture = Awaited<ReturnType<typeof statementsFixture>>;
