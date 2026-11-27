import { For, Match, Show, Switch } from "solid-js";
import { Button } from "../button";
import { formatCount } from "../format";
import { Details } from "../kit";
import { percentOfCounts } from "./format";
import type { RulesFigureData, RulesLoadState } from "./types";
import { words } from "./words";

/** What there is to say about the figure: nothing at all on a book with no transactions to measure
 * (nothing waiting in For review, nothing posted in the window), so the page is the list alone. */
const nothingToMeasure = (data: RulesFigureData | null | undefined): boolean =>
  data?.window !== null && data?.window !== undefined && data.window.considered === 0;

/** The one line that says whether the rules are earning their keep: how many of the transactions waiting in
 * For review and posted lately a rule decides. It is a measurement of what the rules would suggest, never of
 * what has been recorded, and it says which transactions it counted. While it is being measured it says so,
 * and when the measure failed it says that, never a stale number. On a book with nothing to measure it is
 * not shown. */
export function RulesDecided(props: {
  state: RulesLoadState;
  data?: RulesFigureData | null | undefined;
  onRetry?: (() => void) | undefined;
}) {
  const shown = () =>
    props.state === "error"
      ? "error"
      : props.state !== "ready" || !props.data
        ? "loading"
        : props.data.window === null
          ? "unmeasured"
          : nothingToMeasure(props.data)
            ? "nothing"
            : "ready";
  const measured = () => props.data?.window ?? null;
  const percent = () => {
    const current = measured();
    return current ? percentOfCounts(current.decided, current.considered) : null;
  };
  return (
    <Show when={shown() !== "nothing"}>
      <section class="rt-rules-decided" aria-label={words.figureLabel} data-facts>
        <Switch>
          <Match when={shown() === "error"}>
            <div role="alert" class="rt-rules-figure-state">
              <p>{words.figureFailed}</p>
              <Show when={props.onRetry}>
                <Button
                  variant="secondary"
                  size="sm"
                  label={words.retry}
                  onClick={() => props.onRetry?.()}
                />
              </Show>
            </div>
          </Match>
          <Match when={shown() === "loading"}>
            <p role="status">{words.figureLoading}</p>
          </Match>
          <Match when={shown() === "unmeasured"}>
            <p aria-live="polite" aria-atomic="true">
              {words.figureFailed}
            </p>
          </Match>
          <Match when={shown() === "ready" && percent() !== null && measured()}>
            {(current) => (
              <p aria-live="polite" aria-atomic="true">
                <strong>{percent()}%</strong>{" "}
                {words.decidedLine(current().decided, current().considered, current().days)}
              </p>
            )}
          </Match>
        </Switch>
      </section>
    </Show>
  );
}

/** The facts behind that line, in a disclosure under the list: how many rules there are and how many are on,
 * what was counted, what needs attention, and the one caveat. Not shown where the line is not. */
export function RulesFacts(props: { data?: RulesFigureData | null | undefined }) {
  return (
    <Show when={props.data && !nothingToMeasure(props.data) ? props.data : null}>
      {(data) => {
        const measured = () => data().window;
        return (
          <Details summary={words.rulesDisclosure}>
            <dl class="rt-rules-figures">
              <div>
                <dt>{words.figureRulesLabel}</dt>
                <dd>{words.figureRules(data().rules, data().enabled)}</dd>
              </div>
              <Show when={measured()}>
                {(current) => (
                  <>
                    <div>
                      <dt>{words.figureInboxLabel}</dt>
                      <dd>{formatCount(current().inbox)}</dd>
                    </div>
                    <div>
                      <dt>{words.figureHistoryLabel(current().days)}</dt>
                      <dd>{formatCount(current().history)}</dd>
                    </div>
                  </>
                )}
              </Show>
              <div>
                <dt>{words.figureAttentionLabel}</dt>
                <dd>{data().attention === 0 ? words.figureAttentionNone : data().attention}</dd>
              </div>
            </dl>
            <p class="rt-rules-caveat">{words.figureCaveat}</p>
            <Show when={data().notes.length > 0}>
              <ul class="rt-rules-notes">
                <For each={data().notes}>{(note) => <li>{note}</li>}</For>
              </ul>
            </Show>
          </Details>
        );
      }}
    </Show>
  );
}
