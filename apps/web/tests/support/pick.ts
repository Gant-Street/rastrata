/** Choose from one of the kit's lists as a person does: open it, then click the choice. The list is in the page
 * only while it is open, so the choice is looked for on the page, not in the field. A choice is named by what it
 * says; `{ value }` names it by what the page is given for it, and `{ index }` by its place, for a test whose
 * point is not the words. It is written against what a page and a locator can do, so the real browser's and the
 * simulated screen's both fit. It returns once the list is out of the page again: while a list closes it still
 * answers to its field's label, and the next thing a test asks of the field would find two.
 *
 * A screen may draw the field again while the click is on its way (a preview that follows the last choice): the
 * list is then not open, and it is opened again, as a person would. */
type Clickable = { click(): Promise<unknown> };
type List = Clickable & { getAttribute(name: string): Promise<string | null> };
type Shown = Clickable & {
  waitFor(options: { state: "visible" | "detached"; timeout?: number }): Promise<unknown>;
};
type Options = Shown & { nth(index: number): Shown };
type WithOptions = {
  getByRole(role: "option", options?: { name?: string | RegExp; exact?: boolean }): Options;
  locator(selector: string): Shown;
};

export type Choice = string | RegExp | { value: string } | { index: number };

export async function pick(page: WithOptions, list: List, choice: Choice): Promise<void> {
  const option =
    typeof choice === "string" || choice instanceof RegExp
      ? page.getByRole("option", { name: choice, exact: true })
      : "value" in choice
        ? page.locator(`[role="option"][data-value="${choice.value}"]`)
        : page.getByRole("option").nth(choice.index);
  for (let attempt = 1; ; attempt += 1) {
    if ((await list.getAttribute("aria-expanded")) !== "true") await list.click();
    try {
      await option.waitFor({ state: "visible", timeout: 3000 });
      break;
    } catch (cause) {
      if (attempt >= 3) throw cause;
    }
  }
  await option.click();
  await page.locator('[data-scope="select"][data-part="content"]').waitFor({ state: "detached" });
}

/** Put an open list away without choosing, and wait until it is out of the page. */
export async function putAway(
  page: WithOptions & { keyboard: { press(key: string): Promise<unknown> } },
) {
  await page.keyboard.press("Escape");
  await page.locator('[data-scope="select"][data-part="content"]').waitFor({ state: "detached" });
}
