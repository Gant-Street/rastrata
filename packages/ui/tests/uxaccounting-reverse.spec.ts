import { expect, test } from "@playwright/test";
import { shown } from "./support/shown";

/** The reversal dialog (Lanes/UXAccounting/Reverse dialog): a date and a reason, posted in one click,
 * with a review only when the service has something to say first. */
const story = (name: string) =>
  `/iframe.html?id=lanes-uxaccounting-reverse-dialog--${name}&viewMode=story`;
const dialogOf = (page: import("@playwright/test").Page) =>
  page.getByRole("dialog", { name: "Reverse No. 22", exact: true });

test("it opens on the reason, with the date filled in, and Enter sends it", async ({ page }) => {
  await page.goto(story("default"));
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  // What is being reversed is said before anything is asked.
  await expect(dialog).toContainText("LINEAR ORBIT");
  await expect(dialog).toContainText("19.00");
  await expect(dialog.getByRole("textbox", { name: /Reversal date/ })).toHaveValue(
    shown.dateBox("2026-03-20"),
  );
  const reason = dialog.getByRole("textbox", { name: /Reason/ });
  await expect(reason).toBeFocused();
  await reason.fill("Entered twice");
  await reason.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: /\S/ })).toContainText(
    "Reversal of No. 22 dated 2026-03-20 for “Entered twice” sent",
  );
  await expect(dialog).toBeHidden();
});

test("Escape closes it and focus goes back to the button that opened it", async ({ page }) => {
  await page.goto(story("default"));
  await expect(dialogOf(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialogOf(page)).toBeHidden();
  await expect(page.getByRole("button", { name: "Reverse No. 22" })).toBeFocused();
});

test("a missing reason is said beside its field", async ({ page }) => {
  await page.goto(story("missing-reason"));
  const reason = dialogOf(page).getByRole("textbox", { name: /Reason/ });
  await expect(reason).toHaveAttribute("aria-invalid", "true");
  await expect(dialogOf(page)).toContainText("Enter a reason.");
});

test("a warning is read before the reversal is posted, and it can still be posted", async ({
  page,
}) => {
  await page.goto(story("warnings-to-read"));
  const dialog = dialogOf(page);
  await expect(dialog.getByText("Check before you reverse")).toBeVisible();
  await expect(dialog).toContainText("already reconciled");
  // The fields are fixed while the plan is read: what is posted is what was reviewed.
  await expect(dialog.getByRole("textbox", { name: /Reason/ })).toBeDisabled();
  const confirm = dialog.getByRole("button", { name: "Reverse anyway" });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.getByRole("status").filter({ hasText: "Reversed anyway" })).toBeVisible();
});

test("a reversal the service refuses says why and cannot be posted", async ({ page }) => {
  await page.goto(story("cannot-be-posted"));
  const dialog = dialogOf(page);
  await expect(dialog.getByRole("alert")).toContainText("February 2026 is closed");
  await expect(dialog.getByRole("button", { name: "Reverse anyway" })).toBeDisabled();
});

test("while a request is on its way nothing can be sent twice or cancelled", async ({ page }) => {
  await page.goto(story("working"));
  const dialog = dialogOf(page);
  const submit = dialog.getByRole("button", { name: "Reversing…" });
  await expect(submit).toHaveAttribute("aria-busy", "true");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await expect(dialog.getByRole("textbox", { name: /Reason/ })).toBeDisabled();
});

test("a lost reply offers to resume the original request and nothing else", async ({ page }) => {
  await page.goto(story("reply-lost"));
  const dialog = dialogOf(page);
  await expect(dialog).toContainText("An original request is retained");
  await expect(dialog.getByRole("button", { name: "Reverse transaction" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Resume original request" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Resumed in this preview" }),
  ).toBeVisible();
});

test("a long description wraps and the dialog fits a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(story("long-description"));
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  // Nothing in it is wider than it is, and the page does not scroll sideways behind it.
  expect(
    await dialog.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
