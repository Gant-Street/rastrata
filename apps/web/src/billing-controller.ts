/** What the Billing page does, as a state machine with no screen in it: how the workspace stands as to its trial and subscription, and the few things an owner may do about it (subscribe for a month or a
 * year on Stripe's own page, manage the subscription in Stripe's customer portal). The Solid view (routes/billing/page.tsx) draws the state and calls these functions; the tests drive them with a
 * stand-in for the control plane. Nothing here knows about the DOM. The same words make the banner the shell shows everyone in a workspace in the last days of a trial, when a payment has failed and when
 * the workspace is read-only (`bannerFor`).
 *
 * The control plane decides everything: who may subscribe (an owner), what a subscription costs, and how the workspace stands. The page repeats the roles' rule so that it offers only what will be accepted,
 * never so that it decides. A card is never typed here: the person is sent to Stripe's page and comes back, and then the control plane asks Stripe how it went. */
import { formatDate, formatMoney } from "@rastrata/ui/format";
import type {
  BillingAnswer,
  BillingPrice,
  BillingState,
  BillingSummary,
  Result,
  Role,
  WorkspaceSummary,
} from "./account.ts";

/** The control plane's side. */
export interface BillingCalls {
  scope(): string | null;
  workspace(id: string): Promise<Result<{ workspace: WorkspaceSummary }>>;
  billing(workspace: string): Promise<Result<BillingAnswer>>;
  billingCheckout(workspace: string, plan: "month" | "year"): Promise<Result<{ url: string }>>;
  billingComplete(
    workspace: string,
    session: string,
  ): Promise<Result<BillingSummary & { completed: boolean }>>;
  billingPortal(workspace: string): Promise<Result<{ url: string }>>;
}

/** Roles that may subscribe a workspace and manage the subscription: the control plane's rule. */
const MAY_MANAGE: ReadonlySet<Role> = new Set(["owner"]);

const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);

const CURRENCY_SIGNS: Readonly<Record<string, string>> = { USD: "$" };

/** An amount in the smallest unit of its currency, as a person writes it: `$19`, `$19.50`. The figure is the formatter's, made from the whole cents as text (no number is divided or rounded here). */
export function money(price: BillingPrice): string {
  const digits = String(Math.max(0, Math.trunc(price.amount))).padStart(3, "0");
  const figure = formatMoney(`${digits.slice(0, -2)}.${digits.slice(-2)}`);
  const written = digits.endsWith("00") ? figure.replace(/\.00$/, "") : figure;
  const code = price.currency.toUpperCase();
  const sign = CURRENCY_SIGNS[code];
  return sign ? `${sign}${written}` : `${written} ${code}`;
}

/** What a year costs against twelve months, in words (`Two months free`), or null when it costs no less. */
export function yearNote(month: BillingPrice, year: BillingPrice): string | null {
  const saved = 12 * month.amount - year.amount;
  if (saved <= 0 || month.amount <= 0) return null;
  const months = saved / month.amount;
  if (Number.isInteger(months))
    return months === 1 ? "One month free" : `${months === 2 ? "Two" : months} months free`;
  return `Saves ${money({ amount: saved, currency: year.currency })} a year`;
}

export interface Headline {
  /** What stands out: one line. */
  readonly headline: string;
  /** What it means, and what to do, in a sentence or two; null when there is nothing to add. */
  readonly detail: string | null;
}

/** How a workspace stands, in words, for the page. */
export function inWords(billing: BillingSummary): Headline {
  switch (billing.state) {
    case "trialing": {
      const days = billing.daysLeft ?? 0;
      return {
        headline: `Your trial has ${days} ${plural(days, "day", "days")} left`,
        detail: `Everything works during the trial and no card is needed. It ends on ${
          billing.trialEndsAt ? formatDate(billing.trialEndsAt) : "the day shown"
        }. After that this workspace is read-only until it is subscribed: you can still read your books and export them.`,
      };
    }
    case "active": {
      const paid = billing.plan === "year" ? "Paid yearly" : "Paid monthly";
      if (billing.cancelAtPeriodEnd)
        return {
          headline: "Subscribed, and ending",
          detail: `This subscription will not renew. It ends on ${
            billing.periodEnd ? formatDate(billing.periodEnd) : "the end of the period"
          }, and then this workspace is read-only.`,
        };
      return {
        headline: "Subscribed",
        detail: billing.periodEnd
          ? `${paid}. It renews on ${formatDate(billing.periodEnd)}.`
          : `${paid}.`,
      };
    }
    case "past_due":
      return {
        headline: "Your last payment did not go through",
        detail:
          "Stripe will try the card again. If it keeps failing, the subscription ends and this workspace becomes read-only. Update the card to avoid that.",
      };
    case "read_only":
      return {
        headline: "This workspace is read-only",
        detail:
          "You can read your books and export them. Subscribing lets you post, import and change things again. Nothing has been deleted.",
      };
    case "complimentary":
      return { headline: "This workspace is not billed", detail: null };
  }
}

export interface BillingPageView {
  readonly workspace: WorkspaceSummary;
  readonly role: Role;
  /** The service charges for workspaces and has its prices (billing is set up). */
  readonly available: boolean;
  readonly state: BillingState | null;
  readonly headline: string;
  readonly detail: string | null;
  /** Account-level flat pricing coverage note (e.g. how many owned businesses the subscription covers). */
  readonly coverage: string | null;
  /** True when the signed-in user is this workspace's billing owner. */
  readonly isBillingOwner: boolean;
  /** Number of active businesses owned by the billing owner, and the self-serve plan limit. */
  readonly ownedWorkspaces: number | null;
  readonly workspaceLimit: number | null;
  /** The billing owner may subscribe: the account has none. */
  readonly canSubscribe: boolean;
  /** The billing owner may open Stripe's portal: the account has a subscription. */
  readonly canManage: boolean;
  /** What a subscription costs, as a person writes it (`$19 a month`, `$190 a year`), and what a year saves. */
  readonly prices: {
    readonly month: string;
    readonly year: string;
    readonly note: string | null;
  } | null;
  readonly error?: string;
  readonly notice?: string;
}

export type BillingPageState =
  | { readonly step: "loading" }
  | { readonly step: "problem"; readonly message: string }
  | { readonly step: "ready"; readonly view: BillingPageView };

export interface BillingOptions {
  readonly control: BillingCalls;
  /** Where the browser goes next: Stripe's own page. */
  readonly go: (address: string) => void;
  /** Called after checkout completes so the shell refreshes the workspace banner immediately. */
  readonly onChanged?: () => void;
}

const messageOf = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message !== "" ? cause.message : fallback;

/** What the address the person came back to says: Stripe's page sends them to `?checkout=done&session=<id>`, or `?checkout=cancelled`. */
export interface Returned {
  readonly checkout: string | null;
  readonly session: string | null;
}

export class BillingController {
  #state: BillingPageState = { step: "loading" };
  readonly #listeners = new Set<(state: BillingPageState) => void>();
  readonly #options: BillingOptions;

  constructor(options: BillingOptions) {
    this.#options = options;
  }

  get state(): BillingPageState {
    return this.#state;
  }

  subscribe(listener: (state: BillingPageState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(state: BillingPageState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }

  #fail(message: string): void {
    this.#set({ step: "problem", message });
  }

  /** Read the page: when it opens, and again after a change. A notice or an error stays until the next action. */
  async load(): Promise<void> {
    const view = await this.#read();
    if (view === null) return;
    if (this.#state.step === "ready") {
      const { error, notice } = this.#state.view;
      this.#set({
        step: "ready",
        view: { ...view, ...(error ? { error } : {}), ...(notice ? { notice } : {}) },
      });
      return;
    }
    this.#set({ step: "ready", view });
  }

  async #read(): Promise<BillingPageView | null> {
    const { control } = this.#options;
    const id = control.scope();
    if (id === null) {
      this.#fail("No workspace is open.");
      return null;
    }
    const [detail, answer] = await Promise.all([control.workspace(id), control.billing(id)]);
    if (!detail.ok) {
      this.#fail(detail.message);
      return null;
    }
    if (!answer.ok) {
      this.#fail(answer.message);
      return null;
    }
    const workspace = detail.value.workspace;
    const role = workspace.role;
    if (!answer.value.available)
      return {
        workspace,
        role,
        available: false,
        state: null,
        headline: "Billing is not set up yet",
        detail: null,
        coverage: null,
        isBillingOwner: false,
        ownedWorkspaces: null,
        workspaceLimit: null,
        canSubscribe: false,
        canManage: false,
        prices: null,
      };
    const billing = answer.value;
    const words = inWords(billing);
    const isBillingOwner = MAY_MANAGE.has(role) && billing.canManage;
    const subscribed = billing.state === "active" || billing.state === "past_due";
    const ownedWorkspaces =
      typeof billing.ownedWorkspaces === "number" ? billing.ownedWorkspaces : null;
    const workspaceLimit =
      typeof billing.workspaceLimit === "number" ? billing.workspaceLimit : null;
    const coverage = isBillingOwner
      ? ownedWorkspaces !== null
        ? workspaceLimit !== null
          ? ownedWorkspaces <= 1
            ? `One subscription covers all businesses you own (${ownedWorkspaces} of ${workspaceLimit} included).`
            : `One subscription covers all ${ownedWorkspaces} businesses you own (${ownedWorkspaces} of ${workspaceLimit} included).`
          : `One subscription covers all ${ownedWorkspaces} ${plural(ownedWorkspaces, "business", "businesses")} you own.`
        : "One subscription covers all businesses you own."
      : "Billing for this workspace is managed by its billing owner.";
    return {
      workspace,
      role,
      available: true,
      state: billing.state,
      headline: words.headline,
      detail: words.detail,
      coverage,
      isBillingOwner,
      ownedWorkspaces,
      workspaceLimit,
      canSubscribe:
        isBillingOwner && (billing.state === "trialing" || billing.state === "read_only"),
      canManage: isBillingOwner && subscribed,
      prices: {
        month: `${money(billing.prices.month)} a month`,
        year: `${money(billing.prices.year)} a year`,
        note: yearNote(billing.prices.month, billing.prices.year),
      },
    };
  }

  /** The person is back from Stripe's page: the control plane asks Stripe how it went, and the page says so. */
  async returned(came: Returned): Promise<void> {
    const { control } = this.#options;
    const id = control.scope();
    await this.load();
    if (id === null || this.#state.step !== "ready") return;
    if (came.checkout === "done" && came.session !== null) {
      const done = await control.billingComplete(id, came.session);
      await this.load();
      if (!done.ok) return this.#say({ error: done.message });
      if (done.value.completed) this.#options.onChanged?.();
      return this.#say(
        done.value.completed
          ? { notice: "Thank you. This workspace is subscribed." }
          : { notice: "The checkout was not finished. Nothing was charged." },
      );
    }
    if (came.checkout === "cancelled") this.#say({ notice: "Nothing was charged." });
  }

  #say(note: { readonly error?: string; readonly notice?: string }): void {
    if (this.#state.step !== "ready") return;
    const { error: _error, notice: _notice, ...view } = this.#state.view;
    this.#set({ step: "ready", view: { ...view, ...note } });
  }

  /** An owner subscribes: Stripe's page opens. */
  async startCheckout(plan: "month" | "year"): Promise<void> {
    const { control, go } = this.#options;
    const id = control.scope();
    if (id === null || this.#state.step !== "ready" || !this.#state.view.canSubscribe) return;
    const made = await control.billingCheckout(id, plan);
    if (!made.ok) return this.#say({ error: made.message });
    go(made.value.url);
  }

  /** An owner opens Stripe's customer portal. */
  async manage(): Promise<void> {
    const { control, go } = this.#options;
    const id = control.scope();
    if (id === null || this.#state.step !== "ready" || !this.#state.view.canManage) return;
    try {
      const made = await control.billingPortal(id);
      if (!made.ok) return this.#say({ error: made.message });
      go(made.value.url);
    } catch (cause) {
      this.#say({ error: messageOf(cause, "That could not be done. Try again in a moment.") });
    }
  }
}

// ---- the banner ---------------------------------------------------------------------------------------------------------------------

export interface Banner {
  readonly tone: "info" | "attention";
  readonly title: string;
  readonly text: string;
  /** What the link to the Billing page says. */
  readonly link: string;
}

/** Days before the end of a trial from which everyone in the workspace is told. */
export const BANNER_DAYS = 10;

/** What the shell tells everyone in a workspace about its trial or subscription, or null when there is nothing to say. An owner is asked to act; the others are told whom to ask. */
export function bannerFor(workspace: WorkspaceSummary | null | undefined): Banner | null {
  const billing = workspace?.billing;
  if (!workspace || !billing || workspace.state !== "ready") return null;
  const owner = MAY_MANAGE.has(workspace.role) && workspace.billingOwner !== false;
  switch (billing.state) {
    case "trialing": {
      const days = billing.daysLeft ?? 0;
      if (days > BANNER_DAYS) return null;
      return {
        tone: "info",
        title: `${days} ${plural(days, "day", "days")} left in your trial`,
        text: owner
          ? "Subscribe to keep editing after it ends."
          : "An owner of this workspace can subscribe to keep editing after it ends.",
        link: owner ? "Subscribe" : "Billing",
      };
    }
    case "active": {
      if (!billing.cancelAtPeriodEnd) return null;
      const ends = billing.periodEnd ? formatDate(billing.periodEnd) : "the end of the period";
      return {
        tone: "info",
        title: "Your subscription will not renew",
        text: owner
          ? `It ends on ${ends}, and then your owned workspaces become read-only.`
          : `It ends on ${ends}, and then this workspace becomes read-only.`,
        link: owner ? "Manage subscription" : "Billing",
      };
    }
    case "past_due":
      return {
        tone: "attention",
        title: "Your last payment did not go through",
        text: owner
          ? "Update the card to keep editing."
          : "An owner of this workspace needs to update the card to keep it editable.",
        link: owner ? "Update the card" : "Billing",
      };
    case "read_only":
      return {
        tone: "attention",
        title: "This workspace is read-only",
        text: owner
          ? "You can read and export your books. Subscribe to edit again."
          : "You can read and export your books. An owner of this workspace can subscribe to edit again.",
        link: owner ? "Subscribe" : "Billing",
      };
    default:
      return null;
  }
}
