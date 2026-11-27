import { createUniqueId, For, type JSX, Show } from "solid-js";
import { Button } from "../button";
import { isZeroMoney } from "../format";
import { Money } from "../money";
import { Status } from "../notice";
import type {
  PayeeAmbiguousView,
  PayeeRowView,
  PayeeSubject,
  PayeeTallyView,
  PayeeUnnamedView,
} from "./types";
import { words } from "./words";

/** An amount, or a dash where the row has none of it: most payees have money on one side only, and a
 * column of 0.00 hides the figures that matter. A screen reader still hears the amount. */
export function Figure(props: { value: string }): JSX.Element {
  return (
    <Show
      when={!isZeroMoney(props.value)}
      fallback={
        <span class="rt-payees-none">
          <span aria-hidden="true">—</span>
          <span class="rt-sr-only">{props.value}</span>
        </span>
      }
    >
      <Money value={props.value} />
    </Show>
  );
}

/** A table that scrolls inside its own region when it is wider than the screen, so the page never does. */
function Scroll(props: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <section class="rt-table-scroll" tabindex={0} aria-label={words.tableScroll(props.label)}>
      {props.children}
    </section>
  );
}

/** One part of the report: a heading, what it holds in a sentence, and its table. */
export function Part(props: {
  title: string;
  intro?: string | undefined;
  /** Names the heading for a script that moves focus to it. */
  marker?: string | undefined;
  children: JSX.Element;
}): JSX.Element {
  const id = createUniqueId();
  return (
    <section class="rt-payees-part" aria-labelledby={id}>
      <h3 id={id} tabindex="-1" data-payees-part={props.marker}>
        {props.title}
      </h3>
      <Show when={props.intro}>
        <p class="rt-hint">{props.intro}</p>
      </Show>
      {props.children}
    </section>
  );
}

/** The heading of a table: what its rows are, the two sides of the money, and, where a row has buttons, a
 * column for them (a narrow screen has no such column: the buttons sit under the row's text). */
function Head(props: { first: string; net?: boolean; action?: boolean }): JSX.Element {
  return (
    <thead>
      <tr>
        <th scope="col">{props.first}</th>
        <th scope="col" class="rt-number">
          {words.columnReceived}
        </th>
        <th scope="col" class="rt-number">
          {words.columnSpent}
        </th>
        <Show when={props.net}>
          <th scope="col" class="rt-number">
            {words.columnNet}
          </th>
        </Show>
        <Show when={props.action}>
          <th scope="col" class="rt-payees-wide">
            <span class="rt-sr-only">{words.columnAction}</span>
          </th>
        </Show>
      </tr>
    </thead>
  );
}

/** The buttons of a row, in the column made for them on a wide screen and under the row's text on a narrow
 * one, so the figures keep their room and nothing needs a sideways scroll to be reached. Each is made from
 * the row, so the two places say the same. */
function Narrow(props: { children: JSX.Element }): JSX.Element {
  return <span class="rt-payees-narrow rt-payees-actions">{props.children}</span>;
}
function Wide(props: { children: JSX.Element }): JSX.Element {
  return (
    <td class="rt-payees-wide">
      <span class="rt-payees-actions">{props.children}</span>
    </td>
  );
}

/** What a row of the report is made of, as a button that says so. */
function SeeTransactions(props: { text: string; onClick: () => void }): JSX.Element {
  return (
    <Button
      variant="quiet"
      size="sm"
      label={words.seeTransactions}
      aria-label={words.seeTransactionsFor(props.text)}
      onClick={props.onClick}
    />
  );
}

/** The named payees, largest first. Each name opens that payee's transactions. */
export function PayeeTable(props: {
  rows: readonly PayeeRowView[];
  onOpen: (subject: PayeeSubject) => void;
}): JSX.Element {
  return (
    <Scroll label={words.payeesTitle}>
      <table class="rt-table rt-payees-table">
        <caption class="rt-sr-only">{words.payeesTitle}</caption>
        <Head first={words.columnPayee} net />
        <tbody>
          <For each={props.rows}>
            {(row) => (
              <tr data-payee-row={row.payeeId}>
                <th scope="row">
                  <span class="rt-payees-name">
                    <button
                      type="button"
                      class="rt-payees-link"
                      aria-label={words.openPayee(row.name)}
                      onClick={() =>
                        props.onOpen({ kind: "payee", payeeId: row.payeeId, label: row.name })
                      }
                    >
                      {row.name}
                    </button>
                    <Show when={row.retired}>
                      <Status>{words.retired}</Status>
                    </Show>
                  </span>
                  <small>{words.rowMeta(row.transactions, row.firstOn, row.lastOn)}</small>
                </th>
                <td class="rt-number">
                  <Figure value={row.received} />
                </td>
                <td class="rt-number">
                  <Figure value={row.spent} />
                </td>
                <td class="rt-number">
                  <Figure value={row.net} />
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </Scroll>
  );
}

/** What the bank wrote, shown as the text it is. An empty text is said to be empty. */
function Wrote(props: { text: string }): JSX.Element {
  return <span class="rt-payees-text">{props.text === "" ? words.noText : props.text}</span>;
}

/** Texts that match no payee, grouped (numbers count as one), largest first. Each row names a payee from
 * it, or opens its transactions. */
export function UnnamedTable(props: {
  rows: readonly PayeeUnnamedView[];
  onName: (row: PayeeUnnamedView) => void;
  onOpen: (subject: PayeeSubject) => void;
}): JSX.Element {
  const actions = (row: PayeeUnnamedView) => (
    <>
      <Button
        variant="secondary"
        size="sm"
        label={words.nameThis}
        aria-label={words.nameThisFor(row.text)}
        onClick={() => props.onName(row)}
      />
      <SeeTransactions
        text={row.text}
        onClick={() =>
          props.onOpen({
            kind: "unnamed",
            key: row.key,
            label: row.text,
            suggestedWords: row.suggestedWords,
          })
        }
      />
    </>
  );
  return (
    <Scroll label={words.unnamedTitle}>
      <table class="rt-table rt-payees-table rt-payees-unnamed">
        <caption class="rt-sr-only">{words.unnamedTitle}</caption>
        <Head first={words.columnWrote} action />
        <tbody>
          <For each={props.rows}>
            {(row) => (
              <tr>
                <th scope="row">
                  <Wrote text={row.text} />
                  <small>{words.rowMeta(row.transactions, row.firstOn, row.lastOn)}</small>
                  <Narrow>{actions(row)}</Narrow>
                </th>
                <td class="rt-number">
                  <Figure value={row.received} />
                </td>
                <td class="rt-number">
                  <Figure value={row.spent} />
                </td>
                <Wide>{actions(row)}</Wide>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </Scroll>
  );
}

/** Texts that match more than one payee equally well, so they are given to none. Each names the payees, and
 * each payee's name leads to changing its words: the way out is to make one set of words longer. */
export function AmbiguousTable(props: {
  rows: readonly PayeeAmbiguousView[];
  onChange: (payeeId: string) => void;
  onOpen: (subject: PayeeSubject) => void;
}): JSX.Element {
  const open = (row: PayeeAmbiguousView) => (
    <SeeTransactions
      text={row.text}
      onClick={() =>
        props.onOpen({ kind: "ambiguous", key: row.key, label: row.text, payees: row.payees })
      }
    />
  );
  return (
    <Scroll label={words.ambiguousTitle}>
      <table class="rt-table rt-payees-table rt-payees-ambiguous">
        <caption class="rt-sr-only">{words.ambiguousTitle}</caption>
        <Head first={words.columnWrote} action />
        <tbody>
          <For each={props.rows}>
            {(row) => (
              <tr>
                <th scope="row">
                  <Wrote text={row.text} />
                  <small>{words.rowMeta(row.transactions, row.firstOn, row.lastOn)}</small>
                  <span class="rt-payees-matched">
                    {words.columnMatchedBy}{" "}
                    <For each={row.payees}>
                      {(payee, index) => (
                        <>
                          <Show when={index() > 0}>
                            <span aria-hidden="true">, </span>
                          </Show>
                          <button
                            type="button"
                            class="rt-payees-link"
                            aria-label={words.changePayee(payee.name)}
                            onClick={() => props.onChange(payee.id)}
                          >
                            {payee.name}
                          </button>
                        </>
                      )}
                    </For>
                  </span>
                  <Narrow>{open(row)}</Narrow>
                </th>
                <td class="rt-number">
                  <Figure value={row.received} />
                </td>
                <td class="rt-number">
                  <Figure value={row.spent} />
                </td>
                <Wide>{open(row)}</Wide>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </Scroll>
  );
}

/** The two kinds of entry that have no payee to name. */
export function NoPayeeTable(props: {
  byHand: PayeeTallyView;
  noBankText: PayeeTallyView;
  onOpen: (subject: PayeeSubject) => void;
}): JSX.Element {
  const rows = () =>
    [
      {
        why: "by_hand" as const,
        name: words.byHandName,
        note: words.byHandNote,
        tally: props.byHand,
      },
      {
        why: "no_bank_text" as const,
        name: words.noBankTextName,
        note: words.noBankTextNote,
        tally: props.noBankText,
      },
    ].filter((row) => row.tally.transactions > 0);
  return (
    <Scroll label={words.noPayeeTitle}>
      <table class="rt-table rt-payees-table rt-payees-nopayee">
        <caption class="rt-sr-only">{words.noPayeeTitle}</caption>
        <Head first={words.columnKind} action />
        <tbody>
          <For each={rows()}>
            {(row) => {
              const open = () => (
                <SeeTransactions
                  text={row.name}
                  onClick={() => props.onOpen({ kind: "no_payee", why: row.why, label: row.name })}
                />
              );
              return (
                <tr>
                  <th scope="row">
                    <span class="rt-payees-text">{row.name}</span>
                    <small>{row.note}</small>
                    <Narrow>{open()}</Narrow>
                  </th>
                  <td class="rt-number">
                    <Figure value={row.tally.received} />
                  </td>
                  <td class="rt-number">
                    <Figure value={row.tally.spent} />
                  </td>
                  <Wide>{open()}</Wide>
                </tr>
              );
            }}
          </For>
        </tbody>
      </table>
    </Scroll>
  );
}
