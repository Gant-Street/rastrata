import { afterEach, expect, test } from "bun:test";
import type { IngestLine, LedgerEvent } from "../../src/ingest-types.ts";
import {
  ACCOUNT_OF,
  KEY,
  ONLINE_BOOK_WITH_ADJUSTMENTS,
  UNTAGGED_BOOK,
  type World,
  uuid,
  world,
} from "./slice-support.ts";

const open: World[] = [];
afterEach(() => {
  for (const w of open.splice(0)) w.close();
});
async function fresh(options: Parameters<typeof world>[0] = {}): Promise<World> {
  const w = await world(options);
  open.push(w);
  return w;
}

const CONTRACT_ROLES = [
  "stripe.balance",
  "stripe.fees",
  "payouts.in-transit",
  "refunds",
  "chargebacks",
  "tax.sales",
  "revenue.sales",
];

interface RoleStatus {
  role: string;
  required: boolean;
  state: string;
  accountId: string | null;
  code: string | null;
  problem: string | null;
}
const roleOf = (roles: RoleStatus[], role: string): RoleStatus => {
  const found = roles.find((r) => r.role === role);
  if (!found) throw new Error(`no status for ${role}`);
  return found;
};

const everythingSaid = (w: World, ...bodies: unknown[]): string =>
  JSON.stringify([bodies, w.stripe.seen]);

const lines = (w: World): IngestLine[] => [...w.port.items.values()].map((i) => i.line);
const events = (w: World): LedgerEvent[] =>
  lines(w).filter((l): l is LedgerEvent => l.kind === "event");
const payoutEntries = (w: World): LedgerEvent[] => events(w).filter((e) => !e.coveredBy);
const covered = (w: World): LedgerEvent[] => events(w).filter((e) => e.coveredBy);

test("before anything is configured, status resolves each role from the chart's role keys", async () => {
  const w = await fresh();
  const status = await w.call("stripe.status");
  expect(status.body.ok).toBe(true);
  const data = status.body.data;
  // Nothing of Stripe has been set in this book yet (which does not stop a reading: it uses the defaults, and saves them).
  expect(data.configured).toBe(false);
  expect(data.settings).toBeNull();
  expect(data.key).toEqual({
    present: true,
    source: "environment",
    mode: "live",
    restricted: true,
    problem: null,
    warning: null,
  });
  const roles = data.roles as RoleStatus[];
  expect(roles).toHaveLength(8);
  for (const role of CONTRACT_ROLES) {
    expect(roleOf(roles, role)).toMatchObject({
      required: true,
      state: "tagged",
      accountId: ACCOUNT_OF[role],
      code: ACCOUNT_OF[role],
      problem: null,
    });
  }
  // The eighth is optional, and with nothing carrying its key it says what to do.
  expect(roleOf(roles, "stripe.adjustments")).toMatchObject({
    required: false,
    state: "missing",
    accountId: null,
  });
  expect(roleOf(roles, "stripe.adjustments").problem).toMatch(/role key stripe\.adjustments/);
  expect(data.account).toBeNull();
  expect(data.balance.snapshot).toBeNull();
  expect(data.balance.explanation).toMatch(/has not been read yet/);
  expect(JSON.stringify(status.body)).not.toContain(KEY);
});

test("the first configure keeps nothing the owner did not choose, says which accounts the chart gave, and later calls replace what they name", async () => {
  const w = await fresh();
  const first = await w.call("stripe.configure", {}, uuid());
  expect(first.body.ok).toBe(true);
  expect(first.body.data.settings.mapping).toEqual([]);
  expect(first.body.data.settings).toMatchObject({
    syncFrom: "2026-01-01",
    timeZone: "UTC",
    salesTax: "stripe",
    overlapDays: 3,
    matchWindowDays: 2,
    accountKey: null,
  });
  expect(first.body.data.ready).toBe(true);
  expect((first.body.data.roles as RoleStatus[]).filter((r) => r.state === "tagged")).toHaveLength(
    7,
  );
  const notes = first.body.data.notes.join(" ");
  expect(notes).toMatch(/Taken from the chart's role keys/);
  expect(notes).toMatch(/refunds is account 4100/);
  expect(notes).toMatch(/You can sync now/);
  expect(notes).toMatch(/No account is chosen for other Stripe adjustments/);
  const second = await w.call(
    "stripe.configure",
    { timeZone: "America/Denver", salesTax: "none", syncFrom: "2026-03-01" },
    uuid(),
  );
  expect(second.body.data.settings).toMatchObject({
    timeZone: "America/Denver",
    salesTax: "none",
    syncFrom: "2026-03-01",
  });
  const status = await w.call("stripe.status");
  expect(status.body.data.configured).toBe(true);
  expect(status.body.data.settings.timeZone).toBe("America/Denver");
  // Sales tax is no longer split, so the sales tax account is no longer needed.
  expect(roleOf(status.body.data.roles, "tax.sales").required).toBe(false);
});

test("an account the owner chooses wins over the chart's role key, and clearing the choice returns to the key", async () => {
  const w = await fresh();
  const chosen = await w.call(
    "stripe.configure",
    { mapping: [{ role: "refunds", accountId: "6026" }] },
    uuid(),
  );
  expect(chosen.body.ok).toBe(true);
  expect(chosen.body.data.settings.mapping).toEqual([{ role: "refunds", accountId: "6026" }]);
  expect(roleOf(chosen.body.data.roles, "refunds")).toMatchObject({
    state: "chosen",
    accountId: "6026",
  });
  expect(roleOf(chosen.body.data.roles, "chargebacks")).toMatchObject({
    state: "tagged",
    accountId: "6026",
  });
  const cleared = await w.call("stripe.configure", { mapping: [] }, uuid());
  expect(cleared.body.data.settings.mapping).toEqual([]);
  expect(roleOf(cleared.body.data.roles, "refunds")).toMatchObject({
    state: "tagged",
    accountId: "4100",
  });
});

test("configure refuses a choice that cannot work, naming the account by code and never by name", async () => {
  const w = await fresh();
  const choose = (role: string, accountId: string) => ({ mapping: [{ role, accountId }] });
  const cases: [string, string, RegExp][] = [
    ["stripe.fees", "2500", /Stripe fees must be an expense account; 2500 is liability/],
    ["stripe.balance", "4000", /Stripe balance must be an asset account; 4000 is income/],
    ["tax.sales", "6025", /Sales tax payable must be a liability account; 6025 is expense/],
    [
      "chargebacks",
      "1000",
      /Chargebacks and disputes must be an expense or income account; 1000 is asset/,
    ],
    ["stripe.balance", "nope", /is not in the chart/],
    // The balance is its own account, even when it is the chart's key that names it.
    [
      "payouts.in-transit",
      "1100",
      /Payouts in transit cannot use account 1100: it is the Stripe balance/,
    ],
  ];
  for (const [role, account, message] of cases) {
    const result = await w.call("stripe.configure", choose(role, account), uuid());
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("stripe_settings_invalid");
    expect(result.body.error.message).toMatch(message);
    expect(result.body.error.message).not.toMatch(/Stripe balance account\b.*Checking/);
  }
  const twice = await w.call(
    "stripe.configure",
    {
      mapping: [
        { role: "refunds", accountId: "4100" },
        { role: "refunds", accountId: "4000" },
      ],
    },
    uuid(),
  );
  expect(twice.body.error.message).toMatch(/mapped twice/);
  for (const input of [
    { timeZone: "Mars/Olympus" },
    { syncFrom: "2999-01-01" },
    { syncFrom: "2026-02-30" },
    { overlapDays: 99 },
  ]) {
    const bad = await w.call("stripe.configure", input, uuid());
    expect(bad.body.ok).toBe(false);
    expect(bad.status).toBe(400);
  }
  // Nothing refused was kept.
  expect((await w.call("stripe.status")).body.data.settings).toBeNull();
});

test("a book whose accounts carry no role keys is told which roles are missing, and syncs once they are chosen", async () => {
  const w = await fresh({ book: UNTAGGED_BOOK });
  const configured = await w.call("stripe.configure", {}, uuid());
  expect(configured.body.ok).toBe(true);
  expect(configured.body.data.ready).toBe(false);
  const roles = configured.body.data.roles as RoleStatus[];
  for (const role of CONTRACT_ROLES) {
    expect(roleOf(roles, role)).toMatchObject({
      state: "missing",
      accountId: null,
      required: true,
    });
    expect(roleOf(roles, role).problem).toContain(`role key ${role}`);
  }
  const notes = configured.body.data.notes.join(" ");
  expect(notes).toMatch(
    /No account is chosen for Stripe fees, and no open account carries the role key stripe\.fees/,
  );
  expect(notes).toMatch(/Stripe cannot sync until these accounts are settled/);
  // The sync says the same, and asks Stripe nothing.
  const blocked = await w.call("stripe.sync", {}, uuid());
  expect(blocked.status).toBe(409);
  expect(blocked.body.error.code).toBe("stripe_not_configured");
  expect(blocked.body.error.message).toContain("stripe.fees");
  expect(w.stripe.seen).toEqual([]);
  // Choosing the accounts here settles it; the chart's keys were never needed.
  const choose = await w.call(
    "stripe.configure",
    { mapping: CONTRACT_ROLES.map((role) => ({ role, accountId: ACCOUNT_OF[role] })) },
    uuid(),
  );
  expect(choose.body.data.ready).toBe(true);
  expect((choose.body.data.roles as RoleStatus[]).every((r) => r.state !== "tagged")).toBe(true);
  expect((await w.call("stripe.sync", {}, uuid())).body.ok).toBe(true);
});

test("a role key that moves on a date is followed: today's tag decides, a later one waits for its date", async () => {
  const w = await fresh();
  await w.call("stripe.configure", {}, uuid());
  // From the start of March the sales role key is on 4010, and not on 4000.
  const clear = await w.call(
    "accounts.setTags",
    { accountId: "4000", effectiveOn: "2026-03-01", tags: { roleKey: null } },
    uuid(),
  );
  expect(clear.body.ok).toBe(true);
  const move = await w.call(
    "accounts.setTags",
    { accountId: "4010", effectiveOn: "2026-03-01", tags: { roleKey: "revenue.sales" } },
    uuid(),
  );
  expect(move.body.ok).toBe(true);
  // From April, fees move to 6050; that is in the future of the book's clock (20 March).
  await w.call(
    "accounts.setTags",
    { accountId: "6025", effectiveOn: "2026-04-01", tags: { roleKey: null } },
    uuid(),
  );
  await w.call(
    "accounts.setTags",
    { accountId: "6050", effectiveOn: "2026-04-01", tags: { roleKey: "stripe.fees" } },
    uuid(),
  );
  const status = (await w.call("stripe.status")).body.data;
  expect(roleOf(status.roles, "revenue.sales")).toMatchObject({
    state: "tagged",
    accountId: "4010",
  });
  expect(roleOf(status.roles, "stripe.fees")).toMatchObject({ state: "tagged", accountId: "6025" });
  expect(status.configured).toBe(true);
});

test("configure is idempotent for a retried identity and conflicts for different input", async () => {
  const w = await fresh();
  const id = uuid();
  const a = await w.call("stripe.configure", { timeZone: "America/Denver" }, id);
  const b = await w.call("stripe.configure", { timeZone: "America/Denver" }, id);
  expect(b).toEqual(a);
  const c = await w.call("stripe.configure", { timeZone: "UTC" }, id);
  expect(c.body.error.code).toBe("operation_identity_conflict");
});

test("configure needs the configure permission and sync needs draft; status needs only read", async () => {
  const w = await fresh();
  expect((await w.call("stripe.configure", {}, uuid(), ["read", "draft"])).body.error.code).toBe(
    "permission_denied",
  );
  expect((await w.call("stripe.sync", {}, uuid(), ["read"])).body.error.code).toBe(
    "permission_denied",
  );
  expect((await w.call("stripe.status", {}, undefined, ["read"])).body.ok).toBe(true);
  expect((await w.call("stripe.payouts", {}, undefined, ["read"])).body.ok).toBe(true);
});

// Until 2026-11-22 a book refused to read Stripe until its settings had been saved once, though it knew every one of them: the owner connected Stripe and was then told to press Save.
test("a book that was never told otherwise reads Stripe with the defaults, and the first reading saves them with the time zone of the Stripe account; a book whose chart does not name an account is the one that is asked", async () => {
  const w = await fresh();
  const early = await w.call("stripe.sync", {}, uuid());
  expect(early.status).toBe(200);
  expect(early.body.data.run.disposition).toBe("complete");
  expect(early.body.data.run.payouts).toBe(6);
  const settled = (await w.call("stripe.status")).body.data;
  expect(settled.configured).toBe(true);
  // Saved now, as they were used: each movement is dated in the zone the Stripe dashboard reports in.
  expect(settled.settings).toMatchObject({
    mapping: [],
    timeZone: "America/Denver",
    salesTax: "stripe",
  });
  expect(settled.settings.syncFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  // A later change of the options is a change, not a first save: the first day is fixed by then.
  const moved = await w.call("stripe.configure", { syncFrom: "2026-01-15" }, uuid());
  expect(moved.body.error.code).toBe("stripe_start_fixed");
  // What a book cannot know is still asked: an account for a role its chart does not name.
  const bare = await fresh({ book: UNTAGGED_BOOK });
  const asked = await bare.call("stripe.sync", {}, uuid());
  expect(asked.status).toBe(409);
  expect(asked.body.error.code).toBe("stripe_not_configured");
  expect(asked.body.error.message).toContain("stripe.fees");
  expect(bare.stripe.seen).toEqual([]);
  expect((await bare.call("stripe.status")).body.data.configured).toBe(false);
});

test("a sync without a key says exactly what to do", async () => {
  const keyless = await fresh({ key: null });
  await keyless.call("stripe.configure", {}, uuid());
  const missing = await keyless.call("stripe.sync", {}, uuid());
  expect(missing.status).toBe(409);
  expect(missing.body.error.code).toBe("stripe_key_missing");
  expect(missing.body.error.message).toMatch(/RASTRATA_STRIPE_KEY|stripe\.key/);
  expect(keyless.stripe.seen).toEqual([]);
});

test("a first sync queues one entry per payout with its transactions as evidence, never posts, and reads Stripe's balance", async () => {
  const w = await fresh();
  await w.call("stripe.configure", { timeZone: "America/Denver" }, uuid());
  const sync = await w.call("stripe.sync", {}, uuid());
  expect(sync.body.ok).toBe(true);
  const data = sync.body.data;
  expect(data.more).toBe(false);
  expect(data.run.disposition).toBe("complete");
  expect(data.run.errorCode).toBeNull();
  // Every transaction Stripe lists was seen; six payouts became six entries and carry 24 of them.
  expect(data.run.transactions).toBe(w.scenario.entries.length);
  expect(data.run.payouts).toBe(6);
  expect(data.run.newLines).toBe(30);
  expect(data.run.duplicateLines).toBe(0);
  expect(data.run.heldLines).toBe(0);
  expect(w.port.items.size).toBe(30);
  expect(payoutEntries(w)).toHaveLength(6);
  expect(covered(w)).toHaveLength(24);
  const notes = data.run.notes.join(" ");
  expect(notes).toMatch(/6 payouts booked, each as one entry/);
  expect(notes).toMatch(/Choose an adjustments account/);
  expect(notes).toMatch(/2 charges had no sales tax figure/);
  // Each covered transaction names the payout that books it, and each payout is named by its id.
  const entries = new Set(payoutEntries(w).map((e) => e.providerId));
  expect(covered(w).every((e) => entries.has(String(e.coveredBy)))).toBe(true);
  for (const entry of payoutEntries(w)) {
    expect(entry.sourceId).toBe(`stripe-payout-${entry.providerId}`);
    expect(entry.evidence).toMatch(
      /^stripe:payout:po_[A-Za-z0-9]+:members=\d+:sha256=[0-9a-f]{64}$/,
    );
    expect(entry.links?.payout).toBe(entry.providerId);
  }
  // The account was learned and is now part of every line's identity; the Stripe balance account is
  // named to the pipeline from the chart's key.
  const status = (await w.call("stripe.status")).body.data;
  expect(status.account).toMatchObject({
    id: "acct_1FixtureAccount0001",
    defaultCurrency: "USD",
    timeZone: "America/Denver",
  });
  expect(status.settings.accountKey).toBe("stripe:acct_1FixtureAccount0001");
  expect(lines(w).every((l) => l.accountKey === "stripe:acct_1FixtureAccount0001:usd")).toBe(true);
  expect(w.port.submissions.every((s) => s.batch.ledgerAccountId === "1100")).toBe(true);
  // What Stripe still holds is exactly what Rastrata knows is not yet paid out: to the cent.
  expect(status.balance.snapshot.total).toBe("19.12");
  expect(status.balance.snapshot.otherCurrencies).toEqual([]);
  expect(status.balance).toMatchObject({
    unpaid: "19.12",
    unpaidCount: 1,
    difference: "0.00",
    inTransit: "0.00",
    ties: true,
    stale: false,
  });
  expect(status.balance.explanation).toMatch(/Stripe holds 19\.12/);
  expect(status.balance.explanation).toMatch(/They agree to the cent/);
  expect(status.payouts).toEqual({
    known: 6,
    booked: 6,
    waiting: 0,
    mismatched: 0,
    held: 0,
    reversed: 1,
    // Five payouts expect a bank deposit and none has been matched yet; the failed one expects none.
    // Today is the 20th and the latest arrival the 17th: every one is past its arrival date and the
    // two-day window, so every one is overdue, the oldest due on the 9th.
    unmatched: 5,
    overdue: 5,
    oldestOverdueOn: "2026-03-09",
  });
  expect(status.held).toMatchObject({
    lines: 0,
    otherCurrency: 0,
    manualPayouts: 0,
    adjustments: 1,
    taxNotReported: 2,
  });
  // The books are untouched: a sync never posts.
  expect((await w.call("journal.list", {})).body.data.count).toBe(0);
  // And no secret is anywhere in what was said or sent.
  expect(everythingSaid(w, sync.body, status)).not.toContain(KEY);
});

test("syncing again with nothing new changes nothing, and a retried identity does not run again", async () => {
  const w = await fresh();
  await w.call("stripe.configure", {}, uuid());
  const id = uuid();
  const first = await w.call("stripe.sync", {}, id);
  const imported = w.port.items.size;
  const requests = w.stripe.seen.length;
  const retry = await w.call("stripe.sync", {}, id);
  expect(retry).toEqual(first);
  expect(w.stripe.seen.length).toBe(requests);
  w.clock.ms += 120_000;
  const second = await w.call("stripe.sync", {}, uuid());
  expect(second.body.data.run.newLines).toBe(0);
  expect(second.body.data.run.duplicateLines).toBe(0);
  expect(second.body.data.run.payouts).toBe(0);
  expect(w.port.items.size).toBe(imported);
  const history = (await w.call("stripe.status")).body.data.history;
  expect(history).toHaveLength(2);
  expect(history[0].id).toBe(second.body.operationId);
});

test("payouts are checked against the transactions Stripe says they paid out, to the cent", async () => {
  const w = await fresh();
  await w.call("stripe.configure", {}, uuid());
  await w.call("stripe.sync", {}, uuid());
  const page = (await w.call("stripe.payouts", {})).body.data;
  expect(page.count).toBe(6);
  expect(page.payouts.every((p: { booking: string }) => p.booking === "booked")).toBe(true);
  for (const p of page.payouts) {
    expect(p.difference).toBe("0.00");
    expect(p.memberNet).toBe(p.amount);
    expect(p.itemised).toBe("completed");
  }
  const counts = page.payouts.map((p: { memberCount: number }) => p.memberCount).sort();
  expect(counts).toEqual([1, 1, 1, 6, 6, 9]);
  const failed = page.payouts.find((p: { status: string }) => p.status === "failed");
  expect(failed.deposit).toBe("reversed");
  const expecting = page.payouts.filter((p: { status: string }) => p.status !== "failed");
  expect(expecting.every((p: { deposit: string }) => p.deposit === "unmatched")).toBe(true);
  expect((await w.call("stripe.payouts", { filter: "unmatched" })).body.data.count).toBe(5);
  expect(failed.reason).toMatch(/returned this payout to the balance/);
  const amounts = page.payouts.map((p: { amount: string }) => p.amount).sort();
  expect(amounts).toEqual(["19.12", "19.12", "19.12", "125.94", "56.31", "93.31"].sort());
  for (const filter of ["waiting", "mismatch", "held"]) {
    expect((await w.call("stripe.payouts", { filter })).body.data.count).toBe(0);
  }
});

test("a payout whose transactions do not add up is reported with the difference, never booked", async () => {
  const w = await fresh();
  await w.call("stripe.configure", {}, uuid());
  const target = w.scenario.payouts[0];
  if (!target) throw new Error("fixture has no payout");
  // Stripe says the payout was a dollar more than the transactions it lists add up to.
  target.amount = Number(target.amount) + 100;
  const run = await w.call("stripe.sync", {}, uuid());
  expect(run.body.ok).toBe(true);
  const page = (await w.call("stripe.payouts", { filter: "mismatch" })).body.data;
  expect(page.count).toBe(1);
  expect(page.payouts[0]).toMatchObject({ id: target.id, booking: "mismatch", difference: "1.00" });
  expect(page.payouts[0].reason).toMatch(/add up to 93\.31, not the payout's 94\.31/);
  expect(run.body.data.run.notes.join(" ")).toMatch(/add up to 93\.31/);
  expect((await w.call("stripe.status")).body.data.payouts).toMatchObject({
    booked: 5,
    mismatched: 1,
  });
  // Neither the payout nor any of its transactions was queued: nothing is forced.
  expect(w.port.items.size).toBe(30 - 6 - 1);
  expect(lines(w).some((l) => l.providerId === target.id)).toBe(false);
});

test("a payout Stripe is still itemising waits, is counted, and is booked on a later sync", async () => {
  const w = await fresh();
  await w.call("stripe.configure", {}, uuid());
  const target = w.scenario.payouts[0];
  if (!target) throw new Error("fixture has no payout");
  target.reconciliation_status = "in_progress";
  const first = await w.call("stripe.sync", {}, uuid());
  expect(first.body.ok).toBe(true);
  expect(first.body.data.run.payouts).toBe(5);
  expect((await w.call("stripe.payouts", { filter: "waiting" })).body.data.count).toBe(1);
  const waiting = (await w.call("stripe.status")).body.data;
  expect(waiting.payouts).toMatchObject({ booked: 5, waiting: 1 });
  expect(waiting.balance.explanation).toMatch(
    /1 payout is waiting for Stripe to finish itemising it/,
  );
  // Its six transactions and its own debit of the balance are not yet in a payout, so they are
  // part of "in Stripe, not yet paid out", and they add up to nothing.
  expect(waiting.balance.unpaidCount).toBe(8);
  expect(waiting.balance.difference).toBe("0.00");
  target.reconciliation_status = "completed";
  w.clock.ms += 3600_000;
  const second = await w.call("stripe.sync", {}, uuid());
  expect(second.body.data.run.payouts).toBe(1);
  expect(w.port.items.size).toBe(30);
  const done = (await w.call("stripe.status")).body.data;
  expect(done.payouts).toMatchObject({ booked: 6, waiting: 0 });
  expect(done.balance).toMatchObject({ unpaidCount: 1, difference: "0.00", ties: true });
});

test("a payout made by hand is held for a person to categorise, never itemised or guessed", async () => {
  const w = await fresh();
  await w.call("stripe.configure", {}, uuid());
  const target = w.scenario.payouts[1];
  if (!target) throw new Error("fixture has no second payout");
  target.automatic = false;
  target.reconciliation_status = "not_applicable";
  const run = await w.call("stripe.sync", {}, uuid());
  expect(run.body.ok).toBe(true);
  expect(run.body.data.run.heldLines).toBe(1);
  const held = lines(w).filter((l) => l.kind === "bankLine");
  expect(held).toHaveLength(1);
  expect(held[0]).toMatchObject({
    provider: "stripe",
    providerId: target.id,
    amount: "-56.31",
    currency: "USD",
  });
  const page = (await w.call("stripe.payouts", { filter: "held" })).body.data;
  expect(page.count).toBe(1);
  expect(page.payouts[0]).toMatchObject({
    id: target.id,
    booking: "held",
    itemised: "not_applicable",
  });
  expect(page.payouts[0].reason).toMatch(/made by hand/);
  const status = (await w.call("stripe.status")).body.data;
  expect(status.payouts).toMatchObject({ booked: 5, held: 1 });
  expect(status.held).toMatchObject({ lines: 1, manualPayouts: 1, otherCurrency: 0 });
  // Its nine transactions were not booked with it, so they stay in "in Stripe, not yet paid out"
  // with the payout's own debit of the balance, which cancels them: the control still ties.
  expect(status.balance.unpaidCount).toBe(11);
  expect(status.balance).toMatchObject({ difference: "0.00", ties: true });
});

test("a key that belongs to another Stripe account is refused before anything is imported", async () => {
  const w = await fresh();
  await w.call("stripe.configure", {}, uuid());
  await w.call("stripe.sync", {}, uuid());
  const imported = w.port.items.size;
  w.stripe.intercept((request) =>
    request.path === "/v1/account"
      ? Response.json({
          id: "acct_1SomebodyElse00001",
          object: "account",
          country: "US",
          default_currency: "usd",
          settings: {
            branding: {},
            card_payments: {},
            dashboard: { display_name: null, timezone: null },
            payments: {},
          },
        })
      : undefined,
  );
  w.clock.ms += 60_000;
  const swapped = await w.call("stripe.sync", {}, uuid());
  expect(swapped.status).toBe(409);
  expect(swapped.body.error.code).toBe("stripe_account_changed");
  expect(w.port.items.size).toBe(imported);
  const last = (await w.call("stripe.status")).body.data.lastSync;
  expect(last.disposition).toBe("failed");
  expect(last.errorCode).toBe("stripe_account_changed");
});

test("Stripe errors become named, actionable failures that are recorded, and a retry carries on", async () => {
  const w = await fresh();
  await w.call("stripe.configure", {}, uuid());
  w.stripe.intercept(() => Response.json({ error: { message: `bad ${KEY}` } }, { status: 401 }));
  const rejected = await w.call("stripe.sync", {}, uuid());
  expect(rejected.status).toBe(424);
  expect(rejected.body.error.code).toBe("stripe_key_rejected");
  expect(rejected.body.error.message).toMatch(/restricted read-only key/);
  expect(JSON.stringify(rejected.body)).not.toContain(KEY);
  w.stripe.intercept(() => new Response("{}", { status: 429 }));
  const limited = await w.call("stripe.sync", {}, uuid());
  expect(limited.status).toBe(429);
  expect(limited.body.error.retryable).toBe(true);
  w.stripe.intercept(() => new Response("{}", { status: 503 }));
  const down = await w.call("stripe.sync", {}, uuid());
  expect(down.status).toBe(502);
  expect(down.body.error.retryable).toBe(true);
  w.stripe.intercept(() => undefined);
  const ok = await w.call("stripe.sync", {}, uuid());
  expect(ok.body.ok).toBe(true);
  const history = (await w.call("stripe.status")).body.data.history;
  expect(history.map((h: { disposition: string }) => h.disposition)).toEqual([
    "complete",
    "failed",
    "failed",
    "failed",
  ]);
  expect(history.map((h: { errorCode: string | null }) => h.errorCode)).toEqual([
    null,
    "stripe_unavailable",
    "stripe_rate_limited",
    "stripe_key_rejected",
  ]);
});

test("a time budget splits a long sync into calls, each continuing where the last stopped", async () => {
  const w = await fresh({ maxLimit: 6 });
  await w.call("stripe.configure", {}, uuid());
  w.clock.perRequestMs = 150;
  const runs: { more: boolean; newLines: number }[] = [];
  for (let i = 0; i < 200; i++) {
    const result = await w.call("stripe.sync", { budgetSeconds: 1 }, uuid());
    expect(result.body.ok).toBe(true);
    runs.push({ more: result.body.data.more, newLines: result.body.data.run.newLines });
    if (!result.body.data.more) break;
  }
  expect(runs.length).toBeGreaterThan(2);
  expect(runs.at(-1)?.more).toBe(false);
  expect(runs.slice(0, -1).every((r) => r.more)).toBe(true);
  expect(w.port.items.size).toBe(30);
  expect(runs.reduce((sum, r) => sum + r.newLines, 0)).toBe(30);
  const status = (await w.call("stripe.status")).body.data;
  expect(status.payouts).toMatchObject({ known: 6, booked: 6 });
  expect(status.balance).toMatchObject({ difference: "0.00", ties: true });
});

test("only one sync runs at a time", async () => {
  const w = await fresh();
  await w.call("stripe.configure", {}, uuid());
  const [a, b] = await Promise.all([
    w.call("stripe.sync", {}, uuid()),
    w.call("stripe.sync", {}, uuid()),
  ]);
  const outcomes = [a, b].map((r) => (r.body.ok ? "ok" : (r.body.error.code as string)));
  expect(outcomes.sort()).toEqual(["ok", "stripe_sync_running"]);
  expect(w.port.items.size).toBe(30);
});

test("the first day cannot move after lines were imported, and settings survive", async () => {
  const w = await fresh();
  await w.call("stripe.configure", { syncFrom: "2026-03-01" }, uuid());
  await w.call("stripe.sync", {}, uuid());
  const moved = await w.call("stripe.configure", { syncFrom: "2026-02-01" }, uuid());
  expect(moved.status).toBe(409);
  expect(moved.body.error.code).toBe("stripe_start_fixed");
  const same = await w.call(
    "stripe.configure",
    { syncFrom: "2026-03-01", matchWindowDays: 1 },
    uuid(),
  );
  expect(same.body.ok).toBe(true);
  expect(same.body.data.settings.matchWindowDays).toBe(1);
});

test("a book with the optional adjustments account resolves it and the payout that carries an adjustment can be proposed", async () => {
  const w = await fresh({ book: ONLINE_BOOK_WITH_ADJUSTMENTS });
  const configured = await w.call("stripe.configure", {}, uuid());
  expect(roleOf(configured.body.data.roles, "stripe.adjustments")).toMatchObject({
    required: false,
    state: "tagged",
    accountId: "6040",
  });
  expect(configured.body.data.notes.join(" ")).not.toMatch(/No account is chosen for other Stripe/);
});
