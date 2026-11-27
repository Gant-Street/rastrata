import { QUOTA_WINDOW_MS } from "../../bankfeed/constants.ts";
import type { CredentialDescription } from "../../bankfeed/credentials.ts";
import type { ProblemView } from "../../bankfeed/problems.ts";
import { safeText } from "../../bankfeed/redact.ts";
import { utcDate } from "../../bankfeed/time.ts";
import type {
  BankfeedAccount,
  BankfeedAttention,
  BankfeedFeedBalance,
  BankfeedProblem,
  BankfeedRequests,
  BankfeedRun,
} from "../../client-contracts.gen.ts";
import { REQUESTS_BUDGET, REQUESTS_LIMIT, quotaAt } from "./budget.ts";
import type { AccountRow, BankfeedStore, ConnectionRow, LinkRow, RunRow } from "./store.ts";

const iso = (ms: number): string => new Date(ms).toISOString();

export function requestsWire(store: BankfeedStore, nowMs: number): BankfeedRequests {
  const quota = quotaAt(store, nowMs);
  const paused = store.connection().pausedUntil;
  return {
    used: quota.used,
    limit: REQUESTS_LIMIT,
    budget: REQUESTS_BUDGET,
    freesAt: quota.freesAtMs === null ? null : iso(quota.freesAtMs),
    pausedUntil: paused !== null && Date.parse(paused) > nowMs ? paused : null,
  };
}

export function runWire(run: RunRow): BankfeedRun {
  return {
    id: run.id,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    disposition: run.disposition,
    trigger: run.trigger,
    requests: run.requests,
    accounts: run.accounts,
    windows: run.windows,
    newLines: run.newLines,
    duplicateLines: run.duplicateLines,
    pendingSkipped: run.pendingSkipped,
    heldLines: run.heldLines,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    notes: run.notes.slice(0, 12).map((note) => note.slice(0, 500)),
  };
}

export function problemWire(problem: ProblemView): BankfeedProblem {
  return {
    kind: problem.kind,
    code: problem.code,
    bank: problem.bank,
    account: problem.account,
    message: problem.message.slice(0, 700),
    said: problem.said.slice(0, 300),
  };
}

/** What a view of the accounts needs from the rest of the book. All of it is optional: a quick
 * status (`books: false`) reads none of it. */
export interface BooksView {
  readonly bookCurrency: string;
  /** "1000 Business Checking" for a chart account id, or null. */
  readonly chartLabel: (ledgerAccountId: string) => string | null;
  /** The first day the Inbox keeps lines from for a provider account key. */
  readonly sourceStartOn: (accountKey: string) => string | null;
  readonly feedBalance: (accountKey: string) => BankfeedFeedBalance | null;
  readonly accountKey: (accountId: string) => string;
}

export function accountWire(
  row: AccountRow,
  link: LinkRow | undefined,
  books: BooksView,
): BankfeedAccount {
  const foreign = row.isoCurrency !== null && row.isoCurrency !== books.bookCurrency;
  const key = books.accountKey(row.accountId);
  const state: BankfeedAccount["state"] = !row.listed
    ? "gone"
    : link
      ? "linked"
      : row.support !== "ok"
        ? "unsupported"
        : "unlinked";
  return {
    id: row.accountId,
    name: row.name,
    bank: row.orgName,
    currency: row.currency,
    isoCurrency: row.isoCurrency,
    foreignCurrency: foreign,
    balance: row.balance,
    balanceOn: row.balanceOn,
    support: row.support,
    state,
    link: link
      ? {
          ledgerAccountId: link.ledgerAccountId,
          ledgerAccount: books.chartLabel(link.ledgerAccountId),
          startOn: link.startOn,
          sourceStartOn: books.sourceStartOn(key),
          linkedAt: link.linkedAt,
          through: link.through === null ? null : utcDate(link.through),
          lastSyncAt: link.lastSyncAt,
          lastOkAt: link.lastOkAt,
          lastError:
            link.lastErrorCode === null
              ? null
              : {
                  code: link.lastErrorCode.slice(0, 80),
                  message: (link.lastErrorMessage ?? "").slice(0, 700),
                },
          feedBalance: books.feedBalance(key),
        }
      : null,
  };
}

const SEVERITY: Record<BankfeedAttention["severity"], number> = { error: 0, warning: 1, info: 2 };

export interface AttentionInput {
  readonly credential: CredentialDescription;
  readonly connection: ConnectionRow;
  readonly accounts: readonly BankfeedAccount[];
  readonly links: readonly LinkRow[];
  readonly heldCount: number;
  readonly nowMs: number;
  /** Days without a successful sync after which a connected, linked feed is called stale. */
  readonly staleAfterDays: number;
}

/** What needs the owner, most important first. Empty means nothing does. Every line is a sentence a
 * person can act on; none quotes text from the bank. */
export function attentionOf(input: AttentionInput): BankfeedAttention[] {
  const out: BankfeedAttention[] = [];
  const add = (code: string, severity: BankfeedAttention["severity"], message: string) =>
    out.push({ code, severity, message: message.slice(0, 900) });
  const { credential, connection, accounts, links, nowMs } = input;

  if (credential.problem !== null) add("credential_unusable", "error", credential.problem);
  else if (!credential.present && connection.connectedAt !== null)
    add(
      "credential_missing",
      "error",
      "The access URL for the SimpleFIN Bridge is not saved on this computer (a backup or a copy of the book does not carry it, on purpose). Connect again with a new setup token; your links and imported lines are kept.",
    );
  if (connection.attentionCode !== null && connection.attentionMessage !== null)
    add(
      connection.attentionCode,
      connection.attentionCode === "rate_limited" ? "warning" : "error",
      connection.attentionMessage,
    );
  const paused = connection.pausedUntil;
  if (paused !== null && Date.parse(paused) > nowMs)
    add(
      "paused",
      "warning",
      "Syncing is paused because the Bridge asked Rastrata to slow down. It carries on by itself when the pause ends.",
    );
  for (const issue of connection.issues) {
    const severity = issue.kind === "connection" || issue.kind === "access" ? "error" : "warning";
    add(`bridge_${issue.kind}`, severity, issue.message);
  }
  for (const account of accounts) {
    if (account.link === null) continue;
    if (account.state === "gone")
      add(
        "account_gone",
        "error",
        `The Bridge no longer lists ${account.name}. Nothing more can be read for it until it is listed again; check that the bank connection at the Bridge is still there.`,
      );
    else if (account.link.lastError !== null)
      add("account_error", "warning", `${account.name}: ${account.link.lastError.message}`);
  }
  if (input.heldCount > 0)
    add(
      "transactions_held",
      "warning",
      `${input.heldCount} ${input.heldCount === 1 ? "transaction" : "transactions"} could not be read exactly and ${input.heldCount === 1 ? "was" : "were"} not imported. Import that period from a statement file, or add ${input.heldCount === 1 ? "it" : "them"} by hand; the feed balance will keep showing the difference until you do.`,
    );

  const unlinked = accounts.filter((account) => account.state === "unlinked").length;
  const linked = accounts.filter((account) => account.link !== null).length;
  const connected = credential.present;
  if (connected && linked === 0 && unlinked > 0)
    add(
      "no_links",
      "warning",
      `The Bridge lists ${unlinked} ${unlinked === 1 ? "account" : "accounts"} and none is linked to a chart account yet. Choose which to read: nothing is fetched until you do.`,
    );
  else if (connected && unlinked > 0)
    add(
      "unlinked_accounts",
      "info",
      `${unlinked} ${unlinked === 1 ? "account is" : "accounts are"} not linked. Unlinked accounts are never fetched.`,
    );

  if (connected && linked > 0 && out.every((item) => item.code !== "credential_unusable")) {
    const lastOk = Math.max(
      0,
      ...links.map((link) => (link.lastOkAt ? Date.parse(link.lastOkAt) : 0)),
    );
    const since =
      lastOk > 0 ? lastOk : connection.connectedAt ? Date.parse(connection.connectedAt) : nowMs;
    const days = Math.floor((nowMs - since) / (24 * 60 * 60 * 1000));
    if (days >= input.staleAfterDays)
      add(
        "stale",
        "warning",
        lastOk > 0
          ? `The last successful sync was ${days} days ago. The books may be missing recent lines; sync now, or check the connection.`
          : `No sync has succeeded in the ${days} days since connecting. Sync now, or check the connection.`,
      );
  }
  return out.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity]).slice(0, 20);
}

export const QUOTA_WINDOW_HOURS = QUOTA_WINDOW_MS / 3_600_000;

/** Text from the Bridge shown in a note: bounded and stripped, never an instruction. */
export const note = (text: unknown, max = 200): string => safeText(text, { max });
