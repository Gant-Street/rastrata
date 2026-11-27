import { afterEach, expect, test } from "bun:test";
import { ApplicationHttp } from "../src/http.ts";
import { BUSINESS_PERMISSIONS, definitions, operationCatalog } from "../src/schema.ts";
import { sliceSchemas } from "../src/slices/catalog.ts";
import {
  ADD_ONS,
  buildTemplate,
  STRIPE_ROLE_KEYS,
  TEMPLATES,
  type BuiltTemplate,
  type TemplateBasis,
} from "../src/chart/templates.ts";
import { CATCHALL_EXPENSE, CATCHALL_INCOME, tagProblem } from "../src/chart/tags.ts";
import { TAX_YEARS, taxLineIn } from "../src/chart/tax-lines.ts";
import { chartFixture, cleanUp, uuid } from "./chart-support.ts";

afterEach(cleanUp);

const BASES: TemplateBasis[] = ["cash", "accrual"];
const addOnSets = [[], ["online-business"]];

/** Every template, in every combination a person can choose. */
const combinations = TEMPLATES.flatMap((template) =>
  BASES.flatMap((basis) =>
    TAX_YEARS.flatMap((taxYear) =>
      addOnSets.map((addOns) => ({
        template,
        basis,
        taxYear,
        addOns,
        label: `${template.id} ${basis} ${taxYear} ${addOns.join("+") || "plain"}`,
        built: buildTemplate(template.id, { basis, taxYear, addOns }),
      })),
    ),
  ),
);

const ROLE_BY_THOUSAND: Record<string, string[]> = {
  "1": ["asset"],
  "2": ["liability"],
  "3": ["equity"],
  "4": ["income"],
  "5": ["expense"],
  "6": ["expense"],
};

test("every template builds in every combination without tripping the tag rules", () => {
  expect(combinations.length).toBe(
    TEMPLATES.length * BASES.length * TAX_YEARS.length * addOnSets.length,
  );
  for (const { built, label } of combinations)
    expect(built.accounts.length, label).toBeGreaterThan(20);
});

test("codes are unique and well formed, names are unique, and a code's thousands digit matches its type", () => {
  for (const { built, label } of combinations) {
    const codes = built.accounts.map((account) => account.code.toLowerCase());
    expect(new Set(codes).size, `${label}: duplicate code`).toBe(codes.length);
    const names = built.accounts.map((account) => account.name.toLowerCase());
    expect(new Set(names).size, `${label}: duplicate name`).toBe(names.length);
    for (const account of built.accounts) {
      expect(account.code, label).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{1,19}$/);
      expect(account.name.trim().length, `${label} ${account.code}`).toBeGreaterThan(0);
      expect(account.name.length, `${label} ${account.code}`).toBeLessThanOrEqual(120);
      expect(ROLE_BY_THOUSAND[account.code[0] ?? ""], `${label} ${account.code}`).toContain(
        account.role,
      );
    }
  }
});

test("roles are balanced: every statement has something to stand on, and the books can always balance", () => {
  for (const { built, label } of combinations) {
    const roles = new Set(built.accounts.map((account) => account.role));
    for (const role of ["asset", "liability", "equity", "income", "expense"])
      expect(roles.has(role as never), `${label} has no ${role} account`).toBe(true);
    // A place for a sale to land, and the equity to stand on. No bank account: that is the person's own,
    // made from what they bring.
    const byName = (needle: RegExp) => built.accounts.some((account) => needle.test(account.name));
    expect(byName(/checking/i), label).toBe(false);
    expect(byName(/^sales$/i), label).toBe(true);
    expect(byName(/opening balance equity/i), label).toBe(true);
    expect(byName(/(investment|capital|common stock|owner'?s equity)/i), label).toBe(true);
    expect(byName(/(draw|distribution)/i), label).toBe(true);
    // Contra-revenue is income-role so a refund reads as negative revenue, never as an expense.
    expect(
      built.accounts.find((account) => account.name === "Returns and allowances")?.role,
      label,
    ).toBe("income");
  }
});

test("every balance-sheet account has a cash-flow class and no other account has one", () => {
  for (const { built, label } of combinations) {
    for (const account of built.accounts) {
      const balanceSheet = ["asset", "liability", "equity"].includes(account.role);
      expect(
        account.tags.cashFlowClass !== undefined,
        `${label} ${account.code} ${account.name}`,
      ).toBe(balanceSheet);
    }
    // Cash accounts come with the person's bank accounts; a template has them only through the Stripe
    // add-on (its balance and payouts in transit).
    const cash = built.accounts.filter((account) => account.tags.cashFlowClass === "cash");
    for (const account of cash) expect(account.role, `${label} ${account.code}`).toBe("asset");
    // Cash is where money sits: never receivables, inventory, equipment or anything owed.
    for (const account of cash)
      expect(account.name, label).not.toMatch(/receivable|inventory|equipment|prepaid/i);
  }
});

test("equity is financing, depreciation is the non-cash add-back, and equipment is investing", () => {
  for (const { built, label } of combinations) {
    for (const account of built.accounts.filter((item) => item.role === "equity"))
      expect(account.tags.cashFlowClass, `${label} ${account.name}`).toBe("financing");
    expect(
      built.accounts.find((account) => account.name === "Accumulated depreciation")?.tags
        .cashFlowClass,
      label,
    ).toBe("noncash");
    expect(
      built.accounts.find((account) => account.name === "Equipment and computers")?.tags
        .cashFlowClass,
      label,
    ).toBe("investing");
  }
});

test("every tax line is a real line of the template's own form, for that year, and takes the account's type", () => {
  for (const { built, template, taxYear, label } of combinations) {
    const ownForm = template.form;
    for (const account of built.accounts) {
      const line = account.tags.taxLine;
      if (!ownForm) {
        expect(line, `${label} ${account.code}: generic has no tax lines`).toBeUndefined();
        continue;
      }
      if (["asset", "liability", "equity"].includes(account.role)) {
        expect(
          line,
          `${label} ${account.code}: balance-sheet accounts carry no tax line`,
        ).toBeUndefined();
        continue;
      }
      expect(line, `${label} ${account.code} ${account.name} has no tax line`).toBeDefined();
      const found = taxLineIn(line as string, taxYear);
      expect(
        found,
        `${label} ${account.code}: ${line} is not on the ${taxYear} form`,
      ).toBeDefined();
      expect(found?.roles, `${label} ${account.code} ${line}`).toContain(account.role);
      const formOfLine = (line as string).split(".")[0] ?? "";
      expect(
        [ownForm, ...(template.attached ?? [])].map(String),
        `${label} ${account.code}`,
      ).toContain(formOfLine);
    }
    // The forms named in the output are the ones the lines come from.
    const named = new Set(built.taxForms.map((form) => form.id));
    for (const account of built.accounts)
      if (account.tags.taxLine)
        expect(named.has((account.tags.taxLine.split(".")[0] ?? "") as never), label).toBe(true);
    for (const form of built.taxForms) expect(form.taxYear, label).toBe(taxYear);
  }
});

test("Schedule C maps each kind of cost to the lines the form prints", () => {
  const chart = (taxYear: number, addOns: string[] = []) =>
    buildTemplate("sole-proprietor", { basis: "cash", taxYear, addOns });
  const lineOf = (built: BuiltTemplate, name: string) =>
    built.accounts.find((account) => account.name === name)?.tags.taxLine;
  const expected: Record<string, string> = {
    Sales: "scheduleC.line1",
    "Returns and allowances": "scheduleC.line2",
    "Other income": "scheduleC.line6",
    "Cost of goods sold: Purchases": "scheduleC.line36",
    "Cost of goods sold: Cost of labor": "scheduleC.line37",
    "Cost of goods sold: Materials and supplies": "scheduleC.line38",
    "Cost of goods sold: Other costs": "scheduleC.line39",
    "Advertising and marketing": "scheduleC.line8",
    "Commissions and fees": "scheduleC.line10",
    "Contract labor": "scheduleC.line11",
    Depreciation: "scheduleC.line13",
    "Legal and professional services": "scheduleC.line17",
    "Office expense": "scheduleC.line18",
    "Rent or lease: Equipment": "scheduleC.line20a",
    "Rent or lease: Office space": "scheduleC.line20b",
    "Taxes and licenses": "scheduleC.line23",
    Meals: "scheduleC.line24b",
    Wages: "scheduleC.line26",
    // Part V: the 2025 form moved "Other expenses (from line 48)" to line 27b.
    "Software and subscriptions": "scheduleC.line27b",
    "Bank and card fees": "scheduleC.line27b",
    "Other expenses": "scheduleC.line27b",
  };
  for (const year of TAX_YEARS)
    for (const [name, line] of Object.entries(expected))
      expect(lineOf(chart(year), name), `${year} ${name}`).toBe(line);
  // Interest is the one line a number moved on: 16b "Other" in 2025, 16c "Other" in the 2026 draft.
  expect(lineOf(chart(2025), "Interest expense")).toBe("scheduleC.line16b");
  expect(lineOf(chart(2026), "Interest expense")).toBe("scheduleC.line16c");
  // Processing fees: the instructions do not name them; line 10 with a note to ask a preparer.
  expect(lineOf(chart(2026, ["online-business"]), "Stripe fees")).toBe("scheduleC.line10");
  expect(lineOf(chart(2026, ["online-business"]), "Chargebacks and disputes")).toBe(
    "scheduleC.line27b",
  );
});

test("the S corporation and partnership charts use their own forms and Form 1125-A for cost of goods sold", () => {
  const s = buildTemplate("s-corporation", { basis: "cash", taxYear: 2026 });
  const lineOf = (built: BuiltTemplate, name: string) =>
    built.accounts.find((account) => account.name === name)?.tags.taxLine;
  expect(lineOf(s, "Sales")).toBe("form1120S.line1a");
  expect(lineOf(s, "Returns and allowances")).toBe("form1120S.line1b");
  expect(lineOf(s, "Officer compensation")).toBe("form1120S.line7");
  expect(lineOf(s, "Salaries and wages")).toBe("form1120S.line8");
  expect(lineOf(s, "Insurance")).toBe("form1120S.line20");
  expect(lineOf(s, "Utilities")).toBe("form1120S.line20");
  expect(lineOf(s, "Cost of goods sold: Purchases")).toBe("form1125A.line2");
  expect(s.taxForms.map((form) => form.id)).toEqual(["form1120S", "form1125A"]);
  const p = buildTemplate("partnership", { basis: "cash", taxYear: 2026 });
  expect(lineOf(p, "Sales")).toBe("form1065.line1a");
  expect(lineOf(p, "Guaranteed payments to partners")).toBe("form1065.line10");
  expect(lineOf(p, "Insurance")).toBe("form1065.line21");
  expect(lineOf(p, "Cost of goods sold: Cost of labor")).toBe("form1125A.line3");
  expect(p.taxForms.map((form) => form.id)).toEqual(["form1065", "form1125A"]);
  // Owners' money is equity on every form: it is never an expense.
  for (const built of [s, p, buildTemplate("sole-proprietor", { basis: "cash", taxYear: 2026 })])
    for (const account of built.accounts.filter((item) => /draw|distribution/i.test(item.name)))
      expect(account.role, `${built.id} ${account.name}`).toBe("equity");
});

test("cash books leave out what only accrual books record; accrual books keep it", () => {
  const accrualOnly = [
    "Accounts receivable",
    "Accounts payable",
    "Prepaid expenses",
    "Deferred revenue",
  ];
  for (const template of TEMPLATES) {
    const cash = buildTemplate(template.id, {
      basis: "cash",
      taxYear: 2026,
      addOns: ["online-business"],
    });
    const accrual = buildTemplate(template.id, {
      basis: "accrual",
      taxYear: 2026,
      addOns: ["online-business"],
    });
    const names = (built: BuiltTemplate) => built.accounts.map((account) => account.name);
    for (const name of accrualOnly) {
      expect(names(cash), `${template.id} cash ${name}`).not.toContain(name);
      expect(names(accrual), `${template.id} accrual ${name}`).toContain(name);
    }
    // Everything else is identical.
    expect(names(accrual).filter((name) => !accrualOnly.includes(name))).toEqual(names(cash));
  }
});

test("the online business add-on carries exactly the Stripe role keys, once each, on the right kinds of account", () => {
  const kinds: Record<string, string> = {
    "stripe.balance": "asset",
    "payouts.in-transit": "asset",
    "stripe.fees": "expense",
    refunds: "income",
    chargebacks: "expense",
    "tax.sales": "liability",
    "revenue.sales": "income",
  };
  expect([...STRIPE_ROLE_KEYS].sort()).toEqual(Object.keys(kinds).sort());
  for (const template of TEMPLATES)
    for (const basis of BASES) {
      const built = buildTemplate(template.id, {
        basis,
        taxYear: 2026,
        addOns: ["online-business"],
      });
      // The catch-all keys are on every template (see the next test); these are the add-on's own.
      const keyed = built.accounts.filter(
        (account) => account.tags.roleKey && !account.tags.roleKey.startsWith("catchall."),
      );
      expect(
        keyed.map((account) => account.tags.roleKey).sort(),
        `${template.id} ${basis}`,
      ).toEqual(Object.keys(kinds).sort());
      for (const account of keyed)
        expect(String(account.role), `${template.id} ${account.tags.roleKey}`).toBe(
          kinds[account.tags.roleKey as string] ?? "",
        );
      // Stripe's balance and payouts in transit are cash: the cash-flow statement ties to them.
      for (const key of ["stripe.balance", "payouts.in-transit"])
        expect(
          built.accounts.find((account) => account.tags.roleKey === key)?.tags.cashFlowClass,
          `${template.id} ${key}`,
        ).toBe("cash");
      // Without the add-on there are no Stripe role keys at all.
      expect(
        buildTemplate(template.id, { basis, taxYear: 2026 }).accounts.filter(
          (account) => account.tags.roleKey && !account.tags.roleKey.startsWith("catchall."),
        ),
      ).toEqual([]);
    }
  expect(ADD_ONS.map((addOn) => addOn.id)).toEqual(["online-business"]);
});

test("every template marks one catch-all account for expenses and one for income, on the right kinds of account, with or without the add-on", () => {
  // Where each template keeps its catch-all: the entity's own form names it (Form 1120-S and Form 1065
  // call it Other deductions).
  const expenseNames: Record<string, [string, string]> = {
    "sole-proprietor": ["6290", "Other expenses"],
    "s-corporation": ["6299", "Other deductions"],
    partnership: ["6299", "Other deductions"],
    generic: ["6290", "Other expenses"],
  };
  for (const template of TEMPLATES)
    for (const basis of BASES)
      for (const addOns of [[], ["online-business"]]) {
        const built = buildTemplate(template.id, { basis, taxYear: 2026, addOns });
        const holders = (key: string) =>
          built.accounts.filter((account) => account.tags.roleKey === key);
        const where = `${template.id} ${basis} ${addOns.join(",")}`;
        const [expense] = holders(CATCHALL_EXPENSE);
        const [income] = holders(CATCHALL_INCOME);
        expect(holders(CATCHALL_EXPENSE), where).toHaveLength(1);
        expect(holders(CATCHALL_INCOME), where).toHaveLength(1);
        expect([expense?.code, expense?.name], where).toEqual(
          expenseNames[template.id] as [string, string],
        );
        expect(expense?.role, where).toBe("expense");
        expect([income?.code, income?.name, income?.role], where).toEqual([
          "4900",
          "Other income",
          "income",
        ]);
        // Each says what it is for, in a sentence.
        expect(expense?.note, where).toContain("nowhere else");
        expect(income?.note, where).toContain("nowhere else");
      }
  // A catch-all key is only for the right kind of account.
  expect(tagProblem("asset", "roleKey", CATCHALL_EXPENSE)?.message).toContain(
    "marks an expense account; this is an asset account",
  );
  expect(tagProblem("expense", "roleKey", CATCHALL_INCOME)?.message).toContain(
    "marks an income account; this is an expense account",
  );
  expect(tagProblem("expense", "roleKey", CATCHALL_EXPENSE)).toBeNull();
  expect(tagProblem("income", "roleKey", CATCHALL_INCOME)).toBeNull();
  // Other keys are still any account's to hold.
  expect(tagProblem("asset", "roleKey", "stripe.balance")).toBeNull();
});

test("the online Schedule C chart is the founder-ready one: cost of goods, Stripe, owner money, your own banks and cards", () => {
  const built = buildTemplate("sole-proprietor", {
    basis: "cash",
    taxYear: 2026,
    addOns: ["online-business"],
  });
  const names = built.accounts.map((account) => account.name);
  for (const name of [
    "Cost of goods sold: Purchases",
    "Stripe balance",
    "Stripe payouts in transit",
    "Stripe fees",
    "Returns and allowances",
    "Chargebacks and disputes",
    "Sales tax payable",
    "Owner's investment",
    "Owner's draw",
  ])
    expect(names).toContain(name);
  // A template carries no bank or card account: those are the person's own, made from what they bring and
  // named by the bank (ruling of 2026-11-05). The 1000s and 2000s are left free for them.
  expect(built.accounts.filter((account) => account.tags.kind !== undefined)).toEqual([]);
  expect(built.accounts.filter((account) => /^(10|20)[0-9]{2}$/.test(account.code))).toEqual([]);
  expect(names).not.toContain("Business checking");
  expect(names).not.toContain("Business credit card");
  expect(built.disclaimer).toContain("not tax advice");
  expect(built.taxYear).toBe(2026);
  expect(built.taxForms[0]?.status).toBe("draft");
});

test("the generic chart has no tax lines and no disclaimer to carry", () => {
  const built = buildTemplate("generic", { basis: "cash", taxYear: 2026 });
  expect(built.taxForms).toEqual([]);
  expect(built.taxYear).toBeNull();
  expect(built.disclaimer).toBe("");
  expect(built.accounts.some((account) => account.tags.taxLine)).toBe(false);
});

test("a template that is wrong never reaches a book", () => {
  expect(() => buildTemplate("nope", { basis: "cash", taxYear: 2026 })).toThrow(/Unknown template/);
  expect(() =>
    buildTemplate("generic", { basis: "cash", taxYear: 2026, addOns: ["nope"] }),
  ).toThrow(/Unknown add-on/);
});

/** The slice contract: names, permissions and the pre-setup list. */
test("catalog operations are reads that work before setup, and nothing else does", async () => {
  const chart = sliceSchemas.find((slice) => slice.name === "chart");
  const before = chart?.readsBeforeSetup ?? [];
  expect([...before].sort()).toEqual(["taxLines.list", "templates.get", "templates.list"]);
  for (const slice of sliceSchemas)
    for (const name of slice.readsBeforeSetup ?? []) {
      const operation = slice.operations.find((item) => item.name === name);
      expect(operation, `${slice.name} lists ${name}`).toBeDefined();
      expect(operation?.writes, `${name} must be a read`).toBe(false);
      expect(operation?.permission).toBe("read");
    }
  for (const name of ["templates.get", "templates.list", "taxLines.list"])
    expect(operationCatalog.some((item) => item.name === name)).toBe(true);
  for (const name of ["TemplateDetail", "TemplateAccount", "TaxFormInfo", "TaxLineInfo"])
    expect(Object.hasOwn(definitions, name)).toBe(true);
  const f = await chartFixture();
  // No book yet: catalogs answer, everything else says the book is not configured.
  expect((await f.call("templates.list")).status).toBe(200);
  expect((await f.call("taxLines.list", {})).status).toBe(200);
  const refused = await f.call("accounts.list");
  expect(refused.status).toBe(409);
  expect(refused.body.error.code).toBe("book_not_configured");
  expect((await f.call("accounts.tagHistory", { accountId: "1000" })).body.error.code).toBe(
    "book_not_configured",
  );
});

test("templates.list names every template and add-on and the years the catalog covers", async () => {
  const f = await chartFixture();
  const { status, body } = await f.call("templates.list");
  expect(status).toBe(200);
  expect(body.data.templates.map((item: { id: string }) => item.id)).toEqual([
    "sole-proprietor",
    "s-corporation",
    "partnership",
    "generic",
  ]);
  expect(body.data.templates[0]).toMatchObject({
    entity: "soleProprietor",
    taxForm: "scheduleC",
    taxFormName: "Schedule C",
  });
  expect(body.data.templates[3].taxForm).toBeUndefined();
  expect(body.data.addOns.map((item: { id: string }) => item.id)).toEqual(["online-business"]);
  expect(body.data.taxYears).toEqual([2025, 2026]);
  expect(body.data.latestTaxYear).toBe(2026);
  expect(body.data.disclaimer).toContain("not tax advice");
});

test("templates.get returns a chart that book.setup accepts as given, apart from the notes", async () => {
  const f = await chartFixture();
  const got = await f.call("templates.get", {
    templateId: "sole-proprietor",
    basis: "accrual",
    taxYear: 2026,
    addOns: ["online-business"],
  });
  expect(got.status).toBe(200);
  const detail = got.body.data;
  expect(detail).toMatchObject({ id: "sole-proprietor", basis: "accrual", taxYear: 2026 });
  expect(detail.addOns).toEqual(["online-business"]);
  expect(detail.taxForms[0]).toMatchObject({ id: "scheduleC", taxYear: 2026, status: "draft" });
  expect(detail.taxForms[0].sources[0].url).toMatch(/^https:\/\/www\.irs\.gov\//);
  const accounts = detail.accounts.map(
    ({ code, name, role, parentCode, tags }: Record<string, unknown>) => ({
      code,
      name,
      role,
      ...(parentCode ? { parentCode } : {}),
      tags,
    }),
  );
  const setup = await f.call(
    "book.setup",
    {
      name: "Template Co",
      currency: "USD",
      fiscalYear: 2026,
      periodModel: "monthly",
      basis: "accrual",
      accounts,
    },
    uuid(),
  );
  expect(setup.status, JSON.stringify(setup.body.error)).toBe(200);
  const list = (await f.call("accounts.list")).body.data;
  expect(list.accounts).toHaveLength(accounts.length);
  const stripe = list.accounts.find((account: { code: string }) => account.code === "1100");
  expect(stripe.tags).toEqual({ cashFlowClass: "cash", roleKey: "stripe.balance" });
  const advertising = list.accounts.find((account: { code: string }) => account.code === "6000");
  expect(advertising.tags).toEqual({ taxLine: "scheduleC.line8" });
});

test("templates.get defaults to a cash book on the latest tax year, and says plainly what it cannot do", async () => {
  const f = await chartFixture();
  const plain = (await f.call("templates.get", { templateId: "sole-proprietor" })).body.data;
  expect(plain).toMatchObject({ basis: "cash", taxYear: 2026, addOns: [] });
  expect(plain.accounts.map((account: { name: string }) => account.name)).not.toContain(
    "Accounts receivable",
  );
  const refusals = [
    [{ templateId: "nope" }, 404, "template_not_found"],
    [{ templateId: "generic", addOns: ["nope"] }, 400, "add_on_not_found"],
    [{ templateId: "generic", taxYear: 2024 }, 400, "tax_year_unsupported"],
    [{ templateId: "generic", basis: "other" }, 400, "invalid_input"],
    [{ templateId: "generic", taxYear: "2026" }, 400, "invalid_input"],
  ] as const;
  for (const [input, status, code] of refusals) {
    const refused = await f.call("templates.get", input);
    expect(
      { status: refused.status, code: refused.body.error.code },
      JSON.stringify(input),
    ).toEqual({
      status,
      code,
    });
  }
  const year = (await f.call("templates.get", { templateId: "generic", taxYear: 2024 })).body.error;
  expect(year.message).toContain("2025 and 2026");
  // Repeating an add-on is the same as naming it once.
  const twice = (
    await f.call("templates.get", {
      templateId: "generic",
      addOns: ["online-business", "online-business"],
    })
  ).body.data;
  expect(twice.addOns).toEqual(["online-business"]);
});

test("taxLines.list serves the verified catalog for a year, and one form on request", async () => {
  const f = await chartFixture();
  const all = (await f.call("taxLines.list", { taxYear: 2025 })).body.data;
  expect(all).toMatchObject({ taxYear: 2025, taxYears: [2025, 2026] });
  expect(all.forms.map((form: { id: string }) => form.id)).toEqual([
    "scheduleC",
    "form1120S",
    "form1065",
    "form1125A",
  ]);
  const interest = (year: number) =>
    f
      .call("taxLines.list", { taxYear: year, form: "scheduleC" })
      .then(
        (result) =>
          result.body.data.forms[0].lines.find((line: { number: string }) => line.number === "16b")
            .label,
      );
  expect(await interest(2025)).toBe("Interest: Other");
  expect(await interest(2026)).toBe("Interest: Vehicle loan");
  const latest = (await f.call("taxLines.list", {})).body.data;
  expect(latest.taxYear).toBe(2026);
  expect(latest.forms[0].status).toBe("draft");
  expect((await f.call("taxLines.list", { taxYear: 2019 })).body.error.code).toBe(
    "tax_year_unsupported",
  );
  expect((await f.call("taxLines.list", { form: "scheduleF" })).body.error.code).toBe(
    "invalid_input",
  );
  expect(latest.disclaimer).toContain("not tax advice");
});

test("catalog reads need only the read permission", async () => {
  const f = await chartFixture();
  for (const name of ["templates.list", "taxLines.list"])
    expect((await f.call(name, {}, undefined, ["read"])).status, name).toBe(200);
  expect(
    (await f.call("templates.get", { templateId: "generic" }, undefined, ["read"])).status,
  ).toBe(200);
  expect((await f.call("templates.list", {}, undefined, ["draft"])).status).toBe(403);
});

test("every template, basis and add-on sets up a real book and stays in balance through the everyday entries", async () => {
  // Cash books compile reports only once the reports lane lifts the accrual-only guard; probe it,
  // and run the cash variants as soon as it is lifted (this test then needs no change).
  const probe = await chartFixture();
  await probe.call(
    "book.setup",
    {
      name: "Probe Co",
      currency: "USD",
      fiscalYear: 2026,
      periodModel: "monthly",
      basis: "cash",
      accounts: [
        { code: "1000", name: "Cash", role: "asset" },
        { code: "3000", name: "Capital", role: "equity" },
      ],
    },
    uuid(),
  );
  const cashReports = (await probe.call("reports.get", { asOf: "2026-01-31" })).status === 200;
  const everyday = async (
    f: Awaited<ReturnType<typeof chartFixture>>,
    built: BuiltTemplate,
  ): Promise<void> => {
    const idOf = (name: string) => built.accounts.find((account) => account.name === name)?.code;
    const equity = built.accounts.find((account) =>
      /^(owner'?s investment|partners' capital contributions|common stock|owner'?s equity)/i.test(
        account.name,
      ),
    )?.code;
    const draw = built.accounts.find((account) =>
      /(draw|distributions)$/i.test(account.name),
    )?.code;
    const expenseAccount = built.accounts.find(
      (account) => account.role === "expense" && /office|supplies/i.test(account.name),
    )?.code;
    const entries = [
      {
        ref: "INVEST",
        lines: [
          ["1000", "5000.00", ""],
          [equity, "", "5000.00"],
        ],
      },
      {
        ref: "SALE",
        lines: [
          ["1000", "1200.00", ""],
          [idOf("Sales"), "", "1200.00"],
        ],
      },
      {
        ref: "REFUND",
        lines: [
          [idOf("Returns and allowances"), "100.00", ""],
          ["1000", "", "100.00"],
        ],
      },
      {
        ref: "SUPPLIES",
        lines: [
          [expenseAccount, "250.00", ""],
          ["1000", "", "250.00"],
        ],
      },
      {
        ref: "DRAW",
        lines: [
          [draw, "300.00", ""],
          ["1000", "", "300.00"],
        ],
      },
    ];
    for (const entry of entries) {
      const data = {
        date: "2026-03-15",
        reference: entry.ref,
        narration: entry.ref,
        lines: entry.lines.map(([accountId, debit, credit]) => ({ accountId, debit, credit })),
      };
      const draft = await f.call("drafts.create", { data }, uuid());
      expect(draft.status, `${built.id} ${entry.ref}: ${JSON.stringify(draft.body.error)}`).toBe(
        200,
      );
      const plan = (
        await f.call("journal.prepare", { draftId: draft.body.data.id, expectedVersion: 1 }, uuid())
      ).body.data;
      expect(plan.valid, `${built.id} ${entry.ref}: ${JSON.stringify(plan.problems)}`).toBe(true);
      const receipt = await f.call("operations.commit", {
        planId: plan.planId,
        planHash: plan.planHash,
      });
      expect(receipt.body.data.disposition, `${built.id} ${entry.ref}`).toBe("committed");
    }
    const report = (await f.call("reports.get", { asOf: "2026-03-31" })).body.data;
    expect(report.trialBalance.balanced).toBe(true);
    expect(report.trialBalance.debit).toBe(report.trialBalance.credit);
    // 5000 invested + 1200 sales - 100 refund - 250 supplies - 300 draw
    expect(report.balanceSheet.assets).toBe("5550.00");
    expect(report.profitAndLoss.netIncome).toBe("850.00");
    expect(report.balanceSheet.balanced).toBe(true);
  };
  const chosen = combinations.filter(
    (item) =>
      item.taxYear === 2026 &&
      (item.basis === "accrual" || cashReports) &&
      // One book per template and basis with and without the add-on keeps the run short.
      true,
  );
  for (const { built, label } of chosen) {
    const f = await chartFixture();
    const setup = await f.call(
      "book.setup",
      {
        name: "Everyday Co",
        currency: "USD",
        fiscalYear: 2026,
        periodModel: "monthly",
        basis: built.basis,
        accounts: [
          // The person's bank account, as a first statement import or bank connection would make it.
          {
            code: "1000",
            name: "Checking",
            role: "asset",
            tags: { cashFlowClass: "cash", kind: "bank" },
          },
          ...built.accounts.map(({ code, name, role, parentCode, tags }) => ({
            code,
            name,
            role,
            ...(parentCode ? { parentCode } : {}),
            tags,
          })),
        ],
      },
      uuid(),
    );
    expect(setup.status, `${label}: ${JSON.stringify(setup.body.error)}`).toBe(200);
    await everyday(f, built);
    // The tags came through setup intact.
    const list = (await f.call("accounts.list")).body.data.accounts as {
      code: string;
      tags: object;
    }[];
    for (const account of built.accounts)
      expect(
        list.find((item) => item.code === account.code)?.tags,
        `${label} ${account.code}`,
      ).toEqual(account.tags);
    f.service.close();
  }
}, 120_000);

test("no template carries a real person's, bank's or business's name", () => {
  const text = JSON.stringify(
    combinations.map(({ built }) => [built.name, built.description, built.notes, built.accounts]),
  );
  const found = [
    /\bmercury\b/i,
    /\bchase\b/i,
    /\bwells fargo\b/i,
    /\bbank of america\b/i,
    /\bamex\b/i,
    /\bamerican express\b/i,
    /\bcapital one\b/i,
    /\bcitibank\b/i,
  ].filter((pattern) => pattern.test(text));
  expect(found).toEqual([]);
});

test("http boundary: the pre-setup list cannot be used to reach a write", async () => {
  const f = await chartFixture();
  const http = new ApplicationHttp(f.service, {
    bookId: f.service.bookId,
    permissions: BUSINESS_PERMISSIONS,
  });
  const response = await http.fetch(
    new Request("http://127.0.0.1:4010/v1/accounts.setTags", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: "rastrata-application-v1",
        bookId: "local-book",
        operationId: uuid(),
        input: { accountId: "1000", effectiveOn: "2026-01-01", tags: { cashFlowClass: "cash" } },
      }),
    }),
  );
  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe("book_not_configured");
});
