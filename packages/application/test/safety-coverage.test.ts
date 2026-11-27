import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ApplicationHttp } from "../src/http.ts";
import { LocalBookService } from "../src/local.ts";
import { restoreBackup } from "../src/local/restore.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS } from "../src/schema.ts";
import { batchOf, closeFixtures, ingestFixture } from "./support/ingest-fixture.ts";

afterEach(closeFixtures);

/** Every table of a database file with its row count and a digest of its content, read-only. */
function tablesOf(path: string): Record<string, { rows: number; digest: string }> {
  const db = new Database(path, { readonly: true });
  try {
    const names = (
      db
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    )
      .map((row) => row.name)
      .sort();
    return Object.fromEntries(
      names.map((name) => {
        const rows = db.query(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[];
        const lines = rows
          .map((row) =>
            JSON.stringify(
              Object.entries(row).map(([column, value]) => [
                column,
                value instanceof Uint8Array ? Buffer.from(value).toString("base64") : value,
              ]),
            ),
          )
          .sort();
        return [
          name,
          {
            rows: rows.length,
            digest: createHash("sha256").update(lines.join("\n")).digest("hex"),
          },
        ];
      }),
    );
  } finally {
    db.close();
  }
}

const callOn = async (service: LocalBookService, name: string, input: unknown = {}) => {
  const http = new ApplicationHttp(service, {
    bookId: service.bookId,
    permissions: BUSINESS_PERMISSIONS,
  });
  const response = await http.fetch(
    new Request(`http://127.0.0.1:4010/v1/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: APPLICATION_API_VERSION,
        bookId: service.bookId,
        input,
        operationId: crypto.randomUUID(),
      }),
    }),
  );
  return { status: response.status, body: await response.json() };
};

test("a backup holds every table in the book database, whichever lane made it, and restores each lane's data", async () => {
  const f = await ingestFixture();
  // Ingest: a batch of bank lines, with the raw file archived (app_blobs) and the items it made.
  f.port.submit(
    batchOf(f.port, [
      { date: "2026-01-02", amount: "-4.50", description: "COFFEE SHOP #1" },
      { date: "2026-01-05", amount: "1200.00", description: "ACH DEPOSIT ACME" },
    ]),
  );
  // Rules, reconciliation, chart tags and agent access: each lane keeps its records in the book.
  const rule = await f.call(
    "rules.create",
    {
      rule: {
        name: "Coffee",
        conditions: [{ field: "description", operator: "contains", value: "COFFEE" }],
        action: { kind: "categorize", accountId: "5100" },
      },
    },
    crypto.randomUUID(),
  );
  expect(rule.status, JSON.stringify(rule.body)).toBe(200);
  const reconciliation = await f.call(
    "reconcile.start",
    { accountId: "1000", statementDate: "2026-01-31", statementBalance: "0.00" },
    crypto.randomUUID(),
  );
  expect(reconciliation.status, JSON.stringify(reconciliation.body)).toBe(200);
  const tags = await f.call(
    "accounts.setTags",
    { accountId: "1000", effectiveOn: "2026-01-01", tags: { cashFlowClass: "cash" } },
    crypto.randomUUID(),
  );
  expect(tags.status, JSON.stringify(tags.body)).toBe(200);
  const token = await f.call(
    "tokens.create",
    { label: "Bookkeeping agent", permissions: ["read", "draft"] },
    crypto.randomUUID(),
  );
  expect(token.status, JSON.stringify(token.body)).toBe(200);
  // The cutover (shadow lane) records the day the books moved, and sets the Inbox sources' start.
  const cutover = await f.call(
    "cutover.set",
    { cutoverDate: "2026-01-01", accountIds: ["1000"] },
    crypto.randomUUID(),
  );
  expect(cutover.status, JSON.stringify(cutover.body)).toBe(200);
  // Stripe and statements create their tables when first used.
  expect((await f.call("stripe.status", {})).status).toBe(200);
  expect((await f.call("import.history", {})).status).toBe(200);
  // The safety lane's own state.
  await f.call(
    "backup.configure",
    {
      enabled: true,
      intervalHours: 12,
      onShutdown: true,
      verifyAfterBackup: true,
      keepDaily: 7,
      keepWeekly: 4,
      keepMonthly: 12,
      warnAfterHours: 48,
    },
    crypto.randomUUID(),
  );

  const live = tablesOf(f.path);
  // Every lane's tables are in the book database, so one snapshot of it is the whole product.
  for (const table of [
    "app_book",
    "app_drafts",
    "app_actions",
    "app_requests",
    "app_sources",
    "app_slice_migrations",
    "app_read_snapshots",
    "app_blobs",
    "app_ingest_items",
    "app_ingest_batches",
    "app_ingest_sources",
    "app_import_runs",
    "app_statement_profiles",
    "rules_rule",
    "rules_meta",
    "recon_sessions",
    "chart_tag_log",
    "stripe_settings",
    "stripe_runs",
    "shadow_cutover_log",
    "shadow_opening",
    "agent_tokens",
    "agent_activity",
    "safety_settings",
    "ledger_native_book",
    "ledger_native_outcomes",
    "ledger_native_facts",
  ])
    expect(Object.keys(live), `the book database should hold ${table}`).toContain(table);
  expect(live.app_ingest_items?.rows).toBe(2);
  expect(live.rules_rule?.rows).toBe(1);
  expect(live.agent_tokens?.rows).toBe(1);
  expect(live.shadow_cutover_log?.rows).toBe(1);
  expect(live.app_blobs?.rows).toBeGreaterThan(0);

  const host = f.service.host.safety;
  if (!host) throw new Error("no safety host");
  const made = await host.createBackup("manual", new Date());
  const backed = tablesOf(join(host.directories.backups, made.manifest.file.name));
  // The backup has exactly the tables the book has, and every table has exactly the rows it had.
  expect(Object.keys(backed)).toEqual(Object.keys(live));
  for (const [table, found] of Object.entries(live)) expect(backed[table], table).toEqual(found);
  // The manifest names the product-state version of every lane that had state in the book, so a
  // restore knows what wrote the file.
  expect(Object.keys(made.manifest.application.stores).sort()).toEqual([
    "agent",
    "changes",
    "chart",
    "core",
    "ingest",
    "reconcile",
    "rules",
    "safety",
    "shadow",
    "statements",
    "stripe",
  ]);

  // It verifies and drills clean with every lane's tables in it.
  const verified = await f.call("backup.verify", {}, crypto.randomUUID());
  expect(verified.body.data.verification.passed, JSON.stringify(verified.body)).toBe(true);
  const drilled = await f.call("backup.drill", {}, crypto.randomUUID());
  expect(drilled.body.data.drill.passed, JSON.stringify(drilled.body)).toBe(true);

  // Restored, each lane's data is where it was.
  const target = join(f.path, "..", "restored", "book.sqlite");
  const restored = await restoreBackup({
    backup: made.manifest.id,
    to: target,
    backupDirectory: host.directories.backups,
    quick: true,
  });
  expect(restored.warnings.join(" ")).toContain("1 agent token");
  const book = await LocalBookService.open(target, { safety: false });
  try {
    expect(
      (await callOn(book, "rules.list", {})).body.data.rules.map((r: { name: string }) => r.name),
    ).toEqual(["Coffee"]);
    expect((await callOn(book, "inbox.summary", {})).body.data.counts.total).toBe(2);
    expect((await callOn(book, "reconcile.status", {})).status).toBe(200);
    expect(
      (await callOn(book, "tokens.list", {})).body.data.tokens.map(
        (t: { label: string }) => t.label,
      ),
    ).toEqual(["Bookkeeping agent"]);
    const accounts = (await callOn(book, "accounts.list", {})).body.data.accounts as {
      id: string;
      tags?: { cashFlowClass?: string };
    }[];
    expect(accounts.find((account) => account.id === "1000")?.tags?.cashFlowClass).toBe("cash");
    expect((await callOn(book, "cutover.get", {})).body.data.cutover.cutoverDate).toBe(
      "2026-01-01",
    );
    expect(tablesOf(target).app_blobs).toEqual(live.app_blobs);
  } finally {
    book.close();
  }
}, 120_000);
