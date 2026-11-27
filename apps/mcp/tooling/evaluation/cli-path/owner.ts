import { WRITE_OPERATIONS } from "@rastrata/application/client-contracts";
import { APPLICATION_API_VERSION } from "@rastrata/application/schema";
import { isRecord } from "./util.ts";

/** Parsed JSON, loosely typed the way the harness reads an answer. The grader validates the few
 * fields it relies on and says so when one is missing. */
// biome-ignore lint/suspicious/noExplicitAny: the harness reads untyped answers from the service.
export type Json = any;

const WRITES: ReadonlySet<string> = new Set(WRITE_OPERATIONS);
export const isWriteOperation = (operation: string): boolean => WRITES.has(operation);

export class OwnerCallError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`${operation} answered ${status} ${code}: ${message}`.slice(0, 900));
  }
}

/** The owner's own access to the evaluation service, held by the harness: it seeds the book, makes
 * the agent's token, reads the book to grade it, and revokes the token afterwards. It is never
 * handed to an agent, a driver or a scenario prompt. */
export class OwnerClient {
  constructor(
    private readonly url: string,
    private readonly key: () => string,
  ) {}

  async call(
    operation: string,
    input: unknown = {},
    options: { operationId?: string } = {},
  ): Promise<Json> {
    const reply = await this.raw(operation, input, options);
    if (reply.status !== 200 || reply.body?.ok !== true) {
      const error = isRecord(reply.body?.error) ? reply.body.error : {};
      throw new OwnerCallError(
        operation,
        reply.status,
        String(error.code ?? "unknown"),
        String(error.message ?? JSON.stringify(reply.body).slice(0, 300)),
      );
    }
    return reply.body.data;
  }

  /** Like `call`, for an answer that may be a refusal the caller wants to read. */
  async raw(
    operation: string,
    input: unknown = {},
    options: { operationId?: string } = {},
  ): Promise<{ status: number; body: Json }> {
    const operationId =
      options.operationId ?? (WRITES.has(operation) ? crypto.randomUUID() : undefined);
    const response = await fetch(`${this.url}/v1/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.key()}` },
      body: JSON.stringify({
        version: APPLICATION_API_VERSION,
        bookId: "local-book",
        input,
        ...(operationId ? { operationId } : {}),
      }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  /** `POST /v1/uploads`: the raw bytes of a statement file, addressed by SHA-256. */
  async upload(bytes: string | Uint8Array, name: string, mediaType = "text/csv"): Promise<Json> {
    const response = await fetch(`${this.url}/v1/uploads`, {
      method: "POST",
      headers: {
        "content-type": mediaType,
        "x-upload-name": encodeURIComponent(name),
        authorization: `Bearer ${this.key()}`,
      },
      body: (typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes) as BodyInit,
    });
    const body = (await response.json().catch(() => null)) as Json;
    if (response.status !== 200 || body?.ok !== true)
      throw new OwnerCallError(
        "uploads",
        response.status,
        String(body?.error?.code ?? "unknown"),
        String(body?.error?.message ?? ""),
      );
    return body.data;
  }

  /** A long operation (backup, verify) asked again under one identity until it is done. */
  async job(operation: string, input: unknown = {}): Promise<Json> {
    const operationId = crypto.randomUUID();
    for (let attempt = 0; attempt < 2400; attempt++) {
      const data = await this.call(operation, input, { operationId });
      if (data.state !== "running") return data;
      await new Promise((done) => setTimeout(done, 50));
    }
    throw new Error(`${operation} did not finish`);
  }
}
