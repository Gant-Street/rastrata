import { For, Show } from "solid-js";
import { Check, TriangleAlert } from "../icons";
import { formatFiguresInText } from "../format";
import { Status } from "../notice";
import { Amount } from "../reports/amount";
import type { ChecklistItem } from "./types";
import { words } from "./words";

/** What the books and the rest of Rastrata can say about a year before it is closed. Every line has a
 * word for its state ("Ready", "Needs attention", "Could not be read", "Checking…"), never color or
 * an icon alone, and a line that could not be read is never shown as fine. None of it blocks the
 * close: the person decides. A line can link to where the thing is fixed. */
export function YearEndChecklist(props: { items: readonly ChecklistItem[] }) {
  return (
    <ul class="rt-cal-checklist" aria-label={words.checklist}>
      <For each={props.items}>
        {(item) => (
          <li data-state={item.state}>
            <div class="rt-cal-check-state">
              <Status
                tone={
                  item.state === "attention" || item.state === "unavailable" ? "review" : "neutral"
                }
              >
                <Show when={item.state === "ready"}>
                  <Check aria-hidden="true" />{" "}
                </Show>
                <Show when={item.state === "attention" || item.state === "unavailable"}>
                  <TriangleAlert aria-hidden="true" />{" "}
                </Show>
                {item.state === "ready"
                  ? words.ready
                  : item.state === "attention"
                    ? words.attention
                    : item.state === "unavailable"
                      ? words.unavailable
                      : words.checking}
              </Status>
            </div>
            <div class="rt-cal-check-body">
              <p class="rt-cal-check-label">{item.label}</p>
              <p class="rt-cal-check-detail">
                {formatFiguresInText(
                  item.state === "unavailable"
                    ? `${item.detail} ${words.unavailableNote}`
                    : item.detail,
                )}
              </p>
              <Show when={item.href}>
                {(href) => (
                  <p>
                    <a href={href()}>{item.hrefLabel ?? href()}</a>
                  </p>
                )}
              </Show>
            </div>
          </li>
        )}
      </For>
    </ul>
  );
}

/** The year's figures at its last day, as the books produced them. */
export function YearStatements(props: {
  statements: {
    readonly currency: string;
    readonly basis: "cash" | "accrual";
    readonly asOf: string;
    readonly revenue: string;
    readonly expenses: string;
    readonly netIncome: string;
    readonly assets: string;
    readonly liabilities: string;
    readonly equity: string;
    readonly priorEarnings: string;
    readonly reportHref: string;
  };
}) {
  const rows = () =>
    [
      [words.income, props.statements.revenue],
      [words.expenses, props.statements.expenses],
      [words.netIncome, props.statements.netIncome],
      [words.assets, props.statements.assets],
      [words.liabilities, props.statements.liabilities],
      [words.equity, props.statements.equity],
      [words.priorEarnings, props.statements.priorEarnings],
    ] as const;
  return (
    <section class="rt-cal-statements" aria-labelledby="rt-cal-statements-title">
      <h3 id="rt-cal-statements-title">{words.statements}</h3>
      <p class="rt-cal-note">
        {words.statementsLead(props.statements.basis, props.statements.asOf)}
      </p>
      <dl class="rt-cal-figures">
        <For each={rows()}>
          {([label, amount]) => (
            <div>
              <dt>{label}</dt>
              <dd>
                <Amount value={amount} />{" "}
                <span class="rt-cal-currency">{props.statements.currency}</span>
              </dd>
            </div>
          )}
        </For>
      </dl>
      <p>
        <a href={props.statements.reportHref}>{words.reviewStatements}</a>
      </p>
    </section>
  );
}
