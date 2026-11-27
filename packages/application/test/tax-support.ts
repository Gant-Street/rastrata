import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "bun:test";
import type { AccessPrincipal } from "../src/agent/principal.ts";
import { ApplicationHttp } from "../src/http.ts";
import { LocalBookService } from "../src/local.ts";
import { ingestPort } from "../src/slices/ingest/port.ts";
import {
  APPLICATION_API_VERSION,
  BUSINESS_PERMISSIONS,
  type BusinessPermission,
} from "../src/schema.ts";
import { batchOf, type LineInit } from "./support/ingest-fixture.ts";

/** A decoded JSON reply. The tests read it by shape; the contract validates the shape. */
// biome-ignore lint/suspicious/noExplicitAny: test code reads replies by shape
export type Json = any;

const cleanup: (() => void)[] = [];
export function cleanUpTax() {
  for (const work of cleanup.splice(0)) work();
}

/** Who a request is made as: a list of permissions, an agent token (the secret `tokens.create`
 * returned, sent as a Bearer credential), or permissions and a principal given directly. */
export type CallAs =
  | readonly BusinessPermission[]
  | { readonly token: string }
  | { readonly permissions: readonly BusinessPermission[]; readonly principal: AccessPrincipal };

export type Call = (
  name: string,
  input?: unknown,
  operationId?: string,
  as?: CallAs,
) => Promise<{ status: number; body: Json }>;

export interface TaxFixtureOptions {
  /** The service clock, a date such as "2026-03-01". */
  readonly today?: string;
}

/** One book on disk with the versioned HTTP boundary in front, restartable like a real server. The
 * clock is fixed, so "has the year ended" does not depend on the day the test runs. */
export async function taxFixture(options: TaxFixtureOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-tax-"));
  const path = join(directory, "book.sqlite");
  const now = () => new Date(`${options.today ?? "2026-03-01"}T12:00:00`);
  let service = await LocalBookService.open(path, { now });
  let http = new ApplicationHttp(service, {
    bookId: service.bookId,
    permissions: BUSINESS_PERMISSIONS,
  });
  cleanup.push(() => {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const call: Call = async (name, input = {}, operationId, as) => {
    const target =
      as === undefined || (!Array.isArray(as) && "token" in as)
        ? http
        : new ApplicationHttp(
            service,
            "permissions" in (as as object)
              ? {
                  bookId: service.bookId,
                  permissions: (as as { permissions: readonly BusinessPermission[] }).permissions,
                  principal: (as as { principal: AccessPrincipal }).principal,
                }
              : { bookId: service.bookId, permissions: as as readonly BusinessPermission[] },
          );
    const token = as !== undefined && !Array.isArray(as) && "token" in as ? as.token : undefined;
    const response = await target.fetch(
      new Request(`http://127.0.0.1:4010/v1/${name}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
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
  /** Post one balanced entry the way a person does: save a draft, prepare it, commit the plan. */
  const post = async (
    date: string,
    lines: readonly (readonly [account: string, debit: string, credit: string])[],
    narration: string,
  ): Promise<string> => {
    const draft = await call(
      "drafts.create",
      {
        data: {
          date,
          reference: narration.slice(0, 40),
          narration,
          lines: lines.map(([accountId, debit, credit]) => ({ accountId, debit, credit })),
        },
      },
      crypto.randomUUID(),
    );
    expect(draft.status, JSON.stringify(draft.body)).toBe(200);
    const planId = crypto.randomUUID();
    const prepared = await call(
      "journal.prepare",
      { draftId: draft.body.data.id, expectedVersion: draft.body.data.version },
      planId,
    );
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
    const committed = await call("operations.commit", {
      planId,
      planHash: prepared.body.data.planHash,
    });
    expect(committed.body.data.disposition, JSON.stringify(committed.body)).toBe("committed");
    return draft.body.data.id as string;
  };
  return {
    call,
    post,
    path,
    get service() {
      return service;
    },
    async restart() {
      service.close();
      service = await LocalBookService.open(path, { now });
      http = new ApplicationHttp(service, {
        bookId: service.bookId,
        permissions: BUSINESS_PERMISSIONS,
      });
    },
    /** Add an account to the chart (prepare, then commit). An account can only be added with an
     * effective date after the book's last entry, so add it before posting. */
    async addAccount(code: string, name: string, role: string, effectiveOn: string) {
      const planId = crypto.randomUUID();
      const prepared = await call(
        "accounts.prepareCreate",
        { code, name, role, effectiveOn },
        planId,
      );
      expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
      const committed = await call("operations.commit", {
        planId,
        planHash: prepared.body.data.planHash,
      });
      expect(committed.body.data.disposition, JSON.stringify(committed.body)).toBe("committed");
    },
    /** Set a book up from a chart template, as the setup wizard does, with banks named. */
    async setupFromTemplate(input: {
      readonly templateId: string;
      readonly basis: "cash" | "accrual";
      readonly taxYear: number;
      readonly addOns?: readonly string[];
      readonly name?: string;
      readonly fiscalYear?: number;
      /** The last fiscal year of the calendar. Fixtures default to the one year they always had, so a
       * test that is about a calendar the clock has outgrown still has one. */
      readonly calendarThrough?: number;
    }) {
      const template = await call("templates.get", {
        templateId: input.templateId,
        basis: input.basis,
        taxYear: input.taxYear,
        ...(input.addOns ? { addOns: input.addOns } : {}),
      });
      expect(template.status, JSON.stringify(template.body)).toBe(200);
      // A template carries no bank or card account: the fixture brings its own, as a person would.
      const accounts = [
        {
          code: "1000",
          name: "Test Bank 1000",
          role: "asset",
          tags: { cashFlowClass: "cash", kind: "bank" },
        },
        {
          code: "1010",
          name: "Test Bank 1010",
          role: "asset",
          tags: { cashFlowClass: "cash", kind: "bank" },
        },
        {
          code: "2000",
          name: "Test Card 2000",
          role: "liability",
          tags: { cashFlowClass: "operating", kind: "card" },
        },
        ...(template.body.data.accounts as Json[]).map((account) => ({
          code: account.code,
          name: account.name,
          role: account.role,
          ...(account.parentCode ? { parentCode: account.parentCode } : {}),
          tags: account.tags,
        })),
      ];
      const setup = await call(
        "book.setup",
        {
          name: input.name ?? "Fixture Studio",
          currency: "USD",
          fiscalYear: input.fiscalYear ?? input.taxYear,
          calendarThrough: input.calendarThrough ?? input.fiscalYear ?? input.taxYear,
          periodModel: "monthly",
          basis: input.basis,
          accounts,
        },
        crypto.randomUUID(),
      );
      expect(setup.body.ok, JSON.stringify(setup.body)).toBe(true);
    },
  };
}

export type TaxFixture = Awaited<ReturnType<typeof taxFixture>>;
export const amount = (value: string) => value;

/** Reply data, failing the test with the whole reply if the call was refused. */
export async function act(
  f: TaxFixture,
  name: string,
  input: unknown,
  operationId: string = crypto.randomUUID(),
): Promise<Json> {
  const reply = await f.call(name, input, operationId);
  expect(reply.body.ok, JSON.stringify(reply.body)).toBe(true);
  return reply.body.data;
}

/** Put bank lines into the Inbox for the checking account, categorise them to an account and post
 * them, the way the Inbox does for a person. */
export async function postBankLines(
  f: TaxFixture,
  account: string,
  lines: readonly LineInit[],
): Promise<void> {
  const port = ingestPort(f.service);
  const report = port.submit(batchOf(port, lines, { ledgerAccountId: "1000" }));
  const ids = report.dispositions.flatMap((item) => (item.itemId ? [item.itemId] : []));
  await act(f, "inbox.categorize", { itemIds: ids, accountId: account });
  const posted = await act(f, "inbox.post", { itemIds: ids });
  expect(posted.failed, JSON.stringify(posted)).toBe(0);
}
