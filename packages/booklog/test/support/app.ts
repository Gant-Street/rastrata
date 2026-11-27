/** The real application served from a book in the log: what the hosted API server does, for the tests
 * and experiments that need the product itself on top of the storage protocol. The application's side
 * of that (which requests change the book, which reads are logged first, what a host must hand over)
 * lives in `@rastrata/application/hosted`, where the server uses it too. */
import type { Database } from "bun:sqlite";
import type { ApplicationHttp } from "@rastrata/application/http";
import type { LocalBookService, LocalOpenOptions } from "@rastrata/application/local";
import {
  APPLICATION_DERIVED,
  APPLICATION_SCHEMA,
  agentReadsLogFirst,
  changesBook,
  isAgentRequest,
  openHostedService,
} from "@rastrata/application/hosted";
import { APPLICATION_API_VERSION } from "@rastrata/application/schema";
import {
  HostedBook,
  type HostedApplication,
  type HostedBookOptions,
  type HostedReason,
} from "../../src/hosted.ts";

export { APPLICATION_DERIVED, APPLICATION_SCHEMA, agentReadsLogFirst, changesBook, isAgentRequest };

export interface ApplicationOptions {
  /** Passed to the service; `database` is set here, its own snapshots are off unless
   * `applicationSnapshots` says so, and `safety` is off unless named. */
  readonly local?: Omit<LocalOpenOptions, "database" | "snapshots">;
  /** The service's own snapshot of its verified state (off for a hosted book, whose snapshot is the
   * file in the object store; an experiment turns it on to price what it costs a cold read). */
  readonly applicationSnapshots?: boolean;
  /** Called with every service made, before it serves: point its clock and ports where a test wants. */
  readonly wire?: (service: LocalBookService, reason: HostedReason) => void | Promise<void>;
  /** Where the service believes its book file is: the folder it keeps private files and safety copies
   * beside. By default the cache file's own path. */
  readonly servicePath?: string;
}

export interface ServedApplication extends HostedApplication {
  readonly service: LocalBookService;
  readonly http: ApplicationHttp;
}

/** The service and the HTTP boundary in front of it, on the connection the book was handed. `path`
 * is only where the service looks for its private files (a Stripe key, a bank feed credential). */
export async function openApplication(
  db: Database,
  reason: HostedReason,
  path: string,
  options: ApplicationOptions = {},
): Promise<ServedApplication> {
  const { prepareSlices, ...local } = options.local ?? {};
  return openHostedService(db, path, {
    local,
    ...(prepareSlices !== undefined ? { prepareSlices } : {}),
    ...(options.applicationSnapshots !== undefined
      ? { snapshots: options.applicationSnapshots }
      : {}),
    ...(options.wire ? { wire: (service) => options.wire?.(service, reason) } : {}),
  });
}

/** Everything a hosted book needs except the storage: pass the tail, the bulk store and the identity. */
export type HostedApplicationOptions = Omit<
  HostedBookOptions,
  "open" | "changesBook" | "schema" | "exclude"
> &
  ApplicationOptions & { readonly schema?: number };

export function openHostedApplication(options: HostedApplicationOptions): Promise<HostedBook> {
  const { local, wire, applicationSnapshots, servicePath, schema, ...rest } = options;
  const application: ApplicationOptions = {
    ...(local ? { local } : {}),
    ...(wire ? { wire } : {}),
    ...(applicationSnapshots !== undefined ? { applicationSnapshots } : {}),
  };
  return HostedBook.open({
    readEffects: { mode: "defer", deferMs: 2000 },
    effects: agentReadsLogFirst,
    ...rest,
    schema: schema ?? APPLICATION_SCHEMA,
    exclude: APPLICATION_DERIVED,
    open: (db, reason) => openApplication(db, reason, servicePath ?? options.path, application),
    changesBook,
  });
}

/** One request to an operation, the way a client sends it. */
export function operationRequest(
  name: string,
  input: unknown = {},
  operationId?: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://127.0.0.1:4010/v1/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      version: APPLICATION_API_VERSION,
      bookId: "local-book",
      input,
      ...(operationId ? { operationId } : {}),
    }),
  });
}

export interface Reply {
  readonly status: number;
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are inspected loosely
  readonly body: any;
}

/** Send an operation to a hosted book. A write gets a fresh operation identity unless one is given. */
export async function callOperation(
  book: { fetch(request: Request): Promise<Response> },
  name: string,
  input: unknown = {},
  operationId?: string,
): Promise<Reply> {
  const id = operationId ?? (changesBook(operationRequest(name)) ? crypto.randomUUID() : undefined);
  const response = await book.fetch(operationRequest(name, input, id));
  return { status: response.status, body: await response.json() };
}
