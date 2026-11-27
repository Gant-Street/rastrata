import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationHttp } from "../src/http.ts";
import { LocalBookService } from "../src/local.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS } from "../src/schema.ts";
import type { BusinessPermission } from "../src/schema.ts";

/** Shared fixtures for the calendar lane's tests: a real local book behind the real `/v1` surface. */
export const accounts = [
  { code: "1000", name: "Cash", role: "asset" },
  { code: "3000", name: "Capital", role: "equity" },
  { code: "4000", name: "Sales", role: "income" },
  { code: "5000", name: "Expense", role: "expense" },
] as const;

export const baseSetup = {
  name: "Calendar Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts,
} as const;

export interface Reply {
  readonly status: number;
  // The envelope is checked field by field in each test, so it stays loosely typed here.
  // biome-ignore lint/suspicious/noExplicitAny: test envelope
  readonly body: any;
}

export async function fixture(
  options: { cleanup?: (work: () => void) => void; now?: () => Date } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-calendar-"));
  const path = join(directory, "book.sqlite");
  const open = () => LocalBookService.open(path, options.now ? { now: options.now } : {});
  let service = await open();
  let http = new ApplicationHttp(service, {
    bookId: service.bookId,
    permissions: BUSINESS_PERMISSIONS,
  });
  const close = () => {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  };
  options.cleanup?.(close);
  const call = async (
    name: string,
    input: unknown = {},
    operationId?: string,
    permissions?: readonly BusinessPermission[],
  ): Promise<Reply> => {
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
  const f = {
    call,
    path,
    close,
    get service() {
      return service;
    },
    async restart() {
      service.close();
      service = await open();
      http = new ApplicationHttp(service, {
        bookId: service.bookId,
        permissions: BUSINESS_PERMISSIONS,
      });
    },
    async setup(setup: Record<string, unknown> = baseSetup) {
      // The calendar these tests were written for is the first fiscal year alone, however late the
      // clock is; a test of the default asks for it by leaving `calendarThrough` to `book.setup`.
      const body =
        "calendarThrough" in setup || typeof setup.fiscalYear !== "number"
          ? setup
          : { ...setup, calendarThrough: setup.fiscalYear };
      const reply = await call("book.setup", body, crypto.randomUUID());
      if (!reply.body.ok) throw new Error(`setup failed: ${JSON.stringify(reply.body)}`);
      return reply;
    },
    /** Draft, prepare and commit one balanced two-line journal; returns the committed reply. */
    async post(
      date: string,
      amount: string,
      lines: readonly [string, string] = ["1000", "4000"],
      reference = "TEST",
    ) {
      const draft = (
        await call(
          "drafts.create",
          {
            data: {
              date,
              reference,
              narration: `${reference} ${date}`,
              lines: [
                { accountId: lines[0], debit: amount, credit: "" },
                { accountId: lines[1], debit: "", credit: amount },
              ],
            },
          },
          crypto.randomUUID(),
        )
      ).body.data;
      const plan = (
        await call(
          "journal.prepare",
          { draftId: draft.id, expectedVersion: draft.version },
          crypto.randomUUID(),
        )
      ).body;
      if (!plan.ok) return { plan, receipt: undefined, draft };
      const receipt = await call("operations.commit", {
        planId: plan.data.planId,
        planHash: plan.data.planHash,
      });
      return { plan: plan, receipt: receipt.body, draft };
    },
    /** Post one journal and require it to commit; returns its journal id (a draft posts as the
     * journal named for the draft). */
    async postOk(
      date: string,
      amount: string,
      lines: readonly [string, string] = ["1000", "4000"],
      reference = "TEST",
    ): Promise<string> {
      const posted = await f.post(date, amount, lines, reference);
      if (!posted.plan.ok || posted.receipt?.data?.disposition !== "committed")
        throw new Error(
          `posting ${date} failed: ${JSON.stringify(posted.plan.error ?? posted.receipt)}`,
        );
      return posted.draft.id as string;
    },
    /** Call a prepare operation with a fresh identity and commit its plan; returns both replies. */
    async prepareCommit(name: string, input: unknown, permissions?: readonly BusinessPermission[]) {
      const plan = await call(name, input, crypto.randomUUID(), permissions);
      if (!plan.body.ok || !plan.body.data.valid) return { plan, receipt: undefined };
      const receipt = await call(
        "operations.commit",
        { planId: plan.body.data.planId, planHash: plan.body.data.planHash },
        undefined,
        permissions,
      );
      return { plan, receipt };
    },
    /** `periods.list`, unwrapped. */
    async periods() {
      const reply = await call("periods.list");
      if (!reply.body.ok) throw new Error(`periods.list failed: ${JSON.stringify(reply.body)}`);
      return reply.body.data;
    },
    /** Extend through a fiscal year (omitted: one more) and require it to commit. */
    async extend(through?: number) {
      const done = await f.prepareCommit(
        "periods.extend",
        through === undefined ? {} : { through },
      );
      if (done.receipt?.body.data?.disposition !== "committed")
        throw new Error(`extend failed: ${JSON.stringify(done.plan.body)}`);
      return done;
    },
  };
  return f;
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;
