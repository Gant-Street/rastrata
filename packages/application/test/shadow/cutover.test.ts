import { afterEach, expect, test } from "bun:test";
import { closeShadowFixtures, shadowFixture, type ShadowFixture } from "./support.ts";

afterEach(closeShadowFixtures);

const line = (date: string, amount: string, description: string, providerId?: string) => ({
  date,
  amount,
  description,
  ...(providerId ? { providerId } : {}),
});

const sourceOf = (state: { sources: { accountKey: string }[] }, key: string) =>
  state.sources.find((source) => source.accountKey === key) as Record<string, unknown>;

const inbox = async (f: ShadowFixture, filter: Record<string, unknown>) =>
  f.ok("inbox.list", { filter, pageSize: 200, sort: "date_asc" });

test("before a date is set, the accounts that probably have statements are suggested and nothing is changed", async () => {
  const f = await shadowFixture();
  const state = await f.ok("cutover.get", {});
  expect(state.cutover).toBeNull();
  expect(state.forDate).toBeNull();
  expect(state.locked).toBe(false);
  // The empty date field says that no date is recorded; no note repeats it.
  expect(state.notes).not.toContain("No cutover date has been recorded yet.");
  const by = Object.fromEntries(
    state.accounts.map((account: { code: string }) => [account.code, account]),
  );
  // Cash-tagged bank accounts are suggested; the Stripe balance is Stripe's own; a liability called a
  // credit card is a card; payouts in transit are left out.
  expect(by["1000"]).toMatchObject({ kind: "bank", reason: "cash", chosen: true });
  expect(by["1010"]).toMatchObject({ kind: "bank", reason: "cash", chosen: true });
  expect(by["1100"]).toMatchObject({ kind: "stripe", reason: "stripe", chosen: false });
  expect(by["2000"]).toMatchObject({ kind: "card", reason: "card", chosen: true });
  expect(by["1110"]).toBeUndefined();
  expect(by["3000"]).toBeUndefined();
  // An asset is not a bank because it is an asset, nor a liability a card because it is a liability:
  // Equipment and Sales tax payable are never offered, and the notes say why some are missing.
  expect(by["1500"]).toBeUndefined();
  expect(by["2500"]).toBeUndefined();
  expect(state.notes.join(" ")).toContain("2 other accounts are not listed");
  expect(state.notes.join(" ")).toContain(
    "tag it as a bank or card account in your chart of accounts",
  );
  expect(state.sources).toEqual([]);
  expect((await f.ok("inbox.sources", {})).sources).toEqual([]);
});

test("an account is offered when a statement was imported for it, and one the person chose is kept", async () => {
  const f = await shadowFixture();
  // Equipment is not a bank; but a statement was imported for it (a loan-like asset account of the
  // person's own), so it has statements.
  await f.importLines("1500", [line("2026-10-02", "-20.00", "Early line one")]);
  const withSource = await f.ok("cutover.get", {});
  const by = (state: { accounts: { code: string }[] }) =>
    Object.fromEntries(state.accounts.map((account) => [account.code, account]));
  expect(by(withSource)["1500"]).toMatchObject({ kind: "bank", reason: "imported", chosen: true });
  // Sales tax payable is a liability with nothing saying it is a card: it is not offered...
  expect(by(withSource)["2500"]).toBeUndefined();
  // ...until the person names it, and then it stays, with no reason but their own choice.
  const named = await f.ok("cutover.get", {
    cutoverDate: "2026-11-01",
    accountIds: ["1000", "2500"],
  });
  expect(by(named)["2500"]).toMatchObject({ kind: "card", reason: null, chosen: true });
  expect(by(named)["1000"]).toMatchObject({ chosen: true });
  expect(by(named)["1010"]).toMatchObject({ chosen: false });
  // A recorded cutover keeps what was chosen, offered or not.
  await f.ok("cutover.set", { cutoverDate: "2026-11-01", accountIds: ["1000", "2500"] });
  const recorded = await f.ok("cutover.get", {});
  expect(by(recorded)["2500"]).toMatchObject({ chosen: true });
  expect(recorded.cutover.accountIds.sort()).toEqual(["1000", "2500"]);
});

test("a what-if shows what a date would do before anything is recorded", async () => {
  const f = await shadowFixture();
  // Statement lines already imported with no start date.
  await f.importLines("1000", [
    line("2026-10-02", "-20.00", "Early line one"),
    line("2026-10-29", "-30.00", "Early line two"),
    line("2026-11-03", "-40.00", "After the cutover"),
  ]);
  const view = await f.ok("cutover.get", {
    cutoverDate: "2026-11-01",
    accountIds: ["1000", "2000"],
  });
  expect(view.cutover).toBeNull();
  expect(view.forDate).toBe("2026-11-01");
  expect(sourceOf(view, "csv:1000")).toMatchObject({
    action: "set",
    startOn: null,
    after: "2026-11-01",
    wouldExclude: 2,
    wouldRestore: 0,
  });
  // The card has no source yet: one would be created.
  expect(sourceOf(view, "csv:2000")).toMatchObject({
    action: "create",
    provider: "csv",
    ledgerAccountId: "2000",
    after: "2026-11-01",
  });
  // Nothing happened.
  expect((await f.ok("inbox.sources", {})).sources).toHaveLength(1);
  expect((await inbox(f, { exclusion: "before_cutover" })).count).toBe(0);
});

test("setting the date sets earlier history aside where it can be seen, and a first import starts on it", async () => {
  const f = await shadowFixture();
  await f.importLines("1000", [
    line("2026-10-02", "-20.00", "Early line one"),
    line("2026-10-29", "-30.00", "Early line two"),
    line("2026-11-03", "-40.00", "After the cutover"),
  ]);
  const result = await f.ok("cutover.set", {
    cutoverDate: "2026-11-01",
    accountIds: ["1000", "1010", "2000"],
  });
  expect(result.excluded).toBe(2);
  expect(result.sourcesSet).toBe(3);
  expect(result.state.cutover).toMatchObject({ cutoverDate: "2026-11-01", by: "owner" });
  expect(result.state.cutover.accountIds).toEqual(["1000", "1010", "2000"]);
  expect(sourceOf(result.state, "csv:1000")).toMatchObject({
    startOn: "2026-11-01",
    action: "unchanged",
    excluded: 2,
  });
  // The two early lines are excluded with the reason, still visible and restorable; one is queued.
  const hidden = await inbox(f, { exclusion: "before_cutover" });
  expect(hidden.count).toBe(2);
  expect(hidden.items.map((item: { status: string }) => item.status)).toEqual([
    "excluded",
    "excluded",
  ]);
  expect((await inbox(f, { status: ["new", "proposed"] })).count).toBe(1);
  // A statement imported later for an account that had no source starts on the date too.
  const imported = await f.importLines("2000", [
    line("2026-09-15", "-5.00", "September card line"),
    line("2026-11-12", "-8.00", "November card line"),
  ]);
  expect(imported.excludedCount).toBe(1);
  expect(
    (await f.ok("inbox.sources", {})).sources
      .map((s: { accountKey: string; startOn: string }) => [s.accountKey, s.startOn])
      .sort(),
  ).toEqual([
    ["csv:1000", "2026-11-01"],
    ["csv:1010", "2026-11-01"],
    ["csv:2000", "2026-11-01"],
  ]);
  // Setting the same thing again changes nothing.
  const same = await f.ok("cutover.set", {
    cutoverDate: "2026-11-01",
    accountIds: ["1000", "1010", "2000"],
  });
  expect(same.sourcesSet).toBe(0);
  expect(same.excluded).toBe(0);
});

test("moving the date later sets more aside, and moving it earlier brings lines back", async () => {
  const f = await shadowFixture();
  await f.importLines("1000", [
    line("2026-10-02", "-20.00", "Early"),
    line("2026-10-20", "-30.00", "Middle"),
    line("2026-11-03", "-40.00", "Late"),
  ]);
  await f.ok("cutover.set", { cutoverDate: "2026-10-15", accountIds: ["1000"] });
  expect((await inbox(f, { exclusion: "before_cutover" })).count).toBe(1);
  const later = await f.ok("cutover.set", { cutoverDate: "2026-11-01", accountIds: ["1000"] });
  expect(later.excluded).toBe(1);
  expect((await inbox(f, { exclusion: "before_cutover" })).count).toBe(2);
  // Before it is moved earlier the effect is shown.
  const view = await f.ok("cutover.get", { cutoverDate: "2026-10-15" });
  expect(sourceOf(view, "csv:1000")).toMatchObject({ action: "move_earlier", wouldRestore: 1 });
  const earlier = await f.ok("cutover.set", { cutoverDate: "2026-10-15", accountIds: ["1000"] });
  expect(earlier.restored).toBe(1);
  expect((await inbox(f, { exclusion: "before_cutover" })).count).toBe(1);
  expect((await f.ok("cutover.get", {})).cutover.cutoverDate).toBe("2026-10-15");
});

test("a retried request does nothing twice, and a different one under the same identity is a conflict", async () => {
  const f = await shadowFixture();
  await f.importLines("1000", [line("2026-10-02", "-20.00", "Early")]);
  const id = crypto.randomUUID();
  const first = await f.ok("cutover.set", { cutoverDate: "2026-11-01", accountIds: ["1000"] }, id);
  const retry = await f.ok("cutover.set", { cutoverDate: "2026-11-01", accountIds: ["1000"] }, id);
  expect(retry).toEqual(first);
  const conflict = await f.call(
    "cutover.set",
    { cutoverDate: "2026-12-01", accountIds: ["1000"] },
    id,
  );
  expect(conflict.status).toBe(409);
  expect(conflict.body.error.code).toBe("operation_identity_conflict");
  expect((await f.ok("cutover.get", {})).cutover.cutoverDate).toBe("2026-11-01");
});

test("a crash after the Inbox was told and before the date was recorded is finished by the retry", async () => {
  const f = await shadowFixture();
  await f.importLines("1000", [line("2026-10-02", "-20.00", "Early")]);
  const id = crypto.randomUUID();
  await f.ok("cutover.set", { cutoverDate: "2026-11-01", accountIds: ["1000"] }, id);
  // Simulate losing the recorded reply and the record: the retained answer is gone, the source is set.
  f.service.store.query("DELETE FROM app_requests WHERE id=?").run(id);
  f.service.store.query("DELETE FROM shadow_cutover_log").run();
  expect((await f.ok("cutover.get", {})).cutover).toBeNull();
  const resumed = await f.ok(
    "cutover.set",
    { cutoverDate: "2026-11-01", accountIds: ["1000"] },
    id,
  );
  expect(resumed.state.cutover.cutoverDate).toBe("2026-11-01");
  expect(resumed.sourcesSet).toBe(0);
  expect((await inbox(f, { exclusion: "before_cutover" })).count).toBe(1);
});

test("accounts that cannot have statements are refused, naming the account", async () => {
  const f = await shadowFixture();
  for (const [accountId, why] of [
    ["9999", "not in your chart"],
    ["4000", "not a bank or card"],
    ["1100", "Stripe account"],
    ["1110", "Stripe account"],
  ] as const) {
    const refused = await f.call(
      "cutover.set",
      { cutoverDate: "2026-11-01", accountIds: [accountId] },
      crypto.randomUUID(),
    );
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe("account_not_statement_account");
    expect(refused.body.error.message).toContain(why);
  }
  expect((await f.ok("cutover.get", {})).cutover).toBeNull();
});

test("the date has to be a real date on or after the book's first day; one past the calendar's end grows it", async () => {
  const f = await shadowFixture();
  const outside = await f.call("cutover.set", { cutoverDate: "2025-12-31" }, crypto.randomUUID());
  expect(outside.status).toBe(409);
  expect(outside.body.error.code).toBe("cutover_outside_calendar");
  const fake = await f.call("cutover.set", { cutoverDate: "2026-02-30" }, crypto.randomUUID());
  expect(fake.status).toBe(400);
  expect(fake.body.error.code).toBe("invalid_date");
  // A start date after the calendar's end grows the calendar to cover it, as a posting does.
  const after = await f.call("cutover.set", { cutoverDate: "2027-01-01" }, crypto.randomUUID());
  expect(after.body.ok, JSON.stringify(after.body)).toBe(true);
  expect((await f.ok("periods.list", {})).calendar.lastDate).toBe("2027-12-31");
  expect((await f.ok("periods.list", {})).calendar.booksBegan).toBe("2027-01-01");
});

test("once the opening entry is posted the date is fixed", async () => {
  const f = await shadowFixture();
  await f.ok("cutover.set", { cutoverDate: "2026-11-01" });
  const plan = await f.ok("opening.plan", {
    cutoverDate: "2026-11-01",
    balances: [{ accountId: "1000", balance: "100.00" }],
  });
  await f.ok(
    "operations.commit",
    { planId: plan.plan.planId, planHash: plan.plan.planHash },
    plan.plan.planId,
  );
  const moved = await f.call("cutover.set", { cutoverDate: "2026-12-01" }, crypto.randomUUID());
  expect(moved.status).toBe(409);
  expect(moved.body.error.code).toBe("cutover_locked");
  // The same date may be given again, for example to add an account that has statements.
  const again = await f.ok("cutover.set", {
    cutoverDate: "2026-11-01",
    accountIds: ["1000", "2000"],
  });
  expect(again.state.accounts.find((a: { code: string }) => a.code === "2000").chosen).toBe(true);
  expect((await f.ok("cutover.get", {})).notes.join(" ")).toContain("cannot move");
});

test("Stripe's first day moves with the cutover while nothing has been imported from it", async () => {
  const f = await shadowFixture();
  await f.ok("stripe.configure", { syncFrom: "2026-06-01" });
  const before = await f.ok("cutover.get", { cutoverDate: "2026-11-01" });
  expect(before.stripe).toMatchObject({ syncFrom: "2026-06-01", matches: false, fixed: false });
  expect(before.stripe.note).toContain("moves it to 2026-11-01");
  await f.ok("cutover.set", { cutoverDate: "2026-11-01" });
  const status = await f.ok("stripe.status", { books: false });
  expect(status.settings.syncFrom).toBe("2026-11-01");
  const after = await f.ok("cutover.get", {});
  expect(after.stripe).toMatchObject({ syncFrom: "2026-11-01", matches: true });
  // Stripe's own source is never given a start date by this lane.
  expect(after.sources.every((source: { provider: string }) => source.provider !== "stripe")).toBe(
    true,
  );
});

test("a first day the owner chose later than the cutover is left where it is", async () => {
  const f = await shadowFixture();
  await f.ok("stripe.configure", { syncFrom: "2026-11-15" });
  const before = await f.ok("cutover.get", { cutoverDate: "2026-11-01" });
  expect(before.stripe).toMatchObject({ syncFrom: "2026-11-15", matches: false, fixed: false });
  expect(before.stripe.note).toContain("later than the cutover date 2026-11-01");
  expect(before.stripe.note).toContain("recording the cutover leaves it");
  await f.ok("cutover.set", { cutoverDate: "2026-11-01" });
  expect((await f.ok("stripe.status", { books: false })).settings.syncFrom).toBe("2026-11-15");
  // Moving the cutover later than the first day it chose does move it: the first day was earlier.
  await f.ok("cutover.set", { cutoverDate: "2026-11-18" });
  expect((await f.ok("stripe.status", { books: false })).settings.syncFrom).toBe("2026-11-18");
});

test("Stripe connected after the cutover is recorded starts on the cutover date", async () => {
  const f = await shadowFixture();
  await f.ok("cutover.set", { cutoverDate: "2026-11-01" });
  const configured = await f.ok("stripe.configure", {});
  expect(configured.settings.syncFrom).toBe("2026-11-01");
  expect(configured.notes.join(" ")).toContain("Imports begin on 2026-11-01");
  // The owner's own choice still wins, and so does a later change to the cutover.
  const chosen = await f.ok("stripe.configure", { syncFrom: "2026-11-10" });
  expect(chosen.settings.syncFrom).toBe("2026-11-10");
  await f.ok("cutover.set", { cutoverDate: "2026-11-12" });
  expect((await f.ok("stripe.status", { books: false })).settings.syncFrom).toBe("2026-11-12");
});

test("with no cutover recorded Stripe starts on the book's first day, as it always did", async () => {
  const f = await shadowFixture();
  const configured = await f.ok("stripe.configure", {});
  expect(configured.settings.syncFrom).toBe("2026-01-01");
});

test("a cutover that has not come yet is not Stripe's first day", async () => {
  const f = await shadowFixture({ today: "2026-11-20" });
  await f.ok("cutover.set", { cutoverDate: "2026-12-15" });
  // Stripe cannot start on a day that has not come: the default stays the book's first day.
  expect((await f.ok("stripe.configure", {})).settings.syncFrom).toBe("2026-01-01");
  const state = await f.ok("cutover.get", {});
  expect(state.stripe).toMatchObject({ syncFrom: "2026-01-01", matches: false });
  expect(state.stripe.note).toContain("has not come yet");
  // Recording the date again changes nothing it could not do: no failure, the first day stays.
  await f.ok("cutover.set", { cutoverDate: "2026-12-16" });
  expect((await f.ok("stripe.status", { books: false })).settings.syncFrom).toBe("2026-01-01");
});

test("a book that does not use Stripe says nothing about it", async () => {
  const f = await shadowFixture();
  expect((await f.ok("cutover.get", {})).stripe).toBeNull();
});

test("hostile account text never reaches the sources or a note as anything but text", async () => {
  const f = await shadowFixture();
  const evil = `=HYPERLINK("http://example.invalid")‮`;
  await f.importLines("1000", [line("2026-10-02", "-20.00", evil)]);
  const result = await f.ok("cutover.set", { cutoverDate: "2026-11-01", accountIds: ["1000"] });
  expect(JSON.stringify(result)).not.toContain("HYPERLINK");
});

test("two requests at once leave the recorded date and the Inbox's start dates agreeing", async () => {
  const f = await shadowFixture();
  await f.importLines("1000", [
    line("2026-10-02", "-20.00", "Early"),
    line("2026-10-20", "-30.00", "Middle"),
    line("2026-11-03", "-40.00", "Late"),
  ]);
  const answers = await Promise.all([
    f.call("cutover.set", { cutoverDate: "2026-10-15", accountIds: ["1000"] }, crypto.randomUUID()),
    f.call("cutover.set", { cutoverDate: "2026-11-01", accountIds: ["1000"] }, crypto.randomUUID()),
    f.call("cutover.set", { cutoverDate: "2026-10-01", accountIds: ["1000"] }, crypto.randomUUID()),
  ]);
  expect(answers.every((answer) => answer.status === 200)).toBe(true);
  const state = await f.ok("cutover.get", {});
  expect(sourceOf(state, "csv:1000").startOn).toBe(state.cutover.cutoverDate);
});
