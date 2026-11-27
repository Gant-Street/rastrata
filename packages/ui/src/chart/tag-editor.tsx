import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { PageSkeleton } from "../skeleton";
import { Button } from "../button";
import { ErrorSummary } from "../error-summary";
import { Notice } from "../notice";
import { DateField } from "../date-field";
import { TextField } from "../text-field";
import {
  isBalanceSheetType,
  isRealDate,
  reachedPeriods,
  ROLE_KEY_MAX,
  ROLE_KEY_PATTERN,
  taxLineOptions,
} from "./chart-logic";
import type {
  AccountView,
  CashFlowClass,
  ChartProblem,
  ClosedPeriod,
  TagChange,
  TagEvent,
  TagResult,
  TaxFormChoice,
} from "./chart-types";
import { type ChartMessageOverrides, mergeChartMessages } from "./messages";
import { SelectField } from "../select-field";
import { formatDate, formatDateRange } from "../format";
import { DateValue } from "../date-value";

const CLASSES: readonly CashFlowClass[] = [
  "cash",
  "operating",
  "investing",
  "financing",
  "noncash",
];

export interface TagEditorProps {
  account: AccountView;
  /** The forms whose lines an income or cost account may use, for the tax year being shown. */
  taxForms: readonly TaxFormChoice[];
  /** The words shown for a tax line id; see AccountsTable. */
  taxLineText: (id: string) => string | undefined;
  /** The date offered first: today. */
  today: string;
  closedPeriods: readonly ClosedPeriod[];
  /** Every recorded change to this account's tags, oldest first; null while it loads. */
  history: readonly TagEvent[] | null;
  saving?: boolean;
  /** Why the last save was refused or failed. */
  error?: string;
  /** What the service said about the last save. */
  result?: TagResult | null;
  /** The reply to a save was lost: the original request must be resumed before another is made. */
  uncertain?: boolean;
  onSave: (change: TagChange) => void;
  onResume: () => void;
  onClose: () => void;
  messages?: ChartMessageOverrides;
}

/**
 * Edit the tags of one account from a date. Tags are versioned by effective date: a change from a
 * date supersedes the earlier value from then on and earlier dates keep what they had, so the form
 * says which reports will change and warns, before saving, when the date reaches into a closed
 * period. Only the tag that applies to the account's type is offered (cash-flow class for
 * balance-sheet accounts, a tax line for income and costs), plus the role key.
 */
export function TagEditor(props: TagEditorProps): JSX.Element {
  const m = createMemo(() => mergeChartMessages(props.messages).tagEditor);
  const balanceSheet = () => isBalanceSheetType(props.account.role);
  const [effectiveOn, setEffectiveOn] = createSignal(
    props.today < props.account.openedOn ? props.account.openedOn : props.today,
  );
  const [flow, setFlow] = createSignal(props.account.tags.cashFlowClass ?? "");
  const [taxLine, setTaxLine] = createSignal(props.account.tags.taxLine ?? "");
  const [roleKey, setRoleKey] = createSignal(props.account.tags.roleKey ?? "");
  const [problems, setProblems] = createSignal<ChartProblem[]>([]);
  const [attempt, setAttempt] = createSignal(0);

  const options = createMemo(() => taxLineOptions(props.taxForms, props.account.role));
  const known = () => options().some((option) => option.value === props.account.tags.taxLine);
  const flowChoices = () =>
    props.account.role === "asset" ? CLASSES : CLASSES.filter((item) => item !== "cash");
  const reached = createMemo(() => reachedPeriods(props.closedPeriods, effectiveOn()));
  const form = () => props.taxForms[0];

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    if (props.saving || props.uncertain) return;
    const found: ChartProblem[] = [];
    const date = effectiveOn().trim();
    if (!isRealDate(date) || date < "2000-01-01" || date > "2100-12-31")
      found.push({ id: "tag-effective-on", message: m().dateInvalid });
    else if (date < props.account.openedOn)
      found.push({ id: "tag-effective-on", message: m().dateBeforeOpened(props.account.openedOn) });
    const key = roleKey().trim();
    if (key !== "" && (key.length > ROLE_KEY_MAX || !ROLE_KEY_PATTERN.test(key)))
      found.push({ id: "tag-role-key", message: m().roleKeyInvalid(ROLE_KEY_MAX) });
    setProblems(found);
    if (found.length > 0) {
      setAttempt((value) => value + 1);
      return;
    }
    props.onSave({
      effectiveOn: date,
      tags: {
        ...(balanceSheet()
          ? { cashFlowClass: flow() === "" ? null : (flow() as CashFlowClass) }
          : { taxLine: taxLine() === "" ? null : taxLine() }),
        roleKey: key === "" ? null : key,
      },
    });
  }

  const eventText = (event: TagEvent): string => {
    const name = m().tagNames[event.tag] ?? event.tag;
    if (event.value === null) return m().eventCleared(name);
    const value =
      event.tag === "taxLine"
        ? (props.taxLineText(event.value) ?? event.value)
        : event.tag === "cashFlowClass"
          ? (m().classes[event.value] ?? event.value)
          : event.value;
    return m().eventSet(name, value);
  };

  return (
    <form class="rt-tag-editor" onSubmit={submit} noValidate>
      <p class="rt-tag-editor-account">
        <bdi>{props.account.code}</bdi> · <bdi>{props.account.name}</bdi>
        <span class="rt-hint"> · {m().types[props.account.role] ?? props.account.role}</span>
      </p>
      <Show when={problems().length > 0}>
        <ErrorSummary errors={problems()} attempt={attempt()} />
      </Show>
      <Show when={props.uncertain}>
        <Notice title={m().uncertainTitle} tone="review" role="status">
          <p>{m().uncertain}</p>
          <Button variant="secondary" label={m().resume} onClick={() => props.onResume()} />
        </Notice>
      </Show>
      <Show when={props.error}>
        <Notice title={m().errorTitle} tone="error" role="alert">
          {props.error}
        </Notice>
      </Show>
      <Show when={props.result}>
        {(result) => (
          <Notice title={result().changed ? m().savedTitle : m().unchangedTitle} role="status">
            <p>
              {result().changed
                ? m().saved(result().effectiveOn)
                : m().unchanged(result().effectiveOn)}
            </p>
            <For each={result().warnings}>{(warning) => <p>{warning}</p>}</For>
          </Notice>
        )}
      </Show>
      <div class="rt-stack">
        <DateField
          label={m().effectiveOn}
          id="tag-effective-on"
          required
          min={props.account.openedOn}
          max="2100-12-31"
          hint={m().effectiveOnHint}
          error={problems().find((item) => item.id === "tag-effective-on")?.message ?? ""}
          value={effectiveOn()}
          disabled={props.saving === true}
          onChange={(value) => setEffectiveOn(value)}
        />
        <div class="rt-tag-editor-quick">
          <Button
            variant="secondary"
            size="sm"
            label={m().fromOpening(props.account.openedOn)}
            disabled={props.saving === true}
            onClick={() => setEffectiveOn(props.account.openedOn)}
          />
          <Button
            variant="secondary"
            size="sm"
            label={m().fromToday}
            disabled={props.saving === true}
            onClick={() =>
              setEffectiveOn(
                props.today < props.account.openedOn ? props.account.openedOn : props.today,
              )
            }
          />
        </div>
        <Show when={reached().length > 0}>
          <Notice title={m().closedTitle(reached().length)} tone="review" role="status">
            <p>
              {m().closedBody(
                reached().map(
                  (period) =>
                    `${period.label} (${formatDateRange(period.startsOn, period.endsOn)})`,
                ),
              )}
            </p>
          </Notice>
        </Show>
        <Show
          when={balanceSheet()}
          fallback={
            <SelectField
              label={m().taxLine}
              id="tag-tax-line"
              hint={form() ? m().taxLineHint : m().noForms}
              value={taxLine()}
              disabled={props.saving === true}
              items={[
                { value: "", label: m().noTaxLine },
                ...(taxLine() !== "" && !options().some((option) => option.value === taxLine())
                  ? [{ value: taxLine(), label: taxLine() }]
                  : []),
                ...options().map((option) => ({
                  value: option.value,
                  label: `${option.label}`,
                })),
              ]}
              onChange={setTaxLine}
            />
          }
        >
          <SelectField
            label={m().cashFlow}
            id="tag-cash-flow"
            hint={m().cashFlowHint}
            value={flow()}
            disabled={props.saving === true}
            items={[
              { value: "", label: m().notSet },
              ...flowChoices().map((item) => ({ value: item, label: m().classes[item] ?? item })),
            ]}
            onChange={setFlow}
          />
        </Show>
        <TextField
          label={m().roleKey}
          id="tag-role-key"
          autocomplete="off"
          spellcheck={false}
          maxLength={60}
          hint={m().roleKeyHint}
          error={problems().find((item) => item.id === "tag-role-key")?.message ?? ""}
          value={roleKey()}
          disabled={props.saving === true}
          onInput={(event) => setRoleKey(event.currentTarget.value)}
        />
        <Show when={!known() && props.account.tags.taxLine && !balanceSheet()}>
          <p class="rt-hint">{m().unknownLine(props.account.tags.taxLine ?? "")}</p>
        </Show>
      </div>
      <div class="rt-tag-editor-actions">
        <Button
          type="submit"
          label={m().save}
          pending={props.saving === true}
          pendingLabel={m().saving}
          disabled={props.uncertain === true}
        />
        <Button variant="secondary" label={m().close} onClick={() => props.onClose()} />
      </div>
      <section class="rt-tag-history" aria-labelledby="tag-history-title">
        <h3 id="tag-history-title">{m().historyTitle}</h3>
        <Show
          when={props.history !== null}
          fallback={<PageSkeleton shape="table" label={m().historyLoading} />}
        >
          <Show
            when={(props.history ?? []).length > 0}
            fallback={<p class="rt-hint">{m().historyEmpty}</p>}
          >
            <ol>
              <For each={props.history}>
                {(event) => (
                  <li class="rt-tag-event">
                    <DateValue value={event.effectiveOn} /> · {eventText(event)}
                    <small class="rt-chart-note">
                      {event.source === "setup"
                        ? m().eventSetup
                        : m().eventRecorded(formatDate(event.recordedAt))}
                    </small>
                  </li>
                )}
              </For>
            </ol>
          </Show>
        </Show>
      </section>
    </form>
  );
}
