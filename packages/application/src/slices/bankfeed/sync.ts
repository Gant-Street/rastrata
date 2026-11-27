import {
  BridgeBudgetSpent,
  BridgeClient,
  BridgeError,
  type RequestEvent,
} from "../../bankfeed/client.ts";
import {
  type PulledWindow,
  createSimpleFinConnector,
  decodeCursor,
  encodeCursor,
} from "../../bankfeed/connector.ts";
import { QUOTA_WINDOW_MS } from "../../bankfeed/constants.ts";
import { type AccessUrl, isCredentialProblem, parseAccessUrl } from "../../bankfeed/credentials.ts";
import { listAccounts } from "../../bankfeed/listing.ts";
import { accountKeyOf } from "../../bankfeed/normalise.ts";
import {
  type BridgeProblem,
  type Names,
  type ProblemView,
  describeProblem,
} from "../../bankfeed/problems.ts";
import { epochOfDate, utcDate } from "../../bankfeed/time.ts";
import type { InboxSourceList } from "../../client-contracts.gen.ts";
import { ApplicationError } from "../../errors.ts";
import type { IngestPort } from "../../ingest-types.ts";
import type { ApplicationService } from "../../service.ts";
import { ingestPort } from "../ingest/port.ts";
import { callOperation } from "../shadow/operations.ts";
import { sliceState } from "../state.ts";
import type { SliceContext } from "../types.ts";
import { budgetGuard, recorder } from "./budget.ts";
import { type BankfeedRuntime, bankfeedRuntime } from "./runtime.ts";
import { type BankfeedStore, type LinkRow, type RunRow, bankfeedStore } from "./store.ts";
import { note } from "./view.ts";

/** Running a sync. In order: read the access URL, ask the Bridge which accounts exist (one request, and
 * not again within half an hour, so a sync that takes several calls does not repeat it), then for each
 * **linked** account read its new posted transactions window by window, archiving each answer's exact
 * bytes before handing its lines to the pipeline, and moving the account's cursor only after the
 * pipeline has applied them. An unlinked account is never asked for. Nothing here posts anything: the
 * lines wait in the Inbox like any statement import.
 *
 * A sync stops, cleanly, for four reasons, and says which:
 *  - its own time budget (`more`: call again);
 *  - the day's request budget (`paused`: see `requests`, and wait);
 *  - the Bridge asking Rastrata to slow down (`paused`, for 24 hours);
 *  - an error that makes the rest pointless: the access refused (revoked or disabled), payment
 *    required, the Bridge unreachable. These are recorded, shown, and reported as the call's error.
 * A problem with one account (the Bridge could not read it, its list was incomplete, the pipeline
 * refused its batch) does not stop the others, and never moves that account's cursor. */

export interface SyncInput {
  readonly budgetSeconds?: number;
  readonly accountId?: string;
  readonly trigger?: "manual" | "scheduled";
}

export interface SyncAccountResult {
  readonly accountId: string;
  readonly name: string;
  readonly ledgerAccountId: string;
  readonly state: "complete" | "more" | "attention" | "failed" | "skipped";
  readonly windows: number;
  readonly newLines: number;
  readonly duplicateLines: number;
  readonly pendingSkipped: number;
  readonly heldLines: number;
  readonly through: string | null;
  readonly message: string | null;
}

export interface SyncOutcome {
  readonly run: RunRow;
  readonly more: boolean;
  readonly paused: {
    readonly reason: "daily_budget" | "rate_limited";
    readonly until: string | null;
    readonly message: string;
  } | null;
  readonly accounts: readonly SyncAccountResult[];
  readonly problems: readonly ProblemView[];
}

/** Each call works within a few seconds so no client's reply timeout (the CLI waits 15 s, the browser
 * 10 s) is the limit; a long first sync is simply several calls. */
export const DEFAULT_BUDGET_SECONDS = 6;
/** A listing made this recently is not asked for again by the next call of the same sync. */
const LISTING_FRESH_MS = 30 * 60 * 1000;
const RATE_PAUSE =
  "The Bridge said Rastrata is asking too often. Rastrata has stopped asking for 24 hours so the Bridge does not disable its access.";

/** One sync at a time per book: two at once would race on the cursors and spend the quota twice. */
function claim(service: ApplicationService): () => void {
  const state = sliceState(service, "bankfeed.sync", () => ({ running: false }));
  if (state.running)
    throw new ApplicationError(
      "bankfeed_sync_running",
      "A bank feed sync is already running. Wait for it to finish.",
      409,
      [],
      true,
    );
  state.running = true;
  return () => {
    state.running = false;
  };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The access URL, or the reason there is none. */
export function readAccess(service: ApplicationService): AccessUrl {
  const runtime = bankfeedRuntime(service);
  const read = runtime.credentials.read();
  if (read === null)
    throw new ApplicationError(
      "bankfeed_not_connected",
      "The bank feed is not connected. Create a setup token at the SimpleFIN Bridge and connect first.",
      409,
    );
  if (isCredentialProblem(read))
    throw new ApplicationError("bankfeed_credential_unusable", read.problem, 409);
  const access = parseAccessUrl(read.accessUrl, runtime.policy);
  if (access === null)
    throw new ApplicationError(
      "bankfeed_credential_unusable",
      "The saved access URL is not usable. Disconnect and connect again with a new setup token.",
      409,
    );
  return access;
}

/** The ingestion pipeline: the runtime's own (a test's), else the service's. */
export function pipeline(service: ApplicationService): IngestPort {
  try {
    return bankfeedRuntime(service).port ?? ingestPort(service);
  } catch {
    throw new ApplicationError(
      "ingest_unavailable",
      "The Inbox is not available in this build, so bank feed lines cannot be queued.",
      503,
    );
  }
}

/** Names for sentences about problems: the banks and accounts the Bridge last listed. */
export function namesFrom(store: BankfeedStore): Names {
  const rows = store.accounts();
  return {
    bank: (connId) =>
      connId === null ? null : (rows.find((row) => row.connId === connId)?.orgName ?? null),
    account: (accountId) =>
      accountId === null ? null : (rows.find((row) => row.accountId === accountId)?.name ?? null),
  };
}

export const describeAll = (problems: readonly BridgeProblem[], names: Names): ProblemView[] =>
  problems.map((problem) => describeProblem(problem, names));

/** What stopped the run, if anything. */
type Stop =
  | { readonly kind: "time" }
  | { readonly kind: "budget"; readonly until: number | null }
  | { readonly kind: "slow_down"; readonly until: number | null }
  | { readonly kind: "fatal"; readonly error: ApplicationError };

interface Totals {
  accounts: number;
  windows: number;
  newLines: number;
  duplicateLines: number;
  pendingSkipped: number;
  heldLines: number;
  requests: number;
  notes: string[];
}

/** Everything one run shares. */
interface Env {
  readonly context: SliceContext;
  readonly store: BankfeedStore;
  readonly runtime: BankfeedRuntime;
  readonly port: IngestPort;
  readonly client: BridgeClient;
  readonly access: AccessUrl;
  readonly clock: () => number;
  readonly guard: ReturnType<typeof budgetGuard>;
  readonly onRequest: (event: RequestEvent) => void;
  readonly totals: Totals;
  readonly bookCurrency: string;
}

/** The Bridge asked Rastrata to slow down: no request is made for a day. */
function slowDown(env: Env, until: number, message: string): Stop {
  env.store.setPausedUntil(new Date(until).toISOString());
  env.store.setAttention("rate_limited", message, env.runtime.now());
  return { kind: "slow_down", until };
}

/** An error met while talking to the Bridge, as the reason the run (or an account) stops. Anything
 * that is not the Bridge's own error is not translated: it is a bug and propagates. */
function stopOf(env: Env, error: unknown): Stop {
  if (error instanceof BridgeBudgetSpent) {
    if (error.reason === "call_budget") return { kind: "time" };
    if (error.reason === "rate_limited") return { kind: "slow_down", until: error.until };
    return { kind: "budget", until: error.until };
  }
  if (!(error instanceof BridgeError)) throw error;
  const message = env.client.scrubText(error.message);
  if (error.code === "bankfeed_rate_limited")
    return slowDown(env, error.until ?? env.clock() + QUOTA_WINDOW_MS, RATE_PAUSE);
  if (error.code === "bankfeed_access_denied" || error.code === "bankfeed_payment_required")
    env.store.setAttention(
      error.code === "bankfeed_access_denied" ? "access_denied" : "payment_required",
      message,
      env.runtime.now(),
    );
  return {
    kind: "fatal",
    error: new ApplicationError(
      error.code,
      message,
      error.code === "bankfeed_unavailable" ? 502 : 424,
      [],
      error.retryable,
    ),
  };
}

export async function runBankfeedSync(
  context: SliceContext,
  input: SyncInput,
  operationId: string,
): Promise<SyncOutcome> {
  const { service } = context;
  const store = bankfeedStore(service);
  const release = claim(service);
  try {
    return await execute(context, store, input, operationId);
  } finally {
    release();
  }
}

async function execute(
  context: SliceContext,
  store: BankfeedStore,
  input: SyncInput,
  operationId: string,
): Promise<SyncOutcome> {
  const { service } = context;
  const runtime = bankfeedRuntime(service);
  const setup = service.setupState();
  if (!setup) throw new ApplicationError("book_not_configured", "Book is not configured", 409);
  const access = readAccess(service);
  const port = pipeline(service);
  const clock = (): number => Date.parse(runtime.now());
  const startedAt = runtime.now();
  const trigger = input.trigger ?? "manual";
  const seconds = Math.max(1, Math.min(300, input.budgetSeconds ?? DEFAULT_BUDGET_SECONDS));

  let links = store.links();
  if (input.accountId !== undefined) {
    links = links.filter((link) => link.accountId === input.accountId);
    if (links.length === 0)
      throw new ApplicationError(
        "bankfeed_account_not_linked",
        "That Bridge account is not linked to a chart account, so it is never fetched. Link it first.",
        404,
      );
  }

  const totals: Totals = {
    accounts: 0,
    windows: 0,
    newLines: 0,
    duplicateLines: 0,
    pendingSkipped: 0,
    heldLines: 0,
    requests: 0,
    notes: [],
  };
  const record = recorder(store);
  const guard = budgetGuard(store, clock, Date.parse(startedAt) + seconds * 1000);
  /** Every request, whoever makes it, is written down and counted for this run. */
  const onRequest = (event: RequestEvent): void => {
    record(event);
    if (event.kind !== "claim") totals.requests += 1;
  };
  const client = new BridgeClient(access, {
    fetch: runtime.fetch,
    now: clock,
    guard,
    onRequest,
    ...(runtime.sleep ? { sleep: runtime.sleep } : {}),
    ...(runtime.timeoutMs ? { timeoutMs: runtime.timeoutMs } : {}),
  });
  const env: Env = {
    context,
    store,
    runtime,
    port,
    client,
    access,
    clock,
    guard,
    onRequest,
    totals,
    bookCurrency: setup.currency,
  };

  store.startRun(operationId, startedAt, trigger);
  let finished = false;
  const finish = (disposition: RunRow["disposition"], error: ApplicationError | null): RunRow => {
    const row: RunRow = {
      id: operationId,
      startedAt,
      finishedAt: runtime.now(),
      disposition,
      trigger,
      requests: totals.requests,
      accounts: totals.accounts,
      windows: totals.windows,
      newLines: totals.newLines,
      duplicateLines: totals.duplicateLines,
      pendingSkipped: totals.pendingSkipped,
      heldLines: totals.heldLines,
      errorCode: error?.code ?? null,
      errorMessage: error ? client.scrubText(error.message).slice(0, 900) : null,
      notes: totals.notes.slice(0, 12).map((text) => text.slice(0, 500)),
    };
    store.finishRun(row);
    store.pruneRequests(clock());
    finished = true;
    return row;
  };

  const results: SyncAccountResult[] = [];
  const problems: ProblemView[] = [];
  let stop: Stop | null = null;
  try {
    // ---- 1. Which accounts exist: one request, and not again within half an hour -----------
    const before = store.connection();
    const listedRecently =
      before.listedAt !== null && clock() - Date.parse(before.listedAt) < LISTING_FRESH_MS;
    if (input.accountId === undefined && !listedRecently) {
      try {
        const listing = await listAccounts(client, access.secrets);
        port.archive(listing.bytes, "application/json", "simplefin-accounts.json");
        const at = runtime.now();
        store.replaceAccounts(listing.accounts, at);
        const described = describeAll(listing.set.problems, namesFrom(store));
        store.saveListing(
          described,
          listing.set.messages.map((message) => note(message)),
          at,
        );
        problems.push(...described);
        // The Bridge answered: whatever it had refused or asked before is over.
        if (before.attentionCode !== null && !before.attentionCode.startsWith("credential"))
          store.setAttention(null, null, null);
        const slow = described.find((problem) => problem.kind === "rate_limit");
        const denied = described.find((problem) => problem.kind === "access");
        if (slow) stop = slowDown(env, clock() + QUOTA_WINDOW_MS, RATE_PAUSE);
        else if (denied) {
          store.setAttention("access_denied", denied.message, at);
          stop = {
            kind: "fatal",
            error: new ApplicationError("bankfeed_access_denied", denied.message, 424),
          };
        }
      } catch (error) {
        stop = stopOf(env, error);
      }
    }

    // ---- 2. Each linked account, window by window ------------------------------------------
    const sources =
      links.length === 0 || stop !== null
        ? null
        : await callOperation<InboxSourceList>(context, "inbox.sources").catch(() => null);
    for (const link of links) {
      const row = store.account(link.accountId);
      const name = row?.name ?? link.accountId;
      const base = {
        accountId: link.accountId,
        name,
        ledgerAccountId: link.ledgerAccountId,
        windows: 0,
        newLines: 0,
        duplicateLines: 0,
        pendingSkipped: 0,
        heldLines: 0,
        through: link.through === null ? null : utcDate(link.through),
      };
      if (stop !== null) {
        results.push({
          ...base,
          state: "more",
          message:
            "Not read yet: the sync stopped before reaching this account. It carries on at the next sync.",
        });
        continue;
      }
      const key = accountKeyOf(link.accountId);
      if (row === null || !row.listed || row.support !== "ok" || key === null) {
        const message =
          row === null || !row.listed
            ? "The Bridge no longer lists this account, so nothing was read."
            : "This account cannot be read (its id or currency cannot be used).";
        store.recordSync(link.accountId, {
          at: runtime.now(),
          ok: false,
          errorCode: "bankfeed_account_gone",
          errorMessage: message,
        });
        results.push({ ...base, state: "skipped", message });
        continue;
      }
      totals.accounts += 1;
      const startOn =
        sources?.sources.find((s) => s.provider === "simplefin" && s.accountKey === key)?.startOn ??
        link.startOn;
      const outcome = await syncAccount(env, link, key, startOn, base);
      results.push(outcome.result);
      problems.push(...outcome.problems);
      if (outcome.stop !== null) stop = outcome.stop;
    }
    if (links.length === 0 && input.accountId === undefined)
      totals.notes.push(
        "No Bridge account is linked to a chart account yet, so nothing was read. Link an account first.",
      );

    // ---- 3. How it ended -----------------------------------------------------------------------
    if (totals.newLines > 0)
      totals.notes.unshift(
        `${plural(totals.newLines, "line", "lines")} queued in the Inbox for review. Nothing was posted.`,
      );
    if (totals.pendingSkipped > 0)
      totals.notes.push(
        `${plural(totals.pendingSkipped, "pending transaction was", "pending transactions were")} not imported. Rastrata imports a transaction when the bank has posted it.`,
      );
    for (const message of store.connection().messages.slice(0, 2))
      totals.notes.push(`The Bridge says: "${message}"`);

    if (stop !== null && stop.kind === "fatal") {
      finish("failed", stop.error);
      throw stop.error;
    }
    const paused =
      stop !== null && (stop.kind === "budget" || stop.kind === "slow_down")
        ? {
            reason: stop.kind === "budget" ? ("daily_budget" as const) : ("rate_limited" as const),
            until: stop.until === null ? null : new Date(stop.until).toISOString(),
            message:
              stop.kind === "budget"
                ? "The day's request budget for the Bridge is spent (it expects about 24 requests a day, and Rastrata stops at 20 so the access is never disabled). The sync carries on when a request frees up."
                : "The Bridge asked Rastrata to slow down, so no request is made until the pause ends.",
          }
        : null;
    const more = stop !== null && stop.kind === "time";
    const run = finish(paused ? "paused" : more ? "more" : "complete", null);
    return { run, more, paused, accounts: results, problems };
  } catch (error) {
    if (!finished)
      finish(
        "failed",
        error instanceof ApplicationError
          ? error
          : new ApplicationError("bankfeed_sync_failed", "The sync stopped unexpectedly.", 500),
      );
    throw error;
  }
}

interface AccountBase {
  readonly accountId: string;
  readonly name: string;
  readonly ledgerAccountId: string;
  readonly windows: number;
  readonly newLines: number;
  readonly duplicateLines: number;
  readonly pendingSkipped: number;
  readonly heldLines: number;
  readonly through: string | null;
}

interface AccountOutcome {
  readonly result: SyncAccountResult;
  readonly problems: ProblemView[];
  readonly stop: Stop | null;
}

const OTHER = (account: string | null, message: string): ProblemView => ({
  kind: "other",
  code: null,
  bank: null,
  account,
  message,
  said: "",
});

async function syncAccount(
  env: Env,
  link: LinkRow,
  key: string,
  startOn: string,
  base: AccountBase,
): Promise<AccountOutcome> {
  const { store, runtime } = env;
  const names = namesFrom(store);
  const counts = { ...base };
  const problems: ProblemView[] = [];
  const accountName = names.account(link.accountId);
  const recordSync = (ok: boolean, code: string | null, message: string | null): void =>
    store.recordSync(link.accountId, {
      at: runtime.now(),
      ok,
      errorCode: code,
      errorMessage: message === null ? null : message.slice(0, 700),
    });
  const done = (
    state: SyncAccountResult["state"],
    message: string | null,
    stop: Stop | null,
  ): AccountOutcome => ({ result: { ...counts, state, message }, problems, stop });

  // A first day that moved earlier than anything read: read again from it. Safe, because everything
  // already read is known to the pipeline and is refused a second time.
  let through = link.through;
  if (link.fetchedFrom !== null && epochOfDate(startOn) < link.fetchedFrom) {
    store.resetCursor(link.accountId);
    through = null;
  }
  const connector = createSimpleFinConnector(
    {
      accountId: link.accountId,
      accountKey: key,
      ledgerAccountId: link.ledgerAccountId,
      startOn,
      connId: link.connId,
    },
    { bookCurrency: env.bookCurrency },
    {
      access: env.access,
      guard: env.guard,
      onRequest: env.onRequest,
      ...(runtime.sleep ? { sleep: runtime.sleep } : {}),
      ...(runtime.timeoutMs ? { timeoutMs: runtime.timeoutMs } : {}),
    },
  );

  let stopped: Stop | null = null;
  let incomplete: ProblemView | null = null;
  try {
    const cursor = through === null ? null : encodeCursor({ v: 1, through });
    for await (const window of connector.pull(cursor, { fetch: runtime.fetch, now: runtime.now })) {
      const report = applyWindow(env, link, window, names);
      counts.windows += 1;
      counts.newLines += report.newCount;
      counts.duplicateLines += report.duplicateCount + report.overlapCount;
      counts.pendingSkipped += window.facts.counts.pending;
      counts.heldLines += window.facts.counts.held;
      const next = decodeCursor(window.batch.cursor);
      if (next) counts.through = utcDate(next.through);

      const described = describeAll(window.facts.problems, names);
      problems.push(...described);
      if (!window.facts.advance)
        incomplete = window.facts.missing
          ? OTHER(
              accountName,
              "The Bridge no longer lists this account in its answer, so nothing more was read for it. Check that the bank connection is still there at the Bridge.",
            )
          : window.facts.moved
            ? OTHER(
                accountName,
                "This account now belongs to a different bank connection than the one it was linked under, so it was not read. Unlink it and link it again if that is intended.",
              )
            : (described.find((problem) => problem.kind !== "api") ??
              described[0] ??
              OTHER(
                accountName,
                "The Bridge's answer for this account was incomplete, so Rastrata did not move forward from that point. It reads the period again at the next sync.",
              ));
      if (described.some((problem) => problem.kind === "rate_limit")) {
        stopped = slowDown(env, env.clock() + QUOTA_WINDOW_MS, RATE_PAUSE);
        break;
      }
      const denied = described.find((problem) => problem.kind === "access");
      if (denied) {
        env.store.setAttention("access_denied", denied.message, runtime.now());
        stopped = {
          kind: "fatal",
          error: new ApplicationError("bankfeed_access_denied", denied.message, 424),
        };
        break;
      }
    }
  } catch (error) {
    if (error instanceof ApplicationError) {
      // The pipeline refused the batch (a conflicting mapping, an invalid line): this account stops, the
      // others go on, and its cursor stays where it was.
      const message = env.client.scrubText(error.message).slice(0, 700);
      recordSync(false, error.code, message);
      return done("failed", message, null);
    }
    stopped = stopOf(env, error);
  }

  if (stopped !== null && stopped.kind === "fatal") {
    recordSync(false, stopped.error.code, stopped.error.message);
    return done("failed", stopped.error.message, stopped);
  }
  if (stopped !== null) {
    // Stopping on the clock or the quota is not a failure of the account.
    if (counts.windows > 0) recordSync(true, null, null);
    return done(
      "more",
      stopped.kind === "time"
        ? "Stopped on this call's time budget before reaching today. Call again to continue."
        : "Stopped before reaching today because no further request may be made now. It carries on at the next sync.",
      stopped,
    );
  }
  if (incomplete !== null) {
    recordSync(false, `bridge_${incomplete.kind}`, incomplete.message);
    return done("attention", incomplete.message, null);
  }
  recordSync(true, null, null);
  return done("complete", null, null);
}

/** One window into the pipeline, in the order that keeps the cursor honest: the exact bytes are
 * archived, the lines are submitted (atomically, and the same lines again are refused), and only then
 * is the account's cursor moved and what the window found recorded. */
function applyWindow(env: Env, link: LinkRow, window: PulledWindow, names: Names) {
  const { port, store, runtime, totals } = env;
  const raw = port.archive(window.raw.bytes, window.raw.mediaType, window.raw.name);
  const report = port.submit({ ...window.batch, raw });
  const at = runtime.now();
  store.transaction(() => {
    const next = decodeCursor(window.batch.cursor);
    if (next) store.saveCursor(link.accountId, next.through, window.facts.window.from);
    if (window.facts.held.length > 0) store.holdTransactions(link.accountId, window.facts.held, at);
    const imported = window.batch.lines.flatMap((line) =>
      line.providerId === undefined ? [] : [`id:${line.providerId}`],
    );
    if (imported.length > 0) store.releaseHeld(link.accountId, imported);
    if (window.facts.account)
      store.updateBalance(
        link.accountId,
        window.facts.account.balance,
        window.facts.account.balanceOn,
        at,
      );
  });
  totals.windows += 1;
  totals.newLines += report.newCount;
  totals.duplicateLines += report.duplicateCount + report.overlapCount;
  totals.pendingSkipped += window.facts.counts.pending;
  totals.heldLines += window.facts.counts.held;
  if (report.invalidCount > 0)
    totals.notes.push(
      `${plural(report.invalidCount, "line", "lines")} of ${names.account(link.accountId) ?? "an account"} ${report.invalidCount === 1 ? "was" : "were"} reported by the Bridge with different figures than before. The originals are flagged in the Inbox; nothing was overwritten.`,
    );
  for (const text of window.facts.messages.slice(0, 2))
    totals.notes.push(`The Bridge says: "${note(text)}"`);
  return report;
}
