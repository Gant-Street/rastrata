/** W3C Trace Context, the `traceparent` header (https://www.w3.org/TR/trace-context/). Pure string
 * handling, so it works with no backend. */

export interface TraceContext {
  /** 32 lowercase hex digits, not all zero. */
  readonly traceId: string;
  /** 16 lowercase hex digits, not all zero: the span that sent the header. */
  readonly spanId: string;
  /** The trace-flags byte; bit 0 means the sender sampled the trace. */
  readonly flags: number;
}

const HEADER = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:-.*)?$/;

/** Read a header value. Anything that is not valid, including the all-zero ids and the reserved
 * version ff, is undefined, and the caller starts a new trace. A version above 00 may carry more
 * fields after the flags; they are ignored, as the specification says. */
export function parseTraceparent(header: string | null | undefined): TraceContext | undefined {
  if (typeof header !== "string" || header.length < 55 || header.length > 512) return undefined;
  const text = header.trim();
  const match = HEADER.exec(text);
  if (!match) return undefined;
  const [, version, traceId, spanId, flags] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (version === "ff") return undefined;
  // Version 00 is exactly four fields; a longer 00 header is malformed.
  if (version === "00" && text.length !== 55) return undefined;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return undefined;
  return { traceId, spanId, flags: Number.parseInt(flags, 16) };
}

export function formatTraceparent(context: TraceContext): string {
  return `00-${context.traceId}-${context.spanId}-${(context.flags & 0xff).toString(16).padStart(2, "0")}`;
}

const HEX = Array.from({ length: 256 }, (_, index) => index.toString(16).padStart(2, "0"));

/** `bytes` random bytes as lowercase hex, never all zero. */
export function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  for (;;) {
    crypto.getRandomValues(buffer);
    let text = "";
    let nonzero = false;
    for (const byte of buffer) {
      text += HEX[byte];
      if (byte !== 0) nonzero = true;
    }
    if (nonzero) return text;
  }
}
