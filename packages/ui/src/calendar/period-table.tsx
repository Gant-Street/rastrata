import { For, Show, type JSX } from "solid-js";
import { Button } from "../button";
import { LockKeyhole } from "../icons";
import { Status } from "../notice";
import type { PeriodView } from "./types";
import { words } from "./words";
import { formatDateRange } from "../format";

/** The id of a period's action button, so a screen can return focus to it when a review closes. */
export const periodActionId = (periodId: string): string => `rt-cal-act-${periodId}`;
const actionId = periodActionId;

/** The periods of one fiscal year as one table: the period and its dates, whether it is open or
 * locked (and when its close no longer matches the books), what the close recorded, and the one
 * action that fits. Dates and labels are data and are isolated with `<bdi>`. The table scrolls inside
 * its own region on a narrow screen. The buttons say which period they act on in their own text, so
 * they are unambiguous when read out of context. */
export function PeriodTable(props: {
  fiscalYear: number;
  periods: readonly PeriodView[];
  /** Disables every action: a write is under way or retained. */
  blocked?: boolean;
  onClose: (period: PeriodView) => void;
  onReopen: (period: PeriodView) => void;
  empty?: JSX.Element;
}) {
  return (
    <Show when={props.periods.length > 0} fallback={props.empty ?? <p>{words.noPeriods}</p>}>
      <section
        class="rt-table-scroll rt-cal-scroll"
        tabindex="0"
        aria-label={`${words.periodsOf(props.fiscalYear)}, scroll horizontally on narrow screens`}
      >
        <table class="rt-table rt-cal-table">
          <caption class="rt-sr-only">{words.periodsOf(props.fiscalYear)}</caption>
          <thead>
            <tr>
              <th scope="col">{words.period}</th>
              <th scope="col">{words.state}</th>
              <th scope="col">{words.closing}</th>
              <th scope="col">
                <span class="rt-sr-only">{words.action}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <For each={props.periods}>
              {(period) => (
                <tr
                  data-status={period.status}
                  data-superseded={period.closeSuperseded || undefined}
                >
                  <th scope="row">
                    <bdi>{period.label}</bdi>
                    <small>
                      <bdi>{formatDateRange(period.startsOn, period.endsOn)}</bdi>
                    </small>
                  </th>
                  <td>
                    <Show
                      when={period.status === "closed"}
                      fallback={
                        <>
                          <Status>{words.open}</Status>
                          <small>
                            {period.beforeBooks
                              ? words.beforeBooks
                              : period.ended
                                ? words.ended
                                : words.notEnded}
                          </small>
                        </>
                      }
                    >
                      <Status tone={period.closeSuperseded ? "review" : "neutral"}>
                        <LockKeyhole aria-hidden="true" />{" "}
                        {period.closeSuperseded ? words.superseded : words.closed}
                      </Status>
                    </Show>
                  </td>
                  <td class="rt-cal-closing">
                    <Show
                      when={period.status === "closed"}
                      fallback={<span aria-hidden="true">—</span>}
                    >
                      <Show
                        when={!period.closeSuperseded}
                        fallback={<span class="rt-cal-note">{words.supersededNote}</span>}
                      >
                        <Show when={period.closingReportHref}>
                          {(href) => <a href={href()}>{words.closingReport}</a>}
                        </Show>
                      </Show>
                    </Show>
                  </td>
                  <td class="rt-cal-action">
                    <Show
                      when={period.status === "open"}
                      fallback={
                        <Button
                          id={actionId(period.id)}
                          label={words.reopenShort}
                          aria-label={words.reviewReopen(period.label)}
                          variant="secondary"
                          size="sm"
                          disabled={props.blocked ?? false}
                          onClick={() => props.onReopen(period)}
                        />
                      }
                    >
                      <Button
                        id={actionId(period.id)}
                        label={words.closeShort}
                        aria-label={words.reviewClose(period.label)}
                        variant="secondary"
                        size="sm"
                        disabled={props.blocked ?? false}
                        onClick={() => props.onClose(period)}
                      />
                    </Show>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </section>
    </Show>
  );
}
