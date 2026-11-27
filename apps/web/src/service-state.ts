import { notReading, type Warmup } from "./access-note";
import { takeEarlyService } from "./early";

/** Reads what GET /health says about the service reading its book. Anything else (a development
 * server with no such answer, a service that is down, a reply that is not what a Rastrata service
 * says) is "not reading": the footer claims nothing it was not told. */
export function warmupOf(body: unknown): Warmup {
  if (typeof body !== "object" || body === null) return notReading;
  const health = body as { service?: unknown; warmup?: unknown };
  if (health.service !== "rastrata" || typeof health.warmup !== "object" || health.warmup === null)
    return notReading;
  const warmup = health.warmup as { state?: unknown; secondsLeft?: unknown; error?: unknown };
  if (warmup.state === "reading")
    return {
      reading: true,
      secondsLeft:
        typeof warmup.secondsLeft === "number" && Number.isFinite(warmup.secondsLeft)
          ? Math.max(0, warmup.secondsLeft)
          : null,
      failure: null,
    };
  if (warmup.state === "failed")
    return {
      reading: false,
      secondsLeft: null,
      failure: typeof warmup.error === "string" ? warmup.error : "",
    };
  return notReading;
}

/** Whether what GET /health says is a hosted service's (it has a `hosted` section: to a stranger only what the page may offer, to the owner's key the book as well). The installed
 * service and the development servers do not, and a page they serve never asks anyone to sign in. */
export function hostedOf(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const hosted = (body as { hosted?: unknown }).hosted;
  return typeof hosted === "object" && hosted !== null && !Array.isArray(hosted);
}

/** Whether people sign in to this service with accounts (an emailed code at `/auth`) and not only with the owner's key. */
export function accountsOf(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const hosted = (body as { hosted?: unknown }).hosted;
  return (
    typeof hosted === "object" &&
    hosted !== null &&
    (hosted as { accounts?: unknown }).accounts === true
  );
}

/** Whether the service can keep a bank or Stripe credential for the book it serves. One that holds many books in one process cannot (a credential kept beside the books
 * would be every book's) and says so in GET /health; every other service can, which is also what is assumed of one that does not answer. */
export function connectionsOf(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return true;
  const hosted = (body as { hosted?: unknown }).hosted;
  return !(
    typeof hosted === "object" &&
    hosted !== null &&
    (hosted as { connections?: unknown }).connections === false
  );
}

/** Whether the service takes an agent's token. A hosted service that is not set to takes only the owner's key and people's tokens, and says so in GET /health; every other
 * service does, which is also what is assumed of one that does not answer. */
export function agentsOf(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return true;
  const hosted = (body as { hosted?: unknown }).hosted;
  return !(
    typeof hosted === "object" &&
    hosted !== null &&
    (hosted as { agents?: unknown }).agents === false
  );
}

/** Whether the service makes backups for the person to see. A hosted service keeps them itself and says so in GET /health; every other service makes them, which is also what is
 * assumed of one that does not answer. */
export function backupsOf(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return true;
  const hosted = (body as { hosted?: unknown }).hosted;
  return !(
    typeof hosted === "object" &&
    hosted !== null &&
    (hosted as { backups?: unknown }).backups === false
  );
}

/** What the service says about itself in GET /health: whether it is reading its book, whether it is a
 * hosted service, whether it has accounts, whether it can keep a connection's credential, whether it
 * takes an agent's token and whether it makes backups. The page asks once and learns all six. */
export interface ServiceState {
  readonly warmup: Warmup;
  readonly hosted: boolean;
  readonly accounts: boolean;
  readonly connections: boolean;
  readonly agents: boolean;
  readonly backups: boolean;
}

const unknownService: ServiceState = {
  warmup: notReading,
  hosted: false,
  accounts: false,
  connections: true,
  agents: true,
  backups: true,
};

/** Asks the service. It never throws: a question that cannot be answered is not a problem for the page. Asked with no `ask`, it takes the answer the page's first lines have already
 * asked for, if there is one (early.ts), and asks itself when there is none. */
export async function readService(ask?: typeof fetch): Promise<ServiceState> {
  try {
    const early = ask === undefined ? takeEarlyService() : null;
    const response = await (early ??
      (ask ?? fetch)("/health", {
        headers: { accept: "application/json" },
        cache: "no-store",
      }));
    if (!response.ok || !(response.headers.get("content-type") ?? "").includes("json"))
      return unknownService;
    const body = await response.json();
    return {
      warmup: warmupOf(body),
      hosted: hostedOf(body),
      accounts: accountsOf(body),
      connections: connectionsOf(body),
      agents: agentsOf(body),
      backups: backupsOf(body),
    };
  } catch {
    return unknownService;
  }
}

/** What the service says about reading its book (see `readService`). */
export async function readWarmup(ask: typeof fetch = fetch): Promise<Warmup> {
  return (await readService(ask)).warmup;
}
