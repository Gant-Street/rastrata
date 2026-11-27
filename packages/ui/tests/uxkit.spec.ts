import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";

// The UX kit against fictional data in Storybook: Details, EmptyState, Toast and the four tones.
// (Every story is also swept in both themes by lane-stories.spec.ts; these are the states a sweep does
// not reach, and the behaviour: keyboard, timing, pausing, the clipboard.)
const story = (id: string, theme?: "light" | "dark") =>
  `/iframe.html?id=${id}&viewMode=story${theme ? `&globals=theme:${theme}` : ""}`;

declare global {
  interface Window {
    axe: typeof axe;
    __copied?: string[];
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

/** Safari on a Mac does not Tab to controls unless asked to; Option-Tab is its way through everything. */
const tabKey = (browserName: string) =>
  browserName === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab";

/** Whether the page is as wide as the window. It waits for the fonts and a frame first, so a long word has
 * wrapped before it is measured (a measure right after `goto` can run before the story has rendered). */
const noSidewaysScroll = async (page: Page): Promise<boolean> => {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
  return page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
};

const FINGERPRINT = "61e985c0f2b94d3a7e18a5c46d09b3f7a2e4cc1d8b50e7f9a3d62c8b1f04e7a9";

/** Record what is written to the clipboard instead of using the real one, so a test is the same in every
 * browser and needs no permission. */
async function recordClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__copied = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          window.__copied?.push(text);
        },
      },
    });
  });
}

// ---- Details ------------------------------------------------------------------------------------------

test.describe("Details", () => {
  test("a closed fold inside an open one looks closed: its chevron points along and its preview shows", async ({
    page,
  }) => {
    await page.goto(story("lanes-uxkit-details--nested"));
    const outer = page.getByRole("button", { name: "Suggested accounts", exact: true });
    const inner = page.getByRole("button", { name: "By account", exact: true });
    await expect(outer).toHaveAttribute("aria-expanded", "true");
    await expect(inner).toHaveAttribute("aria-expanded", "false");
    const turned = (button: typeof inner) =>
      button.locator(".rt-details-chevron").evaluate((icon) => getComputedStyle(icon).transform);
    expect(await turned(inner)).toBe("none");
    expect(await turned(outer)).not.toBe("none");
    await expect(page.getByText("7 accounts", { exact: true })).toBeVisible();
    await inner.click();
    await expect.poll(() => turned(inner)).not.toBe("none");
    await expect(page.getByText("7 accounts", { exact: true })).toBeHidden();
  });

  test("it is closed until asked, opens and closes from the keyboard, and the preview goes while open", async ({
    page,
  }) => {
    await page.goto(story("lanes-uxkit-details--default"));
    const toggle = page.getByRole("button", { name: "Report details", exact: true });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText("Book revision 24 · fingerprint 61e985c0…")).toBeVisible();
    await expect(page.getByText("Compiler version")).toBeHidden();

    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText("Compiler version")).toBeVisible();
    await expect(page.getByText("Book revision 24 · fingerprint 61e985c0…")).toBeHidden();
    const controlled = await toggle.getAttribute("aria-controls");
    expect(controlled).toBeTruthy();
    await expect(page.locator(`[id="${controlled}"]`)).toBeVisible();

    await page.keyboard.press("Space");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText("Compiler version")).toBeHidden();
    await expect(toggle).toBeFocused();
  });

  test("Copy puts the value on the clipboard and says so politely, then goes back to Copy", async ({
    page,
    browserName,
  }) => {
    await recordClipboard(page);
    await page.clock.install();
    await page.goto(story("lanes-uxkit-details--default"));
    const copy = page.getByRole("button", { name: "Copy fingerprint", exact: true });
    await expect(copy).toHaveText("Copy");
    await page.getByRole("button", { name: "Report details", exact: true }).focus();
    await page.keyboard.press(tabKey(browserName));
    await expect(copy).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status").filter({ hasText: "Copied fingerprint" })).toBeAttached();
    await expect(page.getByRole("button", { name: "Copied fingerprint", exact: true })).toHaveText(
      "Copied",
    );
    expect(await page.evaluate(() => window.__copied)).toEqual([FINGERPRINT]);
    // It goes back to Copy by itself after a few seconds.
    await freeze(page);
    await page.clock.runFor(3_000);
    await expect(page.getByRole("button", { name: "Copy fingerprint", exact: true })).toHaveText(
      "Copy",
    );
  });

  test("a clipboard that refuses is said in words, never reported as copied, and the value is shown", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error("NotAllowedError")) },
      });
      document.execCommand = () => false;
    });
    await page.goto(story("lanes-uxkit-details--default"));
    await page.getByRole("button", { name: "Copy fingerprint", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText(/Could not copy/);
    await expect(page.getByText("Copied")).toHaveCount(0);
    // It opens, so the value can be selected by hand.
    await expect(page.getByRole("button", { name: "Report details", exact: true })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(page.getByText(FINGERPRINT)).toBeVisible();
  });

  test("a value inside the list copies on its own button, named for what it copies", async ({
    page,
  }) => {
    await recordClipboard(page);
    await page.goto(story("lanes-uxkit-details--open"));
    await page.getByRole("button", { name: "Copy source event", exact: true }).click();
    expect(await page.evaluate(() => window.__copied)).toEqual([
      "stripe:payout:po_1Qx7hVLk3d9Wm2Zt",
    ]);
    await page.getByRole("button", { name: "Copy fingerprint", exact: true }).click();
    expect(await page.evaluate(() => window.__copied)).toEqual([
      "stripe:payout:po_1Qx7hVLk3d9Wm2Zt",
      FINGERPRINT,
    ]);
  });

  test("a long key and a long label wrap inside a phone and never widen the page", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const id of ["long-content", "open", "default"]) {
      await page.goto(story(`lanes-uxkit-details--${id}`));
      await expect(page.locator(".rt-details").first()).toBeVisible();
      expect(await noSidewaysScroll(page), id).toBe(true);
    }
  });

  test("the open states pass the accessibility scan in both themes", async ({ page }) => {
    test.slow();
    for (const theme of ["light", "dark"] as const)
      for (const id of ["open", "long-content", "error-state", "loading", "empty", "dark"]) {
        await page.goto(story(`lanes-uxkit-details--${id}`, theme));
        await expect(page.locator(".rt-details").first()).toBeVisible();
        await expectNoViolations(page, `details ${id} (${theme})`);
      }
  });
});

// ---- EmptyState ---------------------------------------------------------------------------------------

test.describe("EmptyState", () => {
  test("it says one sentence and offers one action", async ({ page }) => {
    await page.goto(story("lanes-uxkit-emptystate--default"));
    const empty = page.locator(".rt-empty");
    await expect(empty).toContainText("Nothing imported yet");
    await expect(empty).toContainText("Import a statement and the transactions in it");
    await expect(empty.getByRole("button")).toHaveCount(1);
    await expect(empty.getByRole("button", { name: "Import a statement" })).toBeVisible();
    // It never claims a success that has not happened.
    await expect(empty).not.toContainText(/caught up|all done|all reconciled/i);
  });

  test("a list that is loading, or failed to read, is not an empty state", async ({ page }) => {
    for (const id of ["loading", "error-state"]) {
      await page.goto(story(`lanes-uxkit-emptystate--${id}`));
      await expect(page.locator("#storybook-root")).toContainText(/Reading|could not be read/);
      await expect(page.locator(".rt-empty")).toHaveCount(0);
    }
  });

  test("when a filter finds nothing it says so politely, and clearing brings the rows back", async ({
    page,
  }) => {
    await page.goto(story("lanes-uxkit-emptystate--filter-found-nothing"));
    await expect(page.getByRole("listitem")).toHaveCount(4);
    await expect(page.getByRole("status").filter({ hasText: /\S/ })).toHaveCount(0);
    await page.getByRole("textbox", { name: "Search transactions" }).fill("zzz");
    const empty = page.getByRole("status").filter({ hasText: /\S/ });
    await expect(empty).toContainText("No transactions match");
    await expect(page.getByRole("listitem")).toHaveCount(0);
    await expectNoViolations(page, "filtered empty state");
    await empty.getByRole("button", { name: "Clear the search" }).click();
    await expect(page.getByRole("listitem")).toHaveCount(4);
    await expect(page.getByRole("status").filter({ hasText: /\S/ })).toHaveCount(0);
  });

  test("long words wrap in a narrow column and the action stays under the sentence", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(story("lanes-uxkit-emptystate--long-content"));
    await expect(page.locator(".rt-empty-text")).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
    const text = (await page.locator(".rt-empty-text").boundingBox())?.y ?? 0;
    const action = (await page.locator(".rt-empty-action").boundingBox())?.y ?? 0;
    expect(action).toBeGreaterThan(text);
  });

  test("the states pass the accessibility scan in both themes", async ({ page }) => {
    test.slow();
    for (const theme of ["light", "dark"] as const)
      for (const id of ["default", "sentence-only", "two-actions", "long-content", "dark"]) {
        await page.goto(story(`lanes-uxkit-emptystate--${id}`, theme));
        await expect(page.locator(".rt-empty")).toBeVisible();
        await expectNoViolations(page, `empty state ${id} (${theme})`);
      }
  });
});

// ---- Toast --------------------------------------------------------------------------------------------

const region = (page: Page) => page.getByRole("region", { name: "Notifications" });
const toasts = (page: Page) => region(page).locator(".rt-toast");

/** Stop the page's clock where it is, so a test says how long passes: a toast's timer, its pause and its
 * resume are then exact and no test waits for real seconds. The installed clock keeps pace with real
 * time until it is paused, so the moment read here is already behind when `pauseAt` runs: a margin
 * covers the round trip, and a busy runner that outruns it ("Cannot fast-forward to the past") reads
 * the moment again with a wider one. The margins stay well under a toast's five seconds, so the
 * arithmetic of the tests that follow holds. */
async function freeze(page: Page): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const now = await page.evaluate(() => Date.now());
    try {
      await page.clock.pauseAt(now + 250 * attempt);
      return;
    } catch (error) {
      if (attempt >= 3 || !String(error).includes("past")) throw error;
    }
  }
}

test.describe("Toast", () => {
  test("the region is on the page before any toast, and is a polite live region", async ({
    page,
  }) => {
    await page.goto(story("lanes-uxkit-toast--empty"));
    await expect(region(page)).toBeAttached();
    await expect(region(page)).toHaveAttribute("aria-live", "polite");
    await expect(region(page)).toHaveAttribute("aria-keyshortcuts", "Alt+T");
    await expect(toasts(page)).toHaveCount(0);
  });

  test("a toast is one sentence with an Undo; Undo does its action and the toast goes", async ({
    page,
  }) => {
    await page.clock.install();
    await page.goto(story("lanes-uxkit-toast--empty"));
    await page.getByRole("button", { name: "Accept 6 suggestions" }).click();
    const toast = toasts(page).first();
    await expect(toast).toContainText("Posted 6 transactions.");
    await expect(toast).toHaveAttribute("data-mounted", "");
    await freeze(page);
    await expect(toast).toHaveAttribute("role", "status");
    await expect(toast).toHaveAttribute("data-tone", "calm");
    await toast.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByLabel("Undo count")).toHaveText("Undo pressed 1 times.");
    await page.clock.runFor(500);
    await expect(toasts(page)).toHaveCount(0);
  });

  test("a toast leaves by itself: five seconds, ten with an action", async ({ page }) => {
    await page.clock.install();
    await page.goto(story("lanes-uxkit-toast--empty"));
    await page.getByRole("button", { name: "Import a file" }).click();
    await page.getByRole("button", { name: "Accept 6 suggestions" }).click();
    await expect(toasts(page)).toHaveCount(2);
    await freeze(page);
    await page.clock.runFor(4_000);
    await expect(toasts(page)).toHaveCount(2);
    await page.clock.runFor(1_500);
    await expect(toasts(page)).toHaveCount(1);
    await expect(toasts(page).first()).toContainText("Posted 6 transactions.");
    await page.clock.runFor(3_000);
    await expect(toasts(page)).toHaveCount(1);
    await page.clock.runFor(2_000);
    await expect(toasts(page)).toHaveCount(0);
  });

  test("pointing at the toasts pauses every clock, and leaving lets them run again", async ({
    page,
  }) => {
    await page.clock.install();
    await page.goto(story("lanes-uxkit-toast--empty"));
    await page.getByRole("button", { name: "Import a file" }).click();
    await expect(toasts(page)).toHaveCount(1);
    await freeze(page);
    await toasts(page).first().hover();
    await page.clock.runFor(30_000);
    await expect(toasts(page)).toHaveCount(1);
    await page.mouse.move(700, 100);
    await page.clock.runFor(2_000);
    await expect(toasts(page)).toHaveCount(1);
    await page.clock.runFor(4_000);
    await expect(toasts(page)).toHaveCount(0);
  });

  test("from the keyboard: Alt+T reaches the toasts, focus pauses them, Undo works, focus goes back", async ({
    page,
    browserName,
  }) => {
    await page.clock.install();
    await page.goto(story("lanes-uxkit-toast--empty"));
    const accept = page.getByRole("button", { name: "Accept 6 suggestions" });
    await accept.click();
    await expect(toasts(page)).toHaveCount(1);
    await freeze(page);
    await accept.focus();
    await page.keyboard.press("Alt+KeyT");
    await expect(region(page)).toBeFocused();
    await page.keyboard.press(tabKey(browserName));
    await expect(toasts(page).first()).toBeFocused();
    await page.keyboard.press(tabKey(browserName));
    const undo = toasts(page).first().getByRole("button", { name: "Undo" });
    await expect(undo).toBeFocused();
    // Focus in the region holds the clock, so the time to reach the action is the time it takes.
    await page.clock.runFor(60_000);
    await expect(toasts(page)).toHaveCount(1);
    await page.keyboard.press("Enter");
    await page.clock.runFor(500);
    await expect(page.getByLabel("Undo count")).toHaveText("Undo pressed 1 times.");
    await expect(toasts(page)).toHaveCount(0);
    await expect(accept).toBeFocused();
  });

  test("Escape dismisses the toast that has focus", async ({ page, browserName }) => {
    await page.clock.install();
    await page.goto(story("lanes-uxkit-toast--empty"));
    const import_ = page.getByRole("button", { name: "Import a file" });
    await import_.click();
    await expect(toasts(page)).toHaveCount(1);
    await expect(toasts(page).first()).toHaveAttribute("data-mounted", "");
    await freeze(page);
    await import_.focus();
    await page.keyboard.press("Alt+KeyT");
    await page.keyboard.press(tabKey(browserName));
    await expect(toasts(page).first()).toBeFocused();
    await page.keyboard.press("Escape");
    await page.clock.runFor(500);
    await expect(toasts(page)).toHaveCount(0);
  });

  // The chord is Alt+T, and on a Mac that chord types a character ("†"). A press that moves focus before the
  // character arrives would lose it, so in a field the chord does nothing. A test cannot make the system
  // insert the character, so after the key press it inserts "†" the way the system would: where focus is. If
  // the chord had moved focus to the toasts, the character would arrive there and not in the field.
  //
  // The chord's own letter is the browser's business and not the kit's: Firefox under Playwright types "t" for
  // Alt+T (Chromium and WebKit type nothing for it), and the kit neither adds a character nor takes one away. So
  // what the field must hold is the inserted character, with or without that letter before it.
  test.describe("typing is never interrupted", () => {
    const typingStory = story("lanes-uxkit-toast--typing-in-a-field");
    const afterChord = /^t?†$/;

    test("Alt+T in a text box leaves focus there, and the character arrives", async ({ page }) => {
      await page.goto(typingStory);
      await expect(toasts(page)).toHaveCount(1);
      const field = page.getByRole("textbox", { name: "Reference" });
      await field.focus();
      await page.keyboard.press("Alt+KeyT");
      await expect(field).toBeFocused();
      await expect(region(page)).not.toBeFocused();
      await page.keyboard.insertText("†");
      await expect(field).toHaveValue(afterChord);
    });

    test("Alt+T in a text area leaves focus there, and the character arrives", async ({ page }) => {
      await page.goto(typingStory);
      await expect(toasts(page)).toHaveCount(1);
      const field = page.getByRole("textbox", { name: "Description" });
      await field.focus();
      await page.keyboard.press("Alt+KeyT");
      await expect(field).toBeFocused();
      await expect(region(page)).not.toBeFocused();
      await page.keyboard.insertText("†");
      await expect(field).toHaveValue(afterChord);
    });

    test("Alt+T in an editable region leaves focus there, and the character arrives", async ({
      page,
    }) => {
      await page.goto(typingStory);
      await expect(toasts(page)).toHaveCount(1);
      const field = page.getByRole("textbox", { name: "Note" });
      await field.focus();
      await page.keyboard.press("Alt+KeyT");
      await expect(field).toBeFocused();
      await expect(region(page)).not.toBeFocused();
      await page.keyboard.insertText("†");
      await expect(field).toHaveText(afterChord);
    });

    test("Alt+T in an account picker's box leaves focus there, and the character arrives", async ({
      page,
    }) => {
      await page.goto(typingStory);
      await expect(toasts(page)).toHaveCount(1);
      const field = page.getByRole("combobox", { name: "Paid from", exact: true });
      await field.focus();
      await page.keyboard.press("Alt+KeyT");
      await expect(field).toBeFocused();
      await expect(region(page)).not.toBeFocused();
      await page.keyboard.insertText("†");
      await expect(field).toHaveValue(afterChord);
    });

    test("from a list's button, which types nothing, the chord still reaches the toasts", async ({
      page,
    }) => {
      await page.goto(typingStory);
      await expect(toasts(page)).toHaveCount(1);
      const field = page.getByRole("combobox", { name: "Type", exact: true });
      await field.focus();
      await page.keyboard.press("Alt+KeyT");
      await expect(region(page)).toBeFocused();
    });

    test("from a checkbox, which types nothing, the chord still reaches the toasts", async ({
      page,
    }) => {
      await page.goto(typingStory);
      await expect(toasts(page)).toHaveCount(1);
      const box = page.getByRole("checkbox", { name: "Select this row" });
      await box.focus();
      await page.keyboard.press("Alt+KeyT");
      await expect(region(page)).toBeFocused();
    });

    test("with another modifier held it is another chord, and nothing moves", async ({ page }) => {
      await page.goto(story("lanes-uxkit-toast--default"));
      await expect(toasts(page)).toHaveCount(1);
      const accept = page.getByRole("button", { name: "Accept 6 suggestions" });
      await accept.focus();
      for (const chord of ["Control+Alt+KeyT", "Alt+Shift+KeyT", "Alt+Meta+KeyT"]) {
        await page.keyboard.press(chord);
        await expect(accept, chord).toBeFocused();
        await expect(region(page), chord).not.toBeFocused();
      }
    });

    test("with no toast to go to it does nothing, and focus stays where it was", async ({
      page,
    }) => {
      await page.goto(story("lanes-uxkit-toast--empty"));
      await expect(toasts(page)).toHaveCount(0);
      const accept = page.getByRole("button", { name: "Accept 6 suggestions" });
      await accept.focus();
      await page.keyboard.press("Alt+KeyT");
      await expect(accept).toBeFocused();
      await expect(region(page)).not.toBeFocused();
    });
  });

  test("a problem stays until it is dismissed", async ({ page }) => {
    await page.clock.install();
    await page.goto(story("lanes-uxkit-toast--empty"));
    await page.getByRole("button", { name: "Post one that fails" }).click();
    const toast = toasts(page).first();
    await expect(toast).toHaveAttribute("data-tone", "problem");
    await freeze(page);
    await page.clock.runFor(120_000);
    await expect(toasts(page)).toHaveCount(1);
    await toast.getByRole("button", { name: "Dismiss" }).click();
    await page.clock.runFor(500);
    await expect(toasts(page)).toHaveCount(0);
  });

  test("three show at once and the rest wait their turn", async ({ page }) => {
    await page.goto(story("lanes-uxkit-toast--queue"));
    await expect(toasts(page)).toHaveCount(3);
    await expect(page.getByText("Rule saved.")).toHaveCount(0);
    await expect(page.getByText("Excluded 1 transaction.")).toHaveCount(0);
    await toasts(page).first().getByRole("button", { name: "Dismiss" }).click();
    await expect(page.getByText("Rule saved.")).toBeVisible();
    await expect(toasts(page)).toHaveCount(3);
    await page.getByRole("button", { name: "Dismiss all" }).click();
    await expect(toasts(page)).toHaveCount(0);
    await expect(page.getByText("Excluded 1 transaction.")).toHaveCount(0);
  });

  test("a toast with an id is replaced by the next one, not stacked", async ({ page }) => {
    await page.goto(story("lanes-uxkit-toast--loading"));
    await expect(toasts(page)).toHaveCount(1);
    await expect(toasts(page).first()).toContainText("Posting 6 transactions…");
    await expect(toasts(page).first()).toHaveAttribute("data-tone", "info");
    await page.getByRole("button", { name: "Finish posting" }).click();
    await expect(toasts(page)).toHaveCount(1);
    await expect(toasts(page).first()).toContainText("Posted 6 transactions.");
    await expect(toasts(page).first().getByRole("button", { name: "Undo" })).toBeVisible();
  });

  test("a long message and a long action wrap inside a phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(story("lanes-uxkit-toast--long-content"));
    const toast = toasts(page).first();
    await expect(toast).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
    const box = await toast.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
    await expect(
      toast.getByRole("button", { name: "Undo and return them to review" }),
    ).toBeVisible();
  });

  test("the toasts pass the accessibility scan in both themes, with toasts showing", async ({
    page,
  }) => {
    test.slow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const theme of ["light", "dark"] as const)
      for (const id of [
        "default",
        "error-state",
        "long-content",
        "queue",
        "typing-in-a-field",
        "dark",
      ]) {
        await page.goto(story(`lanes-uxkit-toast--${id}`, theme));
        await expect(toasts(page).first()).toBeVisible();
        await page.waitForTimeout(300);
        await expectNoViolations(page, `toast ${id} (${theme})`);
      }
  });
});

// ---- The four tones -----------------------------------------------------------------------------------

test.describe("Tones", () => {
  test("a Notice and a Status take the four tones, and the old names mean what they always meant", async ({
    page,
  }) => {
    await page.goto(story("lanes-uxkit-tones--default"));
    await expect(page.locator(".rt-notice")).toHaveCount(4);
    expect(
      await page.locator(".rt-notice").evaluateAll((nodes) => nodes.map((n) => n.dataset.tone)),
    ).toEqual(["calm", "info", "attention", "problem"]);
    expect(
      await page.locator(".rt-status").evaluateAll((nodes) => nodes.map((n) => n.dataset.tone)),
    ).toEqual(["calm", "info", "attention", "problem"]);

    await page.goto(story("lanes-uxkit-tones--legacy-names"));
    await expect(page.locator(".rt-notice")).toHaveCount(3);
    expect(
      await page.locator(".rt-notice").evaluateAll((nodes) => nodes.map((n) => n.dataset.tone)),
    ).toEqual(["calm", "attention", "problem"]);
    expect(
      await page.locator(".rt-status").evaluateAll((nodes) => nodes.map((n) => n.dataset.tone)),
    ).toEqual(["calm", "attention", "problem"]);
  });

  test("only a problem carries a warning sign, and only attention is orange", async ({ page }) => {
    await page.goto(story("lanes-uxkit-tones--default"));
    await expect(page.locator('.rt-notice[data-tone="problem"] .rt-notice-icon')).toHaveCount(1);
    for (const tone of ["calm", "info", "attention"])
      await expect(page.locator(`.rt-notice[data-tone="${tone}"] .rt-notice-icon`)).toHaveCount(0);
    const bar = (tone: string) =>
      page
        .locator(`.rt-notice[data-tone="${tone}"]`)
        .evaluate((node) => getComputedStyle(node).borderTopColor);
    expect(await bar("attention")).toBe("rgb(255, 102, 0)");
    for (const tone of ["calm", "info", "problem"])
      expect(await bar(tone)).not.toBe("rgb(255, 102, 0)");
  });

  test("each marker has its own shape, and says its tone to a screen reader except calm", async ({
    page,
  }) => {
    await page.goto(story("lanes-uxkit-tones--default"));
    const markers = page.locator(".rt-tone-marker");
    await expect(markers).toHaveCount(4);
    for (const marker of await markers.all())
      await expect(marker).toHaveAttribute("aria-hidden", "true");
    const shape = (tone: string) =>
      page.locator(`.rt-tone-marker[data-tone="${tone}"]`).evaluate((node) => {
        const style = getComputedStyle(node, "::before");
        return { clip: style.clipPath, radius: style.borderTopLeftRadius };
      });
    expect((await shape("problem")).clip).toContain("polygon");
    expect((await shape("info")).radius).toBe("50%");
    expect((await shape("attention")).clip).toBe("none");
    await expect(page.locator(".rt-sr-only", { hasText: "Needs attention:" })).toHaveCount(1);
    await expect(page.locator(".rt-sr-only", { hasText: "Problem:" })).toHaveCount(1);
    await expect(page.locator(".rt-sr-only", { hasText: "Good to know:" })).toHaveCount(1);
    // The calm marker is a tick and says nothing.
    await expect(page.locator('.rt-tone-marker[data-tone="calm"] svg')).toHaveCount(1);
  });

  test("a long name wraps in a Notice, a chip and a row on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(story("lanes-uxkit-tones--long-content"));
    await expect(page.locator(".rt-notice")).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
  });

  test("every tone page passes the accessibility scan in both themes", async ({ page }) => {
    test.slow();
    for (const theme of ["light", "dark"] as const)
      for (const id of [
        "default",
        "empty",
        "loading",
        "error-state",
        "long-content",
        "legacy-names",
      ]) {
        await page.goto(story(`lanes-uxkit-tones--${id}`, theme));
        await expect(page.locator(".rt-notice").first()).toBeVisible();
        await expectNoViolations(page, `tones ${id} (${theme})`);
      }
  });
});
