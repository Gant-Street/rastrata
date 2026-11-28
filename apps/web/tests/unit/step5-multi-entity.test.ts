import { afterEach, expect, test } from "bun:test";
import {
  Account,
  TAB_WORKSPACE_KEY,
  WORKSPACE_KEY,
  type BillingAnswer,
  type WorkspaceSummary,
} from "../../src/account";
import { installAuthorizer } from "../../src/ambient";
import { BillingController, bannerFor } from "../../src/billing-controller";
import { bootAccounts } from "../../src/boot";
import { learnCapabilities } from "../../src/capabilities";
import { GateController } from "../../src/gate-controller";
import { refuseFile } from "../../src/routes/statements/upload";

afterEach(() => {
  installAuthorizer(null);
  learnCapabilities(null);
});

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

test("multi-tab isolation: switching workspaces in Tab A leaves Tab B pinned to its own LLC", () => {
  const sharedLocal = memoryStorage();
  sharedLocal.setItem(WORKSPACE_KEY, "wsp_alpha");
  const tabA = memoryStorage();
  const tabB = memoryStorage();

  const accountA = new Account({ storage: sharedLocal, tabStorage: tabA });
  const accountB = new Account({ storage: sharedLocal, tabStorage: tabB });

  // Both tabs read their initial scope and pin it into their own sessionStorage.
  expect(accountA.scope()).toBe("wsp_alpha");
  expect(accountB.scope()).toBe("wsp_alpha");
  expect(tabA.getItem(TAB_WORKSPACE_KEY)).toBe("wsp_alpha");
  expect(tabB.getItem(TAB_WORKSPACE_KEY)).toBe("wsp_alpha");

  // Tab A switches to Beta LLC. localStorage updates for future tabs, but Tab B stays pinned on Alpha.
  accountA.select("wsp_beta");
  expect(accountA.scope()).toBe("wsp_beta");
  expect(sharedLocal.getItem(WORKSPACE_KEY)).toBe("wsp_beta");
  expect(accountB.scope()).toBe("wsp_alpha");

  // A brand-new Tab C inherits the most recently selected workspace from localStorage.
  const tabC = memoryStorage();
  const accountC = new Account({ storage: sharedLocal, tabStorage: tabC });
  expect(accountC.scope()).toBe("wsp_beta");
});

test("bootAccounts resolves ?workspace=<slug> and ?workspace=<id> deep links into tabStorage", async () => {
  const sharedLocal = memoryStorage();
  sharedLocal.setItem(WORKSPACE_KEY, "wsp_alpha");
  const tab = memoryStorage();
  const ask = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/health") {
      return Response.json({ service: "rastrata", hosted: { book: "b", accounts: true } });
    }
    if (path === "/auth/workspaces") {
      return Response.json({
        workspaces: [
          { id: "wsp_alpha", name: "Alpha LLC", slug: "alpha-llc", role: "owner", state: "ready" },
          {
            id: "wsp_beta",
            name: "Beta Holdings",
            slug: "beta-holdings",
            role: "owner",
            state: "ready",
          },
        ],
      });
    }
    if (path === "/auth/config") return Response.json({ billing: false });
    if (path === "/auth/workspace-token") return Response.json({ token: "tok", expiresIn: 600 });
    return Response.json({});
  }) as unknown as typeof fetch;

  const booted = await bootAccounts({
    ask,
    go: () => {},
    storage: sharedLocal,
    tabStorage: tab,
    search: "?workspace=beta-holdings",
  });
  expect(booted.redirecting).toBe(false);
  expect(booted.account?.scope()).toBe("wsp_beta");
  expect(tab.getItem(TAB_WORKSPACE_KEY)).toBe("wsp_beta");
});

test("renameWorkspace and transferBillingOwner hit their control-plane endpoints", async () => {
  const seen: { method: string; url: string; body: unknown }[] = [];
  const ask = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      method: init?.method ?? "GET",
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return Response.json({
      workspace: { id: "wsp_1", name: "Renamed LLC", role: "owner", state: "ready" },
    });
  }) as unknown as typeof fetch;

  const account = new Account({ ask, storage: memoryStorage() });
  const renamed = await account.renameWorkspace("wsp_1", "  Renamed LLC ");
  expect(renamed.ok).toBe(true);
  const transferred = await account.transferBillingOwner("wsp_1", "user_2");
  expect(transferred.ok).toBe(true);
  expect(seen).toEqual([
    {
      method: "POST",
      url: "/auth/workspaces/rename",
      body: { workspace: "wsp_1", name: "Renamed LLC" },
    },
    {
      method: "POST",
      url: "/auth/workspaces/transfer-billing",
      body: { workspace: "wsp_1", userId: "user_2" },
    },
  ]);
});

test("GateController auto-opens a 2nd+ workspace once it transitions from provisioning to ready", async () => {
  const existing: WorkspaceSummary = {
    id: "wsp_1",
    name: "First LLC",
    role: "owner",
    state: "ready",
  };
  let second: WorkspaceSummary = {
    id: "wsp_2",
    name: "Second LLC",
    role: "owner",
    state: "provisioning",
  };
  let selected: string | null = "wsp_1";
  const went: string[] = [];

  const gate = new GateController({
    account: {
      config: async () => ({ ok: true, value: { captcha: null } }),
      session: async () => ({ ok: true, value: { id: "user_1", email: "founder@example.com" } }),
      workspaces: async () => ({ ok: true, value: [existing, second] }),
      createWorkspace: async () => ({ ok: true, value: second }),
      restoreHint: async () => ({ ok: true, value: {} }),
      select: (id: string | null) => {
        selected = id;
      },
      scope: () => selected,
    } as never,
    go: (path) => void went.push(path),
    path: "/start",
    choose: true,
  });

  await gate.start();
  await gate.createWorkspace("Second LLC");
  expect(gate.state).toMatchObject({ step: "workspaces", waiting: true });
  expect(went).toEqual([]);

  second = { ...second, state: "ready" };
  await gate.refresh();
  expect(gate.state.step).toBe("done");
  expect(selected).toBe("wsp_2");
  expect(went).toEqual(["/"]);
});

test("BillingController reports account-level coverage, notifies on checkout completion, and bannerFor shows cancelAtPeriodEnd", async () => {
  let changedCalls = 0;
  const billing: BillingAnswer = {
    available: true,
    state: "trialing",
    trialEndsAt: "2026-12-20T00:00:00.000Z",
    daysLeft: 18,
    readOnly: false,
    plan: null,
    periodEnd: null,
    cancelAtPeriodEnd: false,
    prices: {
      month: { amount: 1900, currency: "usd" },
      year: { amount: 19000, currency: "usd" },
    },
    canManage: true,
    ownedWorkspaces: 3,
    workspaceLimit: 10,
  };
  const ws: WorkspaceSummary = {
    id: "wsp_1",
    name: "Alpha LLC",
    role: "owner",
    state: "ready",
    billingOwner: true,
  };

  const controller = new BillingController({
    control: {
      scope: () => "wsp_1",
      workspace: async () => ({ ok: true, value: { workspace: ws } }),
      billing: async () => ({ ok: true, value: billing }),
      billingCheckout: async () => ({ ok: true, value: { url: "https://stripe.test/checkout" } }),
      billingComplete: async () => ({
        ok: true,
        value: {
          completed: true,
          state: "active",
          trialEndsAt: null,
          daysLeft: null,
          readOnly: false,
          plan: "year",
          periodEnd: "2027-12-20T00:00:00.000Z",
          cancelAtPeriodEnd: false,
        },
      }),
      billingPortal: async () => ({ ok: true, value: { url: "https://stripe.test/portal" } }),
    },
    go: () => {},
    onChanged: () => {
      changedCalls += 1;
    },
  });

  await controller.load();
  expect(controller.state.step).toBe("ready");
  if (controller.state.step === "ready") {
    expect(controller.state.view.isBillingOwner).toBe(true);
    expect(controller.state.view.ownedWorkspaces).toBe(3);
    expect(controller.state.view.workspaceLimit).toBe(10);
    expect(controller.state.view.coverage).toContain("3 businesses you own");
    expect(controller.state.view.coverage).toContain("3 of 10");
  }

  await controller.returned({ checkout: "done", session: "cs_test_12345" });
  expect(changedCalls).toBe(1);

  const endingBanner = bannerFor({
    ...ws,
    billing: {
      state: "active",
      trialEndsAt: null,
      daysLeft: null,
      readOnly: false,
      plan: "month",
      periodEnd: "2026-12-31T00:00:00.000Z",
      cancelAtPeriodEnd: true,
    },
  });
  expect(endingBanner).toMatchObject({
    tone: "info",
    title: "Your subscription will not renew",
    link: "Manage subscription",
  });
});

test("statement upload accepts .xlsx while still rejecting .pdf and .xls", () => {
  expect(refuseFile({ name: "chase-2026-01.xlsx", size: 4096 })).toBeNull();
  expect(refuseFile({ name: "statement.pdf", size: 4096 })).toContain("PDF");
  expect(refuseFile({ name: "legacy.xls", size: 4096 })).toContain("Excel");
});
