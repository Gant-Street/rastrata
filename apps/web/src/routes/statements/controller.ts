import type { ApplicationInputs, ApplicationOutputs } from "@rastrata/application/client-contracts";
import type { ImportSampleFilter } from "@rastrata/ui";
import { batch, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { ApplicationRequestError, type BrowserApplicationClient } from "../../application-client";
import { refuseFile, type UploadReceipt, uploadStatement } from "./upload";

export type Preview = ApplicationOutputs["import.preview"];
type PreviewInput = ApplicationInputs["import.preview"];
export type Mapping = NonNullable<PreviewInput["mapping"]>;
export type Committed = ApplicationOutputs["import.commit"];

/** The workflows the page retains writes under, so a lost reply is resumed, never repeated. */
export const COMMIT_WORKFLOW = "import:commit";
export const PROFILE_WORKFLOW = "import:profile";

const PAGE_SIZE = 25;
const MAPPING_DELAY_MS = 300;

export type UploadView = {
  state: "idle" | "reading" | "uploading" | "error";
  name?: string;
  size?: number;
  error?: string;
};

const messageOf = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message ? cause.message : fallback;

/** Everything the Import page holds: the person's choices, the file's upload, the preview the
 * service makes of it, and the commit. The page renders; this decides. Nothing here changes the
 * books until `commit`, and `commit` sends exactly what the preview showed. */
export function createImportController(client: BrowserApplicationClient) {
  const [account, setAccountRaw] = createSignal("");
  const [upload, setUpload] = createSignal<UploadView>({ state: "idle" });
  const [receipt, setReceipt] = createSignal<UploadReceipt | null>(null);
  const [mapping, setMapping] = createSignal<Mapping | null>(null);
  /** A bank's layout the person chose by name. It and `mapping` are alternatives, never both. */
  const [presetId, setPresetId] = createSignal("");
  const [ofxAccount, setOfxAccount] = createSignal("");
  const [ignoreIds, setIgnoreIds] = createSignal(false);
  const [invertBalance, setInvertBalance] = createSignal(false);
  const [startOn, setStartOn] = createSignal("");
  const [catchUp, setCatchUp] = createSignal(false);
  const [skipRows, setSkipRows] = createSignal(false);
  const [filter, setFilterRaw] = createSignal<ImportSampleFilter>("all");
  const [page, setPage] = createSignal(1);
  const [stage, setStage] = createSignal<"review" | "done" | "uncertain">("review");
  const [committing, setCommitting] = createSignal(false);
  const [commitError, setCommitError] = createSignal("");
  const [result, setResult] = createSignal<Committed | null>(null);
  const [profileName, setProfileName] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal("");
  const [saveError, setSaveError] = createSignal("");
  /** The last preview that was read, kept while a newer one is fetched so nothing flashes away. */
  const [shown, setShown] = createSignal<Preview | null>(null);
  const [failed, setFailed] = createSignal("");
  /** Additional statements waiting in a multi-file drop queue (processed one by one). */
  const [queue, setQueue] = createSignal<readonly File[]>([]);
  const [queueTotal, setQueueTotal] = createSignal(0);
  const [queueIndex, setQueueIndex] = createSignal(0);

  const request = createMemo<PreviewInput | null>(() => {
    const file = receipt();
    const chosen = account();
    if (!file || !chosen) return null;
    const explicit = mapping();
    const layout = presetId();
    return {
      sha256: file.sha256,
      ledgerAccountId: chosen,
      ...(explicit ? { mapping: explicit } : layout ? { presetId: layout } : {}),
      ...(ofxAccount() ? { ofxAccount: ofxAccount() } : {}),
      ...(ignoreIds() ? { ignoreProviderIds: true } : {}),
      ...(invertBalance() ? { invertBalance: true } : {}),
      ...(startOn() ? { startOn: startOn() } : {}),
      ...(catchUp() ? { catchUp: true } : {}),
      show: filter(),
      page: page(),
      pageSize: PAGE_SIZE,
    };
  });
  /** Read the preview whenever the request changes. A failure is a message, not a thrown error,
   * so the last good preview stays on screen beside the reason a newer one could not be had; an
   * answer that arrives after a newer request was made is dropped. Plain signals rather than a
   * resource, so a slow preview never suspends the router's boundary and takes the focus. */
  const [previewing, setPreviewing] = createSignal(false);
  let latestPreview = 0;
  createEffect(
    on(request, (input) => {
      const mine = ++latestPreview;
      if (!input) {
        setPreviewing(false);
        return;
      }
      setPreviewing(true);
      client
        .read("import.preview", input)
        .then(
          (data) => {
            if (mine === latestPreview)
              batch(() => {
                setShown(data);
                setFailed("");
              });
          },
          (cause) => {
            if (mine === latestPreview) setFailed(messageOf(cause, "The file could not be read."));
          },
        )
        .finally(() => {
          if (mine === latestPreview) setPreviewing(false);
        });
    }),
  );
  const refreshing = () => previewing() && shown() !== null;

  /** A change to how the file is read starts the sample again from its first page. */
  const changed = () => setPage(1);
  /** A column choice waits a moment for the next keystroke; anything that starts the file over
   * must cancel it, or a choice made for the last file would be applied to the next. */
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  const resetChoices = () =>
    batch(() => {
      clearTimeout(timer);
      setMapping(null);
      setPresetId("");
      setOfxAccount("");
      setIgnoreIds(false);
      setInvertBalance(false);
      setSkipRows(false);
      setFilterRaw("all");
      setPage(1);
      setShown(null);
      setFailed("");
      setSaved("");
      setSaveError("");
      setProfileName("");
    });

  const setAccount = (id: string) => {
    if (id === account()) return;
    batch(() => {
      setAccountRaw(id);
      resetChoices();
    });
  };

  const chooseFile = async (file: File) => {
    const refusal = refuseFile(file);
    if (refusal) {
      setUpload({ state: "error", name: file.name, size: file.size, error: refusal });
      return;
    }
    batch(() => {
      setReceipt(null);
      resetChoices();
      setStage("review");
      setResult(null);
      setCommitError("");
      setUpload({ state: "uploading", name: file.name, size: file.size });
    });
    try {
      const stored = await uploadStatement(file, client.bookId);
      batch(() => {
        setReceipt(stored);
        setUpload({ state: "idle", name: file.name, size: file.size });
      });
    } catch (cause) {
      setUpload({
        state: "error",
        name: file.name,
        size: file.size,
        error: messageOf(cause, "The file could not be uploaded. Try again."),
      });
    }
  };

  /** The column editor reports a complete mapping on every keystroke; the preview follows once the
   * person pauses. Columns chosen by hand replace a layout chosen by name. */
  const chooseMapping = (next: Mapping) => {
    clearTimeout(timer);
    timer = setTimeout(
      () =>
        batch(() => {
          setPresetId("");
          setMapping(next);
          changed();
          setSaved("");
        }),
      MAPPING_DELAY_MS,
    );
  };

  /** A bank's layout chosen by name replaces any columns chosen by hand; choosing none goes back to
   * the file's own header. */
  const choosePreset = (id: string) => {
    clearTimeout(timer);
    batch(() => {
      setMapping(null);
      setPresetId(id);
      changed();
      setSaved("");
    });
  };

  /** What `import.commit` is sent: the preview's own inputs, without the paging. */
  const commitInput = (): ApplicationInputs["import.commit"] | null => {
    const current = request();
    if (!current) return null;
    const { show: _show, page: _page, pageSize: _pageSize, ...rest } = current;
    return { ...rest, ...(skipRows() ? { skipInvalidRows: true } : {}) };
  };

  const commit = async () => {
    const input = commitInput();
    if (!input || committing()) return;
    batch(() => {
      setCommitting(true);
      setCommitError("");
    });
    try {
      const done = await client.write("import.commit", input, COMMIT_WORKFLOW);
      batch(() => {
        setResult(done);
        setStage("done");
      });
    } catch (cause) {
      if (cause instanceof ApplicationRequestError && cause.uncertain) setStage("uncertain");
      else setCommitError(messageOf(cause, "The import did not go through. Nothing was imported."));
    } finally {
      setCommitting(false);
    }
  };

  const resume = async () => {
    if (committing()) return;
    setCommitting(true);
    try {
      const completion = await client.resume(COMMIT_WORKFLOW);
      if (completion.name === "import.commit")
        batch(() => {
          setResult(completion.data);
          setStage("done");
        });
    } catch (cause) {
      if (cause instanceof ApplicationRequestError && cause.uncertain) setStage("uncertain");
      else
        batch(() => {
          setStage("review");
          setCommitError(messageOf(cause, "The import did not go through. Nothing was imported."));
        });
    } finally {
      setCommitting(false);
    }
  };

  const saveProfile = async () => {
    const effective = shown()?.mapping;
    const name = profileName().trim();
    if (!effective || !name || saving()) return;
    batch(() => {
      setSaving(true);
      setSaved("");
      setSaveError("");
    });
    try {
      const profile = await client.write(
        "import.profileSave",
        { name, ledgerAccountId: account(), mapping: effective },
        PROFILE_WORKFLOW,
      );
      setSaved(`Saved as “${profile.name}”.`);
    } catch (cause) {
      setSaveError(messageOf(cause, "The choices could not be saved. Try again."));
    } finally {
      setSaving(false);
    }
  };

  const chooseFiles = async (files: readonly File[]) => {
    if (files.length === 0) return;
    if (files.length === 1 && files[0]) {
      batch(() => {
        setQueue([]);
        setQueueTotal(0);
        setQueueIndex(0);
      });
      await chooseFile(files[0]);
      return;
    }
    const ordered = [...files].sort((left, right) => left.name.localeCompare(right.name));
    const [first, ...rest] = ordered;
    batch(() => {
      setQueue(rest);
      setQueueTotal(ordered.length);
      setQueueIndex(1);
    });
    if (first) await chooseFile(first);
  };

  const nextQueued = async () => {
    const waiting = queue();
    const [next, ...rest] = waiting;
    if (!next) return;
    batch(() => {
      setQueue(rest);
      setQueueIndex((current) => current + 1);
    });
    await chooseFile(next);
  };

  const clearQueue = () =>
    batch(() => {
      setQueue([]);
      setQueueTotal(0);
      setQueueIndex(0);
    });

  const startOver = () =>
    batch(() => {
      setReceipt(null);
      resetChoices();
      setStage("review");
      setResult(null);
      setCommitError("");
      setUpload({ state: "idle" });
      clearQueue();
    });

  // A request the browser still holds from before a reload is resumed, never repeated.
  const pendingBeforeReload = (): boolean => {
    try {
      return client.pending(COMMIT_WORKFLOW) !== null;
    } catch {
      return true;
    }
  };
  if (pendingBeforeReload()) setStage("uncertain");

  return {
    account,
    setAccount,
    upload,
    receipt,
    chooseFile,
    chooseFiles,
    queue,
    queueTotal,
    queueIndex,
    nextQueued,
    clearQueue,
    shown,
    failed,
    refreshing,
    loadingFirst: () => previewing() && shown() === null && request() !== null,
    filter,
    setFilter: (next: ImportSampleFilter) =>
      batch(() => {
        setFilterRaw(next);
        setPage(1);
      }),
    page,
    setPage,
    startOn,
    setStartOn: (value: string) =>
      batch(() => {
        setStartOn(value);
        changed();
      }),
    catchUp,
    setCatchUp: (value: boolean) =>
      batch(() => {
        setCatchUp(value);
        changed();
      }),
    ignoreIds,
    setIgnoreIds: (value: boolean) =>
      batch(() => {
        setIgnoreIds(value);
        changed();
      }),
    invertBalance,
    setInvertBalance: (value: boolean) =>
      batch(() => {
        setInvertBalance(value);
        changed();
      }),
    skipRows,
    setSkipRows,
    chooseMapping,
    presetId,
    choosePreset,
    chooseOfxAccount: (key: string) =>
      batch(() => {
        setOfxAccount(key);
        changed();
      }),
    stage,
    committing,
    commitError,
    result,
    commit,
    resume,
    startOver,
    profileName,
    setProfileName,
    saving,
    saved,
    saveError,
    saveProfile,
  };
}

export type ImportController = ReturnType<typeof createImportController>;
