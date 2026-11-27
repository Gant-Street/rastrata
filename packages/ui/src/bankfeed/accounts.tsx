import { createSignal, createUniqueId, For, Show } from "solid-js";
import { DateField } from "../date-field";
import { SelectField } from "../select-field";
import { Button } from "../button";
import { formatDate, formatFiguresInText, formatInstant, transactionsIn } from "../format";
import { Check, TriangleAlert } from "../icons";
import { Money } from "../money";
import { Notice } from "../notice";
import type {
  BankfeedAccountView,
  BankfeedBalanceView,
  BankfeedChartOption,
  BankfeedListState,
} from "./types";
import { words } from "./words";

/** The accounts the Bridge lists, and which of them are read. An account is read only when the owner
 * links it to a chart account: one that appears at the bank later is shown as not linked and left
 * alone. Each row says what the Bridge reports for the account, set against the books, and says that
 * a feed balance is not a statement balance. */

function FeedBalance(props: { balance: BankfeedBalanceView; currency: string }) {
  return (
    <div class="rt-bankfeed-balance">
      <h4>{words.feedBalanceTitle(formatDate(props.balance.asOf))}</h4>
      <dl class="rt-bankfeed-facts">
        <div>
          <dt>{words.feedReported}</dt>
          <dd>
            <Money value={props.balance.reported} /> <bdi>{props.currency}</bdi>
          </dd>
        </div>
        <Show when={props.balance.ledger !== null}>
          <div>
            <dt>{words.feedBooks}</dt>
            <dd>
              <Money value={props.balance.ledger as string} />
            </dd>
          </div>
        </Show>
        <Show when={props.balance.waiting !== null}>
          <div>
            <dt>{words.feedWaiting}</dt>
            <dd>
              <Money value={props.balance.waiting as string} />
            </dd>
          </div>
        </Show>
        <Show when={props.balance.excluded !== null && props.balance.excluded !== "0.00"}>
          <div>
            <dt>{words.feedAside}</dt>
            <dd>
              <Money value={props.balance.excluded as string} />
            </dd>
          </div>
        </Show>
        <Show when={props.balance.difference !== null}>
          <div data-difference>
            <dt>{words.feedDifference}</dt>
            <dd>
              <Money value={props.balance.difference as string} />
            </dd>
          </div>
        </Show>
      </dl>
      <p class="rt-hint">{words.feedNotStatement}</p>
    </div>
  );
}

function AccountRow(props: {
  account: BankfeedAccountView;
  chart: readonly BankfeedChartOption[];
  bookCurrency: string;
  busy: boolean;
  error: string | null;
  notes: readonly string[];
  onLink: (accountId: string, ledgerAccountId: string, startOn: string) => void;
  onUnlink: (accountId: string) => void;
}) {
  const uid = createUniqueId();
  const [target, setTarget] = createSignal("");
  const [startOn, setStartOn] = createSignal("");
  const [missing, setMissing] = createSignal(false);
  const account = () => props.account;

  const link = (event: SubmitEvent) => {
    event.preventDefault();
    if (target() === "") {
      setMissing(true);
      return;
    }
    setMissing(false);
    props.onLink(account().id, target(), startOn());
  };

  return (
    <li class="rt-bankfeed-account" data-state={account().state}>
      <div class="rt-bankfeed-account-head">
        <h3>
          <bdi>{account().name}</bdi>
        </h3>
        <Show when={account().balance !== null}>
          <p class="rt-bankfeed-figure">
            <Money value={account().balance as string} /> <bdi>{account().currency}</bdi>
          </p>
        </Show>
      </div>
      <p class="rt-hint">
        <Show when={account().bank}>
          <bdi>{account().bank}</bdi>
          {" · "}
        </Show>
        <Show when={account().balanceOn} fallback={words.stateLabels[account().state]}>
          {words.balanceAsOf(formatDate(account().balanceOn as string))}
        </Show>
      </p>
      <p class="rt-bankfeed-state" data-state={account().state === "linked" ? "ok" : "attention"}>
        <Show when={account().state === "linked"} fallback={<TriangleAlert aria-hidden="true" />}>
          <Check aria-hidden="true" />
        </Show>{" "}
        <span>{words.stateLabels[account().state]}</span>
      </p>

      <Show when={account().state === "unsupported" || account().state === "gone"}>
        <p>
          {account().state === "gone"
            ? words.stateLabels.gone
            : (account().unsupported ?? words.stateLabels.unsupported)}
        </p>
      </Show>

      <Show when={account().link}>
        {(link) => (
          <>
            <dl class="rt-bankfeed-facts">
              <div>
                <dt>{words.bookedTo}</dt>
                <dd>
                  <Show when={link().ledgerAccount} fallback={words.linkedToUnknown}>
                    <bdi>{link().ledgerAccount}</bdi>
                  </Show>
                </dd>
              </div>
              <div>
                <dt>{words.readFrom}</dt>
                <dd>{formatDate(link().startOn)}</dd>
              </div>
              <div>
                <dt>{words.readThrough}</dt>
                <dd>{link().through ? formatDate(link().through as string) : words.notReadYet}</dd>
              </div>
              <Show when={link().lastSyncAt}>
                <div>
                  <dt>{words.lastRead}</dt>
                  <dd>{formatInstant(link().lastSyncAt as string)}</dd>
                </div>
              </Show>
            </dl>
            <Show when={link().lastError}>
              <Notice title={words.syncFailed} tone="review">
                <bdi>{link().lastError}</bdi>
              </Notice>
            </Show>
            <Show when={link().feedBalance}>
              {(balance) => <FeedBalance balance={balance()} currency={account().currency} />}
            </Show>
            <div class="rt-bankfeed-actions">
              <Button
                variant="secondary"
                label={words.unlink}
                pendingLabel={words.unlinking}
                pending={props.busy}
                onClick={() => props.onUnlink(account().id)}
              />
              <p class="rt-hint">{words.unlinkNote}</p>
            </div>
          </>
        )}
      </Show>

      <Show when={account().state === "unlinked"}>
        <Show when={account().foreignCurrency}>
          <Notice title={words.foreignTitle} tone="review">
            {words.foreign(account().currency, props.bookCurrency)}
          </Notice>
        </Show>
        <form class="rt-bankfeed-link" onSubmit={link} noValidate>
          <SelectField
            id={`${uid}-to`}
            label={words.linkAccount}
            placeholder={words.chooseAccount}
            items={props.chart}
            value={target()}
            error={missing() ? words.chooseFirst : undefined}
            onChange={(value) => {
              setTarget(value);
              if (value !== "") setMissing(false);
            }}
          />
          <DateField
            id={`${uid}-from`}
            label={words.firstDay}
            hint={words.firstDayHint}
            value={startOn()}
            onChange={setStartOn}
          />
          <div class="rt-bankfeed-actions">
            <Button
              type="submit"
              label={words.link}
              pendingLabel={words.linking}
              pending={props.busy}
            />
          </div>
        </form>
      </Show>

      <Show when={props.error}>
        <Notice
          title={account().state === "linked" ? words.unlinkFailed : words.linkFailed}
          tone="error"
          role="alert"
        >
          <bdi>{props.error}</bdi>
        </Notice>
      </Show>
      <Show when={props.notes.length > 0}>
        <Notice title={words.notes} tone="review" role="status">
          <ul class="rt-bankfeed-notes">
            <For each={props.notes}>
              {(note) => <li>{formatFiguresInText(transactionsIn(note))}</li>}
            </For>
          </ul>
        </Notice>
      </Show>
    </li>
  );
}

export function BankfeedAccounts(props: {
  state: BankfeedListState;
  accounts: readonly BankfeedAccountView[];
  chart: readonly BankfeedChartOption[];
  bookCurrency: string;
  /** The account being linked or unlinked right now. */
  busy: string | null;
  refreshing: boolean;
  /** A failed link or unlink, by account. */
  errors: Readonly<Record<string, string>>;
  /** What the service said to know after a link, by account. */
  notes: Readonly<Record<string, readonly string[]>>;
  /** Without a connection there is nothing to list or refresh. */
  connected: boolean;
  onRefresh: () => void;
  onLink: (accountId: string, ledgerAccountId: string, startOn: string) => void;
  onUnlink: (accountId: string) => void;
}) {
  return (
    <section class="rt-bankfeed-section" aria-labelledby="rt-bankfeed-accounts">
      <h2 id="rt-bankfeed-accounts" tabindex="-1">
        {words.accountsTitle}
      </h2>
      <p class="rt-hint">{words.accountsIntro}</p>
      <Show
        when={props.state === "ready"}
        fallback={
          props.state === "error" ? (
            <Notice title={words.accountsFailed} tone="error" role="alert" />
          ) : (
            <p role="status">{words.accountsLoading}</p>
          )
        }
      >
        <Show when={props.connected}>
          <div class="rt-bankfeed-actions">
            <Button
              variant="secondary"
              label={words.refresh}
              pendingLabel={words.refreshing}
              pending={props.refreshing}
              onClick={props.onRefresh}
            />
            <p class="rt-hint">{words.refreshNote}</p>
          </div>
        </Show>
        <Show when={props.connected && props.chart.length === 0}>
          <Notice title={words.noChart} tone="review" />
        </Show>
        <Show
          when={props.accounts.length > 0}
          fallback={<p>{props.connected ? words.accountsNone : words.notConnected}</p>}
        >
          <ul class="rt-bankfeed-accounts" aria-label={words.accountsTitle}>
            <For each={props.accounts}>
              {(account) => (
                <AccountRow
                  account={account}
                  chart={props.chart}
                  bookCurrency={props.bookCurrency}
                  busy={props.busy === account.id}
                  error={props.errors[account.id] ?? null}
                  notes={props.notes[account.id] ?? []}
                  onLink={props.onLink}
                  onUnlink={props.onUnlink}
                />
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </section>
  );
}
