import { existsSync } from "node:fs";
import { resolve } from "node:path";

export type OracleWireResponse =
  | { readonly id: unknown; readonly ok: unknown }
  | { readonly id: unknown; readonly error: string };

export type OracleOutcome<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "error"; readonly code: string };

export type RationalWire = {
  readonly numerator: string;
  readonly denominator: string;
};

export type DecimalWire = {
  readonly coefficient: string;
  readonly scale: string;
};

export const DEFAULT_ORACLE_PATH = resolve(
  import.meta.dir,
  "../../../proofs/.lake/build/bin/oracle",
);

/**
 * Long-lived client for the compiled Lean `oracle` executable speaking
 * newline-delimited JSON (`{"id","fn","args"}` -> `{"id","ok"|"error"}`).
 */
export class OracleClient {
  private readonly proc: Bun.Subprocess<"pipe", "pipe", "inherit">;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private nextId = 1;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(proc: Bun.Subprocess<"pipe", "pipe", "inherit">) {
    this.proc = proc;
    this.reader = proc.stdout.getReader();
  }

  static start(binaryPath: string = DEFAULT_ORACLE_PATH): OracleClient {
    if (!existsSync(binaryPath)) {
      throw new Error(
        `Lean oracle binary not found at ${binaryPath}. Run "cd proofs && lake build oracle" first.`,
      );
    }
    const proc = Bun.spawn([binaryPath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });
    return new OracleClient(proc);
  }

  private async readLine(): Promise<string> {
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex !== -1) {
        const line = this.buffer.slice(0, newlineIndex);
        this.buffer = this.buffer.slice(newlineIndex + 1);
        return line;
      }
      const { value, done } = await this.reader.read();
      if (done) {
        const tail = this.buffer + this.decoder.decode();
        this.buffer = "";
        if (tail.length > 0) {
          return tail;
        }
        const exitCode = await this.proc.exited;
        throw new Error(`Lean oracle process exited unexpectedly with code ${exitCode}`);
      }
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }

  async call<T = unknown>(fn: string, args: readonly unknown[]): Promise<OracleOutcome<T>> {
    const run = async (): Promise<OracleOutcome<T>> => {
      if (this.closed) {
        throw new Error("OracleClient is already closed");
      }
      const id = this.nextId++;
      const payload = `${JSON.stringify({ id, fn, args })}\n`;
      this.proc.stdin.write(payload);
      await this.proc.stdin.flush();
      const rawLine = await this.readLine();
      const parsed = JSON.parse(rawLine) as Record<string, unknown>;
      if (parsed.id !== id) {
        throw new Error(
          `Oracle response id mismatch: expected ${id}, got ${JSON.stringify(parsed.id)}`,
        );
      }
      if ("error" in parsed) {
        const code = parsed.error;
        if (typeof code !== "string") {
          throw new Error(`Oracle returned non-string error: ${rawLine}`);
        }
        if (code.startsWith("protocol_error:")) {
          throw new Error(`Oracle protocol error calling ${fn}: ${code}`);
        }
        return { kind: "error", code };
      }
      if ("ok" in parsed) {
        return { kind: "ok", value: parsed.ok as T };
      }
      throw new Error(`Malformed oracle response: ${rawLine}`);
    };

    const resultPromise = this.queue.then(run, run);
    this.queue = resultPromise.then(
      () => undefined,
      () => undefined,
    );
    return resultPromise;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.proc.stdin.end();
    } catch {
      // Ignore if stdin was already closed.
    }
    try {
      await this.reader.cancel();
    } catch {
      // Ignore if stdout was already closed.
    }
    await this.proc.exited;
  }
}
