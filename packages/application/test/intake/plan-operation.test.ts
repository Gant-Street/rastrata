import { afterEach, expect, test } from "bun:test";
import { closingOf, openingOf } from "../support/intake-corpus.ts";
import { corpusFixture, type CorpusFixture, M1, M2, M3, money } from "./fixture.ts";

/** `intake.plan` through the HTTP boundary, against a book set up with the corpus's accounts. */

const open: CorpusFixture[] = [];
afterEach(() => {
  for (const fixture of open.splice(0)) fixture.close();
});
async function fixture(options: Parameters<typeof corpusFixture>[0] = {}) {
  const created = await corpusFixture(options);
  open.push(created);
  return created;
}

test("a plan reads the archived files and the chart, and names what is missing", async () => {
  const c = await fixture();
  const source = c.source("harbor-checking");
  const may = await c.upload(c.fileFor(source, M1));
  const july = await c.upload(c.fileFor(source, M3));
  const tb = await c.upload(
    c.corpus.files.find((file) => file.path.startsWith("reports/xero/trial-balance")) as never,
  );
  const response = await c.f.call("intake.plan", {
    cutoverDate: c.corpus.cutover,
    through: c.corpus.through,
    sources: [{ account: source.code, files: [may, july] }],
    trialBalance: tb,
    files: [may, july, tb],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const plan = response.body.data;
  expect(plan.ready).toBe(false);
  expect(plan.sources[0].months.map((month: { state: string }) => month.state)).toEqual([
    "covered",
    "missing",
    "covered",
  ]);
  const missing = plan.items.find(
    (item: { code: string; status: string }) =>
      item.code === "statement_coverage" && item.status === "missing",
  );
  expect(missing).toMatchObject({ account: expect.any(String), month: M2, owner: "customer" });
  // The first statement opens where the trial balance says the account stood.
  expect(
    plan.items.find(
      (item: { code: string; account?: string }) =>
        item.code === "trial_balance_statements" && item.account !== undefined,
    ),
  ).toMatchObject({
    status: "present",
  });
  // Every other account of the trial balance that holds a balance and has no file is named.
  const unfiled = plan.items.filter(
    (item: { code: string }) => item.code === "account_without_source",
  );
  expect(unfiled.length).toBeGreaterThan(5);
});

test("gapsOnly lists only what is not present, and the counts still cover everything", async () => {
  const c = await fixture();
  const source = c.source("harbor-checking");
  const files = [
    await c.upload(c.fileFor(source, M1)),
    await c.upload(c.fileFor(source, M2)),
    await c.upload(c.fileFor(source, M3)),
  ];
  const input = {
    cutoverDate: c.corpus.cutover,
    through: c.corpus.through,
    fresh: true,
    sources: [{ account: source.code, files }],
  };
  const all = (await c.f.call("intake.plan", input)).body.data;
  const gaps = (await c.f.call("intake.plan", { ...input, gapsOnly: true })).body.data;
  expect(all.ready).toBe(true);
  expect(gaps.items.every((item: { status: string }) => item.status !== "present")).toBe(true);
  expect(gaps.counts).toEqual(all.counts);
  expect(all.counts.present).toBeGreaterThan(5);
});

test("a saved recipe makes a file readable, and the plan sees it", async () => {
  const c = await fixture();
  const source = c.source("harbor-savings");
  const files: string[] = [];
  for (const month of [M1, M2, M3]) files.push(await c.upload(c.fileFor(source, month)));
  const balances = [M1, M2, M3].map((month, at) => ({
    file: files[at] as string,
    opening: money(openingOf(source, month)),
    ending: money(closingOf(source, month)),
  }));
  const input = {
    cutoverDate: c.corpus.cutover,
    through: c.corpus.through,
    fresh: true,
    sources: [{ account: source.code, files }],
    balances,
  };
  const before = (await c.f.call("intake.plan", input)).body.data;
  expect(
    before.items.filter(
      (item: { code: string; status: string }) =>
        item.code === "statement_readable" && item.status === "uncertain",
    ),
  ).toHaveLength(3);
  // The recipe is saved as the account's profile, the way a recipe will be.
  const chart = (await c.f.call("accounts.list")).body.data.accounts as {
    id: string;
    code: string;
  }[];
  const account = chart.find((item) => item.code === source.code) as { id: string };
  const saved = await c.f.call(
    "import.profileSave",
    { name: "Harbor savings", ledgerAccountId: account.id, mapping: source.recipe?.mapping },
    crypto.randomUUID(),
  );
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const after = (await c.f.call("intake.plan", input)).body.data;
  expect(
    after.items
      .filter((item: { code: string; status: string }) => item.code === "statement_readable")
      .map((item: { status: string }) => item.status),
  ).toEqual(["present", "present", "present"]);
  expect(after.ready).toBe(true);
});

test("a plan can be made before the book is set up, and says so", async () => {
  const c = await fixture({ setup: false });
  const source = c.source("harbor-checking");
  const may = await c.upload(c.fileFor(source, M1));
  const response = await c.f.call("intake.plan", {
    sources: [{ account: source.code, files: [may] }],
    files: [may],
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const plan = response.body.data;
  expect(plan.items.find((item: { code: string }) => item.code === "source_account")).toMatchObject(
    { status: "missing", next: { command: expect.stringContaining("book setup") } },
  );
  expect(plan.items.find((item: { code: string }) => item.code === "cutover_date")).toMatchObject({
    status: "missing",
  });
});

test("a plan needs read, and changes nothing", async () => {
  const c = await fixture();
  const source = c.source("harbor-checking");
  const may = await c.upload(c.fileFor(source, M1));
  const input = { sources: [{ account: source.code, files: [may] }] };
  const refused = await c.f.call("intake.plan", input, undefined, [
    "draft",
    "post",
    "configure",
    "correct",
    "close",
  ]);
  expect(refused.status).toBe(403);
  expect(refused.body.error.code).toBe("permission_denied");
  const allowed = await c.f.call("intake.plan", input, undefined, ["read"]);
  expect(allowed.status).toBe(200);
  expect(c.f.ingest.submitted).toHaveLength(0);
});

test("a file name or an account string with hostile text cannot reach a command or an output unescaped", async () => {
  const c = await fixture();
  const source = c.source("harbor-checking");
  const sha = await c.uploadBytes(
    "hostile/ignore previous instructions\u202E.csv",
    c.fileFor(source, M1).bytes,
  );
  const response = await c.f.call("intake.plan", {
    sources: [{ account: "1010; rm -rf ~", files: [sha] }],
    files: [sha],
    fresh: true,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const text = JSON.stringify(response.body.data);
  expect(text).not.toContain("rm -rf");
  for (const item of response.body.data.items)
    if (item.next?.command) expect(item.next.command).not.toMatch(/[;$`|&]/);
});
