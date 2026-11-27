import { expect, test, type Page } from "@playwright/test";

const register = "/iframe.html?id=patterns-register--review&viewMode=story";
const rtl = "/iframe.html?id=patterns-register--right-to-left&viewMode=story";

async function openDraft(page: Page) {
  await page.goto(register);
  // A row is named by what the entry says: the register shows no entry number.
  await page.getByRole("button", { name: "Workshop equipment", exact: true }).click();
  return page.getByRole("dialog", { name: "JRN-0044", exact: true });
}

test.describe("inspector", () => {
  test("a slow save cannot be submitted twice", async ({ page }) => {
    const dialog = await openDraft(page);
    await dialog.getByRole("textbox", { name: "Reference", exact: true }).fill("Only once");
    const save = dialog.locator('button[type="submit"]');
    // Two clicks in the same tick: the second lands while the first save is still pending.
    const during = await save.evaluate((button: HTMLButtonElement) => {
      button.click();
      const state = {
        busy: button.getAttribute("aria-busy"),
        disabled: button.getAttribute("aria-disabled"),
        label: button.textContent,
      };
      button.click();
      return state;
    });
    expect(during).toEqual({ busy: "true", disabled: "true", label: "Saving draft…" });
    await expect(dialog.getByRole("status").filter({ hasText: /\S/ })).toHaveText(
      "Draft saved in this preview.",
    );
    await expect(dialog.getByText("Draft reference saved: Only once")).toHaveCount(1);
    await expect(
      dialog.getByRole("region", { name: "Entry history" }).getByRole("listitem"),
    ).toHaveCount(2);
  });

  test("revert restores the saved reference without leaving", async ({ page }) => {
    const dialog = await openDraft(page);
    const input = dialog.getByRole("textbox", { name: "Reference", exact: true });
    await expect(dialog.getByRole("button", { name: "Revert to saved" })).toHaveCount(0);
    await input.fill("Something else");
    await expect(dialog.getByRole("status").filter({ hasText: /\S/ })).toHaveText(
      "Unsaved changes",
    );
    await dialog.getByRole("button", { name: "Revert to saved" }).click();
    await expect(input).toHaveValue("Workshop equipment");
    await expect(dialog.getByRole("status").filter({ hasText: /\S/ })).toHaveText(
      "No unsaved changes",
    );
    await expect(dialog.getByRole("button", { name: "Revert to saved" })).toHaveCount(0);
    await expect(dialog).toBeVisible();
  });

  test("Control+S saves a draft from the field", async ({ page }) => {
    const dialog = await openDraft(page);
    const input = dialog.getByRole("textbox", { name: "Reference", exact: true });
    await input.fill("Saved from keyboard");
    await input.press("Control+s");
    await expect(dialog.getByRole("status").filter({ hasText: /\S/ })).toHaveText(
      "Draft saved in this preview.",
    );
  });

  test("validation waits until the field is left, and contextual help opens on demand", async ({
    page,
  }) => {
    const dialog = await openDraft(page);
    const input = dialog.getByRole("textbox", { name: "Reference", exact: true });
    await input.fill("");
    await expect(dialog.locator(".rt-error")).toHaveCount(0);
    await input.blur();
    await expect(dialog.locator(".rt-error")).toContainText("Enter a reference.");
    await expect(dialog.locator(".rt-error .rt-sr-only")).toHaveText("Error: ");
    await dialog.getByRole("button", { name: "Help: Reference" }).click();
    await expect(page.getByText("A name you can find later", { exact: false })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByText("A name you can find later", { exact: false })).toBeHidden();
    await expect(dialog).toBeVisible();
  });
});

test.describe("register", () => {
  test("results are announced politely when a page, filter or sort changes them", async ({
    page,
  }) => {
    await page.goto(register);
    const live = page.locator('.rt-sr-only[aria-live="polite"]');
    await expect(live).toHaveText(
      "Showing 1 to 4 of 6 transactions. Page 1 of 2. Sorted by date, newest first.",
    );
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(live).toHaveText(
      "Showing 5 to 6 of 6 transactions. Page 2 of 2. Sorted by date, newest first.",
    );
    await page.getByRole("button", { name: "Date", exact: true }).click();
    await expect(live).toContainText("oldest first");
    await page.getByRole("searchbox", { name: "Search transactions" }).fill("nothing like this");
    await expect(live).toHaveText("No transactions match.");
  });

  test('"/" jumps to search, but never while typing or inside a dialog', async ({ page }) => {
    await page.goto(register);
    const search = page.getByRole("searchbox", { name: "Search transactions" });
    await expect(search).toHaveAttribute("aria-keyshortcuts", "/");
    await page.locator("main h1").click();
    await page.keyboard.press("/");
    await expect(search).toBeFocused();
    await search.fill("a/b");
    await expect(search).toHaveValue("a/b");
    await search.fill("");
    await page.getByRole("button", { name: "Workshop equipment", exact: true }).click();
    const reference = page.getByRole("textbox", { name: "Reference", exact: true });
    // Let the dialog finish moving focus in before typing, so we test the key and not a race.
    await expect(page.getByRole("button", { name: "Back to entries" })).toBeFocused();
    await reference.click();
    await reference.press("End");
    await page.keyboard.press("/");
    await expect(reference).toBeFocused();
    await expect(reference).toHaveValue("Workshop equipment/");
  });

  test("by date, and within a day in the order the entries were made, so JRN-100 follows JRN-99", async ({
    page,
  }) => {
    await page.goto(rtl);
    // JRN-99 and JRN-100 share a day: their numbers sort by their digits, not as text.
    const names = page.locator(".rt-register-entry-button");
    await expect(names).toHaveText(["شراء معدات الورشة", "دفعة العميل", "مصروفات المكتب JRN-98"]);
    await page.getByRole("button", { name: "Date", exact: true }).click();
    await expect(names).toHaveText(["مصروفات المكتب JRN-98", "دفعة العميل", "شراء معدات الورشة"]);
  });
});

test.describe("right to left", () => {
  test("Ark popups, arrows, edges and mixed-direction values follow the page", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto(rtl);
    await expect(page.locator(".rt-ui")).toHaveAttribute("dir", "rtl");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      1100,
    );

    // Dates, entry numbers, account labels and amounts are isolated so digits never reorder.
    await expect(page.locator(".rt-register-cell-date bdi")).toHaveCount(3);
    await expect(page.locator(".rt-register-cell-amount bdi")).toHaveCount(3);

    // Reading order starts on the right: the Date column sits right of the Amount column.
    const date = await page.getByRole("columnheader", { name: "Date" }).boundingBox();
    const amount = await page.getByRole("columnheader", { name: /Amount/ }).boundingBox();
    expect(date && amount && date.x > amount.x).toBe(true);

    // Previous/next chevrons mirror.
    for (const name of ["Previous page", "Next page"]) {
      const transform = await page
        .getByRole("button", { name })
        .locator("svg")
        .evaluate((element) => getComputedStyle(element).transform);
      expect(transform).toBe("matrix(-1, 0, 0, 1, 0, 0)");
    }

    // The selected-row edge sits on the outer (right) edge in right-to-left.
    await page.locator('[data-scope="checkbox"][data-part="control"]').nth(1).click();
    const edge = await page
      .locator(".rt-register-row-selected td:first-child")
      .evaluate((cell) => getComputedStyle(cell).boxShadow);
    expect(edge).toContain("-5px");

    // Ark's portaled dialog inherits the direction and opens from the start edge (left here).
    await page.getByRole("button", { name: "مصروفات المكتب JRN-98", exact: true }).click();
    const content = page.locator('[data-scope="dialog"][data-part="content"]').first();
    await expect(content).toHaveAttribute("dir", "rtl");
    const box = await content.boundingBox();
    expect(box && box.x < 100).toBe(true);
  });
});

test.describe("controlled fields", () => {
  const story = "/iframe.html?id=components-forms--controlled-fields&viewMode=story";

  test("an account follows the value it is given, including a reset", async ({ page }) => {
    await page.goto(story);
    const account = page.getByRole("combobox", { name: "Account", exact: true });
    await page.getByRole("button", { name: "Select the cash account" }).click();
    await expect(account).toHaveValue("1000 · Cash");
    await expect(page.getByLabel("Account in the form")).toHaveText("Account in the form: cash");
    await page.getByRole("button", { name: "Clear account" }).click();
    await expect(account).toHaveValue("");
    await expect(page.getByLabel("Account in the form")).toHaveText("No account in the form");
  });

  test("options that arrive late appear without rebuilding the field", async ({ page }) => {
    await page.goto(story);
    const trigger = page.getByRole("combobox", { name: "Currency" });
    await trigger.click();
    await expect(page.getByRole("option")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Load more currencies" }).click();
    await trigger.click();
    await expect(page.getByRole("option")).toHaveCount(3);
  });

  test("a date field starts empty and refuses dates outside its range", async ({ page }) => {
    await page.goto(story);
    const field = page.locator('[data-scope="date-picker"]').first();
    await expect(field.locator("input")).toHaveValue("");
    await field.getByRole("button", { name: "Open calendar" }).click();
    await expect(
      page.locator('[data-part="table-cell-trigger"][data-value="2026-08-31"]').first(),
    ).toHaveAttribute("data-disabled", "");
    await page.locator('[data-part="table-cell-trigger"][data-value="2026-09-15"]').first().click();
    await expect(field.locator("input")).toHaveValue("09/15/2026");
  });

  test("option descriptions survive account IDs with spaces and quotes", async ({ page }) => {
    await page.goto(story);
    const combo = page.getByRole("combobox", { name: "Account with an awkward ID" });
    const option = page.getByRole("option", { name: "1000 · Cash drawer" });
    // Typing opens the list; retry once so a slow first paint cannot make this flaky.
    await expect(async () => {
      await combo.fill("");
      await combo.fill("cash");
      await expect(option).toBeVisible({ timeout: 2000 });
    }).toPass();
    // Neither the option's own id nor the id its description points to may contain whitespace.
    expect(await option.getAttribute("id")).toMatch(/^\S+$/);
    const describedBy = await page
      .getByRole("option", { name: "1000 · Cash drawer" })
      .getAttribute("aria-describedby");
    expect(describedBy).toMatch(/^\S+$/);
    expect(await page.evaluate((id) => !!document.getElementById(id ?? ""), describedBy)).toBe(
      true,
    );
  });
});

test("pending buttons stay focusable, announce busy and say what is happening", async ({
  page,
}) => {
  await page.goto("/iframe.html?id=components-feedback--posting&viewMode=story");
  const button = page.getByRole("button", { name: "Posting…" });
  await button.focus();
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute("aria-busy", "true");
  await expect(button).toHaveAttribute("aria-disabled", "true");
});
