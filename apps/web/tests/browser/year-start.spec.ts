import { expect, test } from "@playwright/test";
import { pick } from "../support/pick";
import { chooseRadio } from "../support/accounting";

/** Settings, Business: the month fiscal years start in can be changed until the first entry is posted.
 * The setup never asks for it, so this is how a business whose year starts in another month says so. */

const version = "rastrata-application-v1";

test("the fiscal year is changed in Settings, reviewed first, and is fixed once an entry is posted", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  await page.clock.setFixedTime(new Date("2026-04-02T12:00:00"));
  await page.goto("/");
  await page.getByRole("textbox", { name: "Business name" }).fill("October Studio");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await chooseRadio(page, "Other business");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Step 4 of 4/ })).toBeVisible();
  await page.getByRole("button", { name: "Create book", exact: true }).first().click();
  await expect(page.locator(".app-book-name")).toHaveText("October Studio");
  // The bank account this flow posts to: a template carries none, so it is added on the chart, as a person adds their own.
  await page.goto("/accounts");
  await page.getByRole("button", { name: "New account" }).click();
  const newAccount = page.getByRole("dialog", { name: "New account" });
  await newAccount.getByRole("textbox", { name: "Name" }).fill("Cash");
  await pick(page, newAccount.getByLabel("Type"), { value: "bank" });
  await newAccount.getByRole("textbox", { name: "Code" }).fill("1000");
  await newAccount.getByRole("button", { name: "Add account" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Added 1000 Cash." })).toBeVisible();

  // The page is drawn once and whole (src/opening.ts): from the moment the header is there, nothing is added to it. The name of the
  // business used to arrive after the navigation and push it sideways.
  await page.addInitScript(() => {
    const late: string[] = [];
    (window as unknown as { lateInHeader: string[] }).lateInHeader = late;
    let drawn = false;
    new MutationObserver((records) => {
      if (!drawn) {
        drawn = document.querySelector(".app-header") !== null;
        return;
      }
      for (const record of records) {
        const at = record.target instanceof Element ? record.target : record.target.parentElement;
        if (!at?.closest(".app-brand")) continue;
        for (const node of record.addedNodes) late.push(node.textContent ?? "");
      }
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Fiscal year", level: 2 })).toBeVisible();
  await expect(page.locator(".app-book-name")).toHaveText("October Studio");
  expect(
    await page.evaluate(() => (window as unknown as { lateInHeader: string[] }).lateInHeader),
  ).toEqual([]);
  await expect(
    page.getByText(
      "Your fiscal year starts in January. You can change it until you post your first entry.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Change fiscal year" }).click();
  // Nothing is chosen yet, so nothing can be reviewed.
  await expect(page.getByRole("button", { name: "Review" })).toBeDisabled();
  await pick(page, page.getByLabel("Fiscal year starts in"), { value: "10" });
  await page.getByRole("button", { name: "Review" }).click();
  await expect(page.getByText("Fiscal years will start in October")).toBeVisible();
  await expect(
    page.getByText(
      "The calendar will run from Oct 1, 2000 to Sep 30, 2027, 27 fiscal years. Nothing you have recorded changes.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Change fiscal year" }).click();
  await expect(page.getByText("Your fiscal year now starts in October.")).toBeVisible();
  // The facts of the book say it too, and the Periods screen has the new calendar.
  await expect(page.locator(".rt-fact", { hasText: "Fiscal year starts" })).toContainText(
    "October",
  );
  await page.goto("/periods");
  await page.getByRole("button", { name: "Calendar and history" }).click();
  await expect(page.getByText("Each fiscal year starts in October")).toBeVisible();

  // One entry fixes it: the choice is gone, and the facts still say October.
  const call = async (name: string, input: unknown) => {
    const response = await request.post(`/v1/${name}`, {
      data: { version, bookId: "local-book", input, operationId: crypto.randomUUID() },
    });
    expect(response.ok(), `${name}: ${await response.text()}`).toBe(true);
    return (await response.json()).data;
  };
  const draft = await call("drafts.create", {
    data: {
      date: "2026-03-10",
      reference: "FIRST",
      narration: "First entry",
      lines: [
        { accountId: "1000", debit: "10.00", credit: "" },
        { accountId: "4000", debit: "", credit: "10.00" },
      ],
    },
  });
  const plan = await call("journal.prepare", { draftId: draft.id, expectedVersion: draft.version });
  const posted = await call("operations.commit", { planId: plan.planId, planHash: plan.planHash });
  expect(posted.disposition).toBe("committed");
  await page.goto("/settings");
  await expect(page.locator(".rt-fact", { hasText: "Fiscal year starts" })).toContainText(
    "October",
  );
  await expect(page.getByRole("button", { name: "Change fiscal year" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Fiscal year", level: 2 })).toHaveCount(0);
});
