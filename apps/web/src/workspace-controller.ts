/** What Settings, Workspace does about taking the books away, as a state machine with no screen in it: ask the service to make the open export (a job that takes
 * as long as the book is big), then fetch it as one file and hand it to the browser to save. The Solid view (routes/settings/workspace.tsx) draws the state and calls
 * `run`; the tests drive it with stand-ins for the service and for saving. Nothing here knows about the DOM. */
import type { BackupJob } from "@rastrata/application/client-contracts";
import type { Account } from "./account";
import { ApplicationRequestError, type BrowserApplicationClient } from "./application-client";

type Client = Pick<BrowserApplicationClient, "writeJob">;

/** Where a retained request for the job is kept, so that a reload or a dropped connection reaches the same job and never starts a second. */
export const EXPORT_WORKFLOW = "workspace:export";

export type ExportState =
  | { readonly step: "idle" }
  | {
      readonly step: "making";
      /** What the service says it is doing ("Reading the book"), when it has said. */
      readonly stage: string | null;
      /** How far, as a whole percentage, when the service knows. */
      readonly percent: number | null;
    }
  | { readonly step: "fetching" }
  | { readonly step: "done"; readonly name: string; readonly bytes: number }
  | { readonly step: "failed"; readonly message: string };

export interface ExportOptions {
  readonly client: Client;
  /** The page's fetch for the application: the one that carries the workspace's token. */
  readonly fetcher: (input: string) => Promise<Response>;
  /** Hand the file to the browser to save. */
  readonly save: (file: Blob, name: string) => void;
  /** Milliseconds between asking whether the job is done. */
  readonly pollMs?: number;
}

/** The service's words for what went wrong are for a program; these are for a person. */
export function exportProblem(cause: unknown): string {
  if (cause instanceof ApplicationRequestError) {
    if (cause.code === "permission_denied")
      return "Only an owner or an administrator can export the books.";
    if (cause.code === "server_busy" || cause.code === "rate_limited")
      return "The service is busy. Try again in a moment.";
    if (cause.code === "backup_unavailable")
      return "This service cannot make an export of the books.";
    if (cause.message) return cause.message;
  }
  return "The export could not be made. Try again in a moment.";
}

export class ExportController {
  #state: ExportState = { step: "idle" };
  readonly #listeners = new Set<(state: ExportState) => void>();
  readonly #options: ExportOptions;
  #running = false;

  constructor(options: ExportOptions) {
    this.#options = options;
  }

  get state(): ExportState {
    return this.#state;
  }

  subscribe(listener: (state: ExportState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(state: ExportState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }

  /** Make the export and save it. A second call while one is under way is that one. */
  async run(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      this.#set({ step: "making", stage: null, percent: null });
      let job: BackupJob;
      try {
        job = await this.#options.client.writeJob("export.create", {}, EXPORT_WORKFLOW, {
          ...(this.#options.pollMs === undefined ? {} : { pollMs: this.#options.pollMs }),
          onProgress: (progress) =>
            this.#set({
              step: "making",
              stage: progress.stage,
              percent:
                progress.total && progress.done !== null
                  ? Math.min(100, Math.floor((progress.done / progress.total) * 100))
                  : null,
            }),
        });
      } catch (cause) {
        this.#set({ step: "failed", message: exportProblem(cause) });
        return;
      }
      if (job.state === "failed" || !job.export) {
        this.#set({
          step: "failed",
          message: job.error?.message ?? "The export could not be made. Try again in a moment.",
        });
        return;
      }
      this.#set({ step: "fetching" });
      let response: Response;
      try {
        response = await this.#options.fetcher(`/v1/exports/${encodeURIComponent(job.export.id)}`);
      } catch {
        this.#set({ step: "failed", message: "The export could not be fetched. Try again." });
        return;
      }
      if (!response.ok) {
        this.#set({
          step: "failed",
          message:
            response.status === 403
              ? "Only an owner or an administrator can export the books."
              : response.status === 404
                ? "The export is no longer there. Make it again."
                : "The export could not be fetched. Try again.",
        });
        return;
      }
      let file: Blob;
      try {
        file = await response.blob();
      } catch {
        this.#set({ step: "failed", message: "The download broke off. Try again." });
        return;
      }
      const name = `${job.export.id}.zip`;
      this.#options.save(file, name);
      this.#set({ step: "done", name, bytes: file.size });
    } finally {
      this.#running = false;
    }
  }
}

// ---- deleting the workspace ----------------------------------------------------------------------------------------------------

export type DeleteState =
  | { readonly step: "idle" }
  | { readonly step: "deleting" }
  | { readonly step: "failed"; readonly message: string }
  | { readonly step: "done" };

export interface DeleteOptions {
  readonly account: Pick<Account, "deleteWorkspace">;
  readonly workspace: { readonly id: string; readonly name: string };
  /** Forget the workspace that is open (it can no longer be). */
  readonly forget: () => void;
  /** Where the browser goes next. */
  readonly go: (path: string) => void;
  /** Where that is: the page that lists the person's workspaces, where this one is listed as being deleted. */
  readonly leaveFor: string;
}

/** What is typed is the name as it is shown: words separated by one space, whatever was typed between them. */
export const sameName = (typed: string, name: string): boolean =>
  typed.replace(/\s+/g, " ").trim() === name;

/** Deleting the workspace: the name is typed, the control plane closes the books to everyone and erases them after thirty days unless an owner brings them back, and the page leaves for
 * the list of workspaces. Nothing is sent until what was typed is the name; the control plane checks it again. */
export class DeleteController {
  #state: DeleteState = { step: "idle" };
  readonly #listeners = new Set<(state: DeleteState) => void>();
  readonly #options: DeleteOptions;
  #running = false;

  constructor(options: DeleteOptions) {
    this.#options = options;
  }

  get state(): DeleteState {
    return this.#state;
  }

  subscribe(listener: (state: DeleteState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(state: DeleteState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }

  async run(typed: string): Promise<void> {
    if (this.#running) return;
    const { account, workspace } = this.#options;
    if (!sameName(typed, workspace.name)) {
      this.#set({ step: "failed", message: "Type the name of the workspace to delete it." });
      return;
    }
    this.#running = true;
    try {
      this.#set({ step: "deleting" });
      const answer = await account.deleteWorkspace(workspace.id, typed);
      if (!answer.ok) {
        this.#set({ step: "failed", message: answer.message });
        return;
      }
      this.#set({ step: "done" });
      this.#options.forget();
      this.#options.go(this.#options.leaveFor);
    } finally {
      this.#running = false;
    }
  }
}
