import { expect, test } from "bun:test";
import { inspectFile } from "../../src/intake/inspect.ts";
import { formatMoney } from "../../src/money.ts";
import {
  type Expectations,
  type GateResult,
  type Recipe,
  type RecipeReport,
  testRecipe,
} from "../../src/intake/recipe.ts";
import type { CsvMapping } from "../../src/statements/csv-mapping.ts";
import {
  closingOf,
  generateCorpus,
  hostileFiles,
  type Month,
  MONTHS,
  openingOf,
  type SourceTruth,
} from "../support/intake-corpus.ts";

/** The verification gates, each with a negative control: a test that seeds the fault the gate is
 * for and proves the gate catches it, next to the clean file that passes. */

const corpus = generateCorpus();
const [M1] = MONTHS as unknown as [Month];
const enc = new TextEncoder();
const dec = new TextDecoder();

const source = (layout: string): SourceTruth =>
  corpus.sources.find((item) => item.layout === layout) as SourceTruth;
const bytesOf = (s: SourceTruth, month: Month = M1): Uint8Array =>
  (
    corpus.files.find((file) => file.source === s.code && file.month === month) as {
      bytes: Uint8Array;
    }
  ).bytes;

const truth = (s: SourceTruth, month: Month = M1): Expectations => ({
  openingBalance: formatMoney(openingOf(s, month)),
  endingBalance: formatMoney(closingOf(s, month)),
});

const recipeOf = (s: SourceTruth): Recipe => s.recipe as unknown as Recipe;

const withMapping = (recipe: Recipe, change: Partial<CsvMapping>): Recipe => ({
  ...recipe,
  mapping: { ...recipe.mapping, ...change } as CsvMapping,
});

function run(
  s: SourceTruth,
  options: {
    month?: Month;
    bytes?: Uint8Array;
    recipe?: Recipe | null;
    expect?: Expectations;
  } = {},
): RecipeReport {
  const month = options.month ?? M1;
  const recipe = options.recipe === undefined ? s.recipe : options.recipe;
  return testRecipe({
    bytes: options.bytes ?? bytesOf(s, month),
    ...(recipe ? { recipe: recipe as unknown as Recipe } : {}),
    expect: options.expect ?? truth(s, month),
    defaultCurrency: "USD",
    accountKind: s.role === "liability" ? "card" : "bank",
  });
}

const gate = (report: RecipeReport, name: string): GateResult =>
  report.gates.find((item) => item.gate === name) as GateResult;
const failed = (report: RecipeReport): string[] =>
  report.gates.filter((item) => item.status === "fail").map((item) => item.gate);

// ---- The clean files pass -----------------------------------------------------------------

test("every layout of the corpus, with the recipe an agent would write, passes every gate and is verified", () => {
  for (const s of corpus.sources) {
    for (const month of MONTHS) {
      const report = run(s, {
        month,
        // The bank's own totals row is not a transaction: the owner agrees to leave it out.
        expect: {
          ...truth(s, month),
          ...(s.layout === "tamarack-checking" ? { skipInvalidRows: true } : {}),
          // A statement whose dates read both ways is settled by the period it prints.
          ...(s.ambiguousDates ? { periodFrom: `${month}-01`, periodTo: `${month}-31` } : {}),
        },
      });
      const where = `${s.layout} ${month}`;
      expect(
        failed(report),
        `${where}: ${JSON.stringify(report.gates.filter((g) => g.status === "fail"))}`,
      ).toEqual([]);
      expect(report.valid, where).toBe(true);
      expect(report.verified, `${where}: ${report.verification.detail}`).toBe(true);
      expect(report.rows.lines, where).toBe(s.months[month].filter(() => true).length);
      expect(report.totals.net, where).toBe(
        formatMoney(s.months[month].reduce((sum, txn) => sum + txn.cents, 0n)),
      );
      const method = report.verification.method;
      expect(["running_balance", "ending_balance"], where).toContain(method);
    }
  }
});

test("a file with a running balance is proved by its own arithmetic; one without, by the statement's balances", () => {
  const chained = run(source("harbor-checking"));
  expect(chained.verification).toMatchObject({ method: "running_balance", status: "pass" });
  const bare = run(source("juniper-card"));
  expect(bare.verification).toMatchObject({ method: "ending_balance", status: "pass" });
  const unverified = run(source("juniper-card"), { expect: {} });
  expect(unverified.verified).toBe(false);
  expect(unverified.verification.status).toBe("unverified");
  expect(unverified.hints.join(" ")).toContain("opening and ending balances");
});

test("a running balance proves the layout, and says it does not prove the ends of the file", () => {
  const s = source("harbor-checking");
  const alone = run(s, { expect: {} });
  expect(alone.verified).toBe(true);
  expect(alone.verification.method).toBe("running_balance");
  expect(alone.hints.join(" ")).toContain("nothing is missing from the end");
  // With the statement's opening balance only, a file missing its first line is caught: its first
  // running balance implies a different opening.
  const lines = dec.decode(bytesOf(s)).split("\n");
  lines.splice(1, 1);
  const headless = run(s, {
    bytes: enc.encode(lines.join("\n")),
    expect: { openingBalance: formatMoney(openingOf(s, M1)) },
  });
  expect(headless.valid).toBe(false);
  expect(gate(headless, "ending_balance").status).toBe("fail");
  expect(gate(headless, "ending_balance").detail).toContain("missing from the start");
  // And a file missing its last line is caught by the ending balance.
  const tail = dec.decode(bytesOf(s)).trimEnd().split("\n");
  tail.pop();
  const truncated = run(s, { bytes: enc.encode(`${tail.join("\n")}\n`) });
  expect(truncated.valid).toBe(false);
  expect(gate(truncated, "ending_balance").status).toBe("fail");
});

test("a report names rows, totals and the range, and what was left out", () => {
  const s = source("quill-business");
  const report = run(s);
  expect(report.rows).toMatchObject({ lines: s.months[M1].length, filtered: 1, rejected: 0 });
  expect(report.range).toEqual({
    from: s.months[M1][0]?.date as string,
    to: s.months[M1].at(-1)?.date as string,
  });
  expect(report.reading).toMatchObject({
    format: "csv",
    source: "recipe",
    encoding: "utf-8",
    delimiter: ",",
    headerRow: 1,
  });
});

// ---- Negative controls ---------------------------------------------------------------------

test("negative control, wrong sign convention: a card read without the issuer's flip fails on the signs and says why", () => {
  const s = source("juniper-card");
  const recipe = recipeOf(s);
  const wrong = withMapping(recipe, {
    amount: { ...(recipe.mapping.amount as object), invert: false } as never,
  });
  const report = run(s, { recipe: wrong });
  expect(report.valid).toBe(false);
  expect(report.verified).toBe(false);
  expect(failed(report)).toEqual(expect.arrayContaining(["ending_balance", "sign_convention"]));
  expect(gate(report, "sign_convention").detail).toContain("reversed");
  expect(report.verification.status).toBe("fail");
  // Without balances to compare, the gate still says most of a card's lines are money in.
  const noBalances = run(s, { recipe: wrong, expect: {} });
  expect(gate(noBalances, "sign_convention").status).toBe("fail");
  expect(gate(noBalances, "sign_convention").detail).toContain("flip the sign");
});

test("negative control, wrong sign convention: a bank file flipped by mistake breaks its running balance", () => {
  const s = source("harbor-savings");
  const recipe = recipeOf(s);
  const flipped = withMapping(recipe, {
    amount: { kind: "signed", amount: { header: "Amount" }, invert: true } as never,
  });
  const report = run(s, { recipe: flipped });
  expect(report.valid).toBe(false);
  // The file's balance now counts the other way from the amounts: the parser learns that, so the
  // running balance stays consistent with itself and the statement's ending balance is what fails.
  expect(failed(report)).toEqual(expect.arrayContaining(["ending_balance", "sign_convention"]));
  expect(gate(report, "sign_convention").detail).toContain("reversed");
  // With nothing from the statement to compare, a bank whose balance counts the other way is still said.
  const alone = run(s, { recipe: flipped, expect: {} });
  expect(gate(alone, "sign_convention").status).toBe("fail");
  expect(gate(alone, "sign_convention").detail).toContain("how a card shows what is owed");
  expect(alone.valid).toBe(false);
});

test("negative control, D/M against M/D: an ambiguous column refuses to be guessed", () => {
  const s = source("tamarack-card");
  const recipe = recipeOf(s);
  // The recipe leaves the order to the data: the data cannot say.
  const auto = run(s, { recipe: withMapping(recipe, { dateOrder: "auto" }) });
  expect(auto.valid).toBe(false);
  expect(gate(auto, "date_order").status).toBe("fail");
  expect(gate(auto, "date_order").detail).toContain("statement period");
  // The wrong order reads every date as a real date, so the sums still agree; only the period catches it.
  const wrong = withMapping(recipe, { dateOrder: "mdy" });
  const period = { periodFrom: `${M1}-01`, periodTo: `${M1}-31` };
  const caught = run(s, { recipe: wrong, expect: { ...truth(s), ...period } });
  expect(gate(caught, "ending_balance").status).toBe("pass");
  expect(gate(caught, "date_period").status).toBe("fail");
  expect(caught.valid).toBe(false);
  // The right order, confirmed by the statement period, passes and is verified.
  const right = run(s, { expect: { ...truth(s), ...period } });
  expect(gate(right, "date_period").status).toBe("pass");
  expect(right.verified).toBe(true);
  // The right order with no period is only a claim: the sums cannot confirm it.
  const claim = run(s);
  expect(gate(claim, "date_order").status).toBe("unverified");
  expect(claim.valid).toBe(true);
  expect(claim.verified).toBe(false);
  expect(claim.hints.join(" ")).toContain("statement period");
});

test("negative control, a date order the data contradicts is refused", () => {
  const s = source("harbor-checking");
  // The corpus has a day above 12 in the second position: month first. A recipe that says day first is wrong.
  const report = run(s, { recipe: withMapping(recipeOf(s), { dateOrder: "dmy" }) });
  expect(report.valid).toBe(false);
  expect(gate(report, "date_order").status).toBe("fail");
  expect(gate(report, "date_order").detail).toContain("prove mdy");
});

test("negative control, a missing line: the running balance breaks at the line, the sums break by its amount", () => {
  const chained = source("harbor-checking");
  const lines = dec.decode(bytesOf(chained)).split("\n");
  lines.splice(3, 1);
  const cut = run(chained, { bytes: enc.encode(lines.join("\n")) });
  expect(cut.valid).toBe(false);
  expect(gate(cut, "balance_chain").status).toBe("fail");
  expect(gate(cut, "balance_chain").rows).toEqual([4]);

  const bare = source("juniper-card");
  const rows = dec.decode(bytesOf(bare)).split("\n");
  const removed = rows.splice(2, 1)[0] as string;
  const report = run(bare, { bytes: enc.encode(rows.join("\n")) });
  expect(report.valid).toBe(false);
  expect(gate(report, "ending_balance").status).toBe("fail");
  expect(report.verification.status).toBe("fail");
  // The difference is the line that went missing; it is shown and never adjusted.
  const amount = Number(removed.split(",").at(-1));
  expect(Math.abs(Number(report.verification.difference))).toBeCloseTo(Math.abs(amount), 2);
  expect(gate(report, "ending_balance").detail).toContain("Never adjust a balance");
});

test("negative control, an ending balance that does not match is a failure with the difference, not a rounding", () => {
  const s = source("tamarack-headerless");
  const right = truth(s);
  const off = { ...right, endingBalance: formatMoney((closingOf(s, M1) as bigint) + 1n) };
  const report = run(s, { expect: off });
  expect(report.valid).toBe(false);
  expect(report.verification).toMatchObject({
    method: "ending_balance",
    status: "fail",
    difference: "-0.01",
  });
  expect(gate(report, "ending_balance").detail).toContain("difference -0.01");
  // With a running balance, a wrong opening balance is caught too.
  const chained = source("harbor-checking");
  const wrongStart = run(chained, {
    expect: { ...truth(chained), openingBalance: formatMoney(openingOf(chained, M1) + 100n) },
  });
  expect(gate(wrongStart, "ending_balance").status).toBe("fail");
});

test("negative control, a byte-order mark: it is read past, reported, and an encoding the recipe gets wrong is refused", () => {
  const s = source("quill-business");
  const bytes = bytesOf(s);
  expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const clean = run(s);
  expect(clean.valid).toBe(true);
  expect(clean.reading.encoding).toBe("utf-8");
  // A recipe that assumes another encoding is caught, not silently read as mojibake.
  const wrong = run(s, { recipe: { ...recipeOf(s), encoding: "windows-1252" } });
  expect(gate(wrong, "encoding").status).toBe("fail");
  expect(wrong.valid).toBe(false);
  const utf16 = source("quill-card-utf16");
  expect(run(utf16).reading.encoding).toBe("utf-16le");
  expect(
    gate(run(utf16, { recipe: { ...recipeOf(utf16), encoding: "utf-8" } }), "encoding").status,
  ).toBe("fail");
  // And the encoding of a Windows-1252 file is the recipe's assertion, and holds.
  const tamarack = source("tamarack-checking");
  const report = run(tamarack, { expect: { ...truth(tamarack), skipInvalidRows: true } });
  expect(gate(report, "encoding")).toMatchObject({ status: "pass" });
  expect(report.reading.encoding).toBe("windows-1252");
});

test("negative control, a pending line: a recipe that does not leave it out fails, one that does passes", () => {
  const s = source("quill-business");
  const recipe = recipeOf(s);
  const { include: _kept, ...without } = recipe.mapping as CsvMapping & { include?: unknown };
  const report = run(s, { recipe: { ...recipe, mapping: without as CsvMapping } });
  expect(report.valid).toBe(false);
  expect(gate(report, "pending_rows").status).toBe("fail");
  expect(gate(report, "pending_rows").detail).toContain("not final");
  // Pending lines have no running balance, so the arithmetic fails too.
  expect(report.verified).toBe(false);
  const clean = run(s);
  expect(gate(clean, "pending_rows")).toMatchObject({ status: "pass" });
  // A filter that keeps the pending rows is not a filter.
  const leaky = withMapping(recipe, {
    include: { column: { header: "Status" }, values: ["Settled", "Pending"] },
  });
  expect(gate(run(s, { recipe: leaky }), "pending_rows").status).toBe("fail");
});

test("negative control, a multi-line memo: kept in quotes it is one row, outside quotes it is caught", () => {
  const s = source("quill-business");
  const clean = run(s);
  expect(gate(clean, "multiline_memo").status).toBe("pass");
  expect(gate(clean, "multiline_memo").detail).toContain("several lines");
  const text = dec.decode(bytesOf(s)).replace(/^\uFEFF/, "");
  // Strip the quotes round the memos that run over two lines: the break now splits the row.
  const broken = text.replace(/"([^"\r\n]*)\r?\n([^"\r\n]*)"/g, "$1\r\n$2");
  expect(broken).not.toBe(text);
  const report = run(s, { bytes: enc.encode(`\uFEFF${broken}`) });
  expect(report.valid).toBe(false);
  expect(gate(report, "multiline_memo").status).toBe("fail");
  // The split rows are left out silently by the status filter, and the running balance notices.
  expect(gate(report, "balance_chain").status).toBe("fail");
});

test("negative control, rows that cannot be read are listed, and left out only by the owner's agreement", () => {
  const s = source("tamarack-checking");
  const refused = run(s);
  expect(refused.valid).toBe(false);
  expect(gate(refused, "rejected_rows").status).toBe("fail");
  expect(refused.rejected.length).toBeGreaterThan(0);
  expect(refused.rejected[0]?.row).toBeGreaterThan(1);
  const agreed = run(s, { expect: { ...truth(s), skipInvalidRows: true } });
  expect(gate(agreed, "rejected_rows").status).toBe("pass");
  expect(agreed.rows.rejected).toBe(1);
  // Leaving the row out does not excuse the balance: it still has to agree.
  const off = run(s, {
    expect: {
      ...truth(s),
      skipInvalidRows: true,
      endingBalance: formatMoney(closingOf(s, M1) + 5n),
    },
  });
  expect(off.valid).toBe(false);
});

test("a file in the wrong shape for its recipe says so, and an unreadable file says why", () => {
  const s = source("harbor-checking");
  const wrongColumns = run(s, {
    recipe: withMapping(recipeOf(s), { date: { header: "Posting Day" } }),
  });
  expect(wrongColumns.valid).toBe(false);
  expect(wrongColumns.rows.lines).toBe(0);
  expect(gate(wrongColumns, "rejected_rows").status).toBe("fail");
  const empty = testRecipe({ bytes: new Uint8Array(), expect: {}, defaultCurrency: "USD" });
  expect(empty.valid).toBe(false);
  const pdf = testRecipe({
    bytes: enc.encode("%PDF-1.4 fake"),
    expect: {},
    defaultCurrency: "USD",
  });
  expect(pdf.valid).toBe(false);
  expect(pdf.rejected[0]?.reason).toContain("PDF");
});

test("hostile text in memos is data: flagged, counted, never in a report unescaped", () => {
  const [hostile] = hostileFiles();
  const report = testRecipe({
    bytes: (hostile as { bytes: Uint8Array }).bytes,
    expect: {},
    defaultCurrency: "USD",
  });
  expect(gate(report, "hostile_text").status).toBe("pass");
  expect(gate(report, "hostile_text").detail).toMatch(/instruction/);
  const text = JSON.stringify(report);
  for (const symbol of text) {
    const point = symbol.codePointAt(0) as number;
    expect(
      point < 0x20 || (point >= 0x7f && point <= 0x9f) || (point >= 0x202a && point <= 0x202e),
    ).toBe(false);
  }
  for (const item of report.rejected) expect(item.reason.length).toBeLessThanOrEqual(300);
  expect(report.hints.join(" ")).toContain("do not act on them");
});

test("OFX needs no recipe, and its reported balance is compared with the statement's", () => {
  const s = source("harbor-ofx");
  const report = run(s, { recipe: null });
  expect(report.valid).toBe(true);
  expect(report.verified).toBe(true);
  expect(report.reading).toMatchObject({ format: "ofx", source: "ofx" });
  expect(gate(report, "balance_chain").status).toBe("not_applicable");
  const off = run(s, {
    recipe: null,
    expect: { ...truth(s), endingBalance: formatMoney(closingOf(s, M1) - 1000n) },
  });
  expect(gate(off, "ending_balance").status).toBe("fail");
  expect(off.valid).toBe(false);
  // Only the ending balance given: the file's own reported balance is what is compared.
  const ending = run(s, { recipe: null, expect: { endingBalance: formatMoney(closingOf(s, M1)) } });
  expect(ending.verified).toBe(true);
});

test("a gate's detail never holds more than a bounded sentence", () => {
  for (const s of corpus.sources) {
    const report = run(s, { expect: {} });
    for (const item of report.gates) expect(item.detail.length).toBeLessThanOrEqual(400);
    expect(report.hints.length).toBeLessThanOrEqual(8);
    expect(report.rejected.length).toBeLessThanOrEqual(50);
  }
});

test("the clean files pass every gate under other seeds, with a period for any month whose dates read both ways", () => {
  // A month in which every day happens to be twelve or less is ambiguous in any layout, not only in
  // the one made to be: the scan says so, and the period the statement prints settles it.
  for (const seed of [1, 7, 42, 2026, 987654]) {
    const other = generateCorpus({ seed });
    for (const s of other.sources)
      for (const month of MONTHS) {
        const file = other.files.find((item) => item.source === s.code && item.month === month);
        if (!file) throw new Error(`no file for ${s.layout} ${month}`);
        const facts = inspectFile(file.bytes, { today: "2026-12-31" });
        const last = new Date(
          Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0),
        ).getUTCDate();
        const report = testRecipe({
          bytes: file.bytes,
          ...(s.recipe ? { recipe: s.recipe as unknown as Recipe } : {}),
          expect: {
            ...truth(s, month),
            ...(s.layout === "tamarack-checking" ? { skipInvalidRows: true } : {}),
            ...(facts.dateOrder === "ambiguous"
              ? { periodFrom: `${month}-01`, periodTo: `${month}-${last}` }
              : {}),
          },
          defaultCurrency: "USD",
          accountKind: s.role === "liability" ? "card" : "bank",
        });
        const where = `seed ${seed} ${s.layout} ${month}`;
        expect(report.valid, where).toBe(true);
        expect(report.verified, `${where}: ${report.verification.detail}`).toBe(true);
      }
  }
});
