import { createEffect, createMemo, createSignal, For, on, Show, untrack } from "solid-js";
import { AccountPicker } from "../kit/account-picker";
import { Button, buttonAttrs } from "../button";
import {
  centsToMoney,
  formatDate,
  formatFiguresInText,
  formatMoney,
  formatMoneyAbsolute,
  isNegativeMoney,
  moneyToCents,
  transactionsIn,
} from "../format";
import { Details, DetailsList } from "../kit";
import { Notice } from "../notice";
import { TextArea } from "../text-field";
import { undoWords } from "../entries/words";
import { categorizable as canChooseCategory, effectOf, nameOfAccount } from "./category";
import { parseAmount, withoutSign } from "./cents";
import {
  FlagList,
  instant,
  linkLabel,
  proposerName,
  ReconciledMark,
  ruleIdOf,
  StatusChip,
} from "./parts";
import { checkSplit, SplitEditor, type SplitPart } from "./split-editor";
import type {
  AcceptMode,
  AccountOption,
  InboxDetailView,
  InboxLegView,
  InboxProposalView,
} from "./types";
import { words } from "./words";
import { DateValue } from "../date-value";

export interface InboxLinks {
  /** A posted journal entry. */
  entry: (journalId: string) => string;
  /** Another For review transaction (for example the payout that books this one). */
  item: (itemId: string) => string;
  /** The rule behind a suggestion, and the editor that makes a new one from this transaction. */
  rule: (ruleId: string) => string;
  newRule: (itemId: string) => string;
  /** The reconciliation record a posted transaction is on. Without it the transaction still says it is
   * reconciled. */
  reconciliation?: (reconciliationId: string) => string;
}

export interface CategorizeChoice {
  readonly accountId?: string;
  readonly splits?: readonly { readonly accountId: string; readonly amount: string }[];
  readonly narration?: string;
  /** The transaction is already in the books and this really is a second payment. */
  readonly allowDuplicate?: boolean;
}

const LONG = 400;

/** The reasons worth saying: "Booked to 4000 Sales" only repeats what "This will record" says below it. */
const reasonsOf = (proposal: InboxProposalView): readonly string[] => {
  const worth = proposal.reasons.filter((reason) => !reason.startsWith("Booked to "));
  return worth.length > 0 ? worth : proposal.reasons;
};

/** An effect on an account as a person reads it: "+498.75" when it goes up, a real minus when it goes down. */
const effectText = (value: string): string =>
  isNegativeMoney(value) ? formatMoney(value) : `+${formatMoneyAbsolute(value)}`;

/** The transaction as the provider sent it: its description exactly (never markup, never an
 * instruction), and the counterparty and reference when it had them. */
function Facts(props: { detail: InboxDetailView }) {
  const line = () => props.detail.item.line;
  const [expanded, setExpanded] = createSignal(false);
  const long = () => line().description.length > LONG;
  return (
    <div class="rt-inbox-facts">
      <p class="rt-inbox-detail-description">
        <span class="rt-inbox-text" data-clamped={long() && !expanded() ? "" : undefined}>
          <bdi>{line().description}</bdi>
        </span>
        <Show when={long()}>
          <button
            type="button"
            class="rt-inbox-link-button"
            aria-expanded={expanded()}
            onClick={() => setExpanded(!expanded())}
          >
            {expanded() ? words.showLessText : words.showAllText}
          </button>
        </Show>
      </p>
      <Show when={line().counterparty || line().reference}>
        <dl class="rt-inbox-facts-list">
          <Show when={line().counterparty}>
            {(value) => (
              <div>
                <dt>{words.counterparty}</dt>
                <dd>
                  <bdi>{value()}</bdi>
                </dd>
              </div>
            )}
          </Show>
          <Show when={line().reference}>
            {(value) => (
              <div>
                <dt>{words.reference}</dt>
                <dd>
                  <bdi>{value()}</bdi>
                </dd>
              </div>
            )}
          </Show>
        </dl>
      </Show>
    </div>
  );
}

/** The entry a provider's own event records, by the roles it names (they become chart accounts when the
 * event is accepted). Shown so a person can see what a payout is made of. */
function EventEntry(props: { detail: InboxDetailView }) {
  const line = () => props.detail.item.line;
  return (
    <Show when={line().kind === "event" && (line().legs?.length ?? 0) > 0}>
      <section class="rt-inbox-section" aria-labelledby="rt-inbox-event">
        <h3 id="rt-inbox-event">{words.eventEntry}</h3>
        <table class="rt-table rt-inbox-legs">
          <caption class="rt-sr-only">{words.eventEntry}</caption>
          <thead>
            <tr>
              <th scope="col">{words.role}</th>
              <th scope="col" class="amount">
                {words.debit}
              </th>
              <th scope="col" class="amount">
                {words.credit}
              </th>
            </tr>
          </thead>
          <tbody>
            <For each={line().legs ?? []}>
              {(leg) => {
                const cents = moneyToCents(leg.amount);
                return (
                  <tr>
                    <td>
                      <bdi>{leg.role}</bdi>
                    </td>
                    <td class="amount rt-inbox-amount">
                      {cents > 0n ? formatMoney(centsToMoney(cents)) : ""}
                    </td>
                    <td class="amount rt-inbox-amount">
                      {cents < 0n ? formatMoney(centsToMoney(-cents)) : ""}
                    </td>
                  </tr>
                );
              }}
            </For>
          </tbody>
        </table>
        <Show when={(line().links?.length ?? 0) > 0}>
          <dl class="rt-inbox-facts-list">
            <For each={line().links ?? []}>
              {(link) => (
                <div>
                  <dt>
                    <bdi>{linkLabel(link.key)}</bdi>
                  </dt>
                  <dd>
                    <bdi>{link.value}</bdi>
                  </dd>
                </div>
              )}
            </For>
          </dl>
        </Show>
      </section>
    </Show>
  );
}

/** What an entry does, in plain words: each account and how its balance moves. "This will record
 * Business checking +498.75, Sales +498.75" teaches the debit and the credit without asking for either. */
function Record(props: {
  legs: readonly InboxLegView[];
  accounts: readonly AccountOption[];
  heading: string;
}) {
  const name = (id: string) => nameOfAccount(props.accounts, id);
  const role = (id: string) => props.accounts.find((account) => account.value === id)?.role;
  return (
    <section class="rt-inbox-record" aria-labelledby="rt-inbox-record">
      <h3 id="rt-inbox-record" class="rt-inbox-label">
        {props.heading}
      </h3>
      <ul class="rt-inbox-effects">
        <For each={props.legs}>
          {(leg) => (
            <li>
              <span>
                <bdi>{name(leg.accountId)}</bdi>
              </span>
              <span class="rt-inbox-amount">
                {effectText(effectOf(leg.amount, role(leg.accountId)))}
              </span>
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}

/** One suggestion that is not the first: what it would book to, why, and a way to take it instead. */
function Alternative(props: {
  proposal: InboxProposalView;
  /** Taking this would book a payment a second time, because the transaction already has an entry. */
  again: boolean;
  accounts: readonly AccountOption[];
  ownAccountId: string | null;
  links: InboxLinks;
  busy: boolean;
  onAccept: (proposalId: string, allowDuplicate?: boolean) => void;
}) {
  const proposal = () => props.proposal;
  const rule = () => ruleIdOf(proposal().proposer);
  const names = () =>
    (proposal().legs ?? [])
      .filter((leg) => leg.accountId !== props.ownAccountId)
      .map((leg) => nameOfAccount(props.accounts, leg.accountId));
  return (
    <article class="rt-inbox-proposal" aria-label={proposerName(proposal().proposer)}>
      <p class="rt-inbox-proposal-who">
        <strong>
          <bdi>
            {names().length > 0
              ? names().join(", ")
              : (words.kindLabel[proposal().kind] ?? proposal().kind)}
          </bdi>
        </strong>
        <span class="rt-inbox-muted">{words.kindLabel[proposal().kind] ?? proposal().kind}</span>
      </p>
      <ul class="rt-inbox-reasons">
        <For each={proposal().reasons}>
          {(reason) => (
            <li>
              <bdi>{formatFiguresInText(transactionsIn(reason))}</bdi>
            </li>
          )}
        </For>
      </ul>
      <Show when={proposal().kind === "match" && proposal().matchJournalId}>
        {(id) => (
          <>
            <p>{words.matchEntry}.</p>
            <p>
              <a
                {...buttonAttrs({ variant: "secondary", size: "sm" })}
                href={props.links.entry(id())}
              >
                {words.viewEntry}
              </a>
            </p>
          </>
        )}
      </Show>
      <Show when={proposal().kind === "transfer"}>
        <p class="rt-inbox-muted">{words.pairedWith}</p>
      </Show>
      <div class="rt-inbox-proposal-actions">
        <Button
          variant="secondary"
          size="sm"
          label={props.again ? words.draftAgain : words.useThis}
          disabled={props.busy}
          onClick={() =>
            props.again ? props.onAccept(proposal().id, true) : props.onAccept(proposal().id)
          }
        />
        <Show when={rule()}>
          {(id) => (
            <a {...buttonAttrs({ variant: "quiet", size: "sm" })} href={props.links.rule(id())}>
              {words.openRule}
            </a>
          )}
        </Show>
      </div>
    </article>
  );
}

/** The right-hand pane: the selected transaction, what can be done with it (the actions come first and
 * stay in view as the pane scrolls), why it was suggested, what it would record, and where it came from. */
export function InboxDetail(props: {
  state: "none" | "loading" | "error" | "ready";
  detail?: InboxDetailView;
  accounts: readonly AccountOption[];
  accountLabel: (item: InboxDetailView["item"]) => string;
  links: InboxLinks;
  /** Whether accepting records the transaction or saves a draft, so the words say what will happen. */
  mode?: AcceptMode;
  busy?: boolean;
  /** Asks the pane to open the category field and move the keyboard to it (the `c` shortcut and a row's
   * Categorize). It waits until the transaction has loaded, then says so with `onCategoryFocused`, so the ask
   * is made once and never again for the next transaction. */
  focusCategory?: boolean;
  onCategoryFocused?: () => void;
  /** The category chosen on the transaction's own row ("" when none). Given, the pane's category field
   * shows it and changes it through `onCategory`, so the row and the pane always say the same thing; left
   * out, the pane keeps its own choice. */
  category?: string;
  onCategory?: (accountId: string) => void;
  onAccept: (proposalId?: string, allowDuplicate?: boolean) => void;
  onCategorize: (choice: CategorizeChoice) => void;
  onExclude: () => void;
  onRestore: () => void;
  onPost: () => void;
  /** Take a posted transaction back: reverse its entry and return it to review. */
  onUndo?: () => void;
  onRetry: () => void;
  /** Narrow the list to the transactions this payout books. */
  onShowCovered?: (providerId: string) => void;
  /** Close the pane (it is a sheet on a phone, which closes itself). */
  onClose?: () => void;
  /** Off when a dialog around the pane already carries the title. */
  showTitle?: boolean;
}) {
  let region: HTMLElement | undefined;
  const [panel, setPanel] = createSignal<"closed" | "category" | "split">("closed");
  const [ownAccount, setOwnAccount] = createSignal("");
  const accountId = () => props.category ?? ownAccount();
  const setAccountId = (id: string) => {
    if (props.onCategory) props.onCategory(id);
    else setOwnAccount(id);
  };
  const [narration, setNarration] = createSignal("");
  const [parts, setParts] = createSignal<readonly SplitPart[]>([
    { accountId: "", amount: "" },
    { accountId: "", amount: "" },
  ]);
  const item = () => props.detail?.item;
  const open = () => item()?.status === "new" || item()?.status === "proposed";
  /** A transaction with nothing suggested starts with the category field open: it is the thing to do. */
  const needsCategory = () => (props.detail?.proposals.length ?? 0) === 0;
  const categorizable = () => {
    const current = item();
    return current !== undefined && canChooseCategory(current);
  };
  createEffect(
    on(
      () => props.detail?.item.id,
      () => {
        // Only the pane's own choice: one made on a row belongs to that row and stays with it.
        setOwnAccount("");
        setNarration("");
        setParts([
          { accountId: "", amount: "" },
          { accountId: "", amount: "" },
        ]);
        setPanel("closed");
      },
    ),
  );
  /** The panel opens by itself when there is nothing suggested, and when a category was chosen on the
   * transaction's row (the pane then says what the row says). */
  const panelOpen = () =>
    panel() !== "closed" ||
    (open() && categorizable() && (needsCategory() || (props.category ?? "") !== ""));
  createEffect(() => {
    if (props.focusCategory !== true || props.state !== "ready" || !categorizable()) return;
    props.onCategoryFocused?.();
    untrack(() => {
      if (panel() === "closed") setPanel("category");
    });
    // The field is made when the panel opens: ask for focus once it is there.
    setTimeout(
      () =>
        region
          ?.querySelector<HTMLInputElement>(".rt-inbox-categorize input[role='combobox']")
          ?.focus(),
      0,
    );
  });

  const total = () => withoutSign(item()?.line.amount ?? "0.00");
  const splitting = () => panel() === "split";
  const split = createMemo(() => checkSplit(total(), parts()));
  const canDraft = () => !props.busy && (splitting() ? split().ok : accountId() !== "");
  /** The transaction is already in the books (booked by hand, or by an agent): anything that makes another
   * entry for it is a second payment, and has to be chosen as one. */
  const booked = () =>
    (props.detail?.proposals ?? []).some((proposal) => proposal.kind === "match");
  const again = (proposal: InboxProposalView) =>
    booked() && proposal.kind !== "match" && proposal.kind !== "exclude";
  const top = () => props.detail?.proposals[0];
  const others = () => (props.detail?.proposals ?? []).slice(1);
  const accountsForCategory = () =>
    props.accounts.filter((account) => account.value !== item()?.ledgerAccountId);

  /** What the person's own choice would record, for the preview under the category field. */
  const manualLegs = (): readonly InboxLegView[] | null => {
    const current = item();
    if (!current?.ledgerAccountId) return null;
    const out = isNegativeMoney(current.line.amount);
    const own: InboxLegView = { accountId: current.ledgerAccountId, amount: current.line.amount };
    const against = (account: string, cents: bigint): InboxLegView => ({
      accountId: account,
      amount: centsToMoney(out ? cents : -cents),
    });
    if (splitting()) {
      const chosen = parts().flatMap((part) => {
        const cents = parseAmount(part.amount);
        return part.accountId !== "" && cents !== null && cents > 0n
          ? [against(part.accountId, cents)]
          : [];
      });
      return chosen.length > 0 ? [own, ...chosen] : null;
    }
    return accountId() !== "" ? [own, against(accountId(), moneyToCents(total()))] : null;
  };
  const previewLegs = (): readonly InboxLegView[] | null =>
    panelOpen() && manualLegs() ? manualLegs() : (top()?.legs ?? null);

  const draft = () => {
    const note = narration().trim();
    const duplicate = booked() ? { allowDuplicate: true } : {};
    props.onCategorize(
      splitting()
        ? {
            splits: parts().map((part) => ({
              accountId: part.accountId,
              amount: centsToMoney(parseAmount(part.amount) ?? 0n),
            })),
            ...(note ? { narration: note } : {}),
            ...duplicate,
          }
        : { accountId: accountId(), ...(note ? { narration: note } : {}), ...duplicate },
    );
  };

  return (
    <aside
      class="rt-inbox-detail"
      aria-label={words.detailTitle}
      ref={(element) => {
        region = element;
      }}
    >
      <Show when={props.showTitle ?? true}>
        <h2 id="rt-inbox-detail-title" class="rt-inbox-detail-title">
          {words.detailTitle}
        </h2>
      </Show>
      <Show when={props.state === "none"}>
        <p class="rt-inbox-muted">{words.detailNone}</p>
      </Show>
      <Show when={props.state === "loading"}>
        <p role="status">{words.detailLoading}</p>
      </Show>
      <Show when={props.state === "error"}>
        <div role="alert">
          <p>{words.detailFailed}</p>
          <Button variant="secondary" size="sm" label={words.retry} onClick={props.onRetry} />
        </div>
      </Show>
      <Show when={props.state === "ready" && props.detail}>
        {(detail) => (
          <>
            <div class="rt-inbox-actionbar" role="toolbar" aria-label={words.detailBar}>
              <Show when={open() && !detail().item.coveredBy}>
                <Show when={top()}>
                  {(first) => (
                    <Button
                      label={again(first()) ? words.draftAgain : words.accept}
                      variant="primary"
                      size="sm"
                      disabled={props.busy ?? false}
                      // Accept books what the pane says will be recorded: the person's own category
                      // or split when one is chosen below, the suggestion otherwise.
                      onClick={() => {
                        if (panelOpen() && canDraft()) draft();
                        else if (again(first())) props.onAccept(first().id, true);
                        else props.onAccept(first().id);
                      }}
                    />
                  )}
                </Show>
                <Show when={categorizable()}>
                  <Button
                    label={words.categorize}
                    variant="secondary"
                    size="sm"
                    aria-expanded={panelOpen() && !splitting()}
                    aria-controls="rt-inbox-categorize"
                    disabled={props.busy ?? false}
                    onClick={() => setPanel(panel() === "category" ? "closed" : "category")}
                  />
                  <Button
                    label={words.splitBetween}
                    variant="secondary"
                    size="sm"
                    aria-expanded={splitting()}
                    aria-controls="rt-inbox-categorize"
                    disabled={props.busy ?? false}
                    onClick={() => setPanel(splitting() ? "closed" : "split")}
                  />
                </Show>
                <Button
                  label={words.exclude}
                  variant="secondary"
                  size="sm"
                  disabled={props.busy ?? false}
                  onClick={props.onExclude}
                />
              </Show>
              <Show when={detail().item.status === "drafted" && !detail().item.coveredBy}>
                <Button
                  label={words.post}
                  variant="primary"
                  size="sm"
                  pending={props.busy ?? false}
                  disabled={props.busy ?? false}
                  onClick={props.onPost}
                />
                <Button
                  label={words.restore}
                  variant="secondary"
                  size="sm"
                  disabled={props.busy ?? false}
                  onClick={props.onRestore}
                />
              </Show>
              <Show when={detail().item.status === "posted"}>
                <Show when={detail().item.journalId}>
                  {(id) => (
                    <a
                      class="rt-button"
                      data-variant="secondary"
                      data-size="sm"
                      href={props.links.entry(id())}
                    >
                      {words.viewEntry}
                    </a>
                  )}
                </Show>
                <Show when={props.onUndo && !detail().item.coveredBy}>
                  <Button
                    label={undoWords.action}
                    variant="secondary"
                    size="sm"
                    disabled={props.busy ?? false}
                    onClick={() => props.onUndo?.()}
                  />
                </Show>
              </Show>
              <Show when={detail().item.status === "excluded" && !detail().item.coveredBy}>
                <Button
                  label={words.restore}
                  variant="secondary"
                  size="sm"
                  disabled={props.busy ?? false}
                  onClick={props.onRestore}
                />
              </Show>
              <Show when={props.onClose}>
                <span class="rt-inbox-actionbar-end">
                  <Button
                    label={words.closeDetail}
                    variant="quiet"
                    size="sm"
                    onClick={() => props.onClose?.()}
                  />
                </span>
              </Show>
            </div>

            <Facts detail={detail()} />
            <header class="rt-inbox-detail-head">
              <p class="rt-inbox-muted">
                <span class="rt-inbox-date">
                  <DateValue value={detail().item.line.date} />
                </span>
                {" · "}
                <bdi>{props.accountLabel(detail().item)}</bdi>
              </p>
              <p class="rt-inbox-detail-amount">
                <span class="rt-inbox-amount">
                  {formatMoneyAbsolute(detail().item.line.amount)}
                </span>{" "}
                <span class="rt-inbox-detail-direction">
                  {isNegativeMoney(detail().item.line.amount) ? words.moneyOut : words.moneyIn}
                </span>
                <Show when={detail().item.line.currency !== "USD"}>
                  <span class="rt-inbox-currency"> {detail().item.line.currency}</span>
                </Show>
              </p>
              <div class="rt-inbox-chips">
                {/* A transaction that is waiting is the pane's whole subject: it needs no chip to say so. */}
                <Show when={!open() || detail().item.coveredBy}>
                  <StatusChip
                    status={detail().item.status}
                    covered={Boolean(detail().item.coveredBy)}
                  />
                </Show>
                <Show when={detail().item.reconciled}>
                  {(mark) => <ReconciledMark statementDate={mark().statementDate} />}
                </Show>
              </div>
            </header>
            <FlagList flags={detail().item.flags} currency={detail().item.line.currency} />
            <EventEntry detail={detail()} />

            <Show when={detail().item.coveredBy}>
              {(cover) => (
                <Notice title={words.coveredNote(cover().providerId)}>
                  <Show
                    when={cover().itemId}
                    fallback={<p>{words.coveredAwaiting(cover().providerId)}</p>}
                  >
                    {(id) => <a href={props.links.item(id())}>{cover().providerId}</a>}
                  </Show>
                </Notice>
              )}
            </Show>
            <Show when={(detail().coveredCount ?? 0) > 0}>
              <p class="rt-inbox-muted">{words.coversNote(detail().coveredCount ?? 0)}</p>
              <Show when={props.onShowCovered && detail().item.line.providerId}>
                <Button
                  variant="secondary"
                  size="sm"
                  label={words.showCovered}
                  onClick={() => props.onShowCovered?.(detail().item.line.providerId ?? "")}
                />
              </Show>
            </Show>

            <Show when={detail().item.postError}>
              {(message) => (
                <Notice title={words.postFailed} tone="problem" role="alert">
                  <bdi>{message()}</bdi>
                </Notice>
              )}
            </Show>

            <Show when={open() && !detail().item.coveredBy}>
              <Show when={top()}>
                {(first) => (
                  <section class="rt-inbox-why-section" aria-labelledby="rt-inbox-why">
                    <h3 id="rt-inbox-why" class="rt-inbox-label">
                      {words.whyHeading}
                    </h3>
                    <ul class="rt-inbox-reasons rt-inbox-proposal-reasons">
                      <For each={reasonsOf(first())}>
                        {(reason) => (
                          <li>
                            <bdi>{formatFiguresInText(transactionsIn(reason))}</bdi>
                          </li>
                        )}
                      </For>
                    </ul>
                    <Show when={first().kind === "match" && first().matchJournalId}>
                      {(id) => (
                        <>
                          <p>{words.matchEntry}.</p>
                          <p>
                            <a
                              {...buttonAttrs({ variant: "secondary", size: "sm" })}
                              href={props.links.entry(id())}
                            >
                              {words.viewEntry}
                            </a>
                          </p>
                        </>
                      )}
                    </Show>
                    <Show when={first().kind === "transfer"}>
                      <p class="rt-inbox-muted">{words.pairedWith}</p>
                    </Show>
                    <Show when={ruleIdOf(first().proposer)}>
                      {(id) => (
                        <p class="rt-inbox-action-line">
                          <a
                            {...buttonAttrs({ variant: "quiet", size: "sm" })}
                            href={props.links.rule(id())}
                          >
                            {words.openRule}
                          </a>
                        </p>
                      )}
                    </Show>
                  </section>
                )}
              </Show>
              <Show when={booked() && detail().proposals.length > 1}>
                <p class="rt-hint">{words.alreadyBooked}</p>
              </Show>
              <Show
                when={top()?.kind === "exclude"}
                fallback={
                  <Show when={previewLegs() && top()?.kind !== "match"}>
                    {(_legs) => (
                      <Record
                        legs={previewLegs() ?? []}
                        accounts={props.accounts}
                        heading={words.willRecord}
                      />
                    )}
                  </Show>
                }
              >
                <p class="rt-inbox-muted">{words.willExclude}</p>
              </Show>
              <Show when={top()?.kind === "match"}>
                <p class="rt-inbox-muted">{words.willMatch}</p>
              </Show>

              <Show when={categorizable() && panelOpen()}>
                <section
                  id="rt-inbox-categorize"
                  class="rt-inbox-section rt-inbox-categorize"
                  aria-label={words.categorizeTitle}
                >
                  <p class="rt-hint">
                    {booked()
                      ? words.draftAgainHint
                      : props.mode === "draft"
                        ? words.recordDraftHint
                        : words.categorizeHint}
                  </p>
                  <Show
                    when={splitting()}
                    fallback={
                      <AccountPicker
                        label={words.chooseAccount}
                        accounts={accountsForCategory()}
                        value={accountId()}
                        onChange={setAccountId}
                        // The sentence above the field already says what to choose.
                        hint=""
                      />
                    }
                  >
                    <SplitEditor
                      total={total()}
                      accounts={accountsForCategory()}
                      parts={parts()}
                      onChange={setParts}
                    />
                  </Show>
                  <TextArea
                    label={words.narration}
                    rows={2}
                    value={narration()}
                    onInput={(event) => setNarration(event.currentTarget.value)}
                  />
                  <div class="rt-inbox-form-actions">
                    <Button
                      label={
                        booked()
                          ? words.draftAgain
                          : props.mode === "draft"
                            ? words.categorizeConfirmDraft
                            : words.categorizeConfirm
                      }
                      pending={props.busy ?? false}
                      pendingLabel={booked() ? words.draftAgainPending : words.categorizePending}
                      disabled={!canDraft()}
                      onClick={draft}
                    />
                    <Button
                      variant="quiet"
                      label={words.cancel}
                      onClick={() => {
                        setPanel("closed");
                        setAccountId("");
                      }}
                    />
                  </div>
                </section>
              </Show>

              <Show when={others().length > 0}>
                <section class="rt-inbox-section" aria-labelledby="rt-inbox-others">
                  <h3 id="rt-inbox-others">{words.otherSuggestions}</h3>
                  <For each={others()}>
                    {(proposal) => (
                      <Alternative
                        proposal={proposal}
                        again={again(proposal)}
                        accounts={props.accounts}
                        ownAccountId={detail().item.ledgerAccountId}
                        links={props.links}
                        busy={props.busy ?? false}
                        onAccept={props.onAccept}
                      />
                    )}
                  </For>
                </section>
              </Show>
              <Show when={detail().proposalProblems.length > 0}>
                <Details summary={words.problemsTitle}>
                  <p class="rt-inbox-muted">{words.problemsBody}</p>
                  <ul>
                    <For each={detail().proposalProblems}>
                      {(problem) => (
                        <li>
                          <bdi>{problem}</bdi>
                        </li>
                      )}
                    </For>
                  </ul>
                </Details>
              </Show>
              <Show when={!top() && !categorizable()}>
                <p class="rt-inbox-muted">{words.noSuggestions}</p>
              </Show>
            </Show>

            <Show when={detail().item.status === "drafted" && !detail().item.coveredBy}>
              <p>{words.draftWaiting}</p>
              <Show when={detail().item.decision?.legs}>
                {(legs) => (
                  <Record legs={legs()} accounts={props.accounts} heading={words.willRecord} />
                )}
              </Show>
            </Show>

            <Show when={detail().item.status === "posted"}>
              <p>{detail().item.decision?.kind === "match" ? words.matchedAs : words.postedAs}</p>
              <Show when={detail().item.reconciled}>
                {(mark) => (
                  <>
                    <p>{words.reconciledNote(formatDate(mark().statementDate))}</p>
                    <Show when={props.links.reconciliation}>
                      {(link) => (
                        <p>
                          <a
                            {...buttonAttrs({ variant: "secondary", size: "sm" })}
                            href={link()(mark().reconciliationId)}
                          >
                            {words.viewReconciliation}
                          </a>
                        </p>
                      )}
                    </Show>
                  </>
                )}
              </Show>
            </Show>

            <Show when={detail().item.status === "excluded" && !detail().item.coveredBy}>
              <p>
                <strong>
                  {words.exclusionLabel[detail().item.exclusion?.code ?? "manual"] ??
                    words.statusLabel.excluded}
                </strong>
                <Show when={detail().item.exclusion?.reason}>
                  {": "}
                  <bdi>{detail().item.exclusion?.reason}</bdi>
                </Show>
              </p>
            </Show>

            <p class="rt-inbox-rule-link">
              <a
                {...buttonAttrs({ variant: "quiet", size: "sm" })}
                href={props.links.newRule(detail().item.id)}
              >
                {words.createRule}
              </a>
            </p>

            <Details summary={words.provenance}>
              <DetailsList
                items={[
                  {
                    label: words.provenanceFrom,
                    value:
                      detail().provenance.rawName !== undefined
                        ? words.fromFile(
                            detail().provenance.rawName ?? "",
                            detail().provenance.rawIndex + 1,
                          )
                        : words.fromBatch(
                            detail().provenance.provider,
                            detail().provenance.rawIndex + 1,
                          ),
                  },
                  { label: words.imported, value: instant(detail().provenance.submittedAt) },
                  { label: words.fetched, value: instant(detail().provenance.fetchedAt) },
                  ...(detail().item.line.providerId
                    ? [
                        {
                          label: words.providerId,
                          value: detail().item.line.providerId ?? "",
                          mono: true,
                        },
                      ]
                    : []),
                  {
                    label: words.archivedAs,
                    value: detail().provenance.rawSha256,
                    mono: true,
                    copy: true,
                    copyLabel: words.archivedAs,
                  },
                  {
                    label: words.ledgerSource,
                    value: detail().provenance.sourceEventId,
                    mono: true,
                    copy: true,
                    copyLabel: words.ledgerSource,
                  },
                  {
                    label: words.evidence,
                    value: detail().provenance.evidenceReference,
                    mono: true,
                  },
                ]}
              />
              <Show when={detail().provenance.excerpt}>
                {(excerpt) => (
                  <>
                    <p class="rt-inbox-label">{words.rawExcerpt}</p>
                    <pre class="rt-inbox-excerpt">{excerpt()}</pre>
                  </>
                )}
              </Show>
              <Show when={detail().history.length > 0}>
                <p class="rt-inbox-label">{words.history}</p>
                <ol class="rt-inbox-history">
                  <For each={detail().history}>
                    {(entry) => (
                      <li>
                        <span>
                          {words.historyKind[entry.kind] ?? entry.kind} {words.by(entry.by)}
                        </span>
                        <span class="rt-inbox-muted">
                          {instant(entry.at)}
                          <Show when={entry.reason}>
                            {" · "}
                            <bdi>{entry.reason}</bdi>
                          </Show>
                        </span>
                      </li>
                    )}
                  </For>
                </ol>
              </Show>
            </Details>
          </>
        )}
      </Show>
    </aside>
  );
}
