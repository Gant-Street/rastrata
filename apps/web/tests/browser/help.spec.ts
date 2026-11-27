import { expect, type Page, test } from "@playwright/test";
import axe from "axe-core";

declare global {
  interface Window {
    axe: typeof axe;
  }
}

// Help, on the build that ships: the list of topics, a topic read from the file the build wrote for it, the
// one link in the footer of every page, and Search. It reads nothing of a book.

const footerHelp = (page: Page) => page.locator(".app-footer").getByRole("link", { name: "Help" });
const fits = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test("Help in the footer opens the how-to for the page a person is on, and Back returns to the page", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/reconcile");
  await expect(footerHelp(page)).toHaveAttribute("href", "/help/reconcile-an-account");
  await footerHelp(page).click();
  await expect(page).toHaveURL(/\/help\/reconcile-an-account$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Reconcile a bank or card account" }),
  ).toBeVisible();
  // The topic's name is the browser tab's, and the text is the how-to's own.
  await expect(page).toHaveTitle(/^Reconcile a bank or card account · /);
  await expect(page.getByRole("heading", { level: 2, name: "What you need" })).toBeVisible();
  await expect(page.locator(".rt-prose").first()).toContainText(
    "A reconciliation checks one account in your books against a statement",
  );
  // No raw Markdown, no file name and no marker reaches the page.
  const text = await page.locator("#main").innerText();
  expect(text).not.toMatch(/\]\(|\.md\b|<!--|help: (skip|end)|^#+ /m);
  // The bar underlines none of the four places: Help is not one of them.
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }).locator("[aria-current]"),
  ).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(/\/reconcile$/);
  // A page of several tools opens the tool's own topic; one with no how-to opens the list.
  await page.goto("/tax?tab=vendors");
  await expect(footerHelp(page)).toHaveAttribute("href", "/help/track-1099-vendors");
  await page.goto("/settings/workspace");
  await expect(footerHelp(page)).toHaveAttribute("href", "/help");
  expect(errors).toEqual([]);
});

test("the list has every topic under its place, one link a row, and a topic links on to the next", async ({
  page,
}) => {
  await page.goto("/help");
  await expect(page.getByRole("heading", { level: 1, name: "Help" })).toBeVisible();
  await expect(page).toHaveTitle(/^Help · /);
  const groups = page.locator(".rt-index-groups > section");
  await expect(groups.getByRole("heading", { level: 2 })).toHaveText([
    "Getting started",
    "Transactions",
    "Accounts",
    "Reports",
    "Settings",
  ]);
  // No group is empty, and nothing but links is in the list.
  for (const group of await groups.all())
    expect(await group.getByRole("link").count()).toBeGreaterThan(0);
  await expect(page.locator("#main").getByRole("button")).toHaveCount(0);
  await page
    .getByRole("list", { name: "Accounts" })
    .getByRole("link", { name: "Connect Stripe" })
    .click();
  await expect(page).toHaveURL(/\/help\/connect-stripe$/);
  await expect(page.getByRole("heading", { level: 1, name: "Connect Stripe" })).toBeVisible();
  // A link inside the text opens the other topic without loading the application again.
  await page.evaluate(() => {
    (window as unknown as { stayed?: boolean }).stayed = true;
  });
  await page.locator(".rt-prose").getByRole("link", { name: "How Rastrata books Stripe" }).click();
  await expect(page).toHaveURL(/\/help\/stripe-booking$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "How Rastrata books Stripe" }),
  ).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { stayed?: boolean }).stayed)).toBe(true);
  // The footer's Help is the way back to the list from a topic.
  await page.getByRole("contentinfo").getByRole("link", { name: "Help", exact: true }).click();
  await expect(page).toHaveURL(/\/help$/);
});

test("a link to one heading lands on it, a command can be copied, and a topic that is not there says so", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/journal");
  await expect(footerHelp(page)).toHaveAttribute(
    "href",
    "/help/work-through-the-inbox#all-transactions",
  );
  await footerHelp(page).click();
  const heading = page.getByRole("heading", { level: 2, name: "All transactions" });
  await expect(heading).toBeInViewport();
  // A command is set apart with Copy, which puts exactly the command on the clipboard and says so.
  await page.goto("/help/set-up-your-books");
  const block = page.locator(".rt-prose-code").first();
  await expect(block).toBeVisible();
  const command = await block.locator("code").innerText();
  await block.getByRole("button", { name: "Copy" }).click();
  await expect(block.getByRole("status")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(command);
  // An address that is no topic: a page that says so and offers the list, never a blank one.
  await page.goto("/help/no-such-topic");
  await expect(
    page.getByRole("heading", { level: 1, name: "There is no such topic" }),
  ).toBeVisible();
  await page.locator("#main").getByRole("link", { name: "See every topic" }).click();
  await expect(page).toHaveURL(/\/help$/);
});

test("Search finds Help and a topic by its name", async ({ page }) => {
  await page.goto("/");
  // The shortcut is installed when the page draws, which can be after the page has loaded; a key pressed before that is lost.
  await expect(page.getByRole("banner")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const search = page.getByRole("dialog", { name: "Search" });
  await search.getByRole("combobox").fill("help");
  await expect(search.getByRole("option", { name: /^Help/ }).first()).toBeVisible();
  await search.getByRole("combobox").fill("1099 vendors");
  await search.getByRole("option", { name: "Track your 1099 vendors" }).click();
  await expect(page).toHaveURL(/\/help\/track-1099-vendors$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Track your 1099 vendors" }),
  ).toBeVisible();
});

// The list, a short topic, one with tables and commands, and the tutorial: no accessibility violations and
// no sideways scroll, in both themes, at a desk and on two phones.
for (const path of [
  "/help",
  "/help/record-money-in-and-out",
  "/help/connect-stripe",
  "/help/your-first-month",
])
  for (const theme of ["light", "dark"] as const)
    test(`${path} fits and passes the accessibility scan (${theme})`, async ({ page }) => {
      await page.goto(path);
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      if (path !== "/help") await expect(page.locator(".rt-prose").first()).toBeVisible();
      await page.addStyleTag({
        content: "*,*::before,*::after{transition:none!important;animation:none!important}",
      });
      for (const width of [1440, 390, 360]) {
        await page.setViewportSize({ width, height: 844 });
        expect(await fits(page), `${path} at ${width}`).toBe(true);
      }
      // A line of the text is a width a person can read: about 65 characters, never the whole desk.
      await page.setViewportSize({ width: 1440, height: 844 });
      if (path !== "/help") {
        const column = await page.locator(".rt-prose").first().boundingBox();
        expect(column?.width ?? 0).toBeLessThanOrEqual(720);
      }
      await page.addScriptTag({ content: axe.source });
      const violations = await page.evaluate(async () =>
        (
          await window.axe.run(document.body, {
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
          })
        ).violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })),
      );
      expect(violations).toEqual([]);
    });
