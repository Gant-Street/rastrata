import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import axe from "axe-core";
import { shown } from "../support/shown";
import { pick } from "../support/pick";
declare global {
  interface Window {
    axe: typeof axe;
  }
}

/** The Rules screen against the real local API, the real engine and a real statement in the Inbox,
 * driven the way a person would: write a rule and see what it matches before saving it, put the
 * specific rule above the general one from the keyboard, edit a rule, try a line, start a rule from
 * a line in the Inbox, train the classifier, delete a rule. One fresh book of its own; the tests run
 * one after another. Every line here is invented. */
test.describe.configure({ mode: "serial" });

const version = "rastrata-application-v1";
const BOOK = "9c1d2e3f-4a5b-4c6d-8e7f-a1b2c3d4e5f6";

const setup = {
  name: "Rules Co",
  currency: "USD",
  fiscalYear: new Date().getUTCFullYear(),
  periodModel: "monthly",
  accounts: [
    { code: "1010", name: "Checking", role: "asset" },
    { code: "2100", name: "Credit card", role: "liability" },
    { code: "3100", name: "Owner contributions", role: "equity" },
    { code: "4000", name: "Sales", role: "income" },
    { code: "6100", name: "Software", role: "expense" },
    { code: "6200", name: "Hosting", role: "expense" },
    { code: "6300", name: "Meals", role: "expense" },
    { code: "6900", name: "Personal", role: "expense" },
  ],
};

/** A date this many days ago, but never before January 1 of this year: the book's one fiscal year. */
const daysAgo = (days: number): string => {
  const now = new Date();
  const wanted = new Date(now.getTime() - days * 86_400_000);
  const first = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  return (wanted < first ? first : wanted).toISOString().slice(0, 10);
};

async function api(request: APIRequestContext, name: string, input: unknown, operationId?: string) {
  const response = await request.post(`/v1/${name}`, {
    data: { version, bookId: "local-book", input, ...(operationId ? { operationId } : {}) },
  });
  const body = await response.json();
  expect(body.ok, `${name}: ${JSON.stringify(body.error)}`).toBe(true);
  return body.data;
}

/** Post a journal between the bank and one other account, from a source event whose description is
 * the bank's memo. `amount` is signed: negative is money out. */
async function post(
  request: APIRequestContext,
  date: string,
  memo: string,
  amount: string,
  category: string,
) {
  const out = amount.startsWith("-");
  const absolute = amount.replace("-", "");
  const id = `rules-${memo.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}-${date}`;
  const draft = await api(
    request,
    "drafts.create",
    {
      data: {
        date,
        reference: id,
        narration: memo,
        source: { id, description: memo },
        lines: [
          { accountId: out ? category : "1010", debit: absolute, credit: "" },
          { accountId: out ? "1010" : category, debit: "", credit: absolute },
        ],
      },
    },
    crypto.randomUUID(),
  );
  const plan = await api(
    request,
    "journal.prepare",
    { draftId: draft.id, expectedVersion: 1 },
    crypto.randomUUID(),
  );
  await api(request, "operations.commit", { planId: plan.planId, planHash: plan.planHash });
}

/** A Chase-shaped statement with a running balance that follows from its amounts, newest first. */
function chase(rows: readonly (readonly [string, string, string])[], opening = 500000n) {
  let balance = opening;
  const text = (value: bigint) =>
    `${value < 0n ? "-" : ""}${(value < 0n ? -value : value) / 100n}.${String((value < 0n ? -value : value) % 100n).padStart(2, "0")}`;
  const lines = rows.map(([date, amount, memo]) => {
    const cents = BigInt(amount.replace(".", ""));
    balance += cents;
    const [year, month, day] = date.split("-");
    // A memo may hold a comma ("GITHUB, INC."), so it is quoted as a CSV field.
    return `${cents < 0n ? "DEBIT" : "CREDIT"},${month}/${day}/${year},"${memo.replaceAll('"', '""')}",${amount},ACH_DEBIT,${text(balance)},,`;
  });
  return `Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\n${lines.reverse().join("\n")}\n`;
}

async function importStatement(request: APIRequestContext, csv: string) {
  const upload = await request.post("/v1/uploads", {
    headers: { "content-type": "text/csv", "x-upload-name": "statement.csv" },
    data: Buffer.from(csv),
  });
  const receipt = (await upload.json()).data;
  const preview = await api(request, "import.preview", {
    sha256: receipt.sha256,
    ledgerAccountId: "1010",
  });
  await api(
    request,
    "import.commit",
    {
      sha256: receipt.sha256,
      ledgerAccountId: "1010",
      ...(preview.detection.preset ? { presetId: preview.detection.preset.id } : {}),
    },
    crypto.randomUUID(),
  );
}

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

const inTheme = async (page: Page, theme: "light" | "dark") => {
  await page.evaluate((value) => {
    document.documentElement.dataset.theme = value;
  }, theme);
  // A scan must not sample colors in the middle of the theme change's short transition.
  await page.addStyleTag({
    content: "*,*::before,*::after{transition:none!important;animation:none!important}",
  });
};

const names = (page: Page) => page.locator("tbody tr th a").allTextContents();

test.beforeAll(async ({ request }) => {
  await api(request, "book.setup", setup, BOOK);
  // The book's history: what has been posted, and so what the rules and the classifier can learn
  // from. GitHub is booked to Software three times and once, wrongly, to Hosting.
  await post(request, daysAgo(60), "Owner contribution", "5000.00", "3100");
  await post(request, daysAgo(40), "GITHUB, INC. SAN FRANCISCO CA 1001", "-21.00", "6100");
  await post(request, daysAgo(30), "GITHUB, INC. SAN FRANCISCO CA 1002", "-21.00", "6100");
  await post(request, daysAgo(20), "GITHUB, INC. SAN FRANCISCO CA 1003", "-21.00", "6100");
  await post(request, daysAgo(18), "GITHUB COPILOT 77", "-4.00", "6200");
  await post(request, daysAgo(35), "AWS EMEA SARL LUXEMBOURG 5501", "-48.12", "6200");
  await post(request, daysAgo(14), "AWS EMEA SARL LUXEMBOURG 5502", "-51.03", "6200");
  await post(request, daysAgo(25), "BLUE BOTTLE COFFEE OAKLAND CA 701", "-6.50", "6300");
  await post(request, daysAgo(9), "BLUE BOTTLE COFFEE OAKLAND CA 702", "-7.25", "6300");
  // A statement from the bank waits in For review.
  await importStatement(
    request,
    chase([
      [daysAgo(5), "-21.00", "GITHUB, INC. SAN FRANCISCO CA 4829104"],
      [daysAgo(4), "-50.00", "AWS EMEA SARL LUXEMBOURG 5599"],
      [daysAgo(3), "1200.00", "STRIPE PAYOUT ST-8841"],
      [daysAgo(2), "-6.00", "BLUE BOTTLE COFFEE OAKLAND CA 703"],
      [daysAgo(1), "-15.49", "NETFLIX.COM LOS GATOS CA"],
    ]),
  );
});

test("with no rules the screen says so, measures what the rules would decide, and offers a new rule", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  // Transactions opens on For review, with the number waiting beside the place's name; Rules is a link in
  // the page's header, beside Import a statement.
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: /^Transactions/ })
    .click();
  await page.getByRole("main").getByRole("link", { name: "Rules", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Rules", level: 1 })).toBeFocused();
  await expect(page.getByText("No rules yet", { exact: true }).first()).toBeVisible();
  // 0 of the 14 transactions (5 in For review, 9 posted) are decided by a rule: one line under the title.
  await expect(page.getByText(/0 of 14 recent transactions are decided by a rule/)).toBeVisible();
  // The one action is in the page header, and the empty state offers it too.
  await expect(page.getByRole("link", { name: "New rule" }).first()).toBeVisible();
  // The classifier learned from the posted lines by itself when For review was first read: nobody
  // trained it, and the card says what it learned from, with no badge.
  await page.getByRole("button", { name: "Suggested accounts" }).click();
  await expect(page.getByText(/Learned from \d+ transactions? across \d+ accounts?/)).toBeVisible();
  await expect(page.getByText("Not ready", { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a rule is written, checked against the book before it is saved, and saved", async ({
  page,
}) => {
  await page.goto("/rules");
  await page.getByRole("link", { name: "New rule" }).first().click();
  await expect(page.getByRole("heading", { name: "New rule", level: 1 })).toBeFocused();
  // Nothing can be checked yet.
  await expect(
    page.getByText("Complete the highlighted parts to see which transactions it matches."),
  ).toBeVisible();

  // Saving an empty rule lists every problem, takes focus, and links to each control.
  await page.getByRole("button", { name: "Create rule" }).click();
  const summary = page.getByRole("region", { name: "Fix these before saving" });
  await expect(summary).toBeFocused();
  await expect(summary.getByRole("link", { name: "Give the rule a name" })).toBeVisible();
  await expect(summary.getByRole("link", { name: "Choose an account" })).toBeVisible();
  await summary.getByRole("link", { name: "Give the rule a name" }).click();
  await expect(page.getByLabel("Name", { exact: true })).toBeFocused();

  await page.getByLabel("Name", { exact: true }).fill("GitHub subscriptions");
  await page.getByLabel("Condition 1: Text to look for").fill("github");
  // The check runs once typing pauses: 4 posted transactions and 1 in For review say GitHub.
  await expect(
    page.getByText(
      "Matches 5 of the 14 transactions waiting for review and from the last 90 days.",
    ),
  ).toBeVisible();
  await expect(page.getByText("1 of the 5 transactions waiting for review.")).toBeVisible();
  await expect(page.getByText("4 of the 9 transactions posted in the last 90 days.")).toBeVisible();

  await pick(page, page.getByLabel("Account", { exact: true }), "6100 · Software");
  // Three of the four posted transactions were recorded to Software; one went to Hosting, and the check says so.
  await expect(
    page.getByText(
      "3 of the 4 matching posted transactions were recorded where this rule would record them.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText("1 was recorded somewhere else. Check the samples before saving."),
  ).toBeVisible();
  // Only the one transaction that went to Hosting is flagged, and it says where it went.
  await expect(page.getByText("Recorded elsewhere")).toHaveCount(1);
  await expect(page.locator(".rt-rules-sample-booked", { hasText: "Hosting" })).toBeVisible();
  await expect(page.getByText("Would suggest").first()).toBeVisible();

  // Both themes, and a phone's width, pass the scan and do not overflow.
  for (const theme of ["light", "dark"] as const) {
    await inTheme(page, theme);
    await scan(page, `/rules/new (${theme})`);
  }
  await inTheme(page, "light");

  await page.getByRole("button", { name: "Create rule" }).click();
  // The list says what was saved, and the address does not keep saying it on a reload.
  await expect(page.getByText("Saved “GitHub subscriptions”.")).toBeVisible();
  await expect(page).toHaveURL(/\/rules$/);
  await expect(page.getByRole("link", { name: "GitHub subscriptions" })).toBeVisible();
  // The row says when it applies and what it then suggests, in words, and who made it.
  const row = page.locator("tbody tr", { hasText: "GitHub subscriptions" });
  await expect(row.locator(".rt-rules-when")).toContainText("Description contains “github”");
  await expect(row.locator(".rt-rules-then")).toHaveText("Software");
  await expect(row).toContainText("You ·");
  // Measured over For review and the last 90 days: it matched 5 transactions and decided all 5.
  await expect(row.locator(".rt-rules-used")).toHaveText(/^5/);
  await expect(page.getByText(/5 of 14 recent transactions are decided by a rule/)).toBeVisible();
});

test("the specific rule goes above the general one from the keyboard, and the order is kept", async ({
  page,
  request,
}) => {
  // A general rule that would suggest for the same transactions, written after the specific one, and one for AWS.
  const general = await api(
    request,
    "rules.create",
    {
      rule: {
        name: "Cloud and software",
        conditions: [{ field: "description", operator: "contains", value: "git" }],
        action: { kind: "categorize", accountId: "6100" },
      },
    },
    crypto.randomUUID(),
  );
  await api(
    request,
    "rules.create",
    {
      rule: {
        name: "AWS",
        conditions: [{ field: "description", operator: "wholeWord", value: "aws" }],
        action: { kind: "categorize", accountId: "6200" },
      },
    },
    crypto.randomUUID(),
  );
  await page.goto("/rules");
  await expect(page.getByRole("link", { name: "AWS" })).toBeVisible();
  expect(await names(page)).toEqual(["GitHub subscriptions", "Cloud and software", "AWS"]);
  // The general rule matches the same 5 transactions, but the specific rule above it decides all of them.
  const generalRow = page.locator("tbody tr", { hasText: "Cloud and software" });
  const github = page.locator("tbody tr", { hasText: "GitHub subscriptions" });
  // Matched, decided and overridden are in each row's Performance disclosure.
  const counts = (row: Locator) =>
    row
      .locator(".rt-rules-performance dd")
      .evaluateAll((all) => all.slice(0, 3).map((cell) => cell.textContent?.match(/^\d+/)?.[0]));
  await expect.poll(() => counts(generalRow)).toEqual(["5", "0", "5"]);
  await expect.poll(() => counts(github)).toEqual(["5", "5", "0"]);
  await expect(page.getByText(/8 of 14 recent transactions are decided by a rule/)).toBeVisible();

  // Alt with the up arrow moves it above; the change is announced and kept on the service.
  await page.getByRole("button", { name: "Move Cloud and software up" }).focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect(page.getByText("Moved Cloud and software to position 1 of 3.")).toBeAttached();
  expect(await names(page)).toEqual(["Cloud and software", "GitHub subscriptions", "AWS"]);
  await expect(page.getByRole("button", { name: "Move Cloud and software up" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Move Cloud and software down" })).toBeFocused();
  // The counts are measured again for the new order: now the general rule decides.
  await expect.poll(() => counts(generalRow)).toEqual(["5", "5", "0"]);
  await expect.poll(() => counts(github)).toEqual(["5", "0", "5"]);
  await page.reload();
  await expect(page.getByRole("link", { name: "AWS" })).toBeVisible();
  expect(await names(page)).toEqual(["Cloud and software", "GitHub subscriptions", "AWS"]);

  // Put it back with the buttons. A reply that is lost is resumed, and the move is made once.
  await page.route("**/v1/rules.reorder", async (route) => {
    await route.fetch();
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "Move Cloud and software down" }).click();
  await expect(page.getByRole("button", { name: "Resume original request" })).toBeVisible();
  await page.unroute("**/v1/rules.reorder");
  await page.reload();
  await page.getByRole("button", { name: "Resume original request" }).click();
  await expect(page.getByRole("button", { name: "Resume original request" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "AWS" })).toBeVisible();
  expect(await names(page)).toEqual(["GitHub subscriptions", "Cloud and software", "AWS"]);
  const detail = await api(request, "rules.get", { ruleId: general.id });
  expect(detail.rule.priority).toBe(2);
});

test("a rule is switched off and on in place, and survives a reload", async ({ page }) => {
  await page.goto("/rules");
  await expect(page.getByRole("link", { name: "AWS" })).toBeVisible();
  const switchOf = (name: string) => page.getByRole("switch", { name });
  const rowOf = (name: string) => page.locator("tbody tr", { hasText: name });
  await expect(switchOf("GitHub subscriptions")).toBeChecked();
  await switchOf("GitHub subscriptions").focus();
  await page.keyboard.press("Space");
  await expect(switchOf("GitHub subscriptions")).not.toBeChecked();
  await expect(rowOf("GitHub subscriptions").getByText("Off", { exact: true })).toBeVisible();
  // The rows stay where they are while the list is read again, so the switch just used keeps focus.
  await expect(switchOf("GitHub subscriptions")).toBeFocused();
  await page.reload();
  await expect(switchOf("GitHub subscriptions")).not.toBeChecked();
  await expect(rowOf("GitHub subscriptions").getByText("Off", { exact: true })).toBeVisible();
  // With a pointer too.
  await rowOf("GitHub subscriptions").locator(".rt-rules-switch-control").click();
  await expect(switchOf("GitHub subscriptions")).toBeChecked();
  await expect(rowOf("GitHub subscriptions").getByText("On", { exact: true })).toBeVisible();
});

test("a rule is opened, edited, tried on a transaction, and saved with its history kept", async ({
  page,
  request,
}) => {
  const revisionOf = async (name: string) =>
    (await api(request, "rules.list", {})).rules.find(
      (rule: { name: string }) => rule.name === name,
    ).revision as number;
  // It was switched off and on in the last test, so it is past its first revision.
  const before = await revisionOf("GitHub subscriptions");
  expect(before).toBeGreaterThan(1);
  await page.goto("/rules");
  await page.getByRole("link", { name: "GitHub subscriptions" }).click();
  await expect(page.getByRole("heading", { name: "Edit rule", level: 1 })).toBeFocused();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("GitHub subscriptions");
  await expect(page.getByLabel("Account", { exact: true })).toHaveAttribute("data-value", "6100");
  // History starts with its creation, by a person.
  await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
  await expect(page.getByText("Revision 1")).toBeVisible();
  await expect(page.getByText("Created.")).toBeVisible();

  // A description with a field; the check shows how it reads on the first transaction the rule applies to.
  await page.getByLabel("Description for the entry").fill("Software: ");
  await page.getByRole("button", { name: "Insert {merchant}" }).click();
  await expect(page.getByLabel("Description for the entry")).toHaveValue("Software: {merchant}");
  await expect(page.getByText("On the first matching transaction this reads:")).toBeVisible();
  await expect(page.getByText(/Software: Git[Hh]ub/).first()).toBeVisible();

  // Try a transaction without saving anything: one that matches and one that does not.
  await page.getByText("Try a transaction", { exact: true }).click();
  await page.getByLabel("Description", { exact: true }).last().fill("GITHUB MARKETPLACE 8812");
  await page.getByLabel("Amount", { exact: true }).last().fill("-12.40");
  await page.getByRole("button", { name: "Try it" }).click();
  await expect(page.getByText("The rule applies to this transaction.")).toBeVisible();
  await expect(page.getByText("description contains “github”").first()).toBeVisible();
  await expect(page.getByText("Software 12.40")).toBeVisible();
  await page.getByLabel("Description", { exact: true }).last().fill("NETFLIX.COM");
  await page.getByLabel("Description", { exact: true }).last().press("Enter");
  await expect(page.getByText("The rule does not match this transaction.")).toBeVisible();
  await expect(page.getByText("Conditions that did not hold")).toBeVisible();
  // Enter tried the transaction; it did not save the rule.
  expect(await revisionOf("GitHub subscriptions")).toBe(before);

  // A bad amount says so beside the box.
  await page.getByLabel("Amount", { exact: true }).last().fill("12");
  await page.getByRole("button", { name: "Try it" }).click();
  await expect(
    page.getByText("Enter a signed amount with two decimals, for example -12.40."),
  ).toBeVisible();

  // Saving keeps the history: revision 2, by a person, and what changed. A lost reply is resumed.
  await page.route("**/v1/rules.update", async (route) => {
    await route.fetch();
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "Save rule" }).click();
  await expect(page.getByRole("button", { name: "Resume original request" })).toBeVisible();
  await page.unroute("**/v1/rules.update");
  await page.reload();
  await page.getByRole("button", { name: "Resume original request" }).click();
  await expect(page.getByText("Saved “GitHub subscriptions”.")).toBeVisible();
  await page.getByRole("link", { name: "GitHub subscriptions" }).click();
  await expect(page.getByText(`Revision ${before + 1}`)).toBeVisible();
  await expect(page.getByText("Changed: what it suggests.")).toBeVisible();
  // The reply was lost and resumed: the change was made once.
  await expect(page.getByText(`Revision ${before + 2}`)).toHaveCount(0);
});

test("a rule changed elsewhere while it is being edited is not overwritten", async ({
  page,
  request,
}) => {
  await page.goto("/rules");
  await page.getByRole("link", { name: "AWS" }).click();
  await expect(page.getByRole("heading", { name: "Edit rule", level: 1 })).toBeVisible();
  const list = await api(request, "rules.list", {});
  const aws = list.rules.find((rule: { name: string }) => rule.name === "AWS");
  // Someone else (an agent, through the API) changes it first.
  await api(
    request,
    "rules.update",
    {
      ruleId: aws.id,
      expectedRevision: aws.revision,
      rule: {
        name: "AWS (renamed elsewhere)",
        enabled: aws.enabled,
        accountIds: aws.accountIds,
        match: aws.match,
        conditions: aws.conditions,
        groups: aws.groups,
        action: aws.action,
      },
      madeBy: { kind: "agent", name: "Claude" },
    },
    crypto.randomUUID(),
  );
  await page.getByLabel("Note").fill("My note");
  await page.getByRole("button", { name: "Save rule" }).click();
  await expect(page.getByText("This rule changed while you were editing")).toBeVisible();
  await expect(page.getByLabel("Note")).toHaveValue("My note");
  await page.getByRole("button", { name: "Load the newer revision" }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("AWS (renamed elsewhere)");
  // The history says an agent made the change, and who.
  await expect(page.getByText("Agent: Claude")).toBeVisible();
});

test("a rule is started from a transaction in For review, and For review then suggests by it", async ({
  page,
  request,
}) => {
  const found = await api(request, "inbox.list", { filter: { text: "NETFLIX" } });
  expect(found.items).toHaveLength(1);
  const item = found.items[0];
  await page.goto(`/rules/new?item=${encodeURIComponent(item.id)}`);
  await expect(page.getByRole("heading", { name: "New rule", level: 1 })).toBeFocused();
  await expect(page.getByText("Started from a transaction")).toBeVisible();
  await expect(page.getByText(/NETFLIX\.COM LOS GATOS CA/).first()).toBeVisible();
  // The suggestion dropped what changes from month to month and kept the merchant.
  await expect(page.getByLabel("Condition 1: Text to look for")).toHaveValue(/netflix/i);
  await page.getByLabel("Name", { exact: true }).fill("Netflix");
  await pick(page, page.getByLabel("Account", { exact: true }), "6900 · Personal");
  await page.getByRole("button", { name: "Create rule" }).click();
  await expect(page.getByText("Saved “Netflix”.")).toBeVisible();
  // For review's own suggestion for that transaction now comes from the rule.
  const rule = (await api(request, "rules.list", {})).rules.find(
    (candidate: { name: string }) => candidate.name === "Netflix",
  );
  await api(request, "inbox.refresh", {}, crypto.randomUUID());
  const detail = await api(request, "inbox.get", { itemId: item.id });
  expect(detail.proposals.map((proposal: { proposer: string }) => proposal.proposer)).toContain(
    `rule:${rule.id}`,
  );
  // A transaction that cannot be read starts a blank rule and says so.
  await page.goto("/rules/new?item=does-not-exist");
  await expect(page.getByText("That transaction could not be read")).toBeVisible();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("");
});

test("hostile text in a rule is only ever text", async ({ page }) => {
  await page.goto("/rules/new");
  const name = "<img src=x onerror=window.__pwned=1> ' OR 1=1 --";
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page
    .getByLabel("Condition 1: Text to look for")
    .fill("$(rm -rf /) {{amount}} <script>window.__pwned=2</script> .*");
  await pick(page, page.getByLabel("Account", { exact: true }), "6900 · Personal");
  await page.getByLabel("Description for the entry").fill("<b>{description}</b>");
  await page.getByRole("button", { name: "Create rule" }).click();
  await expect(page.getByRole("link", { name })).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
  ).toBeUndefined();
  await expect(page.locator("tbody tr img")).toHaveCount(0);
  // Open it again: the same text comes back as text, and the check treats it as words to look for.
  await page.getByRole("link", { name }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(name);
  await expect(page.getByLabel("Description for the entry")).toHaveValue("<b>{description}</b>");
  expect(
    await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
  ).toBeUndefined();
});

test("the local classifier learned by itself, is measured on this book's own history, and its thresholds changed", async ({
  page,
  request,
}) => {
  await page.goto("/rules");
  await page.getByRole("button", { name: "Suggested accounts" }).click();
  // It learned when For review was first read, and this history is short enough to learn from on
  // its own: there is nothing to press.
  await expect(page.getByText(/Learned from \d+ transactions? across \d+ accounts?/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Train now" })).toHaveCount(0);
  const { trainedAt, heldBack } = await api(request, "classifier.status", {});
  expect(heldBack).toBe(0);
  await expect(
    page.getByText(`Last trained ${shown.instant(trainedAt)}.`, { exact: true }),
  ).toBeVisible();
  // The figures are exact counts, replayed in date order on this book's own history.
  await expect(page.getByRole("heading", { name: "How well it does on your books" })).toBeVisible();
  await expect(
    page.getByText(/each of \d+ transactions? was suggested for by a classifier/),
  ).toBeVisible();
  await expect(page.getByText("Right when it suggests").first()).toBeVisible();
  await page.getByRole("button", { name: "If you only trusted the surest suggestions" }).click();
  await expect(page.getByRole("row", { name: /^99%/ })).toBeVisible();

  // Thresholds are a click away, under Advanced: out-of-range values are caught where they are
  // typed; a good change is saved.
  await page.getByRole("button", { name: "Advanced" }).click();
  await page.getByLabel("Agreement (percent)").fill("20");
  await page.getByRole("button", { name: "Save thresholds" }).click();
  await expect(page.getByText("Enter a whole number from 50 to 100.")).toBeVisible();
  await expect(page.getByLabel("Agreement (percent)")).toBeFocused();
  await page.getByLabel("Agreement (percent)").fill("80");
  await page.getByRole("button", { name: "Save thresholds" }).click();
  await expect(
    page.getByText("Thresholds saved. The figures were measured again with them."),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Suggested accounts" }).click();
  await page.getByRole("button", { name: "Advanced" }).click();
  await expect(page.getByLabel("Agreement (percent)")).toHaveValue("80");
  // Switched off, it says so.
  await page.getByText("Switched on", { exact: true }).click();
  await page.getByRole("button", { name: "Save thresholds" }).click();
  // The fold says so beside its name while it is shut.
  const fold = page.getByRole("button", { name: "Suggested accounts" });
  await fold.click();
  await expect(page.getByText("Switched off", { exact: true }).first()).toBeVisible();
  await fold.click();
  await page.getByText("Switched on", { exact: true }).click();
  await page.getByRole("button", { name: "Save thresholds" }).click();
  await expect(
    page.getByText("Thresholds saved. The figures were measured again with them."),
  ).toBeVisible();
  await expect(page.getByText("Switched off", { exact: true })).toHaveCount(0);
});

test("a rule is deleted after a confirmation that names what it does", async ({
  page,
  request,
}) => {
  await page.goto("/rules");
  await page.getByRole("link", { name: "Netflix" }).click();
  await page.getByRole("button", { name: "Delete rule" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Delete this rule?" });
  await expect(dialog).toBeVisible();
  // The safe choice has the first focus, and the alternative is named.
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expect(dialog.getByText("If you may want it again, switch it off instead.")).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Delete rule" }).click();
  await page.getByLabel("Why is it being retired?").fill("Cancelled the subscription");
  await dialog.getByRole("button", { name: "Delete rule" }).click();
  await expect(page).toHaveURL(/\/rules$/);
  await expect(page.getByRole("link", { name: "Netflix" })).toHaveCount(0);
  const gone = await api(request, "rules.list", { status: "deleted" });
  expect(gone.rules.map((rule: { name: string }) => rule.name)).toContain("Netflix");
  // It stays readable, with the reason, and cannot be edited.
  await page.goto(`/rules/${gone.rules[0].id}`);
  await expect(page.getByText("This rule has been deleted")).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete rule" })).toHaveCount(0);
  await expect(page.getByLabel("Name", { exact: true })).toBeDisabled();
  await expect(page.getByText("Deleted.")).toBeVisible();
});

test("every Rules page passes the accessibility scan in both themes and fits a phone", async ({
  page,
  request,
}) => {
  const list = await api(request, "rules.list", {});
  const first = list.rules[0];
  const pages = ["/rules", `/rules/${first.id}`, "/rules/new"];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const theme of ["light", "dark"] as const) {
    for (const route of pages) {
      await page.goto(route);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      if (route === "/rules")
        await expect(page.getByRole("link", { name: first.name })).toBeVisible();
      if (route.startsWith("/rules/") && route !== "/rules/new")
        await expect(page.getByText(/Matches \d+ of the \d+ transactions/)).toBeVisible();
      await inTheme(page, theme);
      await scan(page, `${route} (${theme})`);
    }
  }
  for (const route of pages) {
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(route);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect
        .poll(
          () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          {
            message: `${route} at ${width}px`,
          },
        )
        .toBe(true);
    }
  }
  expect(errors).toEqual([]);
});

/** Press Tab until the focused control has this id, at most `limit` times. A sensible order reaches
 * the next part of the form in a few presses; a form that needs dozens is not usable by keyboard. */
async function tabTo(page: Page, id: string, limit = 12) {
  for (let presses = 0; presses < limit; presses++) {
    if ((await page.evaluate(() => document.activeElement?.id)) === id) return presses;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Tab did not reach #${id} in ${limit} presses`);
}

test("a rule is written and saved from the keyboard alone, in an order that makes sense", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === "webkit",
    "Safari's default Tab order skips links and buttons (Option+Tab reaches them), and this test walks it with Tab.",
  );
  await page.goto("/rules/new");
  await expect(page.getByRole("heading", { name: "New rule", level: 1 })).toBeFocused();
  // From the heading, a few Tab presses reach the first field, then the conditions, the account and
  // the button. Nothing needs a pointer.
  expect(await tabTo(page, "rule-name", 4)).toBeLessThanOrEqual(3);
  await page.keyboard.type("Hosting by keyboard");
  await tabTo(page, "rule-conditions-0-field", 8);
  // A select is changed by typing: "Description" is already chosen. Move on to the text.
  await tabTo(page, "rule-conditions-0-value", 4);
  await page.keyboard.type("aws emea");
  await tabTo(page, "rule-action-accountId", 14);
  await page.keyboard.type("6200");
  // Choosing an account must not take the focus away: the check answers while the person is still
  // on the control, and the next Tab goes on from there.
  await page.waitForTimeout(800);
  await expect(page.getByLabel("Account", { exact: true })).toBeFocused();
  await expect(page.getByLabel("Account", { exact: true })).toHaveAttribute("data-value", "6200");
  // The live check has answered by the time the button is reached.
  await expect(page.getByText(/Matches \d+ of the \d+ transactions/)).toBeVisible();
  await tabTo(page, "rule-action-narration", 3);
  await page.keyboard.press("Tab");
  // The insert buttons, then the actions at the end of the form; Enter on Create rule saves.
  for (let presses = 0; presses < 30; presses++) {
    if ((await page.evaluate(() => document.activeElement?.textContent)) === "Create rule") break;
    await page.keyboard.press("Tab");
  }
  await expect(page.getByRole("button", { name: "Create rule" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Saved “Hosting by keyboard”.")).toBeVisible();
  // The rule list is reachable the same way: the new rule's move buttons are real buttons.
  await expect(page.getByRole("button", { name: "Move Hosting by keyboard up" })).toBeVisible();
});
