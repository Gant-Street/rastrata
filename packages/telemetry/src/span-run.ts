/** What `span(name, attrs, fn)` means, written once for every backend: run `fn` in the span's
 * context, end the span when `fn` returns or its promise settles, record a throw or a rejection and
 * rethrow it, and hand back the value unchanged. */
import type { SpanHandle } from "./api.ts";

/** One started span, as a backend sees it. */
export interface StartedSpan {
  readonly handle: SpanHandle;
  /** Run `fn` with this span as the current one. */
  run<T>(fn: () => T): T;
  /** End the span. Called exactly once. */
  end(): void;
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { then?: unknown }).then === "function";

export function runInSpan<T>(started: StartedSpan, fn: (span: SpanHandle) => T): T {
  let result: T;
  try {
    result = started.run(() => fn(started.handle));
  } catch (error) {
    started.handle.fail(error);
    started.end();
    throw error;
  }
  if (isThenable(result)) {
    return result.then(
      (value) => {
        started.end();
        return value;
      },
      (error: unknown) => {
        started.handle.fail(error);
        started.end();
        throw error;
      },
    ) as T;
  }
  started.end();
  return result;
}
