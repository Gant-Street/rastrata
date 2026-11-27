import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationHttp } from "../src/http.ts";
import { LocalBookService } from "../src/local.ts";
import {
  APPLICATION_API_VERSION,
  BUSINESS_PERMISSIONS,
  type BusinessPermission,
} from "../src/schema.ts";

/** A small chart that exercises every tag: balance-sheet classes, tax lines and a role key. */
export const taggedBook = {
  name: "Tag Fixture Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1000", name: "Checking", role: "asset", tags: { cashFlowClass: "cash" } },
    { code: "2000", name: "Card", role: "liability", tags: { cashFlowClass: "operating" } },
    {
      code: "3000",
      name: "Owner investment",
      role: "equity",
      tags: { cashFlowClass: "financing" },
    },
    {
      code: "4000",
      name: "Sales",
      role: "income",
      tags: { taxLine: "scheduleC.line1", roleKey: "revenue.sales" },
    },
    { code: "6000", name: "Advertising", role: "expense", tags: { taxLine: "scheduleC.line8" } },
    { code: "6100", name: "Interest", role: "expense" },
  ],
};

export const untaggedBook = {
  name: "Plain Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1000", name: "Cash", role: "asset" },
    { code: "3000", name: "Capital", role: "equity" },
    { code: "4000", name: "Sales", role: "income" },
    { code: "5000", name: "Expense", role: "expense" },
  ],
};

const cleanup: (() => void)[] = [];
export function cleanUp() {
  for (const work of cleanup.splice(0)) work();
}

/** One book on disk with the versioned HTTP boundary in front, restartable like a real server. */
export async function chartFixture() {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-chart-"));
  const path = join(directory, "book.sqlite");
  let service = await LocalBookService.open(path);
  let http = new ApplicationHttp(service, {
    bookId: service.bookId,
    permissions: BUSINESS_PERMISSIONS,
  });
  cleanup.push(() => {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const call = async (
    name: string,
    input: unknown = {},
    operationId?: string,
    permissions?: readonly BusinessPermission[],
  ) => {
    const target = permissions
      ? new ApplicationHttp(service, { bookId: service.bookId, permissions })
      : http;
    const response = await target.fetch(
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
  return {
    call,
    path,
    get service() {
      return service;
    },
    async restart() {
      service.close();
      service = await LocalBookService.open(path);
      http = new ApplicationHttp(service, {
        bookId: service.bookId,
        permissions: BUSINESS_PERMISSIONS,
      });
    },
    /** Set a book up and return its fixture. */
    async withBook(book: unknown = taggedBook) {
      const result = await call("book.setup", book, crypto.randomUUID());
      if (!result.body.ok) throw new Error(`Setup failed: ${JSON.stringify(result.body)}`);
      return this;
    },
  };
}

export type ChartFixture = Awaited<ReturnType<typeof chartFixture>>;

export const uuid = () => crypto.randomUUID();
