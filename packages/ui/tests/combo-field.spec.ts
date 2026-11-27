import { expect, test, type Page } from "@playwright/test";

// The kit's combo field (Ark's combobox, taking what is typed) in the workshop.
const story = (id: string) => `/iframe.html?id=lanes-uxkit-combofield--${id}&viewMode=story`;
const box = (page: Page) => page.getByRole("combobox", { name: "Time zone" });
const held = (page: Page) => page.getByLabel("Value");

test("the usual answers are listed, and choosing one puts it in the box", async ({ page }) => {
  await page.goto(story("default"));
  await expect(box(page)).toHaveValue("America/Denver");
  await expect(page.getByRole("option")).toHaveCount(0);
  await page.getByRole("button", { name: "List of zones" }).click();
  await expect(page.getByRole("option")).toHaveCount(8);
  await page.getByRole("option", { name: "America/Chicago" }).click();
  await expect(box(page)).toHaveValue("America/Chicago");
  await expect(held(page)).toHaveText("The box holds America/Chicago.");
  await expect(page.getByRole("option")).toHaveCount(0);
});

test("typing narrows the list, the keyboard chooses from it, and Escape puts it away", async ({
  page,
}) => {
  await page.goto(story("empty"));
  await box(page).click();
  await page.keyboard.type("los");
  await expect(page.getByRole("option")).toHaveText(["America/Los_Angeles"]);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(box(page)).toHaveValue("America/Los_Angeles");
  await expect(held(page)).toHaveText("The box holds America/Los_Angeles.");
  await page.getByRole("button", { name: "List of zones" }).click();
  await expect(page.getByRole("option")).toHaveCount(8);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("option")).toHaveCount(0);
  await expect(box(page)).toHaveValue("America/Los_Angeles");
});

test("what the list does not hold is kept as typed, with no empty list under the box", async ({
  page,
}) => {
  await page.goto(story("empty"));
  await box(page).click();
  await page.keyboard.type("Europe/Lisbon");
  await expect(page.getByRole("option")).toHaveCount(0);
  await expect(page.locator(".rt-account-popup")).toBeHidden();
  await expect(held(page)).toHaveText("The box holds Europe/Lisbon.");
  // Leaving the box keeps it.
  await page.keyboard.press("Tab");
  await expect(box(page)).toHaveValue("Europe/Lisbon");
  await expect(held(page)).toHaveText("The box holds Europe/Lisbon.");
});

test("what is wrong is said under the box and tied to it", async ({ page }) => {
  await page.goto(story("with-error"));
  await expect(box(page)).toHaveAttribute("aria-invalid", "true");
  await expect(box(page)).toHaveAccessibleDescription(
    /Enter a time zone such as America\/Denver\./,
  );
});
