import {
  API_VERSION,
  WRITE_OPERATIONS,
  type ApplicationInputs,
  type ApplicationOperation,
  type ApplicationOutputs,
  type ApplicationResponse,
} from "@rastrata/application/client-contracts";
import { formatFiguresInText } from "@rastrata/ui/format";
import { ambientFetch, authorizationScope } from "./ambient.ts";
import * as held from "./held.ts";
import { outcomeOfError, timeAction } from "./rum-hook.ts";
import { announceSignInRequired, SESSION_ENDED_MESSAGE, SIGN_IN_REQUIRED_CODE } from "./session.ts";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
export type ApplicationFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type PreparedEffects = ApplicationOutputs["journal.prepare"]["effects"];
const writes = new Set<ApplicationOperation>(WRITE_OPERATIONS);
/** Long jobs (the safety slice): each answers `state: "running"` until it is done, and is asked again
 * with the same identity, so the answer is always that one job's. */
export type JobOperation = "backup.create" | "backup.verify" | "backup.drill" | "export.create";
const jobs = new Set<ApplicationOperation>([
  "backup.create",
  "backup.verify",
  "backup.drill",
  "export.create",
]);
const running = (name: ApplicationOperation, data: unknown): boolean =>
  jobs.has(name) && (data as { state?: unknown } | null)?.state === "running";
export type JobOptions<K extends JobOperation> = {
  /** Told each time the service says the job is still running, with its progress. */
  onProgress?: (job: ApplicationOutputs[K]) => void;
  /** Milliseconds between asking again. */
  pollMs?: number;
  /** Stops waiting (the job carries on in the service; ask again to reach it). */
  signal?: AbortSignal;
};
export type PendingRequest = { name: ApplicationOperation; body: string };
export type ApplicationCompletion = {
  [K in ApplicationOperation]: { name: K; data: ApplicationOutputs[K] };
}[ApplicationOperation];

export type ApplicationLock = (
  key: string,
  work: () => Promise<ApplicationCompletion>,
) => Promise<ApplicationCompletion>;
async function workflowLock(
  key: string,
  work: () => Promise<ApplicationCompletion>,
): Promise<ApplicationCompletion> {
  if (typeof window === "undefined") return work();
  if (!navigator.locks)
    throw new ApplicationRequestError(
      "This browser cannot coordinate retained writes. Use a browser with Web Locks support.",
      "request_lock_unavailable",
    );
  return navigator.locks.request(key, work);
}

/** Told to the window each time a write goes through (`detail.name` is the operation). What shows a figure
 * the write may have changed, such as the navigation's count of what is waiting for review, reads it
 * again. Nothing depends on it: a page that misses it is only a little stale until the next one. */
export const WRITE_EVENT = "rastrata:write";
function announceWrite(name: ApplicationOperation): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(WRITE_EVENT, { detail: { name } }));
  } catch {
    // A listener that throws is not the write's problem.
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** What `journal.post` answered, checked before anything is shown or kept: the draft the dialog is to hold,
 * a prepared plan under its own hash, a receipt for that plan, or the books' refusal (one of the last two
 * may be null, never the draft, and a result with neither a plan nor a refusal says nothing). */
function validPost(data: Record<string, unknown>): boolean {
  const { draft, plan, receipt, refusal } = data;
  if (
    !isRecord(draft) ||
    typeof draft.id !== "string" ||
    !Number.isSafeInteger(draft.version) ||
    Number(draft.version) < 1 ||
    !["draft", "posting", "rejected", "posted"].includes(String(draft.status)) ||
    !draft.data
  )
    return false;
  if (plan !== null) {
    if (
      !isRecord(plan) ||
      plan.disposition !== "prepared" ||
      plan.planId !== plan.operationId ||
      typeof plan.planHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(plan.planHash) ||
      typeof plan.valid !== "boolean" ||
      !Array.isArray(plan.problems) ||
      !Array.isArray(plan.diagnostics) ||
      !isRecord(plan.effects) ||
      !Array.isArray(plan.effects.journals)
    )
      return false;
  }
  if (receipt !== null) {
    if (
      !isRecord(plan) ||
      !isRecord(receipt) ||
      receipt.operationId !== plan.planId ||
      !["committed", "rejected"].includes(String(receipt.disposition)) ||
      !Array.isArray(receipt.diagnostics) ||
      !Array.isArray(receipt.problems)
    )
      return false;
  }
  if (refusal !== null) {
    if (
      !isRecord(refusal) ||
      typeof refusal.code !== "string" ||
      typeof refusal.message !== "string" ||
      !Array.isArray(refusal.details)
    )
      return false;
  } else if (plan === null) return false;
  return true;
}

/** A failure the service reported, or a request that did not complete. The message is the service's
 * own words, which a person reads, so the dates, instants and amounts in it are written as every other
 * is ("Oct 1, 2024", not "2024-10-01"). */
export class ApplicationRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly uncertain = false,
    /** The service's field-level details (a path and a message each), when it sent any. */
    readonly details: readonly { path: string; message: string }[] = [],
    /** The same request can be sent again and may then be answered: the service said so (it was busy, or the book was on its way from one of its servers to another), or no answer came. */
    readonly again = false,
  ) {
    super(formatFiguresInText(message));
  }
}

/** How long a read waits before it is asked again, after each time the service said "again" or did not answer. A read changes nothing, so asking twice is asking once; a person is told that
 * something could not be read only when the service could not be had, and not in the moment a book passes from one of its servers to another (the founder, 2026-11-22: "I had a message that
 * said transactions could not be checked", on a first visit of the day that the service answered a moment later). */
export const READ_AGAIN_MS: readonly number[] = [250, 750, 1500];
/** The waits in use. A test of what the page does when the service cannot be had at all sets none, so that it does not wait three seconds to be told. */
export const readAgain: { waits: readonly number[] } = { waits: READ_AGAIN_MS };
/** No read is asked again once this long has passed since it was first asked: by then the person is told. */
export const READ_AGAIN_WITHIN_MS = 6000;

/** One pending write per workflow. Exact requests survive reload and are saved
 * before dispatch; a failed local save cannot send an untracked write. */
export class BrowserApplicationClient {
  constructor(
    private readonly storage: Storage,
    private readonly fetcher: ApplicationFetch = ambientFetch,
    readonly bookId = "local-book",
    private readonly lock: ApplicationLock = workflowLock,
  ) {}

  /** Where a retained write is kept. On a service with accounts the key names the workspace that is open, so that a write that was waiting in one workspace is
   * never sent to another's book; without accounts the key is what it always was. */
  private key(workflow: string): string {
    const scope = authorizationScope();
    return `rastrata:${API_VERSION}:${this.bookId}:${scope === "" ? "" : `${scope}:`}${workflow}:pending`;
  }

  pending(workflow: string): PendingRequest | null {
    const raw = this.storage.getItem(this.key(workflow));
    if (!raw) return null;
    try {
      const pending = JSON.parse(raw) as PendingRequest;
      const body = JSON.parse(pending.body);
      if (
        !writes.has(pending.name) ||
        body.version !== API_VERSION ||
        body.bookId !== this.bookId ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.operationId) ||
        !body.input ||
        typeof body.input !== "object" ||
        Array.isArray(body.input) ||
        (pending.name === "operations.commit" && body.input.planId !== body.operationId)
      )
        throw new Error("Invalid retained request");
      return pending;
    } catch {
      throw new ApplicationRequestError(
        "The retained request is invalid. No replacement write was sent.",
        "request_journal_invalid",
      );
    }
  }

  /** Let go of the retained request of a workflow. Only for a request that is known to have done nothing (the
   * service refused it for permission before it looked at the request) and that nobody will send again; any
   * other request waits to be resumed. */
  discard(workflow: string): void {
    this.storage.removeItem(this.key(workflow));
  }

  /** A read of the service. What the page has read already is given at once, and the service is asked again behind it (held.ts); a read of a kind that is not held, or of what the page has not
   * read, waits for the service. */
  async read<K extends ApplicationOperation>(
    name: K,
    input: ApplicationInputs[K],
    /** Stops waiting for the answer: the request is abandoned and the read fails. A read changes nothing,
     * so an abandoned one costs nothing. */
    options: { signal?: AbortSignal; fresh?: boolean } = {},
  ): Promise<ApplicationOutputs[K]> {
    if (writes.has(name)) throw new Error("Writes must be retained before dispatch");
    const key = held.holds(name, input) ? held.keyOf(this.bookId, name, input) : null;
    if (key !== null) held.noteRead(key);
    // A read that must not be given what the page held (`fresh`: it decides something, or it is made again at every letter typed), or of a kind that is not held, waits for the service.
    if (key === null || options.fresh) {
      // A change made while this is on its way ends it as it ends every answer: what it says is from before, and is not kept.
      const since = held.currentEpoch();
      const data = await this.fetchRead(name, input, options.signal);
      if (key !== null) held.put(key, JSON.stringify(data), since);
      return data;
    }
    // On a service with accounts what was kept on the device is being read back as the page starts: the first reads wait for it, a moment at most.
    await held.ready();
    const kept = held.peek(key);
    if (kept) {
      if (!kept.fresh) held.givenOld(key, () => this.check(key, name, input, kept.text));
      return JSON.parse(kept.text) as ApplicationOutputs[K];
    }
    // Nothing held: the service is asked, once for everyone who asks while the answer is on its way, and the answer is kept (unless something was changed meanwhile).
    const since = held.currentEpoch();
    const asking = held.once(key, async () => {
      const text = JSON.stringify(await this.fetchRead(name, input));
      held.put(key, text, since);
      return text;
    });
    const signal = options.signal;
    const text = await (signal === undefined
      ? asking
      : Promise.race([
          asking,
          new Promise<never>((_, reject) => {
            const stop = () =>
              reject(
                new ApplicationRequestError(
                  "The application could not be read.",
                  "service_unavailable",
                ),
              );
            if (signal.aborted) stop();
            else signal.addEventListener("abort", stop, { once: true });
          }),
        ]));
    return JSON.parse(text) as ApplicationOutputs[K];
  }

  /** The service is asked again for what was given from what the page held, and the answer is kept; if it cannot be had, what was held is let go, and the next read asks and says what went wrong. */
  private async check<K extends ApplicationOperation>(
    key: string,
    name: K,
    input: ApplicationInputs[K],
    shown: string,
  ): Promise<void> {
    const since = held.currentEpoch();
    try {
      const text = JSON.stringify(await this.fetchRead(name, input));
      held.put(key, text, since);
      // What the service says is not what was given: whatever showed it reads again.
      if (text !== shown && since === held.currentEpoch()) held.announceChanged();
    } catch {
      held.drop(key);
      // What was shown can no longer be confirmed: whatever showed it reads again, and says what went wrong.
      if (since === held.currentEpoch()) held.announceChanged();
    }
  }

  private async fetchRead<K extends ApplicationOperation>(
    name: K,
    input: ApplicationInputs[K],
    signal?: AbortSignal,
  ): Promise<ApplicationOutputs[K]> {
    const pending = {
      name,
      body: JSON.stringify({ version: API_VERSION, bookId: this.bookId, input }),
    };
    const began = performance.now();
    for (let attempt = 0; ; attempt += 1) {
      try {
        return (await this.send(pending, undefined, signal)).data as ApplicationOutputs[K];
      } catch (error) {
        const wait = readAgain.waits[attempt];
        if (
          wait === undefined ||
          !(error instanceof ApplicationRequestError) ||
          !error.again ||
          signal?.aborted ||
          performance.now() - began + wait > READ_AGAIN_WITHIN_MS
        )
          throw error;
        await new Promise<void>((done) => setTimeout(done, wait));
        if (signal?.aborted) throw error;
      }
    }
  }

  /** Send a write that is retained first. A key action (accept, post, save) is timed from the click to
   * the screen showing it, when this page view reports how it felt (rum-hook.ts); otherwise this is
   * exactly `writeRetained`. */
  async write<K extends ApplicationOperation>(
    name: K,
    input: ApplicationInputs[K],
    workflow: string,
  ): Promise<ApplicationOutputs[K]> {
    const confirmed = timeAction(name);
    try {
      const data = await this.writeRetained(name, input, workflow);
      confirmed?.("ok");
      return data;
    } catch (error) {
      confirmed?.(outcomeOfError(error));
      throw error;
    }
  }

  private async writeRetained<K extends ApplicationOperation>(
    name: K,
    input: ApplicationInputs[K],
    workflow: string,
  ): Promise<ApplicationOutputs[K]> {
    if (!writes.has(name)) throw new Error("Unsupported application write");
    let completed: ApplicationCompletion;
    try {
      completed = await this.lock(this.key(workflow), async () => {
        let pending = this.pending(workflow);
        if (pending) {
          if (
            pending.name !== name ||
            JSON.stringify(JSON.parse(pending.body).input) !== JSON.stringify(input)
          )
            throw new ApplicationRequestError(
              "Resume the original request before sending another write.",
              "request_pending",
              true,
            );
        } else {
          const operationId =
            name === "operations.commit"
              ? (input as ApplicationInputs["operations.commit"]).planId
              : crypto.randomUUID();
          pending = {
            name,
            body: JSON.stringify({ version: API_VERSION, bookId: this.bookId, operationId, input }),
          };
          this.storage.setItem(this.key(workflow), JSON.stringify(pending));
        }
        return this.send(pending, workflow);
      });
    } finally {
      // Whether it went through or its outcome is uncertain, what the page holds of the service may no longer be so (held.ts).
      held.clear();
    }
    announceWrite(name);
    return completed.data as ApplicationOutputs[K];
  }

  async resume(workflow: string): Promise<ApplicationCompletion> {
    let completed: ApplicationCompletion;
    try {
      completed = await this.lock(this.key(workflow), async () => {
        const pending = this.pending(workflow);
        if (!pending)
          throw new ApplicationRequestError("No pending request to resume", "request_not_found");
        return this.send(pending, workflow);
      });
    } finally {
      held.clear();
    }
    announceWrite(completed.name);
    return completed;
  }

  /**
   * Run a long job. The request is retained before it is sent, like any write; while the service
   * answers `running` it is sent again, byte for byte, which attaches to the same job and never
   * starts a second. It returns the job when it is `done` or `failed`. A dropped connection throws
   * an uncertain error and keeps the request, so `resumeJob` reaches the same job afterwards.
   */
  async writeJob<K extends JobOperation>(
    name: K,
    input: ApplicationInputs[K],
    workflow: string,
    options: JobOptions<K> = {},
  ): Promise<ApplicationOutputs[K]> {
    if (!jobs.has(name)) throw new Error("Unsupported application job");
    const completed = await this.lock(this.key(workflow), async () => {
      let pending = this.pending(workflow);
      if (pending) {
        if (
          pending.name !== name ||
          JSON.stringify(JSON.parse(pending.body).input) !== JSON.stringify(input)
        )
          throw new ApplicationRequestError(
            "Resume the original request before sending another write.",
            "request_pending",
            true,
          );
      } else {
        pending = {
          name,
          body: JSON.stringify({
            version: API_VERSION,
            bookId: this.bookId,
            operationId: crypto.randomUUID(),
            input,
          }),
        };
        this.storage.setItem(this.key(workflow), JSON.stringify(pending));
      }
      return this.untilJobEnds(pending, workflow, options as JobOptions<JobOperation>);
    });
    return completed.data as ApplicationOutputs[K];
  }

  /** Reach the job a retained request belongs to, after a dropped connection or a reload. */
  async resumeJob<K extends JobOperation>(
    workflow: string,
    options: JobOptions<K> = {},
  ): Promise<ApplicationOutputs[K]> {
    const completed = await this.lock(this.key(workflow), async () => {
      const pending = this.pending(workflow);
      if (!pending || !jobs.has(pending.name))
        throw new ApplicationRequestError("No pending job to resume", "request_not_found");
      return this.untilJobEnds(pending, workflow, options as JobOptions<JobOperation>);
    });
    return completed.data as ApplicationOutputs[K];
  }

  private async untilJobEnds(
    pending: PendingRequest,
    workflow: string,
    options: JobOptions<JobOperation>,
  ): Promise<ApplicationCompletion> {
    for (;;) {
      const done = await this.send(pending, workflow);
      if (!running(pending.name, done.data)) return done;
      options.onProgress?.(done.data as ApplicationOutputs[JobOperation]);
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 1000));
      if (options.signal?.aborted)
        throw new ApplicationRequestError(
          "Stopped waiting. The job is still running in the service; ask again to reach it.",
          "operation_unresolved",
          true,
        );
    }
  }

  private async send(
    pending: PendingRequest,
    workflow?: string,
    abandon?: AbortSignal,
  ): Promise<ApplicationCompletion> {
    const request = JSON.parse(pending.body);
    let result: ApplicationResponse<ApplicationOperation>;
    let response: Response;
    // A service that wants a sign-in says so with a 401 before it looks at the request: nothing was done.
    let signedOut = false;
    try {
      response = await this.fetcher(`/v1/${pending.name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: pending.body,
        signal: abandon
          ? AbortSignal.any([abandon, AbortSignal.timeout(10000)])
          : AbortSignal.timeout(10000),
      });
      result = await response.json();
      signedOut =
        response.status === 401 &&
        (result as { error?: { code?: unknown } }).error?.code === SIGN_IN_REQUIRED_CODE;
      if (
        !signedOut &&
        (result.version !== API_VERSION ||
          result.bookId !== this.bookId ||
          result.operationId !== request.operationId ||
          typeof result.ok !== "boolean" ||
          (result.ok
            ? !response.ok ||
              !result.data ||
              !this.validResult(pending.name, result.data, request.operationId)
            : response.ok ||
              typeof result.error?.code !== "string" ||
              typeof result.error.message !== "string" ||
              typeof result.error.retryable !== "boolean" ||
              !Array.isArray(result.error.details)))
      )
        throw new Error("Invalid application response");
    } catch {
      throw new ApplicationRequestError(
        workflow
          ? "The result is uncertain. Resume the original request; do not create a replacement."
          : "The application could not be read.",
        workflow ? "operation_unresolved" : "service_unavailable",
        !!workflow,
        [],
        // No answer, or one that was not the service's: a read may be asked again (a write has its own way, the retained request).
        !workflow,
      );
    }
    if (signedOut) {
      // The page asks for the sign-in. A write keeps its retained request, which is sent again, with the
      // same identity, once the person has signed in: it was refused whole, and sending it again is safe
      // whether or not it ever reached the books.
      announceSignInRequired();
      throw new ApplicationRequestError(SESSION_ENDED_MESSAGE, SIGN_IN_REQUIRED_CODE, !!workflow);
    }
    if (!result.ok) {
      const uncertain =
        result.error.retryable ||
        result.error.code === "operation_unresolved" ||
        result.error.code === "permission_denied";
      if (workflow && !uncertain) this.storage.removeItem(this.key(workflow));
      throw new ApplicationRequestError(
        result.error.message,
        result.error.code,
        uncertain,
        result.error.details,
        result.error.retryable === true,
      );
    }
    // A job that is still running keeps its request: asking again with the same bytes reaches it.
    if (workflow && !running(pending.name, result.data))
      this.storage.removeItem(this.key(workflow));
    return { name: pending.name, data: result.data } as ApplicationCompletion;
  }

  private validResult(name: ApplicationOperation, raw: unknown, operationId?: string): boolean {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const data = raw as Record<string, unknown>;
    if (name === "operations.commit")
      return (
        data.operationId === operationId &&
        ["committed", "rejected"].includes(String(data.disposition)) &&
        typeof data.outcomeSequence === "string" &&
        Array.isArray(data.diagnostics) &&
        Array.isArray(data.problems)
      );
    // A prepared year-end is one plan made of several; its commit is one receipt for all of them.
    if (name === "periods.yearEnd")
      return (
        data.disposition === "prepared" &&
        data.planId === operationId &&
        data.operationId === operationId &&
        typeof data.planHash === "string" &&
        /^[0-9a-f]{64}$/.test(data.planHash) &&
        typeof data.valid === "boolean" &&
        Array.isArray(data.steps) &&
        Array.isArray(data.checks) &&
        !!data.statements
      );
    if (name === "periods.commitYearEnd")
      return (
        data.operationId === operationId &&
        ["committed", "rejected"].includes(String(data.disposition)) &&
        Array.isArray(data.steps) &&
        Number.isSafeInteger(data.closedCount) &&
        Number.isSafeInteger(data.totalCount)
      );
    if (
      name === "journal.prepare" ||
      name === "periods.extend" ||
      name.includes("prepare") ||
      name.startsWith("accounts.prepare")
    ) {
      const effects = data.effects as PreparedEffects | undefined;
      return (
        data.disposition === "prepared" &&
        data.planId === operationId &&
        data.operationId === operationId &&
        typeof data.planHash === "string" &&
        /^[0-9a-f]{64}$/.test(data.planHash) &&
        typeof data.valid === "boolean" &&
        typeof data.bookRevision === "string" &&
        !!effects &&
        Array.isArray(effects.journals) &&
        Array.isArray(effects.accounts) &&
        Array.isArray(effects.periods) &&
        Array.isArray(data.diagnostics) &&
        Array.isArray(data.problems)
      );
    }
    if (name === "journal.post") return validPost(data);
    if (name === "book.setup") return !!data.setup && typeof data.outcomeSequence === "string";
    if (name === "drafts.discard")
      return data.disposition === "discarded" && typeof data.draftId === "string";
    if (["drafts.get", "drafts.create", "drafts.save", "drafts.recover"].includes(name))
      return (
        typeof data.id === "string" &&
        Number.isSafeInteger(data.version) &&
        Number(data.version) > 0 &&
        ["draft", "posting", "rejected", "posted"].includes(String(data.status)) &&
        !!data.data
      );
    return true;
  }
}
