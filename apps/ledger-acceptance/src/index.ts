import { timingSafeEqual } from "node:crypto";
import { encodeDurableBook, hashCanonical } from "@rastrata/kernel";
import {
  ProductionLedger,
  NativeLedger,
  SqliteLedgerRepository,
  SqliteBookStorage,
  bookObjectName,
  type SqliteStorage,
} from "@rastrata/ledger";
import { BOOK, TENANT, activation, genesis, posting, nativeSave } from "./scenario.ts";

interface Environment {
  DEPLOYMENT_KIND?: string;
  DEV_EXPIRES_AT?: string;
  DEV_ACCESS_TOKEN?: string;
  BOOKS: {
    idFromName(name: string): { toString(): string };
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
  NATIVE_BOOKS?: Environment["BOOKS"];
}

function json(body: unknown, status = 200): Response {
  return new Response(
    JSON.stringify(body, (_key, value) => (typeof value === "bigint" ? value.toString() : value)),
    {
      status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

// Authorization precedes object routing and is repeated inside the object. No token in URLs/logs.
function authorize(request: Request, env: Environment): Response | null {
  const expiry = Number(env.DEV_EXPIRES_AT);
  if (
    env.DEPLOYMENT_KIND !== "synthetic-development-only" ||
    !Number.isSafeInteger(expiry) ||
    expiry <= Date.now() ||
    !env.DEV_ACCESS_TOKEN ||
    !/^[a-f0-9]{64}$/.test(env.DEV_ACCESS_TOKEN)
  )
    return json({ error: "development_access_disabled" }, 503);
  const provided = request.headers.get("authorization");
  if (
    !provided ||
    !/^Bearer [a-f0-9]{64}$/.test(provided) ||
    !timingSafeEqual(Buffer.from(provided.slice(7)), Buffer.from(env.DEV_ACCESS_TOKEN))
  )
    return json({ error: "unauthorized" }, 401);
  return null;
}

async function admit(request: Request, env: Environment): Promise<Response | null> {
  const denied = authorize(request, env);
  if (denied) return denied;
  const url = new URL(request.url);
  if (url.search) return json({ error: "payloads_not_supported" }, 400);
  const expectedMethod = {
    "/health": "GET",
    "/state": "GET",
    "/smoke": "POST",
    "/native/state": "GET",
    "/native/smoke": "POST",
    "/native/save": "POST",
  }[url.pathname];
  if (!expectedMethod) return json({ error: "not_found" }, 404);
  if (request.method !== expectedMethod) return json({ error: "method_not_allowed" }, 405);
  // workerd may represent a zero-byte POST as a stream. Read at most one chunk,
  // reject any payload, and never buffer or deserialize caller-provided data.
  if (request.body) {
    const reader = request.body.getReader();
    try {
      if (!(await reader.read()).done) return json({ error: "payloads_not_supported" }, 400);
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  }
  return null;
}

export class SyntheticBook {
  private readonly ledger: ProductionLedger;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    ctx: { storage: SqliteStorage; id: { toString(): string } },
    private readonly env: Environment,
  ) {
    const objectId = ctx.id.toString();
    this.ledger = new ProductionLedger(new SqliteBookStorage(objectId, ctx.storage), {
      tenantId: TENANT,
      bookId: BOOK,
      objectId,
    });
  }

  async fetch(request: Request): Promise<Response> {
    const denied = await admit(request, this.env);
    if (denied) return denied;
    if (new URL(request.url).pathname.startsWith("/native/"))
      return json({ error: "not_found" }, 404);
    const operation = this.tail.then(async () => {
      const deniedAfterQueue = authorize(request, this.env);
      if (deniedAfterQueue) return deniedAfterQueue;
      const path = new URL(request.url).pathname;
      if (path === "/health") return json({ deployment: "synthetic-development-only" });
      if (path === "/state") {
        const { head, aggregate } = await this.ledger.read();
        return json({ head, aggregateHash: hashCanonical(encodeDurableBook(aggregate)) });
      }
      await this.ledger.provision(genesis());
      const activated = await this.ledger.execute(activation());
      const accepted = await this.ledger.execute(posting(true));
      const rejected = await this.ledger.execute(posting(false));
      const acceptedRetry = await this.ledger.execute(posting(true));
      const rejectedRetry = await this.ledger.execute(posting(false));
      const { head, aggregate } = await this.ledger.read();
      return json({
        activated,
        accepted,
        rejected,
        acceptedRetry,
        rejectedRetry,
        head,
        aggregateHash: hashCanonical(encodeDurableBook(aggregate)),
      });
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }
}

/** Separate SQLite namespace: never adopts or changes the existing synthetic book.
 * At most four fixed outcomes, no customer input and no unbounded load endpoint. */
export class SyntheticNativeBook {
  private readonly repository: SqliteLedgerRepository;
  private readonly ledger: NativeLedger;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  constructor(
    ctx: { storage: SqliteStorage; id: { toString(): string } },
    private readonly env: Environment,
  ) {
    const objectId = ctx.id.toString();
    this.repository = new SqliteLedgerRepository(
      ctx.storage,
      {
        tenantId: TENANT,
        bookId: BOOK,
        objectId,
        namespaceId: "rastrata-ledger-dev_SyntheticNativeBook",
        generation: "0",
      },
      objectId,
      () => ({
        fence: "0",
        pending:
          !Number.isSafeInteger(Number(env.DEV_EXPIRES_AT)) ||
          Number(env.DEV_EXPIRES_AT) <= Date.now(),
      }),
    );
    this.ledger = new NativeLedger(this.repository);
  }
  async fetch(request: Request): Promise<Response> {
    const denied = await admit(request, this.env);
    if (denied) return denied;
    const path = new URL(request.url).pathname;
    if (path !== "/native/state" && path !== "/native/smoke" && path !== "/native/save")
      return json({ error: "not_found" }, 404);
    if (this.pending >= 16) return json({ error: "development_overloaded" }, 429);
    this.pending++;
    const operation = this.tail.then(async () => {
      const deniedAfterQueue = authorize(request, this.env);
      if (deniedAfterQueue) return deniedAfterQueue;
      if (path === "/native/save") {
        // Provisioning belongs to /native/smoke. This endpoint measures exactly
        // one immutable command, then only retries its permanent identity.
        const saved = await this.ledger.execute(nativeSave());
        return json({ head: saved.head, ...saved.value });
      }
      let dispositions: readonly string[] = [];
      if (path === "/native/smoke") {
        await this.ledger.provision(genesis(), activation());
        const accepted = await this.ledger.execute(posting(true));
        const rejected = await this.ledger.execute(posting(false));
        const acceptedRetry = await this.ledger.execute(posting(true));
        const rejectedRetry = await this.ledger.execute(posting(false));
        dispositions = [
          accepted.value.result.disposition,
          rejected.value.result.disposition,
          acceptedRetry.value.result.disposition,
          rejectedRetry.value.result.disposition,
        ];
      }
      const page = await this.repository.outcomePage(null, 4);
      if (
        !["3", "4"].includes(page.observedTip.sequence) ||
        page.through.sequence !== page.observedTip.sequence ||
        page.outcomes.length !== Number(page.observedTip.sequence)
      )
        throw new Error("Unexpected native synthetic population");
      return json({
        profile: "native-book-commands-v1",
        scope: this.repository.scope,
        genesis: page.genesis,
        head: page.observedTip,
        outcomes: page.outcomes.map((row) => ({ head: row.head, encoded: row.encoded })),
        ...(path === "/native/smoke" ? { dispositions } : {}),
      });
    });
    this.tail = operation.catch(() => undefined);
    try {
      return await operation;
    } finally {
      this.pending--;
    }
  }
}

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    const denied = await admit(request, env);
    if (denied) return denied;
    if (new URL(request.url).pathname === "/health")
      return json({ deployment: "synthetic-development-only" });
    try {
      const forwarded = new Request(request.url, {
        method: request.method,
        headers: request.headers,
      });
      const namespace = new URL(request.url).pathname.startsWith("/native/")
        ? env.NATIVE_BOOKS
        : env.BOOKS;
      if (!namespace) return json({ error: "ledger_unavailable" }, 503);
      return await namespace
        .get(namespace.idFromName(bookObjectName(TENANT, BOOK)))
        .fetch(forwarded);
    } catch {
      // Storage failure is not an accounting rejection. Do not leak exception contents.
      return json({ error: "ledger_unavailable" }, 503);
    }
  },
};
