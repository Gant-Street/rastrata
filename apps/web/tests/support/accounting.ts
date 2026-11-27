import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";

/** What a spec does on the accounting screens, said once: the row of the Transactions list that says
 * some text, and reversing its transaction (the menu at the end of the row, then the dialog). When a
 * screen's markup moves, this file changes and the specs do not. */

/** Turn a checkbox on or off the way a person does: by clicking what is drawn, its label. The input is clipped
 * to a pixel under the drawn box, so a click made on it (`check({ force: true })`) took in Chromium and left the
 * box as it was in Firefox and WebKit. */
export async function setChecked(
  scope: Page | Locator,
  name: string | RegExp,
  checked: boolean,
): Promise<void> {
  const box = scope.getByRole("checkbox", { name });
  if ((await box.isChecked()) !== checked) await box.locator("xpath=ancestor::label[1]").click();
  if (checked) await expect(box).toBeChecked();
  else await expect(box).not.toBeChecked();
}

/** Choose a radio button the way a person does: by clicking what is drawn, its label (see `setChecked`). */
export async function chooseRadio(scope: Page | Locator, name: string | RegExp): Promise<void> {
  const radio = scope.getByRole("radio", { name });
  if (!(await radio.isChecked())) await radio.locator("xpath=ancestor::label[1]").click();
  await expect(radio).toBeChecked();
}

/** A backup that has been taken and checked, as the Close the books checklist asks for before a month can
 * close ("Verify a backup"): the service answers each of the two with a job, and asking again with the same
 * operation id reads it until it is done. */
export async function takeVerifiedBackup(request: APIRequestContext): Promise<void> {
  for (const name of ["backup.create", "backup.verify"] as const) {
    const operationId = crypto.randomUUID();
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const response = await request.post(`/v1/${name}`, {
        data: { version: "rastrata-application-v1", bookId: "local-book", input: {}, operationId },
      });
      expect(response.ok(), `${name}: ${await response.text()}`).toBe(true);
      const job = (await response.json()).data as { state: string };
      if (job.state === "done") break;
      expect(job.state, `${name} did not finish`).toBe("running");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

/** The row of the Transactions list that says `text`. */
export const transactionRow = (page: Page, text: string | RegExp): Locator =>
  page.getByRole("table", { name: "Transactions" }).getByRole("row").filter({ hasText: text });

/** Open the reversal dialog of the transaction whose row says `text`: its menu, then Reverse. When `text`
 * says more than one row, `first` takes the topmost of them (the newest). */
export async function openReverse(
  page: Page,
  text: string | RegExp,
  options: { first?: boolean } = {},
): Promise<Locator> {
  const menus = transactionRow(page, text).getByRole("button", { name: /^Actions for / });
  await (options.first ? menus.first() : menus).click();
  await page.getByRole("menuitem", { name: "Reverse" }).click();
  const dialog = page.getByRole("dialog", { name: /^Reverse / });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Fill the reversal dialog: the date (when it is not the one it starts on) and the reason. */
export async function fillReverse(
  dialog: Locator,
  input: { date?: string; reason: string },
): Promise<void> {
  if (input.date) await dialog.getByRole("textbox", { name: /Reversal date/ }).fill(input.date);
  await dialog.getByRole("textbox", { name: /Reason/ }).fill(input.reason);
}
