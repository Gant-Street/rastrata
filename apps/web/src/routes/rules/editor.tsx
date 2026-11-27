import type { RuleRecord } from "@rastrata/application/client-contracts";
import { parseMoney } from "@rastrata/application/money";
import {
  blankRuleDraft,
  Button,
  Notice,
  PageHeader,
  PageSkeleton,
  RuleDeleteDialog,
  type RuleDraft,
  RuleForm,
  RuleHistory,
  RulePreview,
  type RulePreviewData,
  type RuleRevisionRow,
  rulesWords as words,
  RuleTryLine,
  type RuleTryResult,
} from "@rastrata/ui";
import { useParams } from "@tanstack/solid-router";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { BrowserApplicationClient } from "../../application-client";
import type { ChartView } from "./chart.ts";
import {
  draftOf,
  errorsOf,
  firstNarration,
  inputOf,
  isStructural,
  previewOf,
  problemsOf,
  revisionsOf,
  splitPreview,
  summaryOf,
  tryOf,
} from "./draft.ts";
import { createLoader } from "../../loader.ts";
import { codeOf, isUncertain, loadChart, messageOf, retained } from "./retained.ts";

const DAY_CHOICES = [30, 90, 180, 365] as const;
const PAUSE = 350;

type Banner = { title: string; tone: "info" | "review"; paragraphs: readonly string[] };
type Start = {
  draft: RuleDraft;
  revision: number | null;
  status: "active" | "deleted";
  history: RuleRevisionRow[];
  banner?: Banner;
};

/** What the editor starts from: the stored rule when editing; a draft made from an Inbox line when
 * it was opened with `?item=`; otherwise a blank rule. A line that cannot be read, or cannot be
 * generalised, starts a blank rule and says so. Nothing is saved by starting. */
async function begin(
  client: BrowserApplicationClient,
  ruleId: string | undefined,
  itemId: string | null,
): Promise<Start> {
  if (ruleId) {
    const detail = await client.read("rules.get", { ruleId });
    return {
      draft: draftOf(detail.rule),
      revision: detail.rule.revision,
      status: detail.rule.status,
      history: revisionsOf(detail.history),
      ...(detail.rule.status === "deleted"
        ? {
            banner: {
              title: words.deletedTitle,
              tone: "review" as const,
              paragraphs: [words.deletedBody],
            },
          }
        : {}),
    };
  }
  const blank = { draft: blankRuleDraft(), revision: null, status: "active" as const, history: [] };
  if (!itemId) return blank;
  try {
    const found = await client.read("inbox.get", { itemId });
    const line = found.item.line;
    const bank = found.item.ledgerAccountId;
    // A line that has already been categorized tells which account to book to.
    const booked = (found.item.decision?.legs ?? []).filter((leg) => leg.accountId !== bank);
    const [only] = booked;
    const suggestion = await client.read("rules.suggest", {
      description: line.description,
      amount: line.amount,
      ...(line.counterparty ? { counterparty: line.counterparty } : {}),
      ...(bank ? { accountId: bank } : {}),
      ...(booked.length === 1 && only ? { categoryAccountId: only.accountId } : {}),
    });
    return {
      ...blank,
      draft: suggestion.rule ? draftOf(suggestion.rule) : blank.draft,
      banner: {
        title: words.fromItemTitle,
        tone: "info",
        paragraphs: [words.fromItemBody(line.description), ...suggestion.notes],
      },
    };
  } catch {
    return {
      ...blank,
      banner: {
        title: words.fromItemFailedTitle,
        tone: "review",
        paragraphs: [words.fromItemFailed],
      },
    };
  }
}

export function NewRulePage() {
  return <Editor />;
}

export function EditRulePage() {
  // The router's types know only the core routes; this lane's path carries one parameter.
  const params = useParams({ strict: false }) as () => { ruleId?: string };
  return (
    <Show when={params().ruleId} keyed>
      {(ruleId) => <Editor ruleId={ruleId} />}
    </Show>
  );
}

function Editor(props: { ruleId?: string }) {
  const client = new BrowserApplicationClient(window.localStorage);
  const itemId = new URLSearchParams(window.location.search).get("item");
  const chart = createLoader(() => loadChart(client));
  const start = createLoader(() => begin(client, props.ruleId, itemId));
  // The page has a title whatever state it is in: while it opens, when it could not be opened, and
  // once the form is there (which has its own).
  const title = () => (props.ruleId ? words.editorEditTitle : words.editorNewTitle);
  return (
    <section class="rt-rules-page">
      <Show
        when={!chart.error() && !start.error()}
        fallback={
          <>
            <PageHeader title={title()} />
            <Notice
              title={start.error() ? words.ruleFailedTitle : words.listFailedTitle}
              tone="error"
              role="alert"
            >
              <p>{start.error() ? words.ruleFailedBody : words.listFailedBody}</p>
              <Button
                variant="secondary"
                label={words.retry}
                onClick={() => {
                  void chart.reload();
                  void start.reload();
                }}
              />{" "}
              <a href="/rules">{words.backToRules}</a>
            </Notice>
          </>
        }
      >
        <Show
          when={chart.value() && start.value()}
          fallback={
            <>
              <PageHeader title={title()} />
              <PageSkeleton shape="form" label={words.loadingRule} />
            </>
          }
        >
          <Show when={start.value()} keyed>
            {(initial) => (
              <EditorForm
                client={client}
                chart={chart.value() as ChartView}
                start={initial}
                ruleId={props.ruleId}
                onReload={() => void start.reload()}
              />
            )}
          </Show>
        </Show>
      </Show>
    </section>
  );
}

function EditorForm(props: {
  client: BrowserApplicationClient;
  chart: ChartView;
  start: Start;
  ruleId: string | undefined;
  onReload: () => void;
}) {
  const client = props.client;
  const chart = props.chart;
  const [draft, setDraft] = createSignal(props.start.draft);
  const [attempted, setAttempted] = createSignal(false);
  const [attempt, setAttempt] = createSignal(0);
  const [saving, setSaving] = createSignal(false);
  const [failure, setFailure] = createSignal<{ conflict: boolean; message: string } | null>(null);
  const [days, setDays] = createSignal<number>(90);
  const [splitAmount, setSplitAmount] = createSignal("120.00");
  const [tryValues, setTryValues] = createSignal({
    description: "",
    counterparty: "",
    amount: "",
    accountId: "",
  });
  const [tryResult, setTryResult] = createSignal<RuleTryResult | null>(null);
  const [tryProblem, setTryProblem] = createSignal<string | undefined>();
  const [tryErrors, setTryErrors] = createSignal<{ description?: string; amount?: string }>({});
  const [trying, setTrying] = createSignal(false);
  const [confirming, setConfirming] = createSignal(false);
  const [deleting, setDeleting] = createSignal(false);
  const [deleteError, setDeleteError] = createSignal<string | undefined>();
  const workflow = props.ruleId ? `rules:update:${props.ruleId}` : "rules:create";
  const change = retained(client, workflow);
  const removal = retained(client, `rules:delete:${props.ruleId ?? ""}`);
  const retired = props.start.status === "deleted";
  let page: HTMLDivElement | undefined;

  onMount(() => {
    change.sync();
    if (props.ruleId) removal.sync();
    page?.querySelector<HTMLElement>("h1")?.focus();
  });

  // ---- What is wrong, and what is shown of it ------------------------------------------------------

  const problems = createMemo(() => problemsOf(draft(), chart));
  // Problems appear once a save has been tried, and then follow the draft as it is fixed.
  const shown = createMemo(() => (attempted() ? problems() : []));
  const errors = createMemo(() => errorsOf(shown()));
  const summary = createMemo(() => summaryOf(shown()));
  // A split part with no account yet cannot be sent: the service wants an account on every part.
  const unsendable = createMemo(
    () => draft().action.kind === "split" && draft().action.parts.some((part) => !part.accountId),
  );
  const blocked = createMemo(() => problems().some(isStructural) || unsendable());

  // ---- The live check -----------------------------------------------------------------------------------

  type Check = { key: string; rule: ReturnType<typeof inputOf>; windowDays: number };
  const [settled, setSettled] = createSignal<Check | null>(null);
  const wanted = createMemo((): Check | null => {
    if (blocked()) return null;
    const rule = inputOf(draft(), words.untitled);
    const windowDays = days();
    return { key: JSON.stringify([rule, props.ruleId ?? null, windowDays]), rule, windowDays };
  });
  // The check waits until typing pauses, then asks once.
  createEffect(() => {
    const next = wanted();
    if (!next) {
      setSettled(null);
      return;
    }
    const timer = setTimeout(() => setSettled(next), PAUSE);
    onCleanup(() => clearTimeout(timer));
  });
  // The check is held in plain signals, not a resource: a resource read while it loads suspends the
  // router's boundary, which would detach the form and drop the focus of the person typing.
  const [preview, setPreview] = createSignal<RulePreviewData | null>(null);
  const [checking, setChecking] = createSignal(false);
  const [checkFailure, setCheckFailure] = createSignal<unknown>(undefined);
  const [asking, setAsking] = createSignal(0);
  let asked = 0;
  createEffect(() => {
    const check = settled();
    asking();
    if (!check) return;
    asked += 1;
    const mine = asked;
    setChecking(true);
    setCheckFailure(() => undefined);
    void client
      .read("rules.test", {
        rule: check.rule,
        ...(props.ruleId ? { ruleId: props.ruleId } : {}),
        days: check.windowDays,
        samples: 5,
      })
      .then(
        (result) => {
          if (mine !== asked) return;
          setPreview(() => previewOf(result, chart));
          setChecking(false);
        },
        (cause) => {
          if (mine !== asked) return;
          setCheckFailure(() => cause);
          setChecking(false);
        },
      );
  });
  onCleanup(() => {
    asked = Number.MAX_SAFE_INTEGER;
  });
  // A draft the service cannot read at all is one that is not finished, not one that failed.
  const previewState = () =>
    blocked() || codeOf(checkFailure()) === "invalid_input"
      ? "incomplete"
      : checkFailure()
        ? "error"
        : wanted()?.key !== settled()?.key || checking()
          ? "loading"
          : "ready";
  const narrationExample = createMemo(() =>
    draft().action.kind === "exclude" ? undefined : firstNarration(preview()),
  );

  // ---- Try a line -------------------------------------------------------------------------------------------

  async function tryLine() {
    const values = tryValues();
    setTryResult(null);
    setTryProblem(undefined);
    const description = values.description.trim();
    const amount = values.amount.trim();
    const mistakes: { description?: string; amount?: string } = {};
    if (description === "") mistakes.description = words.tryNeedsDescription;
    try {
      parseMoney(amount);
    } catch {
      mistakes.amount = words.tryNeedsAmount;
    }
    setTryErrors(mistakes);
    if (mistakes.description || mistakes.amount) return;
    if (problems().some((problem) => problem.path !== "name")) {
      setTryProblem(words.tryNeedsRule);
      return;
    }
    setTrying(true);
    try {
      const result = await client.read("rules.test", {
        rule: inputOf(draft(), words.untitled),
        ...(props.ruleId ? { ruleId: props.ruleId } : {}),
        days: 1,
        samples: 0,
        lines: [
          {
            description,
            amount,
            ...(values.counterparty.trim() ? { counterparty: values.counterparty.trim() } : {}),
            ...(values.accountId ? { accountId: values.accountId } : {}),
          },
        ],
      });
      const [line] = result.lines;
      setTryResult(line ? tryOf(line, chart) : null);
    } catch (cause) {
      setTryProblem(messageOf(cause, words.tryFailed));
    } finally {
      setTrying(false);
    }
  }

  // ---- Saving, and deleting --------------------------------------------------------------------------------

  const leave = (record: RuleRecord) =>
    window.location.assign(`/rules?saved=${encodeURIComponent(record.id)}`);

  function report(cause: unknown) {
    if (isUncertain(cause)) return;
    setFailure({
      conflict: codeOf(cause) === "rule_revision_conflict",
      message: messageOf(cause, words.failed),
    });
  }

  async function save() {
    setAttempted(true);
    setAttempt((count) => count + 1);
    setFailure(null);
    if (problems().length > 0) return;
    setSaving(true);
    try {
      const rule = inputOf(draft());
      leave(
        props.ruleId
          ? await client.write(
              "rules.update",
              {
                ruleId: props.ruleId,
                expectedRevision: props.start.revision ?? 0,
                rule,
              },
              workflow,
            )
          : await client.write("rules.create", { rule }, workflow),
      );
    } catch (cause) {
      report(cause);
    } finally {
      change.sync();
      setSaving(false);
    }
  }

  async function resume() {
    setSaving(true);
    setFailure(null);
    try {
      const done = await client.resume(workflow);
      if (done.name === "rules.create" || done.name === "rules.update") leave(done.data);
    } catch (cause) {
      report(cause);
    } finally {
      change.sync();
      setSaving(false);
    }
  }

  async function remove(reason: string) {
    if (!props.ruleId) return;
    setDeleting(true);
    setDeleteError(undefined);
    try {
      await client.write(
        "rules.delete",
        {
          ruleId: props.ruleId,
          expectedRevision: props.start.revision ?? 0,
          ...(reason ? { reason } : {}),
        },
        `rules:delete:${props.ruleId}`,
      );
      window.location.assign("/rules");
    } catch (cause) {
      if (!isUncertain(cause)) setDeleteError(messageOf(cause, words.deleteFailedTitle));
    } finally {
      removal.sync();
      setDeleting(false);
    }
  }

  // ---- The page --------------------------------------------------------------------------------------------------

  const banner = (
    <>
      <Show when={props.start.banner}>
        {(note) => (
          <Notice title={note().title} tone={note().tone} role="status">
            <For each={note().paragraphs}>{(text) => <p>{text}</p>}</For>
          </Notice>
        )}
      </Show>
      <Show when={change.pending() || change.broken() || removal.pending()}>
        <Notice title={words.uncertainTitle} tone="review" role="status">
          <p>{change.broken() ?? words.uncertainBody}</p>
          <Show when={!change.broken() && change.pending()}>
            <Button label={words.resume} pending={saving()} onClick={() => void resume()} />
          </Show>
        </Notice>
      </Show>
      <Show when={failure()}>
        {(problem) => (
          <Notice
            title={problem().conflict ? words.conflictTitle : words.failed}
            tone="error"
            role="alert"
          >
            <p>{problem().message}</p>
            <Show when={problem().conflict}>
              <p>{words.conflictBody}</p>
              <Button
                variant="secondary"
                label={words.conflictLoad}
                onClick={() => props.onReload()}
              />
            </Show>
          </Notice>
        )}
      </Show>
    </>
  );

  return (
    <div ref={page}>
      <RuleForm
        mode={props.ruleId ? "edit" : "new"}
        draft={draft()}
        onChange={setDraft}
        errors={errors()}
        summary={summary()}
        attempt={attempt()}
        accounts={chart.withCurrent(chart.bookable, [
          draft().action.accountId,
          ...draft().action.parts.map((part) => part.accountId),
        ])}
        transferAccounts={chart.withCurrent(chart.own, [draft().action.accountId])}
        lineAccounts={chart.withCurrent(chart.own, [
          ...draft().accountIds,
          ...[...draft().conditions, ...draft().groups.flatMap((group) => group.conditions)]
            .filter((condition) => condition.field === "account")
            .map((condition) => condition.value),
        ])}
        split={{
          amount: splitAmount(),
          onAmount: setSplitAmount,
          preview: splitPreview(draft(), splitAmount(), chart),
        }}
        narrationExample={narrationExample()}
        banner={banner}
        saving={saving()}
        locked={retired}
        cancelHref="/rules"
        onSubmit={() => void save()}
        onDelete={props.ruleId && !retired ? () => setConfirming(true) : undefined}
        aside={
          retired ? undefined : (
            <RulePreview
              state={previewState()}
              data={preview()}
              days={days()}
              dayChoices={DAY_CHOICES}
              onDays={setDays}
              onRetry={() => setAsking((count) => count + 1)}
            >
              <RuleTryLine
                values={tryValues()}
                onChange={(values) => {
                  setTryValues(values);
                  setTryErrors({});
                }}
                accounts={chart.own}
                onRun={() => void tryLine()}
                pending={trying()}
                problem={tryProblem()}
                errors={tryErrors()}
                result={tryResult()}
              />
            </RulePreview>
          )
        }
      />
      <Show when={props.ruleId && props.start.history.length > 0}>
        <RuleHistory revisions={props.start.history} />
      </Show>
      <RuleDeleteDialog
        open={confirming()}
        onOpenChange={setConfirming}
        name={draft().name}
        pending={deleting()}
        error={deleteError()}
        onConfirm={(reason) => void remove(reason)}
      />
    </div>
  );
}
