import { createUniqueId, For, Show, type JSX } from "solid-js";
import { Button } from "../button";
import { formatCount, formatDate } from "../format";
import { Money } from "../money";
import { Notice, Status } from "../notice";
import { IssueList } from "./issues";
import { SelectField } from "../select-field";
import type { AtBlockView, AtStepView, DateOrder } from "./xero-types";
import { ColumnsRead, FileChoice, SkipUnreadable } from "./xero-file";
import { xeroWords as words } from "./xero-words";
import { Details } from "../kit/details";

const ORDERS: readonly { value: DateOrder; label: string }[] = [
  { value: "mdy", label: words.tbOrderMdy },
  { value: "dmy", label: words.tbOrderDmy },
];

const DASH = "—";

function Block(props: { block: AtBlockView }): JSX.Element {
  const block = () => props.block;
  return (
    <Details flush summary={<bdi>{block().heading}</bdi>}>
      <p class="rt-hint">
        <Status tone={block().status === "unmapped" ? "review" : "neutral"}>
          {words.status[block().status]}
        </Status>{" "}
        <bdi>{block().mapsTo ?? DASH}</bdi>
      </p>
      <p>
        {formatCount(block().lines)} · <Money value={block().debit} /> /{" "}
        <Money value={block().credit} />
        <Show when={block().agrees !== null}>
          {" · "}
          {block().agrees ? words.atTotalsAgree : words.atTotalsDiffer}
        </Show>
      </p>
      <Show when={block().sample.length > 0}>
        <section
          class="rt-table-scroll"
          tabindex="0"
          aria-label={`${words.atSample}: ${block().heading}`}
        >
          <table class="rt-table rt-xero-table">
            <caption class="rt-sr-only">{`${words.atSample}: ${block().heading}`}</caption>
            <thead>
              <tr>
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
              <For each={block().sample}>
                {(line) => (
                  <tr>
                    <td>{formatDate(line.date)}</td>
                    <td>
                      <bdi>{line.description}</bdi>
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
      </Show>
    </Details>
  );
}

/** Step three: a month of Xero's account transactions. Every account's block is read and its lines
 * are added up against the total Xero printed, so a lost row shows before anything is kept. */
export function TransactionsStep(props: { step: AtStepView }): JSX.Element {
  const uid = createUniqueId();
  const step = () => props.step;
  return (
    <section class="rt-shadow-step" aria-labelledby={`${uid}-title`}>
      <h2 id={`${uid}-title`}>{words.atTitle}</h2>
      <p class="rt-hint">{words.atIntro}</p>
      <FileChoice step={step()} label={words.atKind} />
      <div class="rt-xero-options">
        <SelectField
          label={words.tbOrder}
          hint={words.tbOrderHint}
          value={step().dateOrder}
          items={ORDERS}
          onChange={(value) => step().onDateOrder(value as DateOrder)}
        />
      </div>
      <Show when={step().preview}>
        {(preview) => (
          <>
            <p>
              <Show when={preview().periodFrom && preview().periodTo}>
                {words.atPeriod(preview().periodFrom as string, preview().periodTo as string)}{" "}
              </Show>
              {words.atBlocksNote(preview().blocks.length, preview().lineCount)}
            </p>
            <ColumnsRead columns={preview().columns} />
            <IssueList issues={preview().issues} />
            <For each={preview().blocks}>{(block) => <Block block={block} />}</For>
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
            </div>
            <p role="status" class="rt-xero-status">
              {step().keep.message ?? ""}
            </p>
          </>
        )}
      </Show>
    </section>
  );
}
