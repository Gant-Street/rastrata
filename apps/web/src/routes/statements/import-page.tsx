import {
  accountOptions,
  AccountPicker,
  Button,
  EmptyState,
  ImportFileDrop,
  ImportHistoryList,
  type ImportHistoryRow,
  ImportResult,
  ImportReview,
  importWords as words,
  NewAccountDrawer,
  Notice,
  PageHeader,
} from "@rastrata/ui";
import { createEffect, createMemo, createSignal, Match, Show, Switch } from "solid-js";
import type { Role } from "../../account";
import { BrowserApplicationClient } from "../../application-client";
import { createLoader } from "../../loader";
import { currentRole, may } from "../../role";
import { workspaceReadOnly } from "../../standing";
import { createAccountDrawers } from "../accounting/account-drawers";
import { createImportController } from "./controller";

/** The picker's id: where focus returns when the New account drawer closes. */
const PICKER_ID = "import-account";
const TAGS_WORKFLOW = "import:account-tags";

/** Import a statement: choose the account and the file; then the file's name, the account, what was
 * found in one sentence, one button and the first rows. The route only loads data and wires the
 * controller to components; nothing here decides what a statement means. Nothing is imported until the
 * button is pressed, and what is imported is exactly what the preview showed. */
/** What an account is to a statement: a bank account, a card, or another asset or liability. The tag the
 * setup gives says it; an older book's bank account is an asset the cash flow calls cash. An account another
 * part of Rastrata finds by a role key (Stripe's balance, payouts in transit) is listed, since a statement can
 * be imported into it, but it is never chosen for the person. */
type StatementKind = "bank" | "card" | "other";
const STATEMENT_KIND_ORDER: Readonly<Record<StatementKind, number>> = {
  bank: 0,
  card: 1,
  other: 2,
};
const STATEMENT_KIND_WORDS: Readonly<Record<StatementKind, { path: string; group: string }>> = {
  bank: { path: "Bank account", group: "Bank accounts" },
  card: { path: "Credit card", group: "Credit cards" },
  other: { path: "", group: "Other accounts" },
};
function statementKind(item: {
  readonly role: string;
  readonly tags?:
    | {
        readonly cashFlowClass?: string | undefined;
        readonly kind?: string | undefined;
        readonly roleKey?: string | undefined;
      }
    | undefined;
}): StatementKind {
  const tags = item.tags ?? {};
  if (tags.roleKey) return "other";
  if (tags.kind === "card" && item.role === "liability") return "card";
  if (item.role === "asset" && (tags.kind === "bank" || tags.cashFlowClass === "cash"))
    return "bank";
  return "other";
}

export function ImportPage() {
  const client = new BrowserApplicationClient(window.localStorage);
  const controller = createImportController(client);
  const chart = createLoader(() => client.read("accounts.list", {}));
  const history = createLoader(() => client.read("import.history", {}));
  const presets = createLoader(() => client.read("import.presets", {}));
  // Making an account needs `configure`: the offer is shown to a role that holds it (a role not yet known is
  // offered it; the service answers for itself).
  const [role, setRole] = createSignal<Role | null>(null);
  void currentRole().then(setRole);
  const mayMake = () => may(role(), "configure") && !workspaceReadOnly();

  // The books' first bank or card account can be made here, from the picker, the way the Chart of accounts
  // makes one: the same drawer, opened on a bank account with the name that was typed, and the account it makes
  // is the one chosen for the statement.
  let tagError = "";
  const drawers = createAccountDrawers({
    chart: chart.value,
    taxForms: () => [],
    reload: () => chart.reload(),
    saveTags: async (accountId, change) => {
      try {
        await client.write(
          "accounts.setTags",
          { accountId, effectiveOn: change.effectiveOn, tags: change.tags },
          TAGS_WORKFLOW,
        );
        return true;
      } catch (cause) {
        tagError = cause instanceof Error ? cause.message : "";
        return false;
      }
    },
    tagError: () => tagError,
    created: (account) => controller.setAccount(account.id),
  });

  // The accounts a statement can be for, as the kit's picker takes them: the bank accounts first, then
  // the cards, then any other asset or liability (a loan, a processor's balance), each under its own heading.
  const choices = createMemo(() => {
    const rows = (chart.value()?.accounts ?? [])
      .filter(
        (item) => (item.role === "asset" || item.role === "liability") && item.closedOn === null,
      )
      .map((item) => ({ item, kind: statementKind(item) }))
      .sort((left, right) => STATEMENT_KIND_ORDER[left.kind] - STATEMENT_KIND_ORDER[right.kind]);
    return accountOptions(rows.map((row) => row.item)).map((option, index) => ({
      ...option,
      path: STATEMENT_KIND_WORDS[rows[index]?.kind ?? "other"].path,
      group: STATEMENT_KIND_WORDS[rows[index]?.kind ?? "other"].group,
      statementKind: rows[index]?.kind ?? "other",
    }));
  });
  // A bank tile's Import link names the account (`/import?account=<id>`): it is chosen when the chart arrives.
  // A book with one bank or card account has nothing to choose: that account is chosen.
  const wanted = new URLSearchParams(window.location.search).get("account") ?? "";
  /** The books' own bank and card accounts: what a statement is usually for. */
  const own = () => choices().filter((choice) => choice.statementKind !== "other");
  createEffect(() => {
    if (controller.account() !== "") return;
    if (wanted !== "" && choices().some((choice) => choice.value === wanted)) {
      controller.setAccount(wanted);
      return;
    }
    if (wanted === "" && own().length === 1)
      controller.setAccount((own()[0] as { value: string }).value);
  });

  const upload = controller.upload;
  /** The file has been read: the page is now about what was found in it. */
  const checking = () => controller.stage() === "review" && Boolean(controller.shown());
  // The column editor starts again for another file or account, and when a layout is chosen by name.
  const resetKey = () =>
    `${controller.receipt()?.sha256 ?? ""}:${controller.account()}:${controller.presetId()}`;
  const historyRows = (): ImportHistoryRow[] => [...(history.value()?.runs ?? [])];

  // Where a person looks next is where focus goes: the check once a file has been read (the result
  // component takes focus itself when it appears).
  let checked = "";
  createEffect(() => {
    const shown = controller.shown();
    if (shown && shown.file.sha256 !== checked) {
      checked = shown.file.sha256;
      queueMicrotask(() => document.getElementById("import-check-title")?.focus());
    }
    if (!shown) checked = "";
  });
  createEffect(() => {
    if (controller.stage() === "done") {
      void history.reload();
      void chart.reload();
    }
  });

  return (
    <section class="rt-imp-page" aria-labelledby="import-title">
      <PageHeader
        titleId="import-title"
        title={words.title}
        description={
          controller.stage() === "review" && !controller.shown() ? words.intro : undefined
        }
      />

      <Show when={workspaceReadOnly()}>
        <Notice title={words.readOnlyTitle} tone="info">
          <p>{words.readOnlyBody}</p>
        </Notice>
      </Show>

      <Show
        when={
          !workspaceReadOnly() && controller.queueTotal() > 1 && controller.stage() === "review"
        }
      >
        <div class="rt-imp-queue" role="status">
          <span>
            {words.queueStatus(
              controller.queueIndex(),
              controller.queueTotal(),
              controller.queue().length,
            )}
          </span>
          <div class="rt-imp-queue-actions">
            <Show when={controller.queue().length > 0}>
              <Button
                variant="quiet"
                size="sm"
                label={words.skipQueued}
                onClick={() => void controller.nextQueued()}
              />
            </Show>
            <Button
              variant="quiet"
              size="sm"
              label={words.clearQueue}
              onClick={controller.clearQueue}
            />
          </div>
        </div>
      </Show>

      <Show when={!workspaceReadOnly()}>
        <Switch>
          <Match when={controller.stage() !== "review"}>
            <ImportResult
              state={controller.stage() === "done" ? "done" : "uncertain"}
              result={controller.result() ?? undefined}
              resuming={controller.committing()}
              onResume={() => void controller.resume()}
              nextLabel={
                controller.queue().length > 0
                  ? words.nextQueued(controller.queue().length)
                  : undefined
              }
              onNext={
                controller.queue().length > 0 ? () => void controller.nextQueued() : undefined
              }
              onAnother={controller.startOver}
              inboxLink={
                <a
                  class="rt-button"
                  data-variant={controller.queue().length > 0 ? "secondary" : "primary"}
                  data-size="md"
                  href="/inbox"
                >
                  {words.openInbox}
                </a>
              }
            />
          </Match>
          <Match when={true}>
            <div class="rt-imp-pair" data-checking={checking() ? "" : undefined}>
              <Show when={checking()}>
                <p class="rt-imp-file" data-facts>
                  <strong>{upload().name}</strong> <span>{words.into}</span>
                </p>
              </Show>
              <section class="rt-imp-step" aria-labelledby="import-account-title">
                <h2 id="import-account-title" class="rt-sr-only">
                  {words.accountTitle}
                </h2>
                <Show when={chart.error() !== undefined}>
                  <Notice title={words.accountsFailed} tone="error" role="alert">
                    <Button
                      label="Try again"
                      variant="secondary"
                      onClick={() => void chart.reload()}
                    />
                  </Notice>
                </Show>
                <Show when={chart.error() === undefined}>
                  <Show
                    when={chart.loading() || choices().length > 0 || mayMake()}
                    fallback={
                      <EmptyState title={words.noAccountsTitle}>{words.noAccounts}</EmptyState>
                    }
                  >
                    <AccountPicker
                      id={PICKER_ID}
                      accounts={choices()}
                      label={words.accountLabel}
                      hideLabel={checking()}
                      compact={checking()}
                      hint={own().length === 0 ? words.firstAccountHint : ""}
                      state={chart.loading() ? "loading" : "ready"}
                      value={controller.account()}
                      onChange={controller.setAccount}
                      onCreate={
                        mayMake()
                          ? (typed) => drawers.openNew(PICKER_ID, { name: typed, kind: "bank" })
                          : undefined
                      }
                    />
                  </Show>
                </Show>
              </section>

              <Show when={!checking()}>
                <section class="rt-imp-step" aria-labelledby="import-file-title">
                  <h2 id="import-file-title" class="rt-sr-only">
                    {words.fileTitle}
                  </h2>
                  <ImportFileDrop
                    multiple
                    state={upload().state}
                    fileName={upload().name}
                    fileSize={upload().size}
                    error={upload().error}
                    onFile={(file) => void controller.chooseFile(file)}
                    onFiles={(files) => void controller.chooseFiles(files)}
                  />
                </section>
              </Show>
            </div>

            <Show when={controller.receipt() && !controller.account()}>
              <p class="rt-hint" role="status">
                {words.needAccountFirst}
              </p>
            </Show>

            <Show when={controller.loadingFirst()}>
              <p class="rt-hint" role="status">
                {words.reading(upload().name ?? "")}
              </p>
            </Show>
            <Show when={!controller.shown() && controller.failed()}>
              <Notice title={words.previewFailed} tone="error" role="alert">
                {controller.failed()}
              </Notice>
            </Show>

            <Show when={controller.shown()}>
              {(preview) => (
                <section class="rt-imp-step" aria-labelledby="import-check-title">
                  <h2 id="import-check-title" class="rt-sr-only" tabindex={-1}>
                    {words.checkTitle}
                  </h2>
                  <Show when={controller.commitError()}>
                    <Notice title={words.commitFailed} tone="error" role="alert">
                      {controller.commitError()}
                    </Notice>
                  </Show>
                  <ImportReview
                    preview={preview()}
                    refreshing={controller.refreshing()}
                    failed={controller.failed() || undefined}
                    filter={controller.filter()}
                    page={controller.page()}
                    startOn={controller.startOn()}
                    catchUp={controller.catchUp()}
                    ignoreIds={controller.ignoreIds()}
                    invertBalance={controller.invertBalance()}
                    skipRows={controller.skipRows()}
                    committing={controller.committing()}
                    resetKey={resetKey()}
                    presets={presets.value()?.presets}
                    presetId={controller.presetId()}
                    onPreset={controller.choosePreset}
                    save={{
                      name: controller.profileName(),
                      saving: controller.saving(),
                      message: controller.saved() || undefined,
                      error: controller.saveError() || undefined,
                      onName: controller.setProfileName,
                      onSave: () => void controller.saveProfile(),
                    }}
                    onFilter={controller.setFilter}
                    onPage={controller.setPage}
                    onStartOn={controller.setStartOn}
                    onCatchUp={controller.setCatchUp}
                    onIgnoreIds={controller.setIgnoreIds}
                    onInvertBalance={controller.setInvertBalance}
                    onSkipRows={controller.setSkipRows}
                    onMapping={(next) =>
                      controller.chooseMapping(
                        next as Parameters<typeof controller.chooseMapping>[0],
                      )
                    }
                    onOfxAccount={controller.chooseOfxAccount}
                    onCommit={() => void controller.commit()}
                    onStartOver={controller.startOver}
                  />
                </section>
              )}
            </Show>
          </Match>
        </Switch>
      </Show>

      {/* What was imported before, when something was: beside the choice of a file, where "did I already
          bring this one in?" is asked. */}
      <Show when={!checking() && (historyRows().length > 0 || history.error() !== undefined)}>
        <ImportHistoryList
          rows={historyRows()}
          state={history.error() !== undefined ? "error" : "ready"}
        />
      </Show>

      <Show when={drawers.mode() === "create"}>
        <NewAccountDrawer
          open
          values={drawers.values()}
          onChange={drawers.change}
          accounts={chart.value()?.accounts ?? []}
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
          returnFocus={() => document.getElementById(PICKER_ID)}
        />
      </Show>
    </section>
  );
}
