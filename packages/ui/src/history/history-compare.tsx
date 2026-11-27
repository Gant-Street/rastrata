import { For, type JSX, Show } from "solid-js";
import { Button, buttonAttrs } from "../button";
import { formatCount, formatDate, formatFiguresInText, formatMoney } from "../format";
import { Details } from "../kit";
import { Notice } from "../notice";
import type { ButtonLinkProps } from "../settings/button-link";
import { ImportFileDrop } from "../statements/file-drop";
import { DateField } from "../date-field";
import type { TieOutView } from "./types";
import { historyWords } from "./words";

const w = historyWords.compare;
const ZERO = "0.00";

/** The proof that history came in whole: the old system's trial balance for a day, set against the book's
 * balance of every account on that day. A year that ties can be closed; a year that does not names the
 * accounts that differ, by how much. */
export function HistoryCompare(props: {
  fileName?: string | undefined;
  fileSize?: number | undefined;
  state: "idle" | "reading" | "uploading" | "error";
  uploadError?: string | undefined;
  onFile: (file: File) => void;
  date: string;
  onDate: (date: string) => void;
  /** Why the comparison could not be made, when it could not. */
  problem?: string | undefined;
  busy: boolean;
  /** Whether a file is chosen and a date is given: what Compare waits for. */
  ready: boolean;
  onCompare: () => void;
  result: TieOutView | null;
  /** Draws a link the way the application navigates (through its router). */
  link?: (props: ButtonLinkProps) => JSX.Element;
}): JSX.Element {
  const closeAttrs = buttonAttrs({ variant: "primary" });
  return (
    // One click away: the page is bringing the history in, and this is the check made afterwards. It
    // stays open once a file is chosen or a result is shown.
    <Details summary={w.title} defaultOpen={props.fileName !== undefined || props.result !== null}>
      <div class="rt-stack rt-history-compare">
        <ImportFileDrop
          state={props.state}
          fileName={props.fileName}
          fileSize={props.fileSize}
          error={props.uploadError}
          disabled={props.busy}
          copy={w.drop}
          onFile={props.onFile}
        />
        <div class="rt-history-compare-date">
          <DateField
            label={w.date}
            value={props.date}
            disabled={props.busy}
            onChange={(value) => props.onDate(value)}
          />
        </div>
        <Show when={props.problem}>
          <Notice title={props.problem as string} tone="problem" role="alert" />
        </Show>
        <div>
          <Button
            variant="secondary"
            label={props.busy ? w.comparing : w.action}
            disabled={!props.ready || props.busy}
            onClick={props.onCompare}
          />
        </div>

        <Show when={props.result}>
          {(result) => (
            <div class="rt-stack rt-history-compare-result" role="status">
              <Show
                when={result().problemCount === 0}
                fallback={
                  <div>
                    <h3>{w.problems}</h3>
                    <ul>
                      <For each={result().problems}>
                        {(item) => (
                          <li>{`Row ${item.row}: ${formatFiguresInText(item.message)}`}</li>
                        )}
                      </For>
                    </ul>
                  </div>
                }
              >
                <Show
                  when={result().tied}
                  fallback={
                    <Notice
                      title={w.differ(result().differing, formatCount(result().differing))}
                      tone="attention"
                    />
                  }
                >
                  <Notice title={w.tied(formatDate(result().asOf))} tone="calm">
                    <p>
                      {w.compared(result().accounts.length, formatCount(result().accounts.length))}
                    </p>
                    <p class="rt-history-compare-next">
                      {props.link ? (
                        props.link({ ...closeAttrs, href: "/periods", children: w.next })
                      ) : (
                        <a {...closeAttrs} href="/periods">
                          {w.next}
                        </a>
                      )}
                    </p>
                  </Notice>
                </Show>
                <Show when={!result().tied && result().accounts.length > 0}>
                  <section class="rt-table-scroll" tabindex="0" aria-label={w.differTable}>
                    <table class="rt-table">
                      <thead>
                        <tr>
                          <th scope="col">{w.account}</th>
                          <th scope="col" class="rt-number">
                            {w.oldBooks}
                          </th>
                          <th scope="col" class="rt-number">
                            {w.yourBooks}
                          </th>
                          <th scope="col" class="rt-number">
                            {w.gap}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={result().accounts.filter((row) => row.difference !== ZERO)}>
                          {(row) => (
                            <tr>
                              <th scope="row">
                                {row.name} <span class="rt-account-code">{row.account}</span>
                              </th>
                              <td class="rt-number" data-heading={w.oldBooks}>
                                {formatMoney(row.file)}
                              </td>
                              <td class="rt-number" data-heading={w.yourBooks}>
                                {formatMoney(row.book)}
                              </td>
                              <td class="rt-number" data-heading={w.gap}>
                                {formatMoney(row.difference)}
                              </td>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </section>
                </Show>
                <Show when={result().unmapped.length > 0}>
                  <div>
                    <h3>{w.notInBooks}</h3>
                    <ul>
                      <For each={result().unmapped}>
                        {(label) => <li>{formatFiguresInText(label)}</li>}
                      </For>
                    </ul>
                  </div>
                </Show>
              </Show>
            </div>
          )}
        </Show>
      </div>
    </Details>
  );
}
