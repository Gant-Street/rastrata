import { describe, expect, test } from "bun:test";
import {
  LABEL_VALUES,
  outcomeOfStatus,
  r2ClassOf,
  sizeBucket,
  standIn,
  type LabelKey,
} from "../src/labels.ts";

describe("sizeBucket", () => {
  test("puts a book in the bucket of the sizes the programs measure at", () => {
    const cases: [number, string][] = [
      [0, "xs"],
      [499, "xs"],
      [500, "s"],
      [1_999, "s"],
      [2_000, "m"],
      [4_999, "m"],
      [5_000, "l"],
      [19_999, "l"],
      [20_000, "xl"],
      [1_000_000, "xl"],
    ];
    for (const [entries, bucket] of cases) expect(sizeBucket(entries)).toBe(bucket as never);
  });

  test("takes the sequence number as a bigint or as the decimal string a head carries", () => {
    expect(sizeBucket(4_999n)).toBe("m");
    expect(sizeBucket("5000")).toBe("l");
  });

  test("a size that is not known is unknown, never a guess", () => {
    for (const bad of [undefined, null, "", "abc", -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(sizeBucket(bad as never)).toBe("unknown");
  });
});

describe("r2ClassOf", () => {
  test("follows Cloudflare's list: put, list and copy are A, get and head are B, delete is free", () => {
    expect(r2ClassOf("put")).toBe("A");
    expect(r2ClassOf("list")).toBe("A");
    expect(r2ClassOf("copy")).toBe("A");
    expect(r2ClassOf("get")).toBe("B");
    expect(r2ClassOf("head")).toBe("B");
    expect(r2ClassOf("delete")).toBe("free");
  });

  test("prices a call it does not know as the dearer class", () => {
    expect(r2ClassOf("other")).toBe("A");
  });
});

describe("outcomeOfStatus", () => {
  test("names the answers the log protocol treats differently", () => {
    expect(outcomeOfStatus(200)).toBe("ok");
    expect(outcomeOfStatus(204)).toBe("ok");
    expect(outcomeOfStatus(304)).toBe("ok");
    expect(outcomeOfStatus(404)).toBe("not_found");
    expect(outcomeOfStatus(409)).toBe("conflict");
    expect(outcomeOfStatus(412)).toBe("conflict");
    expect(outcomeOfStatus(408)).toBe("timeout");
    expect(outcomeOfStatus(504)).toBe("timeout");
    expect(outcomeOfStatus(400)).toBe("client_error");
    expect(outcomeOfStatus(429)).toBe("client_error");
    expect(outcomeOfStatus(500)).toBe("server_error");
    expect(outcomeOfStatus(503)).toBe("server_error");
    expect(outcomeOfStatus(0)).toBe("other");
    expect(outcomeOfStatus(100)).toBe("other");
  });
});

describe("the closed sets", () => {
  test("have no duplicates and no empty member", () => {
    for (const [key, values] of Object.entries(LABEL_VALUES)) {
      expect(new Set(values).size, key).toBe(values.length);
      for (const value of values) expect(value.length, `${key}: ${value}`).toBeGreaterThan(0);
    }
  });

  test("hold no identifier: nothing that looks like a uuid, a digit string or a long word", () => {
    for (const [key, values] of Object.entries(LABEL_VALUES))
      for (const value of values) {
        expect(value, key).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,24}$/);
      }
  });

  test("give a value that stands in for an unlisted one wherever the set has an other or unknown", () => {
    expect(standIn(LABEL_VALUES.outcome)).toBe("other");
    expect(standIn(LABEL_VALUES.size_bucket)).toBe("unknown");
    expect(standIn(LABEL_VALUES.resolution)).toBe("unknown");
    for (const key of ["direction", "cpu_mode", "snapshot_op", "r2_class"] as LabelKey[])
      expect(standIn(LABEL_VALUES[key]), key).toBeUndefined();
    // A metric that lists only part of a set has no stand-in the set holds for it.
    expect(standIn(["xs", "s", "m", "l", "xl"])).toBeUndefined();
  });
});
