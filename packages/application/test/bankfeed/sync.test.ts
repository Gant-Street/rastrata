import { afterEach, expect, test } from "bun:test";
import { ingestPort } from "../../src/slices/ingest/port.ts";
import { configureBankfeedRuntime } from "../../src/slices/bankfeed/runtime.ts";
import { DAY, NOW, checking, day, savings } from "./fake-bridge.ts";
import {
  DAY_MS,
  HOUR,
  type World,
  advance,
  chartIds,
  closeWorlds,
  idsOf,
  linkByCode,
  lines,
  uuid,
  world,
} from "./support.ts";

afterEach(closeWorlds);

const sync = (w: World, input: Record<string, unknown> = {}, operationId = uuid()) =>
  w.call("bankfeed.sync", input, operationId);

async function connectedAndLinked(
  options: Parameters<typeof world>[0] = {},
  startOn = "2026-09-01",
) {
  const w = await world({ connected: true, ...options });
  await linkByCode(w, "ACT-checking-0001", "1000", startOn);
  return w;
}

test("a first sync queues every posted transaction of a linked account in the Inbox and posts nothing", async () => {
  const w = await connectedAndLinked();
  const reply = await sync(w);
  expect(reply.status).toBe(200);
  const data = reply.body.data;
  expect(data).toMatchObject({ more: false, paused: null });
  expect(data.run).toMatchObject({
    disposition: "complete",
    trigger: "manual",
    accounts: 1,
    newLines: 5,
    duplicateLines: 0,
  });
  expect(data.accounts).toEqual([
    {
      accountId: "ACT-checking-0001",
      name: "Business Checking",
      ledgerAccountId: "1000",
      state: "complete",
      windows: 1,
      newLines: 5,
      duplicateLines: 0,
      pendingSkipped: 0,
      heldLines: 0,
      through: "2026-10-04",
      message: null,
    },
  ]);
  expect(data.run.notes[0]).toContain(
    "5 lines queued in the Inbox for review. Nothing was posted.",
  );

  const items = await lines(w);
  expect(
    items.map((i) => [i.line.providerId, i.line.date, i.line.amount, i.status]).sort(),
  ).toEqual(
    [
      ["T-1001", "2026-09-28", "-12.50", "new"],
      ["T-1002", "2026-09-29", "2500.00", "new"],
      // "RENT SEPT": the starter list knows rent, so this line arrives with a suggestion (not decided, not
      // posted); the others are not known and arrive as they came.
      ["T-1003", "2026-09-30", "-1200.00", "proposed"],
      ["T-1004", "2026-10-01", "-45.15", "new"],
      ["T-1005", "2026-10-02", "-19.00", "new"],
    ].sort(),
  );
  const first = items.find((i) => i.line.providerId === "T-1001");
  expect(first?.line).toMatchObject({
    kind: "bankLine",
    provider: "simplefin",
    accountKey: "simplefin:ACT-checking-0001",
    currency: "USD",
    description: "COFFEE SHOP 0042",
    counterparty: "Coffee Shop",
  });
  // The lines wait in the Inbox for a person: no draft, no journal.
  expect((await w.ok("journal.list", { page: 1 })).count).toBe(0);
  expect((await w.ok("drafts.list", { page: 1 })).count ?? 0).toBe(0);
});

test("the exact bytes the Bridge sent are archived and each line points back to them", async () => {
  const w = await connectedAndLinked();
  await sync(w);
  const [item] = await lines(w, { text: "COFFEE" });
  const detail = await w.ok("inbox.get", { itemId: item?.id });
  expect(detail.provenance).toMatchObject({
    provider: "simplefin",
    accountKey: "simplefin:ACT-checking-0001",
    rawMediaType: "application/json",
  });
  expect(detail.provenance.rawName).toMatch(/^simplefin-[0-9a-f]{8}-2026-09-01-2026-10-04\.json$/);
  const archived = ingestPort(w.service).readArchive(detail.provenance.rawSha256);
  expect(archived).not.toBeNull();
  const body = JSON.parse(new TextDecoder().decode(archived?.bytes));
  expect(body.accounts[0].id).toBe("ACT-checking-0001");
  expect(body.accounts[0].transactions).toHaveLength(5);
  // The line's own raw text is the transaction object as received.
  expect(JSON.parse(detail.provenance.excerpt).id).toBe("T-1001");
});

test("reading again adds nothing, and a transaction the bank posts late is found by the overlap", async () => {
  const w = await connectedAndLinked();
  await sync(w);
  advance(w, 2 * HOUR);
  const again = (await sync(w)).body.data;
  expect(again.run).toMatchObject({ newLines: 0 });
  expect(again.run.duplicateLines).toBeGreaterThan(0);
  expect((await lines(w)).length).toBe(5);

  // Two days on, the bank shows a new transaction, and one it posted late with an older date.
  advance(w, 2 * DAY_MS);
  const account = w.bridge.accounts[0];
  account?.transactions?.push(
    { id: "T-1006", posted: NOW + DAY, amount: "-30.00", description: "NEW" },
    {
      id: "T-LATE",
      posted: NOW - 3 * DAY,
      amount: "-7.00",
      description: "POSTED LATE, DATED 1 OCT",
    },
  );
  const third = (await sync(w)).body.data;
  expect(third.run.newLines).toBe(2);
  expect(await idsOf(w)).toEqual([
    "T-1001",
    "T-1002",
    "T-1003",
    "T-1004",
    "T-1005",
    "T-1006",
    "T-LATE",
  ]);
});

test("a retried sync under the same identity is the first answer and asks the Bridge nothing more", async () => {
  const w = await connectedAndLinked();
  const operationId = uuid();
  const first = await sync(w, {}, operationId);
  const asked = w.bridge.log.length;
  const again = await sync(w, {}, operationId);
  expect(again.body).toEqual(first.body);
  expect(w.bridge.log).toHaveLength(asked);
  expect((await lines(w)).length).toBe(5);
});

test("an account is read only from its first day, and earlier lines are set aside, visibly, never dropped", async () => {
  const w = await connectedAndLinked({}, "2026-10-01");
  await sync(w);
  // The Bridge was asked from the first day on, so older transactions were not even requested.
  const asked = w.bridge.requests("accounts").filter((r) => r.query.account);
  expect(Number(asked[0]?.query["start-date"]?.[0])).toBe(day("2026-10-01", 0));
  expect(await idsOf(w)).toEqual(["T-1004", "T-1005"]);
  // A server that sends older lines anyway: the pipeline sets them aside with the reason.
  w.bridge.sloppy.ignoreStart = true;
  advance(w, HOUR);
  await sync(w);
  const aside = await lines(w, { exclusion: "before_cutover" });
  expect(aside.map((i) => i.line.providerId).sort()).toEqual(["T-1001", "T-1002", "T-1003"]);
  expect(aside.every((i) => i.status === "excluded")).toBe(true);
  const detail = await w.ok("inbox.get", { itemId: aside[0]?.id });
  expect(detail.item.exclusion.reason).toContain("Before the cutover date (2026-10-01)");
  // And they are queued nowhere: only two lines wait for review.
  expect((await w.ok("inbox.summary", {})).counts.toReview).toBe(2);
});

test("moving the first day earlier brings the older lines in: it reads again from the new first day", async () => {
  const w = await connectedAndLinked({}, "2026-10-01");
  await sync(w);
  expect(await idsOf(w, { status: ["new"] })).toEqual(["T-1004", "T-1005"]);
  await linkByCode(w, "ACT-checking-0001", "1000", "2026-09-01");
  advance(w, HOUR);
  const reply = (await sync(w)).body.data;
  expect(reply.accounts[0].windows).toBe(1);
  // (Still waiting, with a suggestion where the starter list has one: "new" and "proposed".)
  expect(await idsOf(w, { status: ["new", "proposed"] })).toEqual([
    "T-1001",
    "T-1002",
    "T-1003",
    "T-1004",
    "T-1005",
  ]);
});

test("pending transactions are never imported, and the run says how many it left for the bank to post", async () => {
  const bridge = (await world()).bridge;
  void bridge;
  const w = await connectedAndLinked({
    accounts: [
      checking({
        transactions: [
          { id: "P-1", posted: 0, amount: "-5.00", description: "PENDING", pending: true },
          {
            id: "P-2",
            posted: day("2026-10-02"),
            amount: "-6.00",
            description: "PENDING TOO",
            pending: true,
          },
          { id: "OK-1", posted: day("2026-10-02"), amount: "-7.00", description: "POSTED" },
        ],
      }),
    ],
  });
  w.bridge.sloppy.sendPending = true;
  const reply = (await sync(w)).body.data;
  expect(await idsOf(w)).toEqual(["OK-1"]);
  expect(reply.run.pendingSkipped).toBe(2);
  expect(reply.run.notes.join(" ")).toContain("2 pending transactions were not imported");
  for (const request of w.bridge.requests("accounts"))
    expect(request.query.pending).toBeUndefined();
});

test("a transaction that cannot be read exactly is held and reported, the rest is imported, and the cursor moves", async () => {
  const w = await connectedAndLinked({
    accounts: [
      checking({
        transactions: [
          { id: "GOOD", posted: day("2026-10-01"), amount: "-1.00", description: "fine" },
          {
            id: "FLOAT",
            posted: day("2026-10-01"),
            amount: -1.5 as never,
            description: "a JSON number",
          },
          {
            id: "THREE",
            posted: day("2026-10-02"),
            amount: "1.005",
            description: "three decimals",
          },
        ],
      }),
    ],
  });
  const reply = (await sync(w)).body.data;
  expect(await idsOf(w)).toEqual(["GOOD"]);
  expect(reply.run.heldLines).toBe(2);
  expect(reply.accounts[0]).toMatchObject({
    state: "complete",
    through: "2026-10-04",
    heldLines: 2,
  });
  const status = await w.ok("bankfeed.status", {});
  expect(status.heldCount).toBe(2);
  expect(status.held.map((h: { id: string }) => h.id).sort()).toEqual(["FLOAT", "THREE"]);
  expect(status.held[0].reason).toContain("not");
  const note = status.attention.find((a: { code: string }) => a.code === "transactions_held");
  expect(note.message).toContain("2 transactions could not be read exactly");
  // Reading it again keeps them listed once, and never invents lines.
  advance(w, HOUR);
  await sync(w);
  expect((await w.ok("bankfeed.status", {})).heldCount).toBe(2);
  expect(await idsOf(w)).toEqual(["GOOD"]);
});

test("a held transaction is released when the Bridge later sends it in a form that can be read", async () => {
  const w = await connectedAndLinked({
    accounts: [
      checking({
        transactions: [
          { id: "LATER", posted: day("2026-10-01"), amount: "1.005", description: "x" },
        ],
      }),
    ],
  });
  await sync(w);
  expect((await w.ok("bankfeed.status", {})).heldCount).toBe(1);
  advance(w, HOUR);
  const tx = w.bridge.accounts[0]?.transactions?.[0];
  if (tx) tx.amount = "1.00";
  await sync(w);
  expect((await w.ok("bankfeed.status", {})).heldCount).toBe(0);
  expect(await idsOf(w)).toEqual(["LATER"]);
});

test("another currency keeps its code, is flagged, cannot be accepted, and gets no balance check", async () => {
  const w = await world({
    connected: false,
    accounts: [
      checking(),
      savings({
        id: "ACT-euro",
        name: "Euro Account",
        currency: "EUR",
        balance: "900.00",
        transactions: [
          { id: "E-1", posted: day("2026-10-01"), amount: "-100.00", description: "HOTEL" },
        ],
      }),
    ],
  });
  await w.ok("bankfeed.connect", { setupToken: w.bridge.setupToken() });
  await linkByCode(w, "ACT-euro", "1200", "2026-09-01");
  await sync(w);
  const [item] = await lines(w);
  expect(item?.line).toMatchObject({ currency: "EUR", amount: "-100.00" });
  expect(item?.flags).toContain("foreign_currency");
  const accepted = await w.call(
    "inbox.categorize",
    { itemIds: [item?.id], accountId: (await chartIds(w))["5100"] },
    uuid(),
  );
  expect(accepted.body.ok).toBe(true);
  expect(accepted.body.data.results[0]).toMatchObject({
    outcome: "skipped",
    code: "foreign_currency",
    status: "new",
  });
  expect(accepted.body.data.results[0].message).toContain("does not convert currencies");
  const status = await w.ok("bankfeed.status", {});
  expect(
    status.accounts.find((a: { id: string }) => a.id === "ACT-euro").link.feedBalance,
  ).toBeNull();
});

test("the feed's balance is shown against the books as a difference and is never fixed", async () => {
  const w = await connectedAndLinked();
  await sync(w);
  let balance = (await w.ok("bankfeed.status", {})).accounts[0].link.feedBalance;
  // Nothing posted, no opening balance: the books are 0.00, the lines waiting add up to 1,223.35, and the
  // bank's 4,021.35 leaves 2,798.00 unexplained. It is shown; nothing is adjusted.
  expect(balance).toEqual({
    asOf: "2026-10-04",
    reported: "4021.35",
    ledger: "0.00",
    waiting: "1223.35",
    excluded: "0.00",
    difference: "2798.00",
  });
  // Booking the opening balance explains it to the cent.
  const ids = await chartIds(w);
  const { postManual } = await import("./support.ts");
  await postManual(w, "2026-09-01", "Opening balance", [
    { accountId: ids["1000"] as string, debit: "2798.00", credit: "" },
    { accountId: ids["3000"] as string, debit: "", credit: "2798.00" },
  ]);
  balance = (await w.ok("bankfeed.status", {})).accounts[0].link.feedBalance;
  expect(balance).toMatchObject({ ledger: "2798.00", waiting: "1223.35", difference: "0.00" });
  // It is a feed balance in the Inbox's own list of balance checks, labelled by its provider.
  const checks = await w.ok("inbox.balanceChecks", {});
  expect(checks.checks.map((c: { provider: string }) => c.provider)).toEqual(["simplefin"]);
});

test("only the last window of a run carries the balance, so an earlier one never shows a difference the later ones explain", async () => {
  const w = await connectedAndLinked({}, "2026-04-01");
  await sync(w);
  const batches = w.service.store
    .query("SELECT balances FROM app_ingest_batches ORDER BY seq")
    .all() as { balances: string }[];
  const withBalance = batches.filter((b) => b.balances !== "[]");
  expect(batches.length).toBe(5);
  expect(withBalance).toHaveLength(1);
  expect(batches.at(-1)?.balances).not.toBe("[]");
});

test("a long first sync reads in windows of 45 days, tiling the period, within the Bridge's quota", async () => {
  const w = await connectedAndLinked({}, "2026-04-01");
  const reply = (await sync(w)).body.data;
  expect(reply.accounts[0].windows).toBe(5);
  const asked = w.bridge.requests("accounts").filter((r) => r.query.account);
  expect(asked).toHaveLength(5);
  const spans = asked.map(
    (r) => [Number(r.query["start-date"]?.[0]), Number(r.query["end-date"]?.[0])] as const,
  );
  for (const [i, [from, to]] of spans.entries()) {
    expect(to - from).toBeLessThanOrEqual(45 * DAY);
    if (i > 0) expect(from).toBe(spans[i - 1]?.[1] ?? -1);
  }
  const status = await w.ok("bankfeed.status", {});
  // The connect listing and five windows.
  expect(status.requests.used).toBe(6);
  expect(reply.run.requests).toBe(5);
});

test("a sync that runs out of time stops cleanly and the next call carries on from the last applied window", async () => {
  const w = await connectedAndLinked({}, "2026-04-01");
  // Each request takes 700 ms; a call has 1 second, so it can start two requests.
  configureBankfeedRuntime(w.service, {
    fetch: async (input, init) => {
      advance(w, 700);
      return w.bridge.fetch(input, init);
    },
  });
  const first = (await sync(w, { budgetSeconds: 1 })).body.data;
  expect(first.more).toBe(true);
  expect(first.run.disposition).toBe("more");
  expect(first.accounts[0]).toMatchObject({ state: "more", windows: 2 });
  let calls = 1;
  let last = first;
  while (last.more && calls < 10) {
    last = (await sync(w, { budgetSeconds: 1 })).body.data;
    calls += 1;
  }
  expect(last.more).toBe(false);
  expect(last.accounts[0].state).toBe("complete");
  // Every window was read once: five requests for five windows, plus the overlap of the later calls.
  expect((await lines(w)).length).toBe(5);
  expect(calls).toBeGreaterThan(1);
});

test("a failure part way leaves the cursor at the last window applied and the next sync loses nothing", async () => {
  const w = await connectedAndLinked({}, "2026-04-01");
  // Windows 1 and 2 answer; window 3 fails, and so does its one retry.
  w.bridge.overrides.push(
    () => null,
    () => null,
  );
  w.bridge.respondOnce(500, "oops");
  w.bridge.respondOnce(500, "oops");
  const failed = await sync(w);
  expect(failed.status).toBe(502);
  expect(failed.body.error.code).toBe("bankfeed_unavailable");
  let status = await w.ok("bankfeed.status", {});
  expect(status.lastSync).toMatchObject({
    disposition: "failed",
    errorCode: "bankfeed_unavailable",
  });
  const through = status.accounts[0].link.through;
  expect(through).toBe("2026-06-30");
  // The next sync continues and completes.
  const next = (await sync(w)).body.data;
  expect(next.accounts[0].state).toBe("complete");
  status = await w.ok("bankfeed.status", {});
  expect(status.accounts[0].link.through).toBe("2026-10-04");
  expect((await lines(w)).length).toBe(5);
});

test("one account's problem never stops the others, and never moves its own cursor", async () => {
  const w = await world({ connected: true });
  await linkByCode(w, "ACT-checking-0001", "1000", "2026-09-01");
  await linkByCode(w, "ACT-savings-0002", "1100", "2026-09-01");
  w.bridge.problems = [
    {
      code: "act.missingdata",
      msg: "Incomplete transaction listing. Try again later.",
      account_id: "ACT-checking-0001",
    },
  ];
  const reply = (await sync(w)).body.data;
  const [a, b] = reply.accounts;
  expect(a).toMatchObject({ accountId: "ACT-checking-0001", state: "attention", through: null });
  expect(a.message).toContain("did not move forward");
  // The savings account's own answer carried the same problem list but it is about checking only.
  expect(b).toMatchObject({
    accountId: "ACT-savings-0002",
    state: "complete",
    through: "2026-10-04",
  });
  const status = await w.ok("bankfeed.status", {});
  expect(
    status.accounts.find((x: { id: string }) => x.id === "ACT-checking-0001").link.lastError.code,
  ).toBe("bridge_missing_data");
  expect(
    status.attention.find((x: { code: string }) => x.code === "account_error").message,
  ).toContain("Business Checking");
  // What did arrive was applied (it is idempotent), and the period is read again once the problem clears.
  expect(await idsOf(w)).toContain("T-1001");
  w.bridge.problems = [];
  advance(w, HOUR);
  const fixed = (await sync(w)).body.data;
  expect(fixed.accounts[0].state).toBe("complete");
  expect(
    (await w.ok("bankfeed.status", {})).attention.find(
      (x: { code: string }) => x.code === "account_error",
    ),
  ).toBeUndefined();
});

test("a bank that needs the owner to sign in again is reported with its name and where to go", async () => {
  const w = await connectedAndLinked();
  w.bridge.problems = [{ code: "con.auth", msg: "Please sign in again.", conn_id: "CON-bank-a" }];
  advance(w, HOUR);
  const reply = (await sync(w)).body.data;
  expect(reply.accounts[0].state).toBe("attention");
  const problem = reply.problems.find((p: { kind: string }) => p.kind === "connection");
  expect(problem.bank).toBe("Example Bank");
  expect(problem.message).toContain("Example Bank");
  expect(problem.message).toContain("https://beta-bridge.simplefin.org");
  const status = await w.ok("bankfeed.status", {});
  const item = status.attention.find((a: { code: string }) => a.code === "bridge_connection");
  expect(item.severity).toBe("error");
  expect(item.message).toContain("Example Bank");
});

test("a sync of one account reads only that account, and an unlinked one is refused", async () => {
  const w = await world({ connected: true });
  await linkByCode(w, "ACT-checking-0001", "1000", "2026-09-01");
  await linkByCode(w, "ACT-savings-0002", "1100", "2026-09-01");
  const before = w.bridge.log.length;
  const reply = (await sync(w, { accountId: "ACT-savings-0002" })).body.data;
  expect(reply.accounts.map((a: { accountId: string }) => a.accountId)).toEqual([
    "ACT-savings-0002",
  ]);
  expect(w.bridge.log.slice(before).every((r) => r.query.account?.[0] === "ACT-savings-0002")).toBe(
    true,
  );
  const refused = await sync(w, { accountId: "ACT-nothing" });
  expect(refused.status).toBe(404);
  expect(refused.body.error.code).toBe("bankfeed_account_not_linked");
});

test("only one sync runs at a time", async () => {
  const w = await connectedAndLinked();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  configureBankfeedRuntime(w.service, {
    fetch: async (input, init) => {
      await gate;
      return w.bridge.fetch(input, init);
    },
  });
  const first = sync(w);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await sync(w);
  expect(second.status).toBe(409);
  expect(second.body.error.code).toBe("bankfeed_sync_running");
  expect(second.body.error.retryable).toBe(true);
  release();
  expect((await first).status).toBe(200);
});

test("the pipeline refusing one batch fails that account only and says why", async () => {
  const w = await world({ connected: true });
  await linkByCode(w, "ACT-checking-0001", "1000", "2026-09-01");
  await linkByCode(w, "ACT-savings-0002", "1100", "2026-09-01");
  // Someone moved the account's chart account in the Inbox directly: the next batch disagrees with it.
  const ids = await chartIds(w);
  await w.ok("inbox.configureSource", {
    provider: "simplefin",
    accountKey: "simplefin:ACT-checking-0001",
    ledgerAccountId: ids["1100"],
  });
  const reply = (await sync(w)).body.data;
  expect(reply.accounts[0]).toMatchObject({ accountId: "ACT-checking-0001", state: "failed" });
  expect(reply.accounts[0].message).toContain("already mapped to chart account");
  expect(reply.accounts[1]).toMatchObject({ accountId: "ACT-savings-0002", state: "complete" });
});
