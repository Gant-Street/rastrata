import type { ApplicationInputs, ApplicationOutputs } from "@rastrata/application/client-contracts";
import type {
  AtStepView,
  ChartStepView,
  DateOrder,
  ReconciledStepView,
  TbStepView,
  XeroScreenProps,
} from "@rastrata/ui/shadow/types";
import { xeroWords as words } from "@rastrata/ui";
import { batch, createEffect, createMemo, createSignal, on, onMount } from "solid-js";
import { ApplicationRequestError, type BrowserApplicationClient } from "../../application-client";
import { createKeyedLoader, createLoader } from "../../loader.ts";
import { leaveHandoff } from "./handoff";
import { isNoBook } from "./no-book";
import {
  atBlocks,
  canKeepTrialBalance,
  canUseAsOpening,
  chartPreviewView,
  columnViews,
  cutoverNote,
  type Decisions,
  isDateText,
  mappingChoices,
  MAX_FILE_CHARACTERS,
  MAX_REQUEST_TEXT_BYTES,
  overridesFrom,
  reconciledChanges,
  reconciledRows,
  requestBytes,
  statusView,
  tbRows,
  xeroIssues,
} from "./xero-logic";

/** The workflows this screen retains writes under, so a lost reply is resumed, never repeated. */
export const CHART_WORKFLOW = "shadow:xero-chart";
export const MAPPING_WORKFLOW = "shadow:xero-mapping";
export const TB_WORKFLOW = "shadow:xero-trial-balance";
export const AT_WORKFLOW = "shadow:xero-transactions";
export const RECONCILED_WORKFLOW = "shadow:xero-reconciled";
const WORKFLOWS = [
  CHART_WORKFLOW,
  MAPPING_WORKFLOW,
  TB_WORKFLOW,
  AT_WORKFLOW,
  RECONCILED_WORKFLOW,
] as const;

type ChartPreview = ApplicationOutputs["xero.chart.preview"];
type TbPreview = ApplicationOutputs["xero.trialBalance.preview"];
type AtPreview = ApplicationOutputs["xero.transactions.preview"];

const messageOf = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message ? cause.message : fallback;
const isUncertain = (cause: unknown): boolean =>
  cause instanceof ApplicationRequestError && cause.uncertain;
/** Why reading a file failed, in the service's words: its own problems with the file are listed in
 * the preview, so this is a request that did not complete. */
const previewFailed = (cause: unknown): string =>
  `${words.fileNotRead} ${messageOf(cause, "")}`.trim();

interface ChosenFile {
  readonly name: string;
  readonly text: string;
}

/** Read a file the person chose, as text, within what one request carries. */
async function readFile(file: File): Promise<{ file: ChosenFile } | { error: string }> {
  if (file.size > MAX_FILE_CHARACTERS * 4) return { error: words.fileTooLarge };
  let text: string;
  try {
    text = await file.text();
  } catch {
    return { error: words.fileUnreadable };
  }
  if (text.length > MAX_FILE_CHARACTERS || requestBytes(text) > MAX_REQUEST_TEXT_BYTES)
    return { error: words.fileTooLarge };
  if (text.includes("\u0000")) return { error: words.fileUnreadable };
  return { file: { name: file.name.slice(0, 200), text } };
}

/** One file step: the file, how it is being read, and why it could not be. */
function createFileStep() {
  const [file, setFile] = createSignal<ChosenFile | null>(null);
  const [reading, setReading] = createSignal(false);
  const [error, setError] = createSignal("");
  async function choose(chosen: File) {
    setReading(true);
    setError("");
    const result = await readFile(chosen);
    batch(() => {
      if ("file" in result) setFile(result.file);
      else setError(result.error);
      setReading(false);
    });
  }
  return { file, reading, error, choose, clear: () => setFile(null) };
}

/** Import from Xero: four steps, each reading a file and showing it before anything is kept. The
 * screen renders; this decides. Nothing is kept until a person chooses to keep it, and a lost reply
 * is resumed, never repeated. */
export function createXeroController(client: BrowserApplicationClient) {
  const accounts = createLoader(() => client.read("accounts.list", {}));
  const status = createLoader(() => client.read("xero.status", {}));
  const choices = createMemo(() => mappingChoices(accounts.value()?.accounts ?? []));
  const [pageError, setPageError] = createSignal("");
  const [pending, setPending] = createSignal<string | null>(null);
  const [resuming, setResuming] = createSignal(false);
  const syncPending = () => {
    try {
      setPending(WORKFLOWS.find((workflow) => client.pending(workflow) !== null) ?? null);
    } catch {
      setPending(null);
    }
  };
  onMount(syncPending);

  // ---- Step 1: the chart ----
  const chartFile = createFileStep();
  const [decisions, setDecisions] = createSignal<Decisions>({});
  const [acceptLikely, setAcceptLikely] = createSignal(true);
  const [chartSkip, setChartSkip] = createSignal(false);
  const [chartKeeping, setChartKeeping] = createSignal(false);
  const [chartMessage, setChartMessage] = createSignal("");
  const [chartError, setChartError] = createSignal("");
  // A preview is asked for a file, never for a choice: what the person decides is applied on the
  // screen at once and sent when they keep the mapping, and a row does not move while it is decided.
  const chartAsk = createMemo(
    () => ({ text: chartFile.file()?.text, name: chartFile.file()?.name }),
    undefined,
    { equals: (a, b) => a.text === b.text && a.name === b.name },
  );
  const chartPreview = createKeyedLoader(chartAsk, async (ask): Promise<ChartPreview | null> => {
    try {
      return await client.read("xero.chart.preview", {
        ...(ask.text !== undefined ? { text: ask.text, name: ask.name } : {}),
      } as ApplicationInputs["xero.chart.preview"]);
    } catch (cause) {
      // No chart has been imported and no file chosen: there is nothing to show yet.
      if (
        ask.text === undefined &&
        cause instanceof ApplicationRequestError &&
        cause.code === "xero_chart_missing"
      )
        return null;
      throw cause;
    }
  });
  // The chart as stored, apart from any file being looked at: where Xero was reconciled is asked
  // for the bank accounts the service already knows.
  const stored = createLoader(async (): Promise<ChartPreview | null> => {
    try {
      return await client.read("xero.chart.preview", {});
    } catch (cause) {
      if (cause instanceof ApplicationRequestError && cause.code === "xero_chart_missing")
        return null;
      throw cause;
    }
  });
  // Decisions were made about one file's accounts: a different file starts again.
  createEffect(
    on(
      () => chartFile.file(),
      () => setDecisions({}),
      { defer: true },
    ),
  );
  const chartIssues = () => chartPreview.value()?.issues ?? [];
  const chartUnreadable = () => chartIssues().filter((issue) => issue.severity === "error").length;

  async function keepChart() {
    const file = chartFile.file();
    if (chartKeeping()) return;
    setChartKeeping(true);
    setChartError("");
    setChartMessage("");
    try {
      if (file) {
        const saved = await client.write(
          "xero.chart.import",
          {
            text: file.text,
            name: file.name,
            ...(decisions() && overridesFrom(decisions()).length > 0
              ? { overrides: overridesFrom(decisions()) }
              : {}),
            accept: acceptLikely() ? "likely" : "certain",
            ...(chartSkip() ? { skipUnreadable: true } : {}),
          },
          CHART_WORKFLOW,
        );
        batch(() => {
          chartFile.clear();
          setDecisions({});
          setChartSkip(false);
          setChartMessage(words.mappingKept(saved.saved));
        });
      } else {
        const saved = await client.write(
          "xero.mapping.set",
          { choices: overridesFrom(decisions()) },
          MAPPING_WORKFLOW,
        );
        batch(() => {
          setDecisions({});
          setChartMessage(words.mappingKept(saved.saved));
        });
      }
      await Promise.all([status.reload(), chartPreview.reload(), stored.reload()]);
    } catch (cause) {
      if (!isUncertain(cause)) setChartError(messageOf(cause, words.requestFailed));
    } finally {
      syncPending();
      setChartKeeping(false);
    }
  }

  // The views are made when what they show changes (a new reading, a new choice), not whenever any
  // flag on the screen does: a list made again is a list the page redraws, and a redrawn page drops
  // the focus and the groups a person opened.
  const chartView = createMemo(() => {
    const preview = chartPreview.value();
    return preview ? chartPreviewView(preview, decisions()) : null;
  });
  const chartStep = createMemo((): ChartStepView => {
    const preview = chartPreview.value();
    return {
      fileName: chartFile.file()?.name ?? null,
      busy: chartFile.reading() || chartPreview.loading(),
      ...(chartFile.error() || (chartPreview.error() && chartFile.file())
        ? { fileError: chartFile.error() || previewFailed(chartPreview.error()) }
        : {}),
      onFile: (file) => void chartFile.choose(file),
      preview: chartView(),
      choices: choices(),
      onChoose: (code, value) => setDecisions({ ...decisions(), [code]: value }),
      acceptLikely: acceptLikely(),
      onAcceptLikely: setAcceptLikely,
      keep: {
        pending: chartKeeping(),
        canKeep:
          !chartFile.reading() &&
          !chartPreview.loading() &&
          preview !== null &&
          preview !== undefined &&
          (chartFile.file() !== null
            ? preview.source === "file"
            : preview.source === "stored" && overridesFrom(decisions()).length > 0) &&
          (chartUnreadable() === 0 || chartSkip()),
        ...(chartMessage() ? { message: chartMessage() } : {}),
        ...(chartError() ? { error: chartError() } : {}),
        unreadable: chartFile.file() ? chartUnreadable() : 0,
        skipUnreadable: chartSkip(),
        onSkipUnreadable: setChartSkip,
        onKeep: () => void keepChart(),
      },
    };
  });

  // ---- Step 2: the trial balance ----
  const tbFile = createFileStep();
  const [tbOrder, setTbOrder] = createSignal<DateOrder>("mdy");
  const [includePl, setIncludePl] = createSignal(false);
  const [tbSkip, setTbSkip] = createSignal(false);
  const [tbKeeping, setTbKeeping] = createSignal(false);
  const [tbMessage, setTbMessage] = createSignal("");
  const [tbError, setTbError] = createSignal("");
  const tbAsk = createMemo(
    () => {
      const file = tbFile.file();
      return file
        ? { text: file.text, name: file.name, order: tbOrder(), includePl: includePl() }
        : undefined;
    },
    undefined,
    {
      equals: (a, b) =>
        a === b ||
        (a !== undefined &&
          b !== undefined &&
          a.text === b.text &&
          a.name === b.name &&
          a.order === b.order &&
          a.includePl === b.includePl),
    },
  );
  const tbInput = (ask: NonNullable<ReturnType<typeof tbAsk>>) => ({
    text: ask.text,
    name: ask.name,
    dateOrder: ask.order,
    ...(ask.includePl ? { includeProfitLoss: true } : {}),
  });
  const tbPreview = createKeyedLoader(tbAsk, (ask) =>
    client.read("xero.trialBalance.preview", tbInput(ask)),
  );
  const tbUnreadable = () =>
    (tbPreview.value()?.issues ?? []).filter((issue) => issue.severity === "error").length;

  async function keepTrialBalance() {
    const ask = tbAsk();
    if (!ask || tbKeeping()) return;
    setTbKeeping(true);
    setTbError("");
    setTbMessage("");
    try {
      await client.write(
        "xero.trialBalance.import",
        { ...tbInput(ask), ...(tbSkip() ? { skipUnreadable: true } : {}) },
        TB_WORKFLOW,
      );
      setTbMessage(words.fileKept(ask.name));
      await status.reload();
    } catch (cause) {
      if (!isUncertain(cause)) setTbError(messageOf(cause, words.requestFailed));
    } finally {
      syncPending();
      setTbKeeping(false);
    }
  }

  /** Hand the mapped balances to the opening balances screen, which reviews them before anything
   * is posted. */
  function useAsOpening() {
    const preview = tbPreview.value();
    if (tbPreview.loading() || !canUseAsOpening(preview) || !preview) return;
    const left = leaveHandoff({
      asOf: preview.asOf,
      balances: preview.balances.map((entry) => ({
        accountId: entry.accountId,
        balance: entry.balance,
      })),
    });
    if (!left) {
      setTbError(words.requestFailed);
      return;
    }
    window.location.assign("/opening");
  }

  const tbView = createMemo((): TbStepView["preview"] => {
    const preview = tbPreview.value() as TbPreview | undefined;
    return preview
      ? {
          asOf: preview.asOf,
          balanced: preview.balanced,
          rows: tbRows(preview),
          issues: xeroIssues(preview.issues),
          leftOut: {
            profitLoss: preview.leftOut.profitLoss,
            unmapped: preview.leftOut.unmapped,
            skipped: preview.leftOut.skipped,
            retainedEarnings: preview.leftOut.retainedEarnings,
          },
          cutoverNote: cutoverNote(preview),
          asOfIsDayBefore: preview.cutover?.asOfIsDayBefore === true,
          columns: columnViews(preview.columns),
        }
      : null;
  });
  const tbStep = createMemo((): TbStepView => {
    const preview = tbPreview.value() as TbPreview | undefined;
    return {
      fileName: tbFile.file()?.name ?? null,
      busy: tbFile.reading() || tbPreview.loading(),
      ...(tbFile.error() || tbPreview.error()
        ? { fileError: tbFile.error() || previewFailed(tbPreview.error()) }
        : {}),
      onFile: (file) => void tbFile.choose(file),
      dateOrder: tbOrder(),
      onDateOrder: setTbOrder,
      includeProfitLoss: includePl(),
      onIncludeProfitLoss: setIncludePl,
      preview: tbView(),
      keep: {
        pending: tbKeeping(),
        canKeep:
          !tbFile.reading() &&
          !tbPreview.loading() &&
          canKeepTrialBalance(preview) &&
          (tbUnreadable() === 0 || tbSkip()),
        ...(tbMessage() ? { message: tbMessage() } : {}),
        ...(tbError() ? { error: tbError() } : {}),
        unreadable: tbUnreadable(),
        skipUnreadable: tbSkip(),
        onSkipUnreadable: setTbSkip,
        onKeep: () => void keepTrialBalance(),
      },
      canUseAsOpening: !tbFile.reading() && !tbPreview.loading() && canUseAsOpening(preview),
      onUseAsOpening: useAsOpening,
    };
  });

  // ---- Step 3: the account transactions ----
  const atFile = createFileStep();
  const [atOrder, setAtOrder] = createSignal<DateOrder>("mdy");
  const [atSkip, setAtSkip] = createSignal(false);
  const [atKeeping, setAtKeeping] = createSignal(false);
  const [atMessage, setAtMessage] = createSignal("");
  const [atError, setAtError] = createSignal("");
  const atAsk = createMemo(
    () => {
      const file = atFile.file();
      return file ? { text: file.text, name: file.name, order: atOrder() } : undefined;
    },
    undefined,
    {
      equals: (a, b) =>
        a === b ||
        (a !== undefined &&
          b !== undefined &&
          a.text === b.text &&
          a.name === b.name &&
          a.order === b.order),
    },
  );
  const atInput = (ask: NonNullable<ReturnType<typeof atAsk>>) => ({
    text: ask.text,
    name: ask.name,
    dateOrder: ask.order,
  });
  const atPreview = createKeyedLoader(atAsk, (ask) =>
    client.read("xero.transactions.preview", atInput(ask)),
  );
  const atUnreadable = () =>
    (atPreview.value()?.issues ?? []).filter((issue) => issue.severity === "error").length;

  async function keepTransactions() {
    const ask = atAsk();
    if (!ask || atKeeping()) return;
    setAtKeeping(true);
    setAtError("");
    setAtMessage("");
    try {
      await client.write(
        "xero.transactions.import",
        { ...atInput(ask), ...(atSkip() ? { skipUnreadable: true } : {}) },
        AT_WORKFLOW,
      );
      setAtMessage(words.fileKept(ask.name));
      await status.reload();
    } catch (cause) {
      if (!isUncertain(cause)) setAtError(messageOf(cause, words.requestFailed));
    } finally {
      syncPending();
      setAtKeeping(false);
    }
  }

  const atView = createMemo((): AtStepView["preview"] => {
    const preview = atPreview.value() as AtPreview | undefined;
    return preview
      ? {
          periodFrom: preview.periodFrom,
          periodTo: preview.periodTo,
          lineCount: preview.lineCount,
          blocks: atBlocks(preview),
          issues: xeroIssues(preview.issues),
          columns: columnViews(preview.columns),
        }
      : null;
  });
  const atStep = createMemo((): AtStepView => {
    const preview = atPreview.value() as AtPreview | undefined;
    return {
      fileName: atFile.file()?.name ?? null,
      busy: atFile.reading() || atPreview.loading(),
      ...(atFile.error() || atPreview.error()
        ? { fileError: atFile.error() || previewFailed(atPreview.error()) }
        : {}),
      onFile: (file) => void atFile.choose(file),
      dateOrder: atOrder(),
      onDateOrder: setAtOrder,
      preview: atView(),
      keep: {
        pending: atKeeping(),
        canKeep:
          !atFile.reading() &&
          !atPreview.loading() &&
          preview !== undefined &&
          preview.blocks.length > 0 &&
          (atUnreadable() === 0 || atSkip()),
        ...(atMessage() ? { message: atMessage() } : {}),
        ...(atError() ? { error: atError() } : {}),
        unreadable: atUnreadable(),
        skipUnreadable: atSkip(),
        onSkipUnreadable: setAtSkip,
        onKeep: () => void keepTransactions(),
      },
    };
  });

  // ---- Step 4: where Xero was reconciled ----
  const [typed, setTyped] = createSignal<Readonly<Record<string, string>>>({});
  const [datesSaving, setDatesSaving] = createSignal(false);
  const [datesMessage, setDatesMessage] = createSignal("");
  const [datesError, setDatesError] = createSignal("");
  const savedDates = () => status.value()?.reconciled ?? [];
  const bankChart = () => stored.value() ?? undefined;
  const dateRows = createMemo(() => reconciledRows(bankChart(), savedDates(), typed()));
  const changes = createMemo(() =>
    reconciledChanges(
      savedDates(),
      Object.fromEntries(dateRows().map((row) => [row.code, row.through])),
    ),
  );

  async function saveDates() {
    const wanted = changes();
    if (datesSaving() || wanted.bad.length > 0) return;
    if (wanted.choices.length === 0 && wanted.clear.length === 0) return;
    setDatesSaving(true);
    setDatesError("");
    setDatesMessage("");
    try {
      await client.write(
        "xero.reconciled.set",
        {
          choices: wanted.choices,
          ...(wanted.clear.length > 0 ? { clear: wanted.clear } : {}),
        },
        RECONCILED_WORKFLOW,
      );
      batch(() => {
        setTyped({});
        setDatesMessage(words.reconciledSaved);
      });
      await status.reload();
    } catch (cause) {
      if (!isUncertain(cause)) setDatesError(messageOf(cause, words.requestFailed));
    } finally {
      syncPending();
      setDatesSaving(false);
    }
  }

  const reconciledStep = createMemo(
    (): ReconciledStepView => ({
      rows: dateRows().map((row) => ({
        code: row.code,
        name: row.name,
        through: row.through,
        ...(row.through !== "" && !isDateText(row.through)
          ? { error: "Use a date, YYYY-MM-DD." }
          : {}),
      })),
      onThrough: (code, value) => setTyped({ ...typed(), [code]: value }),
      save: {
        pending: datesSaving(),
        canSave:
          changes().bad.length === 0 &&
          (changes().choices.length > 0 || changes().clear.length > 0),
        ...(datesMessage() ? { message: datesMessage() } : {}),
        ...(datesError() ? { error: datesError() } : {}),
        onSave: () => void saveDates(),
      },
    }),
  );

  async function resume() {
    const workflow = pending();
    if (!workflow || resuming()) return;
    setResuming(true);
    setPageError("");
    try {
      await client.resume(workflow);
      batch(() => {
        if (workflow === CHART_WORKFLOW) {
          chartFile.clear();
          setDecisions({});
        }
      });
      await Promise.all([status.reload(), chartPreview.reload(), stored.reload()]);
    } catch (cause) {
      if (!isUncertain(cause)) setPageError(messageOf(cause, "The request could not be resumed."));
    } finally {
      syncPending();
      setResuming(false);
    }
  }

  const statusMemo = createMemo(() => {
    const read = status.value();
    return read ? statusView(read) : null;
  });
  const props = createMemo(
    (): XeroScreenProps => ({
      state:
        status.error() !== undefined || accounts.error() !== undefined
          ? "error"
          : status.value() && accounts.value()
            ? "ready"
            : "loading",
      noBook: isNoBook(status.error(), accounts.error()),
      onRetry: () => void Promise.all([status.reload(), accounts.reload()]),
      focusTitle: true,
      ...(pageError() ? { error: pageError() } : {}),
      uncertain: pending() ? { resuming: resuming() } : null,
      onResume: () => void resume(),
      status: statusMemo(),
      chart: chartStep(),
      trialBalance: tbStep(),
      transactions: atStep(),
      reconciled: reconciledStep(),
      links: { tieout: "/tie-out", opening: "/opening" },
    }),
  );
  return { props };
}
