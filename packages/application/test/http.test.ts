import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { decodeBookCommand, encodeBookCommand, hashCanonical, sealCommand } from "@rastrata/kernel";
import { LocalBookService } from "../src/local.ts";
import { ApplicationHttp } from "../src/http.ts";
import { BUSINESS_PERMISSIONS, APPLICATION_API_VERSION } from "../src/schema.ts";
import type { BusinessPermission } from "../src/schema.ts";

const book = {
  name: "Contract Co",
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
const opening = {
  date: "2026-01-15",
  reference: "OPEN",
  narration: "Owner contribution",
  lines: [
    { accountId: "1000", debit: "1000.00", credit: "" },
    { accountId: "3000", debit: "", credit: "1000.00" },
  ],
};
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-api-contract-"));
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
  };
}

test("versioned contract rejects numeric money, unknown fields, scope and origin changes", async () => {
  const f = await fixture();
  expect((await f.call("book.get")).body.data.setup).toBeNull();
  expect((await f.call("book.setup", book, crypto.randomUUID())).body.ok).toBe(true);
  const malformed = await f.call(
    "drafts.create",
    {
      data: { ...opening, lines: [{ accountId: "1000", debit: 1, credit: "" }, opening.lines[1]] },
    },
    crypto.randomUUID(),
  );
  expect(malformed.status).toBe(400);
  expect(malformed.body.error.details[0].path).toBe("input.data.lines[0].debit");
  // A basis the book does not keep is refused with the reason, not approximated; an unknown one is
  // not a basis at all.
  const cashFromAccrual = await f.call("reports.get", { asOf: "2026-01-31", basis: "cash" });
  expect(cashFromAccrual.status).toBe(409);
  expect(cashFromAccrual.body.error.code).toBe("basis_unavailable");
  expect(cashFromAccrual.body.error.message).toMatch(/accrual basis/);
  expect((await f.call("reports.get", { asOf: "2026-01-31", basis: "tax" })).body.error.code).toBe(
    "invalid_input",
  );
  expect((await f.call("drafts.create", { data: opening })).body.error.code).toBe(
    "operation_id_required",
  );
  const http = new ApplicationHttp(f.service, {
    bookId: "local-book",
    permissions: BUSINESS_PERMISSIONS,
  });
  for (const [body, headers, status, code] of [
    [{ version: "v2", bookId: "local-book", input: {} }, {}, 409, "version_unsupported"],
    [
      { version: APPLICATION_API_VERSION, bookId: "another", input: {} },
      {},
      403,
      "book_scope_mismatch",
    ],
    [
      { version: APPLICATION_API_VERSION, bookId: "local-book", input: {}, actorId: "root" },
      {},
      400,
      "invalid_input",
    ],
    [
      { version: APPLICATION_API_VERSION, bookId: "local-book", input: {} },
      { origin: "https://example.com" },
      403,
      "origin_denied",
    ],
  ] as const) {
    const response = await http.fetch(
      new Request("http://127.0.0.1:4010/v1/book.get", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(status);
    expect((await response.json()).error.code).toBe(code);
  }
  const oversized = await http.fetch(
    new Request("http://127.0.0.1:4010/v1/book.get", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: " ".repeat(131073),
    }),
  );
  expect(oversized.status).toBe(413);
});

test("draft mutations retain exact results across retry, discard and service restart", async () => {
  const f = await fixture();
  const setupId = crypto.randomUUID();
  const firstSetup = await f.call("book.setup", book, setupId);
  const createId = crypto.randomUUID();
  const createInput = { data: opening };
  const draft = (await f.call("drafts.create", createInput, createId)).body.data;
  const saveId = crypto.randomUUID();
  const saveInput = {
    draftId: draft.id,
    expectedVersion: 1,
    data: { ...opening, reference: "EDITED" },
  };
  const saved = await f.call("drafts.save", saveInput, saveId);
  expect(saved.body.data.version).toBe(2);
  expect(
    (await f.call("drafts.save", { ...saveInput, data: opening }, saveId)).body.error.code,
  ).toBe("operation_identity_conflict");
  expect((await f.call("drafts.save", saveInput, crypto.randomUUID())).body.error.code).toBe(
    "draft_version_conflict",
  );
  const discardId = crypto.randomUUID();
  const discardInput = { draftId: draft.id, expectedVersion: 2 };
  const discarded = await f.call("drafts.discard", discardInput, discardId);
  await f.restart();
  expect(await f.call("book.setup", book, setupId)).toEqual(firstSetup);
  expect((await f.call("drafts.create", createInput, createId)).body.data).toEqual(draft);
  expect(await f.call("drafts.save", saveInput, saveId)).toEqual(saved);
  expect(await f.call("drafts.discard", discardInput, discardId)).toEqual(discarded);
  expect((await f.call("drafts.list")).body.data.count).toBe(0);
  expect((await f.call("operations.get", { operationId: createId })).body.data.result.id).toBe(
    draft.id,
  );
  expect(
    (
      await f.call(
        "accounts.prepareCreate",
        { code: "2000", name: "Payable", role: "liability", effectiveOn: "2026-01-01" },
        createId,
      )
    ).body.error.code,
  ).toBe("operation_identity_conflict");
});

test("preview changes no balances, commit is exact and lost response recovers after restart", async () => {
  const f = await fixture();
  await f.call("book.setup", book, crypto.randomUUID());
  const draft = (await f.call("drafts.create", { data: opening }, crypto.randomUUID())).body.data;
  const id = crypto.randomUUID();
  const plan = (await f.call("journal.prepare", { draftId: draft.id, expectedVersion: 1 }, id)).body
    .data;
  expect(plan.valid).toBe(true);
  expect(plan.effects.journals[0].lines[0].debit).toBe("1000.00");
  expect((await f.call("reports.get", { asOf: "2026-01-31" })).body.data.balanceSheet.assets).toBe(
    "0.00",
  );
  expect((await f.call("operations.get", { operationId: id })).body.data.disposition).toBe(
    "prepared",
  );
  expect(
    (await f.call("operations.commit", { planId: id, planHash: "0".repeat(64) })).body.error.code,
  ).toBe("plan_hash_conflict");
  // Caller loses the reply after the server has durably submitted the command.
  const commit = await f.call("operations.commit", { planId: id, planHash: plan.planHash });
  expect(commit.body.data.disposition).toBe("committed");
  await f.restart();
  expect((await f.call("operations.get", { operationId: id })).body.data.disposition).toBe(
    "committed",
  );
  expect(await f.call("operations.commit", { planId: id, planHash: plan.planHash })).toEqual(
    commit,
  );
  expect((await f.call("journal.list")).body.data.count).toBe(1);
  expect((await f.call("drafts.get", { draftId: draft.id })).body.data.status).toBe("posted");
  const report = (await f.call("reports.get", { asOf: "2026-01-31" })).body.data;
  expect(report.trialBalance.debit).toBe("1000.00");
  expect(report.balanceSheet.assets).toBe("1000.00");
});

test("commit rechecks draft version and kernel rejects a stale book plan without posting", async () => {
  const f = await fixture();
  await f.call("book.setup", book, crypto.randomUUID());
  const draft = (await f.call("drafts.create", { data: opening }, crypto.randomUUID())).body.data;
  const plan = (
    await f.call("journal.prepare", { draftId: draft.id, expectedVersion: 1 }, crypto.randomUUID())
  ).body.data;
  await f.call(
    "drafts.save",
    { draftId: draft.id, expectedVersion: 1, data: { ...opening, reference: "changed" } },
    crypto.randomUUID(),
  );
  expect(
    (await f.call("operations.commit", { planId: plan.planId, planHash: plan.planHash })).body.error
      .code,
  ).toBe("draft_version_conflict");
  const fresh = (
    await f.call("journal.prepare", { draftId: draft.id, expectedVersion: 2 }, crypto.randomUUID())
  ).body.data;
  const account = (
    await f.call(
      "accounts.prepareCreate",
      { code: "2000", name: "Payable", role: "liability", effectiveOn: "2026-01-01" },
      crypto.randomUUID(),
    )
  ).body.data;
  expect(
    (await f.call("operations.commit", { planId: account.planId, planHash: account.planHash })).body
      .data.disposition,
  ).toBe("committed");
  const stale = await f.call("operations.commit", {
    planId: fresh.planId,
    planHash: fresh.planHash,
  });
  expect(stale.body.data.disposition).toBe("rejected");
  expect(stale.body.data.problems.length).toBeGreaterThan(0);
  expect(
    (await f.call("operations.get", { operationId: fresh.planId })).body.data.disposition,
  ).toBe("rejected");
  expect((await f.call("journal.list", { status: "Posted" })).body.data.count).toBe(0);
});

test("business permissions are checked at preparation and for each recorded commit kind", async () => {
  const f = await fixture();
  await f.call("book.setup", book, crypto.randomUUID());
  expect(
    (await f.call("drafts.create", { data: opening }, crypto.randomUUID(), ["read"])).status,
  ).toBe(403);
  const account = (
    await f.call(
      "accounts.prepareCreate",
      { code: "2000", name: "Payable", role: "liability", effectiveOn: "2026-01-01" },
      crypto.randomUUID(),
    )
  ).body.data;
  expect(
    (
      await f.call(
        "operations.commit",
        { planId: account.planId, planHash: account.planHash },
        undefined,
        ["post"],
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await f.call(
        "operations.commit",
        { planId: account.planId, planHash: account.planHash },
        undefined,
        ["configure"],
      )
    ).body.data.disposition,
  ).toBe("committed");
  const period = (
    await f.call(
      "periods.prepare",
      { periodId: "period-01", operation: "close", reason: "Reviewed January" },
      crypto.randomUUID(),
    )
  ).body.data;
  expect(
    (
      await f.call(
        "operations.commit",
        { planId: period.planId, planHash: period.planHash },
        undefined,
        ["post", "configure"],
      )
    ).status,
  ).toBe(403);
});

test("earlier browser posting identities remain inspectable and replayable after migration", async () => {
  const f = await fixture();
  await f.call("book.setup", book, crypto.randomUUID());
  const draft = f.service.createDraft(opening);
  const legacy = await f.service.postDraft(draft.id);
  // Reproduce the earlier release: its command lived only on the draft row.
  const metadata = new Database(f.path);
  metadata.query("DELETE FROM app_actions WHERE id=?").run(draft.id);
  metadata.close();
  await f.restart();
  const saved = (await f.call("drafts.get", { draftId: draft.id })).body.data;
  expect(saved.postingOperationId).toBe(draft.id);
  expect(saved.outcomeSequence).toBe(legacy.outcomeSequence);
  const status = (await f.call("operations.get", { operationId: draft.id })).body.data;
  expect(status.disposition).toBe("committed");
  expect(
    (await f.call("operations.commit", { planId: draft.id, planHash: status.planHash })).body.data
      .outcomeSequence,
  ).toBe(legacy.outcomeSequence);
  expect((await f.call("journal.list")).body.data.count).toBe(1);
});

test("competing workflow families cannot claim one operation identity", async () => {
  const f = await fixture();
  await f.call("book.setup", book, crypto.randomUUID());
  const identity = crypto.randomUUID();
  const [account, draft] = await Promise.all([
    f.call(
      "accounts.prepareCreate",
      { code: "2000", name: "Payable", role: "liability", effectiveOn: "2026-01-01" },
      identity,
    ),
    f.call("drafts.create", { data: opening }, identity),
  ]);
  expect(draft.body.ok).toBe(true);
  expect(account.body.error.code).toBe("operation_identity_conflict");
  expect((await f.call("operations.get", { operationId: identity })).body.data.kind).toBe(
    "drafts.create",
  );
});

test("known figures, pinned drill-through, reversal and close/reopen share the contract", async () => {
  const f = await fixture();
  await f.call("book.setup", book, crypto.randomUUID());
  let expenseId = "";
  for (const data of [
    opening,
    {
      ...opening,
      reference: "SALE",
      lines: [
        { accountId: "1000", debit: "200.00", credit: "" },
        { accountId: "4000", debit: "", credit: "200.00" },
      ],
    },
    {
      ...opening,
      reference: "EXPENSE",
      lines: [
        { accountId: "5000", debit: "50.00", credit: "" },
        { accountId: "1000", debit: "", credit: "50.00" },
      ],
    },
  ]) {
    const draft = (await f.call("drafts.create", { data }, crypto.randomUUID())).body.data;
    const plan = (
      await f.call(
        "journal.prepare",
        { draftId: draft.id, expectedVersion: 1 },
        crypto.randomUUID(),
      )
    ).body.data;
    expect(
      (await f.call("operations.commit", { planId: plan.planId, planHash: plan.planHash })).body
        .data.disposition,
    ).toBe("committed");
    if (data.reference === "EXPENSE") expenseId = draft.id;
  }
  const report = (await f.call("reports.get", { asOf: "2026-01-31" })).body.data;
  expect(report.balanceSheet.assets).toBe("1150.00");
  expect(report.profitAndLoss.netIncome).toBe("150.00");
  const scope = {
    accountId: "1000",
    asOf: report.asOf,
    revision: report.bookRevision,
    populationHash: report.populationHash,
    from: "2026-01-01",
    to: "2026-01-31",
  };
  const reversal = (
    await f.call(
      "journal.prepareReverse",
      { journalId: expenseId, accountingDate: "2026-01-17", reason: "Entered in error" },
      crypto.randomUUID(),
    )
  ).body.data;
  expect(
    (await f.call("operations.commit", { planId: reversal.planId, planHash: reversal.planHash }))
      .body.data.disposition,
  ).toBe("committed");
  expect((await f.call("activity.get", scope)).body.data.closingBalance).toBe("1150.00");
  expect(
    (await f.call("journal.get", { journalId: expenseId })).body.data.correction
      .correctionJournalId,
  ).toBe(reversal.planId);
  const corrected = (await f.call("reports.get", { asOf: "2026-01-31" })).body.data;
  expect(corrected.balanceSheet.assets).toBe("1200.00");
  expect(corrected.profitAndLoss.netIncome).toBe("200.00");
  const close = (
    await f.call(
      "periods.prepare",
      { periodId: "period-01", operation: "close", reason: "Reviewed" },
      crypto.randomUUID(),
    )
  ).body.data;
  await f.call("operations.commit", { planId: close.planId, planHash: close.planHash });
  expect((await f.call("periods.list")).body.data.periods[0].status).toBe("closed");
  const draft = (await f.call("drafts.create", { data: opening }, crypto.randomUUID())).body.data;
  const rejected = (
    await f.call("journal.prepare", { draftId: draft.id, expectedVersion: 1 }, crypto.randomUUID())
  ).body.data;
  expect(rejected.valid).toBe(false);
  expect(rejected.problems.length).toBeGreaterThan(0);
  expect(
    (await f.call("operations.commit", { planId: rejected.planId, planHash: rejected.planHash }))
      .body.data.disposition,
  ).toBe("rejected");
  const reopen = (
    await f.call(
      "periods.prepare",
      { periodId: "period-01", operation: "reopen", reason: "Late evidence" },
      crypto.randomUUID(),
    )
  ).body.data;
  expect(
    (await f.call("operations.commit", { planId: reopen.planId, planHash: reopen.planHash })).body
      .data.disposition,
  ).toBe("committed");
  expect((await f.call("periods.list")).body.data.periods[0].status).toBe("open");
});

async function rejectedDraftFixture() {
  const f = await fixture();
  await f.call("book.setup", book, crypto.randomUUID());
  const draft = (await f.call("drafts.create", { data: opening }, crypto.randomUUID())).body.data;
  const plan = (
    await f.call("journal.prepare", { draftId: draft.id, expectedVersion: 1 }, crypto.randomUUID())
  ).body.data;
  const other = (
    await f.call(
      "accounts.prepareCreate",
      { code: "1100", name: "Savings", role: "asset", effectiveOn: "2026-01-01" },
      crypto.randomUUID(),
    )
  ).body.data;
  await f.call("operations.commit", { planId: other.planId, planHash: other.planHash });
  const commitInput = { planId: plan.planId, planHash: plan.planHash };
  const rejected = await f.call("operations.commit", commitInput);
  expect(rejected.body.data.disposition).toBe("rejected");
  return {
    f,
    draft,
    plan,
    commitInput,
    rejected,
    recoveryInput: { draftId: draft.id, expectedVersion: 1, postingOperationId: plan.planId },
  };
}

test("rejected drafts recover once at a new version while old outcomes remain immutable", async () => {
  const { f, draft, plan, commitInput, rejected, recoveryInput } = await rejectedDraftFixture();
  const originalStatus = await f.call("operations.get", { operationId: plan.planId });
  const recoveryId = crypto.randomUUID();
  expect((await f.call("drafts.recover", recoveryInput, recoveryId, ["read"])).status).toBe(403);
  const recovered = await f.call("drafts.recover", recoveryInput, recoveryId, ["read", "draft"]);
  expect(recovered.status).toBe(200);
  expect(recovered.body.data).toEqual({
    id: draft.id,
    version: 2,
    status: "draft",
    data: opening,
    recoveredFromOperationId: plan.planId,
  });
  expect((await f.call("reports.get", { asOf: "2026-01-31" })).body.data.balanceSheet.assets).toBe(
    "0.00",
  );
  expect(await f.call("operations.commit", commitInput)).toEqual(rejected);
  expect(await f.call("operations.get", { operationId: plan.planId })).toEqual(originalStatus);
  expect((await f.call("drafts.get", { draftId: draft.id })).body.data.status).toBe("draft");
  await f.restart();
  expect(await f.call("drafts.recover", recoveryInput, recoveryId)).toEqual(recovered);
  const fresh = (
    await f.call("journal.prepare", { draftId: draft.id, expectedVersion: 2 }, crypto.randomUUID())
  ).body.data;
  expect(fresh.valid).toBe(true);
  expect(fresh.planHash).not.toBe(plan.planHash);
  expect(
    (
      await f.call(
        "operations.commit",
        { planId: fresh.planId, planHash: fresh.planHash },
        undefined,
        ["read", "draft"],
      )
    ).status,
  ).toBe(403);
  expect(
    (await f.call("operations.commit", { planId: fresh.planId, planHash: fresh.planHash })).body
      .data.disposition,
  ).toBe("committed");
  expect(await f.call("operations.commit", commitInput)).toEqual(rejected);
  expect((await f.call("drafts.get", { draftId: draft.id })).body.data).toMatchObject({
    status: "posted",
    version: 2,
    postingOperationId: fresh.planId,
  });
  expect((await f.call("reports.get", { asOf: "2026-01-31" })).body.data.balanceSheet.assets).toBe(
    "1000.00",
  );
  expect((await f.call("journal.list", { status: "Posted" })).body.data.count).toBe(1);
  expect(await f.call("drafts.recover", recoveryInput, recoveryId)).toEqual(recovered);
  expect((await f.call("operations.get", { operationId: recoveryId })).body.data.result).toEqual(
    recovered.body.data,
  );
  await f.restart();
  expect(await f.call("operations.commit", commitInput)).toEqual(rejected);
  expect(await f.call("operations.get", { operationId: plan.planId })).toEqual(originalStatus);
});

test("competing recovery requests cannot reopen a draft twice or cross draft ownership", async () => {
  const { f, draft, recoveryInput, rejected, commitInput } = await rejectedDraftFixture();
  const other = (await f.call("drafts.create", { data: opening }, crypto.randomUUID())).body.data;
  expect(
    (await f.call("drafts.recover", { ...recoveryInput, draftId: other.id }, crypto.randomUUID()))
      .body.error.code,
  ).toBe("draft_operation_conflict");
  const attempts = await Promise.all([
    f.call("drafts.recover", recoveryInput, crypto.randomUUID()),
    f.call("drafts.recover", recoveryInput, crypto.randomUUID()),
  ]);
  expect(attempts.map((result) => result.status).sort()).toEqual([200, 409]);
  const success = attempts.find((result) => result.status === 200);
  if (!success) throw new Error("No recovery succeeded");
  expect((await f.call("drafts.get", { draftId: draft.id })).body.data.version).toBe(2);
  expect(
    (
      await f.call(
        "drafts.recover",
        { ...recoveryInput, draftId: other.id },
        success.body.operationId,
      )
    ).status,
  ).toBe(409);
  await f.call("drafts.discard", { draftId: draft.id, expectedVersion: 2 }, crypto.randomUUID());
  expect(await f.call("operations.commit", commitInput)).toEqual(rejected);
  expect(await f.call("drafts.recover", recoveryInput, success.body.operationId)).toEqual(success);
  expect((await f.call("drafts.get", { draftId: other.id })).body.data.version).toBe(1);
});

test("uncertain postings cannot be recovered; durable rejection repairs a lost product update", async () => {
  const f = await fixture();
  await f.call("book.setup", book, crypto.randomUUID());
  const draft = (await f.call("drafts.create", { data: opening }, crypto.randomUUID())).body.data;
  const plan = (
    await f.call("journal.prepare", { draftId: draft.id, expectedVersion: 1 }, crypto.randomUUID())
  ).body.data;
  const recoveryInput = { draftId: draft.id, expectedVersion: 1, postingOperationId: plan.planId };
  const commitInput = { planId: plan.planId, planHash: plan.planHash };
  expect((await f.call("drafts.recover", recoveryInput, crypto.randomUUID())).body.error.code).toBe(
    "draft_recovery_unavailable",
  );
  const execute = f.service.ledger.execute.bind(f.service.ledger);
  f.service.ledger.execute = async () => {
    throw new Error("Unavailable before admission");
  };
  expect((await f.call("operations.commit", commitInput)).body.error.code).toBe(
    "operation_unresolved",
  );
  expect((await f.call("operations.get", { operationId: plan.planId })).body.data.disposition).toBe(
    "unresolved",
  );
  expect((await f.call("drafts.recover", recoveryInput, crypto.randomUUID())).body.error.code).toBe(
    "draft_recovery_unavailable",
  );
  f.service.ledger.execute = execute;
  // Advance the book so retry of the exact retained command must be rejected.
  const change = (
    await f.call(
      "accounts.prepareCreate",
      { code: "1100", name: "Savings", role: "asset", effectiveOn: "2026-01-01" },
      crypto.randomUUID(),
    )
  ).body.data;
  await f.call("operations.commit", { planId: change.planId, planHash: change.planHash });
  f.service.ledger.execute = async (...args) => {
    await execute(...args);
    throw new Error("Reply lost after ledger admission");
  };
  expect((await f.call("operations.commit", commitInput)).body.error.code).toBe(
    "operation_unresolved",
  );
  expect((await f.call("drafts.get", { draftId: draft.id })).body.data.status).toBe("posting");
  f.service.ledger.execute = execute;
  await f.restart();
  expect(
    (await f.call("drafts.recover", recoveryInput, crypto.randomUUID())).body.data,
  ).toMatchObject({ status: "draft", version: 2 });
  const original = await f.call("operations.commit", commitInput);
  expect(original.body.data.disposition).toBe("rejected");
  expect((await f.call("drafts.get", { draftId: draft.id })).body.data.status).toBe("draft");
});

test("a committed posting with a lost update cannot reopen and retry reconciles its original receipt", async () => {
  const f = await fixture();
  await f.call("book.setup", book, crypto.randomUUID());
  const draft = (await f.call("drafts.create", { data: opening }, crypto.randomUUID())).body.data;
  const plan = (
    await f.call("journal.prepare", { draftId: draft.id, expectedVersion: 1 }, crypto.randomUUID())
  ).body.data;
  const execute = f.service.ledger.execute.bind(f.service.ledger);
  f.service.ledger.execute = async (...args) => {
    await execute(...args);
    throw new Error("Lost update");
  };
  const input = { planId: plan.planId, planHash: plan.planHash };
  expect((await f.call("operations.commit", input)).status).toBe(503);
  f.service.ledger.execute = execute;
  await f.restart();
  expect(
    (
      await f.call(
        "drafts.recover",
        { draftId: draft.id, expectedVersion: 1, postingOperationId: plan.planId },
        crypto.randomUUID(),
      )
    ).body.error.code,
  ).toBe("draft_recovery_unavailable");
  const first = await f.call("operations.commit", input);
  expect(first.body.data.disposition).toBe("committed");
  expect((await f.call("drafts.get", { draftId: draft.id })).body.data.status).toBe("posted");
  expect(await f.call("operations.commit", input)).toEqual(first);
  expect((await f.call("journal.list", { status: "Posted" })).body.data.count).toBe(1);
  expect((await f.call("reports.get", { asOf: "2026-01-31" })).body.data.balanceSheet.assets).toBe(
    "1000.00",
  );
});

test("a damaged application plan cannot claim a different command's durable receipt", async () => {
  const f = await fixture();
  await f.call("book.setup", book, crypto.randomUUID());
  const draft = (await f.call("drafts.create", { data: opening }, crypto.randomUUID())).body.data;
  const plan = (
    await f.call("journal.prepare", { draftId: draft.id, expectedVersion: 1 }, crypto.randomUUID())
  ).body.data;
  const committed = await f.call("operations.commit", {
    planId: plan.planId,
    planHash: plan.planHash,
  });
  const db = new Database(f.path);
  try {
    const original = db
      .query("SELECT sealed_command FROM app_actions WHERE id=?")
      .get(plan.planId) as { sealed_command: string };
    const decoded = decodeBookCommand(original.sealed_command);
    if (decoded.disposition !== "decoded") throw new Error("Fixture command is invalid");
    const changed = encodeBookCommand(
      sealCommand({ ...decoded.command, expectedBookRevision: 999n }),
    );
    const changedHash = hashCanonical({
      type: "ApplicationPostingPlan",
      id: plan.planId,
      encoded: changed,
    }).digest;
    db.query("UPDATE app_actions SET sealed_command=? WHERE id=?").run(changed, plan.planId);
    await expect(f.service.operation(plan.planId)).rejects.toThrow(
      "conflicts with its durable outcome",
    );
    await expect(f.service.commitAction(plan.planId, changedHash)).rejects.toThrow(
      "conflicts with its durable outcome",
    );
    expect(
      (await f.call("reports.get", { asOf: "2026-01-31" })).body.data.balanceSheet.assets,
    ).toBe("1000.00");
    db.query("UPDATE app_actions SET sealed_command=? WHERE id=?").run(
      original.sealed_command,
      plan.planId,
    );
    expect(
      await f.call("operations.commit", { planId: plan.planId, planHash: plan.planHash }),
    ).toEqual(committed);
  } finally {
    db.close();
  }
});

const identifiedOpening = {
  ...opening,
  source: {
    id: "owner-contribution-001",
    description: "Owner contributed USD 1000 on 2026-01-15",
    evidenceReference: "receipt-001",
  },
};
async function sourcePlan(f: Awaited<ReturnType<typeof fixture>>, data = identifiedOpening) {
  const created = await f.call("drafts.create", { data }, crypto.randomUUID());
  expect(created.status).toBe(200);
  const draft = created.body.data;
  const prepared = await f.call(
    "journal.prepare",
    { draftId: draft.id, expectedVersion: draft.version },
    crypto.randomUUID(),
  );
  expect(prepared.status).toBe(200);
  return { draft, plan: prepared.body.data };
}
const planInput = (plan: { planId: string; planHash: string }) => ({
  planId: plan.planId,
  planHash: plan.planHash,
});

test("source facts are immutable, book scoped and separate from editable accounting and freeform references", async () => {
  const f = await fixture();
  await f.call("book.setup", book, crypto.randomUUID());
  const operationId = crypto.randomUUID();
  const created = await f.call("drafts.create", { data: identifiedOpening }, operationId);
  const draft = created.body.data;
  expect(await f.call("drafts.create", { data: identifiedOpening }, operationId)).toEqual(created);
  const second = await f.call("drafts.create", { data: identifiedOpening }, crypto.randomUUID());
  expect(second.body.data.id).not.toBe(draft.id);
  expect(second.body.data.journalId).toBe(draft.journalId);
  const conflicting = {
    ...identifiedOpening,
    source: { ...identifiedOpening.source, description: "Owner contributed USD 2000" },
  };
  expect(
    (await f.call("drafts.create", { data: conflicting }, crypto.randomUUID())).body.error.code,
  ).toBe("source_identity_conflict");
  expect(
    (
      await f.call(
        "drafts.save",
        { draftId: draft.id, expectedVersion: 1, data: conflicting },
        crypto.randomUUID(),
      )
    ).body.error.code,
  ).toBe("source_identity_conflict");
  const edited = {
    ...identifiedOpening,
    date: "2026-01-16",
    narration: "Revised accounting proposal",
  };
  expect(
    (
      await f.call(
        "drafts.save",
        { draftId: draft.id, expectedVersion: 1, data: edited },
        crypto.randomUUID(),
      )
    ).body.data.version,
  ).toBe(2);
  expect(
    (await f.call("drafts.create", { data: identifiedOpening }, crypto.randomUUID(), ["read"]))
      .status,
  ).toBe(403);
  expect(
    (await f.call("sources.get", { sourceId: identifiedOpening.source.id }, undefined, ["draft"]))
      .status,
  ).toBe(403);
  const source = (
    await f.call("sources.get", { sourceId: identifiedOpening.source.id }, undefined, ["read"])
  ).body.data;
  expect(source).toMatchObject({
    source: identifiedOpening.source,
    status: "unposted",
    journalId: draft.journalId,
    drafts: { count: 2 },
  });
  expect(source.contentHash).toMatch(/^[0-9a-f]{64}$/);
  expect((await f.call("sources.list", { text: "owner-contribution" })).body.data.count).toBe(1);
  expect((await f.call("sources.list", { text: "%" })).body.data.count).toBe(0);
  // Registration is rolled back when a draft edit loses its version race.
  const newSource = {
    ...identifiedOpening,
    source: { id: "not-retained", description: "New source" },
  };
  expect(
    (
      await f.call(
        "drafts.save",
        { draftId: draft.id, expectedVersion: 1, data: newSource },
        crypto.randomUUID(),
      )
    ).status,
  ).not.toBe(200);
  expect((await f.call("sources.get", { sourceId: "not-retained" })).status).toBe(404);
  const isolated = await fixture();
  await isolated.call("book.setup", book, crypto.randomUUID());
  expect(
    (await isolated.call("drafts.create", { data: conflicting }, crypto.randomUUID())).status,
  ).toBe(200);
  // The display reference does not assert source identity.
  expect((await f.call("drafts.create", { data: opening }, crypto.randomUUID())).status).toBe(200);
  expect((await f.call("drafts.create", { data: opening }, crypto.randomUUID())).status).toBe(200);
  await f.restart();
  expect(
    (await f.call("sources.get", { sourceId: identifiedOpening.source.id })).body.data.source,
  ).toEqual(identifiedOpening.source);
});

test("competing source proposals produce one posting and pinned provenance survives a linked reversal", async () => {
  const f = await fixture();
  await f.call("book.setup", book, crypto.randomUUID());
  const a = await sourcePlan(f),
    b = await sourcePlan(f);
  expect(a.plan.effects.journals[0].id).toBe(b.plan.effects.journals[0].id);
  const results = await Promise.all([
    f.call("operations.commit", planInput(a.plan)),
    f.call("operations.commit", planInput(b.plan)),
  ]);
  expect(results.map((item) => item.status).sort()).toEqual([200, 409]);
  const winner = results[0].status === 200 ? a : b;
  const receipt = results.find((item) => item.status === 200);
  if (!receipt) throw new Error("No source posting succeeded");
  expect(receipt.body.data.disposition).toBe("committed");
  const source = (await f.call("sources.get", { sourceId: identifiedOpening.source.id })).body.data;
  expect(source).toMatchObject({
    status: "posted",
    postingOperationId: winner.plan.planId,
    journalId: winner.draft.journalId,
  });
  const reports = (await f.call("reports.get", { asOf: "2026-01-31" })).body.data;
  expect(reports.balanceSheet.assets).toBe("1000.00");
  const journal = (
    await f.call("journal.get", { journalId: source.journalId, revision: reports.bookRevision })
  ).body.data;
  expect(journal.source).toEqual({
    id: identifiedOpening.source.id,
    contentHash: source.contentHash,
    originalJournalId: source.journalId,
  });
  expect((await f.call("journal.list", { status: "Posted" })).body.data.entries[0].reference).toBe(
    opening.reference,
  );
  const reverse = (
    await f.call(
      "journal.prepareReverse",
      {
        journalId: source.journalId,
        accountingDate: "2026-01-20",
        reason: "Contribution returned",
      },
      crypto.randomUUID(),
    )
  ).body.data;
  expect((await f.call("operations.commit", planInput(reverse))).body.data.disposition).toBe(
    "committed",
  );
  const corrected = (await f.call("sources.get", { sourceId: identifiedOpening.source.id })).body
    .data;
  expect(corrected.status).toBe("posted");
  expect(corrected.corrections).toHaveLength(1);
  const reversal = (
    await f.call("journal.get", { journalId: corrected.corrections[0].correctionJournalId })
  ).body.data;
  expect(reversal.source).toEqual(journal.source);
  expect(
    (await f.call("journal.get", { journalId: source.journalId, revision: reports.bookRevision }))
      .body.data,
  ).toEqual(journal);
  const newDraft = (await f.call("drafts.create", { data: identifiedOpening }, crypto.randomUUID()))
    .body.data;
  expect(
    (
      await f.call(
        "journal.prepare",
        { draftId: newDraft.id, expectedVersion: 1 },
        crypto.randomUUID(),
      )
    ).body.error.code,
  ).toBe("source_already_posted");
  expect(await f.call("operations.commit", planInput(winner.plan))).toEqual(receipt);
  expect((await f.call("reports.get", { asOf: "2026-01-31" })).body.data.balanceSheet.assets).toBe(
    "0.00",
  );
});

test("uncertain source claims block replacements, rejected attempts permit fresh review and retain old receipts", async () => {
  const f = await fixture();
  await f.call("book.setup", book, crypto.randomUUID());
  const a = await sourcePlan(f),
    b = await sourcePlan(f);
  const execute = f.service.ledger.execute.bind(f.service.ledger);
  f.service.ledger.execute = async () => {
    throw new Error("Unavailable before admission");
  };
  expect((await f.call("operations.commit", planInput(a.plan))).status).toBe(503);
  expect((await f.call("operations.commit", planInput(b.plan))).body.error.code).toBe(
    "source_posting_unresolved",
  );
  expect(
    (await f.call("sources.get", { sourceId: identifiedOpening.source.id })).body.data.status,
  ).toBe("posting");
  f.service.ledger.execute = execute;
  await f.restart();
  expect((await f.call("operations.commit", planInput(b.plan))).body.error.code).toBe(
    "source_posting_unresolved",
  );
  // A configuration change makes the original command stale, with a durable rejection.
  const account = (
    await f.call(
      "accounts.prepareCreate",
      { code: "1100", name: "Savings", role: "asset", effectiveOn: "2026-01-01" },
      crypto.randomUUID(),
    )
  ).body.data;
  await f.call("operations.commit", planInput(account));
  const rejected = await f.call("operations.commit", planInput(a.plan));
  expect(rejected.body.data.disposition).toBe("rejected");
  expect(
    (await f.call("sources.get", { sourceId: identifiedOpening.source.id })).body.data.status,
  ).toBe("rejected");
  const recovered = (
    await f.call(
      "drafts.recover",
      { draftId: a.draft.id, expectedVersion: 1, postingOperationId: a.plan.planId },
      crypto.randomUUID(),
    )
  ).body.data;
  const fresh = (
    await f.call(
      "journal.prepare",
      { draftId: recovered.id, expectedVersion: recovered.version },
      crypto.randomUUID(),
    )
  ).body.data;
  const executeAfterRestart = f.service.ledger.execute.bind(f.service.ledger);
  f.service.ledger.execute = async (...args) => {
    await executeAfterRestart(...args);
    throw new Error("Reply lost after admission");
  };
  expect((await f.call("operations.commit", planInput(fresh))).status).toBe(503);
  expect((await f.call("operations.commit", planInput(b.plan))).body.error.code).toBe(
    "source_already_posted",
  );
  f.service.ledger.execute = executeAfterRestart;
  await f.restart();
  expect((await f.call("operations.commit", planInput(fresh))).body.data.disposition).toBe(
    "committed",
  );
  expect(await f.call("operations.commit", planInput(a.plan))).toEqual(rejected);
  expect((await f.call("drafts.get", { draftId: a.draft.id })).body.data).toMatchObject({
    status: "posted",
    version: 2,
    data: identifiedOpening,
  });
  expect((await f.call("reports.get", { asOf: "2026-01-31" })).body.data.balanceSheet.assets).toBe(
    "1000.00",
  );
});

test("retained journal identity prevents duplicate effects even when the product source claim is lost", async () => {
  const f = await fixture();
  await f.call("book.setup", book, crypto.randomUUID());
  const a = await sourcePlan(f),
    b = await sourcePlan(f);
  await f.call("operations.commit", planInput(a.plan));
  const db = new Database(f.path);
  try {
    db.query("UPDATE app_sources SET posting_operation_id=NULL").run();
    const original = db
      .query("SELECT sealed_command FROM app_actions WHERE id=?")
      .get(b.plan.planId) as { sealed_command: string };
    const decoded = decodeBookCommand(original.sealed_command);
    if (decoded.disposition !== "decoded") throw new Error("Invalid test command");
    const revision = BigInt(
      (await f.call("reports.get", { asOf: "2026-01-31" })).body.data.bookRevision,
    );
    // Simulate a fresh command against the current revision, rather than rely on a stale-revision rejection.
    const changed = encodeBookCommand(
      sealCommand({ ...decoded.command, expectedBookRevision: revision }),
    );
    db.query("UPDATE app_actions SET sealed_command=? WHERE id=?").run(changed, b.plan.planId);
    const changedHash = hashCanonical({
      type: "ApplicationPostingPlan",
      id: b.plan.planId,
      encoded: changed,
    }).digest;
    const rejected = await f.call("operations.commit", {
      planId: b.plan.planId,
      planHash: changedHash,
    });
    expect(rejected.body.data.disposition).toBe("rejected");
    expect(
      rejected.body.data.problems.some(
        (item: { code: string }) => item.code === "canonical_identity_conflict",
      ),
    ).toBe(true);
    expect(
      (await f.call("sources.get", { sourceId: identifiedOpening.source.id })).body.data
        .postingOperationId,
    ).toBe(a.plan.planId);
    expect((await f.call("journal.list", { status: "Posted" })).body.data.count).toBe(1);
    expect(
      (await f.call("reports.get", { asOf: "2026-01-31" })).body.data.balanceSheet.assets,
    ).toBe("1000.00");
    const newDraft = (
      await f.call("drafts.create", { data: identifiedOpening }, crypto.randomUUID())
    ).body.data;
    expect(
      (
        await f.call(
          "journal.prepare",
          { draftId: newDraft.id, expectedVersion: 1 },
          crypto.randomUUID(),
        )
      ).body.error.code,
    ).toBe("source_already_posted");
  } finally {
    db.close();
  }
});

test("independent service connections serialize source posting claims on one book", async () => {
  const f = await fixture();
  await f.call("book.setup", book, crypto.randomUUID());
  const a = await sourcePlan(f),
    b = await sourcePlan(f);
  const peer = await LocalBookService.open(f.path);
  try {
    const attempts = await Promise.allSettled([
      f.service.commitAction(a.plan.planId, a.plan.planHash),
      peer.commitAction(b.plan.planId, b.plan.planHash),
    ]);
    expect(attempts.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const failed = attempts.find((item) => item.status === "rejected");
    if (failed?.status !== "rejected") throw new Error("No competing source was blocked");
    expect([
      "source_claim_conflict",
      "source_posting_unresolved",
      "source_already_posted",
    ]).toContain(failed.reason.code);
    expect((await f.call("journal.list", { status: "Posted" })).body.data.count).toBe(1);
    expect(
      (await f.call("reports.get", { asOf: "2026-01-31" })).body.data.balanceSheet.assets,
    ).toBe("1000.00");
  } finally {
    peer.close();
  }
});

test("sources and linked drafts retain bounded pagination without financial effects", async () => {
  const f = await fixture();
  await f.call("book.setup", book, crypto.randomUUID());
  for (let index = 0; index < 27; index++) {
    await f.call("drafts.create", { data: identifiedOpening }, crypto.randomUUID());
    await f.call(
      "drafts.create",
      {
        data: {
          ...identifiedOpening,
          source: { id: `batch-receipt-${index}`, description: `Receipt ${index}` },
        },
      },
      crypto.randomUUID(),
    );
  }
  const first = (await f.call("sources.get", { sourceId: identifiedOpening.source.id })).body.data;
  const next = (await f.call("sources.get", { sourceId: identifiedOpening.source.id, page: 2 }))
    .body.data;
  expect(first.drafts).toMatchObject({ count: 27, page: 1, pageSize: 25 });
  expect(first.drafts.drafts).toHaveLength(25);
  expect(next.drafts.drafts).toHaveLength(2);
  expect(
    new Set([...first.drafts.drafts, ...next.drafts.drafts].map((item: { id: string }) => item.id))
      .size,
  ).toBe(27);
  const page = (await f.call("sources.list", { text: "batch-receipt-" })).body.data;
  expect(page.count).toBe(27);
  expect(page.sources).toHaveLength(25);
  expect(
    (await f.call("sources.list", { text: "batch-receipt-", page: 2 })).body.data.sources,
  ).toHaveLength(2);
  expect(
    (await f.call("sources.get", { sourceId: identifiedOpening.source.id, page: 0 })).status,
  ).toBe(400);
  expect((await f.call("reports.get", { asOf: "2026-01-31" })).body.data.balanceSheet.assets).toBe(
    "0.00",
  );
});

test("damaged source metadata fails closed without rewriting journal provenance or retained receipts", async () => {
  const f = await fixture();
  await f.call("book.setup", book, crypto.randomUUID());
  const { draft, plan } = await sourcePlan(f);
  const receipt = await f.call("operations.commit", planInput(plan));
  const original = (await f.call("sources.get", { sourceId: identifiedOpening.source.id })).body
    .data;
  const journal = (await f.call("journal.get", { journalId: draft.journalId })).body.data;
  const db = new Database(f.path);
  try {
    const changed = { ...identifiedOpening.source, description: "Different source facts" };
    db.query("UPDATE app_sources SET body=? WHERE id=?").run(JSON.stringify(changed), changed.id);
    expect((await f.call("sources.get", { sourceId: changed.id })).body.error.code).toBe(
      "source_record_corrupt",
    );
    db.query("UPDATE app_sources SET content_hash=? WHERE id=?").run(
      hashCanonical(changed).digest,
      changed.id,
    );
    expect((await f.call("sources.get", { sourceId: changed.id })).body.error.code).toBe(
      "source_identity_conflict",
    );
    expect(await f.call("operations.commit", planInput(plan))).toEqual(receipt);
    expect((await f.call("journal.get", { journalId: draft.journalId })).body.data).toEqual(
      journal,
    );
    expect(
      (await f.call("reports.get", { asOf: "2026-01-31" })).body.data.balanceSheet.assets,
    ).toBe("1000.00");
    db.query("UPDATE app_sources SET body=?, content_hash=? WHERE id=?").run(
      JSON.stringify(original.source),
      original.contentHash,
      original.source.id,
    );
    expect((await f.call("sources.get", { sourceId: original.source.id })).body.data).toEqual(
      original,
    );
  } finally {
    db.close();
  }
});
