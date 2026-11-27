import { expect, test } from "bun:test";
import { parseMoney } from "../../src/money.ts";
import { CSV_PRESETS } from "../../src/statements/presets.ts";
import { summarizeLines } from "../../src/statements/balance.ts";
import { assertWellFormed, fixtureBytes, manifest, parse } from "./helpers.ts";

/** Every bank preset is driven by a fixture and the generator's ground truth: the transactions the
 * file was cut from, with amounts and balances worked out by exact integer arithmetic that never
 * touched the parser. Adding a preset means adding an entry to presets.ts and a fixture to
 * fixtures/build.ts; these tests then check it without being edited. */

const byFile = (name: string) => {
  const entry = manifest.files.find((item) => item.file === name);
  if (!entry) throw new Error(`no manifest entry for ${name}`);
  return entry;
};

function sameTransactions(
  parsed: ReturnType<typeof parse>,
  story: "checking" | "card",
  options: { memos?: boolean } = {},
) {
  const truth = manifest.stories[story].transactions;
  const got = parsed.lines.map(({ line }) => ({ date: line.postedOn, amount: line.amount }));
  const want = truth.map((tx) => ({ date: tx.date, amount: tx.amount }));
  const key = (item: { date: string; amount: string }) => `${item.date} ${item.amount}`;
  expect(got.map(key).sort()).toEqual(want.map(key).sort());
  if (options.memos !== false) {
    // The description carries what the bank wrote. Fixtures that split it or cut it keep the memo
    // somewhere in the line, so compare on containment.
    const remaining = parsed.lines.map(
      ({ line }) => `${line.postedOn} ${line.amount} ${line.description}`,
    );
    for (const tx of truth) {
      const index = remaining.findIndex(
        (text) =>
          text.startsWith(`${tx.date} ${tx.amount} `) &&
          text.toUpperCase().includes(tx.memo.slice(0, 20).toUpperCase()),
      );
      expect(index, `${tx.date} ${tx.amount} ${tx.memo}`).toBeGreaterThanOrEqual(0);
      remaining.splice(index, 1);
    }
  }
}

for (const entry of manifest.files) {
  test(`${entry.file}: ${entry.note ?? "reads every transaction and agrees with the ground truth"}`, () => {
    const result = parse(fixtureBytes(entry.file), entry.use ? { preset: entry.use } : {});
    assertWellFormed(result);
    expect(result.format).toBe(entry.format);
    expect(
      result.diagnostics.counts.errors,
      JSON.stringify(result.diagnostics.list().slice(0, 3)),
    ).toBe(0);
    const story = manifest.stories[entry.story];

    if (entry.format === "csv") {
      expect(result.csv?.source).toBe(entry.use || entry.detect ? "preset" : "detected");
      expect(result.csv?.preset?.id).toBe(entry.use ?? entry.detect);
      expect(result.csv?.preset?.verified).toBe(false);
    } else {
      expect(result.ofx?.accounts.length).toBe(1);
    }

    sameTransactions(result, entry.story);
    const summary = summarizeLines(result.lines);
    expect(summary.count).toBe(story.count);
    expect(summary.moneyIn).toBe(story.moneyIn);
    expect(summary.moneyOut).toBe(story.moneyOut);
    expect(summary.net).toBe(story.net);
    expect(summary.from).toBe(story.from);
    expect(summary.to).toBe(story.to);

    // Identical same-day lines must both survive: overlap detection counts them, the parser keeps them.
    const fuel = result.lines.filter(({ line }) =>
      line.description.toUpperCase().includes("SHELL OIL"),
    );
    if (entry.story === "checking") expect(fuel.length).toBe(2);

    if (entry.closing !== undefined) {
      const balance = result.balances[0];
      expect(balance?.balance).toBe(entry.closing);
      // A running balance is as of the newest line; an OFX ledger balance is as of the statement.
      expect(balance?.asOf).toBe(entry.format === "csv" ? story.to : "2026-02-28");
    }
    if (entry.format === "csv" && entry.opening !== undefined && entry.order !== "none") {
      expect(result.csv?.chain?.opening).toBe(entry.opening);
      expect(result.csv?.chain?.order).toBe(entry.order);
      expect(result.csv?.chain?.breakCount).toBe(0);
    }
    for (const [reason, count] of Object.entries(entry.skipped ?? {})) {
      if (reason === "filtered")
        expect(Object.values(result.csv?.stats?.filtered ?? {}).reduce((a, b) => a + b, 0)).toBe(
          count,
        );
      if (reason === "noAmount") expect(result.csv?.stats?.noAmount).toBe(count);
    }
    for (const kind of entry.warns ?? [])
      expect(result.diagnostics.count(kind), `warning ${kind}`).toBeGreaterThan(0);
    // Without the expected warnings a clean fixture parses clean.
    if (!entry.warns)
      expect(
        result.diagnostics.counts.warnings,
        JSON.stringify(result.diagnostics.list().filter((item) => item.severity === "warning")),
      ).toBe(0);
  });
}

test("a card statement keeps the card's signs: purchases negative, payments positive, balance owed negative", () => {
  for (const name of ["chase-card.csv", "bofa-card.csv", "capital-one-card.csv", "citi-card.csv"]) {
    const result = parse(fixtureBytes(name));
    const payments = result.lines.filter(({ line }) => line.description.includes("PAYMENT"));
    expect(payments.length, name).toBe(2);
    for (const { line } of payments)
      expect(parseMoney(line.amount) > 0n, `${name} ${line.amount}`).toBe(true);
    const purchases = result.lines.filter(({ line }) => line.description.includes("ADOBE"));
    for (const { line } of purchases)
      expect(parseMoney(line.amount) < 0n, `${name} ${line.amount}`).toBe(true);
  }
  // American Express writes charges as positive numbers; the preset flips them.
  for (const name of ["amex-basic.csv", "amex-extended.csv"]) {
    const result = parse(
      fixtureBytes(name),
      name === "amex-basic.csv" ? { preset: "amex-card" } : {},
    );
    for (const { line } of result.lines.filter(({ line }) => line.description.includes("ADOBE")))
      expect(parseMoney(line.amount) < 0n, name).toBe(true);
  }
  const qfx = parse(fixtureBytes("chase-card.qfx"));
  expect(qfx.balances[0]?.balance).toBe(byFile("chase-card.qfx").closing as string);
  expect(parseMoney(qfx.balances[0]?.balance as string) < 0n).toBe(true);
});

test("the three-column American Express file is not mistaken for another bank, and is not claimed without being asked", () => {
  const result = parse(fixtureBytes("amex-basic.csv"));
  expect(result.csv?.preset).toBeNull();
  expect(result.csv?.source).toBe("detected");
  // Read as any bank's file it keeps the signs as written (charges positive): visibly, not silently.
  const adobe = result.lines.find(({ line }) => line.description.includes("ADOBE"));
  expect(parseMoney(adobe?.line.amount as string) > 0n).toBe(true);
});

test("an export that reorders or drops columns still maps by header name", () => {
  const text = [
    "Check or Slip #,Balance,Type,Amount,Description,Posting Date,Details",
    ",8456.00,DEBIT_CARD,-44.00,GITHUB INC,01/02/2026,DEBIT",
    ",8500.00,ACH_CREDIT,8500.00,OPENING,01/01/2026,CREDIT",
  ].join("\n");
  const result = parse(text);
  expect(result.csv?.preset?.id).toBe("chase-checking");
  expect(result.lines.map(({ line }) => line.amount)).toEqual(["-44.00", "8500.00"]);
});

test("every preset is unverified, has a basis, and its fixture exists or says why not", () => {
  for (const preset of CSV_PRESETS) {
    expect(preset.verified, preset.id).toBe(false);
    expect(preset.basis.length, preset.id).toBeGreaterThan(20);
    expect(preset.summary.length, preset.id).toBeGreaterThan(20);
    const fixtures = manifest.files.filter((entry) => (entry.use ?? entry.detect) === preset.id);
    expect(fixtures.length, `no fixture exercises the ${preset.id} preset`).toBeGreaterThan(0);
  }
  expect(new Set(CSV_PRESETS.map((preset) => preset.id)).size).toBe(CSV_PRESETS.length);
});

test("Chase and Rho come first in the preset list", () => {
  expect(CSV_PRESETS.slice(0, 3).map((preset) => preset.id)).toEqual([
    "chase-checking",
    "chase-card",
    "rho",
  ]);
});

test("Rho: only settled rows import, and the skipped ones are counted by status", () => {
  const result = parse(fixtureBytes("rho-checking.csv"), { preset: "rho" });
  const messages = result.diagnostics
    .list()
    .map((item) => item.message)
    .join("\n");
  expect(messages).toContain("Pending");
  expect(messages).toContain("Canceled");
  expect(messages).toContain("Awaiting Approval");
  expect(result.lines.length).toBe(manifest.stories.checking.count);
  // A Rho file without a Status column cannot tell pending from settled, and says so.
  const without = parse("Date,Amount,Memo\n2026-01-02,-44.00,GITHUB\n", { preset: "rho" });
  expect(without.diagnostics.count("column_missing")).toBeGreaterThan(0);
});
