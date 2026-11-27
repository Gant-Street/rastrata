import { expect, test } from "@playwright/test";
import axe from "axe-core";

declare global {
  interface Window {
    axe: typeof axe;
  }
}

test("successive saves use the last confirmed entry and retain both history events", async ({
  page,
}) => {
  await page.goto("/iframe.html?id=patterns-register--review&viewMode=story");
  // A row is named by what the entry says; saving a reference renames it.
  await page.getByRole("button", { name: "Workshop equipment", exact: true }).click();
  const reference = page.getByRole("textbox", { name: "Reference", exact: true });
  for (const value of ["First reference", "Second reference"]) {
    await reference.fill(value);
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await expect(page.getByText("Draft saved in this preview.", { exact: true })).toBeVisible();
  }
  for (const value of ["First reference", "Second reference"]) {
    await expect(page.getByText(`Draft reference saved: ${value}`, { exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Back to entries" }).click();
  await page.getByRole("button", { name: "Second reference", exact: true }).click();
  await expect(reference).toHaveValue("Second reference");
  await expect(
    page.getByText("Draft reference saved: First reference", { exact: true }),
  ).toBeVisible();
});

test("shared inspector preserves split lines, exact amounts, currency and supplied history", async ({
  page,
}) => {
  await page.goto("/iframe.html?id=patterns-register--split-entry&viewMode=story");
  await expect(page.getByRole("columnheader", { name: "Amount" })).toBeVisible();
  await page.getByRole("button", { name: "Equipment and supplies", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "EUR-001", exact: true });
  const lines = dialog.getByRole("table", { name: "Posted entry lines · EUR" });
  await expect(lines.locator("tbody tr")).toHaveCount(3);
  // A line is on one side: the other cell is blank, not a dash and not 0.00.
  await expect(lines.locator("tbody tr").nth(0).locator("td")).toHaveText([
    "9,007,199,254,740.93",
    "",
  ]);
  await expect(lines.locator("tbody tr").nth(1).locator("td")).toHaveText(["0.10", ""]);
  await expect(lines.locator("tbody tr").nth(2).locator("td")).toHaveText([
    "",
    "9,007,199,254,741.03",
  ]);
  await expect(lines.locator("tbody th")).toHaveText([
    "1500 · Equipment",
    "6100 · Office expenses",
    "2000 · Accounts payable",
  ]);
  await expect(lines.locator("tfoot td").first()).toHaveText("9,007,199,254,741.03");
  await expect(dialog.getByText("Imported by Finance team")).toBeVisible();
  await expect(dialog.getByText(/Alex Morgan|USD/)).toHaveCount(0);
  await expect(dialog.getByRole("textbox", { name: "Reference", exact: true })).toHaveAttribute(
    "readonly",
    "",
  );
  await expect(dialog.getByRole("button", { name: "Save draft" })).toHaveCount(0);
});

test("an uncertain save preserves the reference without offering blind retry", async ({ page }) => {
  await page.goto("/iframe.html?id=patterns-register--unknown-save&viewMode=story");
  await page.getByRole("button", { name: "Workshop equipment", exact: true }).click();
  const reference = page.getByRole("textbox", { name: "Reference", exact: true });
  await reference.fill("Awaiting confirmation");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    page
      .getByRole("dialog", { name: "JRN-0044", exact: true })
      .locator("form")
      .getByText("Save outcome not confirmed", { exact: true }),
  ).toBeVisible();
  await expect(reference).toHaveValue("Awaiting confirmation");
  await expect(reference).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Back to entries" }).click();
  const leave = page.getByRole("alertdialog");
  await expect(leave.getByText("Save outcome not confirmed", { exact: true })).toBeVisible();
  await expect(leave.getByRole("button", { name: "Save and leave" })).toBeDisabled();
});

for (const theme of ["light", "dark"] as const) {
  test(`selected register rows keep link and text contrast (${theme})`, async ({ page }) => {
    await page.goto(
      `/iframe.html?id=patterns-register--review&viewMode=story&globals=theme:${theme}`,
    );
    await page.locator('[data-scope="checkbox"][data-part="control"]').nth(1).click();
    await expect(page.locator(".rt-register-row-selected")).toHaveCount(1);
    await page.addScriptTag({ content: axe.source });
    const violations = await page.evaluate(
      async () =>
        (await window.axe.run(document.querySelector("#storybook-root") as HTMLElement)).violations,
    );
    expect(
      violations.map(({ id, nodes }) => ({ id, targets: nodes.map((n) => n.target) })),
    ).toEqual([]);
  });
}
