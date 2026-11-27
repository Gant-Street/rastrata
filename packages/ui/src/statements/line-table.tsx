import { createSignal, createUniqueId, For, Show } from "solid-js";
import { SelectField } from "../select-field";
import { Button } from "../button";
import { Pager } from "../pager";
import { Status } from "../notice";
import { safeText } from "./format";
import type { LinePreview, SampleFilter } from "./types";
import { words } from "./words";
import { formatMoney, isNegativeMoney } from "../format";
import { DateValue } from "../date-value";

const FILTERS: readonly { value: SampleFilter; label: string }[] = [
  { value: "all", label: words.showAll_ },
  { value: "new", label: words.showNew },
  { value: "duplicate", label: words.showDuplicate },
  { value: "overlap", label: words.showOverlap },
  { value: "excluded", label: words.showExcluded },
  { value: "problems", label: words.showProblems },
];

const FLAG_WORDS: Readonly<Record<string, string>> = {
  formula: words.flagFormula,
  control: words.flagControl,
  direction: words.flagDirection,
  markup: words.flagMarkup,
  link: words.flagLink,
  instruction: words.flagInstruction,
  line_break: words.flagLineBreak,
};

/** What a line is, when it is not simply new: the normal state has no word. */
const STATUS_WORDS: Readonly<Record<LinePreview["status"], string>> = {
  new: "",
  duplicate: words.statusDuplicate,
  overlap: words.statusOverlap,
  excluded: words.statusExcluded,
  invalid: words.statusInvalid,
};

/** The lines the file holds: the first few, to compare with the statement at a glance, and all of them
 * (a page at a time, with a choice of which to show) once asked for. A line says what would become of it
 * only when that is not the usual thing (already imported, kept out, refused); the row of the file is
 * shown when a problem names one. Money is right-aligned in tabular figures with its sign as text; a line
 * whose text looks like a formula, markup or an instruction says so next to it. The text itself is plain
 * text, never markup. */
const FIRST = 6;
export function ImportLineTable(props: {
  lines: readonly LinePreview[];
  count: number;
  page: number;
  pageSize: number;
  filter: SampleFilter;
  /** Show which row of the file each line is: a problem named one. */
  rows?: boolean | undefined;
  /** A page is being fetched; what is shown may be about to change. */
  loading?: boolean | undefined;
  onFilter: (filter: SampleFilter) => void;
  onPage: (page: number) => void;
}) {
  const id = createUniqueId();
  const pages = () => Math.max(1, Math.ceil(props.count / props.pageSize));
  // All of them are listed once asked for, and from the start when the list is narrowed or turned.
  const [all, setAll] = createSignal(false);
  const whole = () => all() || props.filter !== "all" || props.page > 1;
  const lines = () => (whole() ? props.lines : props.lines.slice(0, FIRST));
  // A line says what it is when the lines differ: a file that was wholly imported before is said so
  // once, by the page's sentence, and not again on every line.
  const states = () =>
    lines().some((line) => line.status !== "new") &&
    !lines().every((line) => line.status === "duplicate" || line.status === "overlap");
  return (
    <section
      class="rt-imp-sample"
      aria-labelledby={`${id}-title`}
      aria-busy={props.loading ? true : undefined}
    >
      <div class="rt-imp-sample-head">
        <h2 id={`${id}-title`} class="rt-sr-only">
          {words.sample}
        </h2>
        <Show when={whole()}>
          <SelectField
            class="rt-imp-filter"
            label={words.show}
            items={FILTERS}
            value={props.filter}
            onChange={(value) => props.onFilter(value as SampleFilter)}
          />
        </Show>
      </div>
      <Show
        when={props.lines.length > 0}
        fallback={
          <Show when={props.filter !== "all"}>
            <p class="rt-hint" role="status">
              {words.noLinesFilter}
            </p>
          </Show>
        }
      >
        <section class="rt-table-scroll rt-imp-scroll" tabindex={0} aria-label={words.sampleScroll}>
          <table class="rt-table rt-imp-table">
            <caption class="rt-sr-only">{`${words.sample}, page ${props.page} of ${pages()}`}</caption>
            <thead>
              <tr>
                <Show when={props.rows}>
                  <th scope="col">{words.columnRow}</th>
                </Show>
                <th scope="col">{words.columnDate}</th>
                <th scope="col">{words.columnDescription}</th>
                <th scope="col" class="amount">
                  {words.columnAmount}
                </th>
                <Show when={states()}>
                  <th scope="col">{words.columnStatus}</th>
                </Show>
              </tr>
            </thead>
            <tbody>
              <For each={lines()}>
                {(line) => (
                  <tr data-status={line.status}>
                    <Show when={props.rows}>
                      <td class="rt-imp-row">{line.row}</td>
                    </Show>
                    <td class="rt-imp-date">
                      <DateValue value={line.postedOn} />
                    </td>
                    <td class="rt-imp-text">
                      <span class="rt-imp-description">{safeText(line.description)}</span>
                      <Show when={line.reference || line.counterparty}>
                        <small>
                          {safeText(
                            [line.counterparty, line.reference ? `Ref ${line.reference}` : ""]
                              .filter(Boolean)
                              .join(" · "),
                          )}
                        </small>
                      </Show>
                      <Show when={line.flags.length > 0}>
                        <span class="rt-imp-flags">
                          <For each={line.flags}>
                            {(flag) => <Status tone="review">{FLAG_WORDS[flag] ?? flag}</Status>}
                          </For>
                        </span>
                      </Show>
                    </td>
                    <td
                      class="amount rt-imp-money"
                      data-negative={isNegativeMoney(line.amount) ? "" : undefined}
                    >
                      {formatMoney(line.amount)}
                    </td>
                    <Show when={states()}>
                      <td>
                        <Show when={line.status !== "new"}>
                          <Status tone={line.status === "invalid" ? "error" : "neutral"}>
                            {STATUS_WORDS[line.status]}
                          </Status>
                        </Show>
                        <Show when={line.status === "invalid" && line.reason}>
                          <small class="rt-imp-reason">{safeText(line.reason ?? "")}</small>
                        </Show>
                      </td>
                    </Show>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </section>
        <Show when={!whole() && props.count > FIRST}>
          <p class="rt-imp-rest">
            <span data-facts>{words.moreLines(props.count - FIRST)}</span>{" "}
            <Button
              label={words.showLines(props.count)}
              variant="quiet"
              size="sm"
              aria-expanded={false}
              onClick={() => setAll(true)}
            />
          </p>
        </Show>
        <Show when={whole() && props.count > props.pageSize}>
          <Pager
            count={props.count}
            page={props.page}
            pageSize={props.pageSize}
            onPageChange={props.onPage}
          />
        </Show>
      </Show>
    </section>
  );
}
