import { expect, type APIRequestContext, type Page, test } from "@playwright/test";
import axe from "axe-core";
import { recordStartAndOpening } from "../support/opening-seed";
import { shown } from "../support/shown";

declare global {
  interface Window {
    axe: typeof axe;
  }
}

// The ratchet behind "work before explanation" (the UX program's rule 5) and "the surface shows no machine
// detail" (rule 4). Every route is opened at 1440 by 800 against a book that has something in it, and held
// to four rules:
//
//   1. the first control of the page is within 240 px of the rule under the header (a control that does
//      something with the page: the header's "How this works" and back link are not counted);
//   2. the first row of the page's table is on screen (a table that starts under the fold is a table nobody
//      sees);
//   3. no 64-character hash is visible text (it belongs under Details);
//   4. no year-month-day date is visible text (it reads "Mar 20, 2026"; the ISO form stays in `datetime`
//      and in tooltips). This rule applies once the language lane's D1 has landed.
//
// (Rules 5 to 8, the budget, are further down with their own list.)
//
// A route that does not meet them yet is on PENDING. The ratchet is strict in both directions: a route that
// is not on the list must pass, and a route that is on it must still fail, so a lane that fixes its screens
// has to take their routes off, and the list is empty when the program ends.
test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1440, height: 800 } });

const version = "rastrata-application-v1";
type Json = Awaited<ReturnType<Response["json"]>>;

async function api(request: APIRequestContext, name: string, input: unknown, operationId?: string) {
  const response = await request.post(`/v1/${name}`, {
    data: { version, bookId: "local-book", input, ...(operationId ? { operationId } : {}) },
  });
  const body = (await response.json()) as Json;
  expect(body.ok, `${name}: ${JSON.stringify(body.error)}`).toBe(true);
  return body.data as Json;
}

const setup = {
  name: "Willow Lane Studio",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  basis: "cash",
  accounts: [
    { code: "1000", name: "Business checking", role: "asset", tags: { cashFlowClass: "cash" } },
    { code: "1100", name: "Business savings", role: "asset", tags: { cashFlowClass: "cash" } },
    { code: "2000", name: "Business credit card", role: "liability" },
    { code: "3000", name: "Owner capital", role: "equity" },
    { code: "4000", name: "Sales", role: "income" },
    { code: "5000", name: "Software", role: "expense" },
    { code: "5100", name: "Meals", role: "expense" },
  ],
};
const mapping = {
  delimiter: ",",
  headerRow: 1,
  date: { header: "Date" },
  dateOrder: "ymd",
  amount: { kind: "signed", amount: { header: "Amount" } },
  description: [{ header: "Description" }],
  reference: { header: "Reference" },
};

async function post(
  request: APIRequestContext,
  date: string,
  narration: string,
  lines: [string, string, string][],
) {
  const draft = await api(
    request,
    "drafts.create",
    {
      data: {
        date,
        reference: narration.slice(0, 40),
        narration,
        lines: lines.map(([accountId, debit, credit]) => ({ accountId, debit, credit })),
      },
    },
    crypto.randomUUID(),
  );
  const planId = crypto.randomUUID();
  const plan = await api(
    request,
    "journal.prepare",
    { draftId: draft.id, expectedVersion: 1 },
    planId,
  );
  await api(request, "operations.commit", { planId, planHash: plan.planHash });
  return draft.id as string;
}

/** A routes the ratchet opens, and what a person should find on it. */
interface Guarded {
  readonly path: string | (() => string);
  /** Where the page's main table starts, when it has one with rows in this book. Left out, the first
   * table of the page that has rows is used (a visually hidden one, such as the text alternative of a
   * chart, is a table for a screen reader and is not counted). */
  readonly rows?: string;
}

let entryPath = "/journal";
const ROUTES: readonly Guarded[] = [
  { path: "/" },
  { path: "/inbox" },
  { path: "/import" },
  { path: "/reconcile" },
  { path: "/rules" },
  { path: "/rules/new" },
  { path: "/journal" },
  { path: "/journal/new" },
  { path: () => entryPath },
  { path: "/accounts" },
  { path: "/periods" },
  { path: "/changes" },
  { path: "/reports" },
  { path: "/reports?tab=profit-loss" },
  { path: "/reports?tab=general-ledger" },
  { path: "/reports/payees" },
  { path: "/tax" },
  { path: "/tax?tab=pack" },
  { path: "/tax?tab=vendors" },
  { path: "/tax?tab=sales" },
  { path: "/tax?tab=accountant" },
  { path: "/settings" },
  { path: "/settings/members" },
  { path: "/settings/workspace" },
  { path: "/opening" },
  { path: "/settings/connections" },
  { path: "/settings/backups" },
  { path: "/settings/agent" },
  { path: "/settings/bring-in" },
  { path: "/settings/history" },
  { path: "/settings/move" },
  { path: "/xero" },
  { path: "/tie-out" },
  { path: "/gaps" },
  { path: "/settings/stripe" },
  { path: "/settings/bankfeed" },
  { path: "/help" },
];

/** Routes that do not meet the rules yet. A lane takes its routes off when its screens do. (It has been
 * empty since step 7 of docs/reference/ux-simplify-plan.md cut Money by payee.) */
const PENDING = new Set<string>([]);

/** Routes that are over the budget (rules 5 to 8, below). Whoever cuts a page takes its route off. */
const OVER_BUDGET = new Set<string>([
  // An installed copy's own pages.
  "/settings/backups",
  "/settings/stripe",
  "/settings/bankfeed",
]);

test.beforeAll(async ({ request }) => {
  test.setTimeout(120_000);
  await api(request, "book.setup", setup, crypto.randomUUID());
  const accounts = (await api(request, "accounts.list", {})).accounts as {
    id: string;
    code: string;
  }[];
  const id = (code: string) =>
    (accounts.find((account) => account.code === code) as { id: string }).id;
  entryPath = `/journal/${await post(request, "2026-03-01", "Owner opening deposit", [
    [id("1000"), "5000.00", "0.00"],
    [id("3000"), "0.00", "5000.00"],
  ])}`;
  await post(request, "2026-03-05", "Design fee, Northwind", [
    [id("1000"), "1200.00", "0.00"],
    [id("4000"), "0.00", "1200.00"],
  ]);
  await post(request, "2026-03-09", "GitHub, March", [
    [id("5000"), "44.00", "0.00"],
    [id("1000"), "0.00", "44.00"],
  ]);
  // A statement in the Inbox, so For review and Reconcile have rows.
  const csv = [
    "Date,Description,Amount,Reference",
    "2026-03-10,NOTION LABS,-25.00,",
    "2026-03-11,CHIPOTLE 1234,-18.45,",
    "2026-03-12,STRIPE TRANSFER ST-7E69,498.75,",
    "2026-03-13,UNKNOWN MERCHANT 4821,-112.00,",
  ].join("\n");
  const upload = await request.post("/v1/uploads", {
    headers: { "content-type": "text/csv", "x-upload-name": "march.csv" },
    data: csv,
  });
  const receipt = (await upload.json()).data as { sha256: string };
  await api(
    request,
    "import.commit",
    { sha256: receipt.sha256, ledgerAccountId: id("1000"), mapping },
    crypto.randomUUID(),
  );
  // A recorded start date and a posted opening entry, so the screens that need them are scanned too.
  await recordStartAndOpening(
    (name, input, operationId) => api(request, name, input, operationId),
    {
      checking: id("1000"),
      savings: id("1100"),
      card: id("2000"),
      capital: id("3000"),
    },
  );
});

/** What a person would say is wrong with the page as it opens, or an empty list. */
async function problems(page: Page, rows: string | undefined): Promise<string[]> {
  const found = await page.evaluate((rowSelector) => {
    const header = document.querySelector("header.app-header");
    const rule = header ? header.getBoundingClientRect().bottom : 0;
    const main = document.querySelector("main") as HTMLElement;
    const visible = (element: Element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.visibility !== "hidden";
    };
    // Work, not explanation or a way back: the header's "How this works" and its back link are not the
    // page's first control (they would make every page pass).
    const controls = [...main.querySelectorAll("a[href], button, input, select, textarea, summary")]
      .filter((control) => !control.matches(".rt-page-back, .rt-page-help > summary"))
      .filter(visible);
    const first = controls
      .map((control) => control.getBoundingClientRect().top)
      .sort((a, b) => a - b)[0];
    // The page's table is one a person can see: a row inside a closed disclosure (the classifier's
    // measurements under "If you only trusted the surest suggestions") has a box but is not shown, and a
    // table nobody sees first is no table at all for this rule.
    const seen = (element: Element) => element.checkVisibility({ contentVisibilityAuto: true });
    const row = rowSelector
      ? main.querySelector(rowSelector)
      : ([...main.querySelectorAll("table:not(.rt-sr-only) tbody tr")].find(seen) ?? null);
    const text = main.innerText;
    return {
      controlFromRule: first === undefined ? null : Math.round(first - rule),
      rowBottom: row ? Math.round(row.getBoundingClientRect().bottom) : null,
      viewport: window.innerHeight,
      hash: /\b[0-9a-f]{64}\b/i.test(text),
      isoDate: /\b\d{4}-\d{2}-\d{2}\b/.test(text),
    };
  }, rows);
  const out: string[] = [];
  // 240, not 220: Linux's fonts (the runners) wrap a line the Mac's do not, and Stripe's settings page measured 226 there.
  if (found.controlFromRule !== null && found.controlFromRule > 240)
    out.push(
      `the first control is ${found.controlFromRule} px under the header rule (at most 240)`,
    );
  if (found.rowBottom !== null && found.rowBottom > found.viewport)
    out.push(
      `the first table row ends at y = ${found.rowBottom}, under the fold (${found.viewport})`,
    );
  if (found.hash) out.push("a 64-character hash is visible text");
  // The date rule starts when D1 has landed: before it, `shown.date` is the ISO form itself.
  if (shown.date("2026-03-20") !== "2026-03-20" && found.isoDate)
    out.push("a year-month-day date is visible text");
  return out;
}

// The budget (step 7 of docs/reference/ux-simplify-plan.md, "So it stays simple"). A page as it opens:
//
//   5. says at most 40 words of instruction. Instruction is prose: what the page says to the person about
//      itself. A heading, a control's own label, a table, a list of facts (`dl`), a figure, a date, a command
//      to copy and anything inside `data-facts` (the book's own records set out as sentences, such as the
//      list of changes) is not instruction. What a closed fold holds is not on the page at rest;
//   6. has at most one main button;
//   7. has no "How this works": the Help link in the footer opens the how-to for the page;
//   8. has no section that is a heading and nothing else.
//
// A route that does not meet them yet is on OVER_BUDGET, with the same strictness as PENDING: a route on the
// list must still fail, so whoever cuts a page takes it off. RASTRATA_UX_MEASURE=1 prints what was counted.
const WORDS = 40;
async function budget(page: Page) {
  return page.evaluate(() => {
    const main = document.querySelector("main") as HTMLElement;
    const shown = (element: Element) => {
      const box = element.getBoundingClientRect();
      return (
        box.width > 0 &&
        box.height > 0 &&
        element.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true })
      );
    };
    const NOT_PROSE =
      "table, a, button, label, select, summary, legend, h1, h2, h3, h4, h5, h6, input, textarea, dl, code, pre, time, [role=tab], [role=option], [role=status][aria-live], .rt-sr-only, .rt-money, [data-facts], [aria-hidden=true]";
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    const prose: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || parent.closest(NOT_PROSE) || !shown(parent)) continue;
      const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text) prose.push(text);
    }
    const words = prose
      .join(" ")
      .split(" ")
      .filter((word) => /\p{L}/u.test(word));
    const primary = [...main.querySelectorAll('.rt-button[data-variant="primary"]')].filter(shown);
    const empty = [...main.querySelectorAll("section")]
      .filter(shown)
      .filter((section) => {
        const heading = section.querySelector("h2, h3");
        if (!heading) return false;
        const rest = (section as HTMLElement).innerText.replace(
          (heading as HTMLElement).innerText,
          "",
        );
        return rest.trim() === "";
      })
      .map((section) => (section.querySelector("h2, h3") as HTMLElement).innerText);
    return {
      words: words.length,
      prose: prose.join(" | "),
      primary: primary.map((button) => (button as HTMLElement).innerText.trim()),
      help: main.querySelectorAll(".rt-page-help").length,
      empty,
    };
  });
}

async function overBudget(page: Page, key: string): Promise<string[]> {
  const found = await budget(page);
  if (process.env.RASTRATA_UX_MEASURE)
    console.log(
      `BUDGET ${key} words=${found.words} main=${JSON.stringify(found.primary)} help=${found.help}\n   ${found.prose}`,
    );
  const out: string[] = [];
  if (found.words > WORDS)
    out.push(
      `${found.words} words of instruction (at most ${WORDS}): ${found.prose.slice(0, 300)}`,
    );
  if (found.primary.length > 1)
    out.push(`${found.primary.length} main buttons (at most one): ${found.primary.join(", ")}`);
  if (found.help > 0) out.push('"How this works" is on the page');
  for (const heading of found.empty) out.push(`the section "${heading}" has nothing in it`);
  return out;
}

test("every route meets the rules, or is on PENDING and still fails them", async ({ page }) => {
  test.setTimeout(240_000);
  const opened = new Set<string>();
  for (const route of ROUTES) {
    const path = typeof route.path === "string" ? route.path : route.path();
    const key = typeof route.path === "string" ? route.path : "/journal/$entryId";
    opened.add(key);
    await test.step(key, async () => {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      await page.waitForLoadState("networkidle");
      const found = await problems(page, route.rows);
      if (PENDING.has(key))
        expect
          .soft(
            found.length,
            `${key} now meets the rules: take it off PENDING in ux-guards.spec.ts`,
          )
          .toBeGreaterThan(0);
      else expect.soft(found, key).toEqual([]);
      const over = await overBudget(page, key);
      if (OVER_BUDGET.has(key))
        expect
          .soft(
            over.length,
            `${key} is now within the budget: take it off OVER_BUDGET in ux-guards.spec.ts`,
          )
          .toBeGreaterThan(0);
      else expect.soft(over, `${key}, the budget`).toEqual([]);
    });
  }
  expect
    .soft(
      [...OVER_BUDGET].filter((path) => !opened.has(path)),
      "OVER_BUDGET names routes this spec does not open",
    )
    .toEqual([]);
  // A name on PENDING that the ratchet never opens is a typo, and would stay on the list for ever.
  expect
    .soft(
      [...PENDING].filter((path) => !opened.has(path)),
      "PENDING names routes this spec does not open",
    )
    .toEqual([]);
});

// What only a browser can measure, for every screen: since 2026-10-29 the screens' behaviour (and the scan's rules that
// need no layout) is tested on happy-dom (tests/dom), and the layout is held here once for all of them. At a desktop's
// width and a phone's, in both themes, a page never scrolls sideways and the whole accessibility scan, colour contrast
// with it, finds nothing.
for (const [width, height] of [
  [1440, 800],
  [390, 844],
] as const)
  for (const scheme of ["light", "dark"] as const)
    test(`every route fits ${width} px and passes the whole accessibility scan, ${scheme}`, async ({
      page,
    }) => {
      test.setTimeout(240_000);
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: scheme });
      // A scan must not sample colours in the middle of a transition.
      await page.addInitScript(() => {
        const style = document.createElement("style");
        style.textContent =
          "*,*::before,*::after{transition:none!important;animation:none!important}";
        document.addEventListener("DOMContentLoaded", () => document.head.append(style));
      });
      for (const route of ROUTES) {
        const path = typeof route.path === "string" ? route.path : route.path();
        const key = typeof route.path === "string" ? route.path : "/journal/$entryId";
        await test.step(key, async () => {
          await page.goto(path);
          await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
          await page.waitForLoadState("networkidle");
          const fits = await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          );
          expect.soft(fits, `${key} scrolls sideways at ${width} px, ${scheme}`).toBe(true);
          await page.addScriptTag({ content: axe.source });
          const violations = await page.evaluate(async () =>
            (
              await window.axe.run(document.body, {
                runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
              })
            ).violations.map(({ id, nodes }) => ({
              id,
              targets: nodes.map((node) => node.target),
            })),
          );
          expect.soft(violations, `${key} at ${width} px, ${scheme}`).toEqual([]);
        });
      }
    });
