import type { AccountRole, BookSetup, JournalDraftData } from "./contracts.ts";
import {
  describePrincipal,
  type AccessPrincipal,
  type ApplicationAccess,
} from "./agent/principal.ts";
import { ROLE_PERMISSIONS } from "./agent/member.ts";
import { isOwnerKey } from "./agent/token.ts";
import { ApplicationError } from "./errors.ts";
import type { ApplicationService } from "./service.ts";
import {
  APPLICATION_API_VERSION,
  PREPARED_OPERATION_PERMISSIONS,
  READS_BEFORE_SETUP,
  WRITES_BEFORE_SETUP,
  applicationSchema,
  operationCatalog,
  permitsOperation,
  validateSchema,
  type BusinessPermission,
} from "./schema.ts";
import { exportHost } from "./safety/operations.ts";
import { ref } from "./schema-kit.ts";
import { authenticate, type AuthenticationTrace } from "./slices/agent/access.ts";
import { agentState } from "./slices/agent/store.ts";
import { changesState } from "./slices/changes/store.ts";
import { memberState } from "./slices/members/store.ts";
import { pluginState } from "./slices/plugins/store.ts";
import { readBookSettings } from "./slices/entries/settings.ts";
import { sliceHandlers } from "./slices/handlers.ts";
import { receiveUpload } from "./slices/statements/uploads.ts";
import { observeRequest } from "./telemetry.ts";

/** Largest raw body `POST /v1/uploads` accepts. Hosts that cap request bodies must allow this
 * much on that one route; every other route keeps the 128 KiB JSON limit. */
export { MAX_UPLOAD_BYTES } from "./slices/statements/uploads.ts";

export type { ApplicationAccess } from "./agent/principal.ts";

export interface ApplicationHttpOptions {
  /** Lock the owner: every request must then present this key (or an agent token) as a Bearer
   * credential, and a request with none is 401. Absent, a request with no credentials is the
   * owner, as in the loopback development mode. Tokens are honoured either way and never widen. */
  readonly ownerKey?: string;
  /** The clock for token expiry and activity. Tests only. */
  readonly clock?: () => Date;
}

/** The operations the control plane's key may call: who is in the book, the accounts and transactions of the bank connections it keeps (`banks.offer` and `banks.receive`, which
 * check for themselves that the caller is the control plane: a member who is an owner holds `provision` too), and Stripe: which account the owner connected (`stripe.link`, which
 * checks the same) and the answers it read from it (`stripe.receive`, the same operation the command line's pull calls, with the bundles it uploads). Nothing else. */
const SERVICE_OPERATIONS: readonly string[] = [
  "members.list",
  "members.add",
  "members.setRole",
  "members.remove",
  "book.retire",
  "book.unretire",
  "banks.offer",
  "banks.receive",
  "stripe.link",
  "stripe.receive",
  "book.access",
];

/** What a read-only book lets a person keep: `read`, and `configure` only because making and fetching an export needs it (the list below cuts every other `configure` operation). */
const READ_ONLY_PERMISSIONS: readonly BusinessPermission[] = ["read", "configure"];

/** What a read-only book answers: every operation that reads without writing, and the export. Worked out from the catalog, so that a new read is let through and a new write is not. */
let readOnlyList: readonly string[] | undefined;
const readOnlyOperations = (): readonly string[] =>
  (readOnlyList ??= operationCatalog
    .filter(
      (operation) =>
        (operation.permission === "read" && !operation.writes) ||
        operation.name === "export.create",
    )
    .map((operation) => operation.name));

/** The refusal of a call that the person's role allows and the book does not, because its workspace has no subscription. Said plainly, so that a person, or an agent speaking for one, tells the owner the
 * true reason and not "permission denied". */
const readOnlyRefusal = (): ApplicationError =>
  new ApplicationError(
    "workspace_read_only",
    "This workspace is read-only until it is subscribed. You can still read it and export it; an owner can subscribe.",
    403,
  );

/** What one request turned out to be, for the audit trail of agent tokens. */
interface RequestTrace extends AuthenticationTrace {
  principal?: AccessPrincipal;
  operation?: string;
  operationId?: string;
  code?: string;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const string = (input: Record<string, unknown>, key: string, fallback = "") =>
  (input[key] ?? fallback) as string;
const integer = (input: Record<string, unknown>, key: string, fallback = 1) =>
  (input[key] ?? fallback) as number;

/** The most reads one batch carries (a page asks for about thirty at most). */
export const MAX_BATCHED_READS = 40;

async function bodyText(request: Request): Promise<string> {
  const maximum = 131072;
  const declared = request.headers.get("content-length");
  if (declared && (!/^[0-9]+$/.test(declared) || Number(declared) > maximum))
    throw new ApplicationError("request_too_large", "Request exceeds 128 KiB", 413);
  if (!request.body) throw new ApplicationError("invalid_input", "Request body is required");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const deadline = Promise.withResolvers<never>();
  const abort = () =>
    deadline.reject(
      new ApplicationError("request_aborted", "Request was interrupted", 408, [], true),
    );
  request.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () =>
      deadline.reject(
        new ApplicationError("request_timeout", "Request upload timed out", 408, [], true),
      ),
    10000,
  );
  let bytes = 0,
    text = "";
  try {
    if (request.signal.aborted) abort();
    for (;;) {
      const chunk = await Promise.race([reader.read(), deadline.promise]);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximum)
        throw new ApplicationError("request_too_large", "Request exceeds 128 KiB", 413);
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Versioned workflow boundary. Access is supplied by the owning runtime and decided per request
 * from its credentials: a caller's body cannot select its actor or enlarge its business
 * permissions, and a scoped token can only ever hold less than the runtime's own access. */
export class ApplicationHttp {
  private readonly options: ApplicationHttpOptions;

  constructor(
    private readonly service: ApplicationService,
    private readonly access: ApplicationAccess,
    options: ApplicationHttpOptions = {},
  ) {
    if (access.bookId !== service.bookId) throw new Error("Application access scope mismatch");
    if (options.ownerKey !== undefined && !isOwnerKey(options.ownerKey))
      throw new Error("The owner key must be an owner key (rso_...)");
    this.options = options;
    if (options.clock) {
      agentState(service).clock = options.clock;
      memberState(service).clock = options.clock;
      pluginState(service).clock = options.clock;
    }
  }

  private requirePermission(access: ApplicationAccess, permission: BusinessPermission): void {
    if (!access.permissions.includes(permission) && access.readOnly?.held.includes(permission))
      throw readOnlyRefusal();
    if (!access.permissions.includes(permission))
      throw new ApplicationError(
        "permission_denied",
        access.principal?.kind === "token"
          ? `This operation requires ${permission} permission; this token grants ${access.permissions.join(", ") || "nothing"}`
          : `This operation requires ${permission} permission`,
        403,
      );
  }

  private response(
    value: Record<string, unknown>,
    status = 200,
    headers: Record<string, string> = {},
  ): Response {
    return Response.json(
      { version: APPLICATION_API_VERSION, bookId: this.access.bookId, ...value },
      {
        status,
        headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers },
      },
    );
  }

  /** Who is calling, decided from the Authorization header and nothing else, unless the runtime has already decided:
   * the pod checks a member's signed token before it asks the book anything, and hands the access it found. */
  private async who(
    request: Request,
    trace: AuthenticationTrace,
    authenticated?: ApplicationAccess,
  ): Promise<ApplicationAccess> {
    if (authenticated) {
      // A key the control plane vouched for leaves the same trail as a token the book made.
      if (authenticated.principal?.kind === "token")
        trace.tokenId = authenticated.principal.tokenId;
      return authenticated;
    }
    return authenticate(
      this.service,
      this.access,
      request.headers.get("authorization"),
      this.options.ownerKey,
      trace,
    );
  }

  /** The access of a person whom the runtime has already vouched for (it checked their signed token): what their role in this
   * book's own member table allows, or null when they are not in it, or no longer. Never more than the runtime's own access. */
  memberAccess(userId: string): ApplicationAccess | null {
    const state = memberState(this.service);
    // A book that is being deleted lets no member in (the runtime says why: `retired`).
    if (state.retiredAt() !== null) return null;
    const member = state.get(userId);
    if (!member) return null;
    const held = ROLE_PERMISSIONS[member.role].filter((permission) =>
      this.access.permissions.includes(permission),
    );
    const principal = { kind: "member", userId: member.userId, role: member.role } as const;
    const ownerAccess = this.options.ownerKey ? "key" : "open";
    const since = state.readOnlySince();
    if (since === null) return { ...this.access, permissions: held, principal, ownerAccess };
    // A read-only book (its workspace has no subscription): the person reads it and exports it, and nothing more. An agent key's access is the person's, so it is cut the same way.
    return {
      ...this.access,
      permissions: held.filter((permission) => READ_ONLY_PERMISSIONS.includes(permission)),
      principal,
      ownerAccess,
      operations: readOnlyOperations(),
      readOnly: { since, held },
    };
  }

  /** The access of an agent key the runtime has already vouched for (it checked a signed token made for the key): the role of the person who made the key in this book's own member
   * table, with only the permissions the key was given, and never `provision` (a key that held it could make more keys). Null when the person is not in the book, or no longer.
   * The actor recorded is the key. */
  agentAccess(
    userId: string,
    agent: {
      readonly keyId: string;
      readonly scopes: readonly string[];
      readonly name: string;
      readonly expiresAt: string;
    },
  ): ApplicationAccess | null {
    const person = this.memberAccess(userId);
    if (person === null) return null;
    return {
      ...person,
      permissions: person.permissions.filter(
        (permission) => permission !== "provision" && agent.scopes.includes(permission),
      ),
      principal: {
        kind: "token",
        tokenId: agent.keyId,
        label: agent.name,
        expiresAt: agent.expiresAt,
      },
    };
  }

  /** Whether the book is being deleted, so that no member is let in. */
  retired(): boolean {
    return memberState(this.service).retiredAt() !== null;
  }

  /** The access of the control plane acting for itself: it reads who is in the book and changes it, hands it the transactions of the owner's bank connections and the answers of the
   * owner's Stripe account (it may draft, for that and for the uploads of those answers alone), and can call nothing else (its key could otherwise read the book, or make a token that could).
   * Never a person. */
  serviceAccess(name: string): ApplicationAccess {
    return {
      ...this.access,
      permissions: (["read", "provision", "draft"] as const).filter((permission) =>
        this.access.permissions.includes(permission),
      ),
      principal: { kind: "service", name },
      ownerAccess: this.options.ownerKey ? "key" : "open",
      operations: SERVICE_OPERATIONS,
    };
  }

  /** For the browser compatibility routes (/api/*). The owner passes (null); an agent token is
   * refused, because those routes predate scoped access and agents use /v1; credentials that are
   * present but not valid are 401. Returns the response to send, or null to carry on. */
  async guardLegacy(request: Request, authenticated?: ApplicationAccess): Promise<Response | null> {
    const refusal = (status: number, error: string, code: string) =>
      Response.json(
        { error, code },
        {
          status,
          headers: {
            "cache-control": "no-store",
            ...(status === 401 ? { "www-authenticate": 'Bearer realm="rastrata"' } : {}),
          },
        },
      );
    try {
      const access = await this.who(request, {}, authenticated);
      const kind = access.principal?.kind;
      if (kind === "token")
        return refusal(
          403,
          "Agent tokens use the /v1 operations, not these browser routes",
          "token_scope_denied",
        );
      // These routes predate roles and have no permissions: only the owner is let through them.
      if (kind === "member" || kind === "service" || kind === "plugin")
        return refusal(
          403,
          "Everyone but the owner uses the /v1 operations, not these browser routes",
          "scope_denied",
        );
      return null;
    } catch (error) {
      if (error instanceof ApplicationError)
        return refusal(error.status, error.message, error.code);
      return refusal(503, "Application service is unavailable", "service_unavailable");
    }
  }

  /** For a route outside /v1 that must be as well guarded as /v1 (the browser's telemetry beacon):
   * the request must carry credentials, the owner key or an agent token with at least `read`,
   * whatever mode the service is in. An open loopback service answers a request with no credentials
   * as the owner; it does not take telemetry from it. Returns the key to rate-limit this caller by,
   * or the response to send instead. */
  async credentialed(
    request: Request,
    authenticated?: ApplicationAccess,
  ): Promise<{ readonly key: string } | Response> {
    const refuse = (status: number, error: string, code: string) =>
      Response.json(
        { error, code },
        {
          status,
          headers: {
            "cache-control": "no-store",
            ...(status === 401 ? { "www-authenticate": 'Bearer realm="rastrata"' } : {}),
          },
        },
      );
    if (!authenticated && !request.headers.get("authorization"))
      return refuse(401, "Credentials are required", "authentication_required");
    try {
      const access = await this.who(request, {}, authenticated);
      if (access.principal?.kind === "plugin")
        return refuse(403, "Plugin tokens cannot call this route", "permission_denied");
      if (!access.permissions.includes("read"))
        return refuse(403, "This credential may not read", "permission_denied");
      const principal = access.principal;
      return {
        key:
          principal?.kind === "token"
            ? `token:${principal.tokenId}`
            : principal?.kind === "member"
              ? `member:${principal.userId}`
              : principal?.kind === "service"
                ? `service:${principal.name}`
                : "owner",
      };
    } catch (error) {
      if (error instanceof ApplicationError) return refuse(error.status, error.message, error.code);
      return refuse(503, "Application service is unavailable", "service_unavailable");
    }
  }

  async fetch(request: Request, authenticated?: ApplicationAccess): Promise<Response> {
    const trace: RequestTrace = {};
    const response = await observeRequest(this.service, trace, () =>
      this.handle(request, trace, authenticated),
    );
    // Every request made with a token leaves a line the owner can read. Nothing else is
    // recorded, and a failure to record never changes the answer.
    if (trace.tokenId)
      try {
        agentState(this.service).recordActivity({
          tokenId: trace.tokenId,
          operation: trace.operation ?? "(unrouted)",
          operationId: trace.operationId ?? null,
          outcome: response.status < 400 ? "ok" : response.status < 500 ? "denied" : "failed",
          code: trace.code ?? null,
          status: response.status,
        });
      } catch (error) {
        console.error("Could not record agent activity", error instanceof Error ? error.name : "");
      }
    return response;
  }

  private async handle(
    request: Request,
    trace: RequestTrace,
    authenticated?: ApplicationAccess,
  ): Promise<Response> {
    let operationId: string | undefined;
    let writes = false;
    try {
      const url = new URL(request.url);
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin)
        throw new ApplicationError(
          "origin_denied",
          "Cross-origin application access is not enabled",
          403,
        );
      // Name what was asked for before deciding who is asking, so a refused token's trail says
      // what it tried. The path is the caller's text: only a plain operation name is recorded.
      const asked = /^\/v1\/([A-Za-z0-9._-]{1,100})$/.exec(url.pathname)?.[1];
      if (asked) trace.operation = asked;
      const access = await this.who(request, trace, authenticated);
      trace.principal = access.principal as AccessPrincipal;
      if (url.pathname === "/v1/schema" && request.method === "GET") {
        trace.operation = "schema";
        return this.response({ ok: true, data: applicationSchema });
      }
      if (url.pathname === "/v1/batch") {
        trace.operation = "batch";
        return await this.batch(request, access);
      }
      if (url.pathname === "/v1/uploads") {
        trace.operation = "uploads";
        return await this.upload(request, access);
      }
      const exported = /^\/v1\/exports\/([A-Za-z0-9][A-Za-z0-9._-]{0,100})$/.exec(
        url.pathname,
      )?.[1];
      if (exported) {
        trace.operation = "exports.download";
        return await this.exportDownload(request, access, exported);
      }
      const name = url.pathname.startsWith("/v1/") ? url.pathname.slice(4) : "";
      const operation = operationCatalog.find((item) => item.name === name);
      if (!operation || url.search)
        throw new ApplicationError("route_not_found", "Application operation not found", 404);
      trace.operation = name;
      if (request.method !== "POST")
        throw new ApplicationError("method_not_allowed", "Use POST with a versioned request", 405);
      writes = operation.writes;
      // Plugin tokens may only ever call `plugins.status` and `plugins.push` — reject every other
      // operation as permission_denied before read-only checks so no other route leaks workspace state.
      if (
        access.principal?.kind === "plugin" &&
        name !== "plugins.status" &&
        name !== "plugins.push"
      )
        throw new ApplicationError(
          "permission_denied",
          "Plugin tokens may only call plugins.status and plugins.push",
          403,
        );
      if (name !== "operations.commit") this.requirePermission(access, operation.permission);
      if (access.operations && !access.operations.includes(name)) {
        if (access.readOnly?.held.includes(operation.permission)) throw readOnlyRefusal();
        throw new ApplicationError(
          "permission_denied",
          "This credential may not call this operation",
          403,
        );
      }
      if (
        !/^application\/json(?:;\s*charset=utf-8)?$/i.test(
          request.headers.get("content-type") ?? "",
        ) ||
        request.headers.has("content-encoding")
      )
        throw new ApplicationError("media_type_unsupported", "Use application/json", 415);
      let raw: unknown;
      try {
        raw = JSON.parse(await bodyText(request));
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw new ApplicationError("invalid_json", "Expected valid UTF-8 JSON");
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new ApplicationError("invalid_input", "Expected a request object");
      const body = raw as Record<string, unknown>;
      if (
        Object.keys(body).some(
          (key) => !["version", "bookId", "operationId", "input"].includes(key),
        )
      )
        throw new ApplicationError("invalid_input", "Unknown request field");
      if (body.version !== APPLICATION_API_VERSION)
        throw new ApplicationError(
          "version_unsupported",
          "Unsupported application API version",
          409,
        );
      if (body.bookId !== this.access.bookId)
        throw new ApplicationError(
          "book_scope_mismatch",
          "Request book does not match this service",
          403,
        );
      if (body.operationId !== undefined) {
        if (typeof body.operationId !== "string" || !uuid.test(body.operationId))
          throw new ApplicationError("invalid_operation_id", "Use a UUID operation identity");
        operationId = body.operationId;
      }
      if (writes && name !== "operations.commit" && !operationId)
        throw new ApplicationError(
          "operation_id_required",
          "A durable operation identity is required",
        );
      if (operationId) trace.operationId = operationId;
      validateSchema(body.input, operation.input);
      const input = body.input as Record<string, unknown>;
      // So that a command committed deep in the service is kept under the name of whoever asked for it
      // (the owner needs no name, and a read commits nothing).
      if (writes && access.principal !== undefined && access.principal.kind !== "owner")
        changesState(this.service).rememberCaller(access.principal);
      if (name === "operations.commit") {
        operationId = string(input, "planId");
        trace.operationId = operationId;
        const permission = PREPARED_OPERATION_PERMISSIONS[this.service.actionKind(operationId)];
        if (!permission) throw new Error("Unknown prepared operation kind");
        this.requirePermission(access, permission);
      }
      const data = await this.dispatch(access, name, input, operationId ?? "");
      // Output validation protects all clients from a silently changed contract.
      try {
        validateSchema(data, operation.output, "output");
      } catch {
        throw new Error("Application output contract failed");
      }
      return this.response({ ok: true, ...(operationId ? { operationId } : {}), data });
    } catch (error) {
      let failure: ApplicationError;
      if (error instanceof ApplicationError) failure = error;
      else if (error instanceof Error && /^Draft changed/.test(error.message))
        failure = new ApplicationError("draft_version_conflict", error.message, 409);
      else if (error instanceof Error && /^Book already configured/.test(error.message))
        failure = new ApplicationError("book_configuration_conflict", error.message, 409);
      else if (error instanceof Error && /^Book is not configured/.test(error.message))
        failure = new ApplicationError("book_not_configured", error.message, 409);
      else if (error instanceof TypeError)
        failure = new ApplicationError("invalid_input", error.message);
      else
        failure = new ApplicationError(
          writes && operationId ? "operation_unresolved" : "service_unavailable",
          writes && operationId
            ? "Inspect or resume this operation using its original identity"
            : "Application service is unavailable",
          503,
          [],
          true,
        );
      trace.code = failure.code;
      // A read-only book refuses before it has read the request, and a client that keeps its writes by identity (the web application) takes an answer that does not name the one it sent for no
      // answer to it: so the identity is read from the request now, for this answer alone.
      if (failure.code === "workspace_read_only" && !operationId)
        operationId = await this.identityOf(request);
      return this.response(
        {
          ok: false,
          ...(operationId ? { operationId } : {}),
          error: {
            code: failure.code,
            message: failure.message,
            details: failure.details,
            retryable: failure.retryable,
          },
        },
        failure.status,
        failure.status === 401 ? { "www-authenticate": 'Bearer realm="rastrata"' } : {},
      );
    }
  }

  /** Reads carried together. `POST /v1/batch {version, requests: [{name, body}]}` answers `{responses: [{status, body}]}`: for each request, in the order asked, the status and the body that the operation's own
   * route (`POST /v1/<name>`) gives the same `body`. It exists for what a page shows: a screen asks for ten or twenty reads at once, and as that many requests each paid for the credential, a place in the
   * queue of the book's reads and a round trip of its own (the page waited for the slowest of them behind all the others), where one request pays once and the reads run one after the other in the book's
   * memory, in the same moment. **Only reads are carried**: a write named here is refused without being run, so that a batch is safe to send again and needs no operation identity. The credential is
   * checked once, and each read is checked for its permission as it would be alone (a credential that may not call one of them is refused that one and answered for the others). */
  private async batch(request: Request, access: ApplicationAccess): Promise<Response> {
    if (request.method !== "POST")
      throw new ApplicationError("method_not_allowed", "Use POST with a versioned request", 405);
    if (
      !/^application\/json(?:;\s*charset=utf-8)?$/i.test(
        request.headers.get("content-type") ?? "",
      ) ||
      request.headers.has("content-encoding")
    )
      throw new ApplicationError("media_type_unsupported", "Use application/json", 415);
    let raw: unknown;
    try {
      raw = JSON.parse(await bodyText(request));
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError("invalid_json", "Expected valid UTF-8 JSON");
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new ApplicationError("invalid_input", "Expected a request object");
    const body = raw as Record<string, unknown>;
    if (Object.keys(body).some((key) => !["version", "requests"].includes(key)))
      throw new ApplicationError("invalid_input", "Unknown request field");
    if (body.version !== APPLICATION_API_VERSION)
      throw new ApplicationError("version_unsupported", "Unsupported application API version", 409);
    const requests = body.requests;
    if (!Array.isArray(requests) || requests.length === 0 || requests.length > MAX_BATCHED_READS)
      throw new ApplicationError(
        "invalid_input",
        `Send between 1 and ${MAX_BATCHED_READS} requests`,
      );
    const refusal = (status: number, code: string, message: string) => ({
      status,
      body: {
        version: APPLICATION_API_VERSION,
        bookId: this.access.bookId,
        ok: false,
        error: { code, message, details: [], retryable: false },
      },
    });
    const responses: { status: number; body: unknown }[] = [];
    for (const item of requests) {
      const asked = item as { name?: unknown; body?: unknown } | null;
      const name = typeof asked?.name === "string" ? asked.name : "";
      const operation = operationCatalog.find((candidate) => candidate.name === name);
      if (!operation || !asked || typeof asked.body !== "object" || asked.body === null) {
        responses.push(refusal(404, "route_not_found", "Application operation not found"));
        continue;
      }
      if (operation.writes) {
        responses.push(refusal(400, "batch_reads_only", "A batch carries reads only"));
        continue;
      }
      const sub = new Request(new URL(`/v1/${name}`, request.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(asked.body),
      });
      const answer = await this.fetch(sub, access);
      let parsed: unknown = null;
      try {
        parsed = await answer.json();
      } catch {
        responses.push(refusal(502, "service_unavailable", "Application service is unavailable"));
        continue;
      }
      responses.push({ status: answer.status, body: parsed });
    }
    return this.response({ ok: true, data: { responses } });
  }

  /** The operation identity a request names, when its body has not been read (it was refused first) and names one: for the answer to the refusal. Nothing else of the body is used, and one that cannot be
   * read within the usual bounds names nothing. */
  private async identityOf(request: Request): Promise<string | undefined> {
    if (request.bodyUsed) return undefined;
    try {
      const body = JSON.parse(await bodyText(request)) as { operationId?: unknown };
      return typeof body.operationId === "string" && uuid.test(body.operationId)
        ? body.operationId
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** `GET /v1/exports/<id>`: an export that `export.create` made, as one zip, streamed. It needs what making one needs (`configure`: owners and administrators), and a credential that
   * may call `export.create`. An export is kept for a little while where the runtime keeps them (an hour on a hosted pod), and an unknown one is `404`. */
  private async exportDownload(
    request: Request,
    access: ApplicationAccess,
    id: string,
  ): Promise<Response> {
    if (new URL(request.url).search)
      throw new ApplicationError("route_not_found", "Application operation not found", 404);
    if (request.method !== "GET")
      throw new ApplicationError("method_not_allowed", "Use GET to download an export", 405);
    this.requirePermission(access, "configure");
    if (access.operations && !access.operations.includes("export.create"))
      throw new ApplicationError(
        "permission_denied",
        "This credential may not call this operation",
        403,
      );
    const archive = (await exportHost(this.service).archive?.(id)) ?? null;
    if (!archive)
      throw new ApplicationError(
        "export_not_found",
        "There is no such export. Make one first; an export is kept for an hour.",
        404,
      );
    return new Response(archive.body, {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${archive.name}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }

  /** The one route that takes a raw body (a statement file, up to 16 MiB) instead of a JSON
   * request. Content-addressed, so it needs no operation identity: sending the same bytes again
   * returns the same reference. */
  private async upload(request: Request, access: ApplicationAccess): Promise<Response> {
    if (new URL(request.url).search)
      throw new ApplicationError("route_not_found", "Application operation not found", 404);
    if (request.method !== "POST")
      throw new ApplicationError("method_not_allowed", "Use POST with the file as the body", 405);
    // Plugin tokens upload only raw plugin payloads (`X-Upload-For: plugin`).
    if (
      access.principal?.kind === "plugin" &&
      request.headers.get("x-upload-for")?.trim().toLowerCase() !== "plugin"
    )
      throw new ApplicationError(
        "permission_denied",
        "Plugin tokens may upload raw plugin payloads only (send X-Upload-For: plugin)",
        403,
      );
    this.requirePermission(access, "draft");
    // The control plane's key drafts for one thing: the answers it read from the owner's Stripe account, delivered as a bundle. It uploads no statement.
    if (
      access.principal?.kind === "service" &&
      request.headers.get("x-upload-for")?.trim().toLowerCase() !== "stripe"
    )
      throw new ApplicationError(
        "permission_denied",
        "This credential may not call this operation",
        403,
      );
    const data = await receiveUpload(this.service, request);
    try {
      validateSchema(data, ref("UploadReceipt"), "output");
    } catch {
      throw new Error("Application output contract failed");
    }
    return this.response({ ok: true, data });
  }

  private async dispatch(
    access: ApplicationAccess,
    name: string,
    input: Record<string, unknown>,
    operationId: string,
  ): Promise<unknown> {
    const service = this.service;
    switch (name) {
      case "book.get": {
        const setup = service.setupState();
        return {
          enabled: true,
          bookId: service.bookId,
          setup,
          mode: "local-development",
          permissions: access.permissions,
          head: setup ? await service.ledgerHead() : null,
          // A member, the control plane, and a plugin token are not what `principal` names (a frozen choice of two): a member is told by `member`.
          ...(access.principal?.kind === "member"
            ? { member: { userId: access.principal.userId, role: access.principal.role } }
            : access.principal?.kind === "service" || access.principal?.kind === "plugin"
              ? {}
              : { principal: access.principal ?? { kind: "owner" as const } }),
          ownerAccess: access.ownerAccess ?? "open",
          ...(setup ? { settings: readBookSettings(service) } : {}),
        };
      }
      case "book.setup":
        return service.retainAsyncRequest(operationId, name, input, () =>
          service.setup(input as unknown as BookSetup, {
            by: describePrincipal(access.principal),
            operation: "book.setup",
          }),
        );
      case "capabilities.get": {
        const setup = service.setupState();
        return {
          version: APPLICATION_API_VERSION,
          bookId: service.bookId,
          currencies: ["USD", "EUR", "GBP"],
          bases: ["accrual", "cash"],
          periodModels: ["monthly", "quarterly"],
          pageSize: 25,
          permissions: access.permissions,
          // Only what this caller may call, so an agent is never offered what it cannot do.
          operations: operationCatalog.filter((item) => permitsOperation(access.permissions, item)),
          ...(setup
            ? { basis: setup.basis, fiscalYearStartMonth: setup.fiscalYearStartMonth }
            : {}),
        };
      }
      case "operations.get":
        return service.operation(string(input, "operationId"));
    }
    if (!service.setupState() && !READS_BEFORE_SETUP.has(name) && !WRITES_BEFORE_SETUP.has(name))
      throw new ApplicationError("book_not_configured", "Book is not configured", 409);
    switch (name) {
      case "accounts.list":
        return service.accounts();
      case "accounts.prepareCreate":
        return service.createAccount(
          {
            actionId: operationId,
            code: string(input, "code"),
            name: string(input, "name"),
            role: string(input, "role") as AccountRole,
            effectiveOn: string(input, "effectiveOn"),
            ...(input.parentId ? { parentId: string(input, "parentId") } : {}),
          },
          true,
        );
      case "accounts.prepareChange":
        return service.changeAccount(
          {
            actionId: operationId,
            accountId: string(input, "accountId"),
            name: string(input, "name"),
            close: input.close as boolean,
            effectiveOn: string(input, "effectiveOn"),
          },
          true,
        );
      case "sources.get":
        return service.source(string(input, "sourceId"), integer(input, "page"));
      case "sources.list":
        return service.sources(
          integer(input, "page"),
          typeof input.text === "string" ? input.text : "",
        );
      case "drafts.list":
        return service.draftPage(integer(input, "page"));
      case "drafts.get": {
        const draft = service.draft(string(input, "draftId"));
        if (!draft) throw new ApplicationError("draft_not_found", "Draft not found", 404);
        return draft;
      }
      case "drafts.create":
        return service.retainRequest(operationId, name, input, () =>
          service.createDraft(input.data as JournalDraftData),
        );
      case "drafts.save":
        return service.retainRequest(operationId, name, input, () =>
          service.saveDraft(
            string(input, "draftId"),
            integer(input, "expectedVersion"),
            input.data as JournalDraftData,
          ),
        );
      case "drafts.discard":
        return service.retainRequest(operationId, name, input, () => {
          service.discardDraft(string(input, "draftId"), integer(input, "expectedVersion"));
          return { disposition: "discarded", draftId: string(input, "draftId") };
        });
      case "drafts.recover":
        return service.recoverDraft(
          string(input, "draftId"),
          integer(input, "expectedVersion"),
          string(input, "postingOperationId"),
          operationId,
        );
      case "journal.prepare":
        return service.prepareDraft(
          string(input, "draftId"),
          integer(input, "expectedVersion"),
          operationId,
          { by: describePrincipal(access.principal), operation: name },
        );
      case "journal.list":
        return service.journalBook({
          page: integer(input, "page"),
          text: string(input, "text"),
          from: string(input, "from"),
          to: string(input, "to"),
          accountId: string(input, "accountId"),
          status: string(input, "status"),
          type: string(input, "type"),
          ...(input.revision !== undefined ? { revision: BigInt(string(input, "revision")) } : {}),
        });
      case "journal.get": {
        if ((input.asOf !== undefined) !== (input.populationHash !== undefined))
          throw new ApplicationError(
            "invalid_input",
            "Supply both asOf and populationHash for report drill-through",
          );
        const revision =
          input.revision !== undefined
            ? BigInt(string(input, "revision"))
            : (await service.readAggregate()).aggregate.state.bookRevision;
        return service.journalEntry(
          string(input, "journalId"),
          revision,
          input.asOf
            ? {
                asOf: string(input, "asOf"),
                populationHash: string(input, "populationHash"),
                ...(input.reportFrom !== undefined
                  ? { reportFrom: string(input, "reportFrom") }
                  : {}),
              }
            : undefined,
        );
      }
      case "journal.prepareReverse":
        return service.reverseJournal(
          {
            actionId: operationId,
            journalId: string(input, "journalId"),
            accountingDate: string(input, "accountingDate"),
            reason: string(input, "reason"),
          },
          true,
        );
      case "operations.commit":
        return service.commitAction(string(input, "planId"), string(input, "planHash"), {
          by: describePrincipal(access.principal),
          operation: "operations.commit",
        });
      default: {
        // Operations added by a slice (see slices/): validated, permission-checked and
        // book-configured by the time they get here.
        const handler = Object.hasOwn(sliceHandlers, name) ? sliceHandlers[name] : undefined;
        if (!handler)
          throw new ApplicationError("route_not_found", "Application operation not found", 404);
        return handler(input, { service, access, operationId });
      }
    }
  }
}
