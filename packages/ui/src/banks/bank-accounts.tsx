import { For, type JSX, Show } from "solid-js";
import { RowMenu } from "../accounting/row-menu";
import type { RowAction } from "../accounting-types";
import { Button } from "../button";
import { Money } from "../money";
import { PageHeader } from "../page-header";
import { bankWords as words } from "./words";

/** One account of a connected bank. */
export interface BankAccountLine {
  readonly id: string;
  /** As the bank names it: "Checking". */
  readonly name: string;
  /** The last digits the bank gives, or null. */
  readonly ending: string | null;
  /** A plain fact about it that is not the usual one ("Disconnected"). */
  readonly note?: string | undefined;
  /** The account in the books its transactions go into, and that account's page; null while it waits for an answer. */
  readonly ledger: { readonly label: string; readonly href: string } | null;
  /** How many of its transactions wait in For review, and where they are listed; null when that is not known. */
  readonly review: { readonly count: number; readonly href: string } | null;
  /** What the books hold in it, a decimal; null when there is nothing to say yet. */
  readonly balance: string | null;
  /** The one question: the books already hold an account this could be. Asked only then. */
  readonly question?:
    | { readonly account: string; readonly onYes: () => void; readonly onNo: () => void }
    | undefined;
  /** What can be done to it, for a person who may: change where it goes, disconnect. */
  readonly actions: readonly RowAction[];
}

/** A bank, with the accounts connected at it. */
export interface BankGroup {
  readonly institution: string;
  /** When it last brought anything, in words ("Updated today 9:41 AM"); null before the first. */
  readonly dateline: string | null;
  /** What needs the person at this bank (it wants them to sign in again), with its one action. */
  readonly attention?:
    | {
        readonly text: string;
        readonly action?: { readonly label: string; readonly onSelect: () => void } | undefined;
      }
    | undefined;
  readonly accounts: readonly BankAccountLine[];
}

/** Bank accounts, in the ledger language (docs/reference/design-language.md). One job: see which bank accounts feed
 * the books, and connect another. Each bank is a block under one rule: its mark and name, then a row for each
 * account with where it goes in the books, what waits for review and what the books hold. A bank that needs the
 * person turns its rule orange and says so, with the button. Nothing is marked while it works.
 *
 * Connecting asks nothing: the page's host adds the accounts to the books. A row asks one yes-or-no only when the
 * books already hold an account it could be. The two ways to bring transactions in are the page's two buttons. */
export function BankAccounts(props: {
  groups: readonly BankGroup[];
  /** The books' currency, for the heading of the balance column ("USD"). */
  currency: string;
  /** Connect a bank; absent for a person who may not. */
  onConnect?: (() => void) | undefined;
  /** Bring in a statement file instead; absent where that is not offered. */
  onImport?: (() => void) | undefined;
  busy?: boolean | undefined;
  /** What the page says before any bank, in place of its usual sentence (the service cannot connect one just now). */
  emptyText?: string | undefined;
  /** How a link is drawn (the application's router). */
  renderLink?: ((href: string, children: JSX.Element, label?: string) => JSX.Element) | undefined;
  titleId?: string | undefined;
}): JSX.Element {
  const link = (href: string, children: JSX.Element, label?: string) =>
    props.renderLink ? (
      props.renderLink(href, children, label)
    ) : (
      <a href={href} aria-label={label}>
        {children}
      </a>
    );
  const empty = () => props.groups.length === 0;
  const buttons = () => (
    <div class="rt-bankacct-buttons">
      <Show when={props.onImport}>
        {(bring) => (
          <Button
            variant="secondary"
            label={words.importStatement}
            disabled={props.busy ?? false}
            onClick={() => bring()()}
          />
        )}
      </Show>
      <Show when={props.onConnect}>
        {(connect) => (
          <Button
            label={words.connect}
            disabled={props.busy ?? false}
            onClick={() => connect()()}
          />
        )}
      </Show>
    </div>
  );
  return (
    <div class="rt-banks">
      <PageHeader
        {...(props.titleId ? { titleId: props.titleId } : {})}
        title={words.title}
        description={empty() ? undefined : words.lead}
        actions={<Show when={!empty()}>{buttons()}</Show>}
      />
      <Show when={empty()}>
        <div class="rt-bankacct-empty">
          <p class="rt-bankacct-empty-lead">
            {props.emptyText ?? (props.onConnect ? words.empty : words.emptyMember)}
          </p>
          {buttons()}
        </div>
      </Show>
      <For each={props.groups}>
        {(group) => (
          <section
            class="rt-bankacct"
            aria-label={group.institution}
            data-attention={group.attention ? "" : undefined}
          >
            <header class="rt-bankacct-head">
              <span class="rt-bankacct-mark" aria-hidden="true">
                {group.institution.trim().charAt(0).toUpperCase()}
              </span>
              <div class="rt-bankacct-name">
                <h2>{group.institution}</h2>
                <Show when={group.attention}>
                  {(attention) => (
                    <p class="rt-bankacct-attention">
                      <span class="rt-cell" data-tone="attention" aria-hidden="true" />
                      {attention().text}
                    </p>
                  )}
                </Show>
              </div>
              <Show when={group.dateline}>
                <span class="rt-bankacct-dateline">{group.dateline}</span>
              </Show>
              <Show when={group.attention?.action}>
                {(action) => (
                  <Button
                    size="sm"
                    label={action().label}
                    disabled={props.busy ?? false}
                    onClick={() => action().onSelect()}
                  />
                )}
              </Show>
            </header>
            <div class="rt-bankacct-labels" aria-hidden="true">
              <span>{words.columns.account}</span>
              <span>{words.columns.books}</span>
              <span>{words.columns.review}</span>
              <span>{words.columns.balance(props.currency)}</span>
              <span />
            </div>
            <ul class="rt-bankacct-rows">
              <For each={group.accounts}>
                {(account) => (
                  <li>
                    <div class="rt-bankacct-row">
                      <div class="rt-bankacct-account">
                        <strong>{account.name}</strong>
                        <Show when={account.ending}>
                          <span class="rt-bankacct-ending">
                            <span aria-hidden="true">··</span>
                            <span class="rt-sr-only">{words.ending} </span>
                            {account.ending}
                          </span>
                        </Show>
                        <Show when={account.note}>
                          <span class="rt-bankacct-note">{account.note}</span>
                        </Show>
                      </div>
                      <div class="rt-bankacct-books">
                        <Show
                          when={account.ledger}
                          fallback={
                            <span class="rt-bankacct-waiting">{words.waitingForAnswer}</span>
                          }
                        >
                          {(ledger) => link(ledger().href, ledger().label)}
                        </Show>
                      </div>
                      <div class="rt-bankacct-review">
                        <Show when={account.review}>
                          {(review) => (
                            <Show
                              when={review().count > 0}
                              fallback={
                                <span class="rt-bankacct-count">
                                  <span class="rt-cell" aria-hidden="true" />0
                                  <span class="rt-bankacct-count-words">{words.countWords}</span>
                                </span>
                              }
                            >
                              {link(
                                review().href,
                                <span class="rt-bankacct-count" data-waiting="">
                                  <span class="rt-cell" data-tone="attention" aria-hidden="true" />
                                  {review().count}
                                  <span class="rt-bankacct-count-words" aria-hidden="true">
                                    {words.countWords}
                                  </span>
                                </span>,
                                words.toReview(review().count, account.name),
                              )}
                            </Show>
                          )}
                        </Show>
                      </div>
                      <div class="rt-bankacct-balance">
                        <Show when={account.balance}>
                          {(balance) => <Money value={balance()} />}
                        </Show>
                      </div>
                      <div class="rt-bankacct-menu">
                        <Show when={account.actions.length > 0}>
                          <RowMenu
                            id={`rt-bankacct-actions-${account.id}`}
                            label={words.actionsFor(`${group.institution} ${account.name}`)}
                            actions={account.actions}
                          />
                        </Show>
                      </div>
                    </div>
                    <Show when={account.question}>
                      {(question) => (
                        <div class="rt-bankacct-question">
                          <span class="rt-cell" data-tone="attention" aria-hidden="true" />
                          <p>{words.same(question().account)}</p>
                          <div class="rt-bankacct-buttons">
                            <Button
                              size="sm"
                              label={words.yesUse(question().account)}
                              disabled={props.busy ?? false}
                              onClick={() => question().onYes()}
                            />
                            <Button
                              size="sm"
                              variant="secondary"
                              label={words.noSeparate}
                              disabled={props.busy ?? false}
                              onClick={() => question().onNo()}
                            />
                          </div>
                        </div>
                      )}
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </section>
        )}
      </For>
    </div>
  );
}
