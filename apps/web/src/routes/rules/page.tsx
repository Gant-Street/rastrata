import {
  Button,
  buttonAttrs,
  Notice,
  PageHeader,
  RuleList,
  RulesDecided,
  RulesFacts,
  type RulesFigureData,
  rulesWords as words,
} from "@rastrata/ui";
import { createMemo, createSignal, onMount, Show } from "solid-js";
import { BrowserApplicationClient } from "../../application-client";
import { ClassifierPanel } from "./classifier.tsx";
import { inputFromRecord, rowOf } from "./draft.ts";
import { createLoader } from "../../loader.ts";
import { codeOf, isUncertain, loadChart, messageOf, retained, unreadChart } from "./retained.ts";

/** Every change on this screen (reordering, switching a rule on or off) is one retained write at a
 * time, so a lost reply is resumed before anything else is sent. */
const CHANGE = "rules:change";
const DAYS = 90;

/** Rules: the rules in the order they are tried, each with when it applies, what it suggests, how often it was
 * used and a switch; one line on how many transactions they decide; and the local classifier. A rule only
 * suggests; nothing on this screen records anything. */
export function RulesPage() {
  const client = new BrowserApplicationClient(window.localStorage);
  const chart = createLoader(() => loadChart(client));
  // The rules come first and quickly; what each has matched is measured over the Inbox and the
  // last 90 days of history and arrives after, so the list is never held up by it.
  const list = createLoader(() => client.read("rules.list", {}));
  const measured = createLoader(() => client.read("rules.list", { usage: true, days: DAYS }));
  // An order not yet saved: shown at once, kept while it is saved, dropped when it is known.
  const [order, setOrder] = createSignal<readonly string[] | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [busyId, setBusyId] = createSignal<string | null>(null);
  const [problem, setProblem] = createSignal<string | null>(null);
  const [saved, setSaved] = createSignal<string | null>(null);
  const change = retained(client, CHANGE);
  let heading: HTMLHeadingElement | undefined;

  onMount(() => {
    change.sync();
    heading?.focus();
    const url = new URL(window.location.href);
    const id = url.searchParams.get("saved");
    if (id) {
      setSaved(id);
      url.searchParams.delete("saved");
      window.history.replaceState(null, "", `${url.pathname}${url.search}`);
    }
  });

  const names = createMemo(() => chart.value() ?? unreadChart);
  const records = createMemo(() => {
    const rules = list.value()?.rules ?? [];
    const ids = order();
    if (!ids) return rules;
    const byId = new Map(rules.map((rule) => [rule.id, rule] as const));
    return ids.flatMap((id) => byId.get(id) ?? []);
  });
  // The counts are for the order they were measured in: while they are measured again they are
  // not shown, rather than shown for an order that has changed.
  const usageState = () =>
    measured.error()
      ? "unavailable"
      : measured.loading() || !measured.value()
        ? "loading"
        : "ready";
  const usage = createMemo(
    () =>
      new Map(
        usageState() === "ready"
          ? (measured.value()?.rules ?? []).flatMap((rule) =>
              rule.usage ? [[rule.id, rule.usage] as const] : [],
            )
          : [],
      ),
  );
  const rows = createMemo(() =>
    records().map((rule) => rowOf(rule, names(), usage().get(rule.id))),
  );
  const figure = createMemo((): RulesFigureData | null => {
    const current = list.value();
    if (!current) return null;
    const window = usageState() === "ready" ? (measured.value()?.window ?? null) : null;
    return {
      rules: current.count,
      enabled: current.enabled,
      attention: current.rules.filter((rule) => rule.problems.length > 0).length,
      window: window
        ? {
            days: window.days,
            inbox: window.inbox,
            history: window.history,
            considered: window.considered,
            decided: window.decided,
          }
        : null,
      notes: window?.notes ?? [],
    };
  });
  const figureState = () =>
    list.error() || measured.error()
      ? "error"
      : !list.value() || usageState() === "loading"
        ? "loading"
        : "ready";
  const savedName = createMemo(() => {
    const id = saved();
    return id ? list.value()?.rules.find((rule) => rule.id === id)?.name : undefined;
  });

  /** A failed change is told in words, and the screen goes back to what the service has. */
  function failed(cause: unknown, fallback: string) {
    if (isUncertain(cause)) return;
    setProblem(messageOf(cause, fallback));
    setOrder(null);
    const code = codeOf(cause);
    if (code === "rules_order_conflict" || code === "rule_revision_conflict") void list.reload();
  }

  async function move(id: string, direction: "up" | "down") {
    const current = list.value();
    if (!current || saving()) return;
    const ids = [...(order() ?? current.rules.map((rule) => rule.id))];
    const at = ids.indexOf(id);
    const to = direction === "up" ? at - 1 : at + 1;
    const here = ids[at];
    const there = ids[to];
    if (here === undefined || there === undefined) return;
    ids[at] = there;
    ids[to] = here;
    setOrder(ids);
    setProblem(null);
    setSaving(true);
    try {
      list.set(
        await client.write(
          "rules.reorder",
          { expectedRulesRevision: current.rulesRevision, orderedRuleIds: ids },
          CHANGE,
        ),
      );
      setOrder(null);
      void measured.reload();
    } catch (cause) {
      failed(cause, "The new order could not be saved.");
    } finally {
      change.sync();
      setSaving(false);
    }
  }

  async function toggle(id: string, enabled: boolean) {
    const rule = list.value()?.rules.find((item) => item.id === id);
    if (!rule) return;
    setBusyId(id);
    setProblem(null);
    try {
      await client.write(
        "rules.update",
        {
          ruleId: id,
          expectedRevision: rule.revision,
          rule: inputFromRecord(rule, { enabled }),
        },
        CHANGE,
      );
      await list.reload();
      void measured.reload();
    } catch (cause) {
      failed(cause, "The change could not be saved.");
    } finally {
      change.sync();
      setBusyId(null);
    }
  }

  async function resume() {
    setSaving(true);
    try {
      await client.resume(CHANGE);
      setOrder(null);
      await list.reload();
      void measured.reload();
    } catch (cause) {
      failed(cause, "The change could not be saved.");
    } finally {
      change.sync();
      setSaving(false);
    }
  }

  return (
    <section class="rt-rules-page" aria-labelledby="rules-title">
      <PageHeader
        titleId="rules-title"
        titleRef={(element) => {
          heading = element;
        }}
        title={words.title}
        description={words.pageLine}
        actions={
          <a {...buttonAttrs({ variant: "primary", size: "md" })} href="/rules/new">
            {words.newRule}
          </a>
        }
      />
      <Show when={savedName()}>
        {(name) => <Notice title={words.savedNotice(name())} tone="info" role="status" />}
      </Show>
      <Show when={change.pending() || change.broken()}>
        <Notice title={words.uncertainTitle} tone="review" role="status">
          <p>{change.broken() ?? words.uncertainBody}</p>
          <Show when={!change.broken()}>
            <Button label={words.resume} pending={saving()} onClick={() => void resume()} />
          </Show>
        </Notice>
      </Show>
      <Show when={problem()}>
        {(message) => (
          <Notice title={words.failed} tone="error" role="alert">
            <p>{message()}</p>
          </Notice>
        )}
      </Show>
      <RulesDecided
        state={figureState()}
        data={figure()}
        onRetry={() => {
          void list.reload();
          void measured.reload();
        }}
      />
      <RuleList
        rows={rows()}
        state={list.error() ? "error" : !list.value() ? "loading" : "ready"}
        usage={usageState()}
        days={DAYS}
        newHref="/rules/new"
        saving={saving()}
        busyId={busyId()}
        onMove={(id, direction) => void move(id, direction)}
        onToggle={(id, enabled) => void toggle(id, enabled)}
        onRetry={() => void list.reload()}
      />
      <RulesFacts data={figure()} />
      <ClassifierPanel client={client} chart={names()} />
    </section>
  );
}
