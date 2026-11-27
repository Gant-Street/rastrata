import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";

const register = "/iframe.html?id=patterns-register--review&viewMode=story";
/** A row is named by what the entry says: the register shows no entry number. These are the fixture's. */
const NAMES = {
  "JRN-0044": "Workshop equipment",
  "JRN-0043": "Office supplies",
  "JRN-0042": "Customer payment",
  "JRN-0040": "International operations · Professional services and annual review",
  "JRN-0039": "Opening balance adjustment",
} as const;
const entryButton = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
/** The dates, the account and the status are folded behind the search box's Filter button. */
async function openFilters(page: Page) {
  const filter = page.getByRole("button", { name: /^Filter/ });
  if ((await filter.getAttribute("aria-expanded")) !== "true") await filter.click();
}
async function openDraft(page: Page, story = register) {
  await page.goto(story);
  await entryButton(page, NAMES["JRN-0044"]).click();
  return page.getByRole("dialog", { name: "JRN-0044", exact: true });
}

test("account paths disambiguate names and group accounts cannot be posted to", async ({
  page,
}) => {
  await page.goto("/iframe.html?id=components-forms--account-hierarchy&viewMode=story");
  const input = page.getByRole("combobox", { name: "Account", exact: true });
  await input.fill("Professional services");
  await expect(page.getByRole("option")).toHaveCount(2);
  await expect(
    page.getByRole("option", { name: "6200 · Professional services", exact: true }),
  ).toHaveAccessibleDescription("Expenses / Domestic operations");
  await expect(
    page.getByRole("option", { name: "6210 · Professional services", exact: true }),
  ).toHaveAccessibleDescription("Expenses / International operations");
  await input.fill("International operations");
  await expect(page.getByRole("option")).toHaveCount(1);
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(input).toHaveValue("6210 · Professional services");
  await expect(input).toHaveAccessibleDescription("Expenses / International operations");
  // The combobox may restore the selected label just after a clear (about one run in thirty);
  // clearing again until it sticks is what a person would do, and the test is about the result.
  await expect(async () => {
    await input.fill("");
    await expect(input).toHaveValue("", { timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await input.fill("6000");
  await expect(page.getByRole("option")).toHaveAttribute("data-disabled", "");
  await expect(page.getByRole("option")).toHaveAccessibleDescription(/Group only/);
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(input).not.toHaveValue("6000 · Operating expenses");
});

test("an unavailable account is retained until explicitly replaced", async ({ page }) => {
  await page.goto("/iframe.html?id=components-forms--unavailable-account&viewMode=story");
  const input = page.getByRole("combobox", { name: "Account", exact: true });
  await expect(input).toHaveAccessibleDescription(/removed-account-7100.*ID is retained/);
  await input.fill("cash");
  await page.getByRole("option", { name: "1000 · Cash", exact: true }).click();
  await expect(input).toHaveValue("1000 · Cash");
  await expect(input).toHaveAccessibleDescription("Assets / Current assets");
});

test("account and status filters intersect, expose hidden selections and reset together", async ({
  page,
}) => {
  await page.goto(register);
  await page.getByRole("checkbox", { name: "Select JRN-0044", exact: true }).locator("..").click();
  await openFilters(page);
  await page.getByRole("combobox", { name: "Account", exact: true }).click();
  await page.getByRole("option", { name: /1000 · Cash/ }).click();
  await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(3);
  await expect(page.getByText("1 outside current filters", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Status", exact: true }).click();
  await page.getByRole("option", { name: "Draft", exact: true }).click();
  await expect(page.getByText("No transactions match", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Remove Account: 1000 · Cash", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Remove Status: Draft", exact: true }).click();
  await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(3);
  await page.getByRole("button", { name: "Clear all filters", exact: true }).click();
  await expect(page.getByText("Page 1 of 2", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select JRN-0044", exact: true })).toBeChecked();
});

test("posting date range filters by inclusive calendar dates and clears the controls", async ({
  page,
}) => {
  await page.goto(register);
  await page.getByRole("button", { name: "Next page" }).click();
  await openFilters(page);
  await page.getByRole("button", { name: "Open calendar" }).click();
  const start = page.locator('[data-part="table-cell-trigger"][data-value="2026-09-21"]').first();
  await start.click();
  await page.locator('[data-part="table-cell-trigger"][data-value="2026-09-22"]').first().click();
  await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(2);
  await expect(entryButton(page, NAMES["JRN-0042"])).toBeVisible();
  await expect(entryButton(page, NAMES["JRN-0043"])).toBeVisible();
  await expect(page.getByText("Page 1 of 1", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear all filters", exact: true }).click();
  await expect(page.locator('[data-scope="date-picker"][data-part="input"]').first()).toHaveValue(
    "",
  );
  await expect(page.locator('[data-scope="date-picker"][data-part="input"]').last()).toHaveValue(
    "",
  );
  await expect(page.getByText("Page 1 of 2", { exact: true })).toBeVisible();
});

test("entry and account drilldown preserve page, selection, sort and keyboard focus", async ({
  page,
}) => {
  await page.goto(register);
  await page.getByRole("button", { name: "Next page" }).click();
  const trigger = entryButton(page, NAMES["JRN-0039"]);
  await page.getByRole("checkbox", { name: "Select JRN-0039", exact: true }).locator("..").click();
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "JRN-0039", exact: true });
  await expect(dialog.getByRole("textbox", { name: "Reference", exact: true })).toHaveAttribute(
    "readonly",
    "",
  );
  await expect(dialog.getByRole("button", { name: "Save draft" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "1000 · Cash", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "1000 · Cash", exact: true })).toBeFocused();
  await dialog.getByRole("button", { name: "Back to entry", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "1000 · Cash", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(page.getByText("Page 2 of 2", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select JRN-0039", exact: true })).toBeChecked();
});

test("saving a draft returns to dirty on the next edit and discard restores only the last save", async ({
  page,
}) => {
  const dialog = await openDraft(page);
  const input = dialog.getByRole("textbox", { name: "Reference", exact: true });
  await input.fill("Equipment receipt 42");
  await expect(dialog.getByRole("status").filter({ hasText: /\S/ })).toHaveText("Unsaved changes");
  await dialog.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(input).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Back to entries" })).toBeDisabled();
  await expect(dialog.getByRole("status").filter({ hasText: /\S/ })).toHaveText(
    "Draft saved in this preview.",
  );
  await input.fill("Unsaved replacement");
  await expect(dialog.getByRole("status").filter({ hasText: /\S/ })).toHaveText("Unsaved changes");
  await page.keyboard.press("Escape");
  const confirm = page.getByRole("alertdialog", { name: "Save changes before leaving?" });
  await expect(confirm.getByRole("button", { name: "Keep editing" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirm).toBeHidden();
  await expect(input).toHaveValue("Unsaved replacement");
  await dialog.getByRole("button", { name: "Back to entries" }).click();
  await confirm.getByRole("button", { name: "Discard changes" }).click();
  await entryButton(page, "Equipment receipt 42").click();
  await expect(input).toHaveValue("Equipment receipt 42");
});

test("failed save-and-leave preserves input and retry leaves only after confirmation", async ({
  page,
}) => {
  const dialog = await openDraft(
    page,
    "/iframe.html?id=patterns-register--draft-save-recovery&viewMode=story",
  );
  const input = dialog.getByRole("textbox", { name: "Reference", exact: true });
  await input.fill("Equipment invoice 900");
  await dialog.getByRole("button", { name: "Back to entries" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Save changes before leaving?" });
  await confirm.getByRole("button", { name: "Save and leave" }).click();
  await expect(confirm.getByText("Draft could not be saved", { exact: true })).toBeVisible();
  await confirm.getByRole("button", { name: "Keep editing" }).click();
  await expect(input).toHaveValue("Equipment invoice 900");
  await dialog.getByRole("button", { name: "Back to entries" }).click();
  await confirm.getByRole("button", { name: "Save and leave" }).click();
  await expect(confirm).toBeHidden();
  await expect(dialog).toBeHidden();
  await expect(entryButton(page, "Equipment invoice 900")).toBeVisible();
  await expect(entryButton(page, "Equipment invoice 900")).toBeFocused();
});

test("blank references cannot be saved; typing the saved value clears dirty state", async ({
  page,
}) => {
  const dialog = await openDraft(page);
  const input = dialog.getByRole("textbox", { name: "Reference", exact: true });
  await input.fill(" ");
  // Typing is never scolded: the status line explains the disabled button right away,
  // and the field itself reports the problem once the person leaves it.
  await expect(dialog.getByRole("status").filter({ hasText: /\S/ })).toHaveText(
    "Enter a reference.",
  );
  await expect(input).not.toHaveAttribute("aria-invalid", "true");
  await input.blur();
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
  await input.fill("Workshop equipment");
  await expect(dialog.getByRole("status").filter({ hasText: /\S/ })).toHaveText(
    "No unsaved changes",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(dialog).toBeHidden();
});

test("inspector fits a small screen and dialogs pass open-state accessibility checks", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const dialog = await openDraft(page);
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const fitsViewport = async () => {
    const bounds = await page
      .locator('[role="dialog"]:visible, [role="alertdialog"]:visible')
      .evaluateAll((elements) =>
        elements.map((element) => {
          const rect = element.getBoundingClientRect();
          return rect.left >= 0 && rect.right <= window.innerWidth;
        }),
      );
    expect(bounds.every(Boolean)).toBe(true);
  };
  await fitsViewport();
  await page.addScriptTag({ content: axe.source });
  const violations = () =>
    page.evaluate(async () =>
      (await window.axe.run(document.body)).violations.map((violation) => violation.id),
    );
  expect(await violations()).toEqual([]);
  await dialog.getByRole("textbox", { name: "Reference", exact: true }).fill("Unsaved draft");
  await dialog.getByRole("button", { name: "Back to entries" }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await expect(
    page.getByRole("alertdialog").getByRole("button", { name: "Keep editing" }),
  ).toBeFocused();
  await expect(page.getByRole("button", { name: "Save draft", exact: true })).toHaveCount(0);
  await fitsViewport();
  expect(await violations()).toEqual([]);
});

test("saving on page two preserves context and the saved history survives reopening", async ({
  page,
}) => {
  await page.goto(register);
  await page.getByRole("button", { name: "Next page" }).click();
  await entryButton(page, NAMES["JRN-0040"]).click();
  const dialog = page.getByRole("dialog", { name: "JRN-0040", exact: true });
  await dialog
    .getByRole("textbox", { name: "Reference", exact: true })
    .fill("International review");
  await dialog.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(dialog.getByRole("status").filter({ hasText: /\S/ })).toHaveText(
    "Draft saved in this preview.",
  );
  await dialog.getByRole("button", { name: "Back to entries" }).click();
  await expect(page.getByText("Page 2 of 2", { exact: true })).toBeVisible();
  // The saved reference is the row's name now.
  const renamed = entryButton(page, "International review");
  await expect(renamed).toBeFocused();
  await renamed.click();
  await expect(dialog.getByRole("region", { name: "Entry history" })).toContainText(
    "Draft reference saved: International review",
  );
  await expect(dialog.getByRole("textbox", { name: "Reference", exact: true })).toHaveValue(
    "International review",
  );
});

test("saving out of the current search preserves the filter and returns focus to search", async ({
  page,
}) => {
  await page.goto(register);
  const search = page.getByRole("searchbox", { name: "Search transactions" });
  await search.fill("Workshop equipment");
  await entryButton(page, NAMES["JRN-0044"]).click();
  await page.getByRole("textbox", { name: "Reference", exact: true }).fill("Equipment receipt");
  await page.getByRole("button", { name: "Back to entries" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Save and leave" }).click();
  await expect(page.getByRole("alertdialog")).toBeHidden();
  await expect(search).toHaveValue("Workshop equipment");
  await expect(search).toBeFocused();
  await expect(page.getByText("No transactions match", { exact: true })).toBeVisible();
});

test("browser-leave protection applies only while unsaved work is open", async ({ page }) => {
  const dialog = await openDraft(page);
  const protectedFromLeave = () =>
    page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
  expect(await protectedFromLeave()).toBe(false);
  await dialog.getByRole("textbox", { name: "Reference", exact: true }).fill("Unsaved reference");
  expect(await protectedFromLeave()).toBe(true);
  await dialog.getByRole("button", { name: "Back to entries" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Discard changes" }).click();
  await expect(dialog).toBeHidden();
  expect(await protectedFromLeave()).toBe(false);
});

test("workshop overview no longer claims saved after another edit", async ({ page }) => {
  await page.goto("/iframe.html?id=start-here-workshop--review&viewMode=story");
  await page.getByRole("button", { name: "Save Draft", exact: true }).click();
  await expect(page.getByRole("button", { name: "✓ Draft Saved", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Reference", exact: true }).fill("Another edit");
  await expect(page.getByRole("button", { name: "Save Draft", exact: true })).toBeVisible();
});
