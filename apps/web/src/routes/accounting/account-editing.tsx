import type { ApplicationOutputs } from "@rastrata/application/client-contracts";
import {
  type AccountView,
  Button,
  chartWords,
  compareCodes,
  Dialog,
  EditAccountDrawer,
  localToday,
  NewAccountDrawer,
  Notice,
  type TagChange,
  TagEditor,
  type TagEvent,
  type TagResult,
  type TaxFormChoice,
  useToast,
  WatchAccountDialog,
} from "@rastrata/ui";
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  onMount,
  Show,
} from "solid-js";
import {
  ApplicationRequestError,
  type BrowserApplicationClient,
  type PendingRequest,
} from "../../application-client";
import { createKeyedLoader, createLoader } from "../../loader";
import { openedForDisplay } from "../account-opened";
import { createAccountDrawers } from "./account-drawers";
import { type TaxLines, taxLineNames } from "./tax-lines";
import { createWatchController } from "./watch";

type AccountList = ApplicationOutputs["accounts.list"];
type PeriodList = ApplicationOutputs["periods.list"];

const TAGS_WORKFLOW = "accounts-tags";

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "The request could not be completed.";

/** Closed periods, for warning before a tag change reaches into one. */
async function loadClosedPeriods(client: BrowserApplicationClient) {
  try {
    const list = await client.read("periods.list", {});
    return list.periods
      .filter((period) => period.status === "closed")
      .map((period) => ({
        label: period.label,
        startsOn: period.startsOn,
        endsOn: period.endsOn,
      }));
  } catch {
    return [];
  }
}

/** Tag writes are retained like every other write: the exact request is saved first, a lost reply
 * leaves it to be resumed, and a refusal leaves nothing behind. */
function createTagWriter(client: BrowserApplicationClient, onSaved: () => unknown) {
  const [pending, setPending] = createSignal<PendingRequest | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [result, setResult] = createSignal<TagResult | null>(null);
  const [uncertain, setUncertain] = createSignal(false);
  /** The service's code for the last refusal, so a screen can say it in its own words. */
  const [code, setCode] = createSignal("");
  const sync = () => {
    try {
      setPending(client.pending(TAGS_WORKFLOW));
    } catch (cause) {
      setError(messageOf(cause));
    }
  };
  onMount(() => {
    sync();
    setUncertain(pending() !== null);
  });
  const fail = (cause: unknown) => {
    setError(messageOf(cause));
    setCode(cause instanceof ApplicationRequestError ? cause.code : "");
    setUncertain(cause instanceof ApplicationRequestError && cause.uncertain);
  };
  const done = async (data: ApplicationOutputs["accounts.setTags"]) => {
    setResult({ changed: data.changed, effectiveOn: data.effectiveOn, warnings: data.warnings });
    setUncertain(false);
    await onSaved();
  };
  return {
    pending,
    busy,
    error,
    code,
    result,
    uncertain,
    reset() {
      setError("");
      setCode("");
      setResult(null);
    },
    async save(accountId: string, change: TagChange): Promise<boolean> {
      if (busy()) return false;
      setBusy(true);
      setError("");
      setCode("");
      setResult(null);
      try {
        await done(
          await client.write(
            "accounts.setTags",
            { accountId, effectiveOn: change.effectiveOn, tags: change.tags },
            TAGS_WORKFLOW,
          ),
        );
        return true;
      } catch (cause) {
        fail(cause);
        return false;
      } finally {
        sync();
        setBusy(false);
      }
    },
    async resume(): Promise<void> {
      if (busy()) return;
      setBusy(true);
      setError("");
      try {
        const completed = await client.resume(TAGS_WORKFLOW);
        if (completed.name === "accounts.setTags") await done(completed.data);
      } catch (cause) {
        fail(cause);
      } finally {
        sync();
        setBusy(false);
      }
    },
  };
}

/** Adding an account and changing one, for the two pages that do it: Accounts adds, and an account's own
 * page renames or closes it, watches it at month end and edits its tags. Both pages share the state of a
 * change that is waiting (a reply that was lost) and say it the same way, so it can be resumed from either.
 * Call it inside a component; draw `Notices` under the page's header and `Dialogs` at its foot. */
export function createAccountEditing(options: {
  client: BrowserApplicationClient;
  /** The chart as read: `null` when no book is connected yet, undefined before the first read. */
  chart: Accessor<AccountList | null | undefined>;
  /** The chart was changed: read it (and whatever the page shows from it) again. */
  reload: () => Promise<unknown>;
  taxLines: Accessor<TaxLines | null | undefined>;
  periods: Accessor<PeriodList | undefined>;
  /** The id of the page's "New account" button, which gets focus back when that drawer closes. */
  newButtonId?: string;
  /** An account was added: the page may want to show it. */
  created?: (account: AccountList["accounts"][number]) => void;
}) {
  const w = chartWords;
  const toast = useToast();
  const { client } = options;
  const closedPeriods = createLoader(() => loadClosedPeriods(client));
  const [editingTags, setEditingTags] = createSignal<AccountView | null>(null);
  /** The id of the control that opened the dialog about an account, to hand focus back to. */
  const [from, setFrom] = createSignal<string | null>(null);
  const history = createKeyedLoader(
    () => editingTags()?.id,
    async (accountId) => {
      const read = await client.read("accounts.tagHistory", { accountId });
      return read.events as readonly TagEvent[];
    },
  );

  const writer = createTagWriter(client, async () => {
    await options.reload();
    if (editingTags()) await history.reload();
  });

  const taxForms = createMemo<TaxFormChoice[]>(() =>
    (options.taxLines()?.forms ?? []).map((form) => ({
      id: form.id,
      name: form.name,
      taxYear: form.taxYear,
      status: form.status,
      lines: form.lines.map((line) => ({
        id: line.id,
        number: line.number,
        label: line.label,
        part: line.part,
        roles: line.roles,
        ...(line.note ? { note: line.note } : {}),
      })),
    })),
  );
  const lineText = createMemo(() => taxLineNames(options.taxLines()));
  const taxLineText = (id: string) => lineText().get(id);
  const views = createMemo<AccountView[]>(() => {
    const accounts = options.chart()?.accounts ?? [];
    const codes = new Map(accounts.map((account) => [account.id, account.code]));
    // A chart is read in code order, whatever order the accounts were created in.
    return [...accounts]
      .sort((a, b) => compareCodes(a.code, b.code))
      .map((account) => ({
        id: account.id,
        code: account.code,
        name: account.name,
        role: account.role,
        parentCode: account.parentId ? (codes.get(account.parentId) ?? account.parentId) : null,
        openedOn: openedForDisplay(account.openedOn, options.periods()?.calendar.booksBegan),
        closedOn: account.closedOn,
        balance: account.balance,
        tags: {
          ...(account.tags?.cashFlowClass ? { cashFlowClass: account.tags.cashFlowClass } : {}),
          ...(account.tags?.taxLine ? { taxLine: account.tags.taxLine } : {}),
          ...(account.tags?.roleKey ? { roleKey: account.tags.roleKey } : {}),
          ...(account.tags?.kind ? { kind: account.tags.kind } : {}),
        },
      }));
  });

  const drawers = createAccountDrawers({
    chart: options.chart,
    taxForms,
    reload: async () => {
      await options.reload();
    },
    saveTags: (accountId, change) => writer.save(accountId, change),
    tagError: writer.error,
    periods: options.periods,
    ...(options.created ? { created: options.created } : {}),
  });

  // Watching an account at month end: the mark is a tag, saved through the same retained writer.
  const watch = createWatchController({
    accounts: views,
    save: (accountId, change) => writer.save(accountId, change),
    saveError: writer.error,
    saveCode: writer.code,
    uncertain: writer.uncertain,
    resume: () => writer.resume(),
    today: localToday,
    onSaved: (message) => toast.show({ message }),
  });

  /** Rename or close an account, from the control with this id. */
  function editAccount(account: AccountView, opener: string) {
    drawers.openEdit(account, opener);
  }
  /** Watch an account at month end, or stop, from the control with this id. */
  function watchAccount(account: AccountView, opener: string) {
    setFrom(opener);
    watch.begin(account);
  }
  /** Open an account's tag editor, from the control with this id. */
  function editTags(account: AccountView, opener: string) {
    writer.reset();
    setFrom(opener);
    setEditingTags(account);
  }
  function closeTagEditor() {
    const opener = from();
    setEditingTags(null);
    writer.reset();
    if (opener)
      requestAnimationFrame(() =>
        requestAnimationFrame(() => document.getElementById(opener)?.focus()),
      );
  }
  const currentTags = () => {
    const open = editingTags();
    // The account as it is now: a save reads the chart again and the editor keeps showing fresh tags.
    return open ? (views().find((account) => account.id === open.id) ?? open) : null;
  };

  // A tag change that was saved elsewhere than in the editor (a resumed one) says so; the editor says it itself,
  // watching an account says what it did in its own words, and adding an account says "Added …" once for the
  // account and the tags it was given together.
  let said: TagResult | null = null;
  createEffect(() => {
    const result = writer.result();
    if (result && result !== said && !editingTags()) {
      said = result;
      if (!watch.busy() && drawers.mode() !== "create")
        toast.show({ message: result.changed ? w.tagsSaved : w.tagsUnchanged });
    }
  });

  /** What is waiting or was just said about a change: under the page's header. */
  const Notices = (): JSX.Element => (
    <>
      <Show when={writer.pending() && !editingTags()}>
        <Notice title={w.tagsWaitingTitle} tone="attention" role="status">
          <p>{w.tagsWaiting}</p>
          <Button
            variant="secondary"
            label={w.resume}
            disabled={writer.busy()}
            onClick={() => void writer.resume()}
          />
          <Show when={writer.error()}>
            <p role="alert">{writer.error()}</p>
          </Show>
        </Notice>
      </Show>
      {/* A request for an account that was sent and not answered, found again after a reload: resuming it opens
          the drawer it belongs to and finishes it. Nothing is sent twice. */}
      <Show when={drawers.pending() !== null && drawers.mode() === ""}>
        <Notice title={w.add.waitingTitle} tone="attention" role="status">
          <p>{w.add.retained}</p>
          <Button
            variant="secondary"
            label={w.resume}
            disabled={drawers.busy()}
            onClick={() => void drawers.resume()}
          />
          <Show when={drawers.error()}>
            <p role="alert">{drawers.error()}</p>
          </Show>
        </Notice>
      </Show>
      <Show when={!editingTags() && (writer.result()?.warnings ?? []).length > 0}>
        <Notice title={w.checkTags} tone="attention" role="status">
          <ul>
            <For each={writer.result()?.warnings}>{(warning) => <li>{warning}</li>}</For>
          </ul>
        </Notice>
      </Show>
    </>
  );

  /** The drawers and dialogs: at the foot of the page. */
  const Dialogs = (): JSX.Element => (
    <>
      <Show when={drawers.mode() === "create"}>
        <NewAccountDrawer
          open
          values={drawers.values()}
          onChange={drawers.change}
          accounts={options.chart()?.accounts ?? []}
          taxLines={drawers.taxChoices}
          suggestedCode={drawers.suggested()}
          stage={drawers.stage()}
          warnings={drawers.warnings()}
          problems={drawers.problems()}
          error={drawers.error()}
          uncertain={drawers.pending() !== null}
          onResume={() => void drawers.resume()}
          onSubmit={() => void drawers.submitNew()}
          onConfirm={() => void drawers.confirm()}
          onCancel={drawers.cancel}
          returnFocus={() => document.getElementById(drawers.opener() ?? options.newButtonId ?? "")}
        />
      </Show>
      <Show when={drawers.mode() === "edit" && drawers.editing()}>
        {(account) => (
          <EditAccountDrawer
            open
            account={account()}
            values={drawers.edits()}
            onChange={drawers.setEdits}
            stage={drawers.stage()}
            warnings={drawers.warnings()}
            problems={drawers.problems()}
            error={drawers.error()}
            uncertain={drawers.pending() !== null}
            onResume={() => void drawers.resume()}
            onSubmit={() => void drawers.submitEdit()}
            onConfirm={() => void drawers.confirm()}
            onCancel={drawers.cancel}
            returnFocus={() =>
              document.getElementById(drawers.opener() ?? options.newButtonId ?? "")
            }
          />
        )}
      </Show>
      <Show when={watch.target()}>
        {(open) => {
          // Read once: the dialog hands focus back after it has closed, when the target is already gone.
          const opener = from();
          return (
            <WatchAccountDialog
              open
              mode={open().mode}
              account={{
                name: open().account.name,
                role: open().account.role === "income" ? "income" : "expense",
              }}
              replaces={watch.replaces()}
              busy={watch.busy()}
              error={watch.error() || undefined}
              uncertain={watch.uncertain()}
              onResume={() => void watch.resume()}
              onConfirm={() => void watch.confirm()}
              onCancel={watch.cancel}
              returnFocus={() => (opener ? document.getElementById(opener) : null)}
            />
          );
        }}
      </Show>
      <Show when={currentTags()}>
        {(account) => (
          <Dialog
            open
            placement="end"
            title="Edit tags"
            description="Where this account appears on your cash flow statement and your tax form, from a date."
            closeLabel="Close the tag editor"
            onOpenChange={(open) => {
              if (!open) closeTagEditor();
            }}
          >
            <TagEditor
              account={account()}
              taxForms={taxForms()}
              taxLineText={taxLineText}
              today={localToday()}
              closedPeriods={closedPeriods.value() ?? []}
              history={
                history.loading() || history.error() !== undefined
                  ? null
                  : (history.value() ?? null)
              }
              saving={writer.busy()}
              error={writer.error()}
              result={writer.result()}
              uncertain={writer.uncertain()}
              onSave={(change) => void writer.save(account().id, change)}
              onResume={() => void writer.resume()}
              onClose={closeTagEditor}
            />
          </Dialog>
        )}
      </Show>
    </>
  );

  return {
    /** Every account of the chart, in code order, as the screens show one. */
    views,
    taxLineText,
    drawers,
    watch,
    /** No drawer or dialog about an account is open. */
    idle: () => editingTags() === null && drawers.mode() === "" && watch.target() === null,
    editAccount,
    watchAccount,
    editTags,
    Notices,
    Dialogs,
  };
}
