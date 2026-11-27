import type {
  BackupJob,
  BackupSettings,
  BackupStatus,
} from "@rastrata/application/client-contracts";
import type {
  BackupView,
  JobKind,
  JobResultView,
  JobView,
  SafetyClock,
  SafetyStatusView,
  SettingsView,
  SummaryState,
} from "@rastrata/ui";
import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import {
  ApplicationRequestError,
  type BrowserApplicationClient,
  type JobOperation,
} from "../../application-client";
import { createLoader } from "../../loader";

/** The workflows a job's request is retained under, so a reload or a dropped connection reaches the
 * same job instead of starting another. */
const WORKFLOWS: Readonly<Record<JobKind, { workflow: string; operation: JobOperation }>> = {
  backup: { workflow: "backups:create", operation: "backup.create" },
  verify: { workflow: "backups:verify", operation: "backup.verify" },
  drill: { workflow: "backups:drill", operation: "backup.drill" },
  export: { workflow: "backups:export", operation: "export.create" },
};
export const SETTINGS_WORKFLOW = "backups:settings";

const STATUS_POLL_MS = 3000;
const CLOCK_MS = 30_000;

const codeOf = (cause: unknown): string | undefined =>
  cause instanceof ApplicationRequestError ? cause.code : undefined;
const messageOf = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message ? cause.message : fallback;

export const jobView = (job: BackupJob): JobView => ({
  kind: job.kind,
  stage: job.stage,
  done: job.done,
  total: job.total,
  elapsedMs: job.elapsedMs,
  remainingMs: job.remainingMs,
});

/** The job the service reports as running, as the screen shows it. */
export const activeJobView = (active: NonNullable<BackupStatus["activeJob"]>): JobView => ({
  kind: active.kind,
  stage: active.stage,
  done: active.done,
  total: active.total,
  elapsedMs: active.elapsedMs,
  remainingMs: active.remainingMs,
});

/** A finished job as the screen tells it. */
export function resultOf(job: BackupJob): JobResultView {
  if (job.state === "failed" || (job.state === "done" && !hasResult(job)))
    return {
      kind: job.kind,
      state: "failed",
      code: job.error?.code ?? "backup_failed",
      message: job.error?.message ?? "The job ended without a result.",
    };
  switch (job.kind) {
    case "backup":
      return { kind: "backup", state: "done", backup: job.backup as BackupView };
    case "verify": {
      const found = job.verification;
      return {
        kind: "verify",
        state: "done",
        backupId: found?.backupId ?? "",
        passed: found?.passed === true,
        durationMs: found?.durationMs ?? 0,
        replayMs: found?.replayMs ?? null,
        checks: found?.checks ?? [],
      };
    }
    case "drill":
      return { kind: "drill", state: "done", drill: job.drill as NonNullable<BackupJob["drill"]> };
    case "export":
      return {
        kind: "export",
        state: "done",
        export: job.export as NonNullable<BackupJob["export"]>,
      };
  }
}

const hasResult = (job: BackupJob): boolean =>
  job.kind === "backup"
    ? job.backup !== undefined
    : job.kind === "verify"
      ? job.verification !== undefined
      : job.kind === "drill"
        ? job.drill !== undefined
        : job.export !== undefined;

/**
 * Everything the Backups page holds: what it has read, the job it is waiting on, the result of the
 * last one and the settings it is saving. The page renders; this decides. Nothing starts work except a
 * button; a job's request is retained before it is sent and sent again with the same identity until
 * the job ends, so a lost reply or a reload reaches the same job. Reads use plain signals.
 */
export function createBackupsController(client: BrowserApplicationClient) {
  const status = createLoader(() => client.read("backup.status", {}));
  const list = createLoader(() => client.read("backup.list", {}));
  const exportList = createLoader(() => client.read("export.list", {}));
  const book = createLoader(() => client.read("book.get", {}));

  const [now, setNow] = createSignal(new Date());
  const [running, setRunning] = createSignal<JobKind | null>(null);
  const [job, setJob] = createSignal<JobView | null>(null);
  const [uncertain, setUncertain] = createSignal(false);
  const [result, setResult] = createSignal<JobResultView | null>(null);
  const [settingsState, setSettingsState] = createSignal<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [settingsError, setSettingsError] = createSignal<string | undefined>(undefined);
  const abort = new AbortController();

  const clock = createMemo(
    (): SafetyClock => ({
      now: now(),
      ...(typeof navigator === "undefined" ? {} : { locale: navigator.language }),
    }),
  );

  const state = createMemo((): SummaryState => {
    if (status.value()) return "ready";
    const failure = status.error();
    if (failure === undefined) return "loading";
    const code = codeOf(failure);
    return code === "backup_unavailable"
      ? "unavailable"
      : code === "book_not_configured"
        ? "no-book"
        : "error";
  });

  const reloadAll = () => {
    void status.reload();
    void list.reload();
    void exportList.reload();
  };

  /** A job this page did not start (the automatic backups, the command line): while the service
   * says one is running, read the status every few seconds and show it, and when it ends reload
   * the lists. */
  let watching: ReturnType<typeof setInterval> | undefined;
  createEffect(() => {
    const active = status.value()?.activeJob ?? null;
    if (running() !== null) return;
    if (active && watching === undefined)
      watching = setInterval(() => {
        void status.reload();
      }, STATUS_POLL_MS);
    if (!active && watching !== undefined) {
      clearInterval(watching);
      watching = undefined;
      void list.reload();
      void exportList.reload();
    }
  });
  const elsewhere = createMemo(() => {
    const active = status.value()?.activeJob ?? null;
    return running() === null && active ? activeJobView(active) : null;
  });

  async function finish(work: Promise<BackupJob>, kind: JobKind) {
    setRunning(kind);
    setUncertain(false);
    setResult(null);
    try {
      const ended = await work;
      setJob(null);
      setRunning(null);
      setResult(resultOf(ended));
      reloadAll();
    } catch (cause) {
      if (cause instanceof ApplicationRequestError && cause.uncertain) {
        // The job may still be running: keep the request, say so, and let the person reconnect.
        setUncertain(true);
        return;
      }
      setJob(null);
      setRunning(null);
      setResult({
        kind,
        state: "failed",
        code: codeOf(cause) ?? "backup_failed",
        message: messageOf(cause, "The request could not be completed."),
      });
      reloadAll();
    }
  }

  const options = () => ({
    pollMs: 1000,
    signal: abort.signal,
    onProgress: (progress: BackupJob) => setJob(jobView(progress)),
  });

  function start(kind: JobKind, backupId?: string) {
    if (running() !== null) return;
    const { workflow, operation } = WORKFLOWS[kind];
    setJob({ kind, stage: "Starting", done: null, total: null, elapsedMs: 0, remainingMs: null });
    const input = backupId && (kind === "verify" || kind === "drill") ? { backupId } : {};
    void finish(
      client.writeJob(operation, input as never, workflow, options()) as Promise<BackupJob>,
      kind,
    );
  }

  /** Ask again for a job whose request is retained: after a dropped connection, or a reload. */
  function reconnect(kind?: JobKind) {
    const target =
      kind ??
      (Object.keys(WORKFLOWS) as JobKind[]).find((candidate) => {
        try {
          return client.pending(WORKFLOWS[candidate].workflow) !== null;
        } catch {
          return false;
        }
      });
    if (!target) {
      setUncertain(false);
      return;
    }
    setJob(
      (current) =>
        current ?? {
          kind: target,
          stage: "Reconnecting",
          done: null,
          total: null,
          elapsedMs: 0,
          remainingMs: null,
        },
    );
    void finish(
      client.resumeJob(WORKFLOWS[target].workflow, options()) as Promise<BackupJob>,
      target,
    );
  }

  async function saveSettings(values: SettingsView) {
    setSettingsState("saving");
    setSettingsError(undefined);
    try {
      await client.write("backup.configure", values as BackupSettings, SETTINGS_WORKFLOW);
      setSettingsState("saved");
      void status.reload();
    } catch (cause) {
      setSettingsState("error");
      setSettingsError(
        codeOf(cause) === "permission_denied"
          ? "Changing these settings needs owner access."
          : messageOf(cause, "The settings could not be saved. Your settings have not changed."),
      );
    }
  }

  onMount(() => {
    const timer = setInterval(() => setNow(new Date()), CLOCK_MS);
    onCleanup(() => clearInterval(timer));
    // A job this browser started before a reload is still retained: reach it.
    const retained = (Object.keys(WORKFLOWS) as JobKind[]).find((candidate) => {
      try {
        return client.pending(WORKFLOWS[candidate].workflow) !== null;
      } catch {
        return false;
      }
    });
    if (retained) reconnect(retained);
  });
  onCleanup(() => {
    abort.abort();
    if (watching !== undefined) clearInterval(watching);
  });

  return {
    state,
    status: (): BackupStatus | undefined => status.value(),
    statusView: (): SafetyStatusView | undefined => status.value() as SafetyStatusView | undefined,
    backups: (): readonly BackupView[] => (list.value()?.backups ?? []) as readonly BackupView[],
    unrecorded: (): readonly string[] => list.value()?.unrecorded ?? [],
    exports: () => exportList.value()?.exports ?? [],
    clock,
    job: () => job() ?? elsewhere(),
    jobSource: (): "here" | "elsewhere" => (job() ? "here" : "elsewhere"),
    running,
    uncertain,
    result,
    // Optimistic until the book has been read: the common case is the owner, and the service
    // enforces the permission on save either way (and the page says so if it refuses).
    ownerAccess: () => book.value()?.permissions.includes("provision") ?? true,
    settingsState,
    settingsError,
    retry: reloadAll,
    backUp: () => start("backup"),
    verify: (backupId?: string) => start("verify", backupId),
    drill: (backupId?: string) => start("drill", backupId),
    exportNow: () => start("export"),
    reconnect: () => reconnect(),
    dismiss: () => setResult(null),
    saveSettings,
  };
}
