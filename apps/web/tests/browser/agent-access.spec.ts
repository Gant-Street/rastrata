import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";

declare global {
  interface Window {
    axe: typeof axe;
  }
}

// Settings, Agents on a computer that runs the service itself, against the real local API with the owner
// lock on: the web server acts for the owner with the key, so the page works, while the API refuses anyone
// who brings no credentials. Here an agent is connected with `rastrata connect`, which asks the service for
// a token as the owner and keeps it; the page gives the command and lists what is connected, and never holds
// a credential. The command line itself is tested in apps/terminal; what it does at the service (the owner
// makes a token) is done here through the web server. One browser and serial tests, on a book of its own.
/** The locked service itself, for the calls that must not pass through the web server (which adds
 * the owner key). The config hands out the ports, so the address is in the project's metadata. */
const serviceUrl = (): string => String(test.info().project.metadata.api);
const book = {
  name: "Agent Access Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1000", name: "Cash", role: "asset" },
    { code: "3000", name: "Capital", role: "equity" },
  ],
};
test.describe.configure({ mode: "serial" });

/** What is connected, as the page lists it. */
const connected = (page: Page) => page.locator(".rt-agent-connected-row");

/** The command the page tells the person to run. */
const command = (page: Page) => page.locator(".rt-agent-code");

/** The row of "Needs you" on Home about agents: it is there only when one stops working within 14 days. */
const agentsRow = (page: Page) => page.locator('[data-need="tokens"]');

/** Home has read everything it asks about, so a row that is not there is not there for good. */
const homeRead = (page: Page) => expect(page.locator(".rt-today")).toHaveAttribute("data-read", "");

const envelope = (input: unknown, operationId?: string) => ({
  data: {
    version: "rastrata-application-v1",
    bookId: "local-book",
    input,
    ...(operationId ? { operationId } : {}),
  },
});

async function scan(page: Page, theme: "light" | "dark", scope: "page" | "home-line" = "page") {
  // A scan must not sample colors in the middle of the theme change's short transition.
  await page.addStyleTag({
    content: "*,*::before,*::after{transition:none!important;animation:none!important}",
  });
  await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
  await page.addScriptTag({ content: axe.source });
  const result = await page.evaluate((where) => {
    const root =
      where === "home-line"
        ? document.querySelector('[data-need="tokens"]')
        : document.querySelector("main");
    return window.axe.run(root as HTMLElement, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
    });
  }, scope);
  expect(
    result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })),
    `${scope} ${theme}`,
  ).toEqual([]);
}

let secret = "";
let tokenId = "";

test("the page is three steps and one command, which follows the choice and holds no credential", async ({
  page,
  request,
  context,
  baseURL,
  browserName,
}) => {
  // A test can grant clipboard access only in Chromium.
  if (browserName === "chromium")
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  // The service starts without a book; set it up through the web server, which holds the owner key.
  const setup = await request.post(`${baseURL}/v1/book.setup`, {
    ...envelope(book, crypto.randomUUID()),
  });
  expect(setup.ok(), await setup.text()).toBe(true);
  // The API itself refuses a caller with no credentials.
  expect((await request.post(`${serviceUrl()}/v1/book.get`, envelope({}))).status()).toBe(401);

  // Home lists what needs a person, not features: with nothing connected there is no row about agents,
  // and the way in is Settings, then Agents.
  await page.goto("/");
  await homeRead(page);
  await expect(agentsRow(page)).toHaveCount(0);
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  const settings = nav.getByRole("link", { name: "Settings", exact: true });
  await settings.click();
  const list = page.getByRole("navigation", { name: "Settings", exact: true });
  await list.getByRole("link", { name: "Agents", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/agent$/);
  await expect(page.getByRole("heading", { level: 1, name: "Agents" })).toBeVisible();
  await expect(settings).toHaveAttribute("aria-current", "true");
  await expect(list.getByRole("link", { name: "Agents", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );

  // Three steps, in order, each with its title.
  await expect(page.locator(".rt-agent-step-title")).toHaveText([
    "What may it do?",
    "Run this where your agent works",
    "Then ask it",
  ]);
  // The usual choice is made already; the owner of the book may give all three.
  const choices = page.getByRole("radiogroup", { name: "What may it do?" });
  await expect(choices.getByRole("radio")).toHaveCount(3);
  await expect(choices.getByRole("radio", { name: /Prepare, for my approval/ })).toBeChecked();
  // On this computer the owner is the one asking, so there is no code and nothing to press: the command is there.
  await expect(page.getByRole("button", { name: "Get the command" })).toHaveCount(0);
  await expect(command(page)).toHaveText("rastrata connect");
  await expect(page.locator(".rt-agent-ask")).toHaveText(
    "“Review this week’s transactions and show me what you would post.”",
  );
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Copied" })).toBeVisible();
  if (browserName === "chromium")
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("rastrata connect");

  // The command and what to say follow the choice, by keyboard: the arrow keys move it.
  await choices.getByRole("radio", { name: /Prepare/ }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(choices.getByRole("radio", { name: "Read only." })).toBeChecked();
  await expect(command(page)).toHaveText("rastrata connect --preset read-only");
  await expect(page.locator(".rt-agent-ask")).toHaveText("“How did last month go?”");
  await page.keyboard.press("ArrowDown");
  await expect(choices.getByRole("radio", { name: /Run the books/ })).toBeChecked();
  await expect(command(page)).toHaveText("rastrata connect --preset bookkeeper");
  await expect(page.locator(".rt-agent-ask")).toHaveText("“Do this week’s bookkeeping.”");

  await expect(page.getByRole("heading", { name: "Connected" })).toBeVisible();
  await expect(page.getByText("Nothing is connected yet.")).toBeVisible();
  // Nothing about tokens, permissions or keys is on the page, and no "how this works".
  const main = page.locator("main");
  for (const word of ["token", "Token", "permission", "owner key", "How this works", "rst_"])
    await expect(main).not.toContainText(word);
});

test("what the command line connected is listed when the person comes back, by its name and what it may do", async ({
  page,
  request,
  baseURL,
}) => {
  await page.goto("/settings/agent");
  await expect(page.getByText("Nothing is connected yet.")).toBeVisible();
  // `rastrata connect --preset bookkeeper`, as the service sees it: its owner makes a token, named for where the agent runs.
  const created = await request.post(`${baseURL}/v1/tokens.create`, {
    ...envelope(
      { label: "Agent on studio-mac", permissions: ["read", "draft", "post"] },
      crypto.randomUUID(),
    ),
  });
  expect(created.ok(), await created.text()).toBe(true);
  secret = (await created.json()).data.secret as string;
  expect(secret).toMatch(/^rst_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
  tokenId = secret.slice(4, 20);

  // The person comes back from the terminal: the page reads what is connected again, with no reload.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const row = connected(page).filter({ hasText: "Agent on studio-mac" });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Run the books · Not used yet");
  // Being on the list is being connected: nothing says "active", and its end is said only when it is near.
  await expect(row).not.toContainText(/Active|Ends|Expires/);
  await expect(page.getByText("Nothing is connected yet.")).toHaveCount(0);

  // The token works against the API with exactly what was chosen, and cannot connect or disconnect anything itself.
  const asAgent = await request.post(`${serviceUrl()}/v1/book.get`, {
    ...envelope({}),
    headers: { authorization: `Bearer ${secret}` },
  });
  expect(asAgent.ok()).toBe(true);
  expect((await asAgent.json()).data).toMatchObject({
    principal: { kind: "token", tokenId, label: "Agent on studio-mac" },
    permissions: ["read", "draft", "post"],
    ownerAccess: "key",
  });
  const denied = await request.post(`${serviceUrl()}/v1/tokens.list`, {
    ...envelope({}),
    headers: { authorization: `Bearer ${secret}` },
  });
  expect(denied.status()).toBe(403);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(row).toContainText("Run the books · Used just now");

  // The page never held the credential: not in what it shows, not in what it keeps.
  await expect(page.locator("body")).not.toContainText(secret.slice(21));
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
  ).not.toContain(secret.slice(21));

  // What the agents changed is one link away, where the changes are listed.
  await page.getByRole("link", { name: "What agents changed" }).click();
  await expect(page).toHaveURL(/\/changes\?who=agent$/);
  // A connection that works is a setting, not a need: Home says nothing about it.
  await page.goto("/");
  await homeRead(page);
  await expect(agentsRow(page)).toHaveCount(0);
});

test("an agent that is about to stop working is the one thing Home says about agents", async ({
  page,
  request,
  baseURL,
}) => {
  // The web server holds the owner key, so this is the owner making a short-lived token.
  const created = await request.post(`${baseURL}/v1/tokens.create`, {
    ...envelope(
      { label: "Ends in a week", permissions: ["read"], expiresInDays: 7 },
      crypto.randomUUID(),
    ),
  });
  expect(created.ok(), await created.text()).toBe(true);
  const shortLived = (await created.json()).data.token.id as string;

  await page.goto("/");
  const line = agentsRow(page);
  await expect(line).toHaveAttribute("data-tone", "attention");
  await expect(line).toContainText("Needs attention: 1 agent stops working within 14 days.");
  await line.getByRole("link", { name: /See agents/ }).click();
  await expect(page).toHaveURL(/\/settings\/agent$/);
  // The page says which, and when.
  await expect(connected(page).filter({ hasText: "Ends in a week" })).toContainText(
    /Read only · Not used yet · Ends [A-Z][a-z]{2} \d{1,2}, \d{4}/,
  );
  await page.goto("/");
  await expect(line).toBeVisible();
  await scan(page, "light", "home-line");
  await scan(page, "dark", "home-line");

  // Once it is disconnected it is no longer counted, and the row goes.
  const revoked = await request.post(`${baseURL}/v1/tokens.revoke`, {
    ...envelope({ tokenId: shortLived }, crypto.randomUUID()),
  });
  expect(revoked.ok(), await revoked.text()).toBe(true);
  await page.reload();
  await homeRead(page);
  await expect(line).toHaveCount(0);
});

test("disconnecting is keyboard-operable, safe by default, asks nothing else, and stops the agent at once", async ({
  page,
  request,
}) => {
  await page.goto("/settings/agent");
  const disconnect = page.getByRole("button", { name: "Disconnect Agent on studio-mac" });
  await disconnect.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("alertdialog", { name: "Disconnect Agent on studio-mac?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(
    "It stops working within a few minutes. What it did stays in the books.",
  );
  await expect(dialog.getByRole("textbox")).toHaveCount(0);
  // The safe choice has focus; Escape closes and returns focus to where it was.
  await expect(dialog.getByRole("button", { name: "Keep it" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(disconnect).toBeFocused();
  await page.keyboard.press("Enter");
  await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  // One a person disconnected is gone from the list: it is their own doing, and nothing is left to do about it.
  await expect(connected(page).filter({ hasText: "Agent on studio-mac" })).toHaveCount(0);
  await expect(page.getByText("Nothing is connected yet.")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "was disconnected" })).toHaveCount(1);
  const after = await request.post(`${serviceUrl()}/v1/book.get`, {
    ...envelope({}),
    headers: { authorization: `Bearer ${secret}` },
  });
  expect(after.status()).toBe(401);
  expect((await after.json()).error.code).toBe("token_revoked");
  await page.goto("/");
  await homeRead(page);
  await expect(agentsRow(page)).toHaveCount(0);
});

test("a disconnect whose reply was lost says it is still connected, and trying again ends it once", async ({
  page,
  request,
  baseURL,
}) => {
  const created = await request.post(`${baseURL}/v1/tokens.create`, {
    ...envelope({ label: "Lost reply agent", permissions: ["read"] }, crypto.randomUUID()),
  });
  expect(created.ok(), await created.text()).toBe(true);
  await page.goto("/settings/agent");
  await page.route("**/v1/tokens.revoke", async (route) => {
    await route.fetch();
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "Disconnect Lost reply agent" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Disconnect Lost reply agent?" });
  await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(
    dialog.getByText("It could not be disconnected. It is still connected."),
  ).toBeVisible();
  await page.unroute("**/v1/tokens.revoke");
  // The same request, again: the service answers what it did the first time.
  await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(connected(page).filter({ hasText: "Lost reply agent" })).toHaveCount(0);
});

test("at 360 and 390 px wide nothing on the page is wider than the screen", async ({
  page,
  request,
  baseURL,
}) => {
  // A long name with no spaces, and permissions given another way (the command line's --permissions): named, not hidden.
  const created = await request.post(`${baseURL}/v1/tokens.create`, {
    ...envelope(
      {
        label: "Agent-on-a-very-long-hostname-that-somebody-gave-a-build-machine",
        permissions: ["read", "draft", "post", "configure", "correct", "close"],
      },
      crypto.randomUUID(),
    ),
  });
  expect(created.ok(), await created.text()).toBe(true);
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/settings/agent");
    const row = connected(page).filter({ hasText: "Agent-on-a-very-long-hostname" });
    await expect(row).toContainText("Read, Draft, Post, Configure, Correct, Close");
    await page.getByRole("radio", { name: /Run the books/ }).check({ force: true });
    await expect(command(page)).toHaveText("rastrata connect --preset bookkeeper");
    const widths = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth,
      window: window.innerWidth,
      offenders: [...document.querySelectorAll("main *")]
        .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
        .map((element) => `${element.tagName.toLowerCase()}.${String(element.className)}`)
        .slice(0, 8),
    }));
    expect(widths.offenders, `${width}`).toEqual([]);
    expect(widths.page, `${width}`).toBeLessThanOrEqual(widths.window);
  }
});

test("the screen passes the accessibility scan in both themes", async ({ page }) => {
  await page.goto("/settings/agent");
  await expect(page.getByRole("heading", { level: 1, name: "Agents" })).toBeVisible();
  // Scan the settled page, not one that is still reading its list.
  await expect(connected(page).first()).toBeVisible();
  await scan(page, "light");
  await scan(page, "dark");
  // And with the dialog open.
  await page
    .getByRole("button", { name: /^Disconnect / })
    .first()
    .click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await scan(page, "light");
  await scan(page, "dark");
});

test("screenshots of the screen, and of Home with an agent about to stop", async ({
  page,
  request,
  baseURL,
}) => {
  const directory = process.env.AGENT_SCREENSHOT_DIR;
  test.skip(!directory, "set AGENT_SCREENSHOT_DIR to take them");
  for (const [name, width, height, theme] of [
    ["desktop-light", 1440, 900, "light"],
    ["desktop-dark", 1440, 900, "dark"],
    ["phone-light", 390, 844, "light"],
    ["phone-dark", 390, 844, "dark"],
    ["small-light", 360, 800, "light"],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/settings/agent");
    await page.evaluate(
      (value) => document.documentElement.setAttribute("data-theme", value),
      theme,
    );
    await expect(page.getByRole("heading", { level: 1, name: "Agents" })).toBeVisible();
    await expect(connected(page).first()).toBeVisible();
    await page.screenshot({ path: `${directory}/installed-${name}.png`, fullPage: true });
  }

  // Home, with an agent that stops in a week, so a row asks for a person.
  const created = await request.post(`${baseURL}/v1/tokens.create`, {
    ...envelope(
      { label: "Ends in a week", permissions: ["read"], expiresInDays: 7 },
      crypto.randomUUID(),
    ),
  });
  expect(created.ok(), await created.text()).toBe(true);
  for (const [name, width, height, theme] of [
    ["desktop-light", 1440, 900, "light"],
    ["phone-dark", 390, 844, "dark"],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await page.evaluate(
      (value) => document.documentElement.setAttribute("data-theme", value),
      theme,
    );
    await expect(agentsRow(page)).toHaveAttribute("data-tone", "attention");
    await page.screenshot({ path: `${directory}/installed-home-${name}.png`, fullPage: true });
  }
  const revoked = await request.post(`${baseURL}/v1/tokens.revoke`, {
    ...envelope({ tokenId: (await created.json()).data.token.id }, crypto.randomUUID()),
  });
  expect(revoked.ok(), await revoked.text()).toBe(true);
});
