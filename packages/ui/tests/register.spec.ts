import { expect, test } from "@playwright/test";

test.describe("TanStack register with Ark controls", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/iframe.html?id=patterns-register--review&viewMode=story");
  });

  test("selection uses entry IDs across pages, sorting and filtering", async ({ page }) => {
    const selectPage = page.getByRole("checkbox", { name: "Select page", exact: true });
    const first = page.getByRole("checkbox", { name: "Select JRN-0044", exact: true });
    await first.focus();
    await first.press("Space");
    await expect(first).toBeChecked();
    await expect(selectPage).toBeChecked({ indeterminate: true });
    await selectPage.locator("..").click();
    await expect(page.getByText("4 selected across pages", { exact: true })).toBeVisible();
    await expect(selectPage).toBeChecked();

    await page.getByRole("button", { name: "Next page" }).click();
    await expect(selectPage).not.toBeChecked();
    await page
      .getByRole("checkbox", { name: "Select JRN-0039", exact: true })
      .locator("..")
      .click();
    await expect(selectPage).toBeChecked({ indeterminate: true });
    await expect(page.getByText("5 selected across pages", { exact: true })).toBeVisible();

    const search = page.getByRole("searchbox", { name: "Search transactions" });
    await search.fill("office");
    await expect(selectPage).toBeChecked();
    await selectPage.locator("..").click();
    await expect(page.getByText("4 selected across pages", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Review selected" }).click();
    await expect(page.getByRole("status").filter({ hasText: /\S/ })).toContainText("JRN-0039");
    await expect(page.getByRole("status").filter({ hasText: /\S/ })).not.toContainText("JRN-0043");

    await search.fill("");
    await page.getByRole("button", { name: "Date", exact: true }).click();
    await expect(
      page.getByRole("checkbox", { name: "Select JRN-0039", exact: true }),
    ).toBeChecked();
    await page.getByRole("button", { name: "Clear selection" }).click();
    await expect(
      page.getByRole("checkbox", { name: "Select JRN-0039", exact: true }),
    ).not.toBeChecked();
    await expect(page.getByRole("button", { name: "Review selected" })).toHaveCount(0);
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(
      page.getByRole("checkbox", { name: "Select JRN-0044", exact: true }),
    ).not.toBeChecked();
  });

  test("sort and filter reset the page over the full fixture, not just visible rows", async ({
    page,
  }) => {
    const rows = page.getByRole("table").locator("tbody tr");
    const next = page.getByRole("button", { name: "Next page" });
    const previous = page.getByRole("button", { name: "Previous page" });
    await next.click();
    await expect(next).toBeDisabled();
    await expect(rows).toHaveCount(2);
    await page.getByRole("button", { name: "Date", exact: true }).click();
    await expect(page.getByText("Page 1 of 2", { exact: true })).toBeVisible();
    await expect(previous).toBeDisabled();
    await expect(rows.first()).toContainText("Opening balance adjustment");
    await expect(rows).toHaveCount(4);

    await next.click();
    const search = page.getByRole("searchbox", { name: "Search transactions" });
    await search.fill("OPENING");
    await expect(page.getByText("Page 1 of 1", { exact: true })).toBeVisible();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Opening balance adjustment");
    await expect(previous).toBeDisabled();
    await expect(next).toBeDisabled();
    await search.fill("no matching entry");
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(search).toHaveValue("");
    await expect(page.getByText("Page 1 of 2", { exact: true })).toBeVisible();
    await expect(rows).toHaveCount(4);
  });

  test("search is limited to identity/reference and amounts remain display strings", async ({
    page,
  }) => {
    const search = page.getByRole("searchbox", { name: "Search transactions" });
    await search.fill("JRN-0040");
    await expect(page.getByRole("cell", { name: "16,275.38", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Amount" })).toHaveCount(0);
    await search.fill("16,275.38");
    await expect(page.getByText("No transactions match", { exact: true })).toBeVisible();
    await search.fill("Posted");
    await expect(page.getByText("No transactions match", { exact: true })).toBeVisible();
  });
});

test("shared table presentation aligns exact amounts and exposes narrow-screen overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  for (const story of ["patterns-register--review", "start-here-workshop--review"]) {
    await page.goto(`/iframe.html?id=${story}&viewMode=story`);
    const region = page.getByRole("region", { name: /scroll horizontally/ });
    await expect(region).toBeVisible();
    await expect(region).toHaveCSS("overflow-x", "auto");
    await region.focus();
    await expect(region).toBeFocused();
    const table = region.getByRole("table");
    await expect(table).toHaveCSS("font-variant-numeric", "lining-nums tabular-nums");
    await expect(table.locator("td.rt-number").first()).toHaveCSS("text-align", "end");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      320,
    );
    // The rightmost amount must be reachable inside the scroll region, not clipped.
    await region.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    const bounds = await region.evaluate((element) => {
      const cell = element.querySelector("tbody tr td:last-child");
      if (!cell) throw new Error("Missing final amount cell");
      return {
        regionRight: element.getBoundingClientRect().right,
        cellRight: cell.getBoundingClientRect().right,
      };
    });
    expect(bounds.cellRight).toBeLessThanOrEqual(bounds.regionRight + 1);
  }
});
