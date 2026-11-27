import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildScenario,
  fakeKey,
  fakeStripe,
  type Scenario,
} from "@rastrata/application/testing/evaluation-fixtures";
import { API_MAIN, REPO_ROOT } from "./paths.ts";
import { type Spawned, sleep, spawnGroup, waitFor } from "./util.ts";

/** A TCP port that was free a moment ago. The caller retries if binding it fails. */
export async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port;
  if (port === undefined) throw new Error("No free port");
  await probe.stop(true);
  return port;
}

/** The environment a trusted harness process gives the service: a short list, never the caller's
 * whole environment (which may hold the caller's own tokens). */
function serviceEnvironment(extra: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "SHELL"]) {
    const value = process.env[name];
    if (value) base[name] = value;
  }
  return { ...base, ...extra };
}

export interface FakeStripeServer {
  readonly url: string;
  /** A key-shaped string that is made up at run time and accepted only by this stand-in. */
  readonly key: string;
  stop(): Promise<void>;
}

/** The stand-in Stripe of the Stripe lane's tests, listening on this machine only, for the service
 * to sync from. It holds nothing but the fictional month in `scenario`. */
export async function startFakeStripe(
  scenario: Scenario = buildScenario(),
): Promise<FakeStripeServer> {
  const key = fakeKey("EVAL");
  const stripe = fakeStripe(scenario, { key, now: () => Math.floor(Date.now() / 1000) });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      stripe.fetch(request.url, { method: request.method, headers: request.headers }),
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    key,
    stop: async () => {
      await server.stop(true);
    },
  };
}

export interface RunningService {
  /** The service's own directory: its database, backups and log. Private to the harness. */
  readonly directory: string;
  readonly databasePath: string;
  readonly ownerKeyFile: string;
  readonly port: number;
  readonly url: string;
  /** The owner key. Held in the harness only: never given to an agent. */
  ownerKey(): string;
  /** Stop gracefully (SIGTERM: the service closes its database), then wait for it to exit. */
  stop(): Promise<void>;
  /** Stop abruptly, as a crash would. */
  crash(): Promise<void>;
  readonly log: () => string;
}

export interface ServiceOptions {
  readonly directory: string;
  readonly stripe?: { readonly url: string; readonly key: string };
  readonly port?: number;
}

/** Start the real local API (apps/api/src/main.ts) on a private database with the owner lock on, as
 * the installed service has it. Backups are off: the book is a throwaway. The Stripe key and
 * address, when given, reach the service only; the agent never sees them. */
export async function startService(options: ServiceOptions): Promise<RunningService> {
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const databasePath = join(options.directory, "book.sqlite");
  const ownerKeyFile = join(options.directory, "owner.key");
  const logFile = join(options.directory, "service.log");
  let lastError = "";
  for (let attempt = 1; attempt <= 5; attempt++) {
    const port = options.port ?? (await freePort());
    const child: Spawned = spawnGroup(process.execPath, [API_MAIN], {
      cwd: REPO_ROOT,
      env: serviceEnvironment({
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_PORT: String(port),
        RASTRATA_LOCAL_DB: databasePath,
        RASTRATA_OWNER_KEY_FILE: ownerKeyFile,
        RASTRATA_BACKUPS: "off",
        ...(options.stripe
          ? { RASTRATA_STRIPE_KEY: options.stripe.key, RASTRATA_STRIPE_API_URL: options.stripe.url }
          : {}),
      }),
      onStdout: (chunk) => appendFileSync(logFile, chunk),
      onStderr: (chunk) => appendFileSync(logFile, chunk),
    });
    let exited = false;
    void child.done.then(() => {
      exited = true;
    });
    try {
      await waitFor(
        "the service",
        async () => {
          if (exited) throw new Error("the service exited");
          const response = await fetch(`http://127.0.0.1:${port}/health`);
          return response.ok ? true : undefined;
        },
        90_000,
      );
    } catch (error) {
      child.kill("SIGKILL");
      await child.done;
      lastError = `${error instanceof Error ? error.message : String(error)}\n${
        existsSync(logFile) ? readFileSync(logFile, "utf8").slice(-2000) : ""
      }`;
      if (options.port) break;
      await sleep(200);
      continue;
    }
    if (existsSync(ownerKeyFile)) chmodSync(ownerKeyFile, 0o600);
    const stop = async (signal: NodeJS.Signals) => {
      if (exited) return;
      child.kill(signal);
      const finished = await Promise.race([child.done, sleep(30_000).then(() => undefined)]);
      if (!finished) {
        child.kill("SIGKILL");
        await child.done;
      }
    };
    return {
      directory: options.directory,
      databasePath,
      ownerKeyFile,
      port,
      url: `http://127.0.0.1:${port}`,
      ownerKey: () => readFileSync(ownerKeyFile, "utf8").trim(),
      stop: () => stop("SIGTERM"),
      crash: () => stop("SIGKILL"),
      log: () => (existsSync(logFile) ? readFileSync(logFile, "utf8") : ""),
    };
  }
  throw new Error(`The service did not start: ${lastError}`);
}
