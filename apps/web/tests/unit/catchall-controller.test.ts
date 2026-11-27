import { describe, expect, test } from "bun:test";
import { API_VERSION } from "@rastrata/application/client-contracts";
import type {
  InboxRecategorizeReport,
  InboxRecategorizeResult,
} from "@rastrata/application/client-contracts";
import type { ApplicationFetch } from "../../src/application-client";
import { BrowserApplicationClient } from "../../src/application-client";
import {
  CHANGE_WORKFLOW,
  createChangeAccountController,
  MOST_AT_ONCE,
  moveRow,
  PLAN_WORKFLOW,
  TURN,
  waitingChange,
} from "../../src/routes/accounting/change-account";
import { filtersFromAddress } from "../../src/routes/accounting/journal-address";
import { createWatchController, watchedFor, watchOffered } from "../../src/routes/accounting/watch";

// What the Transactions screen decides without a browser: how the service's answer about one transaction
// becomes a row, how a change of account is planned and sent in turns, what a lost reply leaves behind, and
// which accounts the chart offers to watch.

const CHART = [
  { id: "6290", code: "6290", name: "Other expenses", role: "expense" },
  { id: "6200", code: "6200", name: "Software and subscriptions", role: "expense" },
];

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

type Body = { operationId: string; input: Record<string, unknown> };
type Answer = { ok: true; data: InboxRecategorizeReport } | { ok: false; code: string } | "lost";

/** A service that answers the requests it is sent, one scripted answer each, and keeps what it was sent. */
function service(answers: Answer[]) {
  const sent: Body[] = [];
  const fetcher = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Body;
    sent.push(body);
    const answer = answers.shift();
    if (answer === undefined || answer === "lost") throw new Error("The connection dropped");
    if (!answer.ok)
      return Response.json(
        {
          version: API_VERSION,
          bookId: "local-book",
          ok: false,
          operationId: body.operationId,
          error: {
            code: answer.code,
            message: `Refused: ${answer.code}`,
            retryable: false,
            details: [],
          },
        },
        { status: answer.code === "permission_denied" ? 403 : 400 },
      );
    return Response.json({
      version: API_VERSION,
      bookId: "local-book",
      ok: true,
      operationId: body.operationId,
      data: answer.data,
    });
  }) as ApplicationFetch;
  return { sent, fetcher };
}

const result = (
  journalId: string,
  outcome: InboxRecategorizeResult["outcome"],
  rest: Partial<InboxRecategorizeResult> = {},
): InboxRecategorizeResult => ({
  journalId,
  outcome,
  fromAccountId: "6290",
  toAccountId: "6200",
  date: "2026-03-02",
  amount: "-52.99",
  description: `Charge ${journalId}`,
  ...rest,
});

const report = (
  results: InboxRecategorizeResult[],
  rest: Partial<InboxRecategorizeReport> = {},
): InboxRecategorizeReport => ({
  dryRun: false,
  target: { accountId: "6200", code: "6200", name: "Software and subscriptions" },
  results,
  would: results.filter((r) => r.outcome === "would_apply").length,
  applied: results.filter((r) => r.outcome === "applied").length,
  skipped: results.filter((r) => r.outcome === "skipped").length,
  failed: results.filter((r) => r.outcome === "failed").length,
  remaining: 0,
  next: null,
  ...rest,
});

const plan = (results: InboxRecategorizeResult[], rest: Partial<InboxRecategorizeReport> = {}) =>
  report(results, { dryRun: true, ...rest });

function controller(store: ReturnType<typeof storage>, answers: Answer[]) {
  const { sent, fetcher } = service(answers);
  const client = new BrowserApplicationClient(store, fetcher);
  const moved: { moved: number; target: string }[] = [];
  const c = createChangeAccountController({
    client,
    accounts: () => CHART,
    accountsState: () => "ready",
    loadAccounts: () => {},
    onMoved: (count, target) => void moved.push({ moved: count, target }),
  });
  return { c, client, sent, moved };
}

const ids = (count: number, prefix = "j") =>
  Array.from({ length: count }, (_, i) => `${prefix}${i}`);

describe("a transaction as the dialog shows it", () => {
  const names = (id: string | undefined) => CHART.find((account) => account.id === id)?.name;

  test("the service's answer becomes a row with the accounts by name and its words made plain", () => {
    expect(
      moveRow(
        result("j1", "skipped", {
          message: "February 2026 is closed (Reopen on the Periods screen, or periods.prepare).",
          warnings: [
            { code: "cleared_posting_corrected", message: "On a finished reconciliation." },
          ],
        }),
        names,
      ),
    ).toEqual({
      id: "j1",
      outcome: "skipped",
      date: "2026-03-02",
      description: "Charge j1",
      amount: "-52.99",
      from: "Other expenses",
      to: "Software and subscriptions",
      why: "February 2026 is closed.",
      warnings: ["On a finished reconciliation."],
      left: undefined,
    });
  });

  test("a transaction that failed after its old entry was reversed says where it was left", () => {
    const failed = (status: "new" | "drafted") =>
      moveRow(result("j1", "failed", { reversalJournalId: "r1", status }), names).left;
    expect(failed("new")).toBe("review");
    expect(failed("drafted")).toBe("ready");
    // A failure before anything was reversed leaves the transaction where it was.
    expect(moveRow(result("j1", "failed"), names).left).toBeUndefined();
    expect(moveRow(result("j1", "applied"), names).left).toBeUndefined();
  });

  test("a result with no entry is named by its Inbox line, and one with neither is not lost", () => {
    expect(moveRow({ itemId: "item-1", outcome: "skipped" }, names).id).toBe("item-1");
    expect(moveRow({ outcome: "skipped" }, names).id).toBe("");
  });
});

describe("the address of the Transactions list", () => {
  test("it asks for the account and the dates, and nothing else", () => {
    expect(
      filtersFromAddress("?accountId=6290&from=2026-03-01&to=2026-03-31&text=x&page=9"),
    ).toEqual({
      accountId: "6290",
      from: "2026-03-01",
      to: "2026-03-31",
    });
    expect(filtersFromAddress("")).toEqual({ accountId: "", from: "", to: "" });
  });

  test("a range is two days in order; anything else is the whole list", () => {
    const none = { accountId: "6290", from: "", to: "" };
    expect(filtersFromAddress("?accountId=6290&from=2026-03-01")).toEqual(none);
    expect(filtersFromAddress("?accountId=6290&to=2026-03-31")).toEqual(none);
    expect(filtersFromAddress("?accountId=6290&from=2026-04-01&to=2026-03-01")).toEqual(none);
    expect(filtersFromAddress("?accountId=6290&from=March&to=2026-03-31")).toEqual(none);
    expect(filtersFromAddress("?accountId=6290&from=2026-02-30&to=2026-03-31")).toEqual(none);
  });

  test("an account is carried as text and cut to a sane length", () => {
    expect(filtersFromAddress(`?accountId=${"x".repeat(500)}`).accountId).toHaveLength(200);
    expect(filtersFromAddress("?accountId=a%26b%3Dc").accountId).toBe("a&b=c");
  });
});

describe("watching an account", () => {
  const account = (role: string, roleKey?: string, closedOn: string | null = null) => ({
    id: `${role}-${roleKey ?? "none"}`,
    code: "1",
    name: "A",
    role,
    openedOn: "2026-01-01",
    closedOn,
    balance: "0.00",
    parentCode: null,
    tags: roleKey === undefined ? {} : { roleKey },
  });

  test("the menu offers watching, stopping, or nothing", () => {
    expect(watchOffered(account("expense"))).toBe("watch");
    expect(watchOffered(account("expense", "catchall.expense"))).toBe("stop");
    expect(watchOffered(account("income", "revenue.sales"))).toBeNull();
    expect(watchOffered(account("asset"))).toBeNull();
  });

  test("the account watched for a kind is the open one that holds its mark", () => {
    const chart = [
      account("expense", "catchall.expense", "2025-12-31"),
      account("income", "catchall.income"),
      account("expense"),
    ];
    expect(watchedFor(chart, "expense")).toBeUndefined();
    expect(watchedFor(chart, "income")?.id).toBe("income-catchall.income");
  });
});

describe("the mark on a watched account", () => {
  const account = (id: string, role: string, name: string, roleKey?: string) => ({
    id,
    code: id,
    name,
    role,
    openedOn: "2026-01-01",
    closedOn: null,
    balance: "0.00",
    parentCode: null,
    tags: roleKey === undefined ? {} : { roleKey },
  });
  const chart = [
    account("6290", "expense", "Other expenses", "catchall.expense"),
    account("6900", "expense", "Miscellaneous"),
    account("4900", "income", "Other income"),
  ];

  function watcher(outcomes: boolean[] = [], code = "") {
    const saved: { accountId: string; roleKey: string | null | undefined; on: string }[] = [];
    const said: string[] = [];
    const c = createWatchController({
      accounts: () => chart,
      save: async (accountId, change) => {
        saved.push({ accountId, roleKey: change.tags.roleKey, on: change.effectiveOn });
        return outcomes.shift() ?? true;
      },
      saveError: () => "The service said no.",
      saveCode: () => code,
      uncertain: () => false,
      resume: async () => {},
      today: () => "2026-10-17",
      onSaved: (message) => void said.push(message),
    });
    return { c, saved, said };
  }

  test("watching an account takes the mark off the one that held it, then puts it on, and says so", async () => {
    const { c, saved, said } = watcher();
    c.begin(chart[1] as (typeof chart)[number]);
    expect(c.target()?.mode).toBe("watch");
    expect(c.replaces()).toBe("Other expenses");
    await c.confirm();
    expect(saved).toEqual([
      { accountId: "6290", roleKey: null, on: "2026-10-17" },
      { accountId: "6900", roleKey: "catchall.expense", on: "2026-10-17" },
    ]);
    expect(said).toEqual(["Miscellaneous is watched at month end."]);
    expect(c.target()).toBeNull();
  });

  test("an account of the other kind is watched on its own, with its own mark", async () => {
    const { c, saved } = watcher();
    c.begin(chart[2] as (typeof chart)[number]);
    expect(c.replaces()).toBeUndefined();
    await c.confirm();
    expect(saved).toEqual([{ accountId: "4900", roleKey: "catchall.income", on: "2026-10-17" }]);
  });

  test("stopping takes the mark off and changes nothing else", async () => {
    const { c, saved, said } = watcher();
    c.begin(chart[0] as (typeof chart)[number]);
    expect(c.target()?.mode).toBe("stop");
    await c.confirm();
    expect(saved).toEqual([{ accountId: "6290", roleKey: null, on: "2026-10-17" }]);
    expect(said).toEqual(["Other expenses is not watched any more."]);
  });

  test("an account that cannot be watched opens nothing", () => {
    const { c } = watcher();
    c.begin(account("1000", "asset", "Checking"));
    c.begin(account("4100", "income", "Sales", "revenue.sales"));
    expect(c.target()).toBeNull();
  });

  test("when the first step is refused the second is not tried, and the dialog stays with the reason", async () => {
    const { c, saved, said } = watcher([false]);
    c.begin(chart[1] as (typeof chart)[number]);
    await c.confirm();
    expect(saved).toHaveLength(1);
    expect(said).toEqual([]);
    expect(c.target()).not.toBeNull();
    expect(c.error()).toBe("The service said no.");
    expect(c.busy()).toBe(false);
    c.cancel();
    expect(c.target()).toBeNull();
    expect(c.error()).toBe("");
  });

  test("a mark someone else took in the meantime is said in plain words", async () => {
    const { c } = watcher([false], "role_key_in_use");
    c.begin(chart[2] as (typeof chart)[number]);
    await c.confirm();
    expect(c.error()).toBe(
      "Another account was marked in the meantime. Close this, read the chart again and choose once more.",
    );
  });
});

describe("a change of account", () => {
  test("it asks what would happen before it changes anything, then moves what can move, as the person chose", async () => {
    const store = storage();
    const { c, sent, moved } = controller(store, [
      {
        ok: true,
        data: plan([
          result("j0", "would_apply"),
          result("j1", "would_apply"),
          result("j2", "skipped", { message: "This transaction is already on that account." }),
        ]),
      },
      { ok: true, data: report([result("j0", "applied"), result("j1", "applied")]) },
    ]);
    c.begin(ids(3));
    expect(c.open()).toBe(true);
    expect(c.stage()).toBe("choose");
    expect(c.count()).toBe(3);

    // Nothing is sent until an account is chosen.
    await c.plan();
    expect(sent).toHaveLength(0);
    expect(c.accountError()).toBe("Choose the account to move them to.");

    c.setAccountId("6200");
    c.setReason("  Software, not other  ");
    await c.plan();
    expect(c.stage()).toBe("review");
    expect(sent[0]?.input).toEqual({
      journalIds: ["j0", "j1", "j2"],
      accountId: "6200",
      reason: "Software, not other",
      limit: 3,
      dryRun: true,
    });
    expect(c.rows().map((row) => row.outcome)).toEqual(["would_apply", "would_apply", "skipped"]);
    expect(c.target()).toBe("Software and subscriptions");

    await c.confirm();
    // Only what the plan said could move is sent, without the plan's flag.
    expect(sent[1]?.input).toEqual({
      journalIds: ["j0", "j1"],
      accountId: "6200",
      reason: "Software, not other",
    });
    expect(c.stage()).toBe("done");
    expect(c.rows().map((row) => [row.id, row.outcome])).toEqual([
      ["j0", "applied"],
      ["j1", "applied"],
      ["j2", "skipped"],
    ]);
    // Nothing is kept for a resume once the answers have come.
    expect(
      store.getItem(`rastrata:${API_VERSION}:local-book:${CHANGE_WORKFLOW}:pending`),
    ).toBeNull();
    expect(store.getItem(`rastrata:${API_VERSION}:local-book:${PLAN_WORKFLOW}:pending`)).toBeNull();

    c.cancel();
    expect(c.open()).toBe(false);
    expect(moved).toEqual([{ moved: 2, target: "Software and subscriptions" }]);
  });

  test("a blank reason is not sent", async () => {
    const { c, sent } = controller(storage(), [
      { ok: true, data: plan([result("j0", "would_apply")]) },
    ]);
    c.begin(["j0"]);
    c.setAccountId("6200");
    c.setReason("   ");
    await c.plan();
    expect(sent[0]?.input).not.toHaveProperty("reason");
  });

  test("a long list is sent in turns of a hundred, and the dialog is not closed over work that was done without saying so", async () => {
    const all = ids(230);
    const { c, sent, moved } = controller(storage(), [
      { ok: true, data: plan(all.map((id) => result(id, "would_apply"))) },
      { ok: true, data: report(all.slice(0, 100).map((id) => result(id, "applied"))) },
      { ok: true, data: report(all.slice(100, 200).map((id) => result(id, "applied"))) },
      { ok: true, data: report(all.slice(200).map((id) => result(id, "applied"))) },
    ]);
    c.begin(all);
    c.setAccountId("6200");
    await c.plan();
    await c.confirm();
    expect(sent.slice(1).map((request) => (request.input.journalIds as string[]).length)).toEqual([
      TURN,
      TURN,
      30,
    ]);
    expect(c.stage()).toBe("done");
    expect(c.rows().filter((row) => row.outcome === "applied")).toHaveLength(230);
    expect(c.progress()).toBeUndefined();
    c.cancel();
    expect(moved[0]?.moved).toBe(230);
  });

  test("a call the service cut short is followed by one for the rest, and nothing is asked for twice", async () => {
    const all = ids(5);
    const { c, sent } = controller(storage(), [
      { ok: true, data: plan(all.map((id) => result(id, "would_apply"))) },
      {
        ok: true,
        data: report(
          all.slice(0, 2).map((id) => result(id, "applied")),
          { remaining: 3 },
        ),
      },
      { ok: true, data: report(all.slice(2).map((id) => result(id, "applied"))) },
    ]);
    c.begin(all);
    c.setAccountId("6200");
    await c.plan();
    await c.confirm();
    expect(sent[1]?.input.journalIds).toEqual(all);
    expect(sent[2]?.input.journalIds).toEqual(all.slice(2));
    expect(c.rows().every((row) => row.outcome === "applied")).toBe(true);
  });

  test("more than one change takes is cut to the most it takes, and the dialog says how many were left out", async () => {
    const { c, sent } = controller(storage(), [
      { ok: true, data: plan(ids(MOST_AT_ONCE).map((id) => result(id, "would_apply"))) },
    ]);
    c.begin(ids(MOST_AT_ONCE + 112));
    expect(c.count()).toBe(MOST_AT_ONCE);
    expect(c.capped()).toEqual({ included: MOST_AT_ONCE, left: 112 });
    c.setAccountId("6200");
    await c.plan();
    expect(sent[0]?.input.journalIds).toHaveLength(MOST_AT_ONCE);
    expect(sent[0]?.input.limit).toBe(MOST_AT_ONCE);
  });

  test("a plan that does not cover everything is not a plan", async () => {
    const { c } = controller(storage(), [
      { ok: true, data: plan([result("j0", "would_apply")], { remaining: 4 }) },
    ]);
    c.begin(ids(5));
    c.setAccountId("6200");
    await c.plan();
    expect(c.stage()).toBe("failed");
    expect(c.error()).toContain("not time to check all of them");
  });

  test("a refusal in the middle stops the change, shows what was done and says what was not reached", async () => {
    const all = ids(150);
    const { c, sent } = controller(storage(), [
      { ok: true, data: plan(all.map((id) => result(id, "would_apply"))) },
      { ok: true, data: report(all.slice(0, 100).map((id) => result(id, "applied"))) },
      { ok: false, code: "invalid_input" },
    ]);
    c.begin(all);
    c.setAccountId("6200");
    await c.plan();
    await c.confirm();
    expect(sent).toHaveLength(3);
    expect(c.stage()).toBe("done");
    expect(c.error()).toBe("Refused: invalid_input");
    const rows = c.rows();
    expect(rows.filter((row) => row.outcome === "applied")).toHaveLength(100);
    const left = rows.filter((row) => row.outcome === "skipped");
    expect(left).toHaveLength(50);
    expect(left[0]?.why).toBe("It was not reached. Select it again to move it.");
  });

  test("a refusal for permission is said plainly and leaves no request behind to stand in the way", async () => {
    const store = storage();
    const { c, client } = controller(store, [{ ok: false, code: "permission_denied" }]);
    c.begin(ids(2));
    c.setAccountId("6200");
    await c.plan();
    expect(c.stage()).toBe("failed");
    expect(c.uncertain()).toBe(false);
    expect(c.error()).toContain("Ask the owner of the books");
    expect(client.pending(PLAN_WORKFLOW)).toBeNull();
    expect(c.waiting()).toBe(false);
  });

  test("a reply that never came is kept and resumed, after a reload too, and nothing is moved twice", async () => {
    const store = storage();
    const all = ids(3);
    const first = controller(store, [
      { ok: true, data: plan(all.map((id) => result(id, "would_apply"))) },
      "lost",
    ]);
    first.c.begin(all);
    first.c.setAccountId("6200");
    first.c.setReason("Software");
    await first.c.plan();
    await first.c.confirm();
    expect(first.c.stage()).toBe("working");
    expect(first.c.uncertain()).toBe(true);
    // A person is not shown what a lost connection says.
    expect(first.c.error()).toBeUndefined();
    const lost = first.sent[1];

    // The page is closed and opened again: the request is found, and it is the same request.
    const pending = waitingChange(new BrowserApplicationClient(store, service([]).fetcher));
    expect(pending?.which).toBe("change");
    const second = controller(store, [
      { ok: true, data: report(all.map((id) => result(id, "applied"))) },
    ]);
    expect(second.c.waiting()).toBe(true);
    second.c.begin();
    expect(second.c.open()).toBe(true);
    expect(second.c.uncertain()).toBe(true);
    expect(second.c.count()).toBe(3);
    expect(second.c.accountId()).toBe("6200");
    expect(second.c.reason()).toBe("Software");
    // Starting something else is refused while that one is waiting.
    await second.c.plan();
    expect(second.sent).toHaveLength(0);

    await second.c.resume();
    // The same bytes, so the same identity: the service answers it as the one request it is.
    expect(second.sent[0]).toEqual(lost);
    expect(second.c.stage()).toBe("done");
    expect(second.c.uncertain()).toBe(false);
    expect(second.c.rows().filter((row) => row.outcome === "applied")).toHaveLength(3);
    expect(second.c.waiting()).toBe(false);
    second.c.cancel();
    expect(second.moved).toEqual([{ moved: 3, target: "Software and subscriptions" }]);
  });

  test("a plan whose reply never came is resumed into the plan", async () => {
    const store = storage();
    const first = controller(store, ["lost"]);
    first.c.begin(ids(2));
    first.c.setAccountId("6200");
    await first.c.plan();
    expect(first.c.stage()).toBe("choose");
    expect(first.c.uncertain()).toBe(true);
    const second = controller(store, [
      { ok: true, data: plan([result("j0", "would_apply"), result("j1", "would_apply")]) },
    ]);
    second.c.begin();
    expect(second.c.uncertain()).toBe(true);
    await second.c.resume();
    expect(second.c.stage()).toBe("review");
    expect(second.c.rows()).toHaveLength(2);
  });

  test("with nothing selected and nothing waiting, nothing opens", () => {
    const { c } = controller(storage(), []);
    c.begin();
    expect(c.open()).toBe(false);
    c.begin([]);
    expect(c.open()).toBe(false);
  });

  test("closing the dialog before anything was moved reads nothing again", async () => {
    const { c, moved } = controller(storage(), [
      { ok: true, data: plan([result("j0", "would_apply")]) },
    ]);
    c.begin(["j0"]);
    c.setAccountId("6200");
    await c.plan();
    c.cancel();
    expect(c.open()).toBe(false);
    expect(moved).toEqual([]);
  });
});
