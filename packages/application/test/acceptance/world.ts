/** The harness for the acceptance tests: one real local book on a private database, reached only
 * through `ApplicationHttp` (the same boundary a client uses), with every lane's clock seam pointed
 * at one injected clock and the stand-in Stripe wired in. Nothing here knows the product's
 * internals beyond the seams the lanes' own tests already use. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WRITE_OPERATIONS } from "../../src/client-contracts.gen.ts";
import { ApplicationHttp } from "../../src/http.ts";
import { LocalBookService } from "../../src/local.ts";
import { configureSafety } from "../../src/safety/jobs.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS } from "../../src/schema.ts";
import { useClock } from "../../src/slices/statements/ports.ts";
import { configureStripeRuntime } from "../../src/slices/stripe/runtime.ts";
import { type FakeStripe, fakeStripe } from "../stripe/fake-stripe.ts";
import { type Scenario, buildScenario, fakeKey } from "../stripe/fixtures.ts";

/** Parsed JSON, loosely typed the way tests read an answer. */
// biome-ignore lint/suspicious/noExplicitAny: tests read untyped JSON answers.
export type Json = any;

export interface Reply {
  readonly status: number;
  readonly body: Json;
  readonly headers: Headers;
}

/** The founder's "today": the second of April 2026, noon UTC, after the month being booked. */
export const TODAY = Date.UTC(2026, 3, 2, 12, 0, 0);

const WRITES: ReadonlySet<string> = new Set(WRITE_OPERATIONS);

export const KEY = fakeKey("ACCEPTANCE");

export interface World {
  readonly directory: string;
  readonly path: string;
  readonly service: LocalBookService;
  readonly scenario: Scenario;
  readonly stripe: FakeStripe;
  readonly clock: { ms: number };
  /** One request through the HTTP boundary as the owner (or as `credential`, a bearer token). */
  call(
    name: string,
    input?: unknown,
    options?: { operationId?: string; credential?: string },
  ): Promise<Reply>;
  /** A call that must succeed: returns its `data`, or throws a short description of the failure. */
  ok(name: string, input?: unknown, options?: { operationId?: string }): Promise<Json>;
  /** A long operation (backup, verify, drill, export) run to its end: asked again under one operation
   * identity while it is running, as a client does. Returns the finished job. */
  job(name: string, input?: unknown): Promise<Json>;
  /** `POST /v1/uploads`: the raw bytes of a file. Returns the receipt. */
  upload(
    bytes: Uint8Array | string,
    name?: string,
    mediaType?: string,
    credential?: string,
  ): Promise<Reply>;
  /** Close the book and open the same database again, as a restart would. */
  restart(): Promise<void>;
  close(): void | Promise<void>;
}

const short = (value: unknown): string => JSON.stringify(value).slice(0, 700);

/** One owner call against a service the story did not open itself (a rebuilt or restored copy). */
export async function askOwner(
  service: LocalBookService,
  name: string,
  input: unknown = {},
): Promise<Json> {
  const http = new ApplicationHttp(service, {
    bookId: service.bookId,
    permissions: BUSINESS_PERMISSIONS,
  });
  const response = await http.fetch(
    new Request(`http://127.0.0.1:4010/v1/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: APPLICATION_API_VERSION, bookId: "local-book", input }),
    }),
  );
  const body = (await response.json()) as Json;
  if (response.status !== 200 || body.ok !== true)
    throw new Error(`${name} answered ${response.status}: ${short(body.error ?? body)}`);
  return body.data;
}

/** Where a world's book lives and how its requests are served. The default is a local file opened
 * here. Naming a module in ACCEPTANCE_BACKEND (an absolute path whose default export has this shape)
 * runs the same story on another storage, as the hosted book log's tests do: every service the
 * backend makes is handed to `wire`, which points its clock, safety jobs and Stripe at the world's. */
export interface WorldBackend {
  start(context: {
    readonly directory: string;
    readonly path: string;
    readonly now: () => Date;
    readonly wire: (service: LocalBookService) => void;
  }): Promise<{
    fetch(request: Request): Promise<Response>;
    service(): LocalBookService;
    restart(): Promise<void>;
    close(): Promise<void>;
  }>;
}

async function chosenBackend(): Promise<WorldBackend | null> {
  const module = process.env.ACCEPTANCE_BACKEND;
  if (!module) return null;
  return ((await import(module)) as { default: WorldBackend }).default;
}

export async function openWorld(): Promise<World> {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-acceptance-"));
  const path = join(directory, "book.sqlite");
  const clock = { ms: TODAY };
  const now = () => new Date(clock.ms);
  const scenario = buildScenario();
  // The stand-in Stripe reads its balance at the same instant as everything else.
  const stripe = fakeStripe(scenario, { key: KEY, now: () => Math.floor(clock.ms / 1000) });

  const wire = (target: LocalBookService) => {
    // The service's clock reaches every lane's records (finding 11); the statements lane's own seam
    // and the stand-in Stripe's are pointed at it too, as they were before.
    useClock(target, now);
    configureSafety(target, { waitMs: 60_000 });
    configureStripeRuntime(target, {
      keySource: { read: () => ({ key: KEY, source: "environment" }) },
      fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
        stripe.fetch(input, init)) as typeof fetch,
      now: () => now().toISOString(),
      sleep: async () => {},
      random: () => 0.5,
    });
  };
  let service!: LocalBookService;
  let http!: ApplicationHttp;
  const open = async () => {
    service = await LocalBookService.open(path, { now });
    http = new ApplicationHttp(
      service,
      { bookId: service.bookId, permissions: BUSINESS_PERMISSIONS },
      { clock: now },
    );
    wire(service);
  };
  const backend = await chosenBackend();
  const hosted = backend ? await backend.start({ directory, path, now, wire }) : null;
  if (!hosted) await open();
  const send = (request: Request): Promise<Response> =>
    hosted ? hosted.fetch(request) : http.fetch(request);

  const call: World["call"] = async (name, input = {}, options = {}) => {
    const operationId = options.operationId ?? (WRITES.has(name) ? crypto.randomUUID() : undefined);
    const response = await send(
      new Request(`http://127.0.0.1:4010/v1/${name}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.credential ? { authorization: `Bearer ${options.credential}` } : {}),
        },
        body: JSON.stringify({
          version: APPLICATION_API_VERSION,
          bookId: "local-book",
          input,
          ...(operationId ? { operationId } : {}),
        }),
      }),
    );
    return { status: response.status, body: await response.json(), headers: response.headers };
  };

  return {
    directory,
    path,
    get service() {
      return hosted ? hosted.service() : service;
    },
    scenario,
    stripe,
    clock,
    call,
    async ok(name, input = {}, options = {}) {
      const reply = await call(name, input, options);
      if (reply.status !== 200 || reply.body.ok !== true)
        throw new Error(
          `${name} answered ${reply.status}: ${short(reply.body.error ?? reply.body)}`,
        );
      return reply.body.data;
    },
    async job(name, input = {}) {
      const operationId = crypto.randomUUID();
      for (let attempt = 0; attempt < 1200; attempt++) {
        const reply = await call(name, input, { operationId });
        if (reply.status !== 200 || reply.body.ok !== true)
          throw new Error(
            `${name} answered ${reply.status}: ${short(reply.body.error ?? reply.body)}`,
          );
        if (reply.body.data.state !== "running") return reply.body.data;
        await Bun.sleep(50);
      }
      throw new Error(`${name} did not finish`);
    },
    async upload(bytes, name = "statement.csv", mediaType = "text/csv", credential) {
      const response = await send(
        new Request("http://127.0.0.1:4010/v1/uploads", {
          method: "POST",
          headers: {
            "content-type": mediaType,
            "x-upload-name": encodeURIComponent(name),
            ...(credential ? { authorization: `Bearer ${credential}` } : {}),
          },
          body: (typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes) as BodyInit,
        }),
      );
      return { status: response.status, body: await response.json(), headers: response.headers };
    },
    async restart() {
      if (hosted) return hosted.restart();
      service.close();
      await open();
    },
    async close() {
      try {
        if (hosted) await hosted.close();
        else service.close();
      } catch {
        // Already closed by the test.
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
