import { expect, test } from "@playwright/test";

// The header and the section tabs against fictional destinations in Storybook. (Every story is scanned in
// both themes by lane-stories.spec.ts; the real header in the application is in apps/web,
// tests/browser/smoke.spec.ts, in three browsers.)
const story = (id: string) => `/iframe.html?id=lanes-uxshell-appnav--${id}&viewMode=story`;

test("the bar lists the four places, then Search, New and Settings, and marks where you are", async ({
  page,
}) => {
  await page.goto(story("transactions"));
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  // What waits for review is said once, beside the place's name.
  await expect(nav.locator(".rt-appnav-bar > li > a")).toHaveText([
    "Home",
    "Transactions 8",
    "Accounts",
    "Reports",
  ]);
  // On the page the section opens, the section is the page.
  await expect(nav.getByRole("link", { name: /^Transactions/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(nav.getByRole("button", { name: "Search", exact: true })).toBeVisible();
  await expect(nav.getByRole("button", { name: "New", exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  // Under the header: the section's pages as tabs. The first carries no number: the bar has it.
  const tabs = page.getByRole("navigation", { name: "Transactions pages" });
  await expect(tabs.getByRole("link")).toHaveText(["For review", "All transactions", "Rules"]);
  await expect(tabs.getByRole("link", { name: "For review" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  // Choosing another tab moves the page, the section stays marked (as the page it holds, not its landing).
  await tabs.getByRole("link", { name: "Rules" }).click();
  await expect(tabs.getByRole("link", { name: "Rules" })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: /^Transactions/ })).toHaveAttribute(
    "aria-current",
    "true",
  );
  // The name of the book sits beside the wordmark.
  await expect(page.getByText("Willow Lane Studio", { exact: true })).toBeVisible();
});

test("a detail page keeps the tab it sits under marked, and Home has no row of tabs", async ({
  page,
}) => {
  await page.goto(story("detail-page"));
  const tabs = page.getByRole("navigation", { name: "Transactions pages" });
  await expect(tabs.getByRole("link", { name: "Rules" })).toHaveAttribute("aria-current", "true");
  await page.goto(story("home"));
  await expect(page.getByRole("navigation", { name: /pages$/ })).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", {
      name: "Home",
      exact: true,
    }),
  ).toHaveAttribute("aria-current", "page");
});

test("+ New is a menu: one short list of what can be started, and the keyboard works it", async ({
  page,
}) => {
  await page.goto(story("transactions"));
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  const create = nav.getByRole("button", { name: "New", exact: true });
  const item = (name: string) => nav.getByRole("menuitem", { name, exact: true });
  await expect(create).toHaveAttribute("aria-expanded", "false");
  await expect(item("Journal entry")).toBeHidden();
  await create.click();
  await expect(create).toHaveAttribute("aria-expanded", "true");
  const panel = nav.getByRole("menu", { name: "New" });
  await expect(panel.getByRole("menuitem")).toHaveText(["Transaction", "Journal entry", "Account"]);
  // A destination is still a link, so it opens in a new tab when asked to; a dialog is not.
  await expect(item("Journal entry")).toHaveAttribute("href", /journal\/new$/);
  await expect(item("Account")).toHaveAttribute("href", /.+/);
  await expect(item("Transaction")).not.toHaveAttribute("href");
  await page.keyboard.press("Escape");
  await expect(create).toHaveAttribute("aria-expanded", "false");
  await expect(create).toBeFocused();

  // From the keyboard: the Down arrow opens it on the first thing; the arrows, Home and End move (the
  // arrows go round at the ends); Escape closes it and returns to the button.
  const on = (name: string) => expect(item(name)).toHaveAttribute("data-highlighted", "");
  await page.keyboard.press("ArrowDown");
  await expect(create).toHaveAttribute("aria-expanded", "true");
  // The keys go to the list once it has focus.
  await expect(panel).toBeFocused();
  await on("Transaction");
  await page.keyboard.press("ArrowDown");
  await on("Journal entry");
  await page.keyboard.press("End");
  await on("Account");
  await page.keyboard.press("ArrowDown");
  await on("Transaction");
  await page.keyboard.press("ArrowUp");
  await on("Account");
  await page.keyboard.press("Home");
  await on("Transaction");
  await page.keyboard.press("Escape");
  await expect(create).toHaveAttribute("aria-expanded", "false");
  await expect(create).toBeFocused();
});

test("with no actions there is no New button", async ({ page }) => {
  await page.goto(story("no-actions"));
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", {
      name: "New",
      exact: true,
    }),
  ).toHaveCount(0);
});

test("pressing elsewhere closes the open menu, and so does choosing from it", async ({ page }) => {
  await page.goto(story("new-open"));
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  const create = nav.getByRole("button", { name: "New", exact: true });
  await expect(create).toHaveAttribute("aria-expanded", "true");
  await page.getByText("The page. Choosing a link above").click();
  await expect(create).toHaveAttribute("aria-expanded", "false");
  await create.click();
  await expect(create).toHaveAttribute("aria-expanded", "true");
  await nav.getByRole("menuitem", { name: "Transaction", exact: true }).click();
  await expect(create).toHaveAttribute("aria-expanded", "false");
});

test("a phone gets one Menu button holding Search, every place and New, and Escape closes it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(story("transactions"));
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await expect(nav.getByRole("link", { name: "Home", exact: true })).toBeHidden();
  const menu = nav.getByRole("button", { name: "Menu" });
  await expect(menu).toBeVisible();
  await menu.click();
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  for (const name of ["Home", "Accounts", "Reports", "Settings"])
    await expect(nav.getByRole("link", { name, exact: true })).toBeVisible();
  // The number waiting for review is in the list, beside Transactions.
  await expect(nav.getByRole("link", { name: "Transactions 8", exact: true })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Search", exact: true })).toBeVisible();
  for (const name of ["Journal entry", "Account"])
    await expect(nav.getByRole("link", { name, exact: true })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Transaction", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(menu).toBeFocused();
  // The page does not scroll sideways, and the name of the book is still there.
  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
  expect(fits).toBe(true);
  await expect(page.getByText("Willow Lane Studio", { exact: true })).toBeVisible();
});

test("a book name too long for the header is cut with an ellipsis and keeps its full text", async ({
  page,
}) => {
  await page.goto(story("long-book-name"));
  const name = page.locator(".app-book-name");
  await expect(name).toHaveCSS("text-overflow", "ellipsis");
  await expect(name).toHaveAttribute("title", /Extraordinarily Long-Named/);
  const clipped = await name.evaluate((element) => element.scrollWidth > element.clientWidth);
  expect(clipped).toBe(true);
  // The count of a long list is still a figure beside the place's name.
  await expect(
    page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: /^Transactions 128/ }),
  ).toBeVisible();
});

test("before a book exists the header is only the wordmark", async ({ page }) => {
  await page.goto(story("before-a-book"));
  await expect(page.getByRole("link", { name: "Rastrata" })).toBeVisible();
  await expect(page.getByRole("navigation")).toHaveCount(0);
});

test("the tabs scroll sideways in a narrow window instead of wrapping", async ({ page }) => {
  await page.goto("/iframe.html?id=lanes-uxshell-sectiontabs--narrow&viewMode=story");
  const row = page.getByRole("navigation", { name: "Reports pages" }).locator("ul");
  await expect(row).toHaveCSS("overflow-x", "auto");
  const scrolls = await row.evaluate((element) => element.scrollWidth > element.clientWidth);
  expect(scrolls).toBe(true);
  await expect(
    page.getByRole("navigation", { name: "Reports pages" }).getByRole("link").first(),
  ).toHaveAttribute("aria-current", "page");
});

test("on a phone the Settings row opens scrolled to the page you are on, and a first tab leaves it where it is", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    "/iframe.html?id=lanes-uxshell-sectiontabs--settings-list-last-current&viewMode=story",
  );
  const nav = page.getByRole("navigation", { name: "Settings" });
  const row = nav.locator("ul");
  await expect(row).toHaveCSS("flex-direction", "row");
  const current = nav.locator("[aria-current]");
  await expect(current).toHaveText("Changes");
  // The row is scrolled when the page opens and once more when its font has arrived, so the answer is waited for.
  const inRow = () =>
    current.evaluate((element) => {
      const box = (element.closest("ul") as HTMLElement).getBoundingClientRect();
      const mine = element.getBoundingClientRect();
      return mine.left >= box.left - 1 && mine.right <= box.right + 1;
    });
  await expect.poll(inRow).toBe(true);
  expect(await row.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  // The page does not move: only the row does.
  expect(await page.evaluate(() => window.scrollX)).toBe(0);
  await page.goto("/iframe.html?id=lanes-uxshell-sectiontabs--settings-list&viewMode=story");
  const first = page.getByRole("navigation", { name: "Settings" }).locator("ul");
  await expect(first).toHaveCSS("flex-direction", "row");
  expect(await first.evaluate((element) => element.scrollLeft)).toBe(0);
});

test("the Settings list is a column on a wide window and a row on a phone", async ({ page }) => {
  await page.goto("/iframe.html?id=lanes-uxshell-sectiontabs--settings-list&viewMode=story");
  const list = page.getByRole("navigation", { name: "Settings" }).locator("ul");
  await expect(list).toHaveCSS("flex-direction", "column");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(list).toHaveCSS("flex-direction", "row");
});
