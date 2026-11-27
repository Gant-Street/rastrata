import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  allCopy,
  type CopyString,
  copyFolders,
  lineOf,
  looksLikeCopy,
  root,
  stringsIn,
  withoutKeywords,
} from "./support/copy";
import {
  type CodeFirst,
  codeFirstIsFine,
  type Exemption,
  exemptions,
  type Rule,
  rules,
} from "./vocabulary";

// The words of the application are one vocabulary (docs/reference/ux-rework-plan.md, "One vocabulary"),
// kept as data in `vocabulary.ts`. This test reads every string a person reads in `packages/ui/src` and
// `apps/web/src` and fails when one says a word the vocabulary has retired, the way the format guard
// fails a figure that formats itself. If it fails on your string, say the word in the "say" column of
// the rule it names. If the old word is right where you wrote it, add an `unless` pattern to the rule or
// an exemption with the reason.

const fileIsGone = (file: string): boolean => !existsSync(join(root, file));

/** The lanes a pending debt can name. */
const lanes = ["shell", "kit", "banking", "accounting", "home", "reports", "entries", "language"];

const inScope = (rule: Rule, file: string): boolean =>
  rule.in === undefined ||
  rule.in.some((where) =>
    typeof where !== "string"
      ? where.test(file)
      : where.endsWith("/")
        ? file.startsWith(where)
        : file === where,
  );

/** Whether a string breaks a rule. `file` is where it is written; left out, the rule is read as if it
 * applied there. */
const broken = (rule: Rule, text: string, file?: string): boolean =>
  (file === undefined || inScope(rule, file)) &&
  rule.banned.some((pattern) => pattern.test(text)) &&
  !(rule.unless ?? []).some((pattern) => pattern.test(text));

const covers = (exemption: Exemption, rule: Rule, copy: CopyString): boolean =>
  exemption.rule === rule.id &&
  (exemption.file.endsWith("/")
    ? copy.file.startsWith(exemption.file)
    : exemption.file === copy.file) &&
  (exemption.text === undefined || copy.text.includes(exemption.text));

describe("the scanner reads what a person reads", () => {
  test("it finds the strings of JavaScript, a template's expressions as {}", () => {
    const js = [
      'const a = "Inbox";',
      "const b = 'it\\'s here';",
      `const c = \`\${count} lines in \${name}\`;`,
      `const d = fn(\`\${x ? \`nested \${y}\` : "no"}\`);`,
      'const e = /["\']January["\']/.test(text) ? "yes" : "no";',
      "const f = a / b / c;",
      '// "a comment, not a string"',
      '/* "nor this" */ const g = "after";',
      'const h = "\\u2212 and \\n";',
    ].join("\n");
    expect(stringsIn(js)).toEqual([
      "Inbox",
      "it's here",
      "{} lines in {}",
      "nested {}",
      "no",
      "{}",
      "yes",
      "no",
      "after",
      "− and \n",
    ]);
  });

  test("it keeps what is prose and leaves what is code", () => {
    for (const copy of [
      "Inbox",
      "Open the Inbox",
      "{} lines are waiting.",
      "Nothing to review",
      "Journal / Posted entry",
    ])
      expect(looksLikeCopy(copy), copy).toBe(true);
    for (const code of [
      "rt-inbox-table",
      "rt-table rt-inbox-table",
      "/inbox",
      "inbox.list",
      "date_desc",
      ".rt-inbox-categorize input[role='combobox']",
      "click",
      "[data-row-control], .rt-inbox-why-trigger",
      "ul > li a[href]",
      "{}",
      "",
      "12",
      "inbox",
    ])
      expect(looksLikeCopy(code), code).toBe(false);
  });

  test("a search keyword is what people type, so it keeps the old names on purpose", () => {
    const source = 'nav: { label: "Agents", keywords: ["agent access", "tokens"], order: 50 }';
    expect(stringsIn(withoutKeywords(source))).toEqual(["Agents"]);
    expect(stringsIn(source)).toContain("agent access");
  });

  test("the application's words are found in the files that hold them", () => {
    const copy = allCopy();
    expect(copy.length).toBeGreaterThan(2000);
    const files = new Set(copy.map((entry) => entry.file));
    for (const file of [
      "packages/ui/src/ingest/words.ts",
      "packages/ui/src/reports/messages.ts",
      "packages/ui/src/messages.ts",
      "apps/web/src/application-client.ts",
    ])
      expect(files.has(file), file).toBe(true);
    expect(
      copy.some(
        (entry) => entry.file === "packages/ui/src/ingest/words.ts" && /review/i.test(entry.text),
      ),
    ).toBe(true);
  });
});

describe("the vocabulary can fail: each rule recognises what it forbids and lets what is right through", () => {
  const samples: Record<string, { bad: string[]; good: string[] }> = {
    inbox: {
      bad: ["Inbox", "Open the Inbox", "waiting in your inbox"],
      good: ["For review", "Inboxes"],
    },
    "screen-in-sentence": {
      bad: [
        "Connect Stripe and each payout arrives in For review, ready for you to approve.",
        "The transaction is back in For review.",
        "For review could not be read, so Stripe's figures are not compared.",
        "Tag it on the Accounts screen",
        "Choose an account for Sales, under Options.",
        "Manage it from Settings, Billing.",
        "A mistake is corrected by reversing it from Transactions and entering the balances again.",
        "The field is cleared as soon as you press Connect.",
        "When you have read the list, press “I have looked at these”.",
      ],
      good: [
        "For review",
        "Open For review",
        "Back to Rules",
        "Go to Home",
        "The transaction is waiting for review again.",
        "Import your Stripe payouts automatically.",
        "Tag it in your chart of accounts",
        "Press a figure to see the transactions behind it.",
        "Transactions and accounts could not be read.",
      ],
    },
    lines: {
      bad: ["{} lines are waiting", "Show lines", "No lines match", "The line", "Bank lines"],
      good: [
        "One row for each line of an entry.",
        "Where each form line comes from",
        "Debit and credit lines",
        "Accounting lines can still be edited.",
        "The entry has no lines yet.",
        "Nothing is posted from the command line",
        "Use plain text without line breaks",
        "Tax line",
        "Line ",
        "Line {} ·",
        "{} line {} · {}",
        "Add a line",
        "Schedule C line 27b",
        "Online banking",
        "Headline",
      ],
    },
    journal: {
      bad: [
        "Journal",
        "Back to the Journal",
        "Nothing in your journal changes.",
        "View source journal",
      ],
      good: ["Journal entry", "New journal entry", "Journal entries"],
    },
    narration: { bad: ["Narration", "Narration:"], good: ["Description"] },
    "accounts-label": { bad: ["Accounts"], good: ["Chart of accounts", "Accounts to reconcile"] },
    "periods-label": {
      bad: ["Periods"],
      good: ["Close the books", "Each period is closed on its own."],
    },
    periods: {
      bad: ["Fiscal periods", "Cutover checklist"],
      good: ["Close the books", "Each period is closed on its own."],
    },
    cutover: { bad: ["Cutover date", "the cutover"], good: ["Start date"] },
    opening: { bad: ["Opening"], good: ["Opening balances"] },
    "source-id": {
      bad: ["Source ID (optional)", "Source event", "Advanced: duplicate protection"],
      good: ["Where this entry came from"],
    },
    "machine-detail": {
      bad: ["Population", "Book revision {}", "Source fingerprint: ", "Posted at revision "],
      good: ["Details"],
    },
    "chart-advanced": {
      bad: ["Lifecycle", "Cash-flow class", "Role key", "Tags in force on "],
      good: ["Advanced", "Cash flow"],
    },
    "gap-log": { bad: ["Gap log", "Add to the gap log"], good: ["Things to check"] },
    "agent-access": { bad: ["Agent access", "Checking agent access…"], good: ["Agents"] },
    "bank-feed": { bad: ["Bank feed", "Disconnect the bank feed?"], good: ["Bank connection"] },
    "book-to": {
      bad: ["Book to {}", "Book to accounts"],
      good: ["Set up a book to see its reports."],
    },
    "rule-percent": { bad: ["Rule 100%"], good: ["The rule matched"] },
    "iso-date": {
      bad: ["Year-month-day (2026-03-25)", "Closed 2026-01-19"],
      good: ["Mar 25, 2026"],
    },
    hash: { bad: [`Hash ${"a".repeat(64)}`], good: ["A short id 0123abcd"] },
    development: {
      bad: [
        "Local development application · Authentication is not configured",
        "The MCP entry needs the MCP server running (bun run dev:mcp).",
        "start the service with RASTRATA_OWNER_KEY_FILE set",
      ],
      good: ["Signed in as ann@example.com", "rastrata agent init --agent claude --mcp=false"],
    },
    "us-spelling": {
      bad: ["Categorise it", "The colour", "A cheque", "itemised", "was cancelled"],
      good: ["Categorize it", "The color", "A check", "itemized", "was canceled"],
    },
  };

  test("every rule has samples, and the samples behave", () => {
    expect(Object.keys(samples).sort()).toEqual(rules.map((rule) => rule.id).sort());
    for (const rule of rules) {
      for (const text of samples[rule.id]?.bad ?? [])
        expect(broken(rule, text), `${rule.id} should flag: ${text}`).toBe(true);
      for (const text of samples[rule.id]?.good ?? [])
        expect(broken(rule, text), `${rule.id} should pass: ${text}`).toBe(false);
    }
  });

  test("a rule that names screens applies to the files that name them, and to no other", () => {
    const rule = rules.find((entry) => entry.id === "accounts-label") as Rule;
    for (const file of [
      "apps/web/src/router.tsx",
      "apps/web/src/routes/core.ts",
      "apps/web/src/routes/ingest/index.ts",
    ])
      expect(inScope(rule, file), file).toBe(true);
    for (const file of [
      "apps/web/src/routes/ingest/page.tsx",
      "apps/web/src/routes/reports/index.tsx",
      "packages/ui/src/chart/messages.ts",
    ])
      expect(inScope(rule, file), file).toBe(false);
  });

  test("a rule says what to say instead", () => {
    for (const rule of rules) {
      expect(rule.say.length, rule.id).toBeGreaterThan(2);
      expect(rule.was.length, rule.id).toBeGreaterThan(2);
      expect(rule.banned.length, rule.id).toBeGreaterThan(0);
    }
    expect(new Set(rules.map((rule) => rule.id)).size).toBe(rules.length);
  });
});

describe("the words of the application", () => {
  const copy = allCopy();

  test("no string a person reads says a word the vocabulary has retired", () => {
    const problems: string[] = [];
    for (const entry of copy)
      for (const rule of rules) {
        if (!broken(rule, entry.text, entry.file)) continue;
        if (exemptions.some((exemption) => covers(exemption, rule, entry))) continue;
        const line = lineOf(entry.file, entry.text);
        problems.push(
          `${entry.file}${line ? `:${line}` : ""}: [${rule.id}] ${JSON.stringify(entry.text.length > 140 ? `${entry.text.slice(0, 140)}…` : entry.text)}\n    say ${rule.say}, not ${rule.was}`,
        );
      }
    expect(
      problems,
      `\n${problems.length} string${problems.length === 1 ? "" : "s"} say a retired word (docs/reference/ux-rework-plan.md, "One vocabulary"; the rules are in unit/vocabulary.ts):\n${problems.join("\n")}\n`,
    ).toEqual([]);
  });

  test("the exemptions that are debts are named, lane by lane", () => {
    const debts = [...exemptions, ...codeFirstIsFine].filter((entry) => entry.pending);
    const perLane = new Map<string, number>();
    for (const debt of debts)
      perLane.set(debt.pending as string, (perLane.get(debt.pending as string) ?? 0) + 1);
    console.info(
      `glossary: ${debts.length} pending ${debts.length === 1 ? "debt" : "debts"}${
        debts.length
          ? ` (${[...perLane].map(([lane, count]) => `${lane} ${count}`).join(", ")})`
          : ""
      }`,
    );
    // A debt says whose it is.
    for (const debt of debts) expect(lanes, debt.file).toContain(debt.pending as string);
  });

  test("every exemption still exempts something, so the list can only get shorter", () => {
    const unmatched = exemptions.filter(
      (exemption) =>
        !copy.some((entry) =>
          rules.some(
            (rule) => broken(rule, entry.text, entry.file) && covers(exemption, rule, entry),
          ),
        ),
    );
    // A debt for a file that is gone is paid: it does not fail a landing that only met the deletion on the
    // way (the lane that deleted the file landed first), and it is listed so it gets deleted.
    const paid = unmatched.filter((exemption) => exemption.pending && fileIsGone(exemption.file));
    if (paid.length > 0)
      console.info(
        `glossary: ${paid.length} pending debt${paid.length === 1 ? "" : "s"} name a file that is gone; delete: ${paid.map((exemption) => `${exemption.rule} in ${exemption.file}`).join(", ")}`,
      );
    const stale = unmatched.filter((exemption) => !paid.includes(exemption));
    expect(
      stale.map((exemption) => `${exemption.rule} in ${exemption.file}: ${exemption.reason}`),
      "\nThese exemptions no longer match any string; delete them:\n",
    ).toEqual([]);
    for (const exemption of exemptions) {
      expect(
        rules.some((rule) => rule.id === exemption.rule),
        `an exemption names a rule that does not exist: ${exemption.rule}`,
      ).toBe(true);
      expect(exemption.reason.length, `${exemption.rule} in ${exemption.file}`).toBeGreaterThan(10);
    }
  });
});

// An account's code stays, muted, in the chart, the pickers and the reports; a list and a sentence say the
// account's name. So `${account.code} · ${account.name}` (and `${account.code} ${account.name}`) is written
// only where a picker or a report needs the code, and each of those places is listed in `codeFirstIsFine`.
const codeFirst = /\$\{[A-Za-z_.()?!]*\bcode\}\s*(?:·\s*)?\$\{[A-Za-z_.()?!]*\bname\}/;

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("an account is its name in a list", () => {
  test("the code is written before the name only where a picker or a report needs it", () => {
    const problems: string[] = [];
    const used = new Set<CodeFirst>();
    for (const folder of copyFolders)
      for (const path of new Bun.Glob("**/*.{ts,tsx}").scanSync({
        cwd: join(root, folder),
        absolute: true,
      })) {
        const file = relative(root, path);
        stripComments(readFileSync(path, "utf8"))
          .split("\n")
          .forEach((line, index) => {
            if (!codeFirst.test(line)) return;
            const fine = codeFirstIsFine.find(
              (entry) =>
                entry.file === file && (entry.line === undefined || line.includes(entry.line)),
            );
            if (fine) used.add(fine);
            else problems.push(`${file}:${index + 1}: ${line.trim()}`);
          });
      }
    expect(
      problems,
      `\nSay the account's name; the code stays, muted, in the chart, the pickers and the reports (list the place in codeFirstIsFine, with the reason, if it is one of them):\n${problems.join("\n")}\n`,
    ).toEqual([]);
    expect(
      codeFirstIsFine
        .filter((entry) => !used.has(entry) && !(entry.pending && fileIsGone(entry.file)))
        .map((entry) => `${entry.file}${entry.line ? ` (${entry.line})` : ""}: ${entry.why}`),
      "\nThese places no longer write a code before a name; delete them from codeFirstIsFine:\n",
    ).toEqual([]);
    for (const entry of codeFirstIsFine) {
      expect(entry.why.length, entry.file).toBeGreaterThan(10);
      if (entry.pending) expect(lanes, entry.file).toContain(entry.pending);
    }
  });

  test("the guard can fail: it recognises the way a list writes a code first", () => {
    expect(codeFirst.test(`label: \`\${account.code} · \${account.name}\``)).toBe(true);
    expect(codeFirst.test(`\`\${row().code} \${row().name}\``)).toBe(true);
    expect(codeFirst.test(`\`\${account.name} \${account.code}\``)).toBe(false);
    expect(codeFirst.test(`\`\${account.code}\``)).toBe(false);
  });
});
