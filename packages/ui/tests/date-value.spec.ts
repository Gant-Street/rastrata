import { expect, test } from "@playwright/test";
import { shown } from "./support/shown";

// A date is written for a person, and the stored form is kept for a script and a tooltip. An instant is
// shown on the clock of whoever looks: this file runs the same story on a UTC clock (the projects'
// default) and on a clock in Denver.
const story = (id: string) => `/iframe.html?id=lanes-uxlanguage-datevalue--${id}&viewMode=story`;

test("a date is written the way a person writes it and keeps its stored form", async ({ page }) => {
  await page.goto(story("default"));
  const march = page.locator('time[datetime="2026-03-20"]').first();
  await expect(march).toHaveText(shown.date("2026-03-20"));
  await expect(march).toHaveAttribute("title", "2026-03-20");
  await expect(page.locator('time[datetime="2024-02-29"]')).toHaveText(shown.date("2024-02-29"));
  // The text of the page holds no year-month-day date: that form is in the tooltip.
  expect(await page.locator("#storybook-root").innerText()).not.toMatch(/\d{4}-\d{2}-\d{2}/);
});

test("a date does not wrap inside itself in a narrow column", async ({ page }) => {
  await page.goto(story("narrow"));
  await expect(page.locator("time").first()).toBeVisible();
  const times = await page.locator("time").all();
  expect(times.length).toBeGreaterThan(3);
  for (const time of times) {
    // An inline element that wraps has one client rectangle for each line it covers.
    const lines = await time.evaluate((element) => element.getClientRects().length);
    expect(lines).toBe(1);
  }
});

test("what is not a date is shown as it came and is not a time element", async ({ page }) => {
  await page.goto(story("not-a-date-at-all"));
  await expect(page.getByText("Nothing yet")).toBeVisible();
  await expect(page.locator("time")).toHaveCount(0);
  const text = await page.locator("#storybook-root").innerText();
  expect(text).toContain("—");
  expect(text).toContain("2026-3-2");
  expect(text).toContain("Mar 20, 2026");
});

test("an instant is shown on a UTC clock when the viewer is in UTC", async ({ page }) => {
  await page.goto(story("instant"));
  const evening = page.locator('time[datetime="2026-10-05T03:30:00Z"]');
  await expect(evening.first()).toHaveText(shown.instant("2026-10-05T03:30:00Z", "UTC"));
  await expect(evening.last()).toHaveText(shown.date("2026-10-05T03:30:00Z", "UTC"));
  await expect(evening.first()).toHaveAttribute("title", "2026-10-05T03:30:00Z");
});

test("the book's date format changes every date on the page, and the tooltip stays ISO", async ({
  page,
}) => {
  await page.goto(story("chosen-format"));
  const closed = page.locator('time[datetime="2026-02-28"]');
  await expect(closed).toHaveText(shown.dateAs("medium", "2026-02-28"));
  for (const format of ["iso", "numeric", "medium"] as const) {
    await page.locator(`button[data-format="${format}"]`).click();
    await expect(closed).toHaveText(shown.dateAs(format, "2026-02-28"));
    await expect(closed).toHaveAttribute("title", "2026-02-28");
  }
  // The buttons themselves are examples of the three, written from one fixed date.
  await expect(page.locator('button[data-format="numeric"]')).toHaveText(
    shown.dateAs("numeric", "2026-03-20"),
  );
});

test.describe("on a clock in another zone", () => {
  test.use({ timezoneId: "America/Denver" });

  test("an instant is the evening it was, and the day it falls on follows", async ({ page }) => {
    await page.goto(story("instant"));
    const evening = page.locator('time[datetime="2026-10-05T03:30:00Z"]');
    await expect(evening.first()).toHaveText(
      shown.instant("2026-10-05T03:30:00Z", "America/Denver"),
    );
    await expect(evening.last()).toHaveText(shown.date("2026-10-05T03:30:00Z", "America/Denver"));
    // The same instant on a UTC clock reads differently, so this test cannot pass by accident.
    expect(shown.instant("2026-10-05T03:30:00Z", "America/Denver")).not.toBe(
      shown.instant("2026-10-05T03:30:00Z", "UTC"),
    );
    await expect(evening.first()).toHaveAttribute("title", "2026-10-05T03:30:00Z");
  });

  test("a date does not move with the clock: it is a calendar day, not a moment", async ({
    page,
  }) => {
    await page.goto(story("default"));
    await expect(page.locator('time[datetime="2026-03-20"]').first()).toHaveText(
      shown.date("2026-03-20"),
    );
    await expect(page.locator('time[datetime="2026-10-01"]')).toHaveText(shown.date("2026-10-01"));
  });
});
