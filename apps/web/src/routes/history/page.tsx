import type {
  ApplicationInputs,
  HistoryMapping,
  HistoryPreview,
} from "@rastrata/application/client-contracts";
import {
  HistoryCompare,
  HistoryDone,
  type HistoryPreviewView,
  type TieOutView,
  type HistoryRole,
  HistoryReview,
  type HistoryStage,
  historyWords,
  ImportFileDrop,
  Notice,
  PageHeader,
  type ButtonLinkProps,
} from "@rastrata/ui";
import { formatDate, formatFiguresInText } from "@rastrata/ui/format";
import { batch, createSignal, type JSX, Show } from "solid-js";
import { AppLink } from "../../app-link";
import { ApplicationRequestError, BrowserApplicationClient } from "../../application-client";
import { createLoader } from "../../loader";
import { type UploadReceipt, UploadError, uploadStatement } from "../statements/upload";
import { refuseJournal } from "./file";

const words = historyWords;
const WORKFLOW = "history";
/** How long one call may take before the next asks for fewer entries; the client gives up at ten seconds. */
const SLOW_MS = 6000;
const FAST_MS = 2000;

type DateOrder = "auto" | "mdy" | "dmy" | "ymd";
type Upload = { state: "idle" | "uploading" | "error"; name: string; size: number; error?: string };

const link = (props: ButtonLinkProps): JSX.Element => <AppLink {...props} />;
const messageOf = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message ? cause.message : fallback;

/** Why a file could not be uploaded. A book keeps an upload in one entry of its record, which holds a few
 * megabytes of entries at most; the service says so in words made for a statement, so for a history they are ours. */
const uploadMessage = (cause: unknown): string =>
  cause instanceof UploadError && cause.code === "entry_too_large"
    ? "That file is more than the book can take in one go. Export the history in parts of a few years each, and bring in each part, oldest first."
    : messageOf(cause, "The file could not be uploaded. Try again.");

/** Settings, Bring in history: choose a journal file, see what it would do, then import it. Nothing is
 * posted until the button is pressed, and what is posted is exactly what the preview showed. A long
 * history goes in calls of a few hundred entries, each safe to send again. */
export function HistoryPage() {
  const client = new BrowserApplicationClient(window.localStorage);
  const chart = createLoader(() => client.read("accounts.list", {}));
  const [upload, setUpload] = createSignal<Upload>({ state: "idle", name: "", size: 0 });
  const [receipt, setReceipt] = createSignal<UploadReceipt | null>(null);
  const [order, setOrder] = createSignal<DateOrder>("auto");
  const [choices, setChoices] = createSignal<Record<string, string>>({});
  const [preview, setPreview] = createSignal<HistoryPreview | null>(null);
  const [problem, setProblem] = createSignal("");
  const [stage, setStage] = createSignal<HistoryStage>("review");
  const [progress, setProgress] = createSignal<{ done: number; total: number } | null>(null);
  const [stopped, setStopped] = createSignal("");
  const [outcome, setOutcome] = createSignal<{ entries: number; booksBegan: string | null } | null>(
    null,
  );
  // The comparison with the old books' trial balance, on its own file and its own day.
  const [tbUpload, setTbUpload] = createSignal<Upload>({ state: "idle", name: "", size: 0 });
  const [tbReceipt, setTbReceipt] = createSignal<UploadReceipt | null>(null);
  const [asOf, setAsOf] = createSignal("");
  const [comparing, setComparing] = createSignal(false);
  const [tieOut, setTieOut] = createSignal<TieOutView | null>(null);
  const [tbProblem, setTbProblem] = createSignal("");
  let asked = 0;
  let limit = 20;
  let ceiling = 400;

  // The accounts a line can be posted to, names first.
  const options = () =>
    (chart.value()?.accounts ?? [])
      .filter((account) => account.closedOn === null)
      .map((account) => ({ value: account.code, label: `${account.name} (${account.code})` }));

  const mapOf = (): HistoryMapping[] =>
    Object.entries(choices()).flatMap(([account, value]): HistoryMapping[] =>
      value === ""
        ? []
        : value.startsWith("+")
          ? [{ account, add: value.slice(1) as HistoryRole }]
          : [{ account, to: value }],
    );
  const inputOf = (): ApplicationInputs["history.preview"] => {
    const map = mapOf();
    return {
      file: receipt()?.sha256 as string,
      dateOrder: order(),
      ...(map.length > 0 ? { map } : {}),
    };
  };

  /** Read the file against the book as the choices stand. The first time a file is read, each account the
   * book lacks is set to the book's account its name says it is, or to be added as the kind its number or
   * name gives, and the file is read again with that; the person can change any of it. */
  async function read(first = false) {
    if (!receipt()) return;
    const mine = ++asked;
    setProblem("");
    try {
      const seen = await client.read("history.preview", inputOf());
      if (mine !== asked) return;
      if (first) {
        const seeded: Record<string, string> = {};
        for (const row of seen.accounts) {
          if (row.account !== null) continue;
          if (row.suggestedAccount) seeded[row.label] = row.suggestedAccount;
          else if (row.suggestedRole !== null) seeded[row.label] = `+${row.suggestedRole}`;
        }
        if (Object.keys(seeded).length > 0) {
          setChoices(seeded);
          return read(false);
        }
      }
      setPreview(seen);
    } catch (cause) {
      if (mine === asked) setProblem(messageOf(cause, "The file could not be read. Try again."));
    }
  }

  async function chooseFile(file: File) {
    const refusal = refuseJournal(file);
    if (refusal) {
      setUpload({ state: "error", name: file.name, size: file.size, error: refusal });
      return;
    }
    batch(() => {
      asked += 1;
      setReceipt(null);
      setPreview(null);
      setChoices({});
      setOrder("auto");
      setStopped("");
      setProblem("");
      setStage("review");
      setUpload({ state: "uploading", name: file.name, size: file.size });
    });
    try {
      const stored = await uploadStatement(file, client.bookId);
      batch(() => {
        setReceipt(stored);
        setUpload({ state: "idle", name: file.name, size: file.size });
      });
      await read(true);
    } catch (cause) {
      setUpload({
        state: "error",
        name: file.name,
        size: file.size,
        error: uploadMessage(cause),
      });
    }
  }

  async function chooseTrialBalance(file: File) {
    const refusal = refuseJournal(file);
    batch(() => {
      setTbReceipt(null);
      setTieOut(null);
      setTbProblem("");
      setTbUpload(
        refusal
          ? { state: "error", name: file.name, size: file.size, error: refusal }
          : { state: "uploading", name: file.name, size: file.size },
      );
    });
    if (refusal) return;
    try {
      const stored = await uploadStatement(file, client.bookId);
      batch(() => {
        setTbReceipt(stored);
        setTbUpload({ state: "idle", name: file.name, size: file.size });
      });
    } catch (cause) {
      setTbUpload({
        state: "error",
        name: file.name,
        size: file.size,
        error: uploadMessage(cause),
      });
    }
  }

  async function compare() {
    const receipt = tbReceipt();
    if (!receipt || asOf() === "" || comparing()) return;
    batch(() => {
      setComparing(true);
      setTbProblem("");
      setTieOut(null);
    });
    // What was chosen for the import goes with it, so that an account the book names differently is
    // compared with the account it was posted to.
    const map = mapOf().filter((pair) => pair.to !== undefined);
    try {
      setTieOut(
        await client.read("history.tieOut", {
          file: receipt.sha256,
          asOf: asOf(),
          ...(map.length > 0 ? { map } : {}),
        }),
      );
    } catch (cause) {
      setTbProblem(messageOf(cause, "The comparison could not be made. Try again."));
    } finally {
      setComparing(false);
    }
  }

  function choose(label: string, value: string) {
    setChoices({ ...choices(), [label]: value });
    void read();
  }

  async function importAll() {
    const current = preview();
    if (!current || !receipt() || stage() === "importing" || !current.ready) return;
    batch(() => {
      setStopped("");
      setStage("importing");
      setProgress({ done: current.alreadyImported, total: current.entries });
    });
    try {
      for (;;) {
        const started = performance.now();
        let step: Awaited<ReturnType<typeof client.write<"history.import">>>;
        try {
          step = await client.write("history.import", { ...inputOf(), limit }, WORKFLOW);
        } catch (cause) {
          // More than the book's storage takes in one go: nothing was posted, so ask for half as many.
          if (
            cause instanceof ApplicationRequestError &&
            cause.code === "entry_too_large" &&
            limit > 1
          ) {
            ceiling = Math.max(1, limit >> 1);
            limit = ceiling;
            continue;
          }
          throw cause;
        }
        const took = performance.now() - started;
        setProgress({ done: step.importedTotal, total: step.total });
        if (step.failed) {
          setStopped(
            words.stopped(
              step.failed.key,
              formatDate(step.failed.date),
              formatFiguresInText(step.failed.message),
            ),
          );
          setStage("stopped");
          await read();
          return;
        }
        if (step.done) {
          batch(() => {
            setOutcome({ entries: step.total, booksBegan: step.booksBegan });
            setStage("done");
          });
          return;
        }
        if (step.imported === 0) throw new Error("The import made no progress.");
        // A call that was slow asks for fewer entries next time, and a quick one for more.
        limit =
          took > SLOW_MS
            ? Math.max(10, limit >> 1)
            : took < FAST_MS
              ? Math.min(ceiling, limit * 2)
              : limit;
      }
    } catch (cause) {
      if (cause instanceof ApplicationRequestError && cause.code === "permission_denied")
        client.discard(WORKFLOW);
      setStopped(
        cause instanceof ApplicationRequestError &&
          cause.uncertain &&
          cause.code !== "permission_denied"
          ? "The request did not get an answer. Import again to continue: nothing is posted twice."
          : messageOf(cause, "The import could not be completed. Try again."),
      );
      setStage("stopped");
      await read();
    }
  }

  const view = (): HistoryPreviewView | null => preview();
  return (
    <section aria-labelledby="history-title">
      <PageHeader titleId="history-title" title={words.title} description={words.description} />
      <Show
        when={stage() === "done" ? outcome() : null}
        fallback={
          <div class="rt-stack">
            <ImportFileDrop
              state={upload().state === "error" ? "error" : upload().state}
              fileName={upload().name || undefined}
              fileSize={upload().size || undefined}
              error={upload().error}
              disabled={stage() === "importing"}
              copy={words.drop}
              onFile={(file) => void chooseFile(file)}
            />
            <Show when={problem()}>
              <Notice title={problem()} tone="problem" role="alert" />
            </Show>
            <Show when={view()}>
              {(shown) => (
                <HistoryReview
                  preview={shown()}
                  options={options()}
                  choices={choices()}
                  onChoose={choose}
                  dateOrder={
                    shown().dateOrderAssumed || order() !== "auto"
                      ? {
                          value: order() === "dmy" ? "dmy" : "mdy",
                          onChange: (value) => {
                            setOrder(value);
                            void read();
                          },
                        }
                      : undefined
                  }
                  stage={stage()}
                  progress={progress()}
                  stopped={stopped() || undefined}
                  onImport={() => void importAll()}
                />
              )}
            </Show>
          </div>
        }
      >
        {(done) => (
          <HistoryDone entries={done().entries} booksBegan={done().booksBegan} link={link} />
        )}
      </Show>
      <HistoryCompare
        state={tbUpload().state}
        fileName={tbUpload().name || undefined}
        fileSize={tbUpload().size || undefined}
        uploadError={tbUpload().error}
        onFile={(file) => void chooseTrialBalance(file)}
        date={asOf()}
        onDate={setAsOf}
        problem={tbProblem() || undefined}
        busy={comparing() || stage() === "importing"}
        ready={tbReceipt() !== null && asOf() !== ""}
        onCompare={() => void compare()}
        result={tieOut()}
        link={link}
      />
    </section>
  );
}
