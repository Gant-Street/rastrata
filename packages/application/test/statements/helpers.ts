import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "bun:test";
import { isRealDate } from "../../src/statements/dates.ts";
import {
  parseStatement,
  type ParseRequest,
  type StatementParse,
} from "../../src/statements/parse.ts";

const FIXTURES = join(import.meta.dir, "fixtures");

export const bytesOf = (text: string) => new TextEncoder().encode(text);
export const fixtureBytes = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(FIXTURES, name)));
export const fixtureText = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

export interface Manifest {
  readonly stories: Record<
    "checking" | "card",
    {
      readonly opening: string;
      readonly count: number;
      readonly moneyIn: string;
      readonly moneyOut: string;
      readonly net: string;
      readonly from: string;
      readonly to: string;
      readonly transactions: readonly {
        date: string;
        amount: string;
        memo: string;
        kind: string;
        check?: string;
      }[];
    }
  >;
  readonly files: readonly {
    readonly file: string;
    readonly format: "csv" | "ofx";
    readonly detect?: string;
    readonly use?: string;
    readonly story: "checking" | "card";
    readonly order: "newest-first" | "oldest-first" | "none";
    readonly opening?: string;
    readonly closing?: string;
    readonly skipped?: Record<string, number>;
    readonly warns?: string[];
    readonly note?: string;
  }[];
}
export const manifest: Manifest = JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf8"));

export function parse(
  input: Uint8Array | string,
  extra: Partial<Omit<ParseRequest, "bytes">> = {},
): StatementParse {
  return parseStatement({
    bytes: typeof input === "string" ? bytesOf(input) : input,
    defaultCurrency: "USD",
    accountKey: "csv:1010",
    ...extra,
  });
}

const MONEY = /^-?(0|[1-9][0-9]*)\.[0-9]{2}$/;

/** What every parse result must satisfy, whatever the input was. The ingest pipeline refuses a
 * batch with a structurally invalid line, so the parser must never produce one. */
export function assertWellFormed(result: StatementParse): void {
  const seen = new Set<number>();
  for (const { line, row } of result.lines) {
    expect(line.kind).toBe("bankLine");
    expect(["csv", "ofx"]).toContain(line.provider);
    expect(line.provider).toBe(result.provider as string);
    expect(line.accountKey).toBe(result.accountKey as string);
    expect(Number.isInteger(line.rawIndex) && line.rawIndex >= 0).toBe(true);
    expect(seen.has(line.rawIndex)).toBe(false);
    seen.add(line.rawIndex);
    expect(Number.isInteger(row) && row >= 1).toBe(true);
    expect(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(line.postedOn)).toBe(true);
    expect(
      isRealDate(
        Number(line.postedOn.slice(0, 4)),
        Number(line.postedOn.slice(5, 7)),
        Number(line.postedOn.slice(8, 10)),
      ),
    ).toBe(true);
    expect(MONEY.test(line.amount)).toBe(true);
    expect(line.amount).not.toBe("0.00");
    expect(line.amount).not.toBe("-0.00");
    expect(/^[A-Z]{3}$/.test(line.currency)).toBe(true);
    expect(line.description.length).toBeLessThanOrEqual(1000);
    expect(line.description.includes("\u0000")).toBe(false);
    if (line.counterparty !== undefined) expect(line.counterparty.length).toBeLessThanOrEqual(200);
    if (line.reference !== undefined) expect(line.reference.length).toBeLessThanOrEqual(100);
    if (line.providerId !== undefined) {
      expect(line.providerId.length).toBeGreaterThan(0);
      expect(line.providerId.length).toBeLessThanOrEqual(255);
    }
    if (line.runningBalance !== undefined) expect(MONEY.test(line.runningBalance)).toBe(true);
    if (line.excerpt !== undefined) expect(line.excerpt.length).toBeLessThanOrEqual(4096);
  }
  for (const balance of result.balances) {
    expect(MONEY.test(balance.balance)).toBe(true);
    expect(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(balance.asOf)).toBe(true);
    expect(balance.accountKey).toBe(result.accountKey as string);
  }
  const counts = result.diagnostics.counts;
  const list = result.diagnostics.list();
  expect(list.length).toBeLessThanOrEqual(400 + 100);
  expect(list.filter((item) => item.severity === "error").length > 0).toBe(counts.errors > 0);
  for (const item of list) {
    expect(item.message.length).toBeGreaterThan(0);
    expect(item.message.length).toBeLessThan(1200);
    if (item.row !== undefined) expect(Number.isInteger(item.row) && item.row >= 1).toBe(true);
  }
  // Nothing in the result may need more than JSON to travel.
  expect(() =>
    JSON.stringify({ lines: result.lines, balances: result.balances, list }),
  ).not.toThrow();
}

/** A deterministic generator so property and fuzz tests are the same on every machine. */
export function random(seed: number) {
  let state = seed >>> 0 || 0x9e3779b9;
  const next = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
  return {
    next,
    int: (low: number, high: number) => low + Math.floor(next() * (high - low + 1)),
    pick: <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T,
    chance: (probability: number) => next() < probability,
  };
}
