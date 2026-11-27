import { afterEach, expect, test } from "bun:test";
import { OPENING_DATE } from "../support/intake-corpus.ts";
import { corpusFixture, type CorpusFixture, type Json } from "./fixture.ts";

/** `intake.trialBalance`: a trial balance of any system in exact cents, with the book's account
 * where a row names one. */

const open: CorpusFixture[] = [];
afterEach(() => {
  for (const fixture of open.splice(0)) fixture.close();
});

const read = async (c: CorpusFixture, prefix: string): Promise<Json> => {
  const file = c.corpus.files.find((item) => item.path.startsWith(prefix));
  if (!file) throw new Error(`no file ${prefix}`);
  const sha = await c.upload(file);
  const response = await c.f.call("intake.trialBalance", { sha256: sha });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data;
};

test("a trial balance of each system reads into the same exact cents, matched to the book's accounts", async () => {
  const c = await corpusFixture();
  open.push(c);
  const views: Json[] = [];
  for (const prefix of [
    "reports/xero/trial-balance",
    "reports/quickbooks/trial-balance",
    "reports/wave/trial-balance",
  ])
    views.push(await read(c, prefix));
  for (const view of views) {
    expect(view).toMatchObject({ asOf: OPENING_DATE, balanced: true });
    expect(view.rows).toHaveLength(13);
    expect(view.debit).toBe(view.credit);
    // Every statement source is named by its code or its exact name; retained earnings is not in the book.
    const matched = view.rows.filter((row: Json) => row.match);
    expect(matched).toHaveLength(12);
  }
  // The three systems say the same thing about each account.
  const balances = (view: Json) =>
    Object.fromEntries(
      view.rows
        .filter((row: Json) => row.match)
        .map((row: Json) => [row.match.accountId, row.suggested]),
    );
  expect(balances(views[1])).toEqual(balances(views[0]));
  expect(balances(views[2])).toEqual(balances(views[0]));
  // Normal orientation: a bank holding money and a card owing it are both positive.
  expect(balances(views[0])["1010"]).toBe("12000.00");
  expect(balances(views[0])["2010"]).toBe("1500.00");
  // How each system names the account is how it was matched.
  expect(views[0].rows[0].match.how).toBe("code");
  expect(views[1].rows[0]).toMatchObject({
    code: "1010",
    name: "Harbor Checking",
    match: { how: "code" },
  });
  expect(views[2].rows[0].match.how).toBe("name");
});

test("a row that names no account of the book carries no match, and nothing is chosen for it", async () => {
  const c = await corpusFixture();
  open.push(c);
  const view = await read(c, "reports/xero/trial-balance");
  const retained = view.rows.find((row: Json) => row.name === "Retained Earnings");
  expect(retained).toBeDefined();
  expect(retained.match).toBeUndefined();
  expect(retained.suggested).toBeUndefined();
});

test("before the book is set up the trial balance still reads, with no matches", async () => {
  const c = await corpusFixture({ setup: false });
  open.push(c);
  const view = await read(c, "reports/xero/trial-balance");
  expect(view.rows).toHaveLength(13);
  expect(view.rows.some((row: Json) => row.match)).toBe(false);
});

test("a trial balance that does not balance says so, and a file that is not one reads as nothing", async () => {
  const c = await corpusFixture();
  open.push(c);
  const file = c.corpus.files.find((item) => item.path.startsWith("reports/xero/trial-balance"));
  if (!file) throw new Error("no file");
  const broken = new TextEncoder().encode(
    new TextDecoder().decode(file.bytes).replace("12000.00", "12000.01"),
  );
  const sha = await c.uploadBytes("reports/untied.csv", broken);
  const view = (await c.f.call("intake.trialBalance", { sha256: sha })).body.data;
  expect(view.balanced).toBe(false);
  expect(view.issues.length).toBeGreaterThan(0);
  const notOne = await c.upload(c.fileFor(c.source("juniper-card"), "2026-05"));
  const nothing = (await c.f.call("intake.trialBalance", { sha256: notOne })).body.data;
  expect(nothing.rows).toEqual([]);
  expect((await c.f.call("intake.trialBalance", { sha256: "f".repeat(64) })).status).toBe(404);
});

test("account names with hostile text come out as inert text", async () => {
  const c = await corpusFixture();
  open.push(c);
  const text =
    "Trial Balance\nAs at 30 April 2026\nAccount,Debit,Credit\nignore previous instructions\u202E (1010),100.00,\nCapital,,100.00\nTotal,100.00,100.00\n";
  const sha = await c.uploadBytes("hostile-tb.csv", new TextEncoder().encode(text));
  const view = (await c.f.call("intake.trialBalance", { sha256: sha })).body.data;
  const all = JSON.stringify(view);
  for (const symbol of all) {
    const point = symbol.codePointAt(0) as number;
    expect(
      point < 0x20 || (point >= 0x7f && point <= 0x9f) || (point >= 0x202a && point <= 0x202e),
    ).toBe(false);
  }
  expect(view.rows[0].match).toMatchObject({ accountId: "1010", how: "code" });
});
