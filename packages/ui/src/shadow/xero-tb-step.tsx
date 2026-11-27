import { createUniqueId, For, Show, type JSX } from "solid-js";
import { CheckField } from "../accounting-controls";
import { Button } from "../button";
import { formatDate } from "../format";
import { Money } from "../money";
import { Notice, Status } from "../notice";
import { IssueList } from "./issues";
import { SelectField } from "../select-field";
import type { DateOrder, TbStepView } from "./xero-types";
import { ColumnsRead, FileChoice, SkipUnreadable } from "./xero-file";
import { xeroWords as words } from "./xero-words";

const ORDERS: readonly { value: DateOrder; label: string }[] = [
  { value: "mdy", label: words.tbOrderMdy },
  { value: "dmy", label: words.tbOrderDmy },
];

/** Step two: a Xero trial balance. Read as at its date, each account's balance is shown the way the
 * book reads it, with what was left out and why. It can be kept for the comparison, and, when it is
 * as at the day before the cutover, taken to the opening balances screen. Xero's bank balances are
 * Xero's books, not the statements: the opening balances screen is where each is replaced. */
export function TrialBalanceStep(props: { step: TbStepView }): JSX.Element {
  const uid = createUniqueId();
  const step = () => props.step;
  return (
    <section class="rt-shadow-step" aria-labelledby={`${uid}-title`}>
      <h2 id={`${uid}-title`}>{words.tbTitle}</h2>
      <p class="rt-hint">{words.tbIntro}</p>
      <FileChoice step={step()} label={words.tbKind} />
      <div class="rt-xero-options">
        <SelectField
          label={words.tbOrder}
          hint={words.tbOrderHint}
          value={step().dateOrder}
          items={ORDERS}
          onChange={(value) => step().onDateOrder(value as DateOrder)}
        />
        <CheckField
          label={words.tbIncludePl}
          hint={words.tbIncludePlHint}
          checked={step().includeProfitLoss}
          onChange={(checked) => step().onIncludeProfitLoss(checked)}
        />
      </div>
      <Show when={step().preview}>
        {(preview) => (
          <>
            <p>
              <Show when={preview().asOf}>
                {(date) => <>{words.tbAsOf(formatDate(date()))} </>}
              </Show>
              {preview().balanced ? words.tbBalanced : ""}
            </p>
            <Show when={!preview().balanced}>
              <Notice title={words.tbNotBalanced} tone="error" role="alert" />
            </Show>
            <Show when={preview().cutoverNote}>
              <Notice
                title={preview().cutoverNote ?? ""}
                tone={preview().asOfIsDayBefore ? "info" : "review"}
              />
            </Show>
            <ColumnsRead columns={preview().columns} />
            <IssueList issues={preview().issues} />
            <section class="rt-table-scroll" tabindex="0" aria-label={words.tbCaption}>
              <table class="rt-table rt-xero-table">
                <caption class="rt-sr-only">{words.tbCaption}</caption>
                <thead>
                  <tr>
                    <th scope="col">{words.colTbAccount}</th>
                    <th scope="col" class="rt-number">
                      {words.colTbNet}
                    </th>
                    <th scope="col">{words.colTbStatus}</th>
                    <th scope="col">{words.colTbMapsTo}</th>
                    <th scope="col" class="rt-number">
                      {words.colTbBalance}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <For each={preview().rows}>
                    {(row) => (
                      <tr data-status={row.status}>
                        <th scope="row">
                          <bdi>
                            {row.xeroCode ? `${row.xeroCode} ` : ""}
                            {row.name}
                          </bdi>
                        </th>
                        <td class="rt-number">
                          <Money value={row.net} />
                        </td>
                        <td>
                          <Status tone={row.status === "unmapped" ? "review" : "neutral"}>
                            {words.status[row.status]}
                          </Status>
                        </td>
                        <td>
                          <bdi>{row.mapsTo ?? "—"}</bdi>
                        </td>
                        <td class="rt-number">
                          <Show when={row.balance !== null} fallback={"—"}>
                            <Money value={row.balance as string} />
                          </Show>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </section>
            <Show
              when={
                preview().leftOut.profitLoss +
                  preview().leftOut.unmapped +
                  preview().leftOut.skipped >
                  0 || preview().leftOut.retainedEarnings !== "0.00"
              }
            >
              <div class="rt-xero-leftout">
                <h3>{words.leftOutHeading}</h3>
                <ul class="rt-shadow-notes-list">
                  <Show when={preview().leftOut.profitLoss > 0}>
                    <li>{words.leftOutProfitLoss(preview().leftOut.profitLoss)}</li>
                  </Show>
                  <Show when={preview().leftOut.unmapped > 0}>
                    <li>{words.leftOutUnmapped(preview().leftOut.unmapped)}</li>
                  </Show>
                  <Show when={preview().leftOut.skipped > 0}>
                    <li>{words.leftOutSkipped(preview().leftOut.skipped)}</li>
                  </Show>
                  <Show when={preview().leftOut.retainedEarnings !== "0.00"}>
                    <li>
                      {words.leftOutRetained} <Money value={preview().leftOut.retainedEarnings} />
                    </li>
                  </Show>
                </ul>
                <p class="rt-hint">{words.leftOutNote}</p>
              </div>
            </Show>
            <SkipUnreadable keep={step().keep} />
            <Show when={step().keep.error}>
              <Notice title={words.requestFailed} tone="error" role="alert">
                {step().keep.error}
              </Notice>
            </Show>
            <div class="rt-shadow-actions">
              <Button
                label={words.keepForComparison}
                pendingLabel={words.keepingFile}
                pending={step().keep.pending}
                disabled={!step().keep.canKeep}
                onClick={() => step().keep.onKeep()}
              />
              <Button
                variant="secondary"
                label={words.useAsOpening}
                disabled={!step().canUseAsOpening}
                onClick={() => step().onUseAsOpening()}
              />
            </div>
            <p class="rt-hint">{words.useAsOpeningHint}</p>
            <p role="status" class="rt-xero-status">
              {step().keep.message ?? ""}
            </p>
          </>
        )}
      </Show>
    </section>
  );
}
