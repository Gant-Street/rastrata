import type { ApplicationFailure } from "@rastrata/application/client-contracts";
import {
  APPLICATION_API_VERSION,
  BUSINESS_PERMISSIONS,
  ApplicationError,
  PREPARED_OPERATION_PERMISSIONS,
  operationCatalog,
  validateSchema,
  type BusinessPermission,
  type OperationDefinition,
  type Schema,
} from "@rastrata/application/schema";
import { readText } from "./body.ts";

export type Envelope = {
  readonly version: typeof APPLICATION_API_VERSION;
  readonly bookId: string;
  readonly operationId?: string;
} & (
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly error: ApplicationFailure }
);

const failureSchema: Schema = {
  type: "object",
  properties: {
    code: { type: "string", minLength: 1 },
    message: { type: "string" },
    retryable: { type: "boolean" },
    details: {
      type: "array",
      items: {
        type: "object",
        properties: { path: { type: "string" }, message: { type: "string" } },
        required: ["path", "message"],
        additionalProperties: false,
      },
    },
  },
  required: ["code", "message", "details", "retryable"],
  additionalProperties: false,
};

export function localApiUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("RASTRATA_API_URL must be an HTTP loopback origin without credentials");
  return url;
}

/** The MCP process is a client. It never opens the book or receives ledger keys. */
export class ApplicationClient {
  readonly url: URL;
  readonly permissions: readonly BusinessPermission[];

  /** `credential` is an Authorization header value ("Bearer ..."). It is sent only to the fixed
   * loopback API, never logged, and never included in a result. */
  constructor(
    url: string,
    readonly bookId: string,
    permissions: readonly BusinessPermission[],
    private readonly credential?: string,
  ) {
    this.url = localApiUrl(url);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(bookId)) throw new Error("Invalid book scope");
    this.permissions = [...new Set(permissions)];
    if (
      !this.permissions.includes("read") ||
      this.permissions.some((item) => !BUSINESS_PERMISSIONS.includes(item))
    )
      throw new Error(
        "MCP permissions must include read and contain only supported business permissions",
      );
  }

  allows(operation: OperationDefinition): boolean {
    return operation.name === "operations.commit"
      ? Object.values(PREPARED_OPERATION_PERMISSIONS).some((permission) =>
          this.permissions.includes(permission),
        )
      : this.permissions.includes(operation.permission);
  }

  failure(error: ApplicationError, operationId?: string): Envelope {
    return {
      version: APPLICATION_API_VERSION,
      bookId: this.bookId,
      ...(operationId ? { operationId } : {}),
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
        retryable: error.retryable,
      },
    };
  }

  /** Find out what the API grants a caller who presents `authorization`, and return a client that
   * acts as that caller. The MCP process holds no grant of its own for such a caller: the API
   * enforces the token on every call, and this only decides which tools to list. A refusal keeps
   * the API's own code (token_invalid, token_revoked, ...). */
  async asCaller(authorization: string): Promise<
    | { readonly ok: true; readonly client: ApplicationClient }
    | {
        readonly ok: false;
        readonly status: number;
        readonly code: string;
        readonly message: string;
      }
  > {
    const probe = new ApplicationClient(this.url.origin, this.bookId, ["read"], authorization);
    const capabilities = operationCatalog.find((item) => item.name === "capabilities.get");
    if (!capabilities) throw new Error("Missing capabilities contract");
    const result = await probe.call(capabilities, {}, undefined, true);
    if (!result.ok) {
      const unauthenticated = [
        "authentication_required",
        "token_invalid",
        "token_revoked",
        "token_expired",
      ].includes(result.error.code);
      return {
        ok: false,
        status: unauthenticated ? 401 : result.error.code === "permission_denied" ? 403 : 503,
        code: result.error.code,
        message: result.error.message,
      };
    }
    const granted = ((result.data as { permissions?: string[] }).permissions ?? []).filter(
      (item): item is BusinessPermission =>
        BUSINESS_PERMISSIONS.includes(item as BusinessPermission),
    );
    if (!granted.includes("read"))
      return {
        ok: false,
        status: 403,
        code: "permission_denied",
        message: "This credential does not grant read permission",
      };
    return {
      ok: true,
      client: new ApplicationClient(this.url.origin, this.bookId, granted, authorization),
    };
  }

  /** `raw` skips the local grant: the answer to book.get and capabilities.get is returned exactly
   * as the API gave it (used to learn what a caller's token grants). */
  async call(
    operation: OperationDefinition,
    input: unknown,
    operationId?: string,
    raw = false,
  ): Promise<Envelope> {
    try {
      validateSchema(input, operation.input);
      if (!this.allows(operation))
        throw new ApplicationError(
          "permission_denied",
          "The MCP operator has not granted this permission",
          403,
        );
      if (operation.name === "operations.commit") {
        const planId = (input as { planId: string }).planId;
        operationId = planId;
        const statusOperation = operationCatalog.find((item) => item.name === "operations.get");
        if (!statusOperation) throw new Error("Missing operation lookup contract");
        const status = await this.call(statusOperation, { operationId: planId });
        if (!status.ok) return { ...status, operationId };
        const kind = (status.data as { kind: string }).kind;
        const permission = PREPARED_OPERATION_PERMISSIONS[kind];
        if (!permission || !this.permissions.includes(permission))
          throw new ApplicationError(
            "permission_denied",
            "The retained plan requires a permission not granted to this MCP connection",
            403,
          );
      }
      if (operation.writes && !operationId)
        throw new ApplicationError(
          "operation_id_required",
          "Obtain and retain a UUID with rastrata_new_operation_id before writing",
        );
      if (
        operationId &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operationId)
      )
        throw new ApplicationError("invalid_operation_id", "Use a UUID operation identity");
      const body = JSON.stringify({
        version: APPLICATION_API_VERSION,
        bookId: this.bookId,
        input,
        ...(operationId ? { operationId } : {}),
      });
      if (new TextEncoder().encode(body).byteLength > 131072)
        throw new ApplicationError("request_too_large", "Application request exceeds 128 KiB", 413);
      const signal = AbortSignal.timeout(10000);
      const response = await fetch(new URL(`/v1/${operation.name}`, this.url), {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(this.credential ? { authorization: this.credential } : {}),
        },
        body,
        signal,
      });
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? ""))
        throw new Error("Invalid application response media type");
      const result: unknown = JSON.parse(await readText(response.body, 4 * 1024 * 1024, signal));
      if (!result || typeof result !== "object" || Array.isArray(result))
        throw new Error("Invalid application envelope");
      const envelope = result as Record<string, unknown>;
      if (
        envelope.version !== APPLICATION_API_VERSION ||
        envelope.bookId !== this.bookId ||
        typeof envelope.ok !== "boolean" ||
        envelope.ok !== response.ok ||
        envelope.operationId !== operationId ||
        Object.keys(envelope).some(
          (key) =>
            !["version", "bookId", "operationId", "ok", envelope.ok ? "data" : "error"].includes(
              key,
            ),
        )
      )
        throw new Error("Application response scope or identity mismatch");
      validateSchema(
        envelope.ok ? envelope.data : envelope.error,
        envelope.ok ? operation.output : failureSchema,
        "output",
      );
      if (
        envelope.ok &&
        operation.name === "operations.get" &&
        (envelope.data as { operationId: string }).operationId !==
          (input as { operationId: string }).operationId
      )
        throw new Error("Operation lookup identity mismatch");
      if (
        envelope.ok &&
        operation.writes &&
        typeof (envelope.data as Record<string, unknown>).operationId === "string" &&
        (envelope.data as Record<string, unknown>).operationId !== operationId
      )
        throw new Error("Operation receipt identity mismatch");
      if (
        envelope.ok &&
        !raw &&
        (operation.name === "book.get" || operation.name === "capabilities.get")
      ) {
        const data = envelope.data as Record<string, unknown>;
        envelope.data = {
          ...data,
          permissions: this.permissions,
          ...(operation.name === "capabilities.get"
            ? { operations: operationCatalog.filter((item) => this.allows(item)) }
            : {}),
        };
      }
      return envelope as Envelope;
    } catch (error) {
      if (
        error instanceof ApplicationError &&
        error.details.every((detail) => !detail.path.startsWith("output"))
      )
        return this.failure(error, operationId);
      return this.failure(
        new ApplicationError(
          operation.writes ? "operation_unresolved" : "service_unavailable",
          operation.writes
            ? "The result is uncertain. Inspect rastrata_get_operation or retry the exact input with the original identity; do not create a replacement operation."
            : "The local accounting API is unavailable or returned an invalid response",
          503,
          [],
          true,
        ),
        operationId,
      );
    }
  }
}
