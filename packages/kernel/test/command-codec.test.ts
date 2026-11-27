import { expect, test } from "bun:test";
import {
  BOOK_COMMAND_CODEC_VERSION, decodeBookCommand, encodeBookCommand,
  canonicalEncode, canonicalAccountingValue, hashCanonical, sealCommand,
  commandId, instant, semanticVersion, type BookCommand,
} from "../src/index.ts";
import { activationCommand } from "./protocol-fixtures.ts";
import { IDS, journal, resolved } from "./fixtures.ts";

test("command transport preserves exact values without accepting a supplied result or effect", () => {
  const command = sealCommand({
    id: commandId("wire-post"), type: "postJournal", protocolVersion: semanticVersion("1.0.0"),
    bookId: IDS.book, expectedBookRevision: 9007199254740993n,
    issuedAt: instant("2026-01-15T14:00:00Z"), completedAt: instant("2026-01-15T14:00:01Z"), committedAt: instant("2026-01-15T14:00:02Z"),
    actorId: IDS.actor, resolved: resolved(journal("wire-journal")),
  });
  for (const input of [activationCommand(), command]) {
    const encoded = encodeBookCommand(input);
    const result = decodeBookCommand(encoded);
    expect(result.disposition).toBe("decoded");
    if (result.disposition !== "decoded") throw new Error(result.message);
    expect(encodeBookCommand(result.command)).toBe(encoded);
    expect(canonicalEncode(canonicalAccountingValue(result.command))).toEqual(canonicalEncode(canonicalAccountingValue(input)));
    expect(Object.isFrozen(result.command)).toBe(true);
    expect(Object.isFrozen(result.command.inputHash)).toBe(true);
  }
  for (const extra of [{ result: {} }, { effects: [] }, { revision: {} }])
    expect(() => encodeBookCommand({ ...command, ...extra } as BookCommand)).toThrow();
});

test("command transport fails closed on corrupt, noncanonical, foreign and oversized envelopes", () => {
  const encoded = encodeBookCommand(activationCommand());
  const envelope = JSON.parse(encoded);
  for (const input of [
    "", "null", "{}", encoded + " ", " ".repeat(1048577), "é".repeat(524289),
    JSON.stringify({ ...envelope, version: "rastrata-book-outcome-v1" }),
    JSON.stringify({ ...envelope, result: {} }),
    JSON.stringify({ ...envelope, checksum: { ...envelope.checksum, digest: "0".repeat(64) } }),
    JSON.stringify({ ...envelope, checksum: { ...envelope.checksum, algorithm: "sha1" } }),
  ]) expect(decodeBookCommand(input).disposition).toBe("rejected");
  const body = ["o", [...envelope.body[1], ["effects", ["a", []]]]];
  const checksum = hashCanonical({ type: BOOK_COMMAND_CODEC_VERSION, payload: JSON.stringify(body) });
  expect(decodeBookCommand(JSON.stringify({ ...envelope, body, checksum })).disposition).toBe("rejected");
  const oversized = { ...activationCommand(), id: "x".repeat(1048577) } as BookCommand;
  expect(() => encodeBookCommand(oversized)).toThrow("Book command exceeds the byte limit");
  const base = (padding: string) => activationCommand(`x${padding}`);
  const overhead = new TextEncoder().encode(encodeBookCommand(base(""))).byteLength;
  const boundaryCmd = base("x".repeat(1_048_576 - overhead));
  const boundaryEncoded = encodeBookCommand(boundaryCmd);
  expect(new TextEncoder().encode(boundaryEncoded).byteLength).toBe(1_048_576);
  expect(decodeBookCommand(boundaryEncoded).disposition).toBe("decoded");
});
