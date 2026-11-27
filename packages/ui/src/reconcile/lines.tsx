import { createEffect, createMemo, createSignal, createUniqueId, For, Show } from "solid-js";
import { RowCheck } from "../row-check";
import { PageSkeleton } from "../skeleton";
import { words } from "./words";
import type { ReconcileLine } from "./types";
import { formatDate, formatMoney, formatMoneyAbsolute } from "../format";
import { DateValue } from "../date-value";

/** One column of lines (money out, or money in) with a checkbox on each. It is a list you drive
 * from the keyboard: one tab stop for the whole column, then j and k or the arrow keys to move,
 * space or x to tick, shift with an arrow to tick a run, and shift-click for a range. The component
 * holds no selection and does no arithmetic: the parent owns both and passes exact strings. */
export function ReconcileLines(props: {
  title: string;
  /** What the column holds, for names and empty states: "money out". */
  noun: string;
  /** The lines to show (already narrowed by any search). */
  lines: readonly ReconcileLine[];
  /** How many lines the column has before a search narrowed it. */
  totalCount: number;
  selected: ReadonlySet<string>;
  /** How many of the column's lines are selected, and their exact total, supplied by the parent. */
  selectedCount: number;
  selectedTotal: string;
  disabled?: boolean;
  state?: "ready" | "loading" | "error";
  onToggle: (ids: readonly string[], on: boolean) => void;
}) {
  const uid = createUniqueId();
  const headingId = `${uid}-heading`;
  const [current, setCurrent] = createSignal(0);
  let anchor = 0;
  let shiftHeld = false;
  let body: HTMLTableSectionElement | undefined;

  const visibleSelected = createMemo(
    () => props.lines.filter((line) => props.selected.has(line.id)).length,
  );
  const allSelected = () => props.lines.length > 0 && visibleSelected() === props.lines.length;
  // If a search or a refresh shortens the list, keep the single tab stop on a row that exists.
  createEffect(() => {
    if (current() >= props.lines.length) setCurrent(Math.max(0, props.lines.length - 1));
  });

  const rowInput = (index: number) =>
    body?.querySelector<HTMLInputElement>(`input[data-index="${index}"]`) ?? null;
  const focusRow = (index: number) => {
    const target = Math.min(Math.max(index, 0), props.lines.length - 1);
    setCurrent(target);
    queueMicrotask(() => rowInput(target)?.focus());
    return target;
  };

  const toggleRange = (from: number, to: number, on: boolean) => {
    const [start, end] = from <= to ? [from, to] : [to, from];
    props.onToggle(
      props.lines.slice(start, end + 1).map((line) => line.id),
      on,
    );
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== "checkbox") return;
    if (event.ctrlKey || event.metaKey || event.altKey || props.disabled) return;
    const at = Number(input.dataset.index);
    const key = event.key;
    const down = key === "ArrowDown" || key === "j" || key === "J";
    const up = key === "ArrowUp" || key === "k" || key === "K";
    if (down || up) {
      event.preventDefault();
      const next = Math.min(Math.max(at + (down ? 1 : -1), 0), props.lines.length - 1);
      // Shift carries the current line's state along, so holding it ticks (or unticks) a run.
      if (event.shiftKey && next !== at) toggleRange(next, next, input.checked);
      focusRow(next);
    } else if (key === "Home" || key === "End") {
      event.preventDefault();
      focusRow(key === "Home" ? 0 : props.lines.length - 1);
    } else if (key === "PageDown" || key === "PageUp") {
      event.preventDefault();
      focusRow(at + (key === "PageDown" ? 10 : -10));
    } else if (key === "x" || key === "X") {
      event.preventDefault();
      toggleRange(at, at, !input.checked);
      anchor = at;
    }
  };

  return (
    <section class="rt-recon-column" aria-labelledby={headingId}>
      <header class="rt-recon-column-head">
        <h2 id={headingId}>{props.title}</h2>
        <span class="rt-recon-column-count">
          {words.columnCount(props.selectedCount, props.totalCount)}
          <Show when={props.totalCount > 0}>
            {" · "}
            <span class="rt-recon-amount">{formatMoney(props.selectedTotal)}</span>
          </Show>
        </span>
      </header>
      <Show
        when={props.state !== "loading" && props.state !== "error"}
        fallback={
          <Show
            when={props.state === "error"}
            fallback={<PageSkeleton shape="table" label={words.columnLoading} />}
          >
            <p class="rt-recon-state" role="alert">
              {words.columnFailed}
            </p>
          </Show>
        }
      >
        <Show
          when={props.lines.length > 0}
          fallback={
            <p class="rt-recon-state">
              {props.totalCount > 0 ? words.noMatches(props.noun) : words.empty(props.noun)}
            </p>
          }
        >
          <div class="rt-table-scroll rt-recon-scroll">
            <table class="rt-table rt-recon-table">
              <caption class="rt-sr-only">
                {words.tableCaption(props.title, props.lines.length)}
              </caption>
              <thead>
                <tr>
                  <th scope="col" class="rt-recon-check">
                    <RowCheck
                      label={words.selectAll(props.noun)}
                      checked={
                        allSelected() ? true : visibleSelected() > 0 ? "indeterminate" : false
                      }
                      disabled={props.disabled}
                      input={{ class: "rt-recon-checkbox" }}
                      onChange={(checked) =>
                        props.onToggle(
                          props.lines.map((line) => line.id),
                          checked,
                        )
                      }
                    />
                  </th>
                  <th scope="col">{words.date}</th>
                  <th scope="col">{words.description}</th>
                  <th scope="col" class="amount">
                    {words.amount}
                  </th>
                </tr>
              </thead>
              <tbody
                ref={(element) => {
                  body = element;
                }}
                onKeyDown={onKeyDown}
                onFocusIn={(event) => {
                  const index = Number((event.target as HTMLElement).dataset.index);
                  if (!Number.isNaN(index)) setCurrent(index);
                }}
              >
                <For each={props.lines}>
                  {(line, index) => {
                    const inputId = `${uid}-${index()}`;
                    return (
                      <tr classList={{ "rt-recon-selected": props.selected.has(line.id) }}>
                        <td class="rt-recon-check">
                          <RowCheck
                            id={inputId}
                            label={`${formatDate(line.date)}, ${line.description}, ${formatMoneyAbsolute(line.amount)}`}
                            checked={props.selected.has(line.id)}
                            disabled={props.disabled}
                            input={{
                              class: "rt-recon-checkbox",
                              "data-index": index(),
                              tabindex: index() === current() ? 0 : -1,
                            }}
                            onPress={(shiftKey) => {
                              shiftHeld = shiftKey;
                            }}
                            onChange={(on) => {
                              if (shiftHeld && anchor !== index()) toggleRange(anchor, index(), on);
                              else props.onToggle([line.id], on);
                              anchor = index();
                              shiftHeld = false;
                            }}
                          />
                        </td>
                        <td class="rt-recon-date">
                          <DateValue value={line.date} />
                        </td>
                        <td class="rt-recon-description">
                          <label for={inputId}>
                            <bdi>{line.description}</bdi>
                          </label>
                          <Show when={line.href}>
                            {(href) => (
                              <a class="rt-recon-entry-link" href={href()}>
                                {words.viewEntry}
                                <span class="rt-sr-only"> {line.description}</span>
                              </a>
                            )}
                          </Show>
                        </td>
                        <td class="amount rt-recon-amount">{formatMoneyAbsolute(line.amount)}</td>
                      </tr>
                    );
                  }}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </Show>
    </section>
  );
}
