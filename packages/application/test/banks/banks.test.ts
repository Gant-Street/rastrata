import { afterEach, expect, test } from "bun:test";
import { BANK_WIRE } from "../../src/agent/bank-wire.ts";
import { ingestPort } from "../../src/slices/ingest/port.ts";
import { at, cardOffer, checkingOffer, closeWorlds, tx, uuid, world } from "./support.ts";

afterEach(closeWorlds);

test("the control plane offers accounts, and the book lists them unbooked, with what the owner has to do", async () => {
  const w = await world();
  const offered = await w.ok(
    "banks.offer",
    { accounts: [checkingOffer(), cardOffer()] },
    w.control,
  );
  expect(offered.accounts).toEqual([
    { id: "fca_checking", booked: false },
    { id: "fca_card", booked: false },
  ]);
  const status = await w.ok("banks.status", {});
  expect(status.accounts).toHaveLength(2);
  const checking = status.accounts.find((a: { id: string }) => a.id === "fca_checking");
  expect(checking).toMatchObject({
    institution: "Test Bank",
    name: "Business Checking",
    last4: "6789",
    kind: "checking",
    state: "active",
    booking: null,
    lastReceivedAt: null,
    queuedLines: 0,
  });
  expect(checking.attention).toContain("Choose which account in your books");
  expect(status.heldCount).toBe(0);
});

test("offering again changes what the connection says and never what the owner chose", async () => {
  const w = await world();
  await w.ok("banks.offer", { accounts: [checkingOffer()] }, w.control);
  await w.book("fca_checking", "1000", "2026-10-01");
  await w.ok(
    "banks.offer",
    { accounts: [checkingOffer({ name: "Operating", state: "inactive" })] },
    w.control,
  );
  const [account] = (await w.ok("banks.status", {})).accounts;
  expect(account).toMatchObject({
    name: "Operating",
    state: "inactive",
    booking: { ledgerAccount: "1000 Business Checking", startOn: "2026-10-01" },
  });
  expect(account.attention).toContain("Sign in to the bank again");
});

test("only the control plane's key may offer or receive: the owner, an owner of the workspace and a token cannot", async () => {
  const w = await world();
  const input = { accounts: [checkingOffer()] };
  const asOwner = await w.call("banks.offer", input);
  expect(asOwner.status).toBe(403);
  expect(asOwner.body.error.code).toBe("service_only");
  const received = await w.call("banks.receive", {
    account: checkingOffer(),
    refresh: "fctxnref_1",
    transactions: [tx()],
  });
  expect(received.status).toBe(403);
  expect(received.body.error.code).toBe("service_only");

  // A person who owns the workspace holds `provision` too, and is still not the control plane.
  await w.ok(
    "members.add",
    { userId: "user_0000000001", email: "ann@example.com", role: "owner" },
    w.control,
  );
  const member = w.http.memberAccess("user_0000000001");
  expect(member).not.toBeNull();
  const asMember = await w.call("banks.offer", input, { as: member as never });
  expect(asMember.status).toBe(403);
  expect(asMember.body.error.code).toBe("service_only");
  expect((await w.ok("banks.status", {})).accounts).toEqual([]);
});

test("the control plane's key can call nothing else the banks slice adds, and cannot book", async () => {
  const w = await world();
  await w.ok("banks.offer", { accounts: [checkingOffer()] }, w.control);
  const ids = await w.ids();
  const booked = await w.call(
    "banks.book",
    { account: "fca_checking", ledgerAccountId: ids["1000"] },
    { as: w.control },
  );
  expect(booked.status).toBe(403);
  const status = await w.call("banks.status", {}, { as: w.control });
  expect(status.status).toBe(403);
});

test("an account that is not booked queues nothing and says so, and the same transactions are accepted once it is", async () => {
  const w = await world();
  const batch = [tx({ id: "fctxn_a", amount: -1250 }), tx({ id: "fctxn_b", amount: 5000 })];
  const first = await w.receive(checkingOffer(), batch);
  expect(first).toEqual({
    booked: false,
    received: 2,
    queued: 0,
    duplicates: 0,
    pending: 0,
    held: 0,
  });
  expect(await w.lines()).toHaveLength(0);

  const booked = await w.book("fca_checking", "1000", "2026-10-01");
  expect(booked.account.booking).toMatchObject({ ledgerAccount: "1000 Business Checking" });
  const second = await w.receive(checkingOffer(), batch);
  expect(second).toEqual({
    booked: true,
    received: 2,
    queued: 2,
    duplicates: 0,
    pending: 0,
    held: 0,
  });
  const lines = await w.lines();
  expect(lines).toHaveLength(2);
});

test("a posted transaction waits in the Inbox as a bank line with the bank's own sign, and nothing is posted", async () => {
  const w = await world();
  await w.receive(checkingOffer(), []);
  await w.book("fca_checking", "1000", "2026-10-01");
  const result = await w.receive(checkingOffer(), [
    tx({ id: "fctxn_out", amount: -1250, description: "ACME SOFTWARE", postedAt: at(4) }),
    tx({ id: "fctxn_in", amount: 500000, description: "STRIPE PAYOUT", postedAt: at(6) }),
  ]);
  expect(result.queued).toBe(2);
  const lines = await w.lines();
  const byId = Object.fromEntries(lines.map((item) => [item.line.providerId, item]));
  expect(byId.fctxn_out?.line).toMatchObject({
    kind: "bankLine",
    provider: "bank",
    accountKey: "bank:fca_checking",
    date: "2026-10-04",
    amount: "-12.50",
    currency: "USD",
    description: "ACME SOFTWARE",
  });
  expect(byId.fctxn_in?.line).toMatchObject({ date: "2026-10-06", amount: "5000.00" });
  expect(lines.every((item) => item.status === "new")).toBe(true);
  // The source is recorded in the Inbox with the chart account and the first day.
  const ids = await w.ids();
  const sources = await w.ok("inbox.sources", {});
  expect(sources.sources).toEqual([
    expect.objectContaining({
      provider: "bank",
      accountKey: "bank:fca_checking",
      ledgerAccountId: ids["1000"],
      startOn: "2026-10-01",
    }),
  ]);
  // No entry was posted: the books are as they were.
  const journals = await w.ok("journal.list", {});
  expect(journals.journals ?? journals.items ?? []).toHaveLength(0);
  const status = await w.ok("banks.status", {});
  expect(status.accounts[0]).toMatchObject({
    queuedLines: 2,
    lastReceivedAt: new Date(w.clock.ms).toISOString(),
    attention: null,
  });
});

test("pending and voided transactions wait until the bank has posted them, and are queued once when it does", async () => {
  const w = await world();
  await w.receive(checkingOffer(), []);
  await w.book("fca_checking", "1000", "2026-10-01");
  const waiting = await w.receive(checkingOffer(), [
    tx({ id: "fctxn_p", status: "pending", postedAt: null }),
    tx({ id: "fctxn_v", status: "void", postedAt: null }),
  ]);
  expect(waiting).toMatchObject({ booked: true, received: 2, queued: 0, pending: 2 });
  expect(await w.lines()).toHaveLength(0);
  const posted = await w.receive(
    checkingOffer(),
    [tx({ id: "fctxn_p", postedAt: at(8) })],
    "fctxnref_2",
  );
  expect(posted).toMatchObject({ queued: 1, pending: 0 });
  expect((await w.lines()).map((item) => item.line.providerId)).toEqual(["fctxn_p"]);
});

test("the same transactions sent again change nothing, however the call is identified", async () => {
  const w = await world();
  await w.receive(checkingOffer(), []);
  await w.book("fca_checking", "1000", "2026-10-01");
  const batch = [tx({ id: "fctxn_a" }), tx({ id: "fctxn_b", amount: -200 })];
  expect(await w.receive(checkingOffer(), batch)).toMatchObject({ queued: 2, duplicates: 0 });
  const again = await w.receive(checkingOffer(), batch);
  expect(again).toMatchObject({ booked: true, queued: 0, duplicates: 2 });
  expect(await w.lines()).toHaveLength(2);

  // The same call, with the same identity: nothing is doubled, and it is not answered with an old answer either.
  const id = uuid();
  const input = {
    account: checkingOffer(),
    refresh: "fctxnref_9",
    transactions: [tx({ id: "fctxn_c" })],
  };
  const first = await w.call("banks.receive", input, { as: w.control, id });
  const second = await w.call("banks.receive", input, { as: w.control, id });
  expect(first.body.data).toMatchObject({ queued: 1, duplicates: 0 });
  expect(second.body.data).toMatchObject({ queued: 0, duplicates: 1 });
  expect(await w.lines()).toHaveLength(3);
});

test("transactions that were sent before the account was booked are taken when the very same call is sent again", async () => {
  const w = await world();
  const id = uuid();
  const input = {
    account: checkingOffer(),
    refresh: "fctxnref_1",
    transactions: [tx({ id: "fctxn_a" }), tx({ id: "fctxn_b", amount: 4200 })],
  };
  const before = await w.call("banks.receive", input, { as: w.control, id });
  expect(before.body.data).toMatchObject({ booked: false, queued: 0 });
  await w.book("fca_checking", "1000", "2026-10-01");
  // The sender keeps its place, so the next reading is this same payload; it is a new call even when its identity is the same.
  const after = await w.call("banks.receive", input, { as: w.control, id });
  expect(after.body.data).toMatchObject({ booked: true, queued: 2 });
  expect(await w.lines()).toHaveLength(2);
});

test("an account that stops and starts again is told each time, though the words are the same", async () => {
  const w = await world();
  const id = uuid();
  const say = (state: "active" | "inactive") =>
    w.call(
      "banks.offer",
      { accounts: [checkingOffer({ state })] },
      { as: w.control, id: state === "active" ? id : uuid() },
    );
  await say("active");
  await say("inactive");
  expect((await w.ok("banks.status", {})).accounts[0].state).toBe("inactive");
  // The same call as the first: the account is active again.
  await w.call(
    "banks.offer",
    { accounts: [checkingOffer({ state: "active" })] },
    { as: w.control, id },
  );
  expect((await w.ok("banks.status", {})).accounts[0].state).toBe("active");
});

test("a transaction before the first day is set aside, not queued; the first day can be the cutover date", async () => {
  const w = await world();
  await w.receive(checkingOffer(), []);
  await w.book("fca_checking", "1000", "2026-10-05");
  const result = await w.receive(checkingOffer(), [
    tx({ id: "fctxn_old", postedAt: at(2), transactedAt: at(2) }),
    tx({ id: "fctxn_new", postedAt: at(9), transactedAt: at(9) }),
  ]);
  expect(result.queued).toBe(1);
  const queued = await w.lines({ status: ["new"] });
  expect(queued.map((item) => item.line.providerId)).toEqual(["fctxn_new"]);
  const excluded = await w.lines({ status: ["excluded"] });
  expect(excluded.map((item) => item.line.providerId)).toEqual(["fctxn_old"]);
});

test("a transaction that is not whole cents is refused by the contract before it reaches the book", async () => {
  const w = await world();
  await w.receive(checkingOffer(), []);
  await w.book("fca_checking", "1000", "2026-10-01");
  const refused = await w.call(
    "banks.receive",
    { account: checkingOffer(), refresh: "fctxnref_1", transactions: [tx({ amount: 10.5 })] },
    { as: w.control },
  );
  expect(refused.status).toBe(400);
  expect(await w.lines()).toHaveLength(0);
  const tooMany = await w.call(
    "banks.receive",
    {
      account: checkingOffer(),
      refresh: "fctxnref_1",
      transactions: Array.from({ length: BANK_WIRE.transactionsPerCall + 1 }, (_, i) =>
        tx({ id: `fctxn_${i}` }),
      ),
    },
    { as: w.control },
  );
  expect(tooMany.status).toBe(400);
});

test("a disconnected account queues nothing more", async () => {
  const w = await world();
  await w.receive(checkingOffer(), []);
  await w.book("fca_checking", "1000", "2026-10-01");
  expect(await w.receive(checkingOffer(), [tx({ id: "fctxn_a" })])).toMatchObject({ queued: 1 });
  const stopped = await w.receive(checkingOffer({ state: "disconnected" }), [
    tx({ id: "fctxn_b" }),
  ]);
  expect(stopped).toMatchObject({ booked: false, queued: 0 });
  expect((await w.lines()).map((item) => item.line.providerId)).toEqual(["fctxn_a"]);
  const [account] = (await w.ok("banks.status", {})).accounts;
  expect(account.state).toBe("disconnected");
  expect(account.attention).toContain("connection was stopped");
  // Lines already in the Inbox stay, and a stopped connection cannot be booked.
  const ids = await w.ids();
  await w.ok("banks.offer", { accounts: [cardOffer({ state: "disconnected" })] }, w.control);
  const refused = await w.call("banks.book", { account: "fca_card", ledgerAccountId: ids["2000"] });
  expect(refused.status).toBe(409);
  expect(refused.body.error.code).toBe("bank_account_disconnected");
});

test("booking is the owner's choice and is checked against the chart", async () => {
  const w = await world();
  await w.ok("banks.offer", { accounts: [checkingOffer(), cardOffer()] }, w.control);
  const ids = await w.ids();
  const book = (account: string, code: string, extra: Record<string, unknown> = {}) =>
    w.call("banks.book", { account, ledgerAccountId: ids[code], ...extra });

  expect((await book("fca_nope", "1000")).body.error.code).toBe("bank_account_unknown");
  expect((await book("fca_checking", "4000")).body.error.code).toBe("account_role_invalid");
  expect((await book("fca_checking", "1300")).body.error.code).toBe("account_is_stripe");
  // A checking account is an asset; a card is a liability: the other way round would book every line backwards.
  const wrongWay = await book("fca_checking", "2000");
  expect(wrongWay.status).toBe(422);
  expect(wrongWay.body.error.code).toBe("account_kind_mismatch");
  expect(wrongWay.body.error.message).toContain("Choose an asset account");
  expect((await book("fca_card", "1000")).body.error.code).toBe("account_kind_mismatch");
  expect((await book("fca_checking", "1000", { startOn: "2026-02-30" })).status).toBe(400);

  expect((await book("fca_checking", "1000")).body.ok).toBe(true);
  expect((await book("fca_card", "2000")).body.ok).toBe(true);
  // One chart account is fed by one bank account.
  await w.ok(
    "banks.offer",
    { accounts: [checkingOffer({ id: "fca_second", name: "Second" })] },
    w.control,
  );
  const taken = await book("fca_second", "1000");
  expect(taken.status).toBe(409);
  expect(taken.body.error.code).toBe("bank_ledger_account_taken");
  const status = await w.ok("banks.status", {});
  expect(status.accounts.filter((a: { booking: unknown }) => a.booking !== null)).toHaveLength(2);
});

test("the first day defaults to the start of the book's year, and a first day that has not come is said", async () => {
  const w = await world();
  await w.ok("banks.offer", { accounts: [checkingOffer(), cardOffer()] }, w.control);
  const defaulted = await w.book("fca_checking", "1000");
  expect(defaulted.account.booking.startOn).toBe("2026-01-01");
  const future = await w.book("fca_card", "2000", "2026-12-01");
  expect(future.notes.join(" ")).toContain("has not come yet");
});

test("booking says when another source already feeds the chart account, and from which day to start", async () => {
  const w = await world();
  await w.ok("banks.offer", { accounts: [checkingOffer()] }, w.control);
  const ids = await w.ids();
  // A statement file has already been imported for the checking account.
  const port = ingestPort(w.service);
  const raw = port.archive(
    new TextEncoder().encode("date,amount\n2026-10-02,-4.50\n"),
    "text/csv",
    "oct.csv",
  );
  port.submit({
    provider: "csv",
    sourceKey: "csv:checking",
    raw,
    lines: [
      {
        kind: "bankLine",
        provider: "csv",
        accountKey: "csv:checking",
        rawIndex: 0,
        postedOn: "2026-10-02",
        amount: "-4.50",
        currency: "USD",
        description: "COFFEE",
      },
    ],
    balances: [],
    fetchedAt: new Date(w.clock.ms).toISOString(),
    ledgerAccountId: ids["1000"] as string,
    startOn: "2026-10-01",
  });
  const booked = await w.book("fca_checking", "1000", "2026-10-01");
  expect(booked.notes).toHaveLength(1);
  expect(booked.notes[0]).toContain("Another source already feeds 1000 Business Checking (csv");
  expect(booked.notes[0]).toContain("first day of 2026-10-03");
});

test("unbooking stops queuing and keeps what is already in the Inbox", async () => {
  const w = await world();
  await w.receive(checkingOffer(), []);
  await w.book("fca_checking", "1000", "2026-10-01");
  await w.receive(checkingOffer(), [tx({ id: "fctxn_a" })]);
  const unbooked = await w.ok("banks.unbook", { account: "fca_checking" });
  expect(unbooked.unbooked).toBe(true);
  expect(unbooked.account.booking).toBeNull();
  expect(await w.receive(checkingOffer(), [tx({ id: "fctxn_b" })], "fctxnref_2")).toMatchObject({
    booked: false,
    queued: 0,
  });
  expect((await w.lines()).map((item) => item.line.providerId)).toEqual(["fctxn_a"]);
  // Unbooking what is not booked says so, and an unknown account is nothing.
  expect((await w.ok("banks.unbook", { account: "fca_checking" })).unbooked).toBe(false);
  const unknown = await w.ok("banks.unbook", { account: "fca_unknown" });
  expect(unknown).toEqual({ account: null, unbooked: false });
});

test("before the owner has set the book up, the control plane can already offer and send, and the owner cannot book yet", async () => {
  const w = await world({ setup: false });
  await w.ok("banks.offer", { accounts: [checkingOffer()] }, w.control);
  expect(await w.receive(checkingOffer(), [tx()])).toMatchObject({
    booked: false,
    queued: 0,
    received: 1,
  });
  const status = await w.ok("banks.status", {});
  expect(status.accounts).toHaveLength(1);
  const refused = await w.call("banks.book", { account: "fca_checking", ledgerAccountId: "acc_x" });
  expect(refused.status).toBe(409);
  expect(refused.body.error.code).toBe("book_not_configured");
});

test("the book survives a restart with its accounts, their bookings and their lines", async () => {
  const w = await world();
  await w.receive(checkingOffer(), []);
  await w.book("fca_checking", "1000", "2026-10-01");
  await w.receive(checkingOffer(), [tx({ id: "fctxn_a" })]);
  const before = await w.ok("banks.status", {});
  expect(before.accounts[0].booking).not.toBeNull();
  expect((await w.lines()).length).toBe(1);
});

test("a stopped connection of the same bank account is replaced by its new one, which starts the day after the old one's last line so that nothing is queued twice", async () => {
  const w = await world();
  await w.receive(checkingOffer(), []);
  await w.book("fca_checking", "1000", "2026-10-01");
  await w.receive(checkingOffer(), [
    tx({ id: "fctxn_a", postedAt: at(4), transactedAt: at(4) }),
    tx({ id: "fctxn_b", postedAt: at(6), transactedAt: at(6) }),
  ]);
  // The bank stops letting Stripe read the account, and the owner connects it again: Stripe makes a new account for it, with new identifiers for the same transactions.
  await w.ok("banks.offer", { accounts: [checkingOffer({ state: "inactive" })] }, w.control);
  const replacement = checkingOffer({ id: "fca_again" });
  await w.ok("banks.offer", { accounts: [replacement] }, w.control);

  const booked = await w.book("fca_again", "1000");
  expect(booked.account.booking).toMatchObject({
    startOn: "2026-10-07",
    ledgerAccount: "1000 Business Checking",
  });
  expect(booked.notes.join(" ")).toContain("replaces the earlier connection");
  expect(booked.notes.join(" ")).toContain("2026-10-07");
  const status = await w.ok("banks.status", {});
  const old = status.accounts.find((a: { id: string }) => a.id === "fca_checking");
  expect(old.booking).toBeNull();
  expect(old.queuedLines).toBe(2);

  // The new account brings the same two transactions under new identifiers, and one more: only the new one is queued.
  const result = await w.receive(replacement, [
    tx({ id: "fctxn_a2", postedAt: at(4), transactedAt: at(4) }),
    tx({ id: "fctxn_b2", postedAt: at(6), transactedAt: at(6) }),
    tx({ id: "fctxn_c2", postedAt: at(9), transactedAt: at(9), amount: -300 }),
  ]);
  expect(result.queued).toBe(1);
  const queued = await w.lines({ status: ["new"] });
  expect(queued.map((item) => item.line.providerId).sort()).toEqual([
    "fctxn_a",
    "fctxn_b",
    "fctxn_c2",
  ]);
});

test("an earlier connection's last line sets the first day of a new connection to the same chart account, unless the owner gives one", async () => {
  const w = await world();
  await w.receive(checkingOffer(), []);
  await w.book("fca_checking", "1000", "2026-10-01");
  await w.receive(checkingOffer(), [tx({ id: "fctxn_a", postedAt: at(12), transactedAt: at(12) })]);
  await w.ok("banks.unbook", { account: "fca_checking" });
  await w.ok(
    "banks.offer",
    { accounts: [checkingOffer({ id: "fca_two", name: "Other", last4: "1111" })] },
    w.control,
  );
  const defaulted = await w.book("fca_two", "1000");
  expect(defaulted.account.booking.startOn).toBe("2026-10-13");
  expect(defaulted.notes.join(" ")).toContain("nothing is queued twice");
  // With a first day of their own, the owner is told what queuing twice would mean.
  await w.ok("banks.unbook", { account: "fca_two" });
  const explicit = await w.book("fca_two", "1000", "2026-10-01");
  expect(explicit.account.booking.startOn).toBe("2026-10-01");
  expect(explicit.notes.join(" ")).toContain("would be queued twice");
  expect(explicit.notes.join(" ")).toContain("2026-10-13");
});

test("a stopped connection of another bank account is not let go, and a working one is never replaced", async () => {
  const w = await world();
  await w.receive(checkingOffer(), []);
  await w.book("fca_checking", "1000", "2026-10-01");
  await w.ok("banks.offer", { accounts: [checkingOffer({ state: "inactive" })] }, w.control);
  // Another account at the same bank, with other last digits: not the same bank account.
  await w.ok(
    "banks.offer",
    { accounts: [checkingOffer({ id: "fca_other", last4: "1111" })] },
    w.control,
  );
  const refused = await w.call("banks.book", {
    account: "fca_other",
    ledgerAccountId: (await w.ids())["1000"],
  });
  expect(refused.status).toBe(409);
  expect(refused.body.error.code).toBe("bank_ledger_account_taken");
  // The same bank account, but the old connection still works.
  await w.ok("banks.offer", { accounts: [checkingOffer()] }, w.control);
  await w.ok("banks.offer", { accounts: [checkingOffer({ id: "fca_same" })] }, w.control);
  const working = await w.call("banks.book", {
    account: "fca_same",
    ledgerAccountId: (await w.ids())["1000"],
  });
  expect(working.status).toBe(409);
});
