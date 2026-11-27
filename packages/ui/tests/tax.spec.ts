import { expect, type Page, test } from "@playwright/test";

// The Tax components where they have to adapt: a field inside a tab, and the tables at a phone's width. (The
// whole flow against the real service is in apps/web, tests/browser/tax.spec.ts, and every story is scanned in
// both themes by lane-stories.spec.ts.)
const story = (id: string) => `/iframe.html?id=lanes-tax-${id}&viewMode=story`;
const PHONE = { width: 390, height: 800 };
const DESKTOP = { width: 1280, height: 800 };

/** True when the page does not scroll sideways. */
const fits = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test("a field inside a tab looks like the same field outside one", async ({ page }) => {
  await page.goto(story("states--select-in-a-tab"));
  const triggers = page.locator(".rt-select-trigger");
  await expect(triggers).toHaveCount(2);
  const look = (index: number) =>
    triggers.nth(index).evaluate((element) => {
      const style = getComputedStyle(element);
      return [
        style.borderTopWidth,
        style.borderBottomWidth,
        style.color,
        style.backgroundColor,
        style.paddingTop,
      ].join(" | ");
    });
  expect(await look(0)).toBe(await look(1));
  // The tabs themselves keep their own look: a pale line under the list and a 2px ink line under the one chosen
  // (docs/reference/design-language.md).
  const selected = page.getByRole("tab", { name: "Worksheet" });
  expect(await selected.evaluate((element) => getComputedStyle(element).borderBottomWidth)).toBe(
    "2px",
  );
});

test("a pack's files are two columns on a phone, with the size under the description", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto(story("year-end-pack--pack-ready"));
  await expect(page.locator(".rt-tax-filecolumn").first()).toBeVisible();
  await expect(page.locator(".rt-tax-filemeta").first()).toBeHidden();
  await page.setViewportSize(PHONE);
  await expect(page.locator(".rt-tax-filecolumn").first()).toBeHidden();
  await expect(page.locator(".rt-tax-filemeta").first()).toBeVisible();
  // A file name breaks at a hyphen or a slash and never inside a word.
  const path = page.locator(".rt-tax-path").first();
  expect(await path.evaluate((element) => getComputedStyle(element).overflowWrap)).toBe(
    "break-word",
  );
  expect(await fits(page)).toBe(true);
});

test("the preview of an accountant's file fits a phone: the status sits under the entry and nothing scrolls", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await page.goto(story("adjusting-entries--adjustments-problems"));
  const table = page.locator(".rt-tax-entrytable");
  await expect(table).toBeVisible();
  await expect(page.locator(".rt-tax-statuscolumn").first()).toBeHidden();
  await expect(page.locator(".rt-tax-statusinline").first()).toBeVisible();
  const region = table.locator("xpath=..");
  expect(
    await region.evaluate((element) => element.scrollWidth <= element.clientWidth),
    "the preview's table is wider than its region",
  ).toBe(true);
  expect(await fits(page)).toBe(true);
  await page.setViewportSize(DESKTOP);
  await expect(page.locator(".rt-tax-statuscolumn").first()).toBeVisible();
  await expect(page.locator(".rt-tax-statusinline").first()).toBeHidden();
});

test("the worksheet keeps both columns of figures beside their labels at a phone's width", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await page.goto(story("worksheet--worksheet-schedule-c"));
  const figure = page.locator(".rt-tax-worksheet tbody td.rt-number").last();
  await expect(figure).toBeVisible();
  const box = await figure.boundingBox();
  expect(box?.x ?? Infinity, "the last figure's left edge").toBeLessThan(PHONE.width);
  expect(
    (box?.x ?? Infinity) + (box?.width ?? 0),
    "the last figure's right edge",
  ).toBeLessThanOrEqual(PHONE.width);
  // The caption keeps each date whole.
  const caption = page.locator(".rt-tax-worksheet caption .rt-tax-nowrap").first();
  const lines = await caption.evaluate((element) => element.getClientRects().length);
  expect(lines).toBe(1);
  expect(await fits(page)).toBe(true);
});
