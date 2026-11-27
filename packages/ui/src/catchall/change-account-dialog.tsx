import { createEffect, createUniqueId, For, type JSX, on, Show } from "solid-js";
import { Button } from "../button";
import { enterSubmits } from "../chart/enter-submits";
import { DateValue } from "../date-value";
import { Dialog } from "../dialog";
import { formatFiguresInText } from "../format";
import { type AccountOption, AccountPicker } from "../kit/account-picker";
import { Money } from "../money";
import { Notice } from "../notice";
import { Progress } from "../progress";
import { TextField } from "../text-field";
import { doneSplit, leftWords, moving, planSentence } from "./logic";
import type { ChangeAccountStage, MoveRow } from "./types";
import { catchallWords } from "./words";

export interface ChangeAccountDialogProps {
  open: boolean;
  /** How many transactions the change names. */
  count: number;
  /** More were selected than one change takes: how many are in it and how many were left out. */
  capped?: { readonly included: number; readonly left: number } | undefined;
  stage: ChangeAccountStage;
  /** The accounts to choose from, and whether they have been read. */
  accounts: readonly AccountOption[];
  accountsState: "ready" | "loading" | "error";
  onRetryAccounts?: (() => void) | undefined;
  accountId: string;
  onAccount: (id: string) => void;
  /** Said under the account field when nothing was chosen. */
  accountError?: string | undefined;
  reason: string;
  onReason: (value: string) => void;
  /** The name of the account chosen, once there is a plan to read. */
  target: string;
  /** The plan, in `review`; what was done, in `done`. */
  rows: readonly MoveRow[];
  /** While it works: how many are finished, of how many. */
  progress?: { readonly done: number; readonly total: number } | undefined;
  /** What went wrong, in words. */
  error?: string | undefined;
  /** A request was sent and never answered: it must be resumed, not repeated. */
  uncertain?: boolean | undefined;
  onResume?: (() => void) | undefined;
  /** Check what would happen. */
  onPlan: () => void;
  /** Go back from the plan to the choice. */
  onBack: () => void;
  /** Move the transactions in the plan. */
  onConfirm: () => void;
  onCancel: () => void;
  /** Where focus goes when the dialog closes (the button that opened it). */
  returnFocus?: (() => HTMLElement | null) | undefined;
}

/** Changing the account of posted transactions: choose the account, read what will happen to each one,
 * confirm. Nothing is edited: the old entries stay and a linked entry cancels each one. A transaction that
 * cannot be moved is listed with the reason, and the person decides with that in front of them. What a bank
 * wrote is shown as text and cut short; it is never read as anything else. */
export function ChangeAccountDialog(props: ChangeAccountDialogProps): JSX.Element {
  const w = catchallWords.change;
  const pickerId = createUniqueId();
  let summary: HTMLParagraphElement | undefined;

  const stage = () => props.stage;
  const working = () => stage() === "working";
  const planning = () => stage() === "planning";
  const choosing = () => stage() === "choose" || planning() || stage() === "failed";
  const going = () => moving(props.rows);
  /** Closing is held back only while a request is on its way. A request that was sent and not answered is
   * kept, so the dialog may be closed over it and the page says it is waiting. */
  const busy = () => (working() || planning()) && props.uncertain !== true;

  // When the plan or the result arrives, the cursor goes to the sentence that says it: the control that had
  // it has been replaced, and the person should hear what was found.
  createEffect(
    on(
      stage,
      (current) => {
        if (current === "review" || current === "done") queueMicrotask(() => summary?.focus());
      },
      { defer: true },
    ),
  );

  /** Cancel, and the one button that moves the dialog on: it checks while a choice is being made and moves
   * once there is a plan. */
  const actions = (): JSX.Element => (
    <>
      <Button variant="quiet" label={w.cancel} disabled={busy()} onClick={props.onCancel} />
      <Show
        when={stage() === "review"}
        fallback={
          <Show when={choosing()}>
            <Button
              label={w.show}
              pending={planning()}
              pendingLabel={w.planning}
              disabled={props.uncertain === true}
              onClick={props.onPlan}
            />
          </Show>
        }
      >
        <Button
          label={going().length > 0 ? w.plan.confirm(going().length) : w.plan.confirmNone}
          disabled={going().length === 0 || props.uncertain === true}
          onClick={props.onConfirm}
        />
      </Show>
    </>
  );

  const footer = (): JSX.Element => (
    <>
      <Show when={stage() === "review"}>
        <Button variant="quiet" label={w.back} onClick={props.onBack} />
      </Show>
      <Show when={stage() === "done"} fallback={actions()}>
        <Button label={w.done} onClick={props.onCancel} />
      </Show>
    </>
  );

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open && !busy()) props.onCancel();
      }}
      title={w.title(props.count)}
      closeLabel={w.close}
      class="rt-change-account"
      closeOnInteractOutside={false}
      initialFocusEl={() => document.getElementById(pickerId)}
      {...(props.returnFocus ? { finalFocusEl: props.returnFocus } : {})}
      footer={footer()}
    >
      <Show when={choosing()}>
        <p>{w.intro}</p>
        <p class="rt-hint">{w.how}</p>
        <Show when={props.capped}>
          {(capped) => (
            <Notice title={w.capped(capped().included, capped().left)} tone="info" role="status" />
          )}
        </Show>
        <form
          class="rt-change-account-form"
          noValidate
          onSubmit={(event) => event.preventDefault()}
          // The button is in the footer, outside the form, so Enter in a box asks for the plan itself.
          onKeyDown={(event) =>
            enterSubmits(event, () => {
              if (!planning() && props.uncertain !== true) props.onPlan();
            })
          }
        >
          <AccountPicker
            id={pickerId}
            label={w.accountLabel}
            accounts={props.accounts}
            value={props.accountId}
            onChange={props.onAccount}
            state={props.accountsState}
            required
            disabled={planning()}
            error={
              props.accountsState === "error" ? w.accountsFailed : (props.accountError ?? undefined)
            }
          />
          <Show when={props.accountsState === "error" && props.onRetryAccounts}>
            <div>
              <Button
                variant="secondary"
                size="sm"
                label={w.accountsRetry}
                onClick={() => props.onRetryAccounts?.()}
              />
            </div>
          </Show>
          <TextField
            label={w.reasonLabel}
            hint={w.reasonHint}
            maxLength={500}
            value={props.reason}
            disabled={planning()}
            onInput={(event) => props.onReason(event.currentTarget.value)}
          />
        </form>
      </Show>

      <Show when={stage() === "review"}>
        <p ref={summary} tabindex="-1" role="status" class="rt-change-summary">
          {planSentence(props.rows, props.target)}
        </p>
        <Show when={props.rows.some((row) => row.warnings.length > 0)}>
          <Notice title={w.plan.warnings} tone="attention" role="status">
            <ul>
              <For each={[...new Set(props.rows.flatMap((row) => row.warnings))]}>
                {(warning) => <li>{formatFiguresInText(warning)}</li>}
              </For>
            </ul>
          </Notice>
        </Show>
        <PlanTable rows={props.rows} />
      </Show>

      <Show when={working() && props.uncertain !== true}>
        <div role="status" class="rt-change-working">
          <p>{w.working(props.progress?.done ?? 0, props.progress?.total ?? props.count)}</p>
          <Progress
            label={w.workingLabel}
            value={Math.floor(
              ((props.progress?.done ?? 0) * 100) /
                Math.max(1, props.progress?.total ?? props.count),
            )}
          />
        </div>
      </Show>

      <Show when={stage() === "done"}>
        <Done rows={props.rows} target={props.target} summaryRef={(el) => (summary = el)} />
      </Show>

      <Show when={props.error}>
        {(message) => (
          <Notice
            title={stage() === "done" ? w.stoppedTitle : w.planFailedTitle}
            tone="problem"
            role="alert"
          >
            <p>{formatFiguresInText(message())}</p>
          </Notice>
        )}
      </Show>
      <Show when={props.uncertain}>
        <Notice title={w.uncertainTitle} tone="attention" role="status">
          <p>{w.uncertain}</p>
          <Show when={props.onResume}>
            <Button
              variant="secondary"
              label={w.resume}
              disabled={planning() && !props.uncertain}
              onClick={() => props.onResume?.()}
            />
          </Show>
        </Notice>
      </Show>
    </Dialog>
  );
}

/** What will happen to one transaction: it moves, or it stays and why. */
function Result(props: { row: MoveRow }): JSX.Element {
  const w = catchallWords.change.plan;
  return (
    <Show
      when={props.row.outcome === "would_apply"}
      fallback={
        <span>
          <strong>{w.notMoved}</strong>
          <Show when={props.row.why}>{(why) => <small>{formatFiguresInText(why())}</small>}</Show>
        </span>
      }
    >
      <strong>{w.willMove}</strong>
    </Show>
  );
}

/** What will happen to each transaction: where it is, where it goes, or why it stays. On a phone the account it
 * is on, the account it goes to and what happens to it sit under its description, so that nothing that decides
 * the move is off the edge of the screen; on a wider one they have columns of their own. */
function PlanTable(props: { rows: readonly MoveRow[] }): JSX.Element {
  const w = catchallWords.change.plan;
  return (
    <section class="rt-table-scroll rt-change-scroll" tabindex="0" aria-label={w.scroll}>
      <table class="rt-table rt-change-table">
        <caption class="rt-sr-only">{w.caption}</caption>
        <thead>
          <tr>
            <th scope="col">{w.columnDate}</th>
            <th scope="col">{w.columnDescription}</th>
            <th scope="col" class="rt-change-wide">
              {w.columnFrom}
            </th>
            <th scope="col" class="rt-change-wide">
              {w.columnTo}
            </th>
            <th scope="col" class="rt-number">
              {w.columnAmount}
            </th>
            <th scope="col" class="rt-change-wide">
              {w.columnResult}
            </th>
          </tr>
        </thead>
        <tbody>
          <For each={props.rows}>
            {(row) => (
              <tr data-outcome={row.outcome}>
                <td class="rt-change-date">
                  <Show when={row.date} fallback="—">
                    {(date) => <DateValue value={date()} />}
                  </Show>
                </td>
                <td class="rt-change-description">
                  <bdi dir="auto" title={row.description}>
                    {row.description || "—"}
                  </bdi>
                  <span class="rt-change-narrow">
                    <Show when={row.from}>
                      {(name) => (
                        <small>
                          <bdi>{name()}</bdi>
                          <Show when={row.to && row.outcome === "would_apply"}>
                            <span aria-hidden="true"> → </span>
                            <span class="rt-sr-only"> {w.columnTo} </span>
                            <bdi>{row.to}</bdi>
                          </Show>
                        </small>
                      )}
                    </Show>
                    <Result row={row} />
                  </span>
                </td>
                <td class="rt-change-wide">
                  <Show when={row.from} fallback="—">
                    {(name) => <bdi>{name()}</bdi>}
                  </Show>
                </td>
                <td class="rt-change-wide">
                  <Show when={row.to && row.outcome === "would_apply"} fallback="—">
                    <bdi>{row.to}</bdi>
                  </Show>
                </td>
                <td class="rt-number">
                  <Show when={row.amount} fallback="—">
                    {(amount) => <Money value={amount()} />}
                  </Show>
                </td>
                <td class="rt-change-result rt-change-wide">
                  <Result row={row} />
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </section>
  );
}

/** What was done: how many are on the new account, and each one that is not, with where it was left. */
function Done(props: {
  rows: readonly MoveRow[];
  target: string;
  summaryRef: (element: HTMLParagraphElement) => void;
}): JSX.Element {
  const w = catchallWords.change;
  const split = () => doneSplit(props.rows);
  return (
    <>
      <p ref={props.summaryRef} tabindex="-1" role="status" class="rt-change-summary">
        {split().moved.length > 0
          ? w.result.moved(split().moved.length, props.target)
          : w.result.movedNone}
      </p>
      <Show when={split().moved.length > 0}>
        <p class="rt-hint">{w.result.stays}</p>
      </Show>
      <Show when={split().notMoved.length > 0}>
        <Notice
          title={w.result.notMoved(split().notMoved.length)}
          tone={split().notMoved.some((row) => row.outcome === "failed") ? "attention" : "info"}
        >
          <section class="rt-change-left-scroll" tabindex="0" aria-label={w.result.notMovedList}>
            <ul class="rt-change-left">
              <For each={split().notMoved}>
                {(row) => (
                  <li>
                    <bdi dir="auto">{row.description || "—"}</bdi>
                    <Show when={row.why}>
                      {(why) => <small>{formatFiguresInText(why())}</small>}
                    </Show>
                    <Show when={leftWords(row.left)}>{(left) => <small>{left()}</small>}</Show>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Notice>
      </Show>
    </>
  );
}
