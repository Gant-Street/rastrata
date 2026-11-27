import { expect, test } from "@playwright/test";

// Fixed browser, bundled font and deterministic fixtures. Baseline updates need
// visual review; they are not an automatic step in the normal test command.
test("reviewed register and narrow form layouts retain their visual baseline", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "Visual baseline uses one fixed browser; behavior is tested in all three.",
  );
  test.skip(
    Boolean(process.env.CI),
    "Baselines are made on macOS and text renders differently on Linux. Run this locally.",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto("/iframe.html?id=patterns-register--review&viewMode=story");
  await expect(page.locator("main h1")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(page).toHaveScreenshot("register.png", {
    fullPage: true,
    animations: "disabled",
    maxDiffPixelRatio: 0.005,
  });
  await page.goto("/iframe.html?id=patterns-register--review&viewMode=story&globals=theme:dark");
  await expect(page.locator("main h1")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(page).toHaveScreenshot("register-dark.png", {
    fullPage: true,
    animations: "disabled",
    maxDiffPixelRatio: 0.005,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/iframe.html?id=components-forms--review&viewMode=story");
  await expect(page.locator("main h1")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(page).toHaveScreenshot("forms-mobile.png", {
    fullPage: true,
    animations: "disabled",
    maxDiffPixelRatio: 0.005,
  });
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/iframe.html?id=patterns-register--review&viewMode=story");
  await page.getByRole("button", { name: "Workshop equipment", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "JRN-0044", exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(page).toHaveScreenshot("inspector-mobile.png", {
    animations: "disabled",
    maxDiffPixelRatio: 0.005,
  });
  await page.getByRole("textbox", { name: "Reference", exact: true }).fill("Unsaved reference");
  await page.getByRole("button", { name: "Back to entries" }).click();
  await expect(
    page.getByRole("alertdialog").getByRole("button", { name: "Keep editing" }),
  ).toBeFocused();
  await expect(page).toHaveScreenshot("leave-confirmation-mobile.png", {
    animations: "disabled",
    maxDiffPixelRatio: 0.005,
  });
});
