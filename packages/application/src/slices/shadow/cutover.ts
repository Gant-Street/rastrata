/** The cutover: the day the books move, handed to the places that need it. The Inbox's statement
 * sources get it as their start date, so earlier history is set aside where it can be seen and
 * restored; Stripe gets it as its first day while that can still move. The opening entry is dated
 * the day before (the cutover date itself when the book's calendar has no day before), which is why
 * the date is recorded here first and cannot move once that entry is posted.
 *
 * Everything is reached through the other lanes' operations (`inbox.sources`,
 * `inbox.configureSource`, `inbox.list`, `reconcile.status`, `stripe.status`, `stripe.configure`),
 * never their tables. */
import { describePrincipal } from "../../agent/principal.ts";
import type {
  CutoverAccount,
  CutoverGetInput,
  CutoverSetInput,
  CutoverSetResult,
  CutoverSource,
  CutoverState,
  CutoverStripe,
  InboxPage,
  InboxSource,
  InboxSourceChange,
  InboxSourceList,
  ReconcileStatus,
  StripeStatus,
} from "../../client-contracts.gen.ts";
import { ApplicationError } from "../../errors.ts";
import { deriveUuid } from "../../ingest/hash.ts";
import { addDays } from "../../reports/dates.ts";
import { isCalendarDate } from "../../shadow/opening.ts";
import type { SliceContext } from "../types.ts";
import { type Chart, type ChartAccount, readChart, readPeriods } from "./chart.ts";
import { callOperation } from "./operations.ts";
import { findHandMadeOpening, handMadeExisting, openingStatus } from "./opening.ts";
import { shadowStore } from "./store.ts";

/** Providers whose start date is set by their own settings: giving them another one would make
 * their next batch fail with a start-date conflict. */
const MANAGED = new Set(["stripe", "simplefin", "bank"]);

const label = (account: ChartAccount): string => `${account.code} ${account.name}`;

type Reason = NonNullable<CutoverAccount["reason"]>;

/** A liability that is a credit card, by its tag or by what it is called: a chart template names it
 * "Business credit card", and a person adding one says "Amex" or "Visa". A guess about a name, so it
 * only ever suggests: the person can untick it, and an account that has had a statement imported or
 * has been reconciled does not need it. */
const CARD_NAME = /\b(?:card|visa|mastercard|master card|amex|american express|discover)\b/i;
const isCreditCard = (account: ChartAccount): boolean =>
  account.roleKey === "credit.card" || CARD_NAME.test(account.name);

/** The open bank, card and Stripe accounts of the chart that have statements, each with why: the
 * Stripe balance; an account that has been reconciled; one a statement import is mapped to; an asset
 * tagged as cash (a bank account); a liability that is a credit card. Nothing else is offered: an
 * asset is not a bank because it is an asset (Inventory, Equipment), nor a liability a card because it
 * is a liability (Sales tax payable, Accounts payable). An account the person has already chosen is
 * kept, whatever it is, so a choice made before is never dropped from under them. */
function statementAccounts(
  chart: Chart,
  sources: readonly InboxSource[],
  reconcile: ReconcileStatus | null,
  named: ReadonlySet<string>,
): { accounts: Omit<CutoverAccount, "chosen">[]; hidden: number } {
  const tracked = new Map((reconcile?.accounts ?? []).map((row) => [row.account.id, row]));
  const result: Omit<CutoverAccount, "chosen">[] = [];
  let hidden = 0;
  for (const account of chart.accounts) {
    if (account.role !== "asset" && account.role !== "liability") continue;
    if (account.closedOn !== null || account.roleKey === "payouts.in-transit") continue;
    const kind =
      account.roleKey === "stripe.balance"
        ? "stripe"
        : account.role === "liability"
          ? "card"
          : "bank";
    const row = tracked.get(account.id);
    const hasSource = sources.some((source) => source.ledgerAccountId === account.id);
    const reason: Reason | null =
      kind === "stripe"
        ? "stripe"
        : row && (row.lastReconciledDate !== null || row.openReconciliationId !== null)
          ? "reconciled"
          : hasSource
            ? "imported"
            : account.role === "asset" && account.cashFlowClass === "cash"
              ? "cash"
              : account.role === "liability" && isCreditCard(account)
                ? "card"
                : null;
    if (reason === null && !named.has(account.id)) {
      hidden += 1;
      continue;
    }
    result.push({
      accountId: account.id,
      code: account.code,
      name: account.name,
      role: account.role,
      kind,
      reason,
      hasSource,
    });
  }
  return { accounts: result, hidden };
}

async function attempt<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch (cause) {
    if (cause instanceof ApplicationError) return null;
    throw cause;
  }
}

async function countLines(context: SliceContext, filter: Record<string, unknown>): Promise<number> {
  const page = await callOperation<InboxPage>(context, "inbox.list", { filter, pageSize: 1 });
  return page.count;
}

/** Where each statement source starts, and what a cutover date would do to it. */
async function sourceEffects(
  context: SliceContext,
  sources: readonly InboxSource[],
  chart: Chart,
  chosen: ReadonlySet<string>,
  date: string | null,
): Promise<CutoverSource[]> {
  const byId = new Map(chart.accounts.map((account) => [account.id, account]));
  const effects: CutoverSource[] = [];
  for (const source of sources) {
    const mapped = source.ledgerAccountId;
    const account = mapped ? byId.get(mapped) : undefined;
    let action: CutoverSource["action"] = "unchanged";
    let note = "";
    if (MANAGED.has(source.provider)) {
      action = "managed";
      note = "Its first day is set in its own settings.";
    } else if (mapped === null) {
      action = "unmapped";
      note =
        "Choose this source's chart account (inbox.configureSource) before it can start on a date.";
    } else if (!chosen.has(mapped))
      note = "Not one of the accounts with statements; its start date is left alone.";
    else if (date !== null)
      action =
        source.startOn === null
          ? "set"
          : source.startOn === date
            ? "unchanged"
            : date > source.startOn
              ? "move_later"
              : "move_earlier";
    const changes = action === "set" || action === "move_later" || action === "move_earlier";
    const wouldExclude =
      date !== null && (action === "set" || action === "move_later")
        ? await countLines(context, {
            provider: source.provider,
            accountKey: source.accountKey,
            status: ["new", "proposed"],
            to: addDays(date, -1),
          })
        : 0;
    const wouldRestore =
      date !== null && action === "move_earlier"
        ? await countLines(context, {
            provider: source.provider,
            accountKey: source.accountKey,
            exclusion: "before_cutover",
            from: date,
          })
        : 0;
    effects.push({
      provider: source.provider,
      accountKey: source.accountKey,
      ledgerAccountId: mapped,
      account: account ? label(account) : null,
      startOn: source.startOn,
      after: changes ? date : null,
      action,
      excluded: source.counts.beforeCutover,
      wouldExclude,
      wouldRestore,
      ...(note ? { note } : {}),
    });
  }
  return effects;
}

/** The cutover as it stands, or as a date and a set of accounts would leave it. */
export async function cutoverState(
  context: SliceContext,
  query: CutoverGetInput = {},
): Promise<CutoverState> {
  const { service } = context;
  const recorded = shadowStore(service).cutover();
  const [chart, tool, list, reconcile, stripe] = await Promise.all([
    readChart(context),
    openingStatus(service),
    callOperation<InboxSourceList>(context, "inbox.sources"),
    attempt(() => callOperation<ReconcileStatus>(context, "reconcile.status")),
    attempt(() => callOperation<StripeStatus>(context, "stripe.status", { books: false })),
  ]);
  const date = query.cutoverDate ?? recorded?.cutoverOn ?? null;
  // Opening balances entered by hand are the opening entry too, though the opening tools did not
  // write them: shown as posted, and not what locks the date.
  const handMade =
    tool.existing.status === "posted"
      ? null
      : await findHandMadeOpening(service, chart, date, tool.ownJournalIds);
  const existing = handMade ? handMadeExisting(handMade) : tool.existing;
  const { accounts: candidates, hidden } = statementAccounts(
    chart,
    list.sources,
    reconcile,
    new Set(query.accountIds ?? recorded?.accountIds ?? []),
  );
  const chosen = new Set<string>(
    query.accountIds ??
      recorded?.accountIds ??
      candidates
        .filter((item) => item.reason !== null && item.kind !== "stripe")
        .map((item) => item.accountId),
  );
  for (const item of candidates) if (item.kind === "stripe") chosen.delete(item.accountId);
  const accounts: CutoverAccount[] = candidates.map((item) => ({
    ...item,
    chosen: chosen.has(item.accountId),
  }));

  const sources = await sourceEffects(context, list.sources, chart, chosen, date);
  // An account with statements and no source yet gets one, so its first import starts on the date.
  if (date !== null)
    for (const item of accounts)
      if (item.chosen && !item.hasSource)
        sources.push({
          provider: "csv",
          accountKey: `csv:${item.accountId}`,
          ledgerAccountId: item.accountId,
          account: `${item.code} ${item.name}`,
          startOn: null,
          after: date,
          action: "create",
          excluded: 0,
          wouldExclude: 0,
          wouldRestore: 0,
          note: "Created so a first statement import for this account starts on the cutover date.",
        });

  const locked = tool.existing.status === "posted";
  // What the screen cannot see for itself. An empty date field already says that no date is recorded.
  const notes: string[] = [];
  if (locked)
    notes.push(
      `The opening entry is posted (dated ${tool.existing.entryDate ?? tool.existing.cutoverDate}), so the cutover date cannot move. Reverse that entry first to change it.`,
    );
  else if (handMade)
    notes.push(
      `The opening balances were entered by hand (the entry dated ${handMade.date}), so the opening tools will not post another.`,
    );
  if (date !== null && accounts.length > 0 && accounts.every((item) => !item.chosen))
    notes.push("No account is marked as having statements, so the start date changes nothing yet.");
  // Why an account the person expected is not in the list; said only when there is a list. With no
  // bank or card account at all, the screen's one sentence already says so.
  if (hidden > 0 && accounts.length > 0)
    notes.push(
      `${hidden} other ${hidden === 1 ? "account is" : "accounts are"} not listed: a statement belongs to a bank or card account. To list one of them, tag it as a bank or card account in your chart of accounts, or import a statement for it.`,
    );
  return {
    cutover: recorded
      ? {
          cutoverDate: recorded.cutoverOn,
          recordedAt: recorded.recordedAt,
          accountIds: [...recorded.accountIds],
          by: recorded.principal,
        }
      : null,
    forDate: date,
    opening: existing,
    accounts,
    sources,
    stripe: stripeFacts(stripe, date, service.today()),
    locked,
    notes,
  };
}

/** Stripe cannot start on a day that has not come (its own rule: no later than tomorrow), so a
 * cutover date that far ahead is left out of its first day until it arrives. */
const usableAsFirstDay = (date: string, today: string): boolean => date <= addDays(today, 1);

function stripeFacts(
  status: StripeStatus | null,
  date: string | null,
  today: string,
): CutoverStripe | null {
  if (status === null || (status.settings === null && !status.configured)) return null;
  const syncFrom = status.settings?.syncFrom ?? null;
  const fixed = status.lastSync !== null;
  const matches = date !== null && syncFrom !== null ? syncFrom === date : null;
  let note = "";
  if (matches === true) note = "Stripe imports from the cutover date.";
  else if (matches === false && date !== null && syncFrom !== null) {
    if (fixed)
      note = `Stripe's first day is ${syncFrom}, and it has already imported lines, so it cannot move. Whatever Stripe held before ${syncFrom} belongs in the opening balance of the Stripe balance account.`;
    else if (syncFrom > date)
      note = `Stripe's first day is ${syncFrom}, later than the cutover date ${date}. It was chosen that way, so recording the cutover leaves it: Stripe activity from ${date} up to ${syncFrom} is not imported. Set its first day earlier in Stripe's settings if you want it.`;
    else if (!usableAsFirstDay(date, today))
      note = `Stripe's first day is ${syncFrom}. The cutover date has not come yet, and Stripe cannot start on a day that has not come, so its first day stays until then.`;
    else
      note = `Stripe's first day is ${syncFrom}. Recording the cutover moves it to ${date}, because nothing has been imported from Stripe yet.`;
  }
  return {
    configured: status.configured,
    syncFrom,
    matches,
    fixed,
    ...(note ? { note } : {}),
  };
}

/** Record the cutover date and hand it to the Inbox's sources (and to Stripe, while it can still
 * move). Retried under the same identity it does nothing twice: the sources it configures are
 * retained under identities derived from this one. */
export async function setCutover(
  context: SliceContext,
  input: CutoverSetInput,
  operationId: string,
): Promise<CutoverSetResult> {
  const { service } = context;
  return service.retainAsyncRequest(operationId, "cutover.set", input, async () => {
    const date = input.cutoverDate;
    if (!isCalendarDate(date))
      throw new ApplicationError(
        "invalid_date",
        `${JSON.stringify(date)} is not a calendar date.`,
        400,
        [{ path: "input.cutoverDate", message: "Use a real date, YYYY-MM-DD" }],
      );
    let { calendar } = await readPeriods(context);
    if (date > calendar.lastDate) {
      // A start date after the calendar's end grows the calendar to cover it, as a posting does.
      await service.ensureCalendarCovers(
        date,
        "input.cutoverDate",
        { by: describePrincipal(context.access.principal), operation: "cutover.set" },
        operationId,
      );
      ({ calendar } = await readPeriods(context));
    }
    if (date < calendar.firstDate || date > calendar.lastDate)
      throw new ApplicationError(
        "cutover_outside_calendar",
        `The book's calendar runs from ${calendar.firstDate} to ${calendar.lastDate}; ${date} is outside it. A book cannot start before its first day.`,
        409,
      );
    const { existing } = await openingStatus(service);
    if (existing.status === "posted" && existing.cutoverDate !== date)
      throw new ApplicationError(
        "cutover_locked",
        `The opening entry is posted for the cutover date ${existing.cutoverDate}, so the cutover date cannot move. Reverse that entry first.`,
        409,
      );
    const store = shadowStore(service);
    const recorded = store.cutover();
    const chart = await readChart(context);
    const before = await cutoverState(context, {
      cutoverDate: date,
      ...(input.accountIds !== undefined ? { accountIds: input.accountIds } : {}),
    });
    const chosen = before.accounts.filter((item) => item.chosen).map((item) => item.accountId);
    if (input.accountIds !== undefined) {
      const byId = new Map(chart.accounts.map((account) => [account.id, account]));
      const rejected = input.accountIds.flatMap((id) => {
        const account = byId.get(id);
        const reason = !account
          ? "is not in your chart"
          : account.role !== "asset" && account.role !== "liability"
            ? "is not a bank or card account (it is not an asset or a liability)"
            : account.closedOn !== null
              ? "is closed"
              : account.roleKey === "stripe.balance" || account.roleKey === "payouts.in-transit"
                ? "is a Stripe account, which starts on Stripe's own first day"
                : null;
        return reason ? [{ path: `input.accountIds ${id}`, message: `${id} ${reason}` }] : [];
      });
      if (rejected.length > 0)
        throw new ApplicationError(
          "account_not_statement_account",
          `${rejected[0]?.message}. Choose bank and card accounts.`,
          422,
          rejected.slice(0, 20),
        );
    }

    let excluded = 0;
    let restored = 0;
    let sourcesSet = 0;
    for (const source of before.sources) {
      if (
        source.action !== "set" &&
        source.action !== "move_later" &&
        source.action !== "move_earlier" &&
        source.action !== "create"
      )
        continue;
      const change = await callOperation<InboxSourceChange>(
        context,
        "inbox.configureSource",
        {
          provider: source.provider,
          accountKey: source.accountKey,
          ...(source.action === "create" && source.ledgerAccountId
            ? { ledgerAccountId: source.ledgerAccountId }
            : {}),
          startOn: date,
        },
        deriveUuid(["shadow.cutover", operationId, source.provider, source.accountKey]),
      );
      excluded += change.excludedBeforeCutover;
      restored += change.restored;
      sourcesSet += 1;
    }
    // Stripe's first day moves to the cutover date when it is earlier and nothing has been imported
    // from Stripe yet; after that its own rules (and the Inbox's) keep every line's date and the
    // cutover consistent. A first day the owner chose later than the cutover date is left alone.
    const stripe = before.stripe;
    if (
      stripe &&
      stripe.syncFrom !== null &&
      stripe.syncFrom < date &&
      !stripe.fixed &&
      usableAsFirstDay(date, service.today())
    )
      await attempt(() =>
        callOperation(
          context,
          "stripe.configure",
          { syncFrom: date },
          deriveUuid(["shadow.cutover", operationId, "stripe"]),
        ),
      );

    const same =
      recorded !== null &&
      recorded.cutoverOn === date &&
      recorded.accountIds.length === chosen.length &&
      recorded.accountIds.every((id) => chosen.includes(id));
    if (!same)
      store.recordCutover({
        cutoverOn: date,
        accountIds: chosen,
        recordedAt: context.service.now(),
        operationId,
        principal: describePrincipal(context.access.principal),
      });
    return { state: await cutoverState(context), excluded, restored, sourcesSet };
  });
}
