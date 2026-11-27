import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";
import { shown } from "./support/shown";
import { pick, putAway } from "./support/pick";

// The UX kit's two pickers against fictional data in Storybook: AccountPicker and DateRangeField. (Every
// story is also swept in both themes by lane-stories.spec.ts; these are the open states and the keyboard.)
const story = (id: string, theme?: "light" | "dark") =>
  `/iframe.html?id=${id}&viewMode=story${theme ? `&globals=theme:${theme}` : ""}`;

declare global {
  interface Window {
    axe: typeof axe;
  }
}

async function expectNoViolations(page: Page, label: string): Promise<void> {
  // A scan reads the colours on screen at that moment, and a colour that is still moving to its place (the
  // option that has just been highlighted) is neither the one before nor the one after: WebKit reported
  // color-contrast for it when the scan landed halfway. So the scan runs with transitions and animations off.
  await page.addStyleTag({
    content: "*, *::before, *::after { transition: none !important; animation: none !important; }",
  });
  await page.addScriptTag({ content: axe.source });
  const result = await page.evaluate(() =>
    window.axe.run(document.querySelector("#storybook-root") as HTMLElement, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
    }),
  );
  expect(
    result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })),
    label,
  ).toEqual([]);
}

/** Whether the page is as wide as the window, measured once the fonts are in and a frame has passed. */
const noSidewaysScroll = async (page: Page): Promise<boolean> => {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
  return page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
};

// ---- AccountPicker ------------------------------------------------------------------------------------

const picker = (page: Page, name = "Account") => page.getByRole("combobox", { name, exact: true });
const option = (page: Page, name: string) => page.getByRole("option", { name, exact: true });

test.describe("AccountPicker", () => {
  test("it matches the name, the code and where an account sits, in any order, best first", async ({
    page,
  }) => {
    await page.goto(story("lanes-uxkit-accountpicker--default"));
    const input = picker(page);
    await input.fill("chec");
    await expect(page.getByRole("option")).toHaveCount(1);
    await expect(option(page, "Business checking, 1000")).toBeVisible();

    await input.fill("bus chec");
    await expect(page.getByRole("option")).toHaveCount(1);

    await input.fill("6100");
    await expect(option(page, "Office supplies, 6100")).toBeVisible();
    await expect(page.getByRole("option")).toHaveCount(1);

    // Two accounts of one name are told apart by where they sit.
    await input.fill("professional services");
    await expect(page.getByRole("option")).toHaveCount(2);
    await expect(option(page, "Professional services, 6310")).toHaveAccessibleDescription(
      "Operating expenses > Domestic operations",
    );
    await expect(option(page, "Professional services, 6410")).toHaveAccessibleDescription(
      "Operating expenses > International operations",
    );
    await input.fill("professional intern");
    await expect(page.getByRole("option")).toHaveCount(1);

    // The best match leads: a name that starts with it before one that only contains it.
    await input.fill("bus");
    await expect(page.getByRole("option").first()).toHaveAccessibleName("Business checking, 1000");
  });

  test("the name comes first and the code is muted after it", async ({ page }) => {
    await page.goto(story("lanes-uxkit-accountpicker--default"));
    await picker(page).fill("savings");
    const item = option(page, "Business savings, 1010");
    await expect(item.locator(".rt-account-code")).toHaveText("1010");
    const [code, text] = await Promise.all([
      item.locator(".rt-account-code").evaluate((node) => getComputedStyle(node).color),
      item.locator("[data-part='item-text']").evaluate((node) => getComputedStyle(node).color),
    ]);
    expect(code).not.toBe(text);
    // Name before code in reading order.
    const order = await item.evaluate((node) => {
      const name = node.querySelector("[data-part='item-text']");
      const code = node.querySelector(".rt-account-code");
      return Boolean(
        name && code && name.compareDocumentPosition(code) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
    });
    expect(order).toBe(true);
  });

  test("a group account is never offered, unless the picker is asked to", async ({ page }) => {
    await page.goto(story("lanes-uxkit-accountpicker--default"));
    const input = picker(page);
    await input.fill("operating");
    await expect(page.getByRole("option").first()).toBeVisible();
    await expect(option(page, "Operating expenses, 6000")).toHaveCount(0);
    await expect(option(page, "Domestic operations, 6300")).toHaveCount(0);
    await expect(option(page, "Office supplies, 6100")).toBeVisible();

    await page.goto(story("lanes-uxkit-accountpicker--allow-groups"));
    await picker(page).fill("operating");
    await expect(option(page, "Operating expenses, 6000")).toBeVisible();
    await expect(option(page, "Domestic operations, 6300")).toBeVisible();
  });

  test("it is used by the keyboard alone: type, arrow, Enter, and Escape puts it away", async ({
    page,
  }) => {
    await page.goto(story("lanes-uxkit-accountpicker--default"));
    const input = picker(page);
    await input.focus();
    await page.keyboard.type("soft");
    await expect(option(page, "Software and subscriptions, 6200")).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(input).toHaveValue("Software and subscriptions");
    await expect(page.getByLabel("Chosen account")).toHaveText("Chosen: software");
    await expect(page.getByRole("listbox")).toBeHidden();
    await expect(input).toBeFocused();
    // Under the box: the code and where it sits.
    await expect(input).toHaveAccessibleDescription("6200 · Operating expenses");

    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox")).toBeHidden();
    await expect(input).toBeFocused();
  });

  test("opening it again shows every account, not only the one chosen", async ({ page }) => {
    await page.goto(story("lanes-uxkit-accountpicker--chosen"));
    await page.getByRole("button", { name: "Show accounts" }).click();
    await expect(page.getByRole("option").first()).toBeVisible();
    expect(await page.getByRole("option").count()).toBeGreaterThan(8);
  });

  test("a closed account is listed and says why it cannot be chosen", async ({ page }) => {
    await page.goto(story("lanes-uxkit-accountpicker--default"));
    const input = picker(page);
    await input.fill("legacy");
    const closed = option(page, "Legacy expenses, 6900");
    await expect(closed).toHaveAttribute("data-disabled", "");
    await expect(closed).toHaveAccessibleDescription(/Closed account/);
    await input.press("ArrowDown");
    await input.press("Enter");
    await expect(page.getByLabel("Chosen account")).toHaveText("Nothing chosen.");
  });

  test("New account… ends the list, and asks for the account with what was typed, choosing nothing", async ({
    page,
  }) => {
    await page.goto(story("lanes-uxkit-accountpicker--with-new-account"));
    const input = picker(page);
    await expect(input).toHaveValue("Business checking");
    await input.fill("Coffee");
    // Nothing matches, and the way to add one is still there.
    await expect(page.getByText("No matching accounts.")).toBeVisible();
    const create = option(page, "New account…");
    await expect(create).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await expect(create).toHaveAttribute("data-highlighted", "");
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("New account requested")).toHaveText(
      "New account requested: Coffee",
    );
    // The box says what it said, and the chosen account has not changed.
    await expect(input).toHaveValue("Business checking");
    await expect(page.getByLabel("Chosen account")).toHaveText("Chosen: bank");
  });

  test("New account… is the last entry of a list that has matches, and works with the mouse", async ({
    page,
  }) => {
    await page.goto(story("lanes-uxkit-accountpicker--with-new-account"));
    await page.getByRole("button", { name: "Show accounts" }).click();
    const entries = page.getByRole("option");
    await expect(entries.last()).toHaveAccessibleName("New account…");
    await entries.last().click();
    await expect(page.getByLabel("New account requested")).toHaveText("New account requested.");
    await expect(picker(page)).toHaveValue("Business checking");
  });

  test("a book with no accounts says so and still offers to add one", async ({ page }) => {
    await page.goto(story("lanes-uxkit-accountpicker--empty"));
    await page.getByRole("button", { name: "Show accounts" }).click();
    await expect(page.getByText("There are no accounts yet.")).toBeVisible();
    await expect(option(page, "New account…")).toBeVisible();
  });

  test("loading and a failed read are not 'no match'", async ({ page }) => {
    await page.goto(story("lanes-uxkit-accountpicker--loading"));
    await page.getByRole("button", { name: "Show accounts" }).click();
    // The words are a status line in the popup, outside the listbox, which may hold only options.
    const said = page.locator(".rt-account-popup").getByRole("status").filter({ hasText: /\S/ });
    await expect(said).toContainText("Loading accounts");
    await expect(page.getByRole("option")).toHaveCount(0);
    await expect(
      page.getByRole("listbox").getByRole("status").filter({ hasText: /\S/ }),
    ).toHaveCount(0);
    await page.goto(story("lanes-uxkit-accountpicker--error-state"));
    await page.getByRole("button", { name: "Show accounts" }).click();
    await expect(
      page.locator(".rt-account-popup").getByRole("status").filter({ hasText: /\S/ }),
    ).toContainText("could not be loaded");
  });

  test("what is wrong is said beside the field and with it", async ({ page }) => {
    await page.goto(story("lanes-uxkit-accountpicker--invalid"));
    const input = picker(page);
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText("Choose an account for this line.")).toBeVisible();
    await expect(input).toHaveAccessibleDescription(/Choose an account for this line\./);
  });

  test("a filter's All accounts heads the list, is what the box says while nothing is chosen, and clears the choice", async ({
    page,
  }) => {
    await page.goto(story("lanes-uxkit-accountpicker--all-accounts"));
    const input = picker(page);
    await expect(input).toHaveValue("All accounts");
    // A filter is not a posting: nothing says "choose a posting account".
    await expect(page.locator(".rt-account-picker > p.rt-hint")).toHaveCount(0);
    await page.getByRole("button", { name: "Show accounts" }).click();
    const entries = page.getByRole("option");
    await expect(entries.first()).toHaveAccessibleName("All accounts");
    await expect(entries.first()).toHaveAttribute("data-state", "checked");
    await option(page, "Sales, 4000").click();
    await expect(page.getByLabel("Chosen account")).toHaveText("Chosen: sales");
    await expect(input).toHaveValue("Sales");

    // Opened again: it is still first, and no longer the one that is chosen. Choosing it clears the filter.
    await page.getByRole("button", { name: "Show accounts" }).click();
    await expect(entries.first()).toHaveAccessibleName("All accounts");
    await expect(entries.first()).not.toHaveAttribute("data-state", "checked");
    await entries.first().click();
    await expect(page.getByLabel("Chosen account")).toHaveText("Nothing chosen.");
    await expect(input).toHaveValue("All accounts");
  });

  test("All accounts stays in the list only while what is typed could be it, and the keyboard clears the filter", async ({
    page,
  }) => {
    await page.goto(story("lanes-uxkit-accountpicker--all-accounts"));
    const input = picker(page);
    await input.fill("sales");
    await expect(option(page, "Sales, 4000")).toBeVisible();
    await expect(page.getByRole("option")).toHaveCount(1);
    await input.press("ArrowDown");
    await input.press("Enter");
    await expect(page.getByLabel("Chosen account")).toHaveText("Chosen: sales");

    // Typing "all" finds it, and nothing says there is no match.
    await input.fill("all");
    await expect(page.getByRole("option")).toHaveCount(1);
    await expect(option(page, "All accounts")).toBeVisible();
    await expect(page.getByText("No matching accounts.")).toHaveCount(0);
    await input.press("ArrowDown");
    await input.press("Enter");
    await expect(page.getByLabel("Chosen account")).toHaveText("Nothing chosen.");
    await expect(input).toHaveValue("All accounts");

    // Something that matches neither says so.
    await input.fill("zzz");
    await expect(page.getByText("No matching accounts.")).toBeVisible();
    await expect(page.getByRole("option")).toHaveCount(0);
  });

  test("accounts that arrive late give the box the chosen account's name, and none is called missing while they are read", async ({
    page,
  }) => {
    await page.goto(story("lanes-uxkit-accountpicker--late-accounts"));
    const input = picker(page);
    await expect(input).toBeVisible();
    await expect(page.getByText(/unavailable/)).toHaveCount(0);
    await expect(input).toHaveValue("Sales", { timeout: 15_000 });
    await expect(input).toHaveAccessibleDescription("4000");
    await expect(page.getByText(/unavailable/)).toHaveCount(0);
  });

  test("a value set in the same tick the picker is made is shown, in the box and as the chosen entry", async ({
    page,
  }) => {
    await page.goto(story("lanes-uxkit-accountpicker--value-set-on-mount"));
    const input = picker(page);
    await expect(page.getByLabel("Chosen account")).toHaveText("Chosen: sales");
    await expect(input).toHaveValue("Sales");
    await expect(input).toHaveAccessibleDescription("4000");
    await page.getByRole("button", { name: "Show accounts" }).click();
    const chosen = option(page, "Sales, 4000");
    await expect(chosen).toHaveAttribute("aria-selected", "true");
    await expect(chosen).toHaveAttribute("data-state", "checked");
    // Choosing another account still works afterwards.
    await option(page, "Software and subscriptions, 6200").click();
    await expect(page.getByLabel("Chosen account")).toHaveText("Chosen: software");
    await expect(input).toHaveValue("Software and subscriptions");
  });

  test("a screen can give the box its id, and the label still names it", async ({ page }) => {
    await page.goto(story("lanes-uxkit-accountpicker--with-id"));
    const input = picker(page, "Paid from");
    await expect(input).toHaveAttribute("id", "paid-from");
    await expect(page.locator('label[for="paid-from"]')).toContainText("Paid from");
    // What an error summary's link does.
    await page.evaluate(() => document.getElementById("paid-from")?.focus());
    await expect(input).toBeFocused();
  });

  test("a label kept for assistive technology names the box and is not shown", async ({ page }) => {
    await page.goto(story("lanes-uxkit-accountpicker--hidden-label"));
    await expect(picker(page, "Account for line 1")).toBeVisible();
    // The label is there for a screen reader and takes no room on the page.
    const label = page.locator("label.rt-sr-only", { hasText: "Account for line 1" });
    await expect(label).toHaveCount(1);
    expect((await label.boundingBox())?.width ?? 0).toBeLessThanOrEqual(1);
  });

  test("a value that is set from outside reaches the box, and a chosen account that is gone is kept and said", async ({
    page,
  }) => {
    await page.goto(story("lanes-uxkit-accountpicker--default"));
    await page.getByRole("button", { name: "Choose Sales" }).click();
    await expect(picker(page)).toHaveValue("Sales");
    await page.getByRole("button", { name: "Clear" }).click();
    await expect(picker(page)).toHaveValue("");
  });

  test("in a dense row the label is for assistive technology, nothing sits under the box, and typing a code chooses", async ({
    page,
  }) => {
    await page.goto(story("lanes-uxkit-accountpicker--compact"));
    const first = picker(page, "Account for line 1");
    const second = picker(page, "Account for line 2");
    await expect(first).toHaveValue("Business checking");
    await expect(second).toHaveValue("");
    // No line under the boxes, and the label takes no room.
    await expect(page.locator(".rt-account-picker[data-compact] > p.rt-hint")).toHaveCount(0);
    expect(
      (await page.locator("label.rt-sr-only", { hasText: "Account for line 2" }).boundingBox())
        ?.width ?? 0,
    ).toBeLessThanOrEqual(1);
    // It fills its cell.
    const cell = await second.locator("xpath=ancestor::td").boundingBox();
    const box = await page.locator(".rt-account-picker").nth(1).boundingBox();
    expect((box?.width ?? 0) / (cell?.width ?? 1)).toBeGreaterThan(0.85);
    // Type a code, Enter chooses it.
    await second.fill("6100");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(second).toHaveValue("Office supplies");
    await expect(first).toHaveValue("Business checking");
    // "New account…" is still at the foot.
    await second.fill("zzz");
    await expect(option(page, "New account…")).toBeVisible();
  });

  // Ark gives the box focus from an animation frame of its own, when the list opens and when it closes.
  // Whoever has moved on to the next field before that frame (a test with no wait, a very fast typist) must
  // keep focus: the keys they type next go to that field. A slow frame (a busy page) makes the race certain,
  // so most of these give every frame callback 80 ms before it runs: those that are due run together, in the
  // order they were asked for, as they do in a page that is busy.
  const slowFrames = (page: Page) =>
    page.addInitScript(() => {
      type Waiting = { id: number; run: FrameRequestCallback; due: number };
      let next = 1;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const queue: Waiting[] = [];
      const schedule = () => {
        const first = queue[0];
        if (timer !== undefined || !first) return;
        timer = setTimeout(
          () => {
            timer = undefined;
            const now = performance.now();
            const due: Waiting[] = [];
            // Those asked for in the same task run together, not split by the microseconds between them.
            while (queue[0] && queue[0].due <= now + 2) due.push(queue.shift() as Waiting);
            for (const item of due) item.run(now);
            schedule();
          },
          Math.max(0, first.due - performance.now()),
        );
      };
      window.requestAnimationFrame = (run) => {
        const id = next++;
        queue.push({ id, run, due: performance.now() + 80 });
        schedule();
        return id;
      };
      window.cancelAnimationFrame = (id) => {
        const at = queue.findIndex((item) => item.id === id);
        if (at >= 0) queue.splice(at, 1);
      };
    });
  /** Two frames on: whatever Ark asked for in the frame after a choice has been done. */
  const framesPass = (page: Page) =>
    page.evaluate(
      () =>
        new Promise<void>((done) => {
          requestAnimationFrame(() => requestAnimationFrame(() => done()));
        }),
    );

  for (const slow of [true, false])
    test(`after a choice from the keyboard the next field takes the keys at once${slow ? ", even when frames are slow" : ""}`, async ({
      page,
    }) => {
      if (slow) await slowFrames(page);
      await page.goto(story("lanes-uxkit-accountpicker--compact"));
      const account = picker(page, "Account for line 2");
      await account.fill("6100");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      // No wait: on to the next field and type into it.
      await page.keyboard.press("Tab");
      await page.keyboard.type("12");
      await framesPass(page);
      const debit = page.getByLabel("Debit for line 2");
      await expect(debit).toBeFocused();
      await page.keyboard.type(".50");
      await expect(debit).toHaveValue("12.50");
      await expect(account).toHaveValue("Office supplies");
    });

  test("after a choice with the pointer the next field takes the keys at once, even when frames are slow", async ({
    page,
  }) => {
    await slowFrames(page);
    await page.goto(story("lanes-uxkit-accountpicker--compact"));
    const account = picker(page, "Account for line 2");
    await account.click();
    await account.fill("6100");
    await option(page, "Office supplies, 6100").click();
    // On to the next field without waiting (a click would wait for frames, and a test that fills it does not).
    const debit = page.getByLabel("Debit for line 2");
    await debit.focus();
    await page.keyboard.type("12");
    await framesPass(page);
    await expect(debit).toBeFocused();
    await page.keyboard.type(".50");
    await expect(debit).toHaveValue("12.50");
    await expect(account).toHaveValue("Office supplies");
  });

  test("after Escape the next field takes the keys at once, even when frames are slow", async ({
    page,
  }) => {
    await slowFrames(page);
    await page.goto(story("lanes-uxkit-accountpicker--compact"));
    const account = picker(page, "Account for line 2");
    await account.fill("6100");
    await page.keyboard.press("ArrowDown");
    await expect(option(page, "Office supplies, 6100")).toBeVisible();
    // The list puts itself away on Escape once its dismiss layer is there, a frame after it opens, and gives the
    // box focus back from a frame of its own when an item had been moved to.
    await framesPass(page);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Tab");
    await page.keyboard.type("12");
    await framesPass(page);
    const debit = page.getByLabel("Debit for line 2");
    await expect(debit).toBeFocused();
    await page.keyboard.type(".50");
    await expect(debit).toHaveValue("12.50");
  });

  test("a focus() that is not Ark's, a link to the box or a test's, is never dropped, even straight after a choice", async ({
    page,
  }) => {
    await slowFrames(page);
    await page.goto(story("lanes-uxkit-accountpicker--compact"));
    const account = picker(page, "Account for line 2");
    await account.fill("6100");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Debit for line 2")).toBeFocused();
    // What an error summary's link does, while Ark's frame is still to come.
    await account.focus();
    await expect(account).toBeFocused();
    await framesPass(page);
    await expect(account).toBeFocused();
  });

  test("a chosen account that no longer exists is still said in a dense row", async ({ page }) => {
    await page.goto(story("lanes-uxkit-accountpicker--compact-unavailable"));
    const input = picker(page, "Account for line 3");
    await expect(input).toHaveAccessibleDescription(/removed-account-7100.*unavailable/);
    await expect(page.locator(".rt-account-picker[data-compact] > p.rt-hint")).toHaveCount(1);
  });

  test("long names wrap in a phone's width and never widen the page", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(story("lanes-uxkit-accountpicker--long-content"));
    await page.getByRole("button", { name: "Show accounts" }).click();
    await expect(page.getByRole("option").first()).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
  });

  test("the list passes the accessibility scan in both themes, open on every kind of state", async ({
    page,
  }) => {
    test.slow();
    for (const theme of ["light", "dark"] as const)
      for (const id of [
        "default",
        "with-new-account",
        "allow-groups",
        "chosen",
        "empty",
        "loading",
        "error-state",
        "invalid",
        "long-content",
        "compact",
        "compact-unavailable",
        "with-id",
        "all-accounts",
        "value-set-on-mount",
        "dark",
      ]) {
        await page.goto(story(`lanes-uxkit-accountpicker--${id}`, theme));
        await page.getByRole("button", { name: "Show accounts" }).first().click();
        await expect(page.locator(".rt-account-popup:not([hidden])")).toBeVisible();
        await expectNoViolations(page, `account picker ${id} (${theme})`);
      }
  });
});

// ---- DateRangeField -----------------------------------------------------------------------------------

const preset = (page: Page) => page.getByRole("combobox", { name: "Date range" });
/** What the list offers: the list is opened, and its choices are on the page until Escape puts it away. */
const offered = async (page: Page) => {
  await preset(page).click();
  await expect(page.getByRole("option").first()).toBeVisible();
  return page.getByRole("option");
};
const covers = (page: Page) => page.locator(".rt-daterange-note");
/** The vertical middle of a box: two things on one line have the same one. */
const middle = (box: { y: number; height: number } | null) =>
  (box?.y ?? 0) + (box?.height ?? 0) / 2;

test.describe("DateRangeField", () => {
  test("it offers the periods a bookkeeper asks for, from the fiscal year to date", async ({
    page,
  }) => {
    await page.goto(story("lanes-uxkit-daterangefield--default"));
    await expect(await offered(page)).toHaveText([
      "This month",
      "Last month",
      "This quarter",
      "Last quarter",
      "This fiscal year to date",
      "Last fiscal year",
      "Custom",
    ]);
    await putAway(page);
    await expect(preset(page)).toHaveAttribute("data-value", "fiscalYearToDate");
    await expect(covers(page)).toHaveText(shown.range("2026-01-01", "2026-10-04"));
  });

  test("each period is worked out from the book's calendar and today", async ({ page }) => {
    await page.goto(story("lanes-uxkit-daterangefield--default"));
    const value = page.getByLabel("Value");
    const cases: [string, string, string][] = [
      ["thisMonth", "2026-10-01", "2026-10-31"],
      ["lastMonth", "2026-09-01", "2026-09-30"],
      ["thisQuarter", "2026-10-01", "2026-12-31"],
      ["lastQuarter", "2026-07-01", "2026-09-30"],
      ["fiscalYearToDate", "2026-01-01", "2026-10-04"],
      ["lastFiscalYear", "2025-01-01", "2025-12-31"],
    ];
    for (const [id, from, to] of cases) {
      await pick(page, preset(page), { value: id });
      await expect(covers(page)).toHaveText(shown.range(from, to));
      await expect(value).toHaveText(`Reading ${id}: ${shown.range(from, to)}`);
    }
  });

  test("a fiscal year that starts in October has October quarters", async ({ page }) => {
    await page.goto(story("lanes-uxkit-daterangefield--october-year"));
    const expected: [string, string, string][] = [
      ["thisQuarter", "2027-01-01", "2027-03-31"],
      ["lastQuarter", "2026-10-01", "2026-12-31"],
      ["fiscalYearToDate", "2026-10-01", "2027-02-10"],
      ["lastFiscalYear", "2025-10-01", "2026-09-30"],
    ];
    for (const [id, from, to] of expected) {
      await pick(page, preset(page), { value: id });
      await expect(covers(page)).toHaveText(shown.range(from, to));
    }
  });

  test("a period the calendar does not cover is listed, says so, and cannot be chosen", async ({
    page,
  }) => {
    await page.goto(story("lanes-uxkit-daterangefield--first-year"));
    const options = await offered(page);
    const lastYear = options.filter({ hasText: "Last fiscal year" });
    await expect(lastYear).toHaveText("Last fiscal year (not in this book's calendar)");
    await expect(lastYear).toBeDisabled();
    await expect(options.filter({ hasText: "Last quarter" })).toBeDisabled();
    await expect(options.filter({ hasText: "This month" })).toBeEnabled();
  });

  test("from the keyboard: it takes focus in its place, and typing the name of a period chooses it", async ({
    page,
    browserName,
  }) => {
    await page.goto(story("lanes-uxkit-daterangefield--default"));
    await expect(preset(page)).toBeVisible();
    // Safari on a Mac does not Tab to controls unless asked to; Option-Tab is its way through everything.
    const tab = browserName === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab";
    await page.keyboard.press(tab);
    await expect(preset(page)).toBeFocused();
    // A list takes its type-ahead while it is closed: the next period that starts with the letter is chosen.
    await pick(page, preset(page), { value: "thisMonth" });
    await expect(preset(page)).toBeFocused();
    await page.keyboard.type("L");
    await expect(preset(page)).toHaveAttribute("data-value", "lastMonth");
    await expect(covers(page)).toHaveText(shown.range("2026-09-01", "2026-09-30"));
  });

  test("Custom starts from the dates that were showing and says when they are wrong", async ({
    page,
  }) => {
    await page.goto(story("lanes-uxkit-daterangefield--default"));
    await pick(page, preset(page), { value: "custom" });
    const from = page.getByLabel("From", { exact: true });
    const to = page.getByLabel("To", { exact: true });
    await expect(from).toHaveValue(shown.dateBox("2026-01-01"));
    await expect(to).toHaveValue(shown.dateBox("2026-10-04"));

    // The wrong way round.
    await from.fill("2026-11-01");
    await from.blur();
    await expect(page.getByText("The start date is after the end date.")).toBeVisible();
    await expect(from).toHaveAttribute("aria-invalid", "true");
    await expect(to).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByLabel("Value")).toContainText("Not usable yet");

    // Mended.
    await to.fill("2026-12-01");
    await to.blur();
    await expect(page.getByText("The start date is after the end date.")).toHaveCount(0);
    await expect(covers(page)).toHaveText(shown.range("2026-11-01", "2026-12-01"));
    await expect(page.getByLabel("Value")).toHaveText(
      `Reading custom: ${shown.range("2026-11-01", "2026-12-01")}`,
    );

    // Outside the book's calendar.
    await from.fill("2024-06-01");
    await from.blur();
    await expect(
      page.getByText(
        `Choose dates from ${shown.date("2025-01-01")} to ${shown.date("2026-12-31")}, the dates this book's fiscal calendar covers.`,
      ),
    ).toBeVisible();
  });

  test("a date that is not finished is not an error until the field is left", async ({ page }) => {
    await page.goto(story("lanes-uxkit-daterangefield--custom"));
    const from = page.getByLabel("From", { exact: true });
    await from.fill("");
    await expect(page.getByText("Enter both dates, from and to.")).toHaveCount(0);
    await from.blur();
    await expect(page.getByText("Enter both dates, from and to.")).toBeVisible();
    await expect(page.getByLabel("Value")).toContainText("Not usable yet");
  });

  test("a book with no calendar offers only Custom, and says why", async ({ page }) => {
    await page.goto(story("lanes-uxkit-daterangefield--empty"));
    await expect(page.getByText("This book has no calendar yet.")).toBeVisible();
    await expect((await offered(page)).and(page.locator(":not([aria-disabled=true])"))).toHaveText([
      "Custom",
    ]);
  });

  test("while the calendar is read the periods wait, and a failed read says so", async ({
    page,
  }) => {
    await page.goto(story("lanes-uxkit-daterangefield--loading"));
    await expect(preset(page)).toBeDisabled();
    await expect(
      page.getByRole("status").filter({ hasText: /\S/ }).or(page.locator("[aria-live]")).first(),
    ).toContainText("Reading the book's calendar");
    await page.goto(story("lanes-uxkit-daterangefield--error-state"));
    await expect(page.getByText("The book's calendar could not be read.")).toBeVisible();
  });

  test("every date is offered only where a screen lists it, starts a register, and needs no line under it", async ({
    page,
  }) => {
    await page.goto(story("lanes-uxkit-daterangefield--all-dates"));
    await expect(await offered(page)).toHaveText([
      "All dates",
      "This month",
      "Last month",
      "This quarter",
      "Last quarter",
      "This fiscal year to date",
      "Last fiscal year",
      "Custom",
    ]);
    await putAway(page);
    await expect(preset(page)).toHaveAttribute("data-value", "all");
    await expect(page.locator(".rt-daterange-note > p")).toHaveCount(0);
    const value = page.getByLabel("Value");
    await expect(value).toHaveText("Reading all: Every date");

    // A period has its line; going back to every date takes it away again.
    await pick(page, preset(page), { value: "lastMonth" });
    await expect(covers(page)).toHaveText(shown.range("2026-09-01", "2026-09-30"));
    await pick(page, preset(page), { value: "all" });
    await expect(value).toHaveText("Reading all: Every date");
    await expect(page.locator(".rt-daterange-note > p")).toHaveCount(0);

    // Custom from every date starts empty, and is not usable until both dates are in.
    await pick(page, preset(page), { value: "custom" });
    const from = page.getByLabel("From", { exact: true });
    const to = page.getByLabel("To", { exact: true });
    await expect(from).toHaveValue("");
    await expect(to).toHaveValue("");
    await expect(value).toContainText("Not usable yet");
    await from.fill("2026-03-01");
    await from.blur();
    await to.fill("2026-03-31");
    await to.blur();
    await expect(value).toHaveText(`Reading custom: ${shown.range("2026-03-01", "2026-03-31")}`);
  });

  test("the default set has no All dates, and a register's filter bar starts on All in one row", async ({
    page,
  }) => {
    await page.goto(story("lanes-uxkit-daterangefield--default"));
    await expect((await offered(page)).filter({ hasText: "All dates" })).toHaveCount(0);
    await putAway(page);

    // A register's bar on a wide screen: five filters in one row.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(story("lanes-uxkit-daterangefield--register-filters"));
    await expect(preset(page)).toHaveAttribute("data-value", "all");
    const account = page.getByRole("combobox", { name: "Account", exact: true });
    await expect(account).toHaveValue("All accounts");
    const bottoms = await Promise.all(
      [
        page.getByLabel("Search", { exact: true }),
        preset(page),
        account,
        page.getByRole("combobox", { name: "Type" }),
        page.getByRole("combobox", { name: "Status" }),
      ].map(async (control) => {
        const rect = await control.boundingBox();
        return (rect?.y ?? 0) + (rect?.height ?? 0);
      }),
    );
    expect(Math.max(...bottoms) - Math.min(...bottoms)).toBeLessThan(6);
    // Choose a period and an account; both can go back to All.
    await pick(page, preset(page), { value: "thisMonth" });
    await account.fill("sales");
    await account.press("ArrowDown");
    await account.press("Enter");
    await expect(page.getByLabel("Filters")).toHaveText("thisMonth · sales");
    await pick(page, preset(page), { value: "all" });
    await account.fill("all");
    await account.press("ArrowDown");
    await account.press("Enter");
    await expect(page.getByLabel("Filters")).toHaveText("all · all accounts");
  });

  test("a short list of presets, and no line saying what they cover", async ({ page }) => {
    await page.goto(story("lanes-uxkit-daterangefield--some-presets"));
    await expect(await offered(page)).toHaveText([
      "This month",
      "Last month",
      "This fiscal year to date",
      "Custom",
    ]);
    await expect(page.locator(".rt-daterange-note > p")).toHaveCount(0);
  });

  test("in a toolbar it is about 300 px wide, sits in the row with the other filters, and keeps what it covers for a screen reader", async ({
    page,
  }) => {
    await page.goto(story("lanes-uxkit-daterangefield--compact"));
    const group = page.getByRole("group", { name: "Date range" });
    await expect(group).toBeVisible();
    const box = await group.boundingBox();
    expect(box?.width ?? 999).toBeLessThanOrEqual(301);
    await expect(page.locator(".rt-daterange > span.rt-sr-only")).toHaveText(
      shown.range("2026-01-01", "2026-10-04"),
    );
    // One row with the search and the other two filters.
    const bottoms = await Promise.all(
      [
        page.getByLabel("Search", { exact: true }),
        preset(page),
        page.getByRole("combobox", { name: "Type" }),
        page.getByRole("combobox", { name: "Status" }),
      ].map(async (control) => {
        const rect = await control.boundingBox();
        return (rect?.y ?? 0) + (rect?.height ?? 0);
      }),
    );
    expect(Math.max(...bottoms) - Math.min(...bottoms)).toBeLessThan(6);

    // Custom: From and To side by side inside the 300 px.
    await pick(page, preset(page), { value: "custom" });
    const from = await page.getByLabel("From", { exact: true }).boundingBox();
    const to = await page.getByLabel("To", { exact: true }).boundingBox();
    expect(Math.abs((from?.y ?? 0) - (to?.y ?? 99))).toBeLessThan(2);
    expect((to?.x ?? 0) + (to?.width ?? 0) - (from?.x ?? 0)).toBeLessThanOrEqual(301);
  });

  test("in a row the label sits beside the list, and Custom puts From and To beside it on the same line", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(story("lanes-uxkit-daterangefield--row"));
    const label = page.locator(".rt-daterange-preset label");
    await expect(label).toHaveText("Date range");
    const list = preset(page);
    const listBox = await list.boundingBox();
    const labelBox = await label.boundingBox();
    // Beside the list and not above it: the label ends where the list begins, and the two share a line.
    expect((labelBox?.x ?? 0) + (labelBox?.width ?? 0)).toBeLessThanOrEqual((listBox?.x ?? 0) + 1);
    expect(Math.abs(middle(labelBox) - middle(listBox))).toBeLessThan(3);
    // So do the row's other choices, which put their labels beside their controls too.
    for (const other of [
      page.getByRole("combobox", { name: "Compare" }),
      page.getByRole("button", { name: "Export" }),
    ])
      expect(Math.abs(middle(await other.boundingBox()) - middle(listBox))).toBeLessThan(3);
    // The words for the period take no room in a row, and a screen reader still has them.
    await expect(page.locator(".rt-daterange-note > p")).toHaveCount(0);
    await expect(page.locator(".rt-daterange > span.rt-sr-only")).toHaveText(
      shown.range("2026-01-01", "2026-10-04"),
    );

    // Custom: the list, then From and then To, left to right on that one line, each label beside its date. The
    // list is as wide as it was: what is chosen does not move what comes after it.
    await pick(page, list, { value: "custom" });
    expect((await list.boundingBox())?.width).toBe(listBox?.width);
    let right = (listBox?.x ?? 0) + (listBox?.width ?? 0);
    for (const name of ["From", "To"]) {
      const date = page.getByLabel(name, { exact: true });
      await expect(date).toBeVisible();
      const dateBox = await date.boundingBox();
      const nameBox = await page
        .locator("label", { hasText: new RegExp(`^${name}$`) })
        .boundingBox();
      expect(
        Math.abs(middle(dateBox) - middle(listBox)),
        `${name} is on the list's line`,
      ).toBeLessThan(3);
      expect(
        Math.abs(middle(nameBox) - middle(dateBox)),
        `${name}'s label is beside it`,
      ).toBeLessThan(3);
      expect((nameBox?.x ?? 0) + (nameBox?.width ?? 0)).toBeLessThanOrEqual((dateBox?.x ?? 0) + 1);
      expect(nameBox?.x ?? 0, `${name} comes after what is before it`).toBeGreaterThanOrEqual(
        right,
      );
      right = (dateBox?.x ?? 0) + (dateBox?.width ?? 0);
    }
    // The dates still work from here.
    await page.getByLabel("From", { exact: true }).fill("2026-03-01");
    await page.getByLabel("From", { exact: true }).blur();
    await page.getByLabel("To", { exact: true }).fill("2026-03-31");
    await page.getByLabel("To", { exact: true }).blur();
    await expect(page.getByLabel("Value")).toHaveText(
      `Reading custom: ${shown.range("2026-03-01", "2026-03-31")}`,
    );
  });

  test("on a phone a row gives the list a line with its label above it, From and To the line under, and no sideways scroll", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(story("lanes-uxkit-daterangefield--row-custom"));
    const label = page.locator(".rt-daterange-preset label");
    const listBox = await preset(page).boundingBox();
    const labelBox = await label.boundingBox();
    expect((labelBox?.y ?? 0) + (labelBox?.height ?? 0)).toBeLessThanOrEqual((listBox?.y ?? 0) + 1);
    const from = await page.getByLabel("From", { exact: true }).boundingBox();
    const to = await page.getByLabel("To", { exact: true }).boundingBox();
    expect(Math.abs((from?.y ?? 0) - (to?.y ?? 99))).toBeLessThan(2);
    expect(from?.y ?? 0).toBeGreaterThanOrEqual((listBox?.y ?? 0) + (listBox?.height ?? 0));
    expect((to?.x ?? 0) + (to?.width ?? 0)).toBeLessThanOrEqual(390);
    expect(await noSidewaysScroll(page)).toBe(true);

    // A long label wraps above its control instead of widening the page.
    await page.goto(story("lanes-uxkit-daterangefield--row-long-label"));
    await expect(page.locator(".rt-daterange-preset label")).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
  });

  test("a long label and a narrow column never widen the page", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const id of ["long-content", "custom", "invalid", "compact", "row", "row-custom"]) {
      await page.goto(story(`lanes-uxkit-daterangefield--${id}`));
      await expect(page.getByRole("group").first()).toBeVisible();
      expect(await noSidewaysScroll(page), id).toBe(true);
    }
  });

  test("the field passes the accessibility scan in both themes in every state", async ({
    page,
  }) => {
    test.slow();
    for (const theme of ["light", "dark"] as const)
      for (const id of [
        "default",
        "october-year",
        "custom",
        "invalid",
        "first-year",
        "empty",
        "loading",
        "error-state",
        "some-presets",
        "long-content",
        "compact",
        "all-dates",
        "register-filters",
        "row",
        "row-custom",
        "row-long-label",
        "dark",
      ]) {
        await page.goto(story(`lanes-uxkit-daterangefield--${id}`, theme));
        await expect(page.getByRole("group").first()).toBeVisible();
        await expectNoViolations(page, `date range ${id} (${theme})`);
      }
  });
});
