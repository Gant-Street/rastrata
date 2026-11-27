import { createUniqueId, For, Index, Show, type Accessor, type JSX } from "solid-js";
import { CheckField } from "../accounting-controls";
import { Button } from "../button";
import { Money } from "../money";
import { Notice, Status } from "../notice";
import { IssueList } from "./issues";
import { SelectField } from "../select-field";
import type { ChartStepView, MappingChoiceView, XeroAccountView } from "./xero-types";
import { ColumnsRead, FileChoice, SkipUnreadable } from "./xero-file";
import { xeroWords as words } from "./xero-words";
import { Details } from "../kit/details";

type GroupKey = "decide" | "likely" | "certain" | "left";
const GROUP_KEYS: readonly GroupKey[] = ["decide", "likely", "certain", "left"];

/** Which group a row belongs to. It depends on what the file and the saved mapping say, never on
 * what the person has chosen in this sitting, so a row does not move while it is being decided. */
function groupOf(row: XeroAccountView): GroupKey {
  if (row.skip) return "left";
  if (row.confidence === "check" || row.confidence === "none") return "decide";
  return row.confidence === "likely" ? "likely" : "certain";
}

const GROUP_NAMES: Readonly<Record<GroupKey, string>> = {
  decide: words.groupDecide,
  likely: words.groupLikely,
  certain: words.groupCertain,
  left: words.groupLeftOut,
};

function ConfidenceTag(props: { row: XeroAccountView }): JSX.Element {
  return (
    <>
      <Status
        tone={
          props.row.confidence === "check" || props.row.confidence === "none" ? "review" : "neutral"
        }
      >
        {words.confidence[props.row.confidence]}
      </Status>
      <small>{words.basis[props.row.basis]}</small>
    </>
  );
}

function AccountRow(props: {
  row: Accessor<XeroAccountView>;
  choices: readonly MappingChoiceView[];
  onChoose: (value: string) => void;
}): JSX.Element {
  const row = props.row;
  const options = () => {
    const possible = new Set(row().candidates.map((candidate) => candidate.value));
    return [
      {
        value: "",
        label: row().mapsTo
          ? `${row().mapsTo} (${words.confidence[row().confidence].toLowerCase()})`
          : words.autoChoice,
      },
      { value: "skip", label: words.skipChoice },
      ...row().candidates.map((candidate) => ({
        value: candidate.value,
        label: words.possibleChoice(candidate.label),
      })),
      ...props.choices.filter((choice) => !possible.has(choice.value)),
    ];
  };
  return (
    <tr>
      <th scope="row">
        <bdi>{row().code}</bdi>
      </th>
      <td>
        <bdi>{row().name}</bdi>
        <small>
          <bdi>{row().type}</bdi>
          <Show when={row().tags.length > 0}>
            {" · "}
            <For each={row().tags}>
              {(tag, index) => (
                <>
                  {index() > 0 ? ", " : ""}
                  {tag === "archived"
                    ? words.archivedTag
                    : tag === "system"
                      ? words.systemTag
                      : words.bankTag}
                </>
              )}
            </For>
          </Show>
        </small>
        <Show when={row().balance !== null}>
          <small>
            <Money value={row().balance as string} />
          </small>
        </Show>
        <Show when={row().suggestion}>
          <small>
            <bdi>{row().suggestion}</bdi>
          </small>
        </Show>
        <For each={row().problems}>
          {(problem) => (
            <small>
              <bdi>{problem}</bdi>
            </small>
          )}
        </For>
      </td>
      <td>
        <SelectField
          class="rt-row-select"
          label={words.chooseFor(row().code)}
          hideLabel
          value={row().value}
          items={options()}
          onChange={props.onChoose}
        />
      </td>
      <td>
        <ConfidenceTag row={row()} />
        <Show when={row().value !== ""}>
          <small>{words.decidedTag}</small>
        </Show>
      </td>
    </tr>
  );
}

/** Step one: Xero's chart of accounts, matched to the book's. The file is read and every account is
 * shown with how sure the match is; what needs a decision comes first. Nothing is kept until the
 * person chooses to keep the mapping. */
export function ChartStep(props: { step: ChartStepView }): JSX.Element {
  const uid = createUniqueId();
  const step = () => props.step;
  return (
    <section class="rt-shadow-step" aria-labelledby={`${uid}-title`}>
      <h2 id={`${uid}-title`}>{words.chartTitle}</h2>
      <FileChoice step={step()} label={words.chartKind} />
      <p class="rt-hint">{words.chartIntro}</p>
      <Show when={step().preview}>
        {(preview) => (
          <>
            <p>
              {words.chartCounts(
                preview().counts.accounts,
                preview().counts.certain,
                preview().counts.likely,
                preview().counts.check,
              )}
            </p>
            <ColumnsRead columns={preview().columns} />
            <IssueList issues={preview().issues} />
            <For each={GROUP_KEYS}>
              {(key) => {
                // The row objects are made again whenever a choice changes; the group and its rows
                // stay where they are, so a choice keeps the focus and an open group stays open.
                const rows = () => preview().rows.filter((row) => groupOf(row) === key);
                const decided = () => rows().filter((row) => row.value !== "").length;
                // Open at first where the person has work to do: the decisions, or, when there
                // are none, the likely matches. What they open or close afterwards is theirs.
                const open =
                  key === "decide" ||
                  (key === "likely" && preview().rows.every((row) => groupOf(row) !== "decide"));
                return (
                  <Show when={rows().length > 0}>
                    <Details
                      flush
                      defaultOpen={open}
                      summary={words.groupSummary(GROUP_NAMES[key], rows().length, decided())}
                    >
                      <section class="rt-table-scroll" tabindex="0" aria-label={GROUP_NAMES[key]}>
                        <table class="rt-table rt-xero-table">
                          <caption class="rt-sr-only">{GROUP_NAMES[key]}</caption>
                          <thead>
                            <tr>
                              <th scope="col">{words.colXeroCode}</th>
                              <th scope="col">{words.colXeroName}</th>
                              <th scope="col">{words.colMapsTo}</th>
                              <th scope="col">{words.colHow}</th>
                            </tr>
                          </thead>
                          <tbody>
                            <Index each={rows()}>
                              {(row) => (
                                <AccountRow
                                  row={row}
                                  choices={step().choices}
                                  onChoose={(value) => step().onChoose(row().code, value)}
                                />
                              )}
                            </Index>
                          </tbody>
                        </table>
                      </section>
                    </Details>
                  </Show>
                );
              }}
            </For>
            <Show when={preview().source === "file"}>
              <CheckField
                label={words.acceptLikely}
                checked={step().acceptLikely}
                onChange={(checked) => step().onAcceptLikely(checked)}
              />
              <SkipUnreadable keep={step().keep} />
            </Show>
            <Show when={step().keep.error}>
              <Notice title={words.requestFailed} tone="error" role="alert">
                {step().keep.error}
              </Notice>
            </Show>
            <div class="rt-shadow-actions">
              <Button
                label={words.keepMapping}
                pendingLabel={words.keepingMapping}
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
