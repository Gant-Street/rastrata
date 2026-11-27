import type {
  MutationReceipt,
  PreparedOperation,
  SavedDraft,
  SourceRecord,
} from "@rastrata/application/client-contracts";
import {
  accountOptions,
  blankEntryLine,
  Button,
  DateValue,
  EntryBar,
  EntrySource,
  entryIds,
  type EntryLine,
  entryProblems,
  entryTotals,
  entryWords,
  ErrorSummary,
  JournalLines,
  Loading,
  localToday,
  Money,
  normalizedEntryLines,
  Notice,
  PageHeader,
  Status,
  TextField,
  useToast,
  useUi,
  DateField,
} from "@rastrata/ui";
import { useNavigate } from "@tanstack/solid-router";
import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { AppLink, useGoTo } from "../app-link";
import {
  BrowserApplicationClient,
  type ApplicationCompletion,
  type PendingRequest,
} from "../application-client";
import { createLoader } from "../loader";
import { startingDate } from "./journal-date";

type Setup = {
  fiscalYear: number;
  /** The day the books begin, when the setup names one. */
  booksStartOn: string | undefined;
  currency: string;
  accounts: ReturnType<typeof accountOptions>;
  /** The accounts by id, for naming a line in the review. */
  names: ReadonlyMap<string, string>;
};

/** What the form needs of the book: its first year and the day its books begin, its currency and its accounts. `null` is a service with
 * no book set up; a failed read throws. */
async function loadSetup(client: BrowserApplicationClient): Promise<Setup | null> {
  const status = await client.read("book.get", {});
  if (!status.setup) return null;
  const chart = await client.read("accounts.list", {});
  return {
    fiscalYear: status.setup.fiscalYear,
    booksStartOn: status.setup.booksStartOn,
    currency: status.setup.currency,
    accounts: accountOptions(chart.accounts),
    names: new Map<string, string>(
      chart.accounts.map((account): [string, string] => [account.id, account.name]),
    ),
  };
}

/** Said the same way whatever the draft, so "has it changed since it was reviewed" is a comparison of
 * what a person typed and not of how it was written down. */
const canonical = (data: {
  date: string;
  reference: string;
  narration: string;
  lines: readonly EntryLine[];
  source?: { id: string; description: string; evidenceReference?: string | undefined } | undefined;
}): string =>
  JSON.stringify([
    data.date,
    data.reference,
    data.narration,
    data.lines.map((line) => [line.accountId, line.debit, line.credit]),
    data.source
      ? [data.source.id, data.source.description, data.source.evidenceReference ?? ""]
      : null,
  ]);

const messageOf = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback;

/** Put the cursor on a control once the page has drawn what it changed. */
const focusLater = (id: string) =>
  requestAnimationFrame(() => document.getElementById(id)?.focus());

/** The form for a new journal entry, an entry being finished (`?draft=`), the opening balances
 * (`?opening=1`) or an entry recording an event that is already known (`?source=`, from an entry's
 * details: the source's facts are shown under "Where this entry came from", and the ledger refuses to
 * book the event twice). Save draft keeps what was typed; Post saves it, has the ledger check it and
 * posts it in the same click when there is nothing to read. A warning or a refusal is shown and waits.
 * Every write is retained before it is sent, so a lost reply is resumed after a reload and never sent
 * twice. */
export function NewJournal() {
  const w = entryWords;
  const ui = useUi();
  const toast = useToast();
  const goTo = useGoTo();
  const navigate = useNavigate();
  const query = new URLSearchParams(window.location.search);
  const opening = query.get("opening") === "1";
  const application = new BrowserApplicationClient(window.localStorage);
  // Held in plain signals (see loader.ts): reading the book never suspends the page.
  const setup = createLoader(() => loadSetup(application));
  // The book's calendar says where a new entry's date starts, and a date outside it is met with an offer to
  // extend it, not a bare refusal.
  const calendar = createLoader(() => application.read("periods.list", {}));

  const [date, setDate] = createSignal("");
  const [reference, setReference] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [lines, setLines] = createSignal<EntryLine[]>([blankEntryLine(), blankEntryLine()]);
  const [sourceId, setSourceId] = createSignal("");
  const [sourceDescription, setSourceDescription] = createSignal("");
  const [evidence, setEvidence] = createSignal("");
  const [sourceRecord, setSourceRecord] = createSignal<SourceRecord | null>(null);
  // The fold "Where this entry came from" exists only when the form was opened for a source or for a draft
  // that carries one; an entry typed by hand has no field for it.
  const [sourceOpen, setSourceOpen] = createSignal(false);
  const [saved, setSaved] = createSignal<SavedDraft | null>(null);
  const [plan, setPlan] = createSignal<PreparedOperation | null>(null);
  const [reviewed, setReviewed] = createSignal("");
  const [pending, setPending] = createSignal<PendingRequest | null>(null);
  const [busy, setBusy] = createSignal<"draft" | "post" | "other" | null>(null);
  /** The bar spins Save draft or Post; any other request (discarding, loading a draft) only blocks it. */
  const barBusy = (): "draft" | "post" | null => {
    const now = busy();
    return now === "other" ? null : now;
  };
  const [error, setError] = createSignal("");
  const [uncertain, setUncertain] = createSignal(false);
  // After a refused Save draft or Post, what stands in the way is listed and kept up to date as it is fixed.
  const [attempted, setAttempted] = createSignal<"draft" | "post" | null>(null);
  const [attempt, setAttempt] = createSignal(0);

  const startDate = () =>
    startingDate({
      opening,
      today: calendar.value()?.calendar.today ?? localToday(),
      firstFiscalDay:
        setup.value()?.booksStartOn ??
        `${setup.value()?.fiscalYear ?? localToday().slice(0, 4)}-01-01`,
      calendar: calendar.value()?.calendar,
    });
  const shownDate = () => date() || startDate();

  const retainedSource = () => {
    const source = saved()?.data.source ?? sourceRecord()?.source;
    return source?.id === sourceId().trim() ? source : undefined;
  };
  const data = () => ({
    date: shownDate(),
    reference: reference().trim(),
    narration: description().trim(),
    lines: normalizedEntryLines(lines()),
    ...(sourceId().trim()
      ? {
          source: retainedSource() ?? {
            id: sourceId().trim(),
            description: sourceDescription(),
            ...(evidence() ? { evidenceReference: evidence() } : {}),
          },
        }
      : {}),
  });
  const reviewCurrent = () => reviewed() === canonical(data());
  /** A draft that is not a draft any more (posting, rejected, posted) is not edited: it is recovered first. */
  const locked = () => saved() !== null && saved()?.status !== "draft";

  const problems = createMemo(() => {
    const purpose = attempted();
    if (purpose === null) return [];
    return entryProblems({
      date: shownDate(),
      description: description(),
      lines: lines(),
      source: { id: sourceId(), description: sourceDescription() },
      purpose,
    });
  });
  const problemsById = createMemo(
    () =>
      Object.fromEntries(problems().map((problem) => [problem.id, problem.short])) as Record<
        string,
        string
      >,
  );
  const totals = createMemo(() => entryTotals(lines()));

  function loadedDraft(draft: SavedDraft) {
    setSaved(draft);
    setDate(draft.data.date);
    setReference(draft.data.reference);
    setDescription(draft.data.narration);
    setSourceId(draft.data.source?.id ?? "");
    setSourceDescription(draft.data.source?.description ?? "");
    setEvidence(draft.data.source?.evidenceReference ?? "");
    setSourceRecord(null);
    setLines(draft.data.lines.map((line) => ({ ...line })));
    setUncertain(draft.status === "posting");
    if (draft.data.source) setSourceOpen(true);
    const url = new URL(window.location.href);
    url.searchParams.set("draft", draft.id);
    window.history.replaceState(window.history.state, "", url);
  }

  onMount(() => {
    try {
      setPending(application.pending("journal"));
    } catch (cause) {
      setError(messageOf(cause, "Request unavailable"));
    }
    const existingSource = query.get("source");
    if (existingSource) {
      // Opened to look at, or to book, an event that is already known: its facts are filled in and shown.
      setSourceOpen(true);
      void application
        .read("sources.get", { sourceId: existingSource })
        .then((record) => {
          setSourceId(record.source.id);
          setSourceDescription(record.source.description);
          setEvidence(record.source.evidenceReference ?? "");
          setSourceRecord(record);
        })
        .catch((cause) => setError(messageOf(cause, "Source unavailable")));
    }
    const draftId = query.get("draft");
    if (!draftId) {
      if (opening) {
        setReference("OPENING-1");
        setDescription("Opening balances with explicit offset account");
      }
      return;
    }
    void application
      .read("drafts.get", { draftId })
      .then(loadedDraft)
      .catch((cause) => setError(messageOf(cause, "Draft unavailable")));
  });

  const changeLine = (index: number, patch: Partial<EntryLine>) =>
    setLines((previous) =>
      previous.map((line, position) => (position === index ? { ...line, ...patch } : line)),
    );

  /** The entry's number for what the toast says, when the book can say it. */
  async function announcePosted(journalId: string | undefined) {
    let label: string | undefined;
    if (journalId) {
      try {
        const entry = await application.read("journal.get", { journalId });
        label = ui.messages.register.entryNumber(entry.postingSequence);
      } catch {
        // The entry is posted either way; the toast just does not name it.
      }
    }
    toast.show({
      message: label ? w.done.posted(label) : w.done.postedPlain,
      ...(journalId
        ? {
            action: {
              label: w.done.view,
              onSelect: () => goTo(`/journal/${encodeURIComponent(journalId)}`),
            },
          }
        : {}),
    });
  }

  /** What came of a commit: posted, or refused with the draft read again so it can be recovered. */
  async function completePosting(receipt: MutationReceipt, prepared?: PreparedOperation) {
    setPlan(null);
    if (receipt.disposition === "committed") {
      await announcePosted(prepared?.effects.journals[0]?.id);
      await navigate({ to: "/journal" });
      return;
    }
    const draft = saved();
    if (draft) loadedDraft(await application.read("drafts.get", { draftId: draft.id }));
    setError(
      receipt.diagnostics.join("; ") || "Posting was rejected. Recover the draft before editing.",
    );
  }

  /** A plan that was prepared: show it, and post it at once when there is nothing in it to read. */
  async function afterPrepare(prepared: PreparedOperation) {
    setPlan(prepared);
    setReviewed(canonical(data()));
    if (!prepared.valid || (prepared.warnings ?? []).length > 0) return;
    await completePosting(
      await application.write(
        "operations.commit",
        { planId: prepared.planId, planHash: prepared.planHash },
        "journal",
      ),
      prepared,
    );
  }

  async function completion(result: ApplicationCompletion) {
    switch (result.name) {
      case "drafts.create":
      case "drafts.save":
      case "drafts.recover":
        // A retained response is the original snapshot; another client may already have edited or posted
        // that version before recovery finishes.
        loadedDraft(await application.read("drafts.get", { draftId: result.data.id }));
        setPlan(null);
        toast.show({
          message: result.name === "drafts.recover" ? w.done.draftRecovered : w.done.draftSaved,
        });
        break;
      case "journal.prepare":
        await afterPrepare(result.data);
        break;
      case "operations.commit":
        await completePosting(result.data);
        break;
      case "drafts.discard":
        await navigate({ to: "/journal" });
        break;
      default:
        throw new Error("Unexpected request for an entry");
    }
  }

  async function work(kind: "draft" | "post" | "other", action: () => Promise<void>) {
    if (busy() !== null) return;
    setBusy(kind);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(messageOf(cause, "Request unavailable"));
    } finally {
      try {
        setPending(application.pending("journal"));
      } catch (cause) {
        setError(messageOf(cause, "Request unavailable"));
      }
      setBusy(null);
    }
  }

  /** Refuse, in words and with the way to the first thing to fix, an entry that is not ready for what was
   * asked of it. */
  function ready(purpose: "draft" | "post"): boolean {
    const found = entryProblems({
      date: shownDate(),
      description: description(),
      lines: lines(),
      source: { id: sourceId(), description: sourceDescription() },
      purpose,
    });
    // Posting is held to more than a draft: once it has been asked for, that is what stays listed.
    setAttempted((was) => (found.length > 0 ? (was === "post" ? "post" : purpose) : was));
    if (found.length > 0) setAttempt((count) => count + 1);
    return found.length === 0;
  }

  /** Save what is typed as a draft (a new one, or a new version of the one being edited). */
  async function persist(): Promise<SavedDraft> {
    const current = saved();
    const draft = current
      ? await application.write(
          "drafts.save",
          { draftId: current.id, expectedVersion: current.version, data: data() },
          "journal",
        )
      : await application.write("drafts.create", { data: data() }, "journal");
    loadedDraft(draft);
    return draft;
  }

  const saveDraft = () => {
    if (busy() !== null || !ready("draft")) return;
    void work("draft", async () => {
      await persist();
      setPlan(null);
      toast.show({ message: w.done.draftSaved });
    });
  };

  const post = () => {
    if (busy() !== null || !ready("post")) return;
    void work("post", async () => {
      const draft = await persist();
      await afterPrepare(
        await application.write(
          "journal.prepare",
          { draftId: draft.id, expectedVersion: draft.version },
          "journal",
        ),
      );
    });
  };

  const postReviewed = () => {
    const prepared = plan();
    if (!prepared?.valid || !reviewCurrent()) return;
    void work("post", async () => {
      // The plan is committed exactly as it was prepared, under its own hash.
      await completePosting(
        await application.write(
          "operations.commit",
          { planId: prepared.planId, planHash: prepared.planHash },
          "journal",
        ),
        prepared,
      );
    });
  };

  const resume = () =>
    void work("other", async () => completion(await application.resume("journal")));

  const recover = () =>
    void work("other", async () => {
      const draft = saved();
      if (!draft?.postingOperationId) return;
      const recovered = await application.write(
        "drafts.recover",
        {
          draftId: draft.id,
          expectedVersion: draft.version,
          postingOperationId: draft.postingOperationId,
        },
        "journal",
      );
      await completion({ name: "drafts.recover", data: recovered });
    });

  const resolveOriginal = () =>
    void work("other", async () => {
      const draft = saved();
      if (!draft?.postingOperationId) return;
      const status = await application.read("operations.get", {
        operationId: draft.postingOperationId,
      });
      if (
        status.disposition === "committed" ||
        status.disposition === "rejected" ||
        status.disposition === "unresolved"
      ) {
        await completePosting(
          await application.write(
            "operations.commit",
            { planId: draft.postingOperationId, planHash: status.planHash ?? "" },
            "journal",
          ),
        );
      } else toast.show({ message: w.done.uncertainRemains, tone: "attention" });
    });

  const discard = () =>
    void work("other", async () => {
      const draft = saved();
      if (!draft) return;
      await application.write(
        "drafts.discard",
        { draftId: draft.id, expectedVersion: draft.version },
        "journal",
      );
      await navigate({ to: "/journal" });
    });

  const inspectSource = (page = 1) =>
    void work("other", async () => {
      setSourceRecord(await application.read("sources.get", { sourceId: sourceId().trim(), page }));
    });

  const title = () => (opening ? w.openingTitle : saved() ? w.draftTitle : w.title);

  return (
    <section class="rt-acct-page rt-entry-page" aria-labelledby="new-journal-title">
      <PageHeader
        titleId="new-journal-title"
        title={title()}
        description={opening ? w.openingDescription : w.description}
        status={
          <Show when={saved()}>
            <Status>{ui.messages.status.Draft ?? w.draftChip}</Status>
          </Show>
        }
      />
      <Loading
        ready={setup.value() !== undefined || setup.error() !== undefined}
        shape="form"
        label={w.loading}
      >
        <Show
          when={setup.error() === undefined}
          fallback={
            <Notice title={w.bookFailedTitle} tone="problem" role="alert">
              <p>{w.bookFailedBody}</p>
              <Button variant="secondary" label={w.retry} onClick={() => void setup.reload()} />
            </Notice>
          }
        >
          <Show
            when={setup.value()}
            fallback={
              <Notice title={w.noBookTitle}>
                <p>{w.noBookBody}</p>
              </Notice>
            }
          >
            {(book) => (
              <form class="rt-entry-form" noValidate onSubmit={(event) => event.preventDefault()}>
                <Show when={problems().length > 0}>
                  <ErrorSummary
                    title={w.problems.title}
                    errors={problems().map((problem) => ({
                      id: problem.id,
                      message: problem.message,
                    }))}
                    attempt={attempt()}
                  />
                </Show>
                <div class="rt-entry-fields">
                  <DateField
                    id={entryIds.date}
                    label={w.fields.date}
                    required
                    disabled={locked()}
                    value={shownDate()}
                    onChange={(value) => setDate(value)}
                  />
                  <TextField
                    id={entryIds.description}
                    label={w.fields.description}
                    required
                    maxLength={1000}
                    disabled={locked()}
                    value={description()}
                    onInput={(event) => setDescription(event.currentTarget.value)}
                  />
                  <TextField
                    label={w.fields.reference}
                    maxLength={80}
                    disabled={locked()}
                    value={reference()}
                    onInput={(event) => setReference(event.currentTarget.value)}
                  />
                </div>
                <JournalLines
                  lines={lines()}
                  accounts={book().accounts}
                  problems={problemsById()}
                  disabled={locked()}
                  onChange={changeLine}
                  onAdd={() => {
                    const added = lines().length;
                    setLines((previous) => [...previous, blankEntryLine()]);
                    // The cursor goes to the account of the line that was added.
                    focusLater(entryIds.account(added));
                  }}
                  onRemove={(index) => {
                    const last = lines().length - 2;
                    setLines((previous) => previous.filter((_, position) => position !== index));
                    // It stays on the line that took the removed one's place (the one before, for the last).
                    focusLater(entryIds.account(Math.min(index, last)));
                  }}
                />
                <Show when={sourceId().trim() !== ""}>
                  <EntrySource
                    open={sourceOpen()}
                    onOpenChange={setSourceOpen}
                    sourceId={sourceId()}
                    description={sourceDescription()}
                    evidence={evidence()}
                    busy={busy() !== null}
                    onInspect={sourceRecord() ? undefined : () => inspectSource()}
                  >
                    <Show when={sourceRecord()}>
                      {(record) => (
                        <section aria-label={w.source.recordLabel} class="rt-entry-source">
                          <p>{w.source.status(record().status, record().drafts.count)}</p>
                          <Show when={record().postingOperationId}>
                            <p>{w.source.operation(record().postingOperationId as string)}</p>
                          </Show>
                          <ul>
                            <For each={record().drafts.drafts}>
                              {(draft) => (
                                <li>
                                  <AppLink
                                    href={`/journal/new?draft=${encodeURIComponent(draft.id)}`}
                                  >
                                    {w.source.draftLink(draft.id)}
                                  </AppLink>{" "}
                                  · {w.source.draftState(draft.status, draft.version)}
                                </li>
                              )}
                            </For>
                          </ul>
                          <Show when={record().drafts.count > record().drafts.pageSize}>
                            <p>{w.source.draftsPage(record().drafts.page)}</p>
                            <Button
                              variant="secondary"
                              size="sm"
                              label={w.source.previous}
                              disabled={busy() !== null || record().drafts.page <= 1}
                              onClick={() => inspectSource(record().drafts.page - 1)}
                            />
                            <Button
                              variant="secondary"
                              size="sm"
                              label={w.source.next}
                              disabled={
                                busy() !== null ||
                                record().drafts.page * record().drafts.pageSize >=
                                  record().drafts.count
                              }
                              onClick={() => inspectSource(record().drafts.page + 1)}
                            />
                          </Show>
                          <Show when={record().outcomeSequence}>
                            <p>{w.source.outcome(record().outcomeSequence as string)}</p>
                          </Show>
                          <For each={record().corrections}>
                            {(link) => (
                              <p>
                                {w.source.reversal}{" "}
                                <AppLink
                                  href={`/journal/${encodeURIComponent(link.correctionJournalId)}?revision=${record().bookRevision}`}
                                >
                                  {link.correctionPostingSequence
                                    ? ui.messages.register.entryNumber(
                                        link.correctionPostingSequence,
                                      )
                                    : link.correctionJournalId}
                                </AppLink>
                              </p>
                            )}
                          </For>
                          <Show when={record().status === "posted"}>
                            <p>
                              <AppLink
                                href={`/journal/${encodeURIComponent(record().journalId)}?revision=${record().bookRevision}`}
                              >
                                {w.source.viewEntry}
                              </AppLink>
                            </p>
                          </Show>
                        </section>
                      )}
                    </Show>
                  </EntrySource>
                </Show>
                <Show when={error()}>
                  <Notice title={w.review.problemTitle} tone="problem" role="alert">
                    <p>{error()}</p>
                  </Notice>
                </Show>
                <Show when={saved()?.recoveredFromOperationId}>
                  <p class="rt-hint">
                    {w.recovery.recovered(saved()?.recoveredFromOperationId as string)}
                  </p>
                </Show>
                <Show when={pending()}>
                  <Notice title={w.retained.title} tone="attention" role="status">
                    <p>{w.retained.body}</p>
                    <Button
                      variant="secondary"
                      label={w.retained.resume}
                      disabled={busy() !== null}
                      onClick={resume}
                    />
                  </Notice>
                </Show>
                <Show
                  when={
                    (saved()?.status === "rejected" || uncertain()) && saved()?.postingOperationId
                  }
                >
                  <div class="rt-entry-recovery">
                    <Button
                      variant="secondary"
                      label={w.recovery.recover}
                      disabled={busy() !== null || pending() !== null}
                      onClick={recover}
                    />
                    <Button
                      variant="secondary"
                      label={w.recovery.resolve}
                      disabled={busy() !== null || pending() !== null}
                      onClick={resolveOriginal}
                    />
                  </div>
                </Show>
                <Show when={plan()}>
                  {(prepared) => (
                    <section aria-label={w.review.table} class="rt-entry-review">
                      <Show when={!prepared().valid}>
                        <Notice title={w.review.problemTitle} tone="problem" role="alert">
                          <ul>
                            <For each={prepared().diagnostics}>{(line) => <li>{line}</li>}</For>
                          </ul>
                        </Notice>
                      </Show>
                      <Show when={(prepared().warnings ?? []).length > 0}>
                        <Notice title={w.review.warningsTitle} tone="attention" role="status">
                          <ul>
                            <For each={prepared().warnings}>
                              {(warning) => <li>{warning.message}</li>}
                            </For>
                          </ul>
                        </Notice>
                      </Show>
                      <For each={prepared().effects.journals}>
                        {(journal) => (
                          <>
                            <p>
                              <DateValue value={journal.date} /> · {journal.narration}
                            </p>
                            <table>
                              <thead>
                                <tr>
                                  <th scope="col">{w.review.columnAccount}</th>
                                  <th scope="col">{w.review.columnDebit}</th>
                                  <th scope="col">{w.review.columnCredit}</th>
                                </tr>
                              </thead>
                              <tbody>
                                <For each={journal.lines}>
                                  {(line) => (
                                    <tr>
                                      <th scope="row">
                                        {book().names.get(line.accountId) ?? line.accountId}
                                      </th>
                                      <td>
                                        <Money value={line.debit} />
                                      </td>
                                      <td>
                                        <Money value={line.credit} />
                                      </td>
                                    </tr>
                                  )}
                                </For>
                              </tbody>
                            </table>
                          </>
                        )}
                      </For>
                      <Show when={!reviewCurrent()}>
                        <p class="rt-hint">{w.review.changed}</p>
                      </Show>
                      <Show when={prepared().valid}>
                        <Button
                          label={w.review.postAnyway}
                          disabled={busy() !== null || pending() !== null || !reviewCurrent()}
                          onClick={postReviewed}
                        />
                      </Show>
                    </section>
                  )}
                </Show>
                <EntryBar
                  totals={totals()}
                  currency={book().currency}
                  busy={barBusy()}
                  blocked={pending() !== null || locked() || uncertain() || busy() === "other"}
                  canDiscard={saved()?.status === "draft" && !uncertain()}
                  cancelHref="/journal"
                  onSaveDraft={saveDraft}
                  onPost={post}
                  onDiscard={discard}
                />
              </form>
            )}
          </Show>
        </Show>
      </Loading>
    </section>
  );
}
