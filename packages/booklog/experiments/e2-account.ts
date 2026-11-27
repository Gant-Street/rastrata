/** Reads the accounting the acceptance backend writes (ACCEPTANCE_ACCOUNT_FILE) and says what the log
 * was used for: requests by operation, the entries they made and what each held, and the reads that
 * had to write something.
 *
 *   ACCEPTANCE_ACCOUNT_FILE=/tmp/account.jsonl ACCEPTANCE_BACKEND=... bun test .../first-month.test.ts
 *   bun experiments/e2-account.ts /tmp/account.jsonl [--world 0] [--json out.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { operationCatalog } from "@rastrata/application/schema";
import type { EntryInfo } from "../src/runtime.ts";
import { parseArgs, printTable, quantile } from "./lib.ts";

interface Account {
  world: number;
  requests: Record<string, { reads: number; writes: number; ms: number }>;
  entries: EntryInfo[];
  restarts: { kind: "warm" | "cold"; closeMs: number; openMs: number }[];
  openMs: number;
  verifyMs: number;
  runtime: {
    work: number;
    peek: number;
    encode: number;
    append: number;
    commit: number;
    emptyWrites: number;
  };
  resets: number;
  readFlushes: number;
  commits: number;
  tables: Record<string, number>;
}

const WRITES: ReadonlySet<string> = new Set(
  operationCatalog.filter((operation) => operation.writes).map((operation) => operation.name),
);

/** What a read had to write, in words, from the tables whose rows it changed. */
export function readCause(entry: EntryInfo): string {
  const changed = Object.entries(entry.tables)
    .filter(([, n]) => n.insert + n.update + n.delete + n.replace > 0)
    .map(([name]) => name);
  const parts: string[] = [];
  if (entry.ddl > 0) parts.push("slice tables made on first use");
  if (changed.some((name) => name.startsWith("agent_")))
    parts.push("audit row for an agent token's request");
  if (changed.some((name) => name === "app_ingest_items" || name === "app_ingest_proposals"))
    parts.push("the Inbox's suggestions stored");
  return parts.length > 0 ? parts.join(" + ") : "other";
}

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

function main(): void {
  const args = parseArgs();
  const file = process.argv[2];
  if (!file || file.startsWith("--"))
    throw new Error("Usage: e2-account.ts <account.jsonl> [--world n]");
  const accounts = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Account)
    .sort((a, b) => a.world - b.world);
  const focus = args.number("world", 0);
  const result: Record<string, unknown> = {};

  console.log("Worlds (each is one book the story or a known-issue test made)");
  printTable(
    [
      "world",
      "requests (read/write)",
      "entries",
      "from writes",
      "from reads",
      "stored bytes",
      "reads' share of entries",
    ],
    accounts.map((account) => {
      const reads = Object.values(account.requests).reduce((sum, row) => sum + row.reads, 0);
      const writes = Object.values(account.requests).reduce((sum, row) => sum + row.writes, 0);
      const fromReads = account.entries.filter((entry) => entry.cause === "read").length;
      return [
        account.world,
        `${reads + writes} (${reads}/${writes})`,
        account.entries.length,
        account.entries.length - fromReads,
        fromReads,
        account.entries.reduce((sum, entry) => sum + entry.bytes, 0),
        `${((100 * fromReads) / Math.max(1, account.entries.length)).toFixed(1)}%`,
      ];
    }),
  );

  const account = accounts.find((item) => item.world === focus);
  if (!account) return;
  console.log(`\nWorld ${focus}: operations (requests, and the entries they made)`);
  const labels = new Set([
    ...Object.keys(account.requests),
    ...account.entries.map((entry) => entry.label ?? "(open)"),
  ]);
  const byLabel = [...labels].map((label) => {
    const requests = account.requests[label] ?? { reads: 0, writes: 0, ms: 0 };
    const mine = account.entries.filter((entry) => (entry.label ?? "(open)") === label);
    const written = mine.filter((entry) => entry.cause === "write");
    const readCaused = mine.filter((entry) => entry.cause === "read");
    return {
      label,
      kind: WRITES.has(label) ? "write" : label === "uploads" ? "write" : "read",
      requests: requests.reads + requests.writes,
      fromWrites: written.length,
      fromReads: readCaused.length,
      bytes: mine.reduce((sum, entry) => sum + entry.bytes, 0),
      mean: mean(mine.map((entry) => entry.bytes)),
      max: Math.max(0, ...mine.map((entry) => entry.bytes)),
      ms: requests.ms,
    };
  });
  byLabel.sort((a, b) => b.bytes - a.bytes || b.requests - a.requests);
  printTable(
    [
      "operation",
      "kind",
      "requests",
      "entries (write)",
      "entries (read)",
      "bytes",
      "mean/entry",
      "max",
      "ms/request",
    ],
    byLabel.map((row) => [
      row.label,
      row.kind,
      row.requests,
      row.fromWrites,
      row.fromReads,
      row.bytes,
      Math.round(row.mean),
      row.max,
      row.requests ? (row.ms / row.requests).toFixed(1) : "",
    ]),
  );
  result.byOperation = byLabel;

  const reads = account.entries.filter((entry) => entry.cause === "read");
  console.log(
    `\nWorld ${focus}: the ${reads.length} reads that had to be logged before they were answered`,
  );
  printTable(
    ["#", "operation", "bytes", "wrote", "why"],
    reads.map((entry, index) => [
      index + 1,
      entry.label ?? "",
      entry.bytes,
      [
        ...Object.entries(entry.tables)
          .filter(([, n]) => n.insert + n.update + n.delete + n.replace > 0)
          .map(
            ([name, n]) =>
              `${name} ${[n.insert && `+${n.insert}`, n.update && `~${n.update}`, n.delete && `-${n.delete}`, n.replace && `=${n.replace}`].filter(Boolean).join("")}`,
          ),
        entry.ddl
          ? `${entry.ddl} schema statements (${Object.keys(entry.tables).length} tables)`
          : "",
      ]
        .filter(Boolean)
        .join("; ")
        .slice(0, 150),
      readCause(entry),
    ]),
  );
  const causes = new Map<string, { n: number; bytes: number }>();
  for (const entry of reads) {
    const cause = readCause(entry);
    const row = causes.get(cause) ?? { n: 0, bytes: 0 };
    row.n += 1;
    row.bytes += entry.bytes;
    causes.set(cause, row);
  }
  console.log("\nBy cause");
  printTable(
    ["cause", "reads logged", "bytes"],
    [...causes.entries()].map(([cause, row]) => [cause, row.n, row.bytes]),
  );
  result.readCauses = Object.fromEntries(causes);

  console.log(
    `\nWorld ${focus}: where the changes went, by table (rows changed, share of the change sets' size)`,
  );
  const tableRows = new Map<string, { writeRows: number; readRows: number; size: number }>();
  let totalSize = 0;
  for (const entry of account.entries) {
    for (const [name, counts] of Object.entries(entry.tables)) {
      const row = tableRows.get(name) ?? { writeRows: 0, readRows: 0, size: 0 };
      const rows = counts.insert + counts.update + counts.delete + counts.replace;
      if (entry.cause === "read") row.readRows += rows;
      else row.writeRows += rows;
      tableRows.set(name, row);
    }
    for (const [name, size] of Object.entries(entry.sizeByTable)) {
      const row = tableRows.get(name) ?? { writeRows: 0, readRows: 0, size: 0 };
      row.size += size;
      tableRows.set(name, row);
      totalSize += size;
    }
  }
  const tables = [...tableRows.entries()].sort((a, b) => b[1].size - a[1].size);
  printTable(
    ["table", "rows changed by writes", "rows changed by reads", "share of size", "rows now"],
    tables
      .filter(([, row]) => row.writeRows + row.readRows > 0 || row.size > 0)
      .map(([name, row]) => [
        name,
        row.writeRows,
        row.readRows,
        `${((100 * row.size) / Math.max(1, totalSize)).toFixed(1)}%`,
        account.tables[name] ?? "",
      ]),
  );
  result.byTable = Object.fromEntries(tableRows);

  const writeEntries = account.entries.filter((entry) => entry.cause === "write");
  const sizes = (list: EntryInfo[]) => list.map((entry) => entry.bytes).sort((a, b) => a - b);
  console.log(`\nWorld ${focus}: entry sizes (stored bytes)`);
  printTable(
    ["from", "entries", "total", "mean", "p50", "p95", "max"],
    [
      ["writes", writeEntries],
      ["reads", reads],
      ["all", account.entries],
    ].map(([label, list]) => {
      const sorted = sizes(list as EntryInfo[]);
      return [
        label as string,
        sorted.length,
        sorted.reduce((sum, value) => sum + value, 0),
        Math.round(mean(sorted)),
        Math.round(quantile(sorted, 0.5)),
        Math.round(quantile(sorted, 0.95)),
        sorted.at(-1) ?? 0,
      ];
    }),
  );

  // The operations that only prepare something are durable writes: the application retains the plan so
  // that a commit can find it after a failover. Their share, for pricing.
  const prepares = writeEntries.filter((entry) => /prepare/i.test(entry.label ?? ""));
  const prepareBytes = prepares.reduce((sum, entry) => sum + entry.bytes, 0);
  const writeBytes = writeEntries.reduce((sum, entry) => sum + entry.bytes, 0);
  console.log(`\nWorld ${focus}: the *.prepare* operations (durable plans)`);
  printTable(
    ["operation", "entries", "bytes", "mean"],
    [...new Set(prepares.map((entry) => entry.label))].sort().map((label) => {
      const mine = prepares.filter((entry) => entry.label === label);
      const bytes = mine.reduce((sum, entry) => sum + entry.bytes, 0);
      return [label ?? "", mine.length, bytes, Math.round(bytes / Math.max(1, mine.length))];
    }),
  );
  console.log(
    `${prepares.length} of ${writeEntries.length} write entries (${((100 * prepares.length) / Math.max(1, writeEntries.length)).toFixed(1)}%) and ${prepareBytes} of ${writeBytes} write bytes (${((100 * prepareBytes) / Math.max(1, writeBytes)).toFixed(1)}%)`,
  );
  result.prepare = {
    entries: prepares.length,
    bytes: prepareBytes,
    writeEntries: writeEntries.length,
    writeBytes,
  };

  const timed = writeEntries.filter((entry) => entry.ms !== undefined);
  if (timed.length > 0) {
    console.log(
      `\nWorld ${focus}: where a write's time went, per entry (ms; a tail with no latency)`,
    );
    const phases = ["work", "peek", "encode", "append", "commit"] as const;
    const rows = [
      ["all write entries", timed],
      ["entries under 5 KB", timed.filter((entry) => entry.bytes < 5000)],
      ["entries of 5 KB or more", timed.filter((entry) => entry.bytes >= 5000)],
    ] as const;
    printTable(
      [
        "entries",
        "n",
        ...phases.flatMap((phase) => [`${phase} p50`, `${phase} p95`]),
        "capture p50 (peek+encode+commit)",
        "capture p95",
      ],
      rows.map(([label, list]) => {
        const capture = list
          .map((entry) => entry.ms.peek + entry.ms.encode + entry.ms.commit)
          .sort((a, b) => a - b);
        return [
          label,
          list.length,
          ...phases.flatMap((phase) => {
            const sorted = list.map((entry) => entry.ms[phase]).sort((a, b) => a - b);
            return [quantile(sorted, 0.5).toFixed(2), quantile(sorted, 0.95).toFixed(2)];
          }),
          quantile(capture, 0.5).toFixed(2),
          quantile(capture, 0.95).toFixed(2),
        ];
      }),
    );
  }

  const json = args.string("json", "");
  if (json)
    writeFileSync(
      json,
      `${JSON.stringify({ file, worlds: accounts.length, ...result }, null, 2)}\n`,
    );
}

main();
