// What the Bank accounts page does (src/banks-controller.ts), against stand-ins for the book and the control plane.
import { expect, test } from "bun:test";
import type { AccountRow, BankAccount, BanksStatus } from "@rastrata/application/client-contracts";
import type { BankConnections, Result, Role } from "../../src/account";
import {
  type BankRow,
  type BanksState,
  BanksController,
  type BanksView,
  chartOptions,
  NEW_ACCOUNT,
  newAccountFor,
  problemWords,
  sameAccountCandidates,
} from "../../src/banks-controller";

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const no = (status: number, code: string, message = "Refused."): Result<never> => ({
  ok: false,
  status,
  code,
  message,
  retryAfter: null,
});

const chart = (
  id: string,
  code: string,
  name: string,
  role: string,
  extra: Partial<AccountRow> = {},
): AccountRow => ({ id, code, name, role, closedOn: null, ...extra }) as unknown as AccountRow;

const CHART: AccountRow[] = [
  chart("acc_checking", "1000", "Business Checking", "asset"),
  chart("acc_savings", "1100", "Savings", "asset"),
  chart("acc_stripe", "1300", "Stripe balance", "asset", {
    tags: { roleKey: "stripe.balance" },
  } as never),
  chart("acc_old", "1900", "Old account", "asset", { closedOn: "2026-01-01" }),
  chart("acc_card", "2000", "Company Card", "liability"),
  chart("acc_sales", "4000", "Sales", "income"),
];

const account = (overrides: Partial<BankAccount> = {}): BankAccount => ({
  id: "fca_checking",
  institution: "Test Bank",
  name: "Business Checking",
  last4: "6789",
  kind: "checking",
  state: "active",
  attention:
    "Choose which account in your books these transactions belong to. Nothing is read into your books until you do.",
  booking: null,
  lastReceivedAt: null,
  queuedLines: 0,
  ...overrides,
});

const booked = (overrides: Partial<BankAccount> = {}): BankAccount =>
  account({
    attention: null,
    booking: {
      ledgerAccountId: "acc_checking",
      ledgerAccount: "1000 Business Checking",
      startOn: "2026-01-01",
      bookedAt: "2026-10-18T12:00:00.000Z",
    },
    lastReceivedAt: "2026-10-18T13:00:00.000Z",
    queuedLines: 12,
    ...overrides,
  });

interface Setup {
  role?: Role;
  accounts?: BankAccount[];
  chart?: AccountRow[];
  status?: (fresh?: boolean) => Promise<BanksStatus>;
  connections?: () => Promise<Result<BankConnections>>;
  held?: BanksStatus["held"];
}

function harness(setup: Setup = {}) {
  const calls: string[] = [];
  const went: string[] = [];
  let accounts = setup.accounts ?? [account()];
  const controller = new BanksController({
    go: (path) => void went.push(path),
    book: {
      status:
        setup.status ??
        (async () => ({ accounts, held: setup.held ?? [], heldCount: setup.held?.length ?? 0 })),
      chart: async () => setup.chart ?? CHART,
      createAccount: async (input) => {
        calls.push(`create ${input.account} ${input.kind} ${input.name}`);
        return { id: "acc_made", warnings: ["Opens on Nov 5, 2026."] };
      },
      book: async (input) => {
        calls.push(`book ${input.account} ${input.ledgerAccountId} ${input.startOn ?? "-"}`);
        accounts = accounts.map((a) =>
          a.id === input.account
            ? booked({
                id: a.id,
                booking: {
                  ledgerAccountId: input.ledgerAccountId,
                  ledgerAccount: null,
                  startOn: input.startOn ?? "2026-01-01",
                  bookedAt: "2026-10-18T12:00:00.000Z",
                },
              })
            : a,
        );
        return { account: accounts[0] as BankAccount, notes: ["Another source already feeds it."] };
      },
      unbook: async (id) => {
        calls.push(`unbook ${id}`);
        accounts = accounts.map((a) => (a.id === id ? account({ id }) : a));
      },
    },
    control: {
      scope: () => "wsp_acme",
      workspace: async () =>
        ok({
          workspace: {
            id: "wsp_acme",
            name: "Acme",
            role: setup.role ?? "owner",
            state: "ready" as const,
          },
        }),
      bankConnections:
        setup.connections ??
        (async () =>
          ok({
            available: true,
            limit: 5,
            accounts: accounts.map((a) => ({
              id: a.id,
              institution: a.institution,
              name: a.name,
              last4: a.last4,
              kind: a.kind,
              state: a.state,
              syncedAt: null,
              problem: null,
            })),
          })),
      bankLinkPath: (workspace) => `/auth/bank/link?workspace=${workspace}`,
      bankDisconnect: async (workspace, id) => {
        calls.push(`disconnect ${workspace} ${id}`);
        accounts = accounts.map((a) =>
          a.id === id ? { ...a, state: "disconnected" as const } : a,
        );
        return ok({});
      },
      bankReadNow: async (workspace) => {
        calls.push(`read ${workspace}`);
        return ok({});
      },
    },
  });
  return { controller, calls, went };
}

const viewOf = (state: BanksState): BanksView => {
  if (state.step !== "ready") throw new Error(`not ready: ${state.step}`);
  return state.view;
};

test("an account may be booked to an open bank account when it is a checking or savings account, to a card when it is a card, and to neither when the books have none that fits", () => {
  const labels = (kind: string, taken: string[] = [], own: string | null = null) =>
    chartOptions(kind, CHART, new Set(taken), own).map((option) => option.label);
  expect(labels("checking")).toEqual(["1000 · Business Checking", "1100 · Savings"]);
  expect(labels("credit_card")).toEqual(["2000 · Company Card"]);
  expect(labels("line_of_credit")).toEqual(["2000 · Company Card"]);
  expect(labels("other")).toEqual([
    "1000 · Business Checking",
    "1100 · Savings",
    "2000 · Company Card",
  ]);
  // Not a Stripe account, not a closed one, not an income account; and not one another account is booked to, unless it is this one's own.
  expect(labels("checking")).not.toContain("1300 · Stripe balance");
  expect(labels("checking")).not.toContain("1900 · Old account");
  expect(labels("checking", ["acc_checking"])).toEqual(["1100 · Savings"]);
  expect(labels("checking", ["acc_checking"], "acc_checking")).toEqual([
    "1000 · Business Checking",
    "1100 · Savings",
  ]);
  expect(chartOptions("checking", [], new Set(), null)).toEqual([]);
});

test("opening the page may be answered from what the page holds of the book, and looking again for what has come never is", async () => {
  const asked: (boolean | undefined)[] = [];
  const { controller } = harness({
    status: async (fresh) => {
      asked.push(fresh);
      return { accounts: [account()], held: [], heldCount: 0 };
    },
  });
  await controller.load();
  await controller.refresh();
  expect(asked).toEqual([false, true]);
});

test("the control plane's codes are said as what a person can act on", () => {
  expect(problemWords(null)).toBeNull();
  expect(problemWords("refresh_failed")).toContain("tomorrow");
  expect(problemWords("stripe_unreachable")).toContain("tried again by itself");
  expect(problemWords("pod_unreachable")).toContain("tried again by itself");
  expect(problemWords("not_configured")).toContain("paused");
});

test("the page reads the book and the control plane, and shows each account with what the person may do about it", async () => {
  const { controller } = harness({
    accounts: [
      account(),
      booked({
        id: "fca_card",
        name: "Company Card",
        kind: "credit_card",
        last4: "4242",
        booking: {
          ledgerAccountId: "acc_card",
          ledgerAccount: "2000 Company Card",
          startOn: "2026-01-01",
          bookedAt: "2026-10-18T12:00:00.000Z",
        },
      }),
    ],
  });
  await controller.load();
  const view = viewOf(controller.state);
  expect(view).toMatchObject({
    role: "owner",
    available: true,
    canConnect: true,
    atLimit: false,
    limit: 5,
    heldCount: 0,
  });
  const [first, second] = view.rows as [BankRow, BankRow];
  expect(first).toMatchObject({
    id: "fca_checking",
    institution: "Test Bank",
    detail: "Checking account ending 6789",
    state: "active",
    booking: null,
    canBook: true,
    canUnbook: false,
    canDisconnect: true,
  });
  expect(first.attention).toContain("Choose which account");
  expect(first.options.map((o) => o.value)).toEqual(["acc_checking", "acc_savings"]);
  expect(second).toMatchObject({
    detail: "Credit card ending 4242",
    booking: { account: "2000 Company Card", startOn: "2026-01-01" },
    queuedLines: 12,
    canBook: false,
    canUnbook: true,
    canDisconnect: true,
  });
  // The account already booked is not offered to the other.
  expect(first.options.map((o) => o.value)).not.toContain("acc_card");
});

test("an administrator books accounts but does not connect or disconnect banks; anyone else only sees them", async () => {
  const admin = harness({ role: "admin" });
  await admin.controller.load();
  expect(viewOf(admin.controller.state)).toMatchObject({ canConnect: false });
  expect(viewOf(admin.controller.state).rows[0]).toMatchObject({
    canBook: true,
    canDisconnect: false,
  });

  const member = harness({ role: "member" });
  await member.controller.load();
  const view = viewOf(member.controller.state);
  expect(view.canConnect).toBe(false);
  expect(view.rows[0]).toMatchObject({
    canBook: false,
    canUnbook: false,
    canDisconnect: false,
    problem: null,
  });
  // A member is not told how the connections stand: the control plane would refuse, and the page does not ask.
  let asked = false;
  const quiet = harness({
    role: "member",
    connections: async () => {
      asked = true;
      return ok({ available: true, limit: 5, accounts: [] });
    },
  });
  await quiet.controller.load();
  expect(asked).toBe(false);
});

test("an inactive account says what to do, a disconnected one cannot be booked, and a failed reading is said in words", async () => {
  const { controller } = harness({
    accounts: [
      account({ id: "fca_a", state: "inactive", attention: "Sign in to the bank again." }),
      account({
        id: "fca_b",
        state: "disconnected",
        attention: "This connection was stopped.",
        queuedLines: 3,
      }),
      // Stopped before it brought anything, and never booked: nothing to show.
      account({ id: "fca_c", state: "disconnected" }),
    ],
    connections: async () =>
      ok({
        available: true,
        limit: 5,
        accounts: [
          {
            id: "fca_a",
            institution: "Test Bank",
            name: "A",
            last4: null,
            kind: "checking",
            state: "inactive",
            syncedAt: null,
            problem: "refresh_failed",
          },
        ],
      }),
  });
  await controller.load();
  const rows = viewOf(controller.state).rows;
  expect(rows.map((row) => row.id)).toEqual(["fca_a", "fca_b"]);
  const [a, b] = rows as [BankRow, BankRow];
  expect(a).toMatchObject({
    state: "inactive",
    canBook: false,
    canDisconnect: true,
    canReconnect: true,
  });
  expect(a.problem).toContain("tomorrow");
  expect(b).toMatchObject({
    state: "disconnected",
    canBook: false,
    canDisconnect: false,
    canReconnect: false,
  });
});

test("a workspace with as many accounts as it may have cannot connect another", async () => {
  const { controller } = harness({
    connections: async () =>
      ok({
        available: true,
        limit: 1,
        accounts: [
          {
            id: "fca_checking",
            institution: "Test Bank",
            name: "B",
            last4: null,
            kind: "checking",
            state: "active",
            syncedAt: null,
            problem: null,
          },
        ],
      }),
  });
  await controller.load();
  expect(viewOf(controller.state)).toMatchObject({ atLimit: true, limit: 1, canConnect: true });
});

test("connecting opens the window that is a page of its own", async () => {
  const { controller, went } = harness();
  await controller.load();
  controller.connect();
  expect(went).toEqual(["/auth/bank/link?workspace=wsp_acme"]);
});

test("booking sends the choice to the book, has the control plane read at once, and shows what the book said", async () => {
  const { controller, calls } = harness();
  await controller.load();
  expect(await controller.book("fca_checking", "acc_savings", "2026-02-01")).toBe(true);
  expect(calls).toEqual(["book fca_checking acc_savings 2026-02-01", "read wsp_acme"]);
  const view = viewOf(controller.state);
  expect(view.notice).toContain("Booked");
  expect(view.notes).toEqual(["Another source already feeds it."]);
  expect(view.rows[0]?.booking).not.toBeNull();
  // No first day given: the book's cutover date is used.
  const again = harness();
  await again.controller.load();
  await again.controller.book("fca_checking", "acc_checking", "  ");
  expect(again.calls[0]).toBe("book fca_checking acc_checking -");
});

test("the account the books would get is named as the bank names it, with its last digits, and is what the account is", () => {
  expect(newAccountFor(account())).toEqual({ name: "Business Checking 6789", kind: "bank" });
  expect(newAccountFor(account({ name: "Savings 6789", kind: "savings" }))).toEqual({
    name: "Savings 6789",
    kind: "bank",
  });
  expect(newAccountFor(account({ name: "Ink Business Card", kind: "credit_card" }))).toEqual({
    name: "Ink Business Card 6789",
    kind: "card",
  });
  expect(
    newAccountFor(account({ name: "Line of credit", last4: null, kind: "line_of_credit" })),
  ).toEqual({ name: "Line of credit", kind: "loan" });
  expect(newAccountFor(account({ name: "Brokerage", kind: "other" })).kind).toBe("bank");
});

test("with no account in the books that fits, the bank's own is made and booked into, and what the book said about both is shown", async () => {
  const { controller, calls } = harness({ chart: [] });
  await controller.load();
  const row = viewOf(controller.state).rows[0] as BankRow;
  expect(row.options).toEqual([]);
  expect(row.newAccount).toEqual({ name: "Business Checking 6789", kind: "bank" });
  expect(await controller.book("fca_checking", NEW_ACCOUNT, "2026-02-01")).toBe(true);
  expect(calls).toEqual([
    "create fca_checking bank Business Checking 6789",
    "book fca_checking acc_made 2026-02-01",
    "read wsp_acme",
  ]);
  const view = viewOf(controller.state);
  expect(view.notice).toContain("Booked");
  expect(view.notes).toEqual(["Opens on Nov 5, 2026.", "Another source already feeds it."]);
});

test("booking with nothing chosen asks for a choice and does not call the book", async () => {
  const { controller, calls } = harness();
  await controller.load();
  expect(await controller.book("fca_checking", "", "")).toBe(false);
  expect(calls).toEqual([]);
  expect(viewOf(controller.state).error).toContain("Choose which account");
});

test("when the book refuses to book, its words are shown, and the control plane is not asked to read", async () => {
  const { controller, calls } = harness();
  await controller.load();
  const refuse = new Error(
    "1000 Business Checking is already fed by another bank account. Stop that one first.",
  );
  const failing = new BanksController({
    go: () => {},
    book: {
      status: async () => ({ accounts: [account()], held: [], heldCount: 0 }),
      chart: async () => CHART,
      createAccount: async () => {
        throw new Error("not here");
      },
      book: async () => {
        throw refuse;
      },
      unbook: async () => {},
    },
    control: {
      scope: () => "wsp_acme",
      workspace: async () =>
        ok({
          workspace: {
            id: "wsp_acme",
            name: "Acme",
            role: "owner" as const,
            state: "ready" as const,
          },
        }),
      bankConnections: async () => no(500, "x"),
      bankLinkPath: () => "/x",
      bankDisconnect: async () => ok({}),
      bankReadNow: async () => {
        calls.push("read");
        return ok({});
      },
    },
  });
  await failing.load();
  expect(await failing.book("fca_checking", "acc_checking", "")).toBe(false);
  expect(viewOf(failing.state).error).toBe(refuse.message);
  expect(calls).toEqual([]);
});

test("unbooking and disconnecting say what stays, and the page is read again", async () => {
  const { controller, calls } = harness({ accounts: [booked()] });
  await controller.load();
  await controller.unbook("fca_checking");
  expect(calls).toEqual(["unbook fca_checking"]);
  expect(viewOf(controller.state).notice).toContain("stay where they are");
  expect(viewOf(controller.state).rows[0]?.booking).toBeNull();

  await controller.disconnect("fca_checking");
  expect(calls).toContain("disconnect wsp_acme fca_checking");
  expect(viewOf(controller.state).notice).toContain("what is already in your books stays");
  // Stopped, with nothing booked and nothing brought: there is nothing left to show.
  expect(viewOf(controller.state).rows).toEqual([]);
});

test("a refusal by the control plane is shown, and nothing else changes", async () => {
  const harnessed = harness();
  await harnessed.controller.load();
  const refusing = new BanksController({
    go: () => {},
    book: {
      status: async () => ({ accounts: [account()], held: [], heldCount: 0 }),
      chart: async () => CHART,
      createAccount: async () => {
        throw new Error("not here");
      },
      book: async () => {
        throw new Error("no");
      },
      unbook: async () => {},
    },
    control: {
      scope: () => "wsp_acme",
      workspace: async () =>
        ok({
          workspace: {
            id: "wsp_acme",
            name: "Acme",
            role: "owner" as const,
            state: "ready" as const,
          },
        }),
      bankConnections: async () => ok({ available: true, limit: 5, accounts: [] }),
      bankLinkPath: () => "/x",
      bankDisconnect: async () => no(403, "forbidden", "Only an owner can stop a bank connection."),
      bankReadNow: async () =>
        no(429, "too_many_requests", "You have tried that a lot. Try again in a while."),
    },
  });
  await refusing.load();
  await refusing.disconnect("fca_checking");
  expect(viewOf(refusing.state).error).toBe("Only an owner can stop a bank connection.");
  await refusing.readNow();
  expect(viewOf(refusing.state).error).toContain("tried that a lot");
});

test("a book that cannot be read is a problem in place of the page at first, and a line above it later; a control plane that cannot be asked is not", async () => {
  let fail = true;
  const { controller } = harness({
    status: async () => {
      if (fail) throw new Error("The book is not reachable.");
      return { accounts: [account()], held: [], heldCount: 0 };
    },
    connections: async () => no(500, "unavailable", "Down."),
  });
  await controller.load();
  expect(controller.state).toEqual({ step: "problem", message: "The book is not reachable." });
  fail = false;
  await controller.load();
  // The control plane did not answer, and the accounts are shown all the same.
  expect(viewOf(controller.state).rows).toHaveLength(1);
  expect(viewOf(controller.state).limit).toBeNull();
  fail = true;
  await controller.refresh();
  expect(viewOf(controller.state).error).toBe("The book is not reachable.");
  expect(viewOf(controller.state).rows).toHaveLength(1);
});

test("unreadable transactions are listed, with how many there are", async () => {
  const { controller } = harness({
    held: [
      {
        accountId: "fca_checking",
        id: "fctxn_1",
        postedOn: "2026-10-04",
        reason: "Its amount is not a whole number of cents.",
      },
    ],
  });
  await controller.load();
  expect(viewOf(controller.state).held).toHaveLength(1);
  expect(viewOf(controller.state).heldCount).toBe(1);
});

// ---- connecting asks nothing (docs/reference/design-language.md) ------------------------------------------

const BANKS_IN_BOOKS: AccountRow[] = [
  chart("acc_checking", "1000", "Business Checking", "asset", { tags: { kind: "bank" } } as never),
  chart("acc_receivable", "1200", "Accounts receivable", "asset"),
  chart("acc_card", "2000", "Company Card", "liability", { tags: { kind: "card" } } as never),
  chart("acc_stripe", "1300", "Stripe balance", "asset", {
    tags: { kind: "bank", roleKey: "stripe.balance" },
  } as never),
  chart("acc_closed", "1900", "Old bank", "asset", {
    tags: { kind: "bank" },
    closedOn: "2026-01-01",
  } as never),
];

test("the accounts a new bank account could be are the books' own open bank accounts or cards, never Stripe's, a closed one, one that is fed already, or any other asset", () => {
  const labels = (kind: string, taken: string[] = []) =>
    sameAccountCandidates(kind, BANKS_IN_BOOKS, new Set(taken)).map((option) => option.label);
  expect(labels("checking")).toEqual(["Business Checking"]);
  expect(labels("savings")).toEqual(["Business Checking"]);
  expect(labels("credit_card")).toEqual(["Company Card"]);
  expect(labels("checking", ["acc_checking"])).toEqual([]);
  // A loan, and an account of a sort the chart does not mark, have none: nothing is asked about them.
  expect(labels("line_of_credit")).toEqual([]);
  expect(labels("other")).toEqual([]);
});

test("a bank that was just connected asks nothing where the books hold no account it could be: its accounts are added, named as the bank names them, and read at once", async () => {
  const h = harness({
    chart: [chart("acc_receivable", "1200", "Accounts receivable", "asset")],
    accounts: [
      account({ id: "fca_a", name: "Checking", last4: "0730" }),
      account({ id: "fca_b", name: "Reserve", last4: "0960" }),
    ],
  });
  await h.controller.load();
  expect(viewOf(h.controller.state).rows.map((row) => row.candidates)).toEqual([[], []]);
  expect(await h.controller.settle()).toBe(2);
  expect(h.calls).toEqual([
    "create fca_a bank Checking 0730",
    "book fca_a acc_made -",
    "create fca_b bank Reserve 0960",
    "book fca_b acc_made -",
    "read wsp_acme",
  ]);
  expect(viewOf(h.controller.state).notice).toBe(
    "Test Bank is connected. 2 accounts were added to your books.",
  );
  // Nothing is left to add: a second run does nothing.
  h.calls.length = 0;
  expect(await h.controller.settle()).toBe(0);
  expect(h.calls).toEqual([]);
});

test("where the books already hold a bank account it could be, nothing is added by itself: the row carries the one question, and the answer books it", async () => {
  const h = harness({ chart: BANKS_IN_BOOKS });
  await h.controller.load();
  expect(viewOf(h.controller.state).rows[0]?.candidates).toEqual([
    { value: "acc_checking", label: "Business Checking" },
  ]);
  expect(await h.controller.settle()).toBe(0);
  expect(h.calls).toEqual([]);
  // Yes: it is booked to the account the books hold.
  expect(await h.controller.book("fca_checking", "acc_checking", "")).toBe(true);
  expect(h.calls).toEqual(["book fca_checking acc_checking -", "read wsp_acme"]);
  expect(viewOf(h.controller.state).rows[0]?.candidates).toEqual([]);
  expect(viewOf(h.controller.state).rows[0]?.ledgerAccountId).toBe("acc_checking");
});

test("a member who may not book has nothing added for them", async () => {
  const h = harness({ role: "member", chart: [] });
  await h.controller.load();
  expect(await h.controller.settle()).toBe(0);
  expect(h.calls).toEqual([]);
});

test("changing where an account goes stops the one and starts the other, from the day given", async () => {
  const h = harness({ chart: BANKS_IN_BOOKS, accounts: [booked()] });
  await h.controller.load();
  expect(await h.controller.change("fca_checking", NEW_ACCOUNT, "2026-03-01")).toBe(true);
  expect(h.calls).toEqual([
    "unbook fca_checking",
    "create fca_checking bank Business Checking 6789",
    "book fca_checking acc_made 2026-03-01",
    "read wsp_acme",
  ]);
});
