import { createUniqueId, For, onMount, Show, type JSX } from "solid-js";
import { PageSkeleton } from "../skeleton";
import { Button, buttonAttrs } from "../button";
import { formatDate } from "../format";
import { EmptyState } from "../kit/empty-state";
import { Money } from "../money";
import { Notice, Status } from "../notice";
import { DateField } from "../date-field";
import { TextField } from "../text-field";
import type {
  TieoutAccountView,
  TieoutLineView,
  TieoutPeriodView,
  TieoutReportView,
  TieoutScreenProps,
} from "./xero-types";
import { NoBook } from "./no-book";
import { xeroWords as words } from "./xero-words";
import { PageHeader } from "../page-header";
import { Details } from "../kit/details";

const DASH = "—";

/** An amount, or a dash where there is none (a book that has nothing to say about the account). */
function Amount(props: { value: string | null }): JSX.Element {
  return (
    <Show
      when={props.value !== null}
      fallback={
        <>
          <span class="rt-sr-only">{words.noAmount}</span>
          <span aria-hidden="true">{DASH}</span>
        </>
      }
    >
      <Money value={props.value as string} />
    </Show>
  );
}

function LinesTable(props: { account: TieoutAccountView; period: string }): JSX.Element {
  const label = () => words.lineCaption(`${props.account.code}, ${props.period}`);
  return (
    <section class="rt-table-scroll" tabindex="0" aria-label={label()}>
      <table class="rt-table rt-xero-table">
        <caption class="rt-sr-only">{label()}</caption>
        <thead>
          <tr>
            <th scope="col">{words.colSide}</th>
            <th scope="col">{words.colDate}</th>
            <th scope="col">{words.colDescription}</th>
            <th scope="col">{words.colReference}</th>
            <th scope="col" class="rt-number">
              {words.colDebit}
            </th>
            <th scope="col" class="rt-number">
              {words.colCredit}
            </th>
          </tr>
        </thead>
        <tbody>
          <For each={props.account.unmatched}>
            {(line: TieoutLineView) => (
              <tr data-side={line.side}>
                <td>{words.side[line.side]}</td>
                <td>{formatDate(line.date)}</td>
                <td>
                  <bdi>{line.description}</bdi>
                  <Show when={line.source}>
                    <small>
                      <bdi>{line.source}</bdi>
                    </small>
                  </Show>
                </td>
                <td>
                  <bdi>{line.reference}</bdi>
                </td>
                <td class="rt-number">
                  <Show when={line.debit !== "0.00"} fallback={DASH}>
                    <Money value={line.debit} />
                  </Show>
                </td>
                <td class="rt-number">
                  <Show when={line.credit !== "0.00"} fallback={DASH}>
                    <Money value={line.credit} />
                  </Show>
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </section>
  );
}

/** What one differing account's lines say: what the books already disagreed about when the period
 * began, how many lines match, and the lines found in one book and not the other. */
function Explanation(props: {
  account: TieoutAccountView;
  id: string;
  period: string;
}): JSX.Element {
  const account = () => props.account;
  const shown = () => account().unmatched.length;
  return (
    <Details
      flush
      id={props.id}
      summary={<bdi>{words.detailsFor(`${account().code} ${account().name}`)}</bdi>}
    >
      <div class="rt-xero-explanation">
        <Show when={account().carried !== null && account().carried !== "0.00"}>
          <p>
            {words.carriedLabel} <Money value={account().carried as string} />.
          </p>
        </Show>
        <p>{words.matchedLabel(account().matched)}</p>
        <Show when={shown() > 0}>
          <h3>{words.unmatchedHeading}</h3>
          <LinesTable account={account()} period={props.period} />
          <Show when={(account().unmatchedCount ?? 0) > shown()}>
            <p class="rt-hint">{words.unmatchedMore(shown(), account().unmatchedCount ?? 0)}</p>
          </Show>
        </Show>
        <p>
          <Show
            when={account().explained}
            fallback={
              <>
                {words.explainedNo}: <Money value={account().residual ?? "0.00"} />
              </>
            }
          >
            {words.explainedYes}.
          </Show>
        </p>
      </div>
    </Details>
  );
}

function Period(props: { period: TieoutPeriodView }): JSX.Element {
  const uid = createUniqueId();
  const heading = () => words.periodHeading(props.period.from, props.period.to);
  const differing = () =>
    props.period.accounts.filter(
      (account) =>
        account.status === "differs" && (account.unmatched.length > 0 || account.matched > 0),
    );
  const detailId = (account: TieoutAccountView) => `${uid}-d-${account.accountId}`;
  return (
    <section class="rt-shadow-block" aria-labelledby={`${uid}-title`}>
      <h2 id={`${uid}-title`}>{heading()}</h2>
      <p class="rt-hint">
        {props.period.xeroReconciled ? words.xeroReconciledYes : words.xeroReconciledNo}
      </p>
      <Show when={!props.period.xeroReconciled && props.period.notReconciled.length > 0}>
        <ul class="rt-shadow-notes-list">
          <For each={props.period.notReconciled}>
            {(bank) => (
              <li>
                <bdi>
                  {bank.code} {bank.name}
                </bdi>
                : {words.throughWord(bank.through ? formatDate(bank.through) : null)}
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={props.period.accounts.length > 0}>
        <section class="rt-table-scroll" tabindex="0" aria-label={words.accountsCaption(heading())}>
          <table class="rt-table rt-xero-table">
            <caption class="rt-sr-only">{words.accountsCaption(heading())}</caption>
            <thead>
              <tr>
                <th scope="col">{words.colAccount}</th>
                <th scope="col">{words.colCompared}</th>
                <th scope="col">{words.colResult}</th>
                <th scope="col" class="rt-number">
                  {words.colXero}
                </th>
                <th scope="col" class="rt-number">
                  {words.colRastrata}
                </th>
                <th scope="col" class="rt-number">
                  {words.colDifference}
                </th>
                <th scope="col" class="rt-number">
                  {words.colUnexplained}
                </th>
              </tr>
            </thead>
            <tbody>
              <For each={props.period.accounts}>
                {(account) => (
                  <tr data-status={account.status}>
                    <th scope="row">
                      <bdi>
                        {account.code} {account.name}
                      </bdi>
                    </th>
                    <td>{words.comparedAs[account.basis]}</td>
                    <td>
                      <Status
                        tone={
                          account.status === "differs" && !account.explained
                            ? "error"
                            : account.status === "differs"
                              ? "review"
                              : "neutral"
                        }
                      >
                        {words.result[account.status]}
                      </Status>
                      <Show when={account.status === "not_comparable" && account.reason}>
                        <small>
                          <bdi>{account.reason}</bdi>
                        </small>
                      </Show>
                      <Show when={account.status === "differs"}>
                        <small>{account.explained ? words.explainedYes : words.explainedNo}</small>
                        <Show when={differing().includes(account)}>
                          <small>
                            <a href={`#${detailId(account)}`}>{words.detailsFor(account.code)}</a>
                          </small>
                        </Show>
                      </Show>
                    </td>
                    <td class="rt-number">
                      <Amount value={account.xero} />
                    </td>
                    <td class="rt-number">
                      <Amount value={account.rastrata} />
                    </td>
                    <td class="rt-number">
                      <Amount value={account.difference} />
                    </td>
                    <td class="rt-number">
                      <Amount value={account.status === "differs" ? account.residual : null} />
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </section>
        <For each={differing()}>
          {(account) => <Explanation account={account} id={detailId(account)} period={heading()} />}
        </For>
      </Show>
      <Show when={props.period.unmapped.length > 0}>
        <div class="rt-xero-unmapped">
          <h3>{words.unmappedHeading}</h3>
          <p class="rt-hint">{words.unmappedHint}</p>
          <ul class="rt-shadow-notes-list">
            <For each={props.period.unmapped}>
              {(row) => (
                <li>
                  <bdi>
                    {row.code} {row.name}
                  </bdi>
                  : <Money value={row.net} />
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>
    </section>
  );
}

function Summary(props: { report: TieoutReportView }): JSX.Element {
  const uid = createUniqueId();
  const summary = () => props.report.summary;
  return (
    <section class="rt-shadow-block" aria-labelledby={`${uid}-title`}>
      <h2 id={`${uid}-title`}>{words.summaryHeading}</h2>
      <Show
        when={summary().comparable > 0}
        fallback={<Notice title={words.nothingComparable} tone="info" />}
      >
        <p class="rt-xero-figure">{words.comparisons(summary().matches, summary().comparable)}</p>
        <ul class="rt-xero-facts">
          <Show when={summary().differs > 0}>
            <li>
              {words.differences(summary().differs, summary().explained, summary().unexplained)}
            </li>
          </Show>
          <Show when={summary().notComparable > 0}>
            <li>{words.notComparableCount(summary().notComparable)}</li>
          </Show>
          <Show when={summary().linesOnlyInXero > 0}>
            <li>{words.onlyInXero(summary().linesOnlyInXero)}</li>
          </Show>
          <Show when={summary().linesOnlyInRastrata > 0}>
            <li>{words.onlyInRastrata(summary().linesOnlyInRastrata)}</li>
          </Show>
        </ul>
      </Show>
      <p class="rt-hint">
        <Show when={props.report.cutoverDate}>
          {(date) => <>{words.cutoverWas(formatDate(date()))} </>}
        </Show>
        {words.basisNote(props.report.basis, props.report.currency)}
      </p>
      <Show when={props.report.notes.length > 0}>
        <ul class="rt-shadow-notes-list">
          <For each={props.report.notes}>
            {(note) => (
              <li>
                <bdi>{note}</bdi>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}

/** The comparison with Xero: Rastrata's books against what Xero says, account by account and month by
 * month, only where Xero was itself reconciled. Every difference says whether the lines explain it to
 * the cent. A controlled view: the application runs the comparison and records what it found. */
export function TieoutScreen(props: TieoutScreenProps): JSX.Element {
  const uid = createUniqueId();
  let heading: HTMLHeadingElement | undefined;
  onMount(() => {
    if (props.focusTitle) heading?.focus();
  });
  const held = () => props.uncertain !== null;
  return (
    <section class="rt-shadow-screen" aria-labelledby={`${uid}-title`}>
      <PageHeader
        titleId={`${uid}-title`}
        titleRef={(element) => {
          heading = element;
        }}
        title={words.tieTitle}
        description={words.tieIntro}
        actions={
          <Show when={!props.noBook && props.noXero}>
            <a {...buttonAttrs({ variant: "primary" })} href={props.links.xero}>
              {words.tieNoXeroAction}
            </a>
          </Show>
        }
      />

      <Show when={props.noBook}>
        <NoBook />
      </Show>
      <Show when={!props.noBook && props.noXero}>
        <EmptyState title={words.tieNoXeroTitle}>{words.tieNoXero}</EmptyState>
      </Show>
      <Show when={!props.noBook && !props.noXero && props.state === "loading"}>
        <PageSkeleton shape="table" label={words.loading} />
      </Show>
      <Show when={!props.noBook && !props.noXero && props.state === "error"}>
        <Notice title={words.tieLoadFailed} tone="error" role="alert">
          <Show when={props.onRetry}>
            <Button variant="secondary" label={words.retry} onClick={() => props.onRetry?.()} />
          </Show>
        </Notice>
      </Show>

      <Show when={!props.noBook && !props.noXero && props.state === "ready"}>
        <Show when={props.error}>
          <Notice title={words.requestFailed} tone="error" role="alert">
            {props.error}
          </Notice>
        </Show>
        <Show when={props.uncertain}>
          {(uncertain) => (
            <Notice title={words.uncertainTitle} tone="review" role="alert">
              <p>{words.uncertainBody}</p>
              <Button
                label={words.resume}
                pendingLabel={words.resuming}
                pending={uncertain().resuming}
                onClick={() => props.onResume?.()}
              />
            </Notice>
          )}
        </Show>

        <form
          class="rt-shadow-step rt-xero-range"
          aria-label={words.rangeLegend}
          onSubmit={(event) => {
            event.preventDefault();
            if (!props.range.running) props.range.onRun();
          }}
          noValidate
        >
          <p class="rt-hint">{words.rangeHint}</p>
          <div class="rt-xero-range-fields">
            <DateField
              label={words.rangeFrom}
              value={props.range.from}
              onChange={(value) => props.range.onFrom(value)}
            />
            <DateField
              label={words.rangeTo}
              value={props.range.to}
              onChange={(value) => props.range.onTo(value)}
            />
            <TextField
              label={words.toleranceLabel}
              inputmode="numeric"
              hint={words.toleranceHint}
              value={props.range.tolerance}
              onInput={(event) => props.range.onTolerance(event.currentTarget.value)}
              {...(props.range.toleranceError ? { error: props.range.toleranceError } : {})}
            />
          </div>
          <div class="rt-shadow-actions">
            <Button
              type="submit"
              label={words.compare}
              pendingLabel={words.comparing}
              pending={props.range.running}
            />
          </div>
        </form>

        <Show when={props.report}>
          {(report) => (
            <>
              <Summary report={report()} />
              <Show
                when={report().periods.length > 0}
                fallback={<p class="rt-hint">{words.noPeriods}</p>}
              >
                <For each={report().periods}>{(period) => <Period period={period} />}</For>
              </Show>
              <section class="rt-shadow-block" aria-labelledby={`${uid}-record`}>
                <h2 id={`${uid}-record`}>{words.recordHeading}</h2>
                <p class="rt-hint">{words.recordIntro}</p>
                <Show when={props.record.error}>
                  <Notice title={words.requestFailed} tone="error" role="alert">
                    {props.record.error}
                  </Notice>
                </Show>
                <div class="rt-shadow-actions">
                  <Button
                    label={words.record}
                    pendingLabel={words.recording}
                    pending={props.record.pending}
                    disabled={held()}
                    onClick={() => props.record.onRecord()}
                  />
                  <a href={props.links.gaps}>{words.openGaps}</a>
                </div>
                <p role="status" class="rt-xero-status">
                  <Show when={props.record.result}>
                    {(result) => words.recorded(result().added, result().existing)}
                  </Show>
                </p>
              </section>
            </>
          )}
        </Show>
        <p>
          <a href={props.links.xero}>{words.openXero}</a>
        </p>
      </Show>
    </section>
  );
}
