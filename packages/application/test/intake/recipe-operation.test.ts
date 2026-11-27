import { afterEach, expect, test } from "bun:test";
import { closingOf, openingOf } from "../support/intake-corpus.ts";
import { corpusFixture, type CorpusFixture, type Json, M1, M2, money } from "./fixture.ts";

/** `intake.recipeTest`, `intake.recipeSave` and `intake.recipeList` through the HTTP boundary. */

const open: CorpusFixture[] = [];
afterEach(() => {
  for (const fixture of open.splice(0)) fixture.close();
});
async function fixture(options: Parameters<typeof corpusFixture>[0] = {}) {
  const created = await corpusFixture(options);
  open.push(created);
  return created;
}

async function accountOf(c: CorpusFixture, code: string): Promise<string> {
  const chart = (await c.f.call("accounts.list")).body.data.accounts as {
    id: string;
    code: string;
  }[];
  return (chart.find((item) => item.code === code) as { id: string }).id;
}

const proofFor = (c: CorpusFixture, layout: string, month = M1) => {
  const source = c.source(layout);
  return {
    source,
    balances: {
      openingBalance: money(openingOf(source, month)),
      endingBalance: money(closingOf(source, month)),
    },
  };
};

test("a recipe is tested on an uploaded file and the report says what was read and whether it is proven", async () => {
  const c = await fixture();
  const { source, balances } = proofFor(c, "juniper-card");
  const sha = await c.upload(c.fileFor(source, M1));
  const response = await c.f.call("intake.recipeTest", {
    sha256: sha,
    recipe: source.recipe,
    ...balances,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const report = response.body.data;
  expect(report).toMatchObject({
    valid: true,
    verified: true,
    recipe: { name: source.recipe?.name, version: 1 },
    reading: { format: "csv", source: "recipe", delimiter: ",", headerRow: 1 },
    verification: { method: "ending_balance", status: "pass" },
  });
  expect(report.rows.lines).toBe(source.months[M1].length);
  expect(report.file.sha256).toBe(sha);
  expect(report.gates.map((gate: Json) => gate.gate)).toEqual(
    expect.arrayContaining([
      "balance_chain",
      "ending_balance",
      "sign_convention",
      "date_order",
      "encoding",
      "pending_rows",
      "multiline_memo",
      "rejected_rows",
      "hostile_text",
    ]),
  );
});

test("a recipe with the wrong sign is invalid, and the report is a finding, not a failure to answer", async () => {
  const c = await fixture();
  const { source, balances } = proofFor(c, "juniper-card");
  const sha = await c.upload(c.fileFor(source, M1));
  const wrong = {
    ...source.recipe,
    mapping: {
      ...source.recipe?.mapping,
      amount: { kind: "signed", amount: { header: "Amount" } },
    },
  };
  const response = await c.f.call("intake.recipeTest", { sha256: sha, recipe: wrong, ...balances });
  expect(response.status).toBe(200);
  expect(response.body.data.valid).toBe(false);
  expect(response.body.data.verified).toBe(false);
  expect(
    response.body.data.gates.find((gate: Json) => gate.gate === "sign_convention"),
  ).toMatchObject({ status: "fail" });
});

test("a recipe whose mapping means nothing is refused with the column that is wrong", async () => {
  const c = await fixture();
  const source = c.source("juniper-card");
  const sha = await c.upload(c.fileFor(source, M1));
  const broken = {
    ...source.recipe,
    mapping: {
      date: { header: "Trans Date" },
      amount: { kind: "debitCredit" },
      description: [{ header: "Merchant" }],
    },
  };
  const response = await c.f.call("intake.recipeTest", { sha256: sha, recipe: broken });
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe("invalid_mapping");
  expect(response.body.error.details.map((item: Json) => item.path)).toEqual(
    expect.arrayContaining([
      "input.recipe.mapping.amount.debit",
      "input.recipe.mapping.amount.credit",
    ]),
  );
  // A name with control or direction characters never becomes a profile name.
  const named = await c.f.call("intake.recipeTest", {
    sha256: sha,
    recipe: { ...source.recipe, name: "ok\u202Ename" },
  });
  expect(named.status).toBe(400);
  // A file that was never uploaded is not found.
  const ghost = await c.f.call("intake.recipeTest", {
    sha256: "f".repeat(64),
    recipe: source.recipe,
  });
  expect(ghost.status).toBe(404);
});

test("a proven recipe is saved as an import profile and a later file is read with it, with nothing else said", async () => {
  const c = await fixture();
  const { source } = proofFor(c, "harbor-savings");
  const account = await accountOf(c, source.code);
  const proofs = [];
  for (const month of [M1, M2]) {
    const sha = await c.upload(c.fileFor(source, month));
    proofs.push({ sha256: sha, ...proofFor(c, "harbor-savings", month).balances });
  }
  const response = await c.f.call(
    "intake.recipeSave",
    { recipe: source.recipe, proofs, ledgerAccountId: account },
    crypto.randomUUID(),
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.data).toMatchObject({
    name: source.recipe?.name,
    revision: 1,
    accountKind: "bank",
    ledgerAccountId: account,
    savedBy: "owner",
  });
  expect(response.body.data.proven.map((item: Json) => item.method)).toEqual([
    "running_balance",
    "running_balance",
  ]);
  // It is an ordinary import profile now, bound to the account.
  const profiles = (await c.f.call("import.profileList", { ledgerAccountId: account })).body.data
    .profiles;
  expect(profiles).toHaveLength(1);
  expect(profiles[0]).toMatchObject({
    id: response.body.data.profileId,
    name: source.recipe?.name,
    version: 1,
  });
  expect((await c.f.call("intake.recipeList")).body.data.recipes).toMatchObject([
    { name: source.recipe?.name, revision: 1, profileId: profiles[0].id },
  ]);
  // A file of that layout the recipe was not proven on is read by the account's profile with no mapping given.
  const third = await c.upload(c.fileFor(source, "2026-07"));
  const preview = await c.f.call("import.preview", { sha256: third, ledgerAccountId: account });
  expect(preview.body.data.detection).toMatchObject({ how: "profile" });
  expect(preview.body.data.valid).toBe(true);
  // Saving the same name again is a new revision of the same profile.
  const again = await c.f.call(
    "intake.recipeSave",
    { recipe: source.recipe, proofs, ledgerAccountId: account },
    crypto.randomUUID(),
  );
  expect(again.body.data.revision).toBe(2);
  expect(
    (await c.f.call("import.profileList", { ledgerAccountId: account })).body.data.profiles,
  ).toHaveLength(1);
});

test("a retried save finds the first answer and saves nothing twice", async () => {
  const c = await fixture();
  const { source, balances } = proofFor(c, "juniper-card");
  const sha = await c.upload(c.fileFor(source, M1));
  const operationId = crypto.randomUUID();
  const body = { recipe: source.recipe, proofs: [{ sha256: sha, ...balances }] };
  const first = await c.f.call("intake.recipeSave", body, operationId);
  const second = await c.f.call("intake.recipeSave", body, operationId);
  expect(second.body.data).toEqual(first.body.data);
  expect(second.body.data.revision).toBe(1);
  expect((await c.f.call("import.profileList")).body.data.profiles).toHaveLength(1);
});

test("a recipe that has not been proven is refused, with the gate, and nothing is saved", async () => {
  const c = await fixture();
  const { source, balances } = proofFor(c, "juniper-card");
  const sha = await c.upload(c.fileFor(source, M1));
  const refuse = async (body: Json) => {
    const response = await c.f.call("intake.recipeSave", body, crypto.randomUUID());
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error.code).toBe("recipe_unproven");
    return response.body.error.details as { path: string; message: string }[];
  };
  // Wrong sign convention.
  const wrong = {
    ...source.recipe,
    mapping: {
      ...source.recipe?.mapping,
      amount: { kind: "signed", amount: { header: "Amount" } },
    },
  };
  const signs = await refuse({ recipe: wrong, proofs: [{ sha256: sha, ...balances }] });
  expect(signs.map((item) => item.path)).toEqual(
    expect.arrayContaining(["proofs[0].ending_balance", "proofs[0].sign_convention"]),
  );
  // No balances at all: nothing proves the file complete.
  const unproven = await refuse({ recipe: source.recipe, proofs: [{ sha256: sha }] });
  expect(unproven.length).toBeGreaterThan(0);
  // An ending balance that is one cent out.
  const off = await refuse({
    recipe: source.recipe,
    proofs: [{ sha256: sha, ...balances, endingBalance: money(closingOf(source, M1) + 1n) }],
  });
  expect(off.some((item) => item.message.includes("difference"))).toBe(true);
  // One bad proof among good ones refuses the whole recipe.
  const other = proofFor(c, "juniper-card", M2);
  const second = await c.upload(c.fileFor(source, M2));
  await refuse({
    recipe: source.recipe,
    proofs: [
      { sha256: sha, ...balances },
      { sha256: second, ...other.balances, endingBalance: money(closingOf(source, M2) + 5n) },
    ],
  });
  expect((await c.f.call("import.profileList")).body.data.profiles).toEqual([]);
  expect((await c.f.call("intake.recipeList")).body.data.recipes).toEqual([]);
});

test("a date order that every date satisfies is saved only once the statement period has settled it", async () => {
  const c = await fixture();
  const { source, balances } = proofFor(c, "tamarack-card");
  const sha = await c.upload(c.fileFor(source, M1));
  const claim = await c.f.call(
    "intake.recipeSave",
    { recipe: source.recipe, proofs: [{ sha256: sha, ...balances }] },
    crypto.randomUUID(),
  );
  expect(claim.status).toBe(409);
  const settled = await c.f.call(
    "intake.recipeSave",
    {
      recipe: source.recipe,
      proofs: [{ sha256: sha, ...balances, periodFrom: `${M1}-01`, periodTo: `${M1}-31` }],
    },
    crypto.randomUUID(),
  );
  expect(settled.status, JSON.stringify(settled.body)).toBe(200);
  const wrongOrder = {
    ...source.recipe,
    name: "Wrong order",
    mapping: { ...source.recipe?.mapping, dateOrder: "mdy" },
  };
  const refused = await c.f.call(
    "intake.recipeSave",
    {
      recipe: wrongOrder,
      proofs: [{ sha256: sha, ...balances, periodFrom: `${M1}-01`, periodTo: `${M1}-31` }],
    },
    crypto.randomUUID(),
  );
  expect(refused.status).toBe(409);
  expect(refused.body.error.details.map((item: Json) => item.path)).toContain(
    "proofs[0].date_period",
  );
});

test("a recipe for a card is not bound to a bank account", async () => {
  const c = await fixture();
  const { source, balances } = proofFor(c, "juniper-card");
  const sha = await c.upload(c.fileFor(source, M1));
  const bank = await accountOf(c, "1010");
  const response = await c.f.call(
    "intake.recipeSave",
    { recipe: source.recipe, proofs: [{ sha256: sha, ...balances }], ledgerAccountId: bank },
    crypto.randomUUID(),
  );
  expect(response.status).toBe(409);
  expect(response.body.error.code).toBe("recipe_account_mismatch");
});

test("permissions: testing and listing need read, saving needs draft, and nothing needs post", async () => {
  const c = await fixture();
  const { source, balances } = proofFor(c, "juniper-card");
  const sha = await c.upload(c.fileFor(source, M1));
  const test = { sha256: sha, recipe: source.recipe, ...balances };
  const save = { recipe: source.recipe, proofs: [{ sha256: sha, ...balances }] };
  const noRead = ["draft", "post", "configure", "correct", "close"] as never;
  expect((await c.f.call("intake.recipeTest", test, undefined, noRead)).status).toBe(403);
  expect((await c.f.call("intake.recipeList", {}, undefined, noRead)).status).toBe(403);
  expect((await c.f.call("intake.recipeTest", test, undefined, ["read"])).status).toBe(200);
  const readOnly = await c.f.call("intake.recipeSave", save, crypto.randomUUID(), ["read"]);
  expect(readOnly.status).toBe(403);
  expect(readOnly.body.error.code).toBe("permission_denied");
  for (const others of [
    ["post"],
    ["configure"],
    ["post", "configure", "correct", "close"],
  ] as const)
    expect(
      (await c.f.call("intake.recipeSave", save, crypto.randomUUID(), others as never)).status,
    ).toBe(403);
  // Saving also saves an import profile, which needs the same scope and no more.
  const draft = await c.f.call("intake.recipeSave", save, crypto.randomUUID(), ["read", "draft"]);
  expect(draft.status, JSON.stringify(draft.body)).toBe(200);
  expect((await c.f.call("intake.recipeList", {}, undefined, ["read"])).status).toBe(200);
  expect(c.f.ingest.submitted).toHaveLength(0);
});

test("a recipe can be tested before the book is set up", async () => {
  const c = await fixture({ setup: false });
  const { source, balances } = proofFor(c, "juniper-card");
  const sha = await c.upload(c.fileFor(source, M1));
  const response = await c.f.call("intake.recipeTest", {
    sha256: sha,
    recipe: source.recipe,
    ...balances,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.data.verified).toBe(true);
  // Saving one needs the book: the profile lives in it.
  const save = await c.f.call(
    "intake.recipeSave",
    { recipe: source.recipe, proofs: [{ sha256: sha, ...balances }] },
    crypto.randomUUID(),
  );
  expect(save.status).toBe(409);
  expect(save.body.error.code).toBe("book_not_configured");
});

test("negative control, a duplicate file imported twice: the second import adds nothing and the plan sees the duplicate", async () => {
  const c = await fixture({ real: true });
  const { source, balances } = proofFor(c, "harbor-savings");
  const account = await accountOf(c, source.code);
  const sha = await c.upload(c.fileFor(source, M1));
  const saved = await c.f.call(
    "intake.recipeSave",
    { recipe: source.recipe, proofs: [{ sha256: sha, ...balances }], ledgerAccountId: account },
    crypto.randomUUID(),
  );
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const first = await c.f.call(
    "import.commit",
    { sha256: sha, ledgerAccountId: account, profileId: saved.body.data.profileId },
    crypto.randomUUID(),
  );
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  expect(first.body.data.counts.new).toBe(source.months[M1].length);
  const second = await c.f.call(
    "import.commit",
    { sha256: sha, ledgerAccountId: account, profileId: saved.body.data.profileId },
    crypto.randomUUID(),
  );
  expect(second.status, JSON.stringify(second.body)).toBe(200);
  expect(second.body.data.counts.new).toBe(0);
  expect(second.body.data.waiting).toBe(0);
  // The same bytes under another name are the same file; the plan says it was listed twice.
  const renamed = await c.uploadBytes("copy-of-statement.csv", c.fileFor(source, M1).bytes);
  expect(renamed).toBe(sha);
  const plan = (
    await c.f.call("intake.plan", {
      fresh: true,
      cutoverDate: c.corpus.cutover,
      through: `${M1}-31`,
      sources: [{ account: source.code, files: [sha, renamed] }],
    })
  ).body.data;
  expect(plan.items.find((item: Json) => item.code === "duplicate_file")).toMatchObject({
    gate: "duplicate_file",
    status: "uncertain",
  });
});
