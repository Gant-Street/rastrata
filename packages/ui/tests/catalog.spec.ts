import { expect, test } from "@playwright/test";
import axe from "axe-core";

test("RTL composition retains selection and exact strings without claiming translated copy", async ({
  page,
}) => {
  await page.goto("/iframe.html?id=components-forms--right-to-left&viewMode=story");
  const account = page.getByRole("combobox", { name: "Account", exact: true });
  await expect(account).toHaveAttribute("dir", "rtl");
  await account.scrollIntoViewIfNeeded();
  await account.fill("6100");
  await page.getByRole("option", { name: /Office expenses/ }).click();
  await expect(page.getByLabel("Selected account ID", { exact: true })).toHaveText(
    "Selected ID: office",
  );
  const amount = page.getByRole("textbox", { name: "Amount (USD)", exact: true });
  // Ark restores combobox focus on the next animation frame. Verify that handoff,
  // then move focus with a real pointer action before typing into the next field.
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(account).toBeFocused();
  await amount.click();
  await amount.fill("-123456789.001");
  await expect(amount).toHaveValue("-123456789.001");
});

test("failed account loading can recover without inventing or dropping an account selection", async ({
  page,
}) => {
  await page.goto("/iframe.html?id=components-forms--failed-accounts&viewMode=story");
  await page.getByRole("button", { name: "Show accounts" }).click();
  await expect(page.getByRole("status").filter({ hasText: /\S/ })).toContainText(
    "Accounts could not be loaded",
  );
  await expect(page.getByRole("option")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Load fixture accounts" }).click();
  await page.getByRole("button", { name: "Show accounts" }).click();
  await page.getByRole("option", { name: "1000 · Cash", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Account", exact: true })).toHaveValue(
    "1000 · Cash",
  );
});

test("menu actions and interactive popover use the upstream semantics", async ({ page }) => {
  await page.goto("/iframe.html?id=components-overlays--review&viewMode=story");
  await page.getByRole("button", { name: "Entry actions", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: /Reverse entry/ })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await page.getByRole("menuitem", { name: "View history", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: /\S/ })).toContainText(
    "View history selected in preview.",
  );
  await page.getByRole("button", { name: "What does posted mean?" }).click();
  await expect(page.getByText("Part of the permanent record", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("Part of the permanent record", { exact: true })).toBeHidden();
});

test("account search preserves canonical choices, rejects archived choices and recovers from no matches", async ({
  page,
}) => {
  await page.goto("/iframe.html?id=components-forms--review&viewMode=story");
  const account = page.getByRole("combobox", { name: "Account", exact: true });
  await account.scrollIntoViewIfNeeded();
  await account.fill("6100");
  await expect(page.getByRole("option", { name: /Office expenses/ })).toBeVisible();
  await account.press("ArrowDown");
  await account.press("Enter");
  await expect(account).toHaveValue("6100 · Office expenses");
  await expect(page.getByLabel("Selected account ID", { exact: true })).toHaveText(
    "Selected ID: office",
  );
  await account.fill("does not exist");
  await expect(page.getByText("No matching accounts. Try another name or code.")).toBeVisible();
  await account.fill("");
  await account.fill("archived");
  const archived = page.getByRole("option", { name: /archived/ });
  await expect(archived).toHaveAttribute("data-disabled", "");
  await account.press("ArrowDown");
  await account.press("Enter");
  await expect(account).not.toHaveValue("6900 · Legacy expenses (archived)");
  await expect(page.getByLabel("Selected account ID", { exact: true })).not.toContainText(
    "archived",
  );
  await account.fill("1000");
  await page.getByRole("option", { name: "1000 · Cash", exact: true }).click();
  await expect(account).toHaveValue("1000 · Cash");
});

test("choice controls, password reveal and exact decimal text work without custom numeric conversion", async ({
  page,
}) => {
  await page.goto("/iframe.html?id=components-forms--review&viewMode=story");
  await page.getByText("Draft entries", { exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Draft entries", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: /Archived entries/ })).toBeDisabled();
  await page.getByText("Cash", { exact: true }).click();
  await expect(page.getByRole("radio", { name: "Cash", exact: true })).toBeChecked();
  const amount = page.getByRole("textbox", { name: "Amount (USD)", exact: true });
  await amount.fill("-9007199254740993.123456789");
  await expect(page.getByLabel("Exact input", { exact: true })).toHaveText(
    "-9007199254740993.123456789",
  );
  await amount.fill("0.");
  await expect(amount).toHaveValue("0.");
  const password = page.getByLabel("Password", { exact: true });
  await password.fill("fictional-password");
  await expect(password).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: /show password/i }).click();
  await expect(password).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: /hide password/i }).click();
  await expect(password).toHaveAttribute("type", "password");
});

test("calendar permits keyboard date selection and exposes a named popup", async ({ page }) => {
  await page.goto("/iframe.html?id=components-forms--review&viewMode=story");
  const input = page.getByRole("textbox", { name: "Posting date", exact: true });
  const before = await input.inputValue();
  await page.getByRole("button", { name: "Open calendar", exact: true }).first().click();
  const popup = page.locator('[data-scope="date-picker"][data-part="content"]').first();
  await expect(popup).toBeVisible();
  await expect(popup.locator('[data-part="table-cell-trigger"][data-focus]')).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(popup.locator('[data-part="table-cell-trigger"][data-focus]')).toHaveAttribute(
    "data-value",
    "2026-09-24",
  );
  await expect(popup.locator('[data-part="table-cell-trigger"][data-focus]')).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(input).not.toHaveValue(before);
  await expect(popup).toBeHidden();
  await page.getByRole("button", { name: "Open calendar", exact: true }).last().click();
  await expect(
    page.locator('[data-scope="date-picker"][data-part="content"]').last(),
  ).toBeVisible();
  await page.addScriptTag({ content: axe.source });
  expect(
    await page.evaluate(async () =>
      (await window.axe.run(document.querySelector("main") as HTMLElement)).violations.map(
        (violation) => violation.id,
      ),
    ),
  ).toEqual([]);
  await page.keyboard.press("Escape");
});

test("validation summary moves focus and correction preserves other answers", async ({ page }) => {
  await page.goto("/iframe.html?id=components-feedback--validation-recovery&viewMode=story");
  const description = page.getByRole("textbox", { name: "Description", exact: true });
  await description.fill("Keep this exact description");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.locator(".rt-error-summary")).toBeFocused();
  await page.getByRole("link", { name: "Enter a reference." }).click();
  const reference = page.getByRole("textbox", { name: "Reference", exact: true });
  await expect(reference).toBeFocused();
  await reference.fill("September adjustments");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(description).toHaveValue("Keep this exact description");
  await expect(page.getByRole("status").filter({ hasText: /\S/ })).toContainText(
    "Draft saved in this preview",
  );
  await expect(page.locator(".rt-error-summary")).toHaveCount(0);
});

test("nested Ark popup closes before its dialog, restores focus and passes open-state axe", async ({
  page,
}) => {
  await page.goto("/iframe.html?id=components-overlays--review&viewMode=story");
  const trigger = page.getByRole("button", { name: "Edit entry details", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Edit entry details", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Show accounts", exact: true }).click();
  await expect(page.getByRole("listbox", { name: "Account" })).toBeVisible();
  await page.addScriptTag({ content: axe.source });
  // An account option shows a second line under its name (where the account sits, or why it cannot be chosen); its
  // name is the name and the code, and the line is its description (aria-describedby). axe 4.14 reads that line as
  // part of the visible label (its label-in-name rule, on by default since then), which it is not: a voice command
  // says the name. The rule is off for this check alone.
  expect(
    await page.evaluate(async () =>
      (
        await window.axe.run(document.querySelector(".rt-dialog") as HTMLElement, {
          rules: { "label-content-name-mismatch": { enabled: false } },
        })
      ).violations.map((violation) => violation.id),
    ),
  ).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox", { name: "Account" })).toBeHidden();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("discard dialog starts on the safe action and reports the preview outcome", async ({
  page,
}) => {
  await page.goto("/iframe.html?id=components-overlays--review&viewMode=story");
  await page.getByRole("button", { name: "Discard draft", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "Discard this draft?", exact: true });
  await expect(dialog.getByRole("button", { name: "Keep editing" })).toBeFocused();
  await dialog.getByRole("button", { name: "Discard draft", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: /\S/ })).toContainText(
    "Preview draft discarded",
  );
});

test("unknown posting outcome permits status lookup, not another posting", async ({ page }) => {
  await page.goto("/iframe.html?id=components-feedback--unknown-outcome&viewMode=story");
  await expect(page.getByRole("status").filter({ hasText: /\S/ })).toContainText(
    "haven't confirmed",
  );
  // The workshop's theme switch is chrome, not a posting action.
  await expect(page.getByRole("button").filter({ hasNotText: "Dark theme" })).toHaveCount(1);
  await page.getByRole("button", { name: "Check posting status" }).click();
  await expect(page.getByRole("status").filter({ hasText: /\S/ })).toContainText(
    "Entry JRN-0044 was posted",
  );
});

test("register search, sorting, pagination, selection and empty recovery are functional", async ({
  page,
}) => {
  await page.goto("/iframe.html?id=patterns-register--review&viewMode=story");
  await expect(page.getByRole("button", { name: "Previous page" })).toBeDisabled();
  await page.getByRole("checkbox", { name: "Select page", exact: true }).locator("..").click();
  await expect(page.getByText("4 selected across pages", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.getByText("Page 2 of 2", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review selected" }).click();
  await expect(page.getByRole("status").filter({ hasText: /\S/ })).toContainText("JRN-0044");
  const search = page.getByRole("searchbox", { name: "Search transactions" });
  await search.fill("Office supplies");
  await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(1);
  await search.fill("no such entry");
  await expect(page.getByText("No transactions match", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await page.getByRole("button", { name: "Date", exact: true }).click();
  await expect(page.getByRole("columnheader", { name: "Date", exact: true })).toHaveAttribute(
    "aria-sort",
    "ascending",
  );
  await expect(page.getByRole("table").locator("tbody tr").first()).toContainText(
    "Opening balance adjustment",
  );
});

test("journal edits preserve focus and exact strings, invalidate fixture totals and keep posting disabled", async ({
  page,
}) => {
  await page.goto("/iframe.html?id=patterns-journal--review&viewMode=story");
  await expect(page.getByRole("button", { name: "Review posting" })).toBeEnabled();
  const debit = page.getByRole("textbox", { name: "Debit for line 1", exact: true });
  await debit.fill("");
  await debit.pressSequentially("9007199254740993.123456789");
  await expect(debit).toBeFocused();
  await expect(debit).toHaveValue("9007199254740993.123456789");
  await expect(page.getByText("Awaiting evaluation", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Review posting" })).toBeDisabled();
  await page.getByRole("button", { name: "Add line", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Debit for line 3", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove line 3", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add line", exact: true })).toBeFocused();
  await expect(debit).toHaveValue("9007199254740993.123456789");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: /\S/ })).toContainText("preview only");
});

test("balanced fixture can be reviewed, but unbalanced fixture cannot be posted", async ({
  page,
}) => {
  await page.goto("/iframe.html?id=patterns-journal--review&viewMode=story");
  await page.getByRole("button", { name: "Review posting" }).click();
  await expect(page.getByRole("dialog", { name: "Review this posting" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm preview posting" }).click();
  await expect(page.getByRole("status").filter({ hasText: /\S/ })).toContainText(
    "Preview entry posted",
  );
  await page.goto("/iframe.html?id=patterns-journal--unbalanced&viewMode=story");
  await expect(page.getByRole("button", { name: "Review posting" })).toBeDisabled();
  await expect(page.getByText(/difference of USD 8.40/)).toBeVisible();
});

test("report expansion and tab navigation retain their correct semantics", async ({ page }) => {
  await page.goto("/iframe.html?id=patterns-report--review&viewMode=story");
  await page.getByRole("button", { name: "Assets", exact: true }).click();
  await expect(page.getByRole("button", { name: "Assets", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(page.getByRole("rowheader", { name: "1000 · Cash", exact: true })).toHaveCount(0);
  await expect(page.locator("tfoot")).toContainText("2,578.40");
  await page.goto("/iframe.html?id=patterns-navigation--review&viewMode=story");
  await page.getByRole("tab", { name: "All entries" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Drafts" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "All entries" })).toBeHidden();
  await expect(page.getByRole("tabpanel", { name: "Drafts" })).toContainText(
    "Drafts have not been posted",
  );
});

test("catalog pages fit narrow viewports with table overflow contained", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const story of [
    "start-here-workshop--review",
    "foundations-system-rules--review",
    "foundations-logo--review",
    "components-forms--review",
    "components-overlays--review",
    "patterns-navigation--review",
    "patterns-register--review",
    "patterns-journal--review",
    "patterns-report--review",
  ]) {
    await page.goto(`/iframe.html?id=${story}&viewMode=story`);
    await expect(page.locator("main h1")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
      story,
    ).toBeLessThanOrEqual(390);
  }
});

test("reduced motion removes progress animation and forced colors retains control boundaries", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "active" });
  await page.goto("/iframe.html?id=components-feedback--review&viewMode=story");
  await expect(
    page.locator('[data-scope="progress"][data-state="indeterminate"] [data-part="range"]'),
  ).toHaveCSS("animation-name", "none");
  await page.goto("/iframe.html?id=components-overlays--review&viewMode=story");
  await expect(page.getByRole("button", { name: "Edit entry details" })).toHaveCSS(
    "border-top-width",
    "1px",
  );
});
