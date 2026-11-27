import type { ApplicationInputs } from "@rastrata/application/client-contracts";
import type { TieoutScreenProps } from "@rastrata/ui/shadow/types";
import { createMemo, createSignal, onMount } from "solid-js";
import { ApplicationRequestError, type BrowserApplicationClient } from "../../application-client";
import { createLoader } from "../../loader.ts";
import { isNoBook } from "./no-book";
import { readTolerance, tieoutView } from "./xero-logic";

/** The workflow this screen retains its one write under, so a lost reply is resumed, never repeated. */
export const TIEOUT_RECORD_WORKFLOW = "shadow:tieout-record";

const messageOf = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message ? cause.message : fallback;
const isUncertain = (cause: unknown): boolean =>
  cause instanceof ApplicationRequestError && cause.uncertain;
const isDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value);
/** The service refuses a comparison until a Xero chart is imported and mapped: that is "import first", not a
 * failure of the read. */
const isXeroMissing = (cause: unknown): boolean =>
  cause instanceof ApplicationRequestError && cause.code === "xero_chart_missing";

/** The comparison with Xero: the months to compare, the report the service works out, and recording
 * what it found in the gap log. Reading changes nothing; recording adds each finding once. */
export function createTieoutController(client: BrowserApplicationClient) {
  const [from, setFrom] = createSignal("");
  const [to, setTo] = createSignal("");
  const [tolerance, setTolerance] = createSignal("");
  const [toleranceError, setToleranceError] = createSignal("");
  const [pageError, setPageError] = createSignal("");
  const [recording, setRecording] = createSignal(false);
  const [recordError, setRecordError] = createSignal("");
  const [recorded, setRecorded] = createSignal<{ added: number; existing: number } | null>(null);
  const [pending, setPending] = createSignal<string | null>(null);
  const [resuming, setResuming] = createSignal(false);

  /** The input the signals stand for; null while a box holds something that is not usable. */
  const input = (): ApplicationInputs["tieout.report"] | null => {
    const days = readTolerance(tolerance());
    if (!days.ok) return null;
    return {
      ...(isDate(from()) ? { from: from() } : {}),
      ...(isDate(to()) ? { to: to() } : {}),
      ...(days.days !== undefined ? { toleranceDays: days.days } : {}),
    };
  };

  const report = createLoader(() => client.read("tieout.report", input() ?? {}));

  const syncPending = () => {
    try {
      setPending(client.pending(TIEOUT_RECORD_WORKFLOW) ? TIEOUT_RECORD_WORKFLOW : null);
    } catch {
      setPending(null);
    }
  };
  onMount(syncPending);

  async function run() {
    const wanted = input();
    if (wanted === null) {
      setToleranceError("Use a whole number of days from 0 to 14.");
      return;
    }
    setToleranceError("");
    setPageError("");
    setRecorded(null);
    await report.reload();
  }

  async function record() {
    const wanted = input();
    if (wanted === null || recording()) return;
    setRecording(true);
    setRecordError("");
    setRecorded(null);
    try {
      const result = await client.write("tieout.record", wanted, TIEOUT_RECORD_WORKFLOW);
      setRecorded({ added: result.added, existing: result.existing });
    } catch (cause) {
      if (!isUncertain(cause)) setRecordError(messageOf(cause, "The findings could not be added."));
    } finally {
      syncPending();
      setRecording(false);
    }
  }

  async function resume() {
    if (!pending() || resuming()) return;
    setResuming(true);
    setPageError("");
    try {
      const completed = await client.resume(TIEOUT_RECORD_WORKFLOW);
      if (completed.name === "tieout.record")
        setRecorded({ added: completed.data.added, existing: completed.data.existing });
    } catch (cause) {
      if (!isUncertain(cause)) setPageError(messageOf(cause, "The request could not be resumed."));
    } finally {
      syncPending();
      setResuming(false);
    }
  }

  // Made when the report changes, not when a date box is typed in: the periods and the disclosures
  // a person opened stay as they are.
  const reportView = createMemo(() => {
    const read = report.value();
    return read ? tieoutView(read) : null;
  });
  const props = createMemo(
    (): TieoutScreenProps => ({
      state: report.error() !== undefined ? "error" : report.value() ? "ready" : "loading",
      noBook: isNoBook(report.error()),
      noXero: isXeroMissing(report.error()),
      onRetry: () => void report.reload(),
      focusTitle: true,
      ...(pageError() ? { error: pageError() } : {}),
      uncertain: pending() ? { resuming: resuming() } : null,
      onResume: () => void resume(),
      range: {
        from: from(),
        to: to(),
        tolerance: tolerance(),
        ...(toleranceError() ? { toleranceError: toleranceError() } : {}),
        running: report.loading(),
        onFrom: setFrom,
        onTo: setTo,
        onTolerance: (value) => {
          setTolerance(value);
          setToleranceError("");
        },
        onRun: () => void run(),
      },
      report: reportView(),
      record: {
        pending: recording(),
        result: recorded(),
        ...(recordError() ? { error: recordError() } : {}),
        onRecord: () => void record(),
      },
      links: { gaps: "/gaps", xero: "/xero" },
    }),
  );
  return { props };
}
