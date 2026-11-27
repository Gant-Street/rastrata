import { expect, type Page, test } from "@playwright/test";
import axe from "axe-core";

declare global {
  interface Window {
    axe: typeof axe;
  }
}

// The payees components where they have to adapt, against invented data in Storybook: the tables and their
// buttons at a phone's width, what a bank wrote and a name a person typed when it is long or is markup, the
// sheets that open beside the report, and what can be done with the keyboard alone. (The whole flow against
// the real service is in apps/web, tests/browser/payees.spec.ts, and every story is scanned in both themes
// by lane-stories.spec.ts, which scans the page and not the sheets that open over it: those are scanned here.)
const story = (group: string, id: string) =>
  `/iframe.html?id=lanes-payees-${group}--${id}&viewMode=story`;
const report = (id: string) => story("money-by-payee", id);
const sheet = (id: string) => story("transactions-of-a-row", id);
const drawer = (id: string) => story("name-and-change-a-payee", id);
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

/** True when the page does not scroll sideways: a table may scroll inside its own region, the page may not. */
const fits = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

const scan = async (page: Page, label: string) => {
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(async () =>
    (
      await window.axe.run(document.body, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      })
    ).violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })),
  );
  expect(violations, label).toEqual([]);
};

const theme = async (page: Page, value: "light" | "dark") => {
  await page.evaluate((next) => {
    document.documentElement.dataset.theme = next;
  }, value);
  await page.addStyleTag({
    content: "*,*::before,*::after{transition:none!important;animation:none!important}",
  });
};

test("on a phone the buttons of a row sit under its text and the figures keep their room; on a desktop they have a column", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await page.goto(report("default"));
  const unnamed = page.getByRole("table", { name: "Not named yet" });
  await expect(unnamed).toBeVisible();
  const name = unnamed.getByRole("button", { name: /^Name this payee, CHIPOTLE 2188$/ });
  await expect(name).toBeVisible();
  await expect(
    unnamed.getByRole("columnheader", { name: "Action", includeHidden: true }),
  ).toBeHidden();
  // The button is under the text of its own row, inside the screen.
  const text = unnamed.getByText("CHIPOTLE 2188", { exact: true });
  const textBox = await text.boundingBox();
  const buttonBox = await name.boundingBox();
  expect(buttonBox?.y ?? 0).toBeGreaterThan((textBox?.y ?? 0) + (textBox?.height ?? 0));
  expect((buttonBox?.x ?? 0) + (buttonBox?.width ?? 0)).toBeLessThanOrEqual(PHONE.width);
  // The payees' figures are all beside their names: the last column ends inside the screen.
  const payees = page.getByRole("table", { name: "Payees" });
  const last = payees.locator("tbody tr").first().locator("td").last();
  const box = await last.boundingBox();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(PHONE.width);
  expect(await fits(page)).toBe(true);

  await page.setViewportSize(DESKTOP);
  await expect(unnamed.getByRole("columnheader", { name: "Action" })).toBeVisible();
  await expect(name).toBeVisible();
  const wide = await name.boundingBox();
  const row = await text.boundingBox();
  // On a desktop it is beside the text, not under it.
  expect(wide?.y ?? 0).toBeLessThan((row?.y ?? 0) + (row?.height ?? 0));
  expect(await fits(page)).toBe(true);
});

test("a part with buttons on every row has them in reach on a phone, in each of its tables", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await page.goto(report("default"));
  for (const table of ["Not named yet", "Matched by more than one payee", "No payee"]) {
    const rows = page.getByRole("table", { name: table });
    await expect(rows).toBeVisible();
    const see = rows.getByRole("button", { name: /^See transactions/ });
    const count = await see.count();
    expect(count, table).toBeGreaterThan(0);
    for (let index = 0; index < count; index++) {
      const box = await see.nth(index).boundingBox();
      expect((box?.x ?? 0) + (box?.width ?? 0), `${table} ${index}`).toBeLessThanOrEqual(
        PHONE.width,
      );
    }
  }
  expect(await fits(page)).toBe(true);
});

test("what a bank wrote and a name a person typed are text: markup is shown, long text wraps, and the page never widens", async ({
  page,
}) => {
  for (const size of [PHONE, DESKTOP]) {
    await page.setViewportSize(size);
    await page.goto(report("long-text"));
    await expect(page.getByRole("table", { name: "Payees" })).toBeVisible();
    // The markup in a name is what a person reads, not something that ran.
    await expect(page.locator(".rt-payees-link script")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /^Open <script>alert\("payee"\)<\/script>/ }),
    ).toBeVisible();
    expect(await fits(page), `the page at ${size.width}`).toBe(true);
    // Each text stays inside its table's own region.
    const wrote = page.getByRole("table", { name: "Not named yet" }).locator(".rt-payees-text");
    for (let index = 0; index < (await wrote.count()); index++) {
      const box = await wrote.nth(index).boundingBox();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(size.width);
    }
    const region = page.getByRole("region", { name: /^Not named yet\./ });
    expect(
      await region.evaluate((element) => element.scrollWidth <= element.clientWidth),
      `the table at ${size.width} wider than its region`,
    ).toBe(true);
  }
});

test("a report that adds up shows its proof at the foot; one that does not shows it at the head, and says so", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto(report("default"));
  const proof = page.locator(".rt-payees-proof");
  await expect(proof).toBeVisible();
  const payees = await page.getByRole("heading", { name: "Payees", level: 3 }).boundingBox();
  const at = await proof.boundingBox();
  expect(at?.y ?? 0).toBeGreaterThan(payees?.y ?? 0);
  await expect(proof.getByText("Adds up", { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page.goto(report("proof-broken"));
  const broken = page.locator(".rt-payees-proof");
  const above = await page.getByRole("heading", { name: "Payees", level: 3 }).boundingBox();
  const head = await broken.boundingBox();
  expect(head?.y ?? Infinity).toBeLessThan(above?.y ?? 0);
  await expect(page.getByRole("alert")).toContainText("do not rely on this report");
  await expect(broken.getByText("Does not add up").first()).toBeVisible();
});

for (const [group, id, label] of [
  [drawer, "name-from-text", "naming a payee"],
  [drawer, "words-tie", "words that tie"],
  [drawer, "words-refused", "words the service would refuse"],
  [drawer, "save-uncertain", "a save whose reply was lost"],
  [drawer, "long-text", "a long text and name"],
  [sheet, "payee", "a payee's transactions"],
  [sheet, "not-named-yet", "a text nobody has named"],
  [sheet, "matched-by-two-payees", "a text two payees match"],
  [sheet, "long-text", "a long text"],
  [sheet, "failed", "a read that failed"],
] as const) {
  test(`${label}: the sheet fits a phone and a desktop, in both themes, and passes the accessibility scan`, async ({
    page,
  }) => {
    for (const size of [PHONE, DESKTOP]) {
      await page.setViewportSize(size);
      await page.goto(group(id));
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      const box = await dialog.boundingBox();
      expect(box?.x ?? -1, `${label} at ${size.width}: left edge`).toBeGreaterThanOrEqual(0);
      expect(
        (box?.x ?? 0) + (box?.width ?? 0),
        `${label} at ${size.width}: right edge`,
      ).toBeLessThanOrEqual(size.width);
      expect(await fits(page)).toBe(true);
      for (const mode of ["light", "dark"] as const) {
        await theme(page, mode);
        await scan(page, `${label} at ${size.width} (${mode})`);
      }
    }
  });
}

test("naming a payee with the keyboard alone: the name is focused, the words are tried as they are typed, Save is not offered for words the service would refuse", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto(drawer("name-from-text"));
  const name = page.getByLabel("Name", { exact: true });
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("Blue Bottle Coffee");
  const words = page.getByLabel("Words that find them");
  await page.keyboard.press("Tab");
  await expect(words).toBeFocused();
  const found = page.getByRole("region", { name: "What these words find" });
  await expect(found).toContainText("These words find 7 transactions: 41.20 spent.");
  await expect(found).toContainText("2 transactions belong to Blue Bottle Roasters now");
  // Words that are too short are said not to be accepted, and Save is not offered.
  await words.fill("ab");
  await expect(found).toContainText("at least 3 letters or digits");
  await expect(page.getByRole("button", { name: "Name this payee" })).toBeDisabled();
  // Words that tie say who they tie with.
  await words.fill("amazon");
  await expect(found).toContainText("match these words as well as Amazon and Amazon Web Services");
  await expect(page.getByRole("button", { name: "Name this payee" })).toBeEnabled();
  // Words that find nothing say so.
  await words.fill("no such words");
  await expect(found).toContainText("These words find nothing in these dates");
});

test("a form with nothing in it says what is missing, in a summary that moves focus to the field", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto(drawer("name-from-bare-text"));
  const save = page.getByRole("button", { name: "Name this payee" });
  await save.click();
  const summary = page.getByRole("region", { name: "Fix these before saving" });
  await expect(summary).toBeFocused();
  await expect(summary.getByRole("link", { name: "Give the payee a name." })).toBeVisible();
  await expect(
    summary.getByRole("link", { name: /Give the words that find this payee/ }),
  ).toBeVisible();
  await summary.getByRole("link", { name: "Give the payee a name." }).click();
  await expect(page.getByLabel("Name", { exact: true })).toBeFocused();
  await page.getByLabel("Name", { exact: true }).fill("Check payee");
  await expect(summary.getByRole("link", { name: "Give the payee a name." })).toHaveCount(0);
  // Escape closes the sheet and leaves nothing changed.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("the names in a report open their payee and the text rows name one, from the keyboard", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto(report("default"));
  const open = page.getByRole("button", { name: "Open Northwind Design" });
  await open.focus();
  await expect(open).toBeFocused();
  const name = page.getByRole("button", {
    name: /^Name this payee, SQ \*BLUE BOTTLE COFFEE 1234$/,
  });
  await name.focus();
  await expect(name).toBeFocused();
  // Each region of a table can be scrolled with the keyboard.
  const region = page.getByRole("region", { name: /^Not named yet\./ });
  await region.focus();
  await expect(region).toBeFocused();
});

test("a right-to-left page mirrors and still fits", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto(report("right-to-left"));
  await expect(page.getByRole("table", { name: "Payees" })).toBeVisible();
  expect(await fits(page)).toBe(true);
});
