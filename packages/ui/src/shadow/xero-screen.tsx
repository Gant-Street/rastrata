import {
  createEffect,
  createSignal,
  createUniqueId,
  For,
  on,
  onMount,
  Show,
  type JSX,
} from "solid-js";
import { PageSkeleton } from "../skeleton";
import { Button } from "../button";
import { buttonAttrs } from "../button";
import { formatDate } from "../format";
import { Steps, type StepItem } from "../kit/steps";
import { Notice } from "../notice";
import { ChartStep } from "./xero-chart-step";
import { ReconciledStep } from "./xero-reconciled-step";
import { TransactionsStep } from "./xero-at-step";
import { TrialBalanceStep } from "./xero-tb-step";
import type { XeroScreenProps, XeroStatusView } from "./xero-types";
import { NoBook } from "./no-book";
import { xeroWords as words } from "./xero-words";
import { PageHeader } from "../page-header";

type StepId = "chart" | "trialBalance" | "transactions" | "reconciled";

/** The four files, as steps: which are done, and what came of each in a few words. */
function stepsOf(status: XeroStatusView | null | undefined): StepItem[] {
  const chartIn = status?.chartImportedAt != null;
  const reconciled = status?.reconciled ?? [];
  return [
    {
      id: "chart",
      title: words.chartTitle,
      done: chartIn,
      said: chartIn
        ? words.saidChart(
            status?.counts.accounts ?? 0,
            status?.counts.unmapped ?? 0,
            status?.counts.unmappedWithBalance ?? 0,
          )
        : undefined,
    },
    {
      id: "trialBalance",
      title: words.tbTitle,
      done: (status?.trialBalances.length ?? 0) > 0,
      said: status?.trialBalances.map((date) => formatDate(date)).join(", "),
    },
    {
      id: "transactions",
      title: words.atTitle,
      done: (status?.transactions.length ?? 0) > 0,
      said: status?.transactions
        .map((range) => words.statusRange(range.from, range.to, range.lines))
        .join("; "),
    },
    {
      id: "reconciled",
      title: words.reconciledTitle,
      done: reconciled.length > 0,
      said:
        reconciled.length > 0
          ? words.saidReconciled(
              reconciled.length,
              formatDate(
                reconciled
                  .map((entry) => entry.through)
                  .sort()
                  .at(-1) as string,
              ),
            )
          : undefined,
    },
  ];
}

/** The step to do next: the chart while an account that holds a balance still has no place (one with nothing in
 * it can stay unmatched: nothing waits for it), then the first file that is not in. */
function nextStep(status: XeroStatusView | null | undefined): StepId | null {
  if (!status || status.chartImportedAt === null || status.counts.unmappedWithBalance > 0)
    return "chart";
  if (status.trialBalances.length === 0) return "trialBalance";
  if (status.transactions.length === 0) return "transactions";
  if (status.reconciled.length === 0) return "reconciled";
  return null;
}

/** Import from Xero: read its exports, match its chart to the book's, and keep what the comparison
 * needs. Nothing here writes to Xero or needs its login. Every file is read and shown before
 * anything is kept, and a lost reply is resumed, never repeated. A controlled view. */
export function XeroScreen(props: XeroScreenProps): JSX.Element {
  const uid = createUniqueId();
  let heading: HTMLHeadingElement | undefined;
  onMount(() => {
    if (props.focusTitle) heading?.focus();
  });
  const steps = () => stepsOf(props.status);
  // The open step is the next one to do until the person opens another; when a step is finished the next one
  // opens by itself.
  const [chosen, setChosen] = createSignal<string | null | undefined>(undefined);
  const next = () => nextStep(props.status);
  createEffect(on(next, () => setChosen(undefined), { defer: true }));
  const open = () => (chosen() === undefined ? next() : (chosen() as string | null));
  // A file chosen for a step opens that step: what was read from it is what the person looks at next.
  const files = (): [StepId, string | null | undefined][] => [
    ["chart", props.chart.fileName],
    ["trialBalance", props.trialBalance.fileName],
    ["transactions", props.transactions.fileName],
  ];
  for (const index of [0, 1, 2])
    createEffect(
      on(
        () => files()[index]?.[1],
        (name) => {
          if (name) setChosen(files()[index]?.[0] as StepId);
        },
        { defer: true },
      ),
    );
  return (
    <section class="rt-shadow-screen" aria-labelledby={`${uid}-title`}>
      <PageHeader
        titleId={`${uid}-title`}
        titleRef={(element) => {
          heading = element;
        }}
        title={words.importTitle}
        description={words.importLine}
      />

      <Show when={props.noBook}>
        <NoBook />
      </Show>
      <Show when={!props.noBook && props.state === "loading"}>
        <PageSkeleton shape="table" label={words.loading} />
      </Show>
      <Show when={!props.noBook && props.state === "error"}>
        <Notice title={words.importLoadFailed} tone="error" role="alert">
          <Show when={props.onRetry}>
            <Button variant="secondary" label={words.retry} onClick={() => props.onRetry?.()} />
          </Show>
        </Notice>
      </Show>

      <Show when={!props.noBook && props.state === "ready"}>
        <Show when={props.error}>
          <Notice title={words.requestFailed} tone="error" role="alert">
            {props.error}
          </Notice>
        </Show>
        <Show when={props.uncertain}>
          {(uncertain) => (
            <Notice title={words.uncertainTitle} tone="review" role="alert">
              <p>{words.uncertainBody}</p>
              <Button
                label={words.resume}
                pendingLabel={words.resuming}
                pending={uncertain().resuming}
                onClick={() => props.onResume?.()}
              />
            </Notice>
          )}
        </Show>
        <Steps
          label={words.stepsLabel}
          steps={steps()}
          open={open()}
          onOpen={setChosen}
          changeLabel={words.change}
        >
          {(id) =>
            id === "chart" ? (
              <ChartStep step={props.chart} />
            ) : id === "trialBalance" ? (
              <TrialBalanceStep step={props.trialBalance} />
            ) : id === "transactions" ? (
              <TransactionsStep step={props.transactions} />
            ) : (
              <ReconciledStep step={props.reconciled} />
            )
          }
        </Steps>
        {/* What the service notes about what is in: with nothing in yet the steps already say so. */}
        <Show when={props.status?.chartImportedAt != null && (props.status?.notes.length ?? 0) > 0}>
          <ul class="rt-shadow-notes-list" data-facts>
            <For each={props.status?.notes ?? []}>
              {(note) => (
                <li>
                  <bdi>{note}</bdi>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <p class="rt-xero-next">
          <a
            {...(next() === null ? buttonAttrs({ variant: "primary" }) : {})}
            href={props.links.tieout}
          >
            {words.compareNow}
          </a>
        </p>
      </Show>
    </section>
  );
}
