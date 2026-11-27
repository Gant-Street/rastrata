import { describe, expect, test } from "bun:test";
import { formatTraceparent, parseTraceparent, randomHex } from "../src/traceparent.ts";

const TRACE = "0af7651916cd43dd8448eb211c80319c";
const SPAN = "b7ad6b7169203331";

describe("parseTraceparent", () => {
  test("reads the example from the specification", () => {
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-01`)).toEqual({
      traceId: TRACE,
      spanId: SPAN,
      flags: 1,
    });
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-00`)?.flags).toBe(0);
  });

  test("ignores the fields a later version adds, and refuses them on version 00", () => {
    expect(parseTraceparent(`01-${TRACE}-${SPAN}-01-extra-fields`)?.traceId).toBe(TRACE);
    expect(parseTraceparent(`00-${TRACE}-${SPAN}-01-extra`)).toBeUndefined();
  });

  test("refuses anything malformed, so a hostile header only starts a new trace", () => {
    const bad = [
      undefined,
      null,
      "",
      "garbage",
      `ff-${TRACE}-${SPAN}-01`,
      `00-${"0".repeat(32)}-${SPAN}-01`,
      `00-${TRACE}-${"0".repeat(16)}-01`,
      `00-${TRACE.toUpperCase()}-${SPAN}-01`,
      `00-${TRACE.slice(1)}-${SPAN}-01`,
      `00-${TRACE}-${SPAN}-1`,
      `00-${TRACE}-${SPAN}-zz`,
      `00-${TRACE}_${SPAN}-01`,
      `00-${TRACE}-${SPAN}-01\n`.padEnd(700, "x"),
    ];
    for (const header of bad)
      expect(parseTraceparent(header as never), String(header)).toBeUndefined();
  });

  test("trims surrounding whitespace", () => {
    expect(parseTraceparent(`  00-${TRACE}-${SPAN}-01 `)?.spanId).toBe(SPAN);
  });
});

describe("formatTraceparent", () => {
  test("round-trips", () => {
    const header = `00-${TRACE}-${SPAN}-01`;
    const context = parseTraceparent(header);
    expect(context && formatTraceparent(context)).toBe(header);
  });
});

describe("randomHex", () => {
  test("gives lowercase hex of the length asked, differently each time", () => {
    const a = randomHex(16);
    const b = randomHex(16);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(randomHex(8)).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });
});
