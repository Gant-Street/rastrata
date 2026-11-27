import { expect, type Page } from "@playwright/test";

/** What a spec does on the new-entry form, said once: choose an account for a line, fill the whole entry, and
 * post it. When the form's markup moves, this file changes and the specs do not. */

/** Choose the account with this code for a line: type the code, pick the option. The list opens and settles under
 * the box as it is typed in, so a pick that finds it still moving is made again from the typing. The box is
 * brought into view first: the list is hidden while the box it hangs from is off the screen (and WebKit does not
 * scroll to a box that is only typed into), as it is when the page was scrolled down to a screenshot just before. */
export async function chooseAccount(page: Page, line: number, code: string): Promise<void> {
  const box = page.getByRole("combobox", { name: `Account for line ${line}` });
  const option = page.getByRole("option", { name: new RegExp(`, ${code}$`) });
  for (let attempt = 1; ; attempt += 1) {
    await box.scrollIntoViewIfNeeded();
    await box.fill(code);
    try {
      await option.click({ timeout: 5000 });
      break;
    } catch (cause) {
      if (attempt >= 3) throw cause;
    }
  }
  await expect(box).not.toHaveValue(code);
}

export interface EntryFields {
  /** `YYYY-MM-DD`; left out, the date the form starts on. */
  date?: string;
  description?: string;
  reference?: string;
  /** Each line: the account's code and one side. */
  lines: readonly { code: string; debit?: string; credit?: string }[];
}

/** Fill the form: the fields, then a line for each entry (the form starts with two). */
export async function fillEntry(page: Page, entry: EntryFields): Promise<void> {
  if (entry.date) await page.getByRole("textbox", { name: /^Date/ }).fill(entry.date);
  if (entry.description !== undefined)
    await page.getByRole("textbox", { name: /^Description/ }).fill(entry.description);
  if (entry.reference !== undefined)
    await page.getByRole("textbox", { name: /^Reference/ }).fill(entry.reference);
  for (let extra = 2; extra < entry.lines.length; extra += 1)
    await page.getByRole("button", { name: "Add line" }).click();
  for (const [index, line] of entry.lines.entries()) {
    const number = index + 1;
    await chooseAccount(page, number, line.code);
    if (line.debit !== undefined)
      await page.getByRole("textbox", { name: `Debit for line ${number}` }).fill(line.debit);
    if (line.credit !== undefined)
      await page.getByRole("textbox", { name: `Credit for line ${number}` }).fill(line.credit);
  }
}

/** The bar at the foot of the form: totals, Cancel, Save draft and Post. */
export const entryBar = (page: Page) =>
  page.getByRole("group", { name: "Entry totals and actions" });

/** Post the entry: one click, and the list opens with the entry on it. */
export async function postEntry(page: Page): Promise<void> {
  await entryBar(page).getByRole("button", { name: "Post", exact: true }).click();
}
