/** Exact-byte, single-entry decoder slots sharing one per-owner budget. This
 * bounds retained UTF-8 input, not expanded JS heap; population profiling must
 * measure that separately. Stored bytes must still be authenticated on every read. */
export function currentStateCache(maximumBytes: number) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
    throw new RangeError("Invalid current-state cache budget");
  let retainedBytes = 0;
  const frozen = (value: unknown): boolean =>
    value === null ||
    typeof value !== "object" ||
    (Object.isFrozen(value) && Object.values(value).every(frozen));
  return {
    retainedBytes: () => retainedBytes,
    memoize<T>(decode: (encoded: string) => T) {
      let previous: { encoded: string; result: T; bytes: number } | undefined;
      return (encoded: string): T => {
        if (previous?.encoded === encoded) return previous.result;
        if (previous !== undefined) retainedBytes -= previous.bytes;
        previous = undefined;
        const result = decode(encoded);
        if (encoded.length <= maximumBytes - retainedBytes) {
          const bytes = new TextEncoder().encode(encoded).length;
          if (bytes <= maximumBytes - retainedBytes && frozen(result)) {
            previous = { encoded, result, bytes };
            retainedBytes += bytes;
          }
        }
        return result;
      };
    },
  };
}
