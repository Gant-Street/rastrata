import {
  accountingWords,
  Button,
  buttonAttrs,
  canChangeAccount,
  catchallWords,
  ChangeAccountDialog,
  Details,
  DetailsList,
  inboxWords,
  JournalRegister,
  Loading,
  localToday,
  Notice,
  PageHeader,
  type SelectionAction,
  selectionActionId,
  TransactionViews,
  transactionViews,
  useToast,
  useUi,
  type AccountChoice,
  type JournalContext,
  type RegisterCorrection,
  type RegisterEntry,
  type RowAction,
} from "@rastrata/ui";
import { For, Show, createMemo, createSignal } from "solid-js";
import type { ApplicationOutputs } from "@rastrata/application/client-contracts";
import { AppLink, useGoTo } from "../app-link";
import { BrowserApplicationClient } from "../application-client";
import { createKeyedLoader, createLoader } from "../loader";
import { createChangeAccountController } from "./accounting/change-account";
import { filtersFromAddress } from "./accounting/journal-address";
import { VIEW_HREFS } from "./ingest/view";
import { createReverseController, type ReverseTarget } from "./reverse";
import { ReverseEntryDialog, ReversalWaiting } from "./reverse-dialog";

/** A complete server projection for this early local book. The browser receives display rows,
 * never ledger outcomes or credentials. Server paging will replace the whole-book read model. */
export type JournalBook = {
  scope: {
    revision: string;
    asOf: string;
    populationHash: string;
    basis: string;
    currency: string;
    compilerVersion: string;
  };
  context: JournalContext;
  accounts: AccountChoice[];
  entries: RegisterEntry[];
  drafts: { id: string; version: number; status: string }[];
  corrections: RegisterCorrection[];
  count: number;
  page: number;
  pageSize: number;
};

type Filters = {
  page: number;
  text: string;
  from: string;
  to: string;
  accountId: string;
  status: string;
  type: string;
  revision: string;
};

/** Where an entry came from: the Type filter's choices, in the order they are offered. */
const TYPES = ["bank", "stripe", "manual", "opening"] as const;
const isType = (value: string): value is (typeof TYPES)[number] =>
  (TYPES as readonly string[]).includes(value);

/** One page of the register for the filters, from the service. The page is the projection the register
 * component is built for; the contract types it read-only and the component takes it mutable, which
 * is the only reason for the cast. */
async function loadJournal(
  client: BrowserApplicationClient,
  filters: Filters,
): Promise<JournalBook> {
  const page: ApplicationOutputs["journal.list"] = await client.read("journal.list", {
    page: filters.page,
    ...(filters.text ? { text: filters.text } : {}),
    ...(filters.from ? { from: filters.from } : {}),
    ...(filters.to ? { to: filters.to } : {}),
    ...(filters.accountId ? { accountId: filters.accountId } : {}),
    ...(filters.status === "Posted" || filters.status === "Draft"
      ? { status: filters.status }
      : {}),
    ...(isType(filters.type) ? { type: filters.type } : {}),
    ...(filters.revision ? { revision: filters.revision } : {}),
  });
  return page as unknown as JournalBook;
}

export function JournalPage() {
  const ui = useUi();
  const toast = useToast();
  const goTo = useGoTo();
  const w = accountingWords.transactions;
  // The list opens on the account and the dates the address names (a link from Close the books), or on
  // everything.
  const [filters, setFilters] = createSignal<Filters>({
    page: 1,
    text: "",
    ...filtersFromAddress(window.location.search),
    status: "",
    type: "",
    revision: "",
  });
  const client = new BrowserApplicationClient(window.localStorage);
  // Reads are held in plain signals (see loader.ts): a new filter or a refresh never replaces the
  // register, so the search box keeps its focus while the rows change under it.
  const status = createLoader(() => client.read("book.get", {}));
  const connected = () => {
    const current = status.value();
    return current?.enabled === true && current.setup !== null;
  };
  const book = createKeyedLoader(
    () => (connected() ? filters() : undefined),
    (wanted) => loadJournal(client, wanted),
  );
  // What waits in the other view of the page, for the switch under the title. A read that fails leaves the
  // views without their numbers: the switch still works.
  const waiting = createKeyedLoader(
    () => (connected() ? "waiting" : undefined),
    () => client.read("inbox.summary", {}),
  );
  const views = createMemo(() => {
    const counts = waiting.value()?.counts;
    return transactionViews({
      current: "all",
      page: "all",
      toReview: counts?.toReview ?? 0,
      ready: counts?.postable ?? counts?.drafted ?? 0,
      hrefs: VIEW_HREFS,
    });
  });
  // The periods say which dates are locked, so a reversal starts on a date that can be posted. They are read
  // once a book is connected: a service with no book has none to say.
  const periods = createKeyedLoader(
    () => (connected() ? "periods" : undefined),
    () => client.read("periods.list", {}),
  );
  /** The book's fiscal calendar, for the period list of the date filter. */
  const fiscal = () => {
    const list = periods.value();
    return {
      years: (list?.calendar.fiscalYears ?? []).map(({ startsOn, endsOn }) => ({
        startsOn,
        endsOn,
      })),
      today: list?.calendar.today ?? localToday(),
    };
  };

  /** An entry as the reversal dialog says it. */
  const targetOf = (entry: RegisterEntry): ReverseTarget => ({
    id: entry.id,
    label: entry.postingSequence
      ? ui.messages.register.entryNumber(entry.postingSequence)
      : ui.messages.register.draftNumber,
    description: entry.description?.trim() || entry.reference,
    date: entry.isoDate,
    amount: entry.amount,
  });
  const reverse = createReverseController({
    periods: periods.value,
    lookup: (journalId) => {
      const entry = book.value()?.entries.find((item) => item.id === journalId);
      return entry ? targetOf(entry) : undefined;
    },
    onReversed: async (done) => {
      setFilters((previous) => ({ ...previous, revision: "", page: 1 }));
      await book.reload();
      toast.show({ message: done ? w.reversed(done.label) : w.reversedPlain });
    },
  });

  /** Reversed already, or a reversal itself: either way no reversal links it twice. */
  const linked = (entry: RegisterEntry) =>
    (book.value()?.corrections ?? []).some(
      (link) => link.originalJournalId === entry.id || link.correctionJournalId === entry.id,
    );

  // Changing the account of transactions that came from For review. It corrects, drafts and posts, so a person
  // who cannot do all three is not offered boxes that lead to a refusal. The chart is read the first time the
  // dialog opens, not with every visit to the list.
  const mayMove = () => {
    const held = status.value()?.permissions ?? [];
    return ["correct", "draft", "post"].every((permission) => held.includes(permission));
  };
  const [wantAccounts, setWantAccounts] = createSignal(false);
  const chart = createKeyedLoader(
    () => (wantAccounts() ? "accounts" : undefined),
    () => client.read("accounts.list", {}),
  );
  /** Changes when what was ticked has been dealt with, so the register lets go of its selection. */
  const [selectionReset, setSelectionReset] = createSignal(0);
  const change = createChangeAccountController({
    client,
    accounts: () => chart.value()?.accounts,
    accountsState: () =>
      chart.error() !== undefined ? "error" : chart.value() ? "ready" : "loading",
    loadAccounts: () => {
      if (wantAccounts()) void chart.reload();
      else setWantAccounts(true);
    },
    onMoved: async (moved, name) => {
      setFilters((previous) => ({ ...previous, revision: "" }));
      await book.reload();
      setSelectionReset((key) => key + 1);
      // The button the dialog was opened from goes with the selection: the cursor is put on the page's
      // heading, unless the person has already gone somewhere else.
      queueMicrotask(() => {
        const active = document.activeElement;
        if (active === null || active === document.body)
          document.getElementById("journal-title")?.focus();
      });
      if (moved > 0) toast.show({ message: catchallWords.change.result.toast(moved, name) });
    },
  });
  const selectionActions: readonly SelectionAction[] = [
    {
      id: "change-account",
      label: catchallWords.change.action,
      onSelect: (ids) => change.begin(ids),
    },
  ];
  const actionsOf = (entry: RegisterEntry): readonly RowAction[] => {
    if (entry.status === "Draft")
      return [
        {
          id: "edit",
          label: w.editDraft,
          onSelect: () => goTo(`/journal/new?draft=${encodeURIComponent(entry.id)}`),
        },
      ];
    return linked(entry)
      ? []
      : [{ id: "reverse", label: w.reverseAction, onSelect: () => reverse.begin(targetOf(entry)) }];
  };

  return (
    <section aria-labelledby="journal-title" class="app-journal rt-acct-page">
      {/* The same title and the same two things to do as the other view of the page (Transactions: For review). A
          journal entry is started from "+ New". */}
      <PageHeader
        titleId="journal-title"
        title={w.title}
        actions={
          <>
            <AppLink {...buttonAttrs({ variant: "quiet", size: "md" })} href="/rules">
              {inboxWords.rules}
            </AppLink>
            <AppLink {...buttonAttrs({ variant: "secondary", size: "md" })} href="/import">
              {inboxWords.importStatement}
            </AppLink>
          </>
        }
      />
      <ReversalWaiting controller={reverse} />
      <Show when={change.waiting()}>
        <Notice title={catchallWords.change.waitingTitle} tone="attention" role="status">
          <p>{catchallWords.change.waiting}</p>
          <Button
            variant="secondary"
            label={catchallWords.change.resume}
            onClick={() => change.begin()}
          />
        </Notice>
      </Show>
      {/* The first read draws the outline of the list (after a moment, and long enough not to flicker); a new filter keeps the rows on screen. */}
      <Loading
        ready={
          (status.value() !== undefined || status.error() !== undefined) &&
          (!connected() || book.value() !== undefined || book.error() !== undefined)
        }
        shape="table"
        label={w.loading}
      >
        <Show
          when={status.value()}
          fallback={
            status.error() !== undefined ? (
              <Notice title={w.failedTitle} tone="problem" role="alert">
                <p>{w.failedBody}</p>
                <Button variant="secondary" label={w.retry} onClick={() => void status.reload()} />
              </Notice>
            ) : null
          }
        >
          <Show
            when={book.error() === undefined}
            fallback={
              <Notice title={w.failedTitle} tone="problem" role="alert">
                <p>{w.failedBody}</p>
                <Button variant="secondary" label={w.retry} onClick={() => void book.reload()} />
              </Notice>
            }
          >
            <Show
              when={connected() ? book.value() : null}
              fallback={
                connected() ? null : (
                  <Notice title={w.noBookTitle}>
                    <p>{w.noBookBody}</p>
                  </Notice>
                )
              }
            >
              {(current) => (
                <>
                  <Show when={current().drafts.length > 0}>
                    <section aria-label={w.draftsLabel} class="saved-drafts">
                      <h2>{w.draftsTitle}</h2>
                      <ul>
                        <For each={current().drafts}>
                          {(draft) => {
                            const entry = () =>
                              current().entries.find((item) => item.id === draft.id);
                            return (
                              <li>
                                <a href={`/journal/new?draft=${encodeURIComponent(draft.id)}`}>
                                  {entry()?.description?.trim() ||
                                    entry()?.reference ||
                                    w.untitledDraft}
                                </a>{" "}
                                <span>
                                  {draft.status === "posting"
                                    ? w.draftPosting
                                    : draft.status === "rejected"
                                      ? w.draftRejected
                                      : w.draftUnposted}
                                </span>
                              </li>
                            );
                          }}
                        </For>
                      </ul>
                    </section>
                  </Show>
                  <ReverseEntryDialog controller={reverse} client={client} />
                  <Show when={change.open()}>
                    <ChangeAccountDialog
                      open
                      count={change.count()}
                      capped={change.capped()}
                      stage={change.stage()}
                      accounts={change.accountOptions()}
                      accountsState={change.accountsState()}
                      onRetryAccounts={change.loadAccounts}
                      accountId={change.accountId()}
                      onAccount={change.setAccountId}
                      accountError={change.accountError()}
                      reason={change.reason()}
                      onReason={change.setReason}
                      target={change.target()}
                      rows={change.rows()}
                      progress={change.progress()}
                      error={change.error()}
                      uncertain={change.uncertain()}
                      onResume={() => void change.resume()}
                      onPlan={() => void change.plan()}
                      onBack={change.back}
                      onConfirm={() => void change.confirm()}
                      onCancel={change.cancel}
                      returnFocus={() =>
                        document.getElementById(selectionActionId("change-account")) ??
                        document.getElementById("journal-title")
                      }
                    />
                  </Show>
                  <JournalRegister
                    lead={
                      <TransactionViews
                        views={views()}
                        renderLink={(view, extras) => (
                          <AppLink href={view.href} class={extras.class}>
                            {extras.children}
                          </AppLink>
                        )}
                      />
                    }
                    state={book.loading() ? "refreshing" : "ready"}
                    rowSelectable={(entry) => mayMove() && canChangeAccount(entry, linked(entry))}
                    selectionActions={selectionActions}
                    selectionResetKey={selectionReset()}
                    // An entry is "No. 23", its place in the book. A draft has no number until it is
                    // posted. The long identifier is in the entry's Details and in the search.
                    entryLabel={(entry) =>
                      entry.postingSequence
                        ? ui.messages.register.entryNumber(entry.postingSequence)
                        : ui.messages.register.draftNumber
                    }
                    entries={current().entries}
                    accounts={current().accounts}
                    context={current().context}
                    corrections={current().corrections}
                    fiscal={fiscal()}
                    fiscalState={
                      periods.error() !== undefined
                        ? "error"
                        : periods.value()
                          ? "ready"
                          : "loading"
                    }
                    typeOptions={TYPES}
                    rowActions={actionsOf}
                    newEntryHref="/journal/new"
                    entryHref={(entry) =>
                      entry.status === "Posted"
                        ? `/journal/${encodeURIComponent(entry.id)}?revision=${current().scope.revision}`
                        : `/journal/new?draft=${encodeURIComponent(entry.id)}`
                    }
                    server={{
                      ...filters(),
                      count: current().count,
                      pageSize: current().pageSize,
                      onChange: (change) =>
                        setFilters((previous) => ({
                          ...previous,
                          ...change,
                          revision:
                            Object.keys(change).length === 1 && change.page !== undefined
                              ? current().scope.revision
                              : "",
                        })),
                    }}
                  />
                  <div class="journal-details">
                    <Details summary={w.detailsSummary}>
                      <DetailsList
                        items={[
                          { label: w.detailsRevision, value: current().scope.revision, mono: true },
                          { label: w.detailsBasis, value: current().scope.basis },
                          {
                            label: w.detailsPopulation,
                            value: current().scope.populationHash,
                            mono: true,
                            copy: true,
                          },
                        ]}
                      />
                      <p class="report-meta">
                        <AppLink
                          href={`/reports?${new URLSearchParams({ revision: current().scope.revision, asOf: current().scope.asOf }).toString()}`}
                        >
                          {w.openStatements}
                        </AppLink>
                      </p>
                    </Details>
                  </div>
                </>
              )}
            </Show>
          </Show>
        </Show>
      </Loading>
    </section>
  );
}
