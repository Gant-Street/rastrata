import { expect, type Page, test } from "@playwright/test";
import axe from "axe-core";

declare global {
  interface Window {
    axe: typeof axe;
  }
}

// The catch-all components where they have to adapt, against invented data in Storybook: the notes on a
// month, the dialog that changes the account of transactions and the one that watches an account, at a
// phone's width and a desktop's, with what a bank wrote when it is long or is markup, and with the keyboard
// alone. (The whole flow against the real service is in apps/web, tests/browser/catchall.spec.ts, and every
// story is scanned in both themes by lane-stories.spec.ts, which scans the page and not the dialogs that open
// over it: those are scanned here.)
const story = (group: string, id: string) =>
  `/iframe.html?id=lanes-catchall-${group}--${id}&viewMode=story`;
const notes = (id: string) => story("notes-on-a-month", id);
const change = (id: string) => story("change-account", id);
const watch = (id: string) => story("watch-an-account", id);
const register = (id: string) => story("transactions-to-change", id);
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

/** True when the page does not scroll sideways: a table may scroll inside its own region, the page may not. */
const fits = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

const scan = async (page: Page, label: string) => {
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(async () =>
    (
      await window.axe.run(document.body, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      })
    ).violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })),
  );
  expect(violations, label).toEqual([]);
};

const theme = async (page: Page, value: "light" | "dark") => {
  await page.evaluate((next) => {
    document.documentElement.dataset.theme = next;
  }, value);
  await page.addStyleTag({
    content: "*,*::before,*::after{transition:none!important;animation:none!important}",
  });
};

for (const [id, label] of [
  ["money-collecting", "money collecting in one account"],
  ["expense-and-income", "an expense account and an income account"],
  ["could-not-be-checked", "an account that could not be checked"],
  ["beside-steps", "a note beside steps that are not done"],
  ["long-text", "a long name, a long text and large figures"],
] as const) {
  test(`notes: ${label} fit a phone and a desktop, in both themes, and pass the accessibility scan`, async ({
    page,
  }) => {
    for (const size of [PHONE, DESKTOP]) {
      await page.setViewportSize(size);
      await page.goto(notes(id));
      await expect(page.getByRole("region", { name: "Notes about this month" })).toBeVisible();
      expect(await fits(page), `${label} at ${size.width}`).toBe(true);
      // Each note stays inside the screen, whatever its text says.
      for (const article of await page.locator(".rt-close-note").all()) {
        const box = await article.boundingBox();
        expect((box?.x ?? 0) + (box?.width ?? 0), `${label} at ${size.width}`).toBeLessThanOrEqual(
          size.width,
        );
      }
      for (const mode of ["light", "dark"] as const) {
        await theme(page, mode);
        await scan(page, `${label} at ${size.width} (${mode})`);
      }
    }
  });
}

test("a note says it does not stop the close, links to the transactions by the account's name, and is not a step", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto(notes("expense-and-income"));
  const region = page.getByRole("region", { name: "Notes about this month" });
  await expect(
    region.getByRole("heading", { name: "Money is collecting in Other expenses" }),
  ).toBeVisible();
  await expect(region.getByText("This does not stop you closing the month.").first()).toBeVisible();
  // One link for each note, named by its account so that two of them can be told apart.
  await expect(region.getByRole("link")).toHaveCount(2);
  const link = region.getByRole("link", { name: "See these transactions in Other expenses" });
  await expect(link).toHaveAttribute(
    "href",
    "/journal?accountId=6290&from=2026-03-01&to=2026-03-31",
  );
  // The month can still be closed: the button is there and is not disabled by a note.
  await expect(page.getByRole("button", { name: "Close through March 2026" })).toBeEnabled();
  // Where the money went: a bank text nobody named is said to be one.
  await expect(region.getByText("not named yet").first()).toBeVisible();
  await expect(region.getByText("matches more than one payee")).toBeVisible();
});

test("an account that could not be checked says so and offers nothing it cannot back", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto(notes("could-not-be-checked"));
  const region = page.getByRole("region", { name: "Notes about this month" });
  await expect(
    region.getByRole("heading", { name: "Other expenses could not be checked" }),
  ).toBeVisible();
  await expect(region.getByRole("link")).toHaveCount(0);
  await expect(region.getByText("This does not stop you closing the month.")).toHaveCount(0);
  await expect(region.getByText("Your books have not been changed.")).toBeVisible();
});

test("what a bank wrote is text: markup is shown, and long text wraps inside its note", async ({
  page,
}) => {
  for (const size of [PHONE, DESKTOP]) {
    await page.setViewportSize(size);
    await page.goto(notes("long-text"));
    await expect(page.locator(".rt-close-notes script, .rt-close-notes img")).toHaveCount(0);
    await expect(
      page
        .locator(".rt-close-note-places")
        .getByText(/HYPERLINK/)
        .first(),
    ).toBeVisible();
    const places = page.locator(".rt-close-note-places li");
    for (let index = 0; index < (await places.count()); index++) {
      const box = await places.nth(index).boundingBox();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(size.width);
    }
  }
});

for (const [id, label] of [
  ["choose", "choosing the account"],
  ["choose-one", "choosing the account for one transaction"],
  ["more-selected-than-one-change-takes", "more selected than one change takes"],
  ["no-account-chosen", "no account chosen"],
  ["loading-accounts", "the accounts still being read"],
  ["accounts-failed", "the accounts that could not be read"],
  ["checking", "checking what would happen"],
  ["plan-all-will-move", "a plan where every transaction moves"],
  ["plan-some-cannot-move", "a plan where some cannot move"],
  ["plan-none-can-move", "a plan where none can move"],
  ["plan-with-a-warning", "a plan with a warning"],
  ["long-text", "long names and text from a bank"],
  ["many-rows", "sixty transactions"],
  ["working", "moving them"],
  ["done", "everything moved"],
  ["done-with-some-left-behind", "some left behind"],
  ["stopped", "a change that stopped"],
  ["plan-failed", "a plan that failed"],
  ["waiting-for-an-answer", "a request waiting for its answer"],
] as const) {
  test(`change account, ${label}: the dialog fits a phone and a desktop, in both themes, and passes the accessibility scan`, async ({
    page,
  }) => {
    for (const size of [PHONE, DESKTOP]) {
      await page.setViewportSize(size);
      await page.goto(change(id));
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      const box = await dialog.boundingBox();
      expect(box?.x ?? -1, `${label} at ${size.width}: left edge`).toBeGreaterThanOrEqual(0);
      expect(
        (box?.x ?? 0) + (box?.width ?? 0),
        `${label} at ${size.width}: right edge`,
      ).toBeLessThanOrEqual(size.width);
      expect(await fits(page)).toBe(true);
      for (const mode of ["light", "dark"] as const) {
        await theme(page, mode);
        await scan(page, `${label} at ${size.width} (${mode})`);
      }
    }
  });
}

test("a plan lists every transaction with where it is, where it goes or why it stays, and on a phone none of that is off the edge of the screen", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await page.goto(change("plan-some-cannot-move"));
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText(
      "3 of 6 transactions will move to Software and subscriptions. 3 cannot be moved.",
    ),
  ).toBeVisible();
  const table = dialog.getByRole("table", { name: "What will happen to each transaction" });
  await expect(table.locator("tbody tr")).toHaveCount(6);
  // What happens to each is under its description on a phone, so that none of it is off the screen.
  await expect(table.getByText("Will move").filter({ visible: true })).toHaveCount(3);
  await expect(table.getByText("Not moved").filter({ visible: true })).toHaveCount(3);
  await expect(
    table.getByText("This transaction is split across 2 accounts.").filter({ visible: true }),
  ).toBeVisible();
  await expect(table.getByText("February", { exact: false })).toHaveCount(0);
  expect(await fits(page)).toBe(true);
  const region = dialog.getByRole("region", {
    name: "The transactions and what will happen to each",
  });
  expect(
    await region.evaluate((element) => element.scrollWidth <= element.clientWidth),
    "the plan is wider than its region on a phone",
  ).toBe(true);
  await region.focus();
  await expect(region).toBeFocused();
  // The button that moves them says how many.
  await expect(dialog.getByRole("button", { name: "Move 3 transactions" })).toBeEnabled();
});

test("a plan where nothing can move offers no way to move it", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto(change("plan-none-can-move"));
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("This transaction cannot be moved to Software and subscriptions."),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Nothing to move" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Back" })).toBeEnabled();
});

test("a warning is said before the transactions are moved, in words about reconciling", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto(change("plan-with-a-warning"));
  const dialog = page.getByRole("dialog");
  const warning = dialog.getByRole("status").filter({ hasText: "Before you move them" });
  await expect(warning).toContainText("finished reconciliation");
  await expect(warning).toContainText("two more items to reconcile on the next statement");
});

test("text a bank wrote is shown as text in a plan, whatever it holds, and no longer than a line can hold", async ({
  page,
}) => {
  for (const size of [PHONE, DESKTOP]) {
    await page.setViewportSize(size);
    await page.goto(change("long-text"));
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/HYPERLINK/).first()).toBeVisible();
    await expect(dialog.locator("script, img")).toHaveCount(0);
    expect(await fits(page), `the page at ${size.width}`).toBe(true);
  }
});

test("a change that was only partly done says what is on the new account, what is not, and where each was left", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto(change("done-with-some-left-behind"));
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("2 transactions moved to Software and subscriptions."),
  ).toBeVisible();
  await expect(dialog.getByText("2 transactions were not moved:")).toBeVisible();
  await expect(dialog.getByText("Ready to post", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Done" })).toBeVisible();
});

test("a request waiting for its answer is resumed, not repeated: moving is not offered beside it", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto(change("waiting-for-an-answer"));
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Waiting for the answer")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Resume" })).toBeEnabled();
  // The progress bar would say something that is not true while nothing is moving.
  await expect(dialog.getByRole("progressbar")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByText("Resumed in this preview.")).toBeVisible();
});

test("choosing the account with the keyboard alone: the account is focused, typing finds it, Enter checks, Escape closes and gives focus back", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto(change("choose"));
  const account = page.getByRole("combobox", { name: /^Move to account/ });
  await expect(account).toBeFocused();
  await page.keyboard.type("soft");
  await expect(page.getByRole("option", { name: /Software and subscriptions/ })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(account).toHaveValue("Software and subscriptions");
  await page.keyboard.press("Tab");
  const reason = page.getByLabel("Reason");
  await expect(reason).toBeFocused();
  await page.keyboard.type("Software, not other");
  // Enter in the last field asks what would happen, as the button does.
  await page.keyboard.press("Enter");
  await expect(page.getByText("Checked in this preview.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Change account" })).toBeFocused();
});

test("the accounts a book has closed are listed but cannot be chosen", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto(change("choose"));
  const account = page.getByRole("combobox", { name: /^Move to account/ });
  await account.fill("old equipment");
  const option = page.getByRole("option", { name: /Old equipment rental/ });
  await expect(option).toBeVisible();
  await expect(option).toHaveAttribute("aria-disabled", "true");
});

for (const [id, label] of [
  ["watch-expenses", "watching an expense account"],
  ["watch-income", "watching an income account"],
  ["replaces-another-account", "watching one instead of another"],
  ["stop-watching", "stopping"],
  ["long-name", "a long name"],
  ["saving", "saving"],
  ["failed", "a refusal"],
  ["waiting-for-an-answer", "a request waiting for its answer"],
] as const) {
  test(`watch, ${label}: the dialog fits a phone and a desktop, in both themes, and passes the accessibility scan`, async ({
    page,
  }) => {
    for (const size of [PHONE, DESKTOP]) {
      await page.setViewportSize(size);
      await page.goto(watch(id));
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      const box = await dialog.boundingBox();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(size.width);
      expect(await fits(page)).toBe(true);
      for (const mode of ["light", "dark"] as const) {
        await theme(page, mode);
        await scan(page, `${label} at ${size.width} (${mode})`);
      }
    }
  });
}

test("watching says what the mark does before it is put on, and that nothing in the books changes", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto(watch("replaces-another-account"));
  const dialog = page.getByRole("dialog", { name: "Watch Other expenses" });
  await expect(dialog).toContainText("When you close a month, you will see how much was spent");
  await expect(dialog).toContainText("It never stops you closing a month.");
  await expect(dialog).toContainText(
    "Watching this account instead stops watching Miscellaneous expenses.",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("stopping says that nothing in the books changes, and Cancel is the first choice", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto(watch("stop-watching"));
  const dialog = page.getByRole("dialog", { name: "Stop watching Other expenses" });
  await expect(dialog).toContainText("Nothing in your books changes.");
  await expect(dialog.getByRole("button", { name: "Stop watching" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Stop watching" }).click();
  await expect(page.getByText("Saved in this preview.")).toBeVisible();
});

test("the list has a box only on a transaction that can change account, and ticking the page leaves the others out", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto(register("with-boxes"));
  const boxes = page.getByRole("checkbox", { name: /^Select No\./ });
  // The two entries that came from a bank, posted and not reversed.
  await expect(boxes).toHaveCount(2);
  await expect(page.getByRole("checkbox", { name: "Select No. 23" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select No. 22" })).toBeVisible();
  // A reversal, an entry typed by hand, a payout, an opening balance and a draft have none.
  for (const label of ["No. 24", "No. 18", "No. 21", "No. 1", "Draft"])
    await expect(page.getByRole("checkbox", { name: `Select ${label}` })).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Select page", exact: true }).locator("..").click();
  await expect(page.getByText("2 selected across pages", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Change account" }).click();
  await expect(page.getByText("Change account for 2 chosen in this preview.")).toBeVisible();
});

test("a person who may not move transactions is offered no boxes, and a page with nothing to move has no column of them", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  for (const id of ["not-allowed", "nothing-to-move"]) {
    await page.goto(register(id));
    await expect(page.getByRole("table")).toBeVisible();
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Change account" })).toHaveCount(0);
  }
});

test("ticking from the keyboard alone: Space ticks the row, the bar offers Change account, and it is the next stop", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto(register("with-boxes"));
  const first = page.getByRole("checkbox", { name: "Select No. 23" });
  await first.focus();
  await page.keyboard.press("Space");
  await expect(first).toBeChecked();
  await expect(page.getByText("1 selected across pages")).toBeVisible();
  const action = page.getByRole("button", { name: "Change account" });
  await action.focus();
  await expect(action).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Change account for 1 chosen in this preview.")).toBeVisible();
});

for (const id of ["with-boxes", "not-allowed", "nothing-to-move"]) {
  test(`transactions to change, ${id}: fit a phone, in both themes, and pass the accessibility scan with a row ticked`, async ({
    page,
  }) => {
    for (const size of [PHONE, DESKTOP]) {
      await page.setViewportSize(size);
      await page.goto(register(id));
      await expect(page.getByRole("table")).toBeVisible();
      if (id === "with-boxes")
        await page
          .getByRole("checkbox", { name: "Select No. 23", exact: true })
          .locator("..")
          .click();
      expect(await fits(page)).toBe(true);
      for (const mode of ["light", "dark"] as const) {
        await theme(page, mode);
        await scan(page, `${id} at ${size.width} (${mode})`);
      }
    }
  });
}
