import { For, type JSX, Show } from "solid-js";
import { Button } from "../button";
import { formatCount, formatDate, formatFiguresInText, formatMoney } from "../format";
import { Notice } from "../notice";
import { Progress } from "../progress";
import { SelectField } from "../select-field";
import { HISTORY_ROLES, type HistoryPreviewView, type HistoryStage } from "./types";
import { historyWords as w } from "./words";

/** How many of a file's problems are listed; the rest are counted. */
const SHOWN_PROBLEMS = 8;

/** What a file of entries would do, and the way to do it: the years it covers, the book's account each of its
 * accounts is posted to (or added as), what is wrong with it and what stands in the way, then Import.
 * Nothing is posted until Import, and what is posted is exactly what is shown. */
export function HistoryReview(props: {
  preview: HistoryPreviewView;
  /** The book's accounts, to choose for an account of the file. */
  options: readonly { readonly value: string; readonly label: string }[];
  /** What was chosen for an account of the file, by the account as the file writes it: the code of one of
   * the book's accounts, or "+" and a kind to add it as. */
  choices: Readonly<Record<string, string>>;
  onChoose: (label: string, value: string) => void;
  /** How the dates are written, when the file does not say; absent when it does. */
  dateOrder?:
    | { readonly value: "mdy" | "dmy"; readonly onChange: (value: "mdy" | "dmy") => void }
    | undefined;
  stage: HistoryStage;
  progress: { readonly done: number; readonly total: number } | null;
  /** Why an import stopped, when it did. */
  stopped?: string | undefined;
  onImport: () => void;
}): JSX.Element {
  const busy = () => props.stage === "importing";
  const preview = () => props.preview;
  const choicesFor = (unchosen: boolean) => [
    ...(unchosen ? [{ value: "", label: w.notInBook }] : []),
    ...HISTORY_ROLES.map((role) => ({ value: `+${role}`, label: w.addAs[role] })),
    ...props.options,
  ];
  return (
    <div class="rt-stack rt-history">
      <Show when={preview().firstDate !== null && preview().lastDate !== null}>
        <p>
          {w.summary(
            formatCount(preview().entries),
            formatDate(preview().firstDate as string),
            formatDate(preview().lastDate as string),
          )}{" "}
          <Show when={preview().alreadyImported > 0}>
            {w.alreadyIn(formatCount(preview().alreadyImported))}
          </Show>
        </p>
      </Show>
      <Show when={props.dateOrder}>
        {(order) => (
          <div class="rt-history-order">
            <SelectField
              label={w.dateOrder}
              hint={w.dateOrderHint}
              value={order().value}
              items={[
                { value: "mdy", label: w.dateOrders.mdy },
                { value: "dmy", label: w.dateOrders.dmy },
              ]}
              disabled={busy()}
              onChange={(value) => order().onChange(value === "dmy" ? "dmy" : "mdy")}
            />
          </div>
        )}
      </Show>

      <Show when={preview().years.length > 0}>
        <section aria-labelledby="rt-history-years">
          <h2 id="rt-history-years">{w.years}</h2>
          <section class="rt-table-scroll" tabindex="0" aria-label={w.years}>
            <table class="rt-table">
              <thead>
                <tr>
                  <th scope="col">{w.year}</th>
                  <th scope="col" class="rt-number">
                    {w.entries}
                  </th>
                  <th scope="col" class="rt-number">
                    {w.debits}
                  </th>
                </tr>
              </thead>
              <tbody>
                <For each={preview().years}>
                  {(year) => (
                    <tr>
                      <th scope="row">{year.fiscalYear}</th>
                      <td class="rt-number">{formatCount(year.entries)}</td>
                      <td class="rt-number">{formatMoney(year.total)}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </section>
        </section>
      </Show>

      <Show when={preview().accounts.length > 0}>
        <section aria-labelledby="rt-history-accounts">
          <h2 id="rt-history-accounts">{w.accounts}</h2>
          <p class="rt-hint">{w.accountsHint}</p>
          <section class="rt-table-scroll rt-history-accounts" tabindex="0" aria-label={w.accounts}>
            <table class="rt-table">
              <thead>
                <tr>
                  <th scope="col">{w.fileAccount}</th>
                  <th scope="col" class="rt-number">
                    {w.uses}
                  </th>
                  <th scope="col">{w.postedTo}</th>
                </tr>
              </thead>
              <tbody>
                <For each={preview().accounts}>
                  {(row) => {
                    const value = () =>
                      props.choices[row.label] ??
                      (row.add !== null ? `+${row.add}` : (row.account ?? ""));
                    return (
                      <tr>
                        <th scope="row">{row.label}</th>
                        <td class="rt-number">{formatCount(row.lines)}</td>
                        <td>
                          <SelectField
                            class="rt-row-select"
                            label={`${w.postedTo} ${row.label}`}
                            hideLabel
                            value={value()}
                            items={choicesFor(value() === "")}
                            disabled={busy()}
                            onChange={(choice) => props.onChoose(row.label, choice)}
                          />
                        </td>
                      </tr>
                    );
                  }}
                </For>
              </tbody>
            </table>
          </section>
        </section>
      </Show>

      <Show when={preview().problemCount > 0}>
        <section aria-labelledby="rt-history-problems">
          <h2 id="rt-history-problems">{w.problems}</h2>
          <ul>
            <For each={preview().problems.slice(0, SHOWN_PROBLEMS)}>
              {(item) => <li>{w.problem(item.row, formatFiguresInText(item.message))}</li>}
            </For>
          </ul>
          <Show when={preview().problemCount > SHOWN_PROBLEMS}>
            <p class="rt-hint">{w.moreProblems(preview().problemCount - SHOWN_PROBLEMS)}</p>
          </Show>
          <p class="rt-hint">{w.fixFile}</p>
        </section>
      </Show>

      <Show when={preview().conflicts.length > 0}>
        <section aria-labelledby="rt-history-conflicts">
          <h2 id="rt-history-conflicts">{w.conflicts}</h2>
          <For each={preview().conflicts}>
            {(text) => <Notice title={formatFiguresInText(text)} tone="attention" />}
          </For>
        </section>
      </Show>

      <Show when={props.stopped}>
        <Notice title={props.stopped as string} tone="problem" role="alert" />
      </Show>
      <Show when={busy() && props.progress}>
        {(progress) => (
          <Progress
            label={w.importing(formatCount(progress().done), formatCount(progress().total))}
            value={
              progress().total === 0 ? null : Math.round((progress().done / progress().total) * 100)
            }
          />
        )}
      </Show>
      <Show when={!preview().ready && preview().unmapped > 0 && preview().problemCount === 0}>
        <p class="rt-hint">
          {w.stillToChoose(preview().unmapped, formatCount(preview().unmapped))}
        </p>
      </Show>
      <Show
        when={preview().remaining > 0}
        fallback={
          <Show when={preview().ready}>
            <p class="rt-hint">{w.nothingToDo}</p>
          </Show>
        }
      >
        <div>
          <Button
            variant="primary"
            label={
              preview().alreadyImported > 0
                ? w.importAgain(formatCount(preview().remaining))
                : w.import(formatCount(preview().remaining))
            }
            disabled={!preview().ready || busy()}
            onClick={props.onImport}
          />
        </div>
      </Show>
    </div>
  );
}
