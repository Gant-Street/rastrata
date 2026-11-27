// What the Billing page does, and the banner the shell shows (src/billing-controller.ts), against a stand-in for the control plane.
import { expect, test } from "bun:test";
import type {
  BillingAnswer,
  BillingSummary,
  Result,
  Role,
  WorkspaceSummary,
} from "../../src/account";
import {
  BANNER_DAYS,
  BillingController,
  type BillingPageView,
  bannerFor,
  inWords,
  money,
  yearNote,
} from "../../src/billing-controller";

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const no = (status: number, code: string, message = "Refused."): Result<never> => ({
  ok: false,
  status,
  code,
  message,
  retryAfter: null,
});

const summary = (patch: Partial<BillingSummary> = {}): BillingSummary => ({
  state: "trialing",
  trialEndsAt: "2026-11-17T12:00:00.000Z",
  daysLeft: 12,
  readOnly: false,
  plan: null,
  periodEnd: null,
  cancelAtPeriodEnd: false,
  ...patch,
});

const PRICES = {
  month: { amount: 1900, currency: "usd" },
  year: { amount: 19000, currency: "usd" },
} as const;

const answer = (patch: Partial<BillingSummary> = {}, canManage = true): BillingAnswer => ({
  available: true,
  ...summary(patch),
  prices: PRICES,
  canManage,
});

const workspace = (role: Role, billing?: BillingSummary): WorkspaceSummary => ({
  id: "wsp_0000000001",
  name: "Acme Books",
  role,
  state: "ready",
  ...(billing ? { billing } : {}),
});

/** A control plane that keeps the calls it is asked and answers from what a test sets. */
function control(options: { role?: Role; billing?: BillingAnswer; scope?: string | null } = {}) {
  const calls: string[] = [];
  const gone: string[] = [];
  const state = {
    role: options.role ?? "owner",
    billing: options.billing ?? answer(),
    checkout: ok({ url: "https://checkout.stripe.test/c/pay/cs_test_1" }) as Result<{
      url: string;
    }>,
    portal: ok({ url: "https://billing.stripe.test/p/session/x" }) as Result<{ url: string }>,
    complete: ok({ ...summary({ state: "active", plan: "month" }), completed: true }) as Result<
      BillingSummary & { completed: boolean }
    >,
    scope: options.scope === undefined ? "wsp_0000000001" : options.scope,
  };
  return {
    calls,
    gone,
    state,
    calls_: {
      scope: () => state.scope,
      workspace: async (id: string) => {
        calls.push(`workspace ${id}`);
        return ok({ workspace: workspace(state.role) });
      },
      billing: async (id: string) => {
        calls.push(`billing ${id}`);
        return ok(state.billing);
      },
      billingCheckout: async (id: string, plan: "month" | "year") => {
        calls.push(`checkout ${id} ${plan}`);
        return state.checkout;
      },
      billingComplete: async (id: string, session: string) => {
        calls.push(`complete ${id} ${session}`);
        // After a good checkout the control plane says the workspace is subscribed.
        if (state.complete.ok && state.complete.value.completed)
          state.billing = answer({
            state: "active",
            plan: "month",
            periodEnd: "2026-12-17T12:00:00.000Z",
          });
        return state.complete;
      },
      billingPortal: async (id: string) => {
        calls.push(`portal ${id}`);
        return state.portal;
      },
    },
  };
}

function page(world: ReturnType<typeof control>) {
  const controller = new BillingController({
    control: world.calls_,
    go: (address) => void world.gone.push(address),
  });
  return controller;
}

const viewOf = (controller: BillingController): BillingPageView => {
  const current = controller.state;
  if (current.step !== "ready") throw new Error(`the page is ${current.step}`);
  return current.view;
};

test("money is written the way a person writes it, and a year is compared with twelve months", () => {
  expect(money({ amount: 1900, currency: "usd" })).toBe("$19");
  expect(money({ amount: 1950, currency: "usd" })).toBe("$19.50");
  expect(money({ amount: 19000, currency: "usd" })).toBe("$190");
  expect(yearNote(PRICES.month, PRICES.year)).toBe("Two months free");
  expect(yearNote(PRICES.month, { amount: 20900, currency: "usd" })).toBe("One month free");
  expect(yearNote(PRICES.month, { amount: 21000, currency: "usd" })).toBe("Saves $18 a year");
  expect(yearNote(PRICES.month, { amount: 22800, currency: "usd" })).toBeNull();
});

test("how a workspace stands is said in plain words for every state", () => {
  expect(inWords(summary())).toMatchObject({ headline: "Your trial has 12 days left" });
  expect(inWords(summary({ daysLeft: 1 })).headline).toBe("Your trial has 1 day left");
  expect(inWords(summary()).detail).toContain("no card is needed");
  expect(inWords(summary()).detail).toContain("read-only");
  const active = inWords(
    summary({ state: "active", plan: "year", periodEnd: "2027-10-18T12:00:00.000Z" }),
  );
  expect(active.headline).toBe("Subscribed");
  expect(active.detail).toContain("Paid yearly");
  expect(inWords(summary({ state: "active", plan: "month" })).detail).toBe("Paid monthly.");
  const ending = inWords(
    summary({ state: "active", cancelAtPeriodEnd: true, periodEnd: "2026-12-01T12:00:00.000Z" }),
  );
  expect(ending.headline).toBe("Subscribed, and ending");
  expect(ending.detail).toContain("will not renew");
  const late = inWords(summary({ state: "past_due" }));
  expect(late.headline).toBe("Your last payment did not go through");
  expect(late.detail).toContain("Stripe will try the card again");
  expect(late.detail).toContain("becomes read-only");
  // Stripe decides how long it tries: no date is promised.
  expect(late.detail).not.toMatch(/\b(20\d\d|by [A-Z][a-z]+ \d)/);
  const frozen = inWords(summary({ state: "read_only", readOnly: true }));
  expect(frozen.headline).toBe("This workspace is read-only");
  expect(frozen.detail).toContain("Nothing has been deleted");
  expect(inWords(summary({ state: "complimentary" })).headline).toBe(
    "This workspace is not billed",
  );
});

test("an owner in a trial may subscribe, for a month or a year, and is sent to Stripe's page; nothing is typed here", async () => {
  const world = control();
  const controller = page(world);
  await controller.load();
  const view = viewOf(controller);
  expect(view).toMatchObject({
    available: true,
    state: "trialing",
    headline: "Your trial has 12 days left",
    canSubscribe: true,
    canManage: false,
    prices: { month: "$19 a month", year: "$190 a year", note: "Two months free" },
  });
  await controller.startCheckout("year");
  expect(world.calls).toContain("checkout wsp_0000000001 year");
  expect(world.gone).toEqual(["https://checkout.stripe.test/c/pay/cs_test_1"]);
  // A refusal is said, and nowhere is gone.
  world.state.checkout = no(
    409,
    "already_subscribed",
    "This workspace already has a subscription.",
  );
  await controller.startCheckout("month");
  expect(viewOf(controller).error).toBe("This workspace already has a subscription.");
  expect(world.gone).toHaveLength(1);
});

test("only an owner is offered the buttons; an admin and a member are told whom to ask, and the page does nothing for them even if asked", async () => {
  for (const role of ["admin", "accountant", "member"] as const) {
    const world = control({ role, billing: answer({}, false) });
    const controller = page(world);
    await controller.load();
    expect(viewOf(controller), role).toMatchObject({ canSubscribe: false, canManage: false });
    await controller.startCheckout("month");
    await controller.manage();
    expect(
      world.calls.filter((call) => /^(checkout|portal)/.test(call)),
      role,
    ).toEqual([]);
    expect(world.gone, role).toEqual([]);
  }
});

test("a subscribed owner may open Stripe's portal, and a workspace that is read-only may subscribe", async () => {
  const subscribed = control({
    billing: answer({ state: "active", plan: "month", periodEnd: "2026-12-17T12:00:00.000Z" }),
  });
  const controller = page(subscribed);
  await controller.load();
  expect(viewOf(controller)).toMatchObject({
    canSubscribe: false,
    canManage: true,
    headline: "Subscribed",
  });
  await controller.manage();
  expect(subscribed.gone).toEqual(["https://billing.stripe.test/p/session/x"]);
  subscribed.state.portal = no(
    503,
    "unavailable",
    "That could not be done just now. Try again in a moment.",
  );
  await controller.manage();
  expect(viewOf(controller).error).toContain("Try again");

  const frozen = control({
    billing: answer({ state: "read_only", readOnly: true, daysLeft: null, trialEndsAt: null }),
  });
  const second = page(frozen);
  await second.load();
  expect(viewOf(second)).toMatchObject({
    canSubscribe: true,
    canManage: false,
    headline: "This workspace is read-only",
  });
  // A payment that failed: the owner manages the card in the portal.
  const late = control({
    billing: answer({ state: "past_due" }),
  });
  const third = page(late);
  await third.load();
  expect(viewOf(third)).toMatchObject({ canSubscribe: false, canManage: true });
});

test("coming back from Stripe the page asks the control plane how it went, and says so; leaving without paying changes nothing", async () => {
  const world = control();
  const controller = page(world);
  await controller.returned({ checkout: "done", session: "cs_test_abc" });
  expect(world.calls).toContain("complete wsp_0000000001 cs_test_abc");
  expect(viewOf(controller)).toMatchObject({
    state: "active",
    headline: "Subscribed",
    notice: "Thank you. This workspace is subscribed.",
  });
  // A checkout that was not finished.
  const unfinished = control();
  unfinished.state.complete = ok({ ...summary(), completed: false });
  const again = page(unfinished);
  await again.returned({ checkout: "done", session: "cs_test_abc" });
  expect(viewOf(again)).toMatchObject({
    state: "trialing",
    notice: "The checkout was not finished. Nothing was charged.",
  });
  // The person closed Stripe's page.
  const left = control();
  const third = page(left);
  await third.returned({ checkout: "cancelled", session: null });
  expect(left.calls.some((call) => call.startsWith("complete"))).toBe(false);
  expect(viewOf(third).notice).toBe("Nothing was charged.");
  // Stripe could not be asked.
  const broken = control();
  broken.state.complete = no(
    503,
    "unavailable",
    "That could not be done just now. Try again in a moment.",
  );
  const fourth = page(broken);
  await fourth.returned({ checkout: "done", session: "cs_test_abc" });
  expect(viewOf(fourth).error).toContain("Try again");
});

test("a service that is not set up says so and offers nothing; no workspace open, or a failed read, is a problem the page can try again", async () => {
  const off = control({ billing: { available: false } });
  const controller = page(off);
  await controller.load();
  expect(viewOf(controller)).toMatchObject({
    available: false,
    canSubscribe: false,
    canManage: false,
    prices: null,
    headline: "Billing is not set up yet",
  });
  const none = control({ scope: null });
  const second = page(none);
  await second.load();
  expect(second.state).toEqual({ step: "problem", message: "No workspace is open." });
  const failing = control();
  failing.calls_.billing = async () => no(500, "boom", "Billing could not be read.");
  const third = page(failing);
  await third.load();
  expect(third.state).toEqual({ step: "problem", message: "Billing could not be read." });
});

test("the shell tells everyone about the last days of a trial, a payment that failed, and a workspace that is read-only, and an owner is asked to act", () => {
  const trial = (days: number, role: Role) =>
    bannerFor(workspace(role, summary({ daysLeft: days })));
  expect(BANNER_DAYS).toBe(10);
  expect(trial(11, "owner")).toBeNull();
  expect(trial(10, "owner")).toMatchObject({
    tone: "info",
    title: "10 days left in your trial",
    link: "Subscribe",
  });
  expect(trial(1, "owner")?.title).toBe("1 day left in your trial");
  expect(trial(3, "member")).toMatchObject({ tone: "info", link: "Billing" });
  expect(trial(3, "member")?.text).toContain("An owner of this workspace can subscribe");
  const late = bannerFor(workspace("owner", summary({ state: "past_due" })));
  expect(late).toMatchObject({
    tone: "attention",
    title: "Your last payment did not go through",
    link: "Update the card",
  });
  expect(late?.text).toContain("to keep editing");
  expect(bannerFor(workspace("accountant", summary({ state: "past_due" })))?.link).toBe("Billing");
  const frozen = bannerFor(
    workspace("owner", summary({ state: "read_only", readOnly: true, daysLeft: null })),
  );
  expect(frozen).toMatchObject({
    tone: "attention",
    title: "This workspace is read-only",
    link: "Subscribe",
  });
  expect(
    bannerFor(workspace("admin", summary({ state: "read_only", readOnly: true })))?.text,
  ).toContain("An owner of this workspace can subscribe");
  // Nothing to say: a subscription, a workspace that is not billed, one the service does not charge for, and none at all.
  expect(bannerFor(workspace("owner", summary({ state: "active", plan: "month" })))).toBeNull();
  expect(bannerFor(workspace("owner", summary({ state: "complimentary" })))).toBeNull();
  expect(bannerFor(workspace("owner"))).toBeNull();
  expect(bannerFor(null)).toBeNull();
  expect(
    bannerFor({ ...workspace("owner", summary({ state: "read_only" })), state: "deleting" }),
  ).toBeNull();
});
