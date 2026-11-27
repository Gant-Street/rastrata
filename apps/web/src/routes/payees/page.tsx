import type { ApplicationOutputs } from "@rastrata/application/client-contracts";
import {
  defaultPayeesState,
  describeRange,
  ExportMenu,
  isUsableRange,
  localToday,
  PageHeader,
  PayeeControls,
  PayeeDrawer,
  type PayeeDirection,
  type PayeeFormValues,
  PayeeSheet,
  type PayeeSubject,
  PayeesReportView,
  type PayeesScreenState,
  type PayeeTestData,
  type PayeeUnnamedView,
  parsePayeesState,
  parsePayeeWords,
  payeeFormValues,
  payeeNameFormValues,
  payeeSaveFields,
  payeesWords,
  ReportState,
  serializePayeesState,
  type DateRangeValue,
  type ReportCalendar,
} from "@rastrata/ui";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js";
import { ApplicationRequestError, BrowserApplicationClient } from "../../application-client";
import { saveFile } from "../../download";
import { createKeyedLoader, createLoader } from "../../loader";
import { Failure } from "../reports/failure";
import {
  detailInput,
  entryHref,
  payeeInput,
  type Shared,
  safeDownloadName,
  saveInput,
  saveWorkflow,
  testInput,
  totalsInput,
  vendorsHref,
} from "./controller";

type Payee = NonNullable<ApplicationOutputs["payees.get"]["payee"]>;
type Detail = ApplicationOutputs["payees.get"];

const sameContent = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Whether a detail is what this subject asked for: while another row is being read, the one read before
 * it is not shown under the new row's name. */
function isSubjectOf(subject: PayeeSubject, detail: Detail | undefined): boolean {
  if (!detail) return false;
  const read = detail.subject;
  switch (subject.kind) {
    case "payee":
      return read.kind === "payee" && read.payeeId === subject.payeeId;
    case "unnamed":
      return read.kind === "unnamed" && read.key === subject.key;
    case "ambiguous":
      return read.kind === "ambiguous" && read.key === subject.key;
    case "no_payee":
      return read.kind === "no_payee" && read.why === subject.why;
  }
}

/** What the person is doing with the form: naming a payee out of a text nobody has named, or changing one. */
type Editing =
  | { readonly mode: "name"; readonly from: string; readonly initial: PayeeFormValues }
  | {
      readonly mode: "edit";
      readonly payee: Payee;
      readonly initial: PayeeFormValues;
    };

/** The By payee screen: who the book paid and was paid by, for some dates, with one name for each, and the
 * means to name a payee out of the texts nobody has named. It reads through the versioned `/v1` operations,
 * keeps its state (the dates, the side, the page and the payee that is open) in the address, and hands
 * everything it shows to the payees components. Naming or changing a payee changes which row a transaction
 * is in, never the transaction: the report is read again and still adds up to the profit and loss.
 *
 * Like the Reports screen it reads the current book and pins an older revision only when a link asked for
 * one: pinning replays history, which is slow in a large book. */
export function PayeesPage(): JSX.Element {
  const client = new BrowserApplicationClient(window.localStorage);
  const today = localToday();

  // Every read here is a loader, not a resource: see loader.ts for why a read may never suspend.
  const calendar = createLoader(() => client.read("reports.calendar", {}));
  const book = createLoader(() =>
    client.read("book.get", {}).then((context) => context.setup?.name ?? null),
  );
  const fiscal = createMemo(
    (): ReportCalendar => ({ years: calendar.value()?.fiscalYears ?? [], today }),
  );

  const [ready, setReady] = createSignal(false);
  const [state, setState] = createSignal<PayeesScreenState>(defaultPayeesState());
  const [notice, setNotice] = createSignal<string | undefined>();
  /** The row whose transactions are open, and the page of them. */
  const [subject, setSubject] = createSignal<PayeeSubject | null>(null);
  const [sheetPage, setSheetPage] = createSignal(1);
  const [editing, setEditing] = createSignal<Editing | null>(null);
  const [message, setMessage] = createSignal("");
  /** The button that opened a sheet, so focus goes back to it when the sheet closes. */
  let trigger: HTMLElement | null = null;
  /** The page's title takes focus when the page opens, so a screen reader starts at the title. */
  let heading: HTMLHeadingElement | undefined;
  onMount(() => heading?.focus());

  createEffect(() => {
    const loaded = calendar.value();
    if (!loaded || ready()) return;
    const parsed = parsePayeesState(window.location.search, {
      years: loaded.fiscalYears,
      today,
    });
    setState(parsed.state);
    setNotice(parsed.notice);
    // A link from the 1099 vendors opens the payee it names.
    if (parsed.state.payee !== undefined)
      setSubject({
        kind: "payee",
        payeeId: parsed.state.payee,
        label: payeesWords.payeeFallback,
      });
    setReady(true);
  });
  // The address follows the screen, so a reload, a link and the back button agree with it.
  createEffect(() => {
    if (!ready()) return;
    const open = subject();
    const query = serializePayeesState({
      ...state(),
      payee: open?.kind === "payee" ? open.payeeId : undefined,
    });
    const next = `${window.location.pathname}${query ? `?${query}` : ""}`;
    if (next !== `${window.location.pathname}${window.location.search}`)
      window.history.replaceState(window.history.state, "", next);
  });
  const update = (patch: Partial<PayeesScreenState>) =>
    setState((current) => ({ ...current, ...patch }));

  /** The dates every read shares, or nothing while they are not usable: a half-typed date, a range the
   * wrong way round or one outside the book's calendar is named by the date range itself and nothing is
   * requested for it. */
  const shared = createMemo(
    (): Shared | undefined => {
      if (!ready()) return undefined;
      const current = state();
      if (!isUsableRange(current.range, fiscal())) return undefined;
      return {
        asOf: current.range.to,
        from: current.range.from,
        ...(current.revision !== undefined ? { revision: current.revision } : {}),
      };
    },
    undefined,
    { equals: sameContent },
  );

  const reportKey = createMemo(
    () => {
      const dates = shared();
      return dates && totalsInput(state(), dates);
    },
    undefined,
    { equals: sameContent },
  );
  const report = createKeyedLoader(reportKey, (input) => client.read("payees.totals", input));

  const detailKey = createMemo(
    () => {
      const open = subject();
      const dates = shared();
      return open && dates ? detailInput(open, dates, sheetPage()) : undefined;
    },
    undefined,
    { equals: sameContent },
  );
  const detail = createKeyedLoader(detailKey, (input) => client.read("payees.get", input));
  const detailOfSubject = () => {
    const open = subject();
    const read = detail.value();
    return open && isSubjectOf(open, read) ? read : undefined;
  };

  const reloadAll = () => {
    void calendar.refresh();
    void report.refresh();
    void detail.refresh();
  };

  // ---- Opening a row ---------------------------------------------------------------------------

  /** Where focus goes back to when a sheet closes: the button that opened it. A button inside a sheet goes with
   * the sheet, so naming or changing a payee from one leaves what opened the sheet as the place to return to. */
  const remember = () => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && !active.closest('[role="dialog"]')) trigger = active;
  };
  const open = (next: PayeeSubject) => {
    remember();
    setSheetPage(1);
    setSubject(next);
  };
  const closeSheet = () => {
    setSubject(null);
    setSheetPage(1);
  };
  // ---- Trying words ----------------------------------------------------------------------------

  const [test, setTest] = createSignal<PayeeTestData | undefined>();
  const [checking, setChecking] = createSignal(false);
  const [checkFailed, setCheckFailed] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let asking: AbortController | undefined;
  let turn = 0;
  const stopChecking = () => {
    clearTimeout(timer);
    asking?.abort();
    turn += 1;
  };
  onCleanup(stopChecking);
  /** What these words find, asked after a pause in typing: a request for each keystroke would be many
   * and the answer to the last is the only one wanted. */
  function wordsChanged(text: string): void {
    stopChecking();
    const sets = parsePayeeWords(text);
    if (sets.length === 0) {
      setTest(undefined);
      setChecking(false);
      setCheckFailed(false);
      return;
    }
    setChecking(true);
    const mine = turn;
    timer = setTimeout(() => {
      const dates = shared();
      const current = editing();
      if (!dates) return;
      asking = new AbortController();
      client
        .read(
          "payees.test",
          testInput(sets, dates, current?.mode === "edit" ? current.payee.id : undefined),
          {
            signal: asking.signal,
          },
        )
        .then((found) => {
          if (mine !== turn) return;
          setTest(found);
          setCheckFailed(false);
        })
        .catch(() => {
          if (mine === turn) setCheckFailed(true);
        })
        .finally(() => {
          if (mine === turn) setChecking(false);
        });
    }, 350);
  }

  // ---- Naming and changing a payee -------------------------------------------------------------

  const [saving, setSaving] = createSignal(false);
  const [failure, setFailure] = createSignal<string | undefined>();
  const [uncertain, setUncertain] = createSignal(false);

  const resetForm = () => {
    stopChecking();
    setTest(undefined);
    setChecking(false);
    setCheckFailed(false);
    setFailure(undefined);
    setUncertain(false);
    setSaving(false);
  };
  /** A save whose reply was lost is still waiting in this browser: pressing Save sends that one again. */
  const waiting = (changing: { id: string } | null): boolean => {
    try {
      return client.pending(saveWorkflow(changing)) !== null;
    } catch {
      return false;
    }
  };
  /** A sheet that hands over to the form lets go of focus first (it gives it back to the button that opened it);
   * the form opens after that, or it would see focus leave it and close. */
  const afterSheet = (next: () => void) => {
    if (subject() === null) return next();
    closeSheet();
    requestAnimationFrame(() => setTimeout(next, 0));
  };
  function startNaming(row: PayeeUnnamedView): void {
    remember();
    afterSheet(() => {
      resetForm();
      setEditing({
        mode: "name",
        from: row.text,
        initial: payeeNameFormValues(row.suggestedWords),
      });
      setUncertain(waiting(null));
    });
  }
  async function startChanging(payeeId: string): Promise<void> {
    const dates = shared();
    if (!dates) return;
    remember();
    try {
      const read = await client.read("payees.get", payeeInput(payeeId, dates));
      const payee = read.payee;
      if (!payee) return;
      afterSheet(() => {
        resetForm();
        setEditing({ mode: "edit", payee, initial: payeeFormValues(payee) });
        setUncertain(waiting(payee));
      });
    } catch (cause) {
      setMessage(failureText(cause, payeesWords.openFailed));
    }
  }
  const closeForm = () => {
    resetForm();
    setEditing(null);
  };

  async function save(values: PayeeFormValues): Promise<void> {
    const current = editing();
    if (!current) return;
    const changing = current.mode === "edit" ? current.payee : null;
    const workflow = saveWorkflow(changing);
    setFailure(undefined);
    setSaving(true);
    try {
      const done = uncertain()
        ? (await client.resume(workflow)).data
        : await client.write("payees.save", saveInput(payeeSaveFields(values), changing), workflow);
      const saved = (done as ApplicationOutputs["payees.save"]).payee;
      const moved = test()?.matches.transactions ?? 0;
      setMessage(
        current.mode === "edit"
          ? payeesWords.savedChanged(saved.name)
          : moved > 0
            ? payeesWords.savedMoved(saved.name, moved)
            : payeesWords.saved(saved.name),
      );
      resetForm();
      setEditing(null);
      await Promise.all([report.reload(), subject() ? detail.reload() : Promise.resolve()]);
      focusPayee(saved.id);
    } catch (cause) {
      if (cause instanceof ApplicationRequestError && cause.uncertain) setUncertain(true);
      else setFailure(failureText(cause, payeesWords.saveFailed));
    } finally {
      setSaving(false);
    }
  }
  /** The button that opened the form is gone once its row has moved: focus goes to the payee that was
   * named, where the row now is, or else to the part of the page it is in. */
  function focusPayee(payeeId: string): void {
    queueMicrotask(() =>
      requestAnimationFrame(() => {
        const row = document.querySelector<HTMLElement>(
          `[data-payee-row="${CSS.escape(payeeId)}"] button`,
        );
        const part = document.querySelector<HTMLElement>('[data-payees-part="payees"]');
        (row ?? part)?.focus();
      }),
    );
  }

  // ---- Files -----------------------------------------------------------------------------------

  const [exporting, setExporting] = createSignal(false);
  async function download(file: "summary" | "transactions"): Promise<void> {
    const dates = shared();
    if (!dates || exporting()) return;
    setExporting(true);
    setMessage(payeesWords.exporting);
    try {
      const made = await client.read("payees.export", {
        asOf: dates.asOf,
        from: dates.from,
        ...(dates.revision !== undefined ? { revision: dates.revision } : {}),
        file,
      });
      const name = safeDownloadName(made.filename);
      // UTF-8 with a byte order mark, so a spreadsheet reads accented names correctly. The service's file
      // has none; this is only for the download.
      saveFile(new Blob(["﻿", made.content], { type: made.mediaType }), name);
      setMessage(payeesWords.exported(name));
    } catch (cause) {
      setMessage(
        `${payeesWords.exportFailed}${cause instanceof ApplicationRequestError ? ` ${cause.message}` : ""}`,
      );
    } finally {
      setExporting(false);
    }
  }

  const announcement = () => {
    const dates = shared();
    return dates && report.value() && !report.loading()
      ? `${payeesWords.title}, ${describeRange({ from: dates.from, to: dates.asOf })}.`
      : "";
  };

  return (
    <section class="app-payees" aria-labelledby="payees-title">
      <PageHeader
        titleId="payees-title"
        titleRef={(element) => {
          heading = element;
        }}
        title={payeesWords.title}
        description={payeesWords.description}
      />
      <Show
        when={calendar.value() !== undefined || calendar.error() !== undefined}
        fallback={<ReportState state="loading" what={payeesWords.loadingBook} />}
      >
        <Show
          when={calendar.error() === undefined}
          fallback={<Failure error={calendar.error()} retry={reloadAll} />}
        >
          <Show when={ready()}>
            <Show when={notice()}>
              <p class="rt-hint" role="status">
                {notice()}
              </p>
            </Show>
            <Show when={state().revision}>
              <p class="rt-hint">{payeesWords.pinned}</p>
            </Show>
            <PayeeControls
              calendar={fiscal()}
              range={state().range}
              onRange={(range: DateRangeValue) => update({ range, page: 1 })}
              direction={state().direction}
              onDirection={(direction: PayeeDirection) => update({ direction, page: 1 })}
            >
              <ExportMenu
                label={payeesWords.export}
                disabled={!shared()}
                actions={[
                  {
                    id: "summary",
                    label: payeesWords.exportSummary,
                    disabled: exporting(),
                    onSelect: () => void download("summary"),
                  },
                  {
                    id: "transactions",
                    label: payeesWords.exportTransactions,
                    disabled: exporting(),
                    onSelect: () => void download("transactions"),
                  },
                  { id: "print", label: payeesWords.print, onSelect: () => window.print() },
                ]}
              />
            </PayeeControls>
            <Show when={shared()} fallback={<p class="rt-hint">{payeesWords.chooseDates}</p>}>
              <Show
                when={report.error() === undefined}
                fallback={<Failure error={report.error()} retry={() => void report.reload()} />}
              >
                <Show
                  when={report.value()}
                  fallback={<ReportState state="loading" what={payeesWords.loading} />}
                >
                  {(data) => (
                    <PayeesReportView
                      data={data()}
                      bookName={book.value() ?? undefined}
                      busy={report.loading()}
                      onOpen={open}
                      onName={startNaming}
                      onChange={(payeeId) => void startChanging(payeeId)}
                      onPage={(page) => update({ page })}
                    />
                  )}
                </Show>
              </Show>
            </Show>
            <p class="rt-sr-only" role="status" aria-live="polite">
              {announcement()}
            </p>
            <p class="rt-hint rt-payees-message" role="status" aria-live="polite">
              {message()}
            </p>

            <Show when={subject()} keyed>
              {(current) => (
                <PayeeSheet
                  subject={current}
                  detail={detailOfSubject()}
                  loading={detail.loading()}
                  failure={
                    detail.error() === undefined
                      ? undefined
                      : failureText(detail.error(), payeesWords.sheetFailed)
                  }
                  onRetry={() => void detail.reload()}
                  onPage={setSheetPage}
                  entryHref={entryHref}
                  onChange={(payeeId) => void startChanging(payeeId)}
                  onName={
                    current.kind === "unnamed"
                      ? () => startNaming(namingRow(current, report.value()?.unnamed ?? []))
                      : undefined
                  }
                  taxHref={vendorsHref(taxYearOf(shared()))}
                  onClose={closeSheet}
                  returnFocus={() => trigger}
                />
              )}
            </Show>
            <Show when={editing()} keyed>
              {(form) => (
                <PayeeDrawer
                  mode={form.mode}
                  from={form.mode === "name" ? form.from : undefined}
                  initial={form.initial}
                  hasTaxDetails={form.mode === "edit" ? form.payee.hasTaxDetails : false}
                  test={test()}
                  checking={checking()}
                  checkFailed={checkFailed()}
                  onWords={wordsChanged}
                  saving={saving()}
                  failure={failure()}
                  uncertain={uncertain()}
                  onSave={(values) => void save(values)}
                  onClose={closeForm}
                  returnFocus={() => trigger}
                />
              )}
            </Show>
          </Show>
        </Show>
      </Show>
    </section>
  );
}

/** What the service said, in words a person can act on: its own messages are written for a person, so they
 * are shown as they are; anything else is said plainly. */
function failureText(error: unknown, fallback: string): string {
  if (!(error instanceof ApplicationRequestError)) return fallback;
  // The service's own sentence for a payee that is not there names an operation, which is for programs, and
  // a link that names a payee this book does not have is a person's; and for a payee changed since the form
  // was opened it says to read it again, which on this screen is to close the form and open it again. Both
  // are said in the screen's words.
  if (error.code === "payee_not_found") return payeesWords.payeeNotFound;
  if (error.code === "payee_version_conflict") return payeesWords.changedMeanwhile;
  return error.message;
}

/** The unnamed row a sheet is about, so naming from the sheet offers the same words as naming from the row.
 * When the row is no longer on the page (the report moved), the sheet's own text is all there is. */
function namingRow(
  subject: Extract<PayeeSubject, { kind: "unnamed" }>,
  rows: readonly PayeeUnnamedView[],
): PayeeUnnamedView {
  return (
    rows.find((row) => row.key === subject.key) ?? {
      key: subject.key,
      text: subject.label,
      suggestedWords: subject.suggestedWords,
      received: "0.00",
      spent: "0.00",
      net: "0.00",
      transactions: 0,
      firstOn: "",
      lastOn: "",
    }
  );
}

/** The tax year the dates are in, for the link to the 1099 vendors. */
function taxYearOf(dates: Shared | undefined): number | undefined {
  const year = dates ? Number(dates.asOf.slice(0, 4)) : Number.NaN;
  return Number.isInteger(year) ? year : undefined;
}
