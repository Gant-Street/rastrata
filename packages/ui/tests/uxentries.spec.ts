import { expect, test, type Locator, type Page } from "@playwright/test";
import { shown } from "./support/shown";

// Spend money, Receive money, Transfer and the Business form against fictional data in Storybook: the
// behaviour a sweep does not reach (keyboard, what a refusal keeps, what is posted and what is not). Every
// story is also swept in both themes by lane-stories.spec.ts.
const story = (id: string) => `/iframe.html?id=${id}&viewMode=story`;
const SPEND = "lanes-uxentries-quickentry--spend-money";

/** What the dialog's Post and Save draft buttons did, as the harness records it: it closes on either. */
const dialog = (page: Page) => page.getByRole("dialog");

/** Safari on a Mac does not Tab to buttons and links unless asked to; Option-Tab is its way through
 * everything, so that is the key for the order a person's Tab takes in the other browsers. */
const tabKey = (browserName: string) =>
  browserName === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab";

/** Choose an account from the keyboard: focus the box, type, move to the match, choose it. */
async function choose(box: Locator, text: string) {
  await box.focus();
  await box.fill(text);
  await box.press("ArrowDown");
  await box.press("Enter");
  // The list closes and the box takes focus back a moment after the choice; wait for that, or the next
  // field's text would be typed into this one on a busy machine.
  await expect(box).toHaveAttribute("aria-expanded", "false");
  await expect(box).toBeFocused();
}

test.describe("the dialogs", () => {
  test("the one form has a switch for its kind, and changing it keeps what was typed where it still fits", async ({
    page,
  }) => {
    await page.goto(story("lanes-uxentries-quickentry--transaction"));
    const form = page.getByRole("dialog", { name: "New transaction" });
    const kinds = form.getByRole("radiogroup", { name: "Kind of transaction" });
    await expect(kinds.getByRole("radio")).toHaveCount(3);
    await expect(kinds.getByRole("radio", { name: "Spend money", exact: true })).toBeChecked();
    // Focus still starts on the date: the kind it opens on is the common one.
    await expect(form.getByLabel("Date")).toBeFocused();
    await form.getByLabel("Amount").fill("25");
    await form.getByLabel("Description").fill("Lunch with a client");
    await expect(form.getByRole("combobox", { name: /^Paid from/ })).toBeVisible();

    await kinds.getByText("Receive money", { exact: true }).click();
    await expect(kinds.getByRole("radio", { name: "Receive money", exact: true })).toBeChecked();
    await expect(form.getByRole("combobox", { name: /^Deposit to/ })).toBeVisible();
    await expect(form.getByRole("combobox", { name: /^Paid from/ })).toHaveCount(0);
    await expect(form.getByLabel("Received from")).toBeVisible();
    // (The amount is written out in full when the cursor leaves it: "25" is "25.00".)
    await expect(form.getByLabel("Amount")).toHaveValue("25.00");
    await expect(form.getByLabel("Description")).toHaveValue("Lunch with a client");

    // A transfer names nobody: two of the person's own accounts.
    await kinds.getByText("Transfer", { exact: true }).click();
    await expect(form.getByRole("combobox", { name: /^From/ })).toBeVisible();
    await expect(form.getByRole("combobox", { name: /^To/ })).toBeVisible();
    await expect(form.getByLabel("Received from")).toHaveCount(0);
    await expect(form.getByLabel("Amount")).toHaveValue("25.00");

    // From the keyboard it is a radio group: the arrows move the choice.
    await kinds.getByRole("radio", { name: "Transfer", exact: true }).focus();
    await page.keyboard.press("ArrowLeft");
    await expect(kinds.getByRole("radio", { name: "Receive money", exact: true })).toBeChecked();
  });

  test("focus starts on the date, and Tab visits the fields in the order a person says them", async ({
    page,
    browserName,
  }) => {
    await page.goto(story(SPEND));
    await expect(dialog(page).getByLabel("Date")).toBeFocused();
    const order: string[] = [];
    for (let step = 0; step < 24 && order.length < 12; step++) {
      await page.keyboard.press(tabKey(browserName));
      const name = await page.evaluate(() => {
        const element = document.activeElement as HTMLElement | null;
        const label = (element as HTMLInputElement | null)?.labels?.[0]?.textContent;
        return (label ?? element?.textContent ?? "").replace(/\s+/g, " ").trim();
      });
      if (/^(Paid from|Paid to|Category|Amount|Description|Cancel|Save draft|Post)/.test(name))
        order.push(name.replace(/ \(required\)$/, ""));
    }
    expect(order.slice(0, 8)).toEqual([
      "Paid from",
      "Paid to",
      "Category",
      "Amount",
      "Description",
      "Cancel",
      "Save draft",
      "Post",
    ]);
  });

  test("the date starts on today, is typed the short way, and is kept when the box is left", async ({
    page,
  }) => {
    await page.goto(story(SPEND));
    const date = dialog(page).getByLabel("Date");
    await expect(date).toHaveValue(shown.dateBox("2026-10-04"));
    await date.fill("3/9/26");
    await date.blur();
    await expect(date).toHaveValue(shown.dateBox("2026-03-09"));
  });

  test("Enter in an open list chooses an account and posts nothing; Enter in a field posts", async ({
    page,
  }) => {
    await page.goto(story(SPEND));
    const from = dialog(page).getByRole("combobox", { name: /Paid from/ });
    await choose(from, "Business check");
    await expect(from).toHaveValue("Business checking");
    // The dialog is still open: choosing is not posting.
    await expect(dialog(page)).toBeVisible();
    await choose(dialog(page).getByRole("combobox", { name: /Category/ }), "Software");
    await dialog(page).getByLabel("Amount").fill("25");
    await expect(
      dialog(page).getByRole("region", { name: "This will record" }).getByRole("listitem"),
    ).toHaveCount(2);
    await dialog(page).getByLabel("Description").press("Enter");
    await expect(dialog(page)).toBeHidden();
  });

  test("the line that says what will be recorded follows the fields, in plain words and never as debit and credit", async ({
    page,
  }) => {
    await page.goto(story(SPEND));
    const region = dialog(page).getByRole("region", { name: "This will record" });
    await expect(region).toContainText("Choose the accounts and an amount");
    await choose(dialog(page).getByRole("combobox", { name: /Paid from/ }), "Business check");
    await choose(dialog(page).getByRole("combobox", { name: /Category/ }), "Software");
    await dialog(page).getByLabel("Amount").fill("1,250.5");
    await expect(region.getByRole("listitem")).toHaveText(
      [/Software and subscriptions\s*\+1,250\.50/, /Business checking\s*.1,250\.50/],
      { useInnerText: true },
    );
    await expect(region).not.toContainText(/debit|credit/i);
  });

  test("a preset fills the category and says what it is; pressed again it lets go of it", async ({
    page,
  }) => {
    await page.goto(story(SPEND));
    const preset = dialog(page).getByRole("button", { name: "Owner took money out" });
    const category = dialog(page).getByRole("combobox", { name: /Category/ });
    await expect(preset).toHaveAttribute("aria-pressed", "false");
    await preset.click();
    await expect(preset).toHaveAttribute("aria-pressed", "true");
    await expect(category).toHaveValue("Owner's draw");
    await expect(dialog(page).getByLabel("Description")).toHaveValue("Owner took money out");
    await expect(dialog(page).getByText(/not as an expense/)).toBeVisible();
    await preset.click();
    await expect(preset).toHaveAttribute("aria-pressed", "false");
    await expect(category).toHaveValue("");
  });

  test("a preset asked for when the dialog opens is already in the category", async ({ page }) => {
    await page.goto(story("lanes-uxentries-quickentry--owner-took-money-out"));
    await expect(dialog(page).getByRole("combobox", { name: /Category/ })).toHaveValue(
      "Owner's draw",
    );
  });

  test("a chart with no account for the preset says so and leaves the choice", async ({ page }) => {
    await page.goto(story("lanes-uxentries-quickentry--preset-without-an-account"));
    await expect(dialog(page).getByText(/none of your accounts is named for it/)).toBeVisible();
    await expect(dialog(page).getByRole("combobox", { name: /Category/ })).toHaveValue("");
  });

  test("Post with nothing filled in lists what is missing, focuses the list, and each link goes to its field", async ({
    page,
  }) => {
    await page.goto(story(SPEND));
    await dialog(page).getByRole("button", { name: "Post" }).click();
    const summary = dialog(page).getByRole("region", { name: "Fix these before you continue" });
    await expect(summary).toBeFocused();
    await expect(summary.getByRole("link")).toHaveCount(3);
    await summary.getByRole("link", { name: /Enter an amount/ }).click();
    await expect(dialog(page).getByLabel("Amount")).toBeFocused();
    await summary.getByRole("link", { name: "Choose the account you paid from." }).click();
    await expect(dialog(page).getByRole("combobox", { name: /Paid from/ })).toBeFocused();
    // The box says what is wrong with it, and is marked as wrong.
    await expect(dialog(page).getByRole("combobox", { name: /Paid from/ })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  test("a minus sign, three decimals and zero are each refused with what to do", async ({
    page,
  }) => {
    await page.goto(story(SPEND));
    const amount = dialog(page).getByLabel("Amount");
    for (const [typed, said] of [
      ["-5", /without a minus sign/],
      ["1.234", /at most two decimal places/],
      ["0", /more than 0\.00/],
    ] as const) {
      await amount.fill(typed);
      await dialog(page).getByRole("button", { name: "Post" }).click();
      await expect(dialog(page).getByText(said).first()).toBeVisible();
    }
    // The dialog stayed open with what was typed.
    await expect(amount).toHaveValue("0");
  });

  test("a click outside does not close it; Escape does", async ({ page }) => {
    await page.goto(story(SPEND));
    await dialog(page).getByLabel("Amount").fill("5");
    await page.mouse.click(4, 4);
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeHidden();
  });

  test("while a save is under way neither button can be pressed twice and the fields wait", async ({
    page,
  }) => {
    await page.goto(story("lanes-uxentries-quickentry--posting"));
    await expect(dialog(page).getByRole("button", { name: /Posting/ })).toBeDisabled();
    await expect(dialog(page).getByRole("button", { name: "Save draft" })).toBeDisabled();
    await expect(dialog(page).getByLabel("Amount")).toBeDisabled();
  });

  test("a refusal is said in the books' words, and the form keeps what was typed", async ({
    page,
  }) => {
    await page.goto(story("lanes-uxentries-quickentry--refused"));
    await expect(dialog(page).getByRole("alert")).toContainText("is closed");
    await expect(dialog(page).getByRole("button", { name: "Post" })).toBeEnabled();
  });

  test("a reply that was lost offers to resume the original request, and nothing else is offered as a retry", async ({
    page,
  }) => {
    await page.goto(story("lanes-uxentries-quickentry--reply-lost"));
    await expect(dialog(page).getByText(/may not have finished/)).toBeVisible();
    await expect(
      dialog(page).getByRole("button", { name: "Resume original request" }),
    ).toBeVisible();
  });

  test("accounts that cannot be chosen are not offered: a group, a closed account, the other side", async ({
    page,
  }) => {
    await page.goto(story("lanes-uxentries-quickentry--transfer"));
    const from = dialog(page).getByRole("combobox", { name: /From/ });
    await choose(from, "Business check");
    const to = dialog(page).getByRole("combobox", { name: /^To/ });
    await to.focus();
    await to.press("ArrowDown");
    // The list opens a moment after the key; read it once it is there.
    await expect(page.getByRole("option", { name: /Business savings/ })).toBeVisible();
    const offered = (await page.getByRole("option").allInnerTexts()).join(" ");
    expect(offered).not.toContain("Business checking");
    expect(offered).not.toContain("Operating expenses");
    expect(offered).not.toContain("Old account");
  });

  test("the dialog never scrolls sideways, on a phone with a long chart and long names", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(story("lanes-uxentries-quickentry--long-names"));
    await page.evaluate(() => document.fonts.ready);
    await expect(dialog(page)).toBeVisible();
    // It is measured once it has settled: the dialog is in its place when it is inside the window.
    await expect
      .poll(async () => {
        const box = await dialog(page).boundingBox();
        return box !== null && box.x >= 0 && box.x + box.width <= 390;
      })
      .toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    // The buttons stay in view while the fields scroll.
    await expect(dialog(page).getByRole("button", { name: "Post" })).toBeInViewport();
  });
});

test.describe("the Business form", () => {
  const BUSINESS = "lanes-uxentries-businesssettings--default";

  test("there is nothing to save until something changes, and a name that is too short is refused where it is typed", async ({
    page,
  }) => {
    await page.goto(story(BUSINESS));
    const save = page.getByRole("button", { name: "Save changes" });
    await expect(save).toBeDisabled();
    const name = page.getByLabel("Business name");
    await name.fill("W");
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByText("Enter a name of at least two characters.").first()).toBeVisible();
    await expect(name).toHaveAttribute("aria-invalid", "true");
  });

  test("the name, the date format, account numbers and what Accept does are each a control of their own, in that order", async ({
    page,
    browserName,
  }) => {
    await page.goto(story(BUSINESS));
    await page.getByLabel("Business name").focus();
    for (const next of [
      page.getByRole("combobox", { name: "Date format" }),
      page.getByRole("checkbox", { name: /Show account numbers/ }),
      page.getByRole("combobox", { name: "When I accept a suggestion" }),
    ]) {
      await page.keyboard.press(tabKey(browserName));
      await expect(next).toBeFocused();
    }
  });

  test("saving hands the parent only what changed, and the form says it was saved", async ({
    page,
  }) => {
    await page.goto(story(BUSINESS));
    await page.getByLabel("Business name").fill("Willow Lane Studio LLC");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  test("a save whose reply was lost offers to resume the original request", async ({ page }) => {
    await page.goto(story("lanes-uxentries-businesssettings--reply-lost"));
    await expect(page.getByRole("button", { name: "Resume original request" })).toBeVisible();
  });
});
