import { type Json, isWriteOperation } from "./owner.ts";
import { isRecord } from "./util.ts";

/** What the service saw of one request: independent of anything an agent says it did. The
 * credential is classified and never recorded. */
export interface WireRecord {
  readonly seq: number;
  readonly at: string;
  readonly method: string;
  readonly path: string;
  /** `inbox.list` for `/v1/inbox.list`, `uploads` for the upload route, otherwise the path. */
  readonly operation: string;
  readonly write: boolean;
  readonly credential: {
    readonly kind: "token" | "ownerKey" | "none" | "invalid";
    readonly tokenId?: string;
  };
  readonly userAgent: string;
  readonly operationId?: string;
  readonly requestBytes: number;
  /** The JSON input of an operation, when the body was JSON. Statement bytes are never kept. */
  readonly input?: Json;
  readonly status: number;
  readonly ok?: boolean;
  readonly errorCode?: string;
  readonly durationMs: number;
  /** The reply was dropped on purpose after the service had acted (a lost reply). */
  readonly replyLost?: boolean;
}

export type LossRule = {
  /** The operation whose reply to lose. */
  readonly operation: string;
  /** Lose the nth matching request (1 is the first). */
  readonly nth: number;
};

const tokenId = /^Bearer +rst_([0-9a-f]{16})_/i;

function classify(header: string | null): WireRecord["credential"] {
  if (header === null) return { kind: "none" };
  const token = tokenId.exec(header);
  if (token) return { kind: "token", tokenId: token[1] as string };
  if (/^Bearer +rso_/i.test(header)) return { kind: "ownerKey" };
  return { kind: "invalid" };
}

/** A transparent proxy between an agent's `rastrata` and the service. It forwards every request
 * unchanged (the Host header excepted), records what the service saw, and can lose the reply to one
 * request after the service has acted, which is how a real uncertain write looks to the client. */
export class TracingProxy {
  readonly records: WireRecord[] = [];
  private readonly listeners: ((record: WireRecord) => void)[] = [];
  private losses: (LossRule & { seen: number })[] = [];
  private server: ReturnType<typeof Bun.serve> | undefined;

  constructor(private readonly target: string) {}

  get url(): string {
    if (!this.server) throw new Error("The proxy is not started");
    return `http://127.0.0.1:${this.server.port}`;
  }

  start(): void {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      // An upload may be a whole statement file.
      maxRequestBodySize: 20 * 1024 * 1024,
      fetch: (request) => this.forward(request),
    });
  }

  onRecord(listener: (record: WireRecord) => void): void {
    this.listeners.push(listener);
  }

  loseReply(rule: LossRule): void {
    this.losses.push({ ...rule, seen: 0 });
  }

  async stop(): Promise<void> {
    await this.server?.stop(true);
  }

  private async forward(request: Request): Promise<Response> {
    const started = performance.now();
    const url = new URL(request.url);
    const operation = url.pathname.startsWith("/v1/") ? url.pathname.slice(4) : url.pathname;
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer();
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("content-length");
    let upstream: Response;
    try {
      upstream = await fetch(`${this.target}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        redirect: "manual",
      });
    } catch (error) {
      this.note(request, operation, body, 502, undefined, "unreachable", started);
      return new Response(String(error), { status: 502 });
    }
    const bytes = await upstream.arrayBuffer();
    let parsed: Json = null;
    const type = upstream.headers.get("content-type") ?? "";
    if (type.includes("json")) parsed = JSON.parse(new TextDecoder().decode(bytes) || "null");
    const lost = this.losses.find(
      (rule) => rule.operation === operation && ++rule.seen === rule.nth,
    );
    this.note(
      request,
      operation,
      body,
      upstream.status,
      isRecord(parsed) ? (parsed.ok as boolean | undefined) : undefined,
      isRecord(parsed) && isRecord(parsed.error) ? String(parsed.error.code ?? "") : undefined,
      started,
      lost !== undefined,
    );
    if (lost) return new Response("Simulated lost reply", { status: 503 });
    const out = new Headers();
    for (const name of ["content-type", "cache-control"]) {
      const value = upstream.headers.get(name);
      if (value) out.set(name, value);
    }
    return new Response(bytes, { status: upstream.status, headers: out });
  }

  private note(
    request: Request,
    operation: string,
    body: ArrayBuffer | undefined,
    status: number,
    ok: boolean | undefined,
    errorCode: string | undefined,
    started: number,
    replyLost = false,
  ): void {
    let input: Json;
    let operationId: string | undefined;
    const contentType = request.headers.get("content-type") ?? "";
    if (body && contentType.includes("json") && body.byteLength <= 131072) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(body)) as Json;
        if (isRecord(parsed)) {
          input = parsed.input;
          if (typeof parsed.operationId === "string") operationId = parsed.operationId;
        }
      } catch {
        // Not JSON the service will accept either.
      }
    }
    const record: WireRecord = {
      seq: this.records.length + 1,
      at: new Date().toISOString(),
      method: request.method,
      path: new URL(request.url).pathname,
      operation,
      write: operation === "uploads" ? true : isWriteOperation(operation),
      credential: classify(request.headers.get("authorization")),
      userAgent: request.headers.get("user-agent") ?? "",
      ...(operationId ? { operationId } : {}),
      requestBytes: body?.byteLength ?? 0,
      ...(input !== undefined ? { input } : {}),
      status,
      ...(ok !== undefined ? { ok } : {}),
      ...(errorCode ? { errorCode } : {}),
      durationMs: Math.round(performance.now() - started),
      ...(replyLost ? { replyLost } : {}),
    };
    this.records.push(record);
    for (const listener of this.listeners) listener(record);
  }
}
