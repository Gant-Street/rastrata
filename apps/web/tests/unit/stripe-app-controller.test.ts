// What the Stripe card does where Stripe is connected with the button (src/stripe-app-controller.ts), against a stand-in for the control plane; the calls to the control plane
// (src/account.ts); and the page learning that the service has the button (src/boot.ts, src/capabilities.ts).
import { afterEach, expect, test } from "bun:test";
import { Account, type Result, type Role, type StripeAppConnections } from "../../src/account";
import { learnCapabilities } from "../../src/capabilities";
import { availableRoutes, type NavRoute } from "../../src/nav";
import {
  type BookLink,
  noticeOf,
  type StripeAppControl,
  StripeAppController,
  type StripeAppState,
  viewOf,
} from "../../src/stripe-app-controller";

afterEach(() => learnCapabilities(null));

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const no = (status: number, code: string, message = "Refused."): Result<never> => ({
  ok: false,
  status,
  code,
  message,
  retryAfter: null,
});

const CONNECTED: StripeAppConnections = {
  available: true,
  connection: {
    accountId: "acct_1Customer0000001",
    livemode: true,
    state: "active",
    connectedAt: "2026-10-20T15:04:05.000Z",
    syncedAt: "2026-10-20T15:06:00.000Z",
    reading: false,
    problem: null,
  },
};
const NONE: StripeAppConnections = { available: true, connection: null };
const LINK: BookLink = {
  accountId: "acct_1Customer0000001",
  livemode: true,
  since: "2026-10-20T15:04:05.000Z",
};

test("the card is drawn for the role: an owner connects and stops, an admin reads now, anyone else is told whom Rastrata reads and can do nothing", () => {
  const owner = viewOf("owner", NONE, null);
  expect(owner).toMatchObject({
    stage: "none",
    canConnect: true,
    canReadNow: false,
    canDisconnect: false,
  });
  expect(viewOf("admin", NONE, null)).toMatchObject({ stage: "none", canConnect: false });
  expect(viewOf("owner", { available: false, connection: null }, null).stage).toBe("unavailable");
  expect(viewOf("owner", { available: false, connection: null }, null).canConnect).toBe(false);

  expect(viewOf("owner", CONNECTED, LINK)).toMatchObject({
    stage: "connected",
    accountId: "acct_1Customer0000001",
    live: true,
    canConnect: false,
    canReadNow: true,
    canDisconnect: true,
  });
  expect(viewOf("admin", CONNECTED, LINK)).toMatchObject({
    canReadNow: true,
    canDisconnect: false,
  });
  // A member is not told by the control plane: the book's word is all there is, and it offers nothing.
  for (const role of ["member", "accountant"] as const) {
    expect(viewOf(role, null, LINK)).toMatchObject({
      stage: "connected",
      accountId: "acct_1Customer0000001",
      canConnect: false,
      canReadNow: false,
      canDisconnect: false,
    });
    expect(viewOf(role, null, null)).toMatchObject({ stage: "none", canConnect: false });
  }
});

test("a connection that stopped says why in words, and the owner may connect again; a reading that did not work says what to do, never a code", () => {
  const stopped = (problem: string | null): StripeAppConnections => ({
    available: true,
    connection: {
      ...(CONNECTED.connection as NonNullable<typeof CONNECTED.connection>),
      state: "disconnected",
      problem,
    },
  });
  const removed = viewOf("owner", stopped("app_removed"), null);
  expect(removed).toMatchObject({
    stage: "stopped",
    canConnect: true,
    accountId: "acct_1Customer0000001",
  });
  expect(removed.problem).toContain("removed in Stripe");
  expect(viewOf("admin", stopped("app_removed"), null).canConnect).toBe(false);
  expect(viewOf("owner", stopped("account_changed"), null).problem).toContain(
    "different Stripe account",
  );
  expect(viewOf("owner", stopped("stripe_mode_changed"), null).problem).toContain(
    "real sales or practice data",
  );
  expect(viewOf("owner", stopped(null), null).problem).toBeNull();

  const reading = (problem: string | null): StripeAppConnections => ({
    available: true,
    connection: {
      ...(CONNECTED.connection as NonNullable<typeof CONNECTED.connection>),
      problem,
      reading: true,
    },
  });
  expect(viewOf("owner", reading("stripe_not_configured"), null)).toMatchObject({
    reading: true,
    problem: "Choose the accounts Stripe is booked to.",
  });
  for (const code of [
    "workspace_read_only",
    "stripe_permission_denied",
    "internal",
    "pod_unreachable",
  ]) {
    const words = viewOf("owner", reading(code), null).problem ?? "";
    expect(words).not.toBe("");
    // Plain words: nothing of the code, and no machine talk.
    expect(words).not.toContain(code);
    expect(words).not.toMatch(/\b(pod|token|api|http|json)\b/i);
  }
});

test("what Stripe sent the person back with is said in words, and what is not known says nothing", () => {
  for (const outcome of [
    "failed",
    "expired",
    "signin",
    "other_account",
    "other_mode",
    "unavailable",
  ])
    expect(noticeOf(outcome)?.text.length ?? 0, outcome).toBeGreaterThan(10);
  // A connection that worked is on the page, and a person who changed their mind knows it: neither is told anything.
  expect(noticeOf("connected")).toBeNull();
  expect(noticeOf("cancelled")).toBeNull();
  expect(noticeOf("failed")?.tone).toBe("problem");
  expect(noticeOf("something-else")).toBeNull();
  expect(noticeOf(null)).toBeNull();
});

/** A control plane that answers, and keeps what it was asked. */
function control(
  role: Role,
  standing: () => Result<StripeAppConnections>,
  extra: Partial<StripeAppControl> = {},
) {
  const asked: string[] = [];
  const stand: StripeAppControl = {
    scope: () => "wsp_aaaaaaaa",
    workspace: async (id) => {
      asked.push(`workspace ${id}`);
      return ok({ workspace: { id, name: "Acme", role, state: "ready" as const } });
    },
    stripeAppConnection: async (id) => {
      asked.push(`connection ${id}`);
      return standing();
    },
    stripeAppStart: async (id) => {
      asked.push(`start ${id}`);
      return ok({ url: "https://marketplace.stripe.com/apps/install/link/x?state=s" });
    },
    stripeAppDisconnect: async (id) => {
      asked.push(`disconnect ${id}`);
      return ok({});
    },
    stripeAppReadNow: async (id) => {
      asked.push(`read ${id}`);
      return ok({});
    },
    ...extra,
  };
  return { stand, asked };
}

const readyOf = (controller: StripeAppController) => {
  const state = controller.state as Extract<StripeAppState, { step: "ready" }>;
  expect(state.step).toBe("ready");
  return state;
};

test("an owner presses Connect Stripe and is sent to the app's install page, once", async () => {
  const { stand, asked } = control("owner", () => ok(NONE));
  const went: string[] = [];
  const controller = new StripeAppController({
    control: stand,
    link: () => null,
    go: (address) => void went.push(address),
  });
  await controller.load();
  expect(readyOf(controller).view.stage).toBe("none");
  const first = controller.connect();
  // A second press while the first is on its way does nothing.
  const second = controller.connect();
  await Promise.all([first, second]);
  expect(went).toEqual(["https://marketplace.stripe.com/apps/install/link/x?state=s"]);
  expect(asked.filter((line) => line.startsWith("start"))).toEqual(["start wsp_aaaaaaaa"]);
});

test("a refusal is shown in the control plane's words and the card stays as it was", async () => {
  const { stand } = control("owner", () => ok(NONE), {
    stripeAppStart: async () =>
      no(
        503,
        "stripe_app_not_configured",
        "Connecting Stripe is not available yet. Try again later.",
      ),
  });
  const went: string[] = [];
  const controller = new StripeAppController({
    control: stand,
    link: () => null,
    go: (address) => void went.push(address),
  });
  await controller.load();
  await controller.connect();
  const state = readyOf(controller);
  expect(state.error).toBe("Connecting Stripe is not available yet. Try again later.");
  expect(state.busy).toBeNull();
  expect(state.view.stage).toBe("none");
  expect(went).toEqual([]);
});

test("reading now asks the control plane and then reads the connection again, which says a reading is under way", async () => {
  let reading = false;
  const { stand, asked } = control("admin", () =>
    ok({
      available: true,
      connection: {
        ...(CONNECTED.connection as NonNullable<typeof CONNECTED.connection>),
        reading,
      },
    }),
  );
  const states: StripeAppState[] = [];
  const controller = new StripeAppController({ control: stand, link: () => LINK, go: () => {} });
  controller.subscribe((state) => void states.push(state));
  await controller.load();
  expect(readyOf(controller).view).toMatchObject({
    canReadNow: true,
    canDisconnect: false,
    reading: false,
  });
  stand.stripeAppReadNow = async (id) => {
    asked.push(`read ${id}`);
    reading = true;
    return ok({});
  };
  await controller.readNow();
  expect(asked).toContain("read wsp_aaaaaaaa");
  expect(readyOf(controller).view.reading).toBe(true);
  expect(readyOf(controller).busy).toBeNull();
  // While it was asked, the card was busy with it.
  expect(states.some((state) => state.step === "ready" && state.busy === "readNow")).toBe(true);
});

test("stopping is a second step: the first press asks, keeping reading goes back, and the second stops it", async () => {
  let state: StripeAppConnections = CONNECTED;
  const { stand, asked } = control("owner", () => ok(state), {
    stripeAppDisconnect: async (id) => {
      asked.push(`disconnect ${id}`);
      state = {
        available: true,
        connection: {
          ...(CONNECTED.connection as NonNullable<typeof CONNECTED.connection>),
          state: "disconnected",
        },
      };
      return ok({});
    },
  });
  const controller = new StripeAppController({ control: stand, link: () => LINK, go: () => {} });
  await controller.load();
  controller.askToStop();
  expect(readyOf(controller).stopping).toBe(true);
  controller.keepReading();
  expect(readyOf(controller).stopping).toBe(false);
  expect(asked.some((line) => line.startsWith("disconnect"))).toBe(false);
  controller.askToStop();
  await controller.stop();
  expect(asked).toContain("disconnect wsp_aaaaaaaa");
  expect(readyOf(controller).stopping).toBe(false);
  expect(readyOf(controller).view.stage).toBe("stopped");
});

test("a card that cannot be read says so while it has nothing to show, and keeps what it showed when a later look fails", async () => {
  let failing = true;
  const { stand } = control("owner", () =>
    failing ? no(500, "x", "The control plane is not answering.") : ok(CONNECTED),
  );
  const controller = new StripeAppController({ control: stand, link: () => LINK, go: () => {} });
  await controller.load();
  expect(controller.state).toEqual({
    step: "problem",
    message: "The control plane is not answering.",
  });
  failing = false;
  await controller.load();
  expect(readyOf(controller).view.stage).toBe("connected");
  failing = true;
  await controller.load();
  // What it showed stays; the card is not blanked by one look that failed.
  expect(readyOf(controller).view.stage).toBe("connected");
  const none = new StripeAppController({
    control: { ...stand, scope: () => null },
    link: () => null,
    go: () => {},
  });
  await none.load();
  expect(none.state).toEqual({ step: "problem", message: "No workspace is open." });
});

// ----- the calls, and what the page learns -----

test("the four calls go to the control plane's paths with the workspace in the body or the query", async () => {
  const seen: { method: string; url: string; body: unknown }[] = [];
  const ask = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      method: init?.method ?? "GET",
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    if (String(input).startsWith("/auth/stripe-app/connection"))
      return Response.json({ available: true, connection: null });
    return Response.json({ url: "https://marketplace.stripe.com/x", ok: true });
  }) as unknown as typeof fetch;
  const account = new Account({
    ask,
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  });
  expect(await account.stripeAppConnection("wsp_x/y")).toEqual(
    ok({ available: true, connection: null }),
  );
  expect(await account.stripeAppStart("wsp_x")).toMatchObject({
    ok: true,
    value: { url: "https://marketplace.stripe.com/x" },
  });
  await account.stripeAppReadNow("wsp_x");
  await account.stripeAppDisconnect("wsp_x");
  expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
    "GET /auth/stripe-app/connection?workspace=wsp_x%2Fy",
    "POST /auth/stripe-app/start",
    "POST /auth/stripe-app/sync",
    "POST /auth/stripe-app/disconnect",
  ]);
  expect(seen.slice(1).map((s) => s.body)).toEqual([
    { workspace: "wsp_x" },
    { workspace: "wsp_x" },
    { workspace: "wsp_x" },
  ]);
});

test("the Stripe page is offered by either way to have Stripe: a tab of Settings where the service has the button, a page under Connections where it keeps a credential", () => {
  // The page is a tab of Settings where the service has the button and no Connections page; and a page under Connections where it has that.
  const routes: NavRoute[] = [
    {
      path: "/settings/stripe",
      nav: { section: "settings", parent: "/settings/connections", needs: "connections" },
    },
    { path: "/settings/stripe", nav: { section: "settings", label: "Stripe", needs: "stripeApp" } },
  ];
  const base = { accounts: true, banks: false, billing: false, agents: false, backups: false };
  expect(
    availableRoutes(routes, { ...base, connections: false, stripeApp: true }).map(
      (r) => r.nav.label,
    ),
  ).toEqual(["Stripe"]);
  expect(
    availableRoutes(routes, { ...base, connections: true, stripeApp: false }).map(
      (r) => r.nav.parent,
    ),
  ).toEqual(["/settings/connections"]);
  expect(availableRoutes(routes, { ...base, connections: false, stripeApp: false })).toEqual([]);
});
