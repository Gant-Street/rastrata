import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

// Every screen shows money, dates, counts and sizes through `src/format.ts`, so one figure reads the
// same way everywhere. This test reads the source of the components and the web application and fails
// when a file formats its own: its own grouping, its own date or month names, its own clock reading.
// If it fails on your file, import the function you need from the formatter (`@rastrata/ui` in the web
// application, `../format` in a component folder) instead of writing another.

const root = join(import.meta.dir, "..", "..", "..");
const formatter = join(root, "packages/ui/src/format.ts");
const sourceFolders = ["packages/ui/src", "apps/web/src"];

const forbidden: readonly { pattern: RegExp; why: string }[] = [
  {
    pattern: /\.toFixed\(/,
    why: "rounds through a number; use formatMoney, formatBytes or formatPercent",
  },
  {
    pattern: /\.toLocale(Date|Time)?String\(/,
    why: "formats in the viewer's locale; use formatCount, formatDate or formatInstant",
  },
  {
    pattern: /Intl\.(NumberFormat|DateTimeFormat|RelativeTimeFormat)/,
    why: "a format of its own; the formatter owns Intl",
  },
  { pattern: /\\d\{3\}\)\+/, why: "groups digits by hand; use formatMoney or formatCount" },
  {
    pattern: /\.get(UTC)?(FullYear|Month|Date|Hours|Minutes)\(/,
    why: "builds a date by hand; use localToday, formatDate or formatInstant",
  },
  {
    pattern: /\.slice\(0, (10|16)\)|\.slice\(11, 16\)/,
    why: "cuts a timestamp by hand; use formatDate or formatInstant",
  },
  {
    pattern: /\.toISOString\(/,
    why: "builds a date by hand; use localToday, formatDate or formatInstant",
  },
  {
    pattern: /["'](January|Jan|Sunday|Sun)["']/,
    why: "a table of month or weekday names; use monthName, formatMonth, formatDate or formatWeekdayDate",
  },
  { pattern: /−/, why: "writes the minus sign by hand; formatMoney writes it" },
];

// A money field set in a page as it came from the service ("1500.00") rather than through Money or
// formatMoney. Only a child expression is checked: an attribute such as value={...} is a form field.
const rawMoney =
  /(?<![=\w])\{\s*(?!words\.|t\(\)\.|m\(\)\.)[A-Za-z_][A-Za-z0-9_.()?!]*\.(amount|balance|debit|credit|debitTotal|creditTotal|runningBalance|difference|netIncome|assets|equity|revenue|expenses|openingBalance|closingBalance|statementBalance|clearedBalance|selectedTotal|totalDebit|totalCredit|netChange)(\(\))?(?:\s*(?:\?\?|\|\|)\s*(?:"[^"]*"|'[^']*'|[\w.]+))?\s*\}/;

// A timestamp field set in a page as it came from the service ("2026-10-04T17:49:36.838Z") rather than
// through formatInstant, formatDate or formatAge. Child expressions only, as above.
const rawInstant =
  /(?<![=\w])\{\s*(?!words\.|t\(\)\.|m\(\)\.)[A-Za-z_][A-Za-z0-9_.()?!]*\.(recordedAt|createdAt|updatedAt|completedAt|verifiedAt|readAt|lastRunAt|lastUsedAt|expiresAt|startedAt|finishedAt|ranAt|syncedAt|postedAt|closedAt|openedAt|voidedAt|importedAt|isoAt)(\(\))?(?:\s*(?:\?\?|\|\|)\s*(?:"[^"]*"|'[^']*'|[\w.]+))?\s*\}/;

// A date field set in a page as it came from the service ("2026-03-20") rather than through DateValue,
// formatDate or formatDateRange: the app writes "Mar 20, 2026". The names are the ones the contracts
// give a calendar day. Child expressions and template interpolations only, as above: a field in an
// attribute such as value={...} or min={...} is a form field, which holds the stored form.
const rawDate =
  /(?<![=\w])\{\s*(?!words\.|t\(\)\.|m\(\)\.)[A-Za-z_][A-Za-z0-9_.()?!]*\.(date|startsOn|endsOn|firstDate|lastDate|asOf|effectiveOn|statementDate|firstOn|lastOn|w9On|through|postedOn|closedOn|openedOn|completedOn|entryDate|cutoverDate|balanceOn|startOn|expiresOn|dueOn|oldestUnclearedDate|lastMatchedOn|isoAt|lastReconciledDate|arrivalOn|oldestOn|tagsAsOf|after|on|(?:range|period|span|window|data|worksheet)\.(?:from|to))(\(\))?(?:\s*(?:\?\?|\|\|)\s*(?:"[^"]*"|'[^']*'|[\w.]+))?\s*\}/;
const rawDateInTemplate =
  /\$\{\s*[A-Za-z_][A-Za-z0-9_.()?!]*\.(date|startsOn|endsOn|firstDate|lastDate|asOf|effectiveOn|statementDate|firstOn|lastOn|w9On|through|postedOn|closedOn|openedOn|completedOn|entryDate|cutoverDate|balanceOn|startOn|expiresOn|dueOn|oldestUnclearedDate|lastMatchedOn|isoAt|lastReconciledDate|arrivalOn|oldestOn|tagsAsOf|after|on|(?:range|period|span|window|data|worksheet)\.(?:from|to))(\(\))?(?:\s*(?:\?\?|\|\|)\s*(?:"[^"]*"|'[^']*'|[\w.]+))?\s*\}/;

// A bare name that is a calendar day, in a sentence (`${endsOn}`): no object carries it.
const rawBareDate =
  /\$\{\s*(?:endsOn|startsOn|oldestToReviewOn|asOf|effectiveOn|cutoverDate|began)\s*\}/;

function sources(): string[] {
  const found: string[] = [];
  for (const folder of sourceFolders)
    for (const path of new Bun.Glob("**/*.{ts,tsx}").scanSync({
      cwd: join(root, folder),
      absolute: true,
    }))
      if (path !== formatter) found.push(path);
  return found.sort();
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("no screen formats money, dates, counts or sizes in a way of its own", () => {
  const problems: string[] = [];
  for (const path of sources()) {
    const lines = stripComments(readFileSync(path, "utf8")).split("\n");
    lines.forEach((line, index) => {
      for (const { pattern, why } of forbidden)
        if (pattern.test(line)) problems.push(`${relative(root, path)}:${index + 1}: ${why}`);
    });
  }
  expect(problems, `\n${problems.join("\n")}\n`).toEqual([]);
});

test("no page prints a money field as it came from the service", () => {
  const problems: string[] = [];
  for (const path of sources().filter((file) => file.endsWith(".tsx"))) {
    const lines = stripComments(readFileSync(path, "utf8")).split("\n");
    lines.forEach((line, index) => {
      if (rawMoney.test(line))
        problems.push(`${relative(root, path)}:${index + 1}: ${line.trim()}`);
    });
  }
  expect(
    problems,
    `\nUse <Money value={...} /> or formatMoney(...):\n${problems.join("\n")}\n`,
  ).toEqual([]);
});

test("no page prints a timestamp field as it came from the service", () => {
  const problems: string[] = [];
  for (const path of sources().filter((file) => file.endsWith(".tsx"))) {
    const lines = stripComments(readFileSync(path, "utf8")).split("\n");
    lines.forEach((line, index) => {
      if (rawInstant.test(line))
        problems.push(`${relative(root, path)}:${index + 1}: ${line.trim()}`);
    });
  }
  expect(
    problems,
    `\nUse formatInstant(...), formatDate(...) or formatAge(...):\n${problems.join("\n")}\n`,
  ).toEqual([]);
});

// A date field that is not shown to a person as a date, with the reason: a key that tells one list row
// from another, and the text a person typed, which is echoed back as they typed it.
const rawDateIsFine: readonly { file: string; line: string; why: string }[] = [
  {
    file: "apps/web/src/routes/rules/draft.ts",
    line: "key: sample.itemId ??",
    why: "a list key",
  },
  {
    file: "apps/web/src/routes/reconcile/page.tsx",
    line: "is not a calendar date.",
    why: "echoes what the person typed in the date field",
  },
  {
    file: "packages/ui/src/reports/url-state.ts",
    line: "in this link is not a real date",
    why: "echoes the text in the link, which is not a date",
  },
  {
    file: "packages/ui/src/reports/monthly-csv.ts",
    line: "filename:",
    why: "a file's name: an export keeps ISO dates",
  },
];

test("no page prints a date field as it came from the service", () => {
  const problems: string[] = [];
  for (const path of sources()) {
    const lines = stripComments(readFileSync(path, "utf8")).split("\n");
    lines.forEach((line, index) => {
      if (
        (rawDate.test(line) || rawDateInTemplate.test(line) || rawBareDate.test(line)) &&
        !rawDateIsFine.some(
          (fine) => relative(root, path) === fine.file && line.includes(fine.line),
        )
      )
        problems.push(`${relative(root, path)}:${index + 1}: ${line.trim()}`);
    });
  }
  expect(
    problems,
    `\nUse <DateValue value={...} />, formatDate(...) or formatDateRange(...):\n${problems.join("\n")}\n`,
  ).toEqual([]);
});

test("the guard can fail: it recognises each pattern it forbids", () => {
  const samples: Record<string, string> = {
    toFixed: "const text = (bytes / 1024).toFixed(1);",
    toLocaleString: "count.toLocaleString('en-US')",
    Intl: "new Intl.NumberFormat('en-US')",
    grouping: "text.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',')",
    date: "const year = now.getFullYear();",
    iso: "now.toISOString().slice(0, 10)",
    slice: "const day = instant.slice(0, 10);",
    month: "const MONTHS = ['January', 'February']",
    shortMonth: "const MONTHS = ['Jan', 'Feb']",
    weekday: "const DAYS = ['Sunday', 'Monday']",
    minus: "const text = `−1.00`;",
  };
  const hits = Object.entries(samples).filter(([, line]) =>
    forbidden.some(({ pattern }) => pattern.test(line)),
  );
  expect(hits.map(([name]) => name)).toEqual(Object.keys(samples));
  expect(rawMoney.test("<td>{line.debit}</td>")).toBe(true);
  expect(rawMoney.test("<td>{row.original.amount}</td>")).toBe(true);
  expect(rawMoney.test("<input value={line.debit} />")).toBe(false);
  expect(rawMoney.test("<td><Money value={line.debit} /></td>")).toBe(false);
  expect(rawInstant.test("<p>Recorded {current().recordedAt}</p>")).toBe(true);
  expect(rawInstant.test("<span>{latest().createdAt}</span>")).toBe(true);
  expect(rawInstant.test("<time datetime={event.isoAt}>{formatInstant(event.isoAt)}</time>")).toBe(
    false,
  );
  expect(rawInstant.test("<p>Recorded {formatInstant(current().recordedAt)}</p>")).toBe(false);
  expect(rawDate.test("<td>{line.date}</td>")).toBe(true);
  expect(rawDate.test("<bdi>{props.entry.date}</bdi>")).toBe(true);
  expect(rawDate.test("{period.startsOn} – {period.endsOn}")).toBe(true);
  expect(rawDate.test("{props.range.from} {words.to} {props.range.to}")).toBe(true);
  expect(rawDate.test("<input value={line.date} />")).toBe(false);
  expect(rawDate.test("<td><DateValue value={line.date} /></td>")).toBe(false);
  expect(rawDate.test("<td>{formatDate(line.date)}</td>")).toBe(false);
  // a fallback does not hide a raw date, and a formatter around the field is still a formatter
  expect(rawDate.test("<td>{source.startOn ?? words.notSet}</td>")).toBe(true);
  expect(rawDate.test('<td>{source.after ?? "—"}</td>')).toBe(true);
  expect(rawDate.test('<td>{formatDate(source.startOn ?? "")}</td>')).toBe(false);
  expect(rawInstant.test("<dd>{formatInstant(last.finishedAt ?? last.startedAt)}</dd>")).toBe(
    false,
  );
  expect(rawMoney.test('{formatMoney(stripe().difference ?? "0.00")}')).toBe(false);
  expect(rawDate.test("<td>{row.on}</td>")).toBe(true);
  expect(rawDate.test("{data().tagsAsOf}")).toBe(true);
  expect(rawDateInTemplate.test(`\`Closed \${account.closedOn}\``)).toBe(true);
  expect(rawDateInTemplate.test(`\`Closed \${formatDate(account.closedOn)}\``)).toBe(false);
  expect(rawBareDate.test(`\`before \${endsOn} that\``)).toBe(true);
  expect(rawBareDate.test(`\`before \${formatDate(endsOn)} that\``)).toBe(false);
});
