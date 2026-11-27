import { afterEach, expect, test } from "bun:test";
import { ApplicationHttp } from "../src/http.ts";
import type { LedgerEvent } from "../src/ingest-types.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS } from "../src/schema.ts";
import { registerProposer } from "../src/slices/ingest/proposers.ts";
import {
  batchOf,
  bankLine,
  closeFixtures,
  count,
  type Fixture,
  ingestFixture,
  itemRows,
  type Json,
  stripeEvent,
} from "./support/ingest-fixture.ts";

const undo: (() => void)[] = [];
afterEach(() => {
  closeFixtures();
  for (const work of undo.splice(0).reverse()) work();
});

const uuid = () => crypto.randomUUID();
const ACCOUNTS: Record<string, string> = {
  "stripe.balance": "1100",
  "stripe.fees": "5200",
  "revenue.sales": "4000",
  "payouts.in-transit": "1000",
};

/** What a Stripe proposer would do with a payout: book its whole entry. Records what it was asked. */
function stripeProposer(seen: string[]) {
  undo.push(
    registerProposer({
      name: "example.stripe",
      revision: () => "1",
      create: () => ({
        name: "example.stripe",
        propose: (item) => {
          if (item.line.kind !== "event") return [];
          seen.push(item.line.providerId);
          return [
            {
              proposer: "example.stripe",
              kind: "event" as const,
              confidence: 1,
              reasons: ["A payout, booked from the provider's own identifiers"],
              legs: item.line.legs.map((leg) => ({
                accountId: ACCOUNTS[leg.role] as string,
                amount: leg.amount,
              })),
            },
          ];
        },
      }),
    }),
  );
}

const charge = (id: string, coveredBy?: string, rawIndex = 0): LedgerEvent =>
  stripeEvent(
    id,
    "2026-03-03",
    [
      { role: "stripe.balance", amount: "97.10" },
      { role: "stripe.fees", amount: "2.90" },
      { role: "revenue.sales", amount: "-100.00" },
    ],
    rawIndex,
    coveredBy ? { coveredBy } : {},
  );

/** The payout that settles three charges: one entry for the whole payout. */
const payout = (rawIndex = 3): LedgerEvent =>
  stripeEvent(
    "po_1",
    "2026-03-05",
    [
      { role: "payouts.in-transit", amount: "291.30" },
      { role: "stripe.fees", amount: "8.70" },
      { role: "revenue.sales", amount: "-300.00" },
    ],
    rawIndex,
  );

let version = 0;
function submit(f: Fixture, lines: readonly LedgerEvent[]) {
  const raw = f.port.archive(new TextEncoder().encode(`batch ${version++}`), "application/json");
  return f.port.submit({
    provider: "stripe",
    sourceKey: "stripe:acct_1",
    raw,
    lines,
    balances: [],
    fetchedAt: "2026-03-06T00:00:00.000Z",
  });
}

const wholePayout = () => [
  charge("txn_1", "po_1", 0),
  charge("txn_2", "po_1", 1),
  charge("txn_3", "po_1", 2),
  payout(),
];

const list = async (f: Fixture, input: unknown = {}) =>
  (await f.call("inbox.list", input)).body.data as Json;
const act = async (f: Fixture, name: string, input: unknown) => {
  const reply = await f.call(name, input, uuid());
  expect(reply.body.ok, JSON.stringify(reply.body)).toBe(true);
  return reply.body.data as Json;
};
const idOf = (f: Fixture, providerId: string) =>
  itemRows(f, `provider_id='${providerId}'`)[0]?.id as string;

test("lines a payout books are stored and shown as evidence, not as work to review", async () => {
  const f = await ingestFixture();
  const seen: string[] = [];
  stripeProposer(seen);
  submit(f, wholePayout());
  const page = await list(f);
  expect(page.counts).toMatchObject({ total: 4, covered: 3, toReview: 1 });
  const children = page.items.filter((item: Json) => item.line.providerId !== "po_1");
  expect(children).toHaveLength(3);
  for (const child of children)
    expect(child.coveredBy).toEqual({
      providerId: "po_1",
      itemId: idOf(f, "po_1"),
      status: "proposed",
    });
  expect(
    page.items.find((item: Json) => item.line.providerId === "po_1").coveredBy,
  ).toBeUndefined();
  expect((await list(f, { filter: { covered: true } })).count).toBe(3);
  expect(
    (await list(f, { filter: { covered: false } })).items.map((item: Json) => item.line.providerId),
  ).toEqual(["po_1"]);
  // Only the payout is ever asked about: the lines it books decide nothing on their own.
  expect([...new Set(seen)]).toEqual(["po_1"]);
  const detail = (await f.call("inbox.get", { itemId: idOf(f, "po_1") })).body.data;
  expect(detail.coveredCount).toBe(3);
});

test("a line a payout books cannot be decided, excluded, restored or posted on its own", async () => {
  const f = await ingestFixture();
  stripeProposer([]);
  submit(f, wholePayout());
  const ids = ["txn_1", "txn_2"].map((id) => idOf(f, id));
  for (const [name, input] of [
    ["inbox.categorize", { accountId: "4000" }],
    ["inbox.accept", {}],
    ["inbox.exclude", { reason: "no" }],
    ["inbox.restore", { reason: "no" }],
    ["inbox.post", {}],
  ] as const) {
    const result = await act(f, name, { itemIds: ids, ...input });
    expect(
      result.results.map((entry: Json) => [entry.outcome, entry.code]),
      name,
    ).toEqual([
      ["skipped", "covered"],
      ["skipped", "covered"],
    ]);
    expect(result.results[0].message).toContain("po_1");
  }
  // A filter that matches them selects only the payout.
  const accepted = await act(f, "inbox.accept", { filter: { provider: "stripe" } });
  expect(accepted).toMatchObject({ applied: 1, remaining: 0 });
  expect(accepted.results[0].itemId).toBe(idOf(f, "po_1"));
});

test("accepting the payout drafts it and its lines under one draft, and posting it posts one entry", async () => {
  const f = await ingestFixture();
  stripeProposer([]);
  submit(f, wholePayout());
  await act(f, "inbox.accept", {
    filter: { provider: "stripe" },
    proposer: "example.stripe",
    minConfidence: 100,
  });
  expect(count(f, "app_drafts")).toBe(1);
  const drafted = await list(f, { filter: { status: ["drafted"] } });
  expect(drafted.count).toBe(4);
  expect(new Set(drafted.items.map((item: Json) => item.draftId)).size).toBe(1);
  expect(drafted.counts).toMatchObject({ drafted: 4, toReview: 0, covered: 0 });
  const post = await act(f, "inbox.post", { filter: { status: ["drafted"] } });
  expect(post).toMatchObject({ applied: 1, failed: 0, remaining: 0 });
  const posted = await list(f, { filter: { status: ["posted"] } });
  expect(posted.count).toBe(4);
  expect(new Set(posted.items.map((item: Json) => item.journalId)).size).toBe(1);
  expect((await f.call("journal.list", { status: "Posted" })).body.data.count).toBe(1);
  const journalId = posted.items[0].journalId;
  const journal = (await f.call("journal.get", { journalId })).body.data;
  expect(journal.narration).toBe("Stripe po_1");
  expect(journal.lines.map((line: Json) => [line.accountId, line.debit, line.credit])).toEqual([
    ["1000", "291.30", "0.00"],
    ["5200", "8.70", "0.00"],
    ["4000", "0.00", "300.00"],
  ]);
  // The lines show why they are posted and when.
  const child = (await f.call("inbox.get", { itemId: idOf(f, "txn_2") })).body.data;
  expect(child.item).toMatchObject({
    status: "posted",
    journalId,
    decision: { kind: "covered", coveredBy: idOf(f, "po_1") },
  });
  expect(child.history.map((entry: Json) => [entry.kind, entry.by])).toEqual([
    ["covered", "covered"],
    ["covered", "covered"],
  ]);
  // A sync that brings everything again changes nothing.
  const again = submit(f, wholePayout());
  expect(again.newCount).toBe(0);
  expect(again.duplicateCount).toBe(4);
  expect((await f.call("journal.list", { status: "Posted" })).body.data.count).toBe(1);
});

test("excluding a payout excludes its lines, and restoring it brings them all back", async () => {
  const f = await ingestFixture();
  stripeProposer([]);
  submit(f, wholePayout());
  await act(f, "inbox.exclude", { itemIds: [idOf(f, "po_1")], reason: "not this account's money" });
  const excluded = await list(f, { filter: { status: ["excluded"] } });
  expect(excluded.count).toBe(4);
  expect(
    excluded.items.find((item: Json) => item.line.providerId === "txn_1").exclusion,
  ).toMatchObject({
    code: "manual",
    reason: "Excluded with po_1.",
  });
  await act(f, "inbox.restore", { itemIds: [idOf(f, "po_1")], reason: "it was ours" });
  const back = await list(f);
  expect(back.counts).toMatchObject({ excluded: 0, covered: 3, toReview: 1 });
  expect(back.items.every((item: Json) => ["new", "proposed"].includes(item.status))).toBe(true);
});

test("restoring a drafted payout discards the one draft and returns its lines to review", async () => {
  const f = await ingestFixture();
  stripeProposer([]);
  submit(f, wholePayout());
  await act(f, "inbox.accept", { filter: { provider: "stripe" } });
  expect(count(f, "app_drafts")).toBe(1);
  const restored = await act(f, "inbox.restore", {
    itemIds: [idOf(f, "po_1")],
    reason: "wrong accounts",
  });
  expect(restored.results[0]).toMatchObject({ outcome: "applied", status: "new" });
  expect(count(f, "app_drafts")).toBe(0);
  const page = await list(f);
  expect(page.counts).toMatchObject({ drafted: 0, covered: 3, toReview: 1 });
  expect(page.items.every((item: Json) => item.draftId === undefined)).toBe(true);
});

test("a payout that arrives after its lines links them, and the link can be learned later", async () => {
  const f = await ingestFixture();
  stripeProposer([]);
  // The lines come first and know their payout; it has not been imported yet.
  submit(f, [charge("txn_1", "po_1", 0), charge("txn_2", "po_1", 1), charge("txn_3", "po_1", 2)]);
  let page = await list(f);
  expect(page.counts).toMatchObject({ total: 3, covered: 3, toReview: 0 });
  expect(page.items[0].coveredBy).toEqual({ providerId: "po_1" });
  // The payout arrives: the lines now point at it.
  submit(f, [payout(0)]);
  page = await list(f);
  expect(page.items.find((item: Json) => item.line.providerId === "txn_1").coveredBy.itemId).toBe(
    idOf(f, "po_1"),
  );
  expect(page.counts).toMatchObject({ covered: 3, toReview: 1 });
  // Lines imported without a payout are ordinary work until a later sync says which payout books them.
  const f2 = await ingestFixture();
  submit(f2, [charge("txn_1", undefined, 0), charge("txn_2", undefined, 1)]);
  expect((await list(f2)).counts).toMatchObject({ covered: 0, toReview: 2 });
  const learned = submit(f2, [charge("txn_1", "po_1", 0), charge("txn_2", "po_1", 1), payout(2)]);
  expect(learned.dispositions.map((entry) => entry.status)).toEqual([
    "duplicate",
    "duplicate",
    "new",
  ]);
  const after = await list(f2);
  expect(after.counts).toMatchObject({ total: 3, covered: 2, toReview: 1 });
  expect(count(f2, "app_ingest_conflicts")).toBe(0);
  // Their old suggestions went with the link.
  expect((await list(f2, { filter: { covered: true, hasProposal: true } })).count).toBe(0);
});

test("a payout that is already posted takes a late line with it, and one that was matched takes its lines", async () => {
  const f = await ingestFixture();
  stripeProposer([]);
  submit(f, [charge("txn_1", "po_1", 0), payout(1)]);
  await act(f, "inbox.accept", { filter: { provider: "stripe" } });
  await act(f, "inbox.post", { filter: { status: ["drafted"] } });
  submit(f, [charge("txn_9", "po_1", 2)]);
  const late = (await f.call("inbox.get", { itemId: idOf(f, "txn_9") })).body.data.item;
  expect(late).toMatchObject({
    status: "posted",
    journalId: itemRows(f, "provider_id='po_1'")[0]?.journal_id,
  });
});

test("only an event can be covered, and not by itself", async () => {
  const f = await ingestFixture();
  const batch = batchOf(f.port, [{ date: "2026-01-02", amount: "-4.50", description: "COFFEE" }]);
  const withCover = {
    ...bankLine({ date: "2026-01-02", amount: "-4.50", description: "COFFEE" }, 0),
    coveredBy: "po_1",
  };
  expect(f.port.preview({ ...batch, lines: [withCover] } as never).invalidCount).toBe(1);
  const self = charge("txn_1", "txn_1");
  const raw = f.port.archive(new TextEncoder().encode("{}"), "application/json");
  const base = {
    provider: "stripe",
    sourceKey: "stripe:acct_1",
    raw,
    balances: [],
    fetchedAt: "2026-03-06T00:00:00.000Z",
  };
  expect(f.port.preview({ ...base, lines: [self] }).invalidCount).toBe(1);
  expect(
    f.port.preview({ ...base, lines: [{ ...charge("txn_1"), coveredBy: "" }] }).invalidCount,
  ).toBe(1);
});

test("a connector's own source id and evidence text reach the posted journal", async () => {
  const f = await ingestFixture();
  stripeProposer([]);
  const evidence = "stripe:payout:po_1:members=3:sha256=0123abcd";
  submit(f, [
    charge("txn_1", "po_1", 0),
    { ...payout(1), sourceId: "stripe-payout-po_1", evidence },
  ]);
  await act(f, "inbox.accept", { filter: { provider: "stripe" } });
  const posted = await act(f, "inbox.post", { filter: { status: ["drafted"] } });
  const journal = (await f.call("journal.get", { journalId: posted.results[0].journalId })).body
    .data;
  expect(journal.source.id).toBe("stripe-payout-po_1");
  const detail = (await f.call("inbox.get", { itemId: idOf(f, "po_1") })).body.data;
  expect(detail.provenance.sourceEventId).toBe("stripe-payout-po_1");
  expect(detail.provenance.evidenceReference).toBe(
    `ingest:${detail.provenance.batchId}:1 ${evidence}`,
  );
  const source = (await f.call("sources.get", { sourceId: "stripe-payout-po_1" })).body.data;
  expect(source).toMatchObject({
    status: "posted",
    source: { evidenceReference: detail.provenance.evidenceReference },
  });
  // The same payout again is a duplicate by its provider id, and cannot take another line's source id.
  expect(
    submit(f, [{ ...payout(0), sourceId: "stripe-payout-po_1", evidence }]).duplicateCount,
  ).toBe(1);
  const clash = submit(f, [
    { ...payout(0), providerId: "po_2", sourceId: "stripe-payout-po_1" },
    { ...payout(1), providerId: "po_3", sourceId: "stripe-payout-po_3" },
    { ...payout(2), providerId: "po_4", sourceId: "stripe-payout-po_3" },
  ]);
  expect(clash.dispositions.map((entry) => entry.status)).toEqual(["invalid", "new", "invalid"]);
  expect(clash.dispositions[0]?.reason).toContain("already used");
  // The prefix for derived ids is reserved, and only an event carries these fields.
  const raw = f.port.archive(new TextEncoder().encode("{x}"), "application/json");
  const base = {
    provider: "stripe",
    sourceKey: "stripe:acct_1",
    raw,
    balances: [],
    fetchedAt: "2026-03-06T00:00:00.000Z",
  };
  expect(
    f.port.preview({
      ...base,
      lines: [{ ...payout(0), providerId: "po_9", sourceId: "ingest-stripe-abc" }],
    }).invalidCount,
  ).toBe(1);
  expect(
    f.port.preview({
      ...base,
      lines: [{ ...payout(0), providerId: "po_9", evidence: "x".repeat(301) }],
    }).invalidCount,
  ).toBe(1);
  const bank = {
    ...bankLine({ date: "2026-01-02", amount: "-4.50", description: "COFFEE" }, 0),
    evidence: "x",
  };
  expect(f.port.preview({ ...batchOf(f.port, []), lines: [bank] } as never).invalidCount).toBe(1);
});

test("the Inbox can narrow to one payout's lines, count what is postable, and filter by a proposer family", async () => {
  const f = await ingestFixture();
  stripeProposer([]);
  submit(f, wholePayout());
  expect((await list(f, { filter: { coveredBy: "po_1" } })).count).toBe(3);
  expect((await list(f, { filter: { coveredBy: "po_none" } })).count).toBe(0);
  await act(f, "inbox.accept", { filter: { provider: "stripe" } });
  expect((await list(f)).counts).toMatchObject({ drafted: 4, postable: 1, covered: 0 });
  const f2 = await ingestFixture();
  undo.push(
    registerProposer({
      name: "example.rules",
      revision: () => "1",
      create: () => ({
        name: "example.rules",
        propose: (item) =>
          item.line.kind === "bankLine" && item.ledgerAccountId
            ? [
                {
                  proposer: "rule:42",
                  kind: "categorize" as const,
                  confidence: 1,
                  reasons: ["Always"],
                  legs: [
                    { accountId: item.ledgerAccountId, amount: item.line.amount },
                    { accountId: "5000", amount: item.line.amount.slice(1) },
                  ],
                },
              ]
            : [],
      }),
    }),
  );
  f2.port.submit(
    batchOf(f2.port, [{ date: "2026-02-01", amount: "-5.00", description: "A" }], {
      ledgerAccountId: "1000",
    }),
  );
  const found = async (proposer: string) =>
    ((await f2.call("inbox.list", { filter: { proposer } })).body.data as Json).count;
  // A proposer's name also names its family, as it does for accept, and never works as a wildcard.
  expect(await found("rule:42")).toBe(1);
  expect(await found("rule")).toBe(1);
  expect(await found("ru")).toBe(0);
  expect(await found("ru%")).toBe(0);
});

test("the person or agent who acts is recorded on every decision", async () => {
  const f = await ingestFixture();
  // A real scoped token, used the way an agent uses it: a bearer credential on each request.
  const created = await f.call(
    "tokens.create",
    { label: "weekly routine", permissions: ["read", "draft", "post"] },
    uuid(),
  );
  expect(created.body.ok, JSON.stringify(created.body)).toBe(true);
  const { token: issued, secret } = created.body.data as { token: { id: string }; secret: string };
  const tokenId = issued.id;
  const http = new ApplicationHttp(f.service, {
    bookId: f.service.bookId,
    permissions: BUSINESS_PERMISSIONS,
  });
  const agent = async (name: string, input: unknown) => {
    const response = await http.fetch(
      new Request(`http://127.0.0.1:4010/v1/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
        body: JSON.stringify({
          version: APPLICATION_API_VERSION,
          bookId: f.service.bookId,
          input,
          operationId: uuid(),
        }),
      }),
    );
    return (await response.json()) as Json;
  };
  f.port.submit(
    batchOf(
      f.port,
      [
        { date: "2026-02-01", amount: "-5.00", description: "ONE" },
        { date: "2026-02-02", amount: "-6.00", description: "TWO" },
      ],
      { ledgerAccountId: "1000" },
    ),
  );
  const [one, two] = itemRows(f).map((row) => row.id as string) as [string, string];
  expect((await agent("inbox.categorize", { itemIds: [one], accountId: "5000" })).ok).toBe(true);
  // The agent holds no permission to exclude... it holds draft, so it may; the owner excludes the other.
  expect(
    (await f.call("inbox.exclude", { itemIds: [two], reason: "personal" }, uuid())).body.ok,
  ).toBe(true);
  expect((await agent("inbox.post", { itemIds: [one] })).ok).toBe(true);
  const by = `agent:${tokenId}`;
  const detail = (await f.call("inbox.get", { itemId: one })).body.data;
  expect(detail.item.decision).toMatchObject({ kind: "categorize", by: "manual", principal: by });
  expect(detail.history.map((entry: Json) => [entry.kind, entry.by])).toEqual([
    ["categorize", by],
    ["post", by],
  ]);
  const excluded = (await f.call("inbox.get", { itemId: two })).body.data;
  expect(excluded.history.map((entry: Json) => [entry.kind, entry.by])).toEqual([
    ["exclude", "owner"],
  ]);
  expect(excluded.item.decision).toMatchObject({ principal: "owner" });
});

test("a count that leaves out the lines a payout books is refused with what differs, not as a changed list", async () => {
  const f = await ingestFixture();
  stripeProposer([]);
  submit(f, wholePayout());
  await act(f, "inbox.accept", { filter: { provider: "stripe" } });
  // The person counted the one line to post, the payout. The filter matches it and its three lines.
  const refused = await f.call(
    "inbox.post",
    { filter: { status: ["drafted"] }, expectedCount: 1 },
    uuid(),
  );
  expect(refused.status).toBe(409);
  expect(refused.body.error.code).toBe("selection_changed");
  const message: string = refused.body.error.message;
  // Both counts, and what the lines are: one this call can post, three a payout books.
  expect(message).toContain("4 items match now, not the 1 you saw");
  expect(message).toContain("1 can be acted on by this call");
  expect(message).toContain("3 are booked with a payout");
  // It says the list may not have changed, and how to count the lines that matter.
  expect(message).toContain("the list may not have changed");
  expect(message).toContain('"covered": false');
  // The refusal is still a refusal: nothing was posted.
  expect((await f.call("journal.list", { status: "Posted" })).body.data.count).toBe(0);
  // Counting what can be acted on, or saying `covered: false`, goes through.
  const posted = await act(f, "inbox.post", {
    filter: { status: ["drafted"], covered: false },
    expectedCount: 1,
  });
  expect(posted).toMatchObject({ applied: 1, remaining: 0 });
  expect((await f.call("journal.list", { status: "Posted" })).body.data.count).toBe(1);
});

test("a count that includes lines this call cannot act on says how many, and a changed list still says so", async () => {
  const f = await ingestFixture();
  stripeProposer([]);
  submit(f, wholePayout());
  f.port.submit(
    batchOf(f.port, [{ date: "2026-03-04", amount: "-4.50", description: "COFFEE" }], {
      ledgerAccountId: "1000",
    }),
  );
  await act(f, "inbox.accept", { filter: { provider: "stripe" } });
  // Five lines match the empty filter: the payout (postable), its three lines (covered) and a new
  // bank line, which is not drafted and so is not for this call to post.
  const refused = await f.call("inbox.post", { filter: {}, expectedCount: 1 }, uuid());
  expect(refused.body.error.code).toBe("selection_changed");
  const message: string = refused.body.error.message;
  expect(message).toContain("5 items match now, not the 1 you saw");
  expect(message).toContain("1 can be acted on by this call");
  expect(message).toContain("3 are booked with a payout");
  expect(message).toContain("1 is in a status this call does not act on");
  // A number that is neither what can be acted on nor what is not covered is a list that changed.
  const changed = await f.call("inbox.post", { filter: {}, expectedCount: 9 }, uuid());
  expect(changed.body.error.code).toBe("selection_changed");
  expect(changed.body.error.message).toContain("5 items match now, not the 9 you saw");
  expect(changed.body.error.message).toContain("If the list has changed since you looked");
  expect(changed.body.error.message).not.toContain("may not have changed");
  expect((await f.call("journal.list", { status: "Posted" })).body.data.count).toBe(0);
});
