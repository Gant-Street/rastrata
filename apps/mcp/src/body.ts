/** Bound both bytes and time, including responses without Content-Length. */
export async function readText(
  body: ReadableStream<Uint8Array> | null,
  maximum: number,
  signal: AbortSignal,
): Promise<string> {
  if (!body) throw new Error("A JSON body is required");
  const reader = body.getReader();
  const interrupted = Promise.withResolvers<never>();
  const abort = () => interrupted.reject(new Error("JSON transfer interrupted"));
  signal.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0,
    text = "";
  try {
    if (signal.aborted) abort();
    for (;;) {
      const chunk = await Promise.race([reader.read(), interrupted.promise]);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximum) throw new Error("JSON body exceeds its size limit");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
