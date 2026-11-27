import { expect, test } from "bun:test";
import { ExactDecimal, ExactRational, encodeBookCommand, type BookCommand } from "@rastrata/kernel";
import { snapshotCommand } from "../src/records.ts";
import { posting } from "./fixtures.ts";

test("snapshot copying preserves exact commands; caller freezing grants no trust", () => {
  const input = posting(),
    snapshot = snapshotCommand(input);
  expect(snapshot).not.toBe(input);
  expect(snapshotCommand(snapshot)).not.toBe(snapshot);
  expect(snapshotCommand({ ...snapshot })).not.toBe(snapshot);
  expect(encodeBookCommand(snapshot)).toBe(encodeBookCommand(input));
  if (snapshot.type !== "postJournal") throw new Error("Expected journal");
  expect(Object.isFrozen(snapshot.resolved.journal.postings[0]?.units.canonicalNumber)).toBe(true);
  expect(() =>
    Object.defineProperty(snapshot.resolved.journal, "narration", { value: "changed" }),
  ).toThrow();
  expect(() => snapshotCommand(Object.freeze({ ...input, extra: "bad" }) as BookCommand)).toThrow(
    "ledger_command_invalid",
  );
  let invoked = false;
  expect(() =>
    snapshotCommand(
      Object.freeze({
        ...input,
        get extra() {
          invoked = true;
          return "bad";
        },
      }) as BookCommand,
    ),
  ).toThrow("ledger_command_invalid");
  expect(invoked).toBe(false);
  expect(() =>
    snapshotCommand({ ...input, extra: new Uint8Array([1]) } as unknown as BookCommand),
  ).toThrow("ledger_command_invalid");
});

test("UTF-8 byte accounting keeps the exact boundary for ASCII, Unicode and lone surrogates", () => {
  const base = posting("utf8", 1n, true, "");
  if (base.type !== "postJournal") throw new Error("Expected journal");
  const bytes = (value: unknown): number => {
    if (typeof value === "string" || typeof value === "bigint")
      return new TextEncoder().encode(String(value)).length;
    if (value instanceof ExactDecimal) return bytes(value.coefficient) + bytes(value.scale);
    if (value instanceof ExactRational) return bytes(value.numerator) + bytes(value.denominator);
    if (value === null || typeof value !== "object") return 0;
    return Object.entries(value).reduce((sum, [key, child]) => sum + bytes(key) + bytes(child), 0);
  };
  const available = 262144 - bytes(base);
  const withText = (text: string) => ({
    ...base,
    resolved: { ...base.resolved, journal: { ...base.resolved.journal, narration: text } },
  });
  for (const suffix of ["A", "é", "😀", "\ud800", "\udc00"]) {
    const text = "x".repeat(available - bytes(suffix)) + suffix;
    expect(() => snapshotCommand(withText(text))).not.toThrow();
    expect(() => snapshotCommand(withText(text + "x"))).toThrow("ledger_capacity_exceeded");
  }
});

test("snapshot copying preserves isolation from later mutations of the original input", () => {
  const base = posting();
  if (base.type !== "postJournal") throw new Error("Expected journal");
  const input = { ...base, resolved: { ...base.resolved, journal: { ...base.resolved.journal } } };
  const first = snapshotCommand(input),
    originalBytes = encodeBookCommand(first);
  input.resolved.journal.narration = "later edit";
  expect(encodeBookCommand(snapshotCommand(first))).toBe(originalBytes);
  expect(encodeBookCommand(snapshotCommand(input))).not.toBe(originalBytes);
});
