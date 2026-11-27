/** What the Bank feed screen shows, already translated from the service's answers by the web
 * controller (apps/web/src/routes/bankfeed/controller.ts). The components never see the contract's
 * own types, so a screen can be built, shown in a story and tested without the service.
 *
 * Money and dates are wire text ("6878.18", "2026-10-04", "2026-10-04T13:01:00.000Z"). The components
 * set them through the shared formatter and never turn a figure into a number. Names of banks and
 * accounts, and the Bridge's own words, come from outside: they are shown as text in `<bdi>`, never as
 * anything else. */

export type BankfeedListState = "loading" | "ready" | "error";
export type BankfeedSyncState = "idle" | "running" | "failed" | "uncertain";

/** A chart account a feed may be booked to (an open asset or liability that is not a Stripe account). */
export interface BankfeedChartOption {
  readonly value: string;
  readonly label: string;
}

/** The Bridge's balance set against the books. It is a feed balance, not a statement balance. */
export interface BankfeedBalanceView {
  readonly asOf: string;
  readonly reported: string;
  readonly ledger: string | null;
  readonly waiting: string | null;
  readonly excluded: string | null;
  readonly difference: string | null;
}

export interface BankfeedLinkView {
  readonly ledgerAccountId: string;
  /** "1000 Business Checking", or null when the chart no longer has it. */
  readonly ledgerAccount: string | null;
  readonly startOn: string;
  /** Everything before this day has been read and applied. */
  readonly through: string | null;
  readonly lastSyncAt: string | null;
  readonly lastError: string | null;
  readonly feedBalance: BankfeedBalanceView | null;
}

export type BankfeedAccountState = "unlinked" | "linked" | "unsupported" | "gone";

export interface BankfeedAccountView {
  readonly id: string;
  readonly name: string;
  readonly bank: string | null;
  /** As the Bridge writes it: "USD", or the address of a custom currency. */
  readonly currency: string;
  /** In a currency other than the book's: its lines are held for review and never converted. */
  readonly foreignCurrency: boolean;
  readonly balance: string | null;
  readonly balanceOn: string | null;
  readonly state: BankfeedAccountState;
  /** Why an account that cannot be linked cannot be, in words. */
  readonly unsupported: string | null;
  readonly link: BankfeedLinkView | null;
}

export interface BankfeedAttentionView {
  readonly code: string;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
}

export interface BankfeedRunView {
  readonly id: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly disposition: "running" | "complete" | "more" | "paused" | "failed";
  readonly trigger: "manual" | "scheduled";
  readonly requests: number;
  readonly newLines: number;
  readonly duplicateLines: number;
  readonly pendingSkipped: number;
  readonly heldLines: number;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly notes: readonly string[];
}

export interface BankfeedRequestsView {
  readonly used: number;
  readonly limit: number;
  readonly budget: number;
  readonly freesAt: string | null;
  readonly pausedUntil: string | null;
}

export interface BankfeedSettingsView {
  readonly dailySync: boolean;
  /** Local time, "HH:MM". */
  readonly dailyAt: string;
}

/** Why a sync stopped without finishing and when it may be asked again. */
export interface BankfeedPauseView {
  readonly message: string;
  readonly until: string | null;
}

export interface BankfeedCardSummary {
  readonly stage: "not-connected" | "no-links" | "ready";
  readonly lastSync: {
    readonly at: string;
    readonly ok: boolean;
    readonly newLines: number;
  } | null;
  /** How many things need the owner (errors and warnings). */
  readonly needsYou: number;
  readonly paused: boolean;
  readonly unlinked: number;
}
