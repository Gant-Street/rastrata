import { expect, test, type Page } from "@playwright/test";

// The kit's date field (Ark's date picker) in the workshop: what is typed, what is picked, and what the
// screen is told.
const story = (id: string) => `/iframe.html?id=lanes-uxkit-datefield--${id}&viewMode=story`;
const box = (page: Page) => page.getByRole("textbox", { name: "Date" });
const stored = (page: Page) => page.getByLabel("Value");
/** Two frames: after a date is kept, the picker writes it back into the box a moment later, and a test that
 * types the next one at once (no person can) would have it written over. */
const settled = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

test("the box shows the date in numbers, month first, and the screen has the stored form", async ({
  page,
}) => {
  await page.goto(story("default"));
  await expect(box(page)).toHaveValue("10/04/2026");
  await expect(stored(page)).toHaveText("Stored as 2026-10-04.");
});

test("a date is typed the short ways people type one, and is kept when the box is left", async ({
  page,
}) => {
  await page.goto(story("default"));
  // A date typed without a year is in this year.
  const year = new Date().getFullYear();
  for (const [typed, shown, kept] of [
    ["10/5", `10/05/${year}`, `${year}-10-05`],
    ["10/6/26", "10/06/2026", "2026-10-06"],
    ["1007", `10/07/${year}`, `${year}-10-07`],
    ["100826", "10/08/2026", "2026-10-08"],
    // The stored form: its dashes are not typed, and what is left is still read.
    ["2026-10-09", "10/09/2026", "2026-10-09"],
  ] as const) {
    await box(page).fill(typed);
    await box(page).blur();
    await expect(box(page)).toHaveValue(shown);
    await expect(stored(page)).toHaveText(`Stored as ${kept}.`);
    await settled(page);
  }
  // Enter keeps it too, without leaving the box.
  await box(page).fill("10/12/26");
  await page.keyboard.press("Enter");
  await expect(stored(page)).toHaveText("Stored as 2026-10-12.");
  // Emptied, there is no date.
  await box(page).fill("");
  await box(page).blur();
  await expect(stored(page)).toHaveText("No date.");
});

test("letters cannot be typed, and a day that does not exist changes nothing", async ({ page }) => {
  await page.goto(story("default"));
  await box(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type("abc");
  await expect(box(page)).toHaveValue("10/04/2026");
  await box(page).fill("2/30/2026");
  await box(page).blur();
  await expect(box(page)).toHaveValue("10/04/2026");
  await expect(stored(page)).toHaveText("Stored as 2026-10-04.");
});

test("text that is no date never becomes one: an empty field stays empty", async ({ page }) => {
  await page.goto(story("empty"));
  for (const typed of ["45", "13/45", "2/30/2026"]) {
    await box(page).fill(typed);
    await box(page).blur();
    await expect(box(page)).toHaveValue("");
    await expect(stored(page)).toHaveText("No date.");
    await box(page).fill(typed);
    await page.keyboard.press("Enter");
    await expect(box(page)).toHaveValue("");
    await expect(stored(page)).toHaveText("No date.");
  }
  // The same day written another way is the same date, and the box writes it out in full.
  await page.goto(story("default"));
  await box(page).fill("10/4/26");
  await box(page).blur();
  await expect(box(page)).toHaveValue("10/04/2026");
  await expect(stored(page)).toHaveText("Stored as 2026-10-04.");
});

test("the screen has the date as it is typed, and the box is not written again until it is left", async ({
  page,
}) => {
  await page.goto(story("default"));
  const year = new Date().getFullYear();
  await box(page).fill("");
  await expect(stored(page)).toHaveText("No date.");
  // (At once after the box is emptied, which no person can do: the box is theirs all the same.)
  await box(page).pressSequentially("10/1");
  await expect(stored(page)).toHaveText(`Stored as ${year}-10-01.`);
  await settled(page);
  // Half a date that already reads as one is not finished for the person.
  await expect(box(page)).toHaveValue("10/1");
  await box(page).pressSequentially("5");
  await expect(stored(page)).toHaveText(`Stored as ${year}-10-15.`);
  await settled(page);
  await expect(box(page)).toHaveValue("10/15");
  // A day changed in the middle of a date keeps its place.
  await box(page).fill("10/04/2026");
  await settled(page);
  await box(page).evaluate((input: HTMLInputElement) => input.setSelectionRange(3, 5));
  await page.keyboard.type("1");
  await expect(stored(page)).toHaveText("Stored as 2026-10-01.");
  await settled(page);
  await page.keyboard.type("2");
  await expect(stored(page)).toHaveText("Stored as 2026-10-12.");
  await box(page).blur();
  await expect(box(page)).toHaveValue("10/12/2026");
});

test("words typed over a selection made a frame after the last key replace the old ones: the cursor is not put back where it was", async ({
  page,
}) => {
  await page.goto(story("default"));
  await expect(box(page)).toHaveValue("10/04/2026");
  // A program (an agent, a test) selects all and types again a frame after the last key, while the box still holds its hold on the cursor: the old words were kept, the new ones appended to them.
  const value = await page.evaluate(async () => {
    const input = document.querySelector<HTMLInputElement>("input.rt-input");
    if (!input) throw new Error("no box");
    const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));
    input.focus();
    input.select();
    document.execCommand("insertText", false, "10/5");
    input.select();
    await frame();
    document.execCommand("insertText", false, "11/6/26");
    await frame();
    await frame();
    return input.value;
  });
  expect(value).toBe("11/6/26");
});

test("a date typed and then left is the date typed, even when the picker wrote the box over in between", async ({
  page,
}) => {
  await page.goto(story("default"));
  await expect(box(page)).toHaveValue("10/04/2026");
  await page.evaluate(async () => {
    const input = document.querySelector<HTMLInputElement>("input.rt-input");
    if (!input) throw new Error("no box");
    const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));
    input.focus();
    input.select();
    document.execCommand("insertText", false, "11/6/26");
    // The box is written back with the date the picker had, some frames after the last key (later on a slow computer), and the box is left at once.
    await frame();
    await frame();
    await frame();
    await frame();
    input.value = "10/04/2026";
    input.blur();
  });
  await expect(stored(page)).toHaveText("Stored as 2026-11-06.");
  await expect(box(page)).toHaveValue("11/06/2026");
});

test("a date field adds no alert to the page", async ({ page }) => {
  await page.goto(story("in-a-form"));
  await expect(box(page)).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("Enter in the box keeps the date and submits the form, as in any field", async ({ page }) => {
  await page.goto(story("in-a-form"));
  await expect(page.getByLabel("Saved")).toHaveText("Not saved.");
  await box(page).fill("11/2/26");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Saved")).toHaveText("Saved with 2026-11-02.");
  await expect(box(page)).toHaveValue("11/02/2026");
});

test("a day is picked from the calendar, which opens on the date's month and closes on the choice", async ({
  page,
}) => {
  await page.goto(story("default"));
  await page.getByRole("button", { name: "Open calendar" }).click();
  await expect(page.getByText("October 2026")).toBeVisible();
  await page.getByRole("button", { name: /October 15, 2026/ }).click();
  await expect(page.getByText("October 2026")).toBeHidden();
  await expect(box(page)).toHaveValue("10/15/2026");
  await expect(stored(page)).toHaveText("Stored as 2026-10-15.");
  // Escape puts the calendar away without a choice.
  await page.getByRole("button", { name: "Open calendar" }).click();
  await expect(page.getByText("October 2026")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("October 2026")).toBeHidden();
  await expect(stored(page)).toHaveText("Stored as 2026-10-15.");
});

test("a day outside the book's calendar cannot be picked; typed, it is kept for the screen to speak of", async ({
  page,
}) => {
  await page.goto(story("bounded"));
  await page.getByRole("button", { name: "Open calendar" }).click();
  await expect(page.getByRole("button", { name: /October 25, 2026/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: /October 15, 2026/ })).toBeEnabled();
  await page.keyboard.press("Escape");
  await box(page).fill("11/30/2026");
  await box(page).blur();
  await expect(stored(page)).toHaveText("Stored as 2026-11-30.");
});

test("Tab goes from the box to the next field: the calendar's button is the pointer's", async ({
  page,
}) => {
  await page.goto(story("in-a-form"));
  await box(page).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("textbox", { name: "Description" })).toBeFocused();
});
