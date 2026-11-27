import { expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import {
  decodeStoredNativeOutcome,
  encodeStoredNativeOutcome,
  MAX_NATIVE_OUTCOME_BYTES,
} from "../src/native-outcome-storage.ts";

test("physical outcome compression preserves exact UTF-8 and reads legacy JSON", () => {
  for (const body of ["{}", JSON.stringify({ text: "帳簿 € 🧾".repeat(1000) })]) {
    const stored = encodeStoredNativeOutcome(body);
    expect(decodeStoredNativeOutcome(stored)).toBe(body);
    expect(decodeStoredNativeOutcome(body)).toBe(body);
    if (body.length > 1024) expect(stored.length).toBeLessThan(body.length / 2);
    else expect(stored).toBe(body);
  }
  const poorCompression = "{" + randomBytes(2000).toString("latin1");
  expect(decodeStoredNativeOutcome(encodeStoredNativeOutcome(poorCompression))).toBe(
    poorCompression,
  );
});

test("stored outcomes reject unsupported encoding, invalid base64, truncated streams, invalid UTF-8 and expansion bombs", () => {
  const encoded = (bytes: Uint8Array) =>
    "rastrata-deflate-v1:" + deflateRawSync(bytes).toString("base64");
  const large = new Uint8Array(MAX_NATIVE_OUTCOME_BYTES + 1).fill(65);
  const valid = encodeStoredNativeOutcome(JSON.stringify({ text: "x".repeat(8000) }));
  for (const bad of [
    null,
    42,
    "",
    "rastrata-deflate-v2:eA==",
    valid + "!",
    valid.slice(0, -4),
    encoded(new Uint8Array([255, 254])),
    encoded(large),
    "{" + "x".repeat(MAX_NATIVE_OUTCOME_BYTES),
    "{" + "€".repeat(MAX_NATIVE_OUTCOME_BYTES / 2),
  ]) {
    expect(() => decodeStoredNativeOutcome(bad)).toThrow("native_ledger_outcome_corrupt");
  }
  expect(() => encodeStoredNativeOutcome("x".repeat(MAX_NATIVE_OUTCOME_BYTES + 1))).toThrow();
});

test("maximum-size canonical outcome expands to exactly the allowed byte boundary", () => {
  const body = '{"text":"' + "x".repeat(MAX_NATIVE_OUTCOME_BYTES - 11) + '"}';
  expect(new TextEncoder().encode(body).length).toBe(MAX_NATIVE_OUTCOME_BYTES);
  expect(decodeStoredNativeOutcome(encodeStoredNativeOutcome(body))).toBe(body);
});

test("existing level-1 and newer compressed receipts share the exact same read format", () => {
  const canonical = JSON.stringify({ text: "Prior and current receipts 帳簿 🧾".repeat(500) });
  for (const level of [1, 3, 6]) {
    const stored = `rastrata-deflate-v1:${deflateRawSync(new TextEncoder().encode(canonical), { level }).toString("base64")}`;
    expect(decodeStoredNativeOutcome(stored)).toBe(canonical);
  }
  expect(decodeStoredNativeOutcome(encodeStoredNativeOutcome(canonical))).toBe(canonical);
});
