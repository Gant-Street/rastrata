/** What the Bank accounts page does, as a state machine with no screen in it: which accounts the owner's bank connections have brought, where each is booked, what needs a person, and
 * the few things a person may do about that (connect a bank, choose which account in the books an account belongs to, stop reading it into the Inbox, stop the connection, read now).
 * The Solid view (routes/banks/page.tsx) draws the state and calls these functions; the tests drive them with stand-ins for the book and the control plane. Nothing here knows about the DOM.
 *
 * The book decides who may book an account and where (it says why when it refuses, and the page shows its words); the control plane decides who may connect and stop a bank. The page repeats
 * the roles' rules so that it offers only what will be accepted, never so that it decides. After each change the whole page is read again: it shows what the two hold, not what it expects. */
import type {
  AccountRow,
  BankAccount,
  BankBookResult,
  BanksStatus,
} from "@rastrata/application/client-contracts";
import type { BankConnections, Result, Role, WorkspaceSummary } from "./account.ts";
import type {
  NewBankAccount,
  NewBankAccountKind,
} from "./routes/accounting/create-bank-account.ts";

/** The book's side: reads and writes of the application, as the page makes them. */
export interface BookCalls {
  /** `fresh`: asked again to see what has come (the page looks again every few seconds for an account's first transactions), so it must not be answered from what the page holds. */
  status(fresh?: boolean): Promise<BanksStatus>;
  chart(): Promise<readonly AccountRow[]>;
  book(input: {
    account: string;
    ledgerAccountId: string;
    startOn?: string;
  }): Promise<BankBookResult>;
  unbook(account: string): Promise<unknown>;
  /** Make the account in the books that a connected bank account is booked into, named as the bank names it. */
  createAccount(
    input: NewBankAccount & { readonly account: string },
  ): Promise<{ readonly id: string; readonly warnings: readonly string[] }>;
}

/** The control plane's side. */
export interface ControlCalls {
  scope(): string | null;
  workspace(id: string): Promise<Result<{ workspace: WorkspaceSummary }>>;
  bankConnections(workspace: string): Promise<Result<BankConnections>>;
  bankLinkPath(workspace: string): string;
  bankDisconnect(workspace: string, account: string): Promise<Result<unknown>>;
  bankReadNow(workspace: string): Promise<Result<unknown>>;
}

/** Roles that may book an account to the books and stop doing so: what `configure` is given to in a book. */
const MAY_BOOK: ReadonlySet<Role> = new Set(["owner", "admin"]);
/** Roles that may connect and stop a bank: the control plane's rule. */
const MAY_CONNECT: ReadonlySet<Role> = new Set(["owner"]);
/** Roles that are told how the connections stand. */
const MAY_SEE_CONNECTIONS: ReadonlySet<Role> = new Set(["owner", "admin"]);

/** The choice that is not an account in the books yet: the one the bank names, made when the booking is made. */
export const NEW_ACCOUNT = "new";

/** The account the books would get for a connected bank account: the bank's own name for it, with the last digits
 * when the bank gives them, and what it is (a checking or savings account is a bank account, a credit card a
 * card, a line of credit or a mortgage a loan). */
export function newAccountFor(
  account: Pick<BankAccount, "name" | "last4" | "kind">,
): NewBankAccount {
  const name = account.name.trim();
  const kind: NewBankAccountKind =
    account.kind === "credit_card"
      ? "card"
      : account.kind === "line_of_credit" || account.kind === "mortgage"
        ? "loan"
        : "bank";
  return {
    name: account.last4 && !name.endsWith(account.last4) ? `${name} ${account.last4}` : name,
    kind,
  };
}

/** Roles whose accounts are Stripe's own: a bank does not feed them. */
const STRIPE_ROLE_KEYS = new Set(["stripe.balance", "payouts.in-transit"]);

const KIND_WORDS: Readonly<Record<string, string>> = {
  checking: "Checking account",
  savings: "Savings account",
  credit_card: "Credit card",
  line_of_credit: "Line of credit",
  mortgage: "Mortgage",
  other: "Account",
};

export interface ChartOption {
  readonly value: string;
  readonly label: string;
}

/** The chart accounts an account may be booked to: an open one of the sort the account is (a bank account is an asset, a card or a loan a liability; any other may be either), not one of
 * Stripe's own, and not one another account is booked to. The book refuses anything else and says why. */
export function chartOptions(
  kind: string,
  chart: readonly AccountRow[],
  taken: ReadonlySet<string>,
  own: string | null,
): ChartOption[] {
  const roles: readonly string[] =
    kind === "checking" || kind === "savings"
      ? ["asset"]
      : kind === "credit_card" || kind === "line_of_credit" || kind === "mortgage"
        ? ["liability"]
        : ["asset", "liability"];
  return chart
    .filter(
      (account) =>
        roles.includes(account.role) &&
        account.closedOn === null &&
        !STRIPE_ROLE_KEYS.has(account.tags?.roleKey ?? "") &&
        (!taken.has(account.id) || account.id === own),
    )
    .map((account) => ({ value: account.id, label: `${account.code} · ${account.name}` }));
}

/** The accounts the books already hold that a newly connected bank account could be: an open account the chart
 * marks as a bank account (for a checking or savings account) or a card (for a credit card), not one of Stripe's and
 * not one another connection feeds. A loan or an account of another sort has none: the chart does not mark those. */
export function sameAccountCandidates(
  kind: string,
  chart: readonly AccountRow[],
  taken: ReadonlySet<string>,
): ChartOption[] {
  const wanted =
    kind === "checking" || kind === "savings" ? "bank" : kind === "credit_card" ? "card" : null;
  if (wanted === null) return [];
  return chart
    .filter(
      (account) =>
        account.tags?.kind === wanted &&
        account.closedOn === null &&
        !STRIPE_ROLE_KEYS.has(account.tags?.roleKey ?? "") &&
        !taken.has(account.id),
    )
    .map((account) => ({ value: account.id, label: account.name }));
}

/** What the control plane's code for a failed reading means to a person. */
export function problemWords(code: string | null): string | null {
  if (code === null) return null;
  if (code === "refresh_failed")
    return "Your bank did not hand over its latest transactions. They are asked for again tomorrow.";
  if (code === "not_configured") return "Reading is paused until the service is set up.";
  return "The last reading did not finish. It is tried again by itself.";
}

export interface BankRow {
  readonly id: string;
  readonly institution: string;
  readonly name: string;
  /** "Checking account ending 6789". */
  readonly detail: string;
  /** The last digits the bank gives, or null. */
  readonly ending: string | null;
  /** The account in the books it is booked to, or null. */
  readonly ledgerAccountId: string | null;
  /** The accounts the books already hold that could be this very account: an open bank account (for a checking or
   * savings account) or card (for a credit card) that no other connection feeds. With none, nothing is asked: the
   * account is added to the books as the bank names it (`settle`). With one or more, the page asks one question. */
  readonly candidates: readonly ChartOption[];
  readonly state: BankAccount["state"];
  /** What the owner is asked to do, in a sentence, or null. */
  readonly attention: string | null;
  /** Where it is booked: "1000 Business Checking", and from which day. */
  readonly booking: { readonly account: string; readonly startOn: string } | null;
  readonly lastReceivedAt: string | null;
  readonly queuedLines: number;
  /** How the control plane says the last reading went, in words, or null. */
  readonly problem: string | null;
  readonly canBook: boolean;
  readonly canUnbook: boolean;
  readonly canDisconnect: boolean;
  /** The connection has stopped and the owner can sign in to the bank again (which makes a new connection; the book carries on from where this one left off). */
  readonly canReconnect: boolean;
  /** The chart accounts it may be booked to; empty when the books have none that fits. */
  readonly options: readonly ChartOption[];
  /** The account the books would get for it, named as the bank names it: the first choice, and the only one when
   * the books have none that fits. */
  readonly newAccount: NewBankAccount;
}

export interface BanksView {
  readonly workspace: WorkspaceSummary;
  readonly role: Role;
  /** The control plane can connect banks. */
  readonly available: boolean;
  readonly canConnect: boolean;
  /** The workspace has as many accounts connected as it may. */
  readonly atLimit: boolean;
  readonly limit: number | null;
  readonly rows: readonly BankRow[];
  readonly held: BanksStatus["held"];
  readonly heldCount: number;
  /** What the book said about the last booking (another source feeds the account, the first day has not come). */
  readonly notes: readonly string[];
  readonly error?: string;
  readonly notice?: string;
}

export type BanksState =
  | { readonly step: "loading" }
  | { readonly step: "problem"; readonly message: string }
  | { readonly step: "ready"; readonly view: BanksView };

export interface BanksOptions {
  readonly book: BookCalls;
  readonly control: ControlCalls;
  /** Where the browser goes next (the window that connects a bank is a page of its own). */
  readonly go: (path: string) => void;
}

const messageOf = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message !== "" ? cause.message : fallback;

export class BanksController {
  #state: BanksState = { step: "loading" };
  #settling = false;
  readonly #listeners = new Set<(state: BanksState) => void>();
  readonly #options: BanksOptions;

  constructor(options: BanksOptions) {
    this.#options = options;
  }

  get state(): BanksState {
    return this.#state;
  }

  subscribe(listener: (state: BanksState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(state: BanksState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }

  /** Read the page: when it opens, and by the view again every few seconds while an account waits for its first transactions. */
  async load(fresh = false): Promise<void> {
    const first = this.#state.step !== "ready";
    const view = await this.#read(fresh);
    if (view === null) return;
    if (!first && this.#state.step === "ready") {
      // A read that only refreshes keeps what the page said last (a notice or an error stays until the next action).
      const { error, notice, notes } = this.#state.view;
      this.#set({
        step: "ready",
        view: {
          ...view,
          ...(error ? { error } : {}),
          ...(notice ? { notice } : {}),
          notes: view.notes.length > 0 ? view.notes : notes,
        },
      });
      return;
    }
    this.#set({ step: "ready", view });
  }

  /** Looks again for what has come: from the service, not from what the page holds. */
  refresh(): Promise<void> {
    return this.load(true);
  }

  async #read(fresh = false): Promise<BanksView | null> {
    const { book, control } = this.#options;
    const id = control.scope();
    if (id === null) {
      this.#set({ step: "problem", message: "No workspace is open." });
      return null;
    }
    const detail = await control.workspace(id);
    if (!detail.ok) {
      this.#fail(detail.message);
      return null;
    }
    const workspace = detail.value.workspace;
    const role = workspace.role;
    let status: BanksStatus;
    let chart: readonly AccountRow[];
    try {
      [status, chart] = await Promise.all([book.status(fresh), book.chart().catch(() => [])]);
    } catch (cause) {
      this.#fail(messageOf(cause, "Your bank accounts could not be read."));
      return null;
    }
    // How the connections stand is for an owner or an admin; a failure to learn it is not a failure to show the accounts.
    const standing = MAY_SEE_CONNECTIONS.has(role)
      ? await control.bankConnections(workspace.id)
      : null;
    const connections = standing?.ok ? standing.value : null;
    const byId = new Map((connections?.accounts ?? []).map((item) => [item.id, item]));
    const taken = new Set(
      status.accounts.flatMap((account) =>
        account.booking ? [account.booking.ledgerAccountId] : [],
      ),
    );
    const mayBook = MAY_BOOK.has(role);
    // A connection that was stopped before it brought anything and was never booked is nothing to show.
    const shown = status.accounts.filter(
      (account) =>
        !(
          account.state === "disconnected" &&
          account.booking === null &&
          account.queuedLines === 0
        ),
    );
    const rows: BankRow[] = shown.map((account) => {
      const controlled = byId.get(account.id);
      const booked = account.booking !== null;
      const live = account.state !== "disconnected";
      return {
        id: account.id,
        institution: account.institution,
        name: account.name,
        detail: `${KIND_WORDS[account.kind] ?? "Account"}${account.last4 ? ` ending ${account.last4}` : ""}`,
        ending: account.last4,
        ledgerAccountId: account.booking?.ledgerAccountId ?? null,
        candidates: booked ? [] : sameAccountCandidates(account.kind, chart, taken),
        state: account.state,
        attention: account.attention,
        booking: account.booking
          ? {
              account: account.booking.ledgerAccount ?? "An account in your books",
              startOn: account.booking.startOn,
            }
          : null,
        lastReceivedAt: account.lastReceivedAt,
        queuedLines: account.queuedLines,
        problem: problemWords(controlled?.problem ?? null),
        // Only a connection that works is booked: one that has stopped has nothing to read until the owner signs in to the bank again (which makes a new connection that replaces it).
        canBook: mayBook && account.state === "active" && !booked,
        canUnbook: mayBook && booked,
        canDisconnect: MAY_CONNECT.has(role) && live,
        canReconnect: MAY_CONNECT.has(role) && account.state === "inactive",
        options: chartOptions(account.kind, chart, taken, account.booking?.ledgerAccountId ?? null),
        newAccount: newAccountFor(account),
      };
    });
    const connected = (connections?.accounts ?? []).filter(
      (item) => item.state !== "disconnected",
    ).length;
    return {
      workspace,
      role,
      available: connections?.available ?? MAY_CONNECT.has(role),
      canConnect: MAY_CONNECT.has(role) && (connections?.available ?? true),
      atLimit: connections !== null && connected >= connections.limit,
      limit: connections?.limit ?? null,
      rows,
      held: status.held,
      heldCount: status.heldCount,
      notes: [],
    };
  }

  /** A failure to read is shown in place of the page only while there is nothing to show; later it is a line above what is there. */
  #fail(message: string): void {
    if (this.#state.step === "ready")
      this.#set({ step: "ready", view: { ...this.#state.view, error: message } });
    else this.#set({ step: "problem", message });
  }

  /** Tell the page what a change did, then read it again. */
  async #after(
    notice: string | null,
    error: string | null,
    notes: readonly string[] = [],
  ): Promise<void> {
    await this.load();
    if (this.#state.step !== "ready") return;
    const { error: _old, notice: _older, ...rest } = this.#state.view;
    this.#set({
      step: "ready",
      view: {
        ...rest,
        notes,
        ...(error ? { error } : notice ? { notice } : {}),
      },
    });
  }

  /** Open the window that connects a bank (a page of its own, which Stripe's script runs on). */
  connect(): void {
    const id = this.#options.control.scope();
    if (id !== null) this.#options.go(this.#options.control.bankLinkPath(id));
  }

  /** Book an account to a chart account, from a first day (the book's cutover date when none is given); the transactions Stripe already holds for it are read at once. The choice
   * `NEW_ACCOUNT` makes the account first, named as the bank names it, and books into that. */
  async book(account: string, choice: string, startOn: string): Promise<boolean> {
    if (choice === "") {
      await this.#after(null, "Choose which account in your books this one belongs to.");
      return false;
    }
    let notes: readonly string[] = [];
    let ledgerAccountId = choice;
    if (choice === NEW_ACCOUNT) {
      const row =
        this.#state.step === "ready"
          ? this.#state.view.rows.find((item) => item.id === account)
          : undefined;
      if (!row) {
        await this.#after(null, "That bank account is no longer here. Read the page again.");
        return false;
      }
      try {
        const made = await this.#options.book.createAccount({ ...row.newAccount, account });
        ledgerAccountId = made.id;
        notes = made.warnings;
      } catch (cause) {
        await this.#after(null, messageOf(cause, "The account could not be made."));
        return false;
      }
    }
    try {
      const done = await this.#options.book.book({
        account,
        ledgerAccountId,
        ...(startOn.trim() === "" ? {} : { startOn: startOn.trim() }),
      });
      notes = [...notes, ...done.notes];
    } catch (cause) {
      await this.#after(null, messageOf(cause, "That account could not be booked."));
      return false;
    }
    // The transactions that are waiting at Stripe are read now and not at the next reading; the book has the account booked either way.
    const id = this.#options.control.scope();
    if (id !== null) await this.#options.control.bankReadNow(id);
    await this.#after(
      "Booked. New transactions are imported as your bank posts them.",
      null,
      notes,
    );
    return true;
  }

  /** Put in the books every connected account about which there is nothing to ask: one that works, is not booked,
   * and that the books hold no bank account or card it could be. Each gets an account named as the bank names it and
   * is read from the day the books start. Run after the page is read; it does nothing for a person who may not book,
   * and nothing a second time. Gives back how many were added. */
  async settle(): Promise<number> {
    if (this.#settling || this.#state.step !== "ready") return 0;
    const waiting = this.#state.view.rows.filter(
      (row) => row.canBook && row.candidates.length === 0,
    );
    if (waiting.length === 0) return 0;
    this.#settling = true;
    let added = 0;
    try {
      for (const row of waiting) {
        try {
          const made = await this.#options.book.createAccount({
            ...row.newAccount,
            account: row.id,
          });
          await this.#options.book.book({ account: row.id, ledgerAccountId: made.id });
          added += 1;
        } catch {
          // What could not be added stays on the page with its question, and the next reading tries again.
        }
      }
      if (added > 0) {
        const id = this.#options.control.scope();
        if (id !== null) await this.#options.control.bankReadNow(id);
      }
    } finally {
      this.#settling = false;
    }
    const bank = waiting[0]?.institution ?? "Your bank";
    await this.#after(
      added === 0
        ? null
        : `${bank} is connected. ${added === 1 ? "1 account was" : `${added} accounts were`} added to your books.`,
      null,
    );
    return added;
  }

  /** Move a booked account to another account in the books, or to a new one, from a first day: it stops being read
   * into the one and starts being read into the other. */
  async change(account: string, choice: string, startOn: string): Promise<boolean> {
    try {
      await this.#options.book.unbook(account);
    } catch (cause) {
      await this.#after(null, messageOf(cause, "That account could not be changed."));
      return false;
    }
    await this.load();
    return this.book(account, choice, startOn);
  }

  async unbook(account: string): Promise<void> {
    try {
      await this.#options.book.unbook(account);
    } catch (cause) {
      await this.#after(null, messageOf(cause, "That account could not be changed."));
      return;
    }
    await this.#after(
      "Stopped. Transactions waiting for review and in your books stay where they are.",
      null,
    );
  }

  /** Stop a connection (an owner): the bank is no longer read, and what is already in the books stays. */
  async disconnect(account: string): Promise<void> {
    const id = this.#options.control.scope();
    if (id === null) return;
    const done = await this.#options.control.bankDisconnect(id, account);
    if (!done.ok) {
      await this.#after(null, done.message);
      return;
    }
    await this.#after(
      "Disconnected. Nothing more is read from that account; what is already in your books stays.",
      null,
    );
  }

  /** Read the accounts now. */
  async readNow(): Promise<void> {
    const id = this.#options.control.scope();
    if (id === null) return;
    const done = await this.#options.control.bankReadNow(id);
    if (!done.ok) {
      await this.#after(null, done.message);
      return;
    }
    await this.#after("Read. Anything new is waiting for review.", null);
  }
}
