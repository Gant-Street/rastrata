import { expect, test } from "@playwright/test";
import axe from "axe-core";

declare global {
  interface Window {
    axe: typeof axe;
  }
}

test("journal route is honest about connection state and survives reload", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  // Transactions opens on For review; the list of every transaction is the page's other view.
  await page.getByRole("link", { name: "Transactions", exact: true }).click();
  await expect(page).toHaveURL(/\/inbox$/);
  await page.goto("/journal");
  await expect(page).toHaveURL(/\/journal$/);
  await expect(page.getByRole("heading", { name: "Transactions", exact: true })).toBeVisible();
  await expect(page.getByText("No book connected", { exact: true })).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(page.getByText(/North Workshop|JRN-0044/)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Transactions", exact: true })).toHaveCSS(
    "font-family",
    /Inter/,
  );
  await page.reload();
  await expect(page.getByText("No book connected", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const license = await request.get("/licenses/inter.txt");
  expect(license.status()).toBe(200);
  expect(await license.text()).toContain("SIL OPEN FONT LICENSE");
  // The figures' face is bundled too, and its licence is served beside Inter's.
  const mono = await request.get("/licenses/jetbrains-mono.txt");
  expect(mono.status()).toBe(200);
  expect(await mono.text()).toContain("SIL OPEN FONT LICENSE");
  expect(errors).toEqual([]);
});

// Lightning CSS (inside the Tailwind pipeline this app builds with) collapses color-mix() that
// takes a custom property to its first color. The shared tokens use literal inputs so tints
// survive; this guards the resolved values in both themes through the real pipeline.
for (const [theme, expected] of [
  [
    "light",
    { muted: "rgb(92, 92, 92)", divider: "rgb(227, 227, 227)", hover: "rgb(245, 245, 245)" },
  ],
  ["dark", { muted: "rgb(168, 168, 168)", divider: "rgb(41, 41, 41)", hover: "rgb(20, 20, 20)" }],
] as const) {
  test(`shared color tints resolve to real mixtures, not black or white (${theme})`, async ({
    page,
  }) => {
    await page.goto("/");
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    const resolved = await page.evaluate(() => {
      const probe = document.createElement("span");
      document.body.append(probe);
      const read = (token: string) => {
        probe.style.color = `var(--rt-${token})`;
        return getComputedStyle(probe).color;
      };
      const out = { muted: read("muted"), divider: read("divider"), hover: read("hover") };
      probe.remove();
      return out;
    });
    expect(resolved).toEqual(expected);
  });
}

test("navigation, history, refresh and missing routes work without runtime errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
  await expect(page.locator("header.app-header")).toHaveCSS("display", "flex");
  await page.goto("/journal");
  await expect(page).toHaveURL(/\/journal$/);
  await expect(page.getByRole("heading", { name: "Transactions", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Transactions", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("heading", { name: "Transactions", exact: true })).toBeVisible();
  await page.goto("/missing/nested");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await page.getByRole("link", { name: "Go home", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
  expect(errors).toEqual([]);
});

// The nested Ark controls test (a combobox inside a dialog, from the keyboard) was driven against the
// scaffold page /checks. It is a story now: packages/ui/tests/nested-controls.spec.ts, in all three browsers.

test("missing assets and API requests never receive the SPA document", async ({ request }) => {
  for (const path of ["/missing.js", "/assets/missing.css", "/.env", "/api/books"]) {
    const response = await request.get(path, { headers: { Accept: "text/html" } });
    expect(response.status()).toBe(404);
    expect(response.headers()["content-type"]).not.toContain("text/html");
  }
  const response = await request.post("/missing/nested");
  expect([404, 405]).toContain(response.status());
});

// ---- The navigation ---------------------------------------------------------------------------------
// The real header against a service with no book behind it: the destinations are the application's own,
// whether or not a service answers. (The first-run header, with only the wordmark, is in chart-setup.spec.ts.)

const bar = ["Home", "Transactions", "Accounts", "Reports"] as const;

test("the header lists the four places, then Search, New and Settings, and marks where you are", async ({
  page,
}) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await expect(nav.locator(".rt-appnav-bar > li > a")).toHaveText(bar);
  await expect(nav.getByRole("link", { name: "Home", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  for (const name of ["Search", "New"])
    await expect(nav.getByRole("button", { name, exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  // Home has no tabs, so no row of tabs sits under its header.
  await expect(page.getByRole("navigation", { name: /pages$/ })).toHaveCount(0);

  // A place opens on its first page. Transactions is one destination (its two views are the page's own
  // switch and Rules is a link in its header), so no row of tabs sits under the header.
  await nav.getByRole("link", { name: "Transactions", exact: true }).click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(nav.getByRole("link", { name: "Transactions", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  // The browser tab says where you are, and a screen reader is told when the page changes.
  await expect(page).toHaveTitle("Transactions · Rastrata");
  await expect(page.locator(".app-shell > p[aria-live=polite]")).toHaveText("Transactions");
  await expect(page.getByRole("navigation", { name: /pages$/ })).toHaveCount(0);

  // The pages under it keep the place marked, each by its own name: the list of every transaction (and an
  // entry under it), the rules (and a new rule), and importing a statement.
  for (const [path, title] of [
    ["/journal", "All transactions"],
    ["/journal/new", "All transactions"],
    ["/rules", "Rules"],
    ["/rules/new", "Rules"],
    ["/import", "Transactions"],
  ] as const) {
    await page.goto(path);
    await expect(nav.getByRole("link", { name: "Transactions", exact: true })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expect(page).toHaveTitle(`${title} · Rastrata`);
    await expect(page.getByRole("navigation", { name: /pages$/ })).toHaveCount(0);
  }

  // Accounts is one page with no row of tabs: an account's own page sits under it, and so does Reconcile.
  await page.goto("/ledger");
  await expect(page).toHaveTitle("Accounts · Rastrata");
  await expect(page.getByRole("navigation", { name: /pages$/ })).toHaveCount(0);
  await page.goto("/reconcile");
  await expect(page).toHaveTitle("Reconcile · Rastrata");
  await expect(page.getByRole("navigation", { name: /pages$/ })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Accounts", exact: true })).toHaveAttribute(
    "aria-current",
    "true",
  );

  // Reports is one page with no row of tabs: the tax tools and Money by payee are pages under it.
  for (const path of ["/tax", "/reports/payees", "/reports?tab=balance-sheet"]) {
    await page.goto(path);
    await expect(nav.getByRole("link", { name: "Reports", exact: true })).toHaveAttribute(
      "aria-current",
      /page|true/,
    );
    await expect(page.getByRole("navigation", { name: /pages$/ })).toHaveCount(0);
  }
});

test("Settings is a page with a list of its own pages, and what brings books in sits under one of them", async ({
  page,
}) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await nav.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(nav.getByRole("link", { name: "Settings", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  const list = page.getByRole("navigation", { name: "Settings", exact: true });
  await expect(list.getByRole("link")).toHaveText([
    "Business",
    "Agents",
    "Connections",
    "Backups and export",
    "Bring in your books",
    "Close the books",
    "Changes",
  ]);
  await expect(list.getByRole("link", { name: "Business" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  // Bring in your books is one page with every way in, each a link to its page; the entry stays marked on them.
  const bringIn = list.getByRole("link", { name: "Bring in your books" });
  await bringIn.click();
  await expect(page).toHaveURL(/\/settings\/bring-in$/);
  await expect(page).toHaveTitle("Bring in your books · Rastrata");
  const ways = page.locator("main .rt-report-index");
  await expect(ways.getByRole("heading", { level: 2 })).toHaveText([
    "Start from a date",
    "Past years",
    "Moving from Xero",
  ]);
  await expect(ways.locator(".rt-index-name")).toHaveText([
    "Start date and opening balances",
    "Bring in history",
    "Import from Xero",
    "Compare with Xero",
    "Things to check",
  ]);
  for (const [name, path, title] of [
    [/^Start date and opening balances/, /\/opening$/, "Start date and opening balances"],
    [/^Bring in history/, /\/settings\/history$/, "Bring in history"],
  ] as const) {
    await page.goto("/settings/bring-in");
    await ways.getByRole("link", { name }).click();
    await expect(page).toHaveURL(path);
    await expect(page).toHaveTitle(`${title} · Rastrata`);
    await expect(bringIn).toHaveAttribute("aria-current", "true");
  }
  // The three steps of a move from Xero are on the same page, and lead to the screens that do them. The
  // address that used to list them opens this page.
  for (const [name, path] of [
    [/^Import from Xero/, /\/xero$/],
    [/^Compare with Xero/, /\/tie-out$/],
    [/^Things to check/, /\/gaps$/],
  ] as const) {
    await page.goto("/settings/move");
    await expect(
      page.getByRole("heading", { level: 1, name: "Bring in your books" }),
    ).toBeVisible();
    await page.getByRole("link", { name }).click();
    await expect(page).toHaveURL(path);
    await expect(bringIn).toHaveAttribute("aria-current", "true");
  }
  // Close the books and the record of changes are pages of Settings.
  await list.getByRole("link", { name: "Close the books" }).click();
  await expect(page).toHaveURL(/\/periods$/);
  await expect(nav.getByRole("link", { name: "Settings", exact: true })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await list.getByRole("link", { name: "Changes" }).click();
  await expect(page).toHaveURL(/\/changes$/);
  // Stripe and the bank connection are under Connections.
  await page.goto("/settings/stripe");
  await expect(list.getByRole("link", { name: "Connections" })).toHaveAttribute(
    "aria-current",
    "true",
  );
});

test("+ New is a menu that works from the keyboard", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  const create = nav.getByRole("button", { name: "New", exact: true });
  const panel = nav.locator(".rt-appnav-actions");
  await expect(create).toHaveAttribute("aria-expanded", "false");
  await expect(panel).toBeHidden();

  // The Down arrow opens it on the first thing it offers; the arrows, Home and End move. A thing that goes
  // to a page is still a link (it has an address, so it opens in a new tab when asked to); a thing that
  // opens a form over this page (a dialog) is not. It is one short list: what is started from anywhere.
  // (What has a button on its own page, like importing a statement, is found by Search.)
  const things = panel.getByRole("menuitem");
  await create.focus();
  await page.keyboard.press("ArrowDown");
  await expect(create).toHaveAttribute("aria-expanded", "true");
  // The keys go to the list once it has focus.
  await expect(panel).toBeFocused();
  await expect(things.first()).toHaveAttribute("data-highlighted", "");
  await expect(things).toHaveText(["Transaction", "Journal entry", "Account"]);
  await expect(things.first()).not.toHaveAttribute("href");
  for (const name of ["Journal entry", "Account"])
    await expect(panel.getByRole("menuitem", { name, exact: true })).toHaveAttribute("href", /.+/);
  await page.keyboard.press("End");
  await expect(things.last()).toHaveAttribute("data-highlighted", "");
  await page.keyboard.press("Home");
  await expect(things.first()).toHaveAttribute("data-highlighted", "");

  // Escape closes it and puts focus back on its button.
  await page.keyboard.press("Escape");
  await expect(create).toHaveAttribute("aria-expanded", "false");
  await expect(create).toBeFocused();

  // Enter on a thing goes there and puts the list away.
  await create.press("Enter");
  // The keys go to the list once it has focus.
  await expect(panel).toBeFocused();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await expect(panel.getByRole("menuitem", { name: "Journal entry", exact: true })).toHaveAttribute(
    "data-highlighted",
    "",
  );
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/journal\/new$/);
  await expect(create).toHaveAttribute("aria-expanded", "false");

  // Pressing anywhere else puts it away.
  await create.click();
  await expect(create).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("main").click({ position: { x: 5, y: 5 } });
  await expect(create).toHaveAttribute("aria-expanded", "false");
});

test("Search opens with Cmd-K or Ctrl-K, lists pages and actions, and goes there from the keyboard", async ({
  page,
}) => {
  await page.goto("/");
  // The shortcut is installed when the page draws, which can be after the page has loaded; a key pressed before that is lost.
  await expect(page.getByRole("banner")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "Search" });
  await expect(dialog).toBeVisible();
  const box = dialog.getByRole("combobox");
  await expect(box).toBeFocused();
  // With nothing typed it is the list of where you can go and what you can start.
  await expect(dialog.getByRole("option", { name: /^Reports/ })).toBeVisible();
  await expect(dialog.getByRole("option", { name: /^Journal entry/ })).toBeVisible();

  // Words narrow it; the first result is highlighted and Enter opens it.
  await box.fill("reconc");
  // The action, the page, and last the topic of Help that says how.
  await expect(dialog.getByRole("option")).toHaveText([
    /^Reconcile an account/,
    /^Reconcile/,
    /^Reconcile a bank or card account/,
  ]);
  await expect(dialog.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await expect(box).toHaveAttribute("aria-activedescendant", /.+/);
  await box.press("ArrowDown");
  await expect(dialog.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
  await box.press("ArrowDown");
  await box.press("ArrowDown");
  // It wraps at the ends.
  await expect(dialog.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await box.press("ArrowUp");
  await expect(dialog.getByRole("option").nth(2)).toHaveAttribute("aria-selected", "true");
  await box.press("ArrowUp");
  await expect(dialog.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
  await box.press("Enter");
  await expect(page).toHaveURL(/\/reconcile$/);
  await expect(dialog).toBeHidden();

  // A page's own words work too: "inbox" is what the CLI calls the list that waits for review.
  await page.keyboard.press("ControlOrMeta+k");
  await dialog.getByRole("combobox").fill("inbox");
  await expect(dialog.getByRole("option", { name: /^Transactions/ })).toBeVisible();
  await dialog.getByRole("combobox").press("Enter");
  await expect(page).toHaveURL(/\/inbox$/);

  // Nothing found says so, in words.
  await page.keyboard.press("ControlOrMeta+k");
  await dialog.getByRole("combobox").fill("zzzzqq");
  await expect(dialog.locator(".rt-search-empty")).toHaveText(
    'Nothing found for "zzzzqq". Try a name, a code or a date.',
  );
  await expect(dialog.getByRole("option")).toHaveCount(0);

  // Escape closes it and gives focus back to where it was.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("when the session ends the sign-in stands above everything: an open form is kept behind it, nothing behind can be reached, it cannot be put away, nothing opens over it, and signing in gives the form back", async ({
  page,
  browserName,
}) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await nav.getByRole("button", { name: "New", exact: true }).click();
  await nav.getByRole("menuitem", { name: "Transaction", exact: true }).click();
  const entry = page.getByRole("dialog", { name: "New transaction" });
  await entry.getByLabel("Amount").fill("12.34");

  // The service answers a request with 401: the session has ended. (The key is taken by the test.)
  await page.route("**/session/owner", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("rastrata:signin-required")));
  const signin = page.getByRole("alertdialog", { name: "Sign in" });
  await expect(signin).toBeVisible();
  const key = signin.locator('input[name="key"]');
  await expect(key).toBeFocused();

  // It is above the form that was open: what is under the pointer in the middle of it is its own.
  expect(
    await signin.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return top !== null && element.contains(top);
    }),
  ).toBe(true);
  // Nothing of the page shows behind it.
  await expect(page.locator(".rt-backdrop[data-opaque]")).toBeVisible();
  // What is behind is out of a screen reader's reach, the form and the page both.
  await expect(page.getByRole("dialog", { name: "New transaction" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toHaveCount(0);
  // And out of the keyboard's: Tab stays inside the sign-in.
  const modifier = browserName === "webkit" && process.platform === "darwin" ? "Alt+" : "";
  for (let step = 0; step < 5; step++) {
    await page.keyboard.press(`${modifier}Tab`);
    await expect
      .poll(() => signin.evaluate((element) => element.contains(document.activeElement)))
      .toBe(true);
  }

  // It cannot be put away: not with Escape, not with a press outside it.
  await page.keyboard.press("Escape");
  await expect(signin).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(signin).toBeVisible();
  // Nothing opens over it.
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator(".rt-search")).toHaveCount(0);
  await expect(signin).toBeVisible();

  // An empty key is asked for again, in words.
  await key.focus();
  await page.keyboard.press("Enter");
  await expect(signin.getByRole("alert")).toHaveText("Enter the owner key.");
  await expect(key).toBeFocused();

  // Signed in: the sign-in goes, and the form is as it was left and can be typed in again.
  await key.fill("a-key-the-test-service-takes");
  await page.keyboard.press("Enter");
  await expect(signin).toHaveCount(0);
  await expect(entry).toBeVisible();
  await expect(entry.getByLabel("Amount")).toHaveValue("12.34");
  await entry.getByLabel("Amount").fill("12.35");
  await expect(entry.getByLabel("Amount")).toHaveValue("12.35");
  // Escape is the form's again.
  await page.keyboard.press("Escape");
  await expect(entry).toBeHidden();
});

test("the Search button opens the same dialog and Escape returns focus to it", async ({
  page,
  browserName,
}) => {
  await page.goto("/reports");
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  const search = nav.getByRole("button", { name: "Search", exact: true });
  await search.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Search" });
  await expect(dialog).toBeVisible();
  // The dialog is on screen a moment before focus is held inside it; a person waits for the cursor to be in
  // the box, so the test does too (a Tab sent earlier moves along the page behind, and Escape would then
  // give focus back to wherever that Tab left it).
  await expect(dialog.getByRole("combobox")).toBeFocused();
  // Focus stays inside the dialog while it is open. (Safari on a Mac does not Tab to buttons unless asked
  // to; Option-Tab is its way through everything.)
  const modifier = browserName === "webkit" && process.platform === "darwin" ? "Alt+" : "";
  for (let step = 0; step < 4; step++) {
    await page.keyboard.press(`${modifier}Tab`);
    await expect
      .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
      .toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(search).toBeFocused();
});

test("on a phone the Menu button holds every section, New and Search, and no page has a row of tabs", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/journal");
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await expect(nav.getByRole("link", { name: "Transactions", exact: true })).toBeHidden();
  const menu = nav.getByRole("button", { name: "Menu" });
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await menu.focus();
  await page.keyboard.press("Enter");
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  for (const name of [...bar, "Settings"])
    await expect(nav.getByRole("link", { name, exact: true })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Search", exact: true })).toBeVisible();
  for (const name of ["Journal entry", "Account"])
    await expect(nav.getByRole("link", { name, exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(menu).toBeFocused();

  // Choosing a section goes there and puts the list away.
  await menu.click();
  await nav.getByRole("link", { name: "Transactions", exact: true }).click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(menu).toHaveAttribute("aria-expanded", "false");

  // Search is in the Menu too.
  await menu.click();
  await nav.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
  await page.keyboard.press("Escape");

  // The list of reports is three groups, one under another, and the page does not scroll sideways.
  await page.goto("/reports");
  await expect(page.getByRole("navigation", { name: /pages$/ })).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Statements" }).getByRole("link")).toHaveCount(3);
  await expect(page.getByRole("list", { name: "Tax time" }).getByRole("link")).toHaveCount(5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

for (const [theme, width] of [
  ["light", 1280],
  ["dark", 1280],
  ["light", 390],
  ["dark", 390],
] as const) {
  for (const open of ["navigation", "search"] as const) {
    test(`the header with ${open === "search" ? "Search" : width > 900 ? "+ New" : "the Menu"} open passes the accessibility scan (${theme}, ${width} px)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/inbox");
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      const nav = page.getByRole("navigation", { name: "Main navigation" });
      if (open === "search") {
        // The shortcut is installed when the page draws, which can be after the page has loaded; a key pressed before that is lost.
        await expect(page.getByRole("banner")).toBeVisible();
        await page.keyboard.press("ControlOrMeta+k");
        await page.getByRole("dialog", { name: "Search" }).getByRole("combobox").fill("re");
        await expect(page.getByRole("option").first()).toBeVisible();
      } else {
        await nav.getByRole("button", { name: width > 900 ? "New" : "Menu", exact: true }).click();
      }
      await page.addStyleTag({
        content: "*,*::before,*::after{transition:none!important;animation:none!important}",
      });
      await page.addScriptTag({ content: axe.source });
      const violations = await page.evaluate(async () =>
        (
          await window.axe.run(document.body, {
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
          })
        ).violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })),
      );
      expect(violations).toEqual([]);
    });
  }
}

// The Settings pages the shell owns, with their list and their page header: no accessibility violations
// in either theme at either width.
for (const path of [
  "/settings",
  "/settings/members",
  "/settings/workspace",
  "/settings/connections",
  "/settings/bring-in",
  "/settings/move",
]) {
  for (const [theme, width] of [
    ["light", 1280],
    ["dark", 1280],
    ["light", 390],
    ["dark", 390],
  ] as const) {
    test(`${path} passes the accessibility scan (${theme}, ${width} px)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await page.addStyleTag({
        content: "*,*::before,*::after{transition:none!important;animation:none!important}",
      });
      await page.addScriptTag({ content: axe.source });
      const violations = await page.evaluate(async () =>
        (
          await window.axe.run(document.body, {
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
          })
        ).violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })),
      );
      expect(violations).toEqual([]);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    });
  }
}

// A service with no book behind it: every screen says so, and none of them fails to open. (Screens
// that read with a suspending resource used to throw here, which replaced the whole page.)
for (const path of [
  "/accounts",
  "/journal",
  "/journal/new",
  "/reconcile",
  "/settings",
  "/settings/connections",
  "/settings/bring-in",
  "/settings/move",
  "/settings/stripe",
  "/periods",
  "/changes",
  "/rules",
  "/import",
  "/settings/backups",
  "/cutover",
  "/opening",
  "/xero",
  "/tie-out",
  "/gaps",
]) {
  test(`${path} opens without a book and does not fail`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Unable to open this page" })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
    expect(errors).toEqual([]);
  });
}

// A page's title takes focus when the page opens (so a screen reader starts at the title). It is not a
// control, so it draws no ring: the ring belongs on controls and on keyboard use.
for (const path of ["/inbox", "/settings/stripe"]) {
  test(`${path}: the title takes focus when the page opens and draws no ring`, async ({ page }) => {
    await page.goto(path);
    const title = page.getByRole("heading", { level: 1 }).first();
    await expect(title).toBeFocused();
    await expect(title).toHaveCSS("outline-style", "none");
  });
}
