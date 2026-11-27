import { type JSX, Show } from "solid-js";
import { Button } from "../button";
import { SelectField } from "../select-field";
import { formatDate, monthName } from "../format";
import { Notice } from "../notice";
import { settingsWords } from "./words";

/** What changing the fiscal year would do, read from the prepared plan. */
export interface YearStartReview {
  readonly firstDate: string;
  readonly lastDate: string;
  readonly years: number;
}

export type YearStartStage = "closed" | "choosing" | "preparing" | "review" | "committing";

const MONTHS = Array.from({ length: 12 }, (_, index) => ({
  value: String(index + 1),
  label: monthName(index + 1),
}));

/** The month fiscal years start in, with the way to change it while that is still possible: choose a
 * month, review what the calendar becomes, then change it. The block is shown only while the book has
 * no entry; afterwards the month is a plain fact in the list above. */
export function YearStartBlock(props: {
  month: number;
  stage: YearStartStage;
  chosen: number;
  review: YearStartReview | null;
  problem: string;
  /** A request is retained and must be resumed first. */
  blocked?: boolean;
  /** The month was just changed. */
  changed?: boolean;
  onOpen: () => void;
  onChoose: (month: number) => void;
  onReview: () => void;
  onCommit: () => void;
  onCancel: () => void;
}): JSX.Element {
  const w = settingsWords.business.yearStart;
  const busy = () => props.stage === "preparing" || props.stage === "committing";
  return (
    <section class="rt-settings-block" aria-labelledby="rt-year-start-title">
      <h2 id="rt-year-start-title">{w.title}</h2>
      <p>{w.intro(monthName(props.month))}</p>
      <Show when={props.changed && props.stage === "closed"}>
        <Notice title={w.done(monthName(props.month))} role="status" />
      </Show>
      <Show
        when={props.stage !== "closed"}
        fallback={
          <Button
            variant="secondary"
            label={w.change}
            disabled={props.blocked ?? false}
            onClick={props.onOpen}
          />
        }
      >
        <div class="rt-stack">
          <SelectField
            label={w.choose}
            value={String(props.chosen)}
            items={MONTHS}
            disabled={props.stage !== "choosing"}
            onChange={(value) => props.onChoose(Number(value))}
          />
          <Show when={props.review}>
            {(review) => (
              <Notice title={w.reviewTitle(monthName(props.chosen))}>
                {w.reviewBody(
                  formatDate(review().firstDate),
                  formatDate(review().lastDate),
                  review().years,
                )}
              </Notice>
            )}
          </Show>
          <Show when={props.problem}>
            <p role="alert" class="rt-error">
              {props.problem}
            </p>
          </Show>
          <div class="rt-year-start-actions">
            <Show
              when={props.stage === "review" || props.stage === "committing"}
              fallback={
                <Button
                  variant="primary"
                  label={w.review}
                  disabled={busy() || props.chosen === props.month}
                  onClick={props.onReview}
                />
              }
            >
              <Button
                variant="primary"
                label={w.commit}
                disabled={busy() || (props.blocked ?? false)}
                onClick={props.onCommit}
              />
            </Show>
            <Button variant="quiet" label={w.cancel} disabled={busy()} onClick={props.onCancel} />
          </div>
        </div>
      </Show>
    </section>
  );
}
