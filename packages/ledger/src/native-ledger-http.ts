import { decodeBookCommand, decodeDurableBook, type BookCommandResult } from "@rastrata/kernel";
import type { BookApplicationService } from "./book-application-service.ts";
import type { BookPermission, BookAuthorization } from "./book-authorization.ts";
import type { NativeLedgerHead } from "./native-ledger-repository.ts";
import { LedgerError, requireLedger } from "./records.ts";

export const NATIVE_LEDGER_HTTP_VERSION = "rastrata-native-http-v1";
const routes: Readonly<Record<string, { permission: BookPermission; maximumBytes: number }>> = {
  "/commands": { permission: "execute", maximumBytes: 1048576 },
  "/provision": { permission: "provision", maximumBytes: 4194304 },
  "/outcomes": { permission: "read", maximumBytes: 4096 },
  "/authorization": { permission: "maintain", maximumBytes: 4096 },
};
const errorStatuses: Readonly<Record<string, number>> = {
  ledger_unauthorized: 401,
  ledger_forbidden: 403,
  ledger_request_too_large: 413,
  ledger_media_type_unsupported: 415,
  ledger_request_timeout: 408,
  ledger_request_aborted: 408,
  native_ledger_overloaded: 429,
  native_ledger_queue_timeout: 429,
  ledger_request_invalid: 400,
  ledger_command_invalid: 400,
  native_ledger_invalid_input: 400,
  native_ledger_read_limit: 400,
  native_ledger_cursor_mismatch: 400,
  ledger_authorization_revision_invalid: 400,
  ledger_authorization_revision_conflict: 409,
  ledger_authorization_identity_conflict: 409,
  native_ledger_writer_retired: 409,
  native_ledger_writer_fenced: 409,
  native_ledger_restore_required: 409,
};

function response(body: unknown, status = 200): Response {
  return Response.json(
    { version: NATIVE_LEDGER_HTTP_VERSION, ...(body as Record<string, unknown>) },
    {
      status,
      headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
    },
  );
}

/** The receipt's only integer field is encoded explicitly as a decimal string.
 * No generic bigint/float replacer or lossy amount conversion is used. */
function receipt(result: BookCommandResult) {
  return { ...result, observedBookRevision: result.observedBookRevision.toString() };
}
function record(value: unknown, keys: string): Record<string, unknown> {
  requireLedger(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(",") === keys,
    "ledger_request_invalid",
  );
  return value as Record<string, unknown>;
}

function cursor(value: unknown): NativeLedgerHead | null {
  if (value === null) return null;
  const fields = record(value, "bookRevision,chainHash,sequence");
  requireLedger(
    typeof fields.sequence === "string" &&
      /^(0|[1-9][0-9]{0,18})$/.test(fields.sequence) &&
      typeof fields.bookRevision === "string" &&
      /^(0|[1-9][0-9]{0,18})$/.test(fields.bookRevision) &&
      BigInt(fields.sequence) <= (1n << 63n) - 1n &&
      BigInt(fields.bookRevision) <= BigInt(fields.sequence) &&
      typeof fields.chainHash === "string" &&
      /^[0-9a-f]{64}$/.test(fields.chainHash),
    "ledger_request_invalid",
  );
  return {
    sequence: fields.sequence,
    bookRevision: fields.bookRevision,
    chainHash: fields.chainHash,
  };
}

async function readBody(
  request: Request,
  maximumBytes: number,
  timeoutMs: number,
): Promise<string> {
  const declared = request.headers.get("content-length");
  requireLedger(
    declared === null || (/^(0|[1-9][0-9]*)$/.test(declared) && Number(declared) <= maximumBytes),
    "ledger_request_too_large",
  );
  requireLedger(request.body !== null, "ledger_request_invalid");
  const reader = request.body.getReader(),
    decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0,
    text = "";
  const stopped = Promise.withResolvers<never>();
  const abort = () => stopped.reject(new LedgerError("ledger_request_aborted"));
  request.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => stopped.reject(new LedgerError("ledger_request_timeout")),
    timeoutMs,
  );
  try {
    if (request.signal.aborted) abort();
    for (;;) {
      const chunk = await Promise.race([reader.read(), stopped.promise]);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      requireLedger(bytes <= maximumBytes, "ledger_request_too_large");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof TypeError) throw new LedgerError("ledger_request_invalid");
    throw error;
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    // A broken upload must not keep the response waiting for cancellation.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new LedgerError("ledger_request_invalid");
  }
}

/** Command HTTP boundary over an asynchronous application port. Routing, configured
 * issuer and writer-fence authority are supplied by the owning adapter. This has
 * no fixtures, shared development token, synthetic actor or default book identity. */
export class NativeLedgerHttp {
  private active = 0;
  constructor(
    private readonly ledger: BookApplicationService,
    private readonly bodyTimeoutMs = 10000,
  ) {
    requireLedger(
      Number.isSafeInteger(bodyTimeoutMs) && bodyTimeoutMs > 0 && bodyTimeoutMs <= 10000,
      "ledger_http_configuration_invalid",
    );
  }
  async fetch(request: Request, verified?: BookAuthorization): Promise<Response> {
    if (this.active >= 16) return response({ error: "ledger_service_overloaded" }, 429);
    this.active++;
    try {
      const url = new URL(request.url);
      const route = Object.hasOwn(routes, url.pathname) ? routes[url.pathname] : undefined;
      if (!route || url.search) return response({ error: "ledger_route_not_found" }, 404);
      if (request.method !== "POST") return response({ error: "ledger_method_not_allowed" }, 405);
      const token = request.headers.get("authorization");
      // Only this ledger's verifier can mint a reusable context. JSON clones,
      // foreign verifiers, expired capabilities and wrong scopes remain rejected.
      const context = await this.ledger.checkRequestAuthorization(
        verified ?? token,
        route.permission,
      );
      requireLedger(
        /^application\/json(?:;\s*charset=utf-8)?$/i.test(
          request.headers.get("content-type") ?? "",
        ) && !request.headers.has("content-encoding"),
        "ledger_media_type_unsupported",
      );
      const text = await readBody(request, route.maximumBytes, this.bodyTimeoutMs);
      if (url.pathname === "/commands") {
        const decoded = decodeBookCommand(text);
        requireLedger(decoded.disposition === "decoded", "ledger_request_invalid");
        const result = await this.ledger.execute(context, decoded.command);
        return response({
          result: receipt(result.value.result),
          originalResult:
            result.value.originalResult === null ? null : receipt(result.value.originalResult),
          outcomeSequence: result.value.outcomeSequence,
          head: result.head,
        });
      }
      const value = parseJson(text);
      if (url.pathname === "/provision") {
        const body = record(value, "command,genesis");
        requireLedger(
          typeof body.command === "string" &&
            typeof body.genesis === "string" &&
            body.genesis.length <= 1048576 &&
            new TextEncoder().encode(body.genesis).byteLength <= 1048576,
          "ledger_request_invalid",
        );
        const command = decodeBookCommand(body.command),
          genesis = decodeDurableBook(body.genesis);
        requireLedger(
          command.disposition === "decoded" && genesis.disposition === "decoded",
          "ledger_request_invalid",
        );
        const result = await this.ledger.provision(context, genesis.aggregate, command.command);
        return response({
          result: receipt(result.result),
          outcomeSequence: result.outcomeSequence,
        });
      }
      if (url.pathname === "/authorization") {
        const body = record(value, "expectedRevision,requestId");
        requireLedger(
          typeof body.expectedRevision === "string" && typeof body.requestId === "string",
          "ledger_request_invalid",
        );
        return response({
          authorization: await this.ledger.advanceAuthorization(
            context,
            body.requestId,
            body.expectedRevision,
          ),
        });
      }
      const body = record(value, "after,limit");
      requireLedger(typeof body.limit === "number", "ledger_request_invalid");
      const page = await this.ledger.outcomes(context, cursor(body.after), body.limit);
      // The stored outcome envelope already carries exact command/effect values.
      return response({
        genesis: page.genesis,
        from: page.from,
        through: page.through,
        observedTip: page.observedTip,
        outcomes: page.outcomes.map((outcome) => ({
          head: outcome.head,
          previousHash: outcome.previousHash,
          encoded: outcome.encoded,
        })),
      });
    } catch (error) {
      const code = error instanceof LedgerError ? error.code : "ledger_service_unavailable";
      const status = Object.hasOwn(errorStatuses, code) ? (errorStatuses[code] ?? 503) : 503;
      // No SQLite errors, credential details or supplied payloads escape here.
      return response({ error: status === 503 ? "ledger_service_unavailable" : code }, status);
    } finally {
      this.active--;
    }
  }
}
