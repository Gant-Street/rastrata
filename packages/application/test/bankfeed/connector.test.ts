import { expect, test } from "bun:test";
import { BridgeBudgetSpent, BridgeError } from "../../src/bankfeed/client.ts";
import {
  type LinkedAccount,
  type PulledWindow,
  asConnector,
  createSimpleFinConnector,
  decodeCursor,
  encodeCursor,
  runWindow,
} from "../../src/bankfeed/connector.ts";
import { parseAccessUrl } from "../../src/bankfeed/credentials.ts";
import { type FakePort, fakePort } from "../stripe/fake-port.ts";
import {
  DAY,
  FIXTURE_PASSWORD,
  type FakeBridge,
  NOW,
  checking,
  day,
  fakeBridge,
  savings,
} from "./fake-bridge.ts";

const policy = { allowLoopback: false } as const;

const LINK: LinkedAccount = {
  accountId: "ACT-checking-0001",
  accountKey: "simplefin:ACT-checking-0001",
  ledgerAccountId: "1000",
  startOn: "2026-09-01",
  connId: "CON-bank-a",
};

function setup(bridge: FakeBridge = fakeBridge(), link: LinkedAccount = LINK, extra = {}) {
  const access = parseAccessUrl(bridge.accessUrl(), policy);
  if (!access) throw new Error("fixture access URL");
  const clock = { seconds: NOW };
  const now = () => new Date(clock.seconds * 1000).toISOString();
  const connector = createSimpleFinConnector(link, { bookCurrency: "USD" }, { access, ...extra });
  return { bridge, connector, port: fakePort(), clock, now, access };
}

type Setup = ReturnType<typeof setup>;

/** What the runner does with a connector: archive each window's bytes, submit its batch, and only
 * then remember its cursor. */
async function drain(s: Setup, cursor: string | null) {
  const windows: PulledWindow[] = [];
  let current = cursor;
  for await (const window of s.connector.pull(cursor, { fetch: s.bridge.fetch, now: s.now })) {
    const raw = s.port.archive(window.raw.bytes, window.raw.mediaType, window.raw.name);
    s.port.submit({ ...window.batch, raw });
    if (window.batch.cursor !== undefined) current = window.batch.cursor;
    windows.push(window);
  }
  return { windows, cursor: current };
}

const ids = (port: FakePort) =>
  [...port.items.values()].map((held) => (held.line as { providerId?: string }).providerId).sort();

test("the connector is the ingestion contract's Connector", () => {
  const { connector } = setup();
  expect(asConnector(connector).provider).toBe("simplefin");
});

test("a first pull reads the account from its first day to now and hands over exactly what the Bridge sent", async () => {
  const s = setup();
  const { windows, cursor } = await drain(s, null);
  expect(windows).toHaveLength(1);
  const [window] = windows;
  expect(window?.facts.window).toEqual({ from: day("2026-09-01", 0), to: NOW });
  expect(window?.facts.final).toBe(true);
  expect(window?.facts.advance).toBe(true);
  expect(window?.batch).toMatchObject({
    provider: "simplefin",
    sourceKey: LINK.accountKey,
    ledgerAccountId: "1000",
    fetchedAt: new Date(NOW * 1000).toISOString(),
  });
  expect(window?.batch.lines.map((l) => (l as { providerId: string }).providerId)).toEqual([
    "T-1001",
    "T-1002",
    "T-1003",
    "T-1004",
    "T-1005",
  ]);
  expect(window?.batch.balances).toEqual([
    { accountKey: LINK.accountKey, asOf: "2026-10-04", balance: "4021.35" },
  ]);
  expect(decodeCursor(cursor)).toEqual({ v: 1, through: NOW });
  expect(window?.raw.mediaType).toBe("application/json");
  expect(window?.raw.name).toMatch(/^simplefin-[0-9a-f]{8}-2026-09-01-2026-10-04\.json$/);
  // The archived bytes are the Bridge's answer and nothing else.
  expect(JSON.parse(new TextDecoder().decode(window?.raw.bytes))).toMatchObject({
    accounts: [{ id: LINK.accountId }],
  });
  expect(s.port.archived.size).toBe(1);
  expect(s.port.items.size).toBe(5);
});

test("only the linked account is ever asked for, by id, never the whole set", async () => {
  const s = setup();
  await drain(s, null);
  expect(s.bridge.log).toHaveLength(1);
  for (const request of s.bridge.log) {
    expect(request.query.account).toEqual([LINK.accountId]);
    expect(request.query["balances-only"]).toBeUndefined();
    expect(request.query.pending).toBeUndefined();
    expect(request.query.version).toEqual(["2"]);
  }
  // Nothing of the other account came in.
  expect(ids(s.port).some((id) => id?.startsWith("S-"))).toBe(false);
});

test("a long period is cut into windows of at most 45 days that tile it, oldest first", async () => {
  const s = setup(fakeBridge(), { ...LINK, startOn: "2026-04-01" });
  const { windows } = await drain(s, null);
  expect(windows.length).toBe(5);
  const spans = windows.map((w) => w.facts.window);
  expect(spans[0]?.from).toBe(day("2026-04-01", 0));
  expect(spans.at(-1)?.to).toBe(NOW);
  for (const [i, span] of spans.entries()) {
    expect(span.to - span.from).toBeLessThanOrEqual(45 * DAY);
    if (i > 0) expect(span.from).toBe(spans[i - 1]?.to ?? -1);
  }
  // What was asked is exactly what was tiled: start inclusive, end exclusive, whole seconds.
  expect(s.bridge.log.map((r) => [r.query["start-date"]?.[0], r.query["end-date"]?.[0]])).toEqual(
    spans.map((span) => [String(span.from), String(span.to)]),
  );
  // No request drew the Bridge's range warning.
  expect(windows.every((w) => w.facts.problems.length === 0)).toBe(true);
  // Only the last window carries the balance.
  expect(windows.map((w) => w.batch.balances.length)).toEqual([0, 0, 0, 0, 1]);
  // And each window's cursor is its own end.
  expect(windows.map((w) => decodeCursor(w.batch.cursor)?.through)).toEqual(
    spans.map((span) => span.to),
  );
});

test("an unchanged answer read again adds nothing, and every line stays unique", async () => {
  const s = setup();
  const first = await drain(s, null);
  const before = s.port.items.size;
  s.clock.seconds += 3600;
  const second = await drain(s, first.cursor);
  expect(s.port.items.size).toBe(before);
  const report = s.port.submissions.at(-1)?.report;
  expect(report?.newCount).toBe(0);
  // Only the last five days are read again: three of the five transactions fall in them.
  expect(report?.duplicateCount).toBe(3);
  expect(second.windows).toHaveLength(1);
});

test("a later run starts five days before its cursor, so a transaction posted late is found", async () => {
  const s = setup();
  const first = await drain(s, null);
  expect(decodeCursor(first.cursor)?.through).toBe(NOW);
  // Two days later the bank shows a transaction dated three days ago, which it had not posted before.
  s.clock.seconds = NOW + 2 * DAY;
  s.bridge.now = s.clock.seconds;
  s.bridge.accounts[0]?.transactions?.push({
    id: "LATE",
    posted: NOW - 3 * DAY,
    amount: "-7.00",
    description: "LATE POSTING",
  });
  const second = await drain(s, first.cursor);
  expect(second.windows[0]?.facts.window.from).toBe(NOW - 5 * DAY);
  expect(
    second.windows[0]?.batch.lines.map((l) => (l as { providerId: string }).providerId),
  ).toContain("LATE");
  expect(s.port.items.size).toBe(6);
  // Older than the overlap is not looked for again: that is what the five days buy, and no more.
  s.clock.seconds = NOW + 4 * DAY;
  s.bridge.accounts[0]?.transactions?.push({
    id: "TOO-LATE",
    posted: NOW - 20 * DAY,
    amount: "-1.00",
    description: "x",
  });
  await drain(s, second.cursor);
  expect(ids(s.port)).not.toContain("TOO-LATE");
});

test("a run never starts before the account's first day, however old the cursor is", () => {
  expect(
    runWindow({ startOn: "2026-09-01" }, { v: 1, through: day("2026-09-02", 0) }, NOW)?.from,
  ).toBe(day("2026-09-01", 0));
  expect(runWindow({ startOn: "2026-09-01" }, null, NOW)?.from).toBe(day("2026-09-01", 0));
  expect(
    runWindow({ startOn: "2026-09-01" }, { v: 1, through: day("2026-10-01", 0) }, NOW)?.from,
  ).toBe(day("2026-10-01", 0) - 5 * DAY);
  // A first day that has not come yet: nothing to read.
  expect(runWindow({ startOn: "2026-12-01" }, null, NOW)).toBeNull();
});

test("a first day in the future makes no request at all", async () => {
  const s = setup(fakeBridge(), { ...LINK, startOn: "2026-12-01" });
  const { windows } = await drain(s, null);
  expect(windows).toEqual([]);
  expect(s.bridge.log).toHaveLength(0);
});

test("an unreadable cursor starts over from the first day, which is safe", async () => {
  for (const bad of [
    "",
    "nonsense",
    "{}",
    '{"v":2,"through":1}',
    '{"v":1,"through":"x"}',
    '{"v":1,"through":1.5}',
  ]) {
    expect(decodeCursor(bad)).toBeNull();
  }
  const s = setup();
  const { windows } = await drain(s, "nonsense");
  expect(windows[0]?.facts.window.from).toBe(day("2026-09-01", 0));
  expect(decodeCursor(encodeCursor({ v: 1, through: 5 }))).toEqual({ v: 1, through: 5 });
});

test("pending transactions are neither asked for nor imported, even when the Bridge sends them unasked", async () => {
  const bridge = fakeBridge([
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
  ]);
  const s = setup(bridge);
  const { windows } = await drain(s, null);
  expect(ids(s.port)).toEqual(["OK-1"]);
  expect(bridge.log.every((r) => r.query.pending === undefined)).toBe(true);
  expect(windows[0]?.facts.counts.pending).toBe(0);

  // A server that sends them anyway: counted and left out.
  const sloppy = fakeBridge(bridge.accounts);
  sloppy.sloppy.sendPending = true;
  const t = setup(sloppy);
  const again = await drain(t, null);
  expect(ids(t.port)).toEqual(["OK-1"]);
  expect(again.windows[0]?.facts.counts.pending).toBe(2);
  expect(again.windows[0]?.facts.advance).toBe(true);
});

test("a window the Bridge says is incomplete does not move the cursor, and the run stops there", async () => {
  const s = setup(fakeBridge(), { ...LINK, startOn: "2026-04-01" });
  s.bridge.problems = [
    { code: "act.missingdata", msg: "Incomplete transaction listing.", account_id: LINK.accountId },
  ];
  const { windows, cursor } = await drain(s, null);
  // The first window was applied (its lines are real) but carried no cursor, and nothing followed it.
  expect(windows).toHaveLength(1);
  expect(windows[0]?.facts.advance).toBe(false);
  expect(windows[0]?.batch.cursor).toBeUndefined();
  expect(windows[0]?.facts.problems.map((p) => p.code)).toEqual(["act.missingdata"]);
  expect(cursor).toBeNull();
  expect(s.bridge.log).toHaveLength(1);
});

test("a problem about another account or another bank does not hold this account", async () => {
  const s = setup();
  s.bridge.problems = [
    { code: "act.failed", msg: "Failed.", account_id: "ACT-savings-0002" },
    { code: "con.auth", msg: "Sign in again.", conn_id: "CON-bank-b" },
  ];
  const { windows, cursor } = await drain(s, null);
  expect(windows[0]?.facts.advance).toBe(true);
  expect(decodeCursor(cursor)?.through).toBe(NOW);
  // It is still reported, so a person sees it.
  expect(windows[0]?.facts.problems).toHaveLength(2);
});

test("a problem about this account's bank, or about nothing in particular, holds the cursor", async () => {
  for (const problem of [
    { code: "con.auth", msg: "Sign in again.", conn_id: "CON-bank-a" },
    { code: "gen.api", msg: "Something about the request." },
    { msg: "A warning in the old shape." },
  ]) {
    const s = setup();
    s.bridge.problems = [problem];
    const { windows, cursor } = await drain(s, null);
    expect(windows[0]?.facts.advance).toBe(false);
    expect(cursor).toBeNull();
    // What did come is still applied; the balance of an incomplete answer is not offered as a check.
    expect(s.port.items.size).toBe(5);
    expect(windows[0]?.batch.balances).toEqual([]);
  }
});

test("warnings the Bridge puts in `errors` beside an `errlist` are read and hold the cursor", async () => {
  const s = setup();
  s.bridge.warnings = ["You are making more requests than expected."];
  const { windows } = await drain(s, null);
  expect(windows[0]?.facts.problems.map((p) => p.message)).toEqual([
    "You are making more requests than expected.",
  ]);
  expect(windows[0]?.facts.advance).toBe(false);
});

test("an account that is not in the answer is reported, imports nothing and stops", async () => {
  const s = setup(fakeBridge([savings()]));
  const { windows } = await drain(s, null);
  expect(windows).toHaveLength(1);
  expect(windows[0]?.facts.missing).toBe(true);
  expect(windows[0]?.facts.advance).toBe(false);
  expect(windows[0]?.facts.account).toBeNull();
  expect(s.port.items.size).toBe(0);
});

test("an account that now belongs to another bank connection is not read", async () => {
  const s = setup(fakeBridge([checking({ connId: "CON-bank-z" })]));
  const { windows } = await drain(s, null);
  expect(windows[0]?.facts.moved).toBe(true);
  expect(windows[0]?.facts.advance).toBe(false);
  expect(s.port.items.size).toBe(0);
});

test("an answer without a transaction list says nothing and moves nothing", async () => {
  const s = setup(fakeBridge([checking({ transactions: undefined as never })]));
  const bare = s.bridge.accounts[0];
  if (bare) delete (bare as { transactions?: unknown }).transactions;
  const { windows, cursor } = await drain(s, null);
  expect(windows[0]?.facts.advance).toBe(false);
  expect(cursor).toBeNull();
});

test("transactions dated after the window are read by a later run, never imported early", async () => {
  const bridge = fakeBridge([
    checking({
      transactions: [
        { id: "NOW", posted: NOW - 3600, amount: "-1.00", description: "an hour ago" },
        { id: "SOON", posted: NOW + 6 * 3600, amount: "-2.00", description: "later today" },
      ],
    }),
  ]);
  // A server that ignores end-date, like the Bridge's demo, which dates things after "now".
  bridge.sloppy.ignoreEnd = true;
  const s = setup(bridge);
  const { windows, cursor } = await drain(s, null);
  expect(ids(s.port)).toEqual(["NOW"]);
  expect(windows[0]?.facts.counts.afterWindow).toBe(1);
  expect(decodeCursor(cursor)?.through).toBe(NOW);
  // Later the day arrives and the five days before the cursor find it.
  s.clock.seconds = NOW + DAY;
  bridge.now = s.clock.seconds;
  await drain(s, cursor);
  expect(ids(s.port)).toEqual(["NOW", "SOON"]);
});

test("unreadable transactions are reported with their ids and never stop the account", async () => {
  const bridge = fakeBridge([
    checking({
      transactions: [
        { id: "GOOD", posted: day("2026-10-01"), amount: "-1.00", description: "ok" },
        { id: "FLOAT", posted: day("2026-10-01"), amount: -1.5 as never, description: "float" },
        { id: "THREE", posted: day("2026-10-01"), amount: "1.005", description: "three decimals" },
      ],
    }),
  ]);
  const s = setup(bridge);
  const { windows, cursor } = await drain(s, null);
  expect(ids(s.port)).toEqual(["GOOD"]);
  expect(windows[0]?.facts.held.map((h) => h.id)).toEqual(["FLOAT", "THREE"]);
  expect(windows[0]?.facts.advance).toBe(true);
  expect(decodeCursor(cursor)?.through).toBe(NOW);
});

test("another currency is carried as it is, flagged by nothing here, and no balance check is offered", async () => {
  const s = setup(fakeBridge([checking({ currency: "EUR" })]));
  const { windows } = await drain(s, null);
  expect(windows[0]?.batch.lines.every((l) => l.kind === "bankLine" && l.currency === "EUR")).toBe(
    true,
  );
  expect(windows[0]?.batch.balances).toEqual([]);
  expect(windows[0]?.facts.account?.currency).toBe("EUR");
});

test("an answer the connector cannot read is an error, not a window", async () => {
  const s = setup();
  s.bridge.respondOnce(200, { nonsense: true });
  let error: unknown;
  try {
    await drain(s, null);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(BridgeError);
  expect((error as BridgeError).code).toBe("bankfeed_bad_response");
});

test("a failure in the middle leaves the cursor at the last window that was applied", async () => {
  const s = setup(fakeBridge(), { ...LINK, startOn: "2026-04-01" });
  // Windows 1 and 2 answer; window 3 fails twice (the attempt and its retry).
  s.bridge.overrides.push(
    () => null,
    () => null,
  );
  s.bridge.respondOnce(500, "oops");
  s.bridge.respondOnce(500, "oops");
  let cursor: string | null = null;
  let applied = 0;
  let error: unknown;
  try {
    for await (const window of s.connector.pull(null, { fetch: s.bridge.fetch, now: s.now })) {
      const raw = s.port.archive(window.raw.bytes, window.raw.mediaType, window.raw.name);
      s.port.submit({ ...window.batch, raw });
      cursor = window.batch.cursor ?? cursor;
      applied += 1;
    }
  } catch (caught) {
    error = caught;
  }
  expect(applied).toBe(2);
  expect(error).toBeInstanceOf(BridgeError);
  // The cursor is the end of window 2: the next run starts there (less the overlap) and loses nothing.
  expect(decodeCursor(cursor)?.through).toBe(day("2026-04-01", 0) + 90 * DAY);
});

test("a spent budget stops the run between windows and the cursor holds", async () => {
  let requests = 0;
  const s = setup(
    fakeBridge(),
    { ...LINK, startOn: "2026-04-01" },
    {
      guard: () => {
        requests += 1;
        if (requests > 2) throw new BridgeBudgetSpent("call_budget");
      },
    },
  );
  let cursor: string | null = null;
  let thrown: unknown;
  try {
    for await (const window of s.connector.pull(null, { fetch: s.bridge.fetch, now: s.now })) {
      cursor = window.batch.cursor ?? cursor;
    }
  } catch (caught) {
    thrown = caught;
  }
  expect(thrown).toBeInstanceOf(BridgeBudgetSpent);
  expect(decodeCursor(cursor)?.through).toBe(day("2026-04-01", 0) + 90 * DAY);
});

test("the credential appears in no batch, name or cursor", async () => {
  const s = setup();
  const { windows, cursor } = await drain(s, null);
  const everything = JSON.stringify([
    windows.map((w) => ({ batch: w.batch, name: w.raw.name, facts: w.facts })),
    cursor,
  ]);
  expect(everything).not.toContain(FIXTURE_PASSWORD);
  expect(everything).not.toContain("Basic ");
  expect(everything).not.toContain("@beta-bridge");
});
