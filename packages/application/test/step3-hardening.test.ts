import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import type { ApplicationAccess } from "../src/agent/principal.ts";
import { ApplicationHttp } from "../src/http.ts";
import { LocalBookService } from "../src/local.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS } from "../src/schema.ts";
import { parseStatement } from "../src/statements/parse.ts";
import {
  batchOf,
  closeFixtures,
  type Fixture,
  ingestFixture,
  type Json,
  type LineInit,
} from "./support/ingest-fixture.ts";

async function ingestAct(f: Fixture, name: string, input: unknown): Promise<Json> {
  const reply = await f.call(name, input, uuid());
  expect(reply.body.ok, `${name}: ${JSON.stringify(reply.body)}`).toBe(true);
  return reply.body.data as Json;
}

function importLines(f: Fixture, lines: readonly LineInit[]): string[] {
  const batch = batchOf(f.port, lines, { ledgerAccountId: "1000" });
  const report = f.port.submit(batch);
  return report.dispositions.map((d) => d.itemId as string);
}
import { cleanupSafetyFixtures, safetyFixture } from "./support/safety.ts";
import { act as taxAct, cleanUpTax, postBankLines, taxFixture } from "./tax-support.ts";

const dirs: string[] = [];
afterEach(() => {
  closeFixtures();
  cleanupSafetyFixtures();
  cleanUpTax();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const uuid = () => crypto.randomUUID();

function zipBytes(files: readonly { name: string; text: string }[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
  const u32 = (v: number) => [...u16(v & 0xffff), ...u16((v >>> 16) & 0xffff)];
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = encoder.encode(file.text);
    const sum = crc32(data);
    const local = new Uint8Array([
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(sum),
      ...u32(data.length),
      ...u32(data.length),
      ...u16(name.length),
      ...u16(0),
      ...name,
    ]);
    central.push(
      new Uint8Array([
        ...u32(0x02014b50),
        ...u16(20),
        ...u16(20),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(sum),
        ...u32(data.length),
        ...u32(data.length),
        ...u16(name.length),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(0),
        ...u32(offset),
        ...name,
      ]),
    );
    parts.push(local, data);
    offset += local.length + data.length;
  }
  const directory = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array([
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(files.length),
    ...u16(files.length),
    ...u32(directory),
    ...u32(offset),
    ...u16(0),
  ]);
  const whole = new Uint8Array(offset + directory + end.length);
  let at = 0;
  for (const part of [...parts, ...central, end]) {
    whole.set(part, at);
    at += part.length;
  }
  return whole;
}

function minimalXlsx(rows: readonly (readonly string[])[]): Uint8Array {
  const xmlRows = rows
    .map((cells, r) => {
      const rowNum = r + 1;
      const xmlCells = cells
        .map((cell, c) => {
          const col = String.fromCharCode(65 + c);
          const escaped = cell
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;");
          return `<c r="${col}${rowNum}" t="inlineStr"><is><t>${escaped}</t></is></c>`;
        })
        .join("");
      return `<row r="${rowNum}">${xmlCells}</row>`;
    })
    .join("");
  return zipBytes([
    {
      name: "xl/workbook.xml",
      text: '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      text: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    },
    {
      name: "xl/worksheets/sheet1.xml",
      text: `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${xmlRows}</sheetData></worksheet>`,
    },
  ]);
}

async function closePeriod(
  call: (name: string, input: unknown, id?: string) => Promise<{ status: number; body: Json }>,
  periodId: string,
  reason = "month end",
) {
  const prep = await call("periods.prepare", { periodId, operation: "close", reason }, uuid());
  expect(prep.status, JSON.stringify(prep.body)).toBe(200);
  const committed = await call("operations.commit", {
    planId: prep.body.data.planId,
    planHash: prep.body.data.planHash,
  });
  expect(committed.status, JSON.stringify(committed.body)).toBe(200);
}

async function reopenPeriod(
  call: (name: string, input: unknown, id?: string) => Promise<{ status: number; body: Json }>,
  periodId: string,
  reason = "adjustment",
) {
  const prep = await call("periods.prepare", { periodId, operation: "reopen", reason }, uuid());
  expect(prep.status, JSON.stringify(prep.body)).toBe(200);
  const committed = await call("operations.commit", {
    planId: prep.body.data.planId,
    planHash: prep.body.data.planHash,
  });
  expect(committed.status, JSON.stringify(committed.body)).toBe(200);
}

describe("pod authorization, capabilities, agent read-only scopes and book.usage", () => {
  test("book.usage is service-only and accurately counts statements, transactions and exports", async () => {
    const root = mkdtempSync(join(tmpdir(), "rastrata-usage-"));
    dirs.push(root);
    const sf = await safetyFixture({
      directory: root,
      open: { safety: false, exports: { directory: join(root, "exports") } },
    });
    const http = new ApplicationHttp(sf.service, {
      bookId: sf.service.bookId,
      permissions: BUSINESS_PERMISSIONS,
    });
    const control = http.serviceAccess("control");
    const call = async (name: string, input: unknown, as?: ApplicationAccess, id = uuid()) => {
      const response = await http.fetch(
        new Request(`http://127.0.0.1:4010/v1/${name}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            version: APPLICATION_API_VERSION,
            bookId: "local-book",
            input,
            operationId: id,
          }),
        }),
        as,
      );
      return { status: response.status, body: (await response.json()) as Json };
    };
    await call(
      "members.add",
      { userId: "user_0000000001", email: "owner@example.com", role: "owner" },
      control,
    );
    const memberOwner = http.memberAccess("user_0000000001") as ApplicationAccess;

    const denied = await call("book.usage", {}, memberOwner);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("service_only");

    const before = await call("book.usage", {}, control);
    expect(before.status).toBe(200);
    expect(before.body.data).toEqual({
      statementsImported: 0,
      transactionsImported: 0,
      exportsCreated: 0,
    });

    const expId = uuid();
    for (let i = 0; i < 200; i += 1) {
      const res = await call("export.create", {}, memberOwner, expId);
      if (res.body.data.state !== "running") break;
      await Bun.sleep(25);
    }
    const after = await call("book.usage", {}, control);
    expect(after.status).toBe(200);
    expect(after.body.data.exportsCreated).toBe(1);
  });

  test("capabilities.get respects read-only operations and agentAccess intersects readOnly.held with key scopes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rastrata-caps-"));
    dirs.push(dir);
    const service = await LocalBookService.open(join(dir, "book.sqlite"));
    try {
      const http = new ApplicationHttp(service, {
        bookId: service.bookId,
        permissions: BUSINESS_PERMISSIONS,
      });
      const control = http.serviceAccess("control");
      const send = async (name: string, input: unknown, as?: ApplicationAccess) => {
        const res = await http.fetch(
          new Request(`http://127.0.0.1:4010/v1/${name}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              version: APPLICATION_API_VERSION,
              bookId: "local-book",
              input,
              operationId: uuid(),
            }),
          }),
          as,
        );
        return { status: res.status, body: (await res.json()) as Json };
      };
      await send("book.setup", {
        name: "Caps Co",
        currency: "USD",
        fiscalYear: 2026,
        periodModel: "monthly",
        accounts: [
          { code: "1000", name: "Cash", role: "asset" },
          { code: "3000", name: "Capital", role: "equity" },
        ],
      });
      await send(
        "members.add",
        { userId: "user_0000000001", email: "owner@example.com", role: "owner" },
        control,
      );
      await send("book.access", { readOnly: true }, control);

      const owner = http.memberAccess("user_0000000001") as ApplicationAccess;
      const caps = await send("capabilities.get", {}, owner);
      expect(caps.status).toBe(200);
      const names = (caps.body.data.operations as { name: string }[]).map((o) => o.name);
      expect(names).toContain("export.create");
      expect(names).toContain("accounts.list");
      expect(names).not.toContain("book.update");
      expect(names).not.toContain("rules.create");

      // A read-only agent key never held `draft`, so attempting a draft write returns permission_denied (not workspace_read_only).
      const readOnlyKey = http.agentAccess("user_0000000001", {
        keyId: "key_readonly_0001",
        scopes: ["read"],
        name: "Reader",
        expiresAt: "2027-01-01T00:00:00.000Z",
      }) as ApplicationAccess;
      const denied = await send("rules.create", {}, readOnlyKey);
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe("permission_denied");

      // A write-capable agent key DOES get workspace_read_only.
      const writerKey = http.agentAccess("user_0000000001", {
        keyId: "key_writer_0001",
        scopes: ["read", "draft"],
        name: "Bookkeeper",
        expiresAt: "2027-01-01T00:00:00.000Z",
      }) as ApplicationAccess;
      const locked = await send("rules.create", {}, writerKey);
      expect(locked.status).toBe(403);
      expect(locked.body.error.code).toBe("workspace_read_only");
    } finally {
      service.close();
    }
  });
});

describe("period lock enforcement across reconcile, undo, match and account tags", () => {
  test("reconcile.start, setStatement, complete and void reject dates in a locked period", async () => {
    const f = await ingestFixture();
    await f.call(
      "journal.post",
      {
        data: {
          date: "2026-01-15",
          reference: "INV-1",
          narration: "Initial deposit",
          lines: [
            { accountId: "1000", debit: "1000.00", credit: "" },
            { accountId: "3000", debit: "", credit: "1000.00" },
          ],
        },
      },
      uuid(),
    );

    const periods = (await f.call("periods.list", {})).body.data.periods as {
      id: string;
      startsOn: string;
    }[];
    const jan = periods.find((p) => p.startsOn === "2026-01-01") as { id: string };
    const feb = periods.find((p) => p.startsOn === "2026-02-01") as { id: string };

    // Start a Jan reconciliation while Jan is open, then close Jan and confirm complete fails.
    const started = await f.call(
      "reconcile.start",
      { accountId: "1000", statementDate: "2026-01-31", statementBalance: "1000.00" },
      uuid(),
    );
    expect(started.status).toBe(200);
    const rec = started.body.data;
    const postingId = rec.lines[0].postingId as string;
    const cleared = await f.call(
      "reconcile.setCleared",
      { id: rec.id, expectedVersion: rec.version, select: [postingId] },
      uuid(),
    );
    expect(cleared.status).toBe(200);

    await closePeriod((n, i, id) => f.call(n, i, id), jan.id);

    const completeBlocked = await f.call(
      "reconcile.complete",
      { id: rec.id, expectedVersion: cleared.body.data.version },
      uuid(),
    );
    expect(completeBlocked.status).toBe(409);
    expect(completeBlocked.body.error.code).toBe("fiscal_period_admission");

    // Discard draft, reopen Jan, complete it, close Jan, then confirm void & new start are blocked.
    await f.call(
      "reconcile.discard",
      { id: rec.id, expectedVersion: cleared.body.data.version },
      uuid(),
    );
    const startBlocked = await f.call(
      "reconcile.start",
      { accountId: "1000", statementDate: "2026-01-31", statementBalance: "1000.00" },
      uuid(),
    );
    expect(startBlocked.status).toBe(409);
    expect(startBlocked.body.error.code).toBe("fiscal_period_admission");

    await reopenPeriod((n, i, id) => f.call(n, i, id), jan.id);
    const rec2 = (
      await f.call(
        "reconcile.start",
        { accountId: "1000", statementDate: "2026-01-31", statementBalance: "1000.00" },
        uuid(),
      )
    ).body.data;
    const cl2 = (
      await f.call(
        "reconcile.setCleared",
        { id: rec2.id, expectedVersion: rec2.version, select: [rec2.lines[0].postingId] },
        uuid(),
      )
    ).body.data;
    const done = await f.call(
      "reconcile.complete",
      { id: rec2.id, expectedVersion: cl2.version },
      uuid(),
    );
    expect(done.status).toBe(200);

    // Close Jan and Feb, then reopen Jan so Feb is locked-but-superseded.
    await closePeriod((n, i, id) => f.call(n, i, id), jan.id);
    const voidBlocked = await f.call("reconcile.void", { id: rec2.id, reason: "mistake" }, uuid());
    expect(voidBlocked.status).toBe(409);
    expect(voidBlocked.body.error.code).toBe("fiscal_period_admission");

    await closePeriod((n, i, id) => f.call(n, i, id), feb.id);
    await reopenPeriod((n, i, id) => f.call(n, i, id), jan.id);
    // Feb's close is now superseded, yet Feb is STILL LOCKED: account tags effective in Feb must warn about the closed period!
    const tagWarned = await f.call(
      "accounts.setTags",
      { accountId: "1000", effectiveOn: "2026-02-10", tags: { cashFlowClass: "cash" } },
      uuid(),
    );
    expect(tagWarned.status).toBe(200);
    expect(tagWarned.body.data.warnings).toHaveLength(1);
    expect(tagWarned.body.data.warnings[0]).toContain("closed period");
    expect(tagWarned.body.data.warnings[0]).toContain("2026-02");
  });

  test("unlinking a matched hand-entry in a locked period fails with fiscal_period_admission", async () => {
    const f = await ingestFixture();
    await f.call(
      "journal.post",
      {
        data: {
          date: "2026-01-10",
          reference: "COFFEE",
          narration: "Coffee shop",
          lines: [
            { accountId: "5100", debit: "12.50", credit: "" },
            { accountId: "1000", debit: "", credit: "12.50" },
          ],
        },
      },
      uuid(),
    );
    const [itemId] = importLines(f, [
      { date: "2026-01-10", amount: "-12.50", description: "Coffee shop" },
    ]) as [string];
    const matched = await ingestAct(f, "inbox.accept", { itemIds: [itemId] });
    expect(matched.applied).toBe(1);

    const periods = (await f.call("periods.list", {})).body.data.periods as {
      id: string;
      startsOn: string;
    }[];
    const jan = periods.find((p) => p.startsOn === "2026-01-01") as { id: string };
    await closePeriod((n, i, id) => f.call(n, i, id), jan.id);

    const undone = await ingestAct(f, "inbox.undo", {
      itemIds: [itemId],
      reason: "test locked unlink",
    });
    expect(undone.failed).toBe(1);
    expect(undone.results[0].code).toBe("fiscal_period_admission");
  });
});

describe("inbox.post dryRun and .xlsx statement parsing", () => {
  test("inbox.post dryRun validates and computes balanced accountDeltas without committing", async () => {
    const f = await ingestFixture();
    const [janId, febId] = importLines(f, [
      { date: "2026-01-05", amount: "-25.00", description: "JANUARY COFFEE" },
      { date: "2026-02-05", amount: "-40.00", description: "FEBRUARY SUPPLIES" },
    ]) as [string, string];
    await ingestAct(f, "inbox.categorize", { itemIds: [janId, febId], accountId: "5100" });

    const periods = (await f.call("periods.list", {})).body.data.periods as {
      id: string;
      startsOn: string;
    }[];
    const jan = periods.find((p) => p.startsOn === "2026-01-01") as { id: string };
    await closePeriod((n, i, id) => f.call(n, i, id), jan.id);

    const dry = await ingestAct(f, "inbox.post", {
      itemIds: [janId, febId],
      dryRun: true,
    });
    expect(dry.dryRun).toBe(true);
    expect(dry.applied).toBe(1);
    expect(dry.failed).toBe(1);
    expect(dry.results.find((r: Json) => r.itemId === janId).code).toBe("fiscal_period_admission");
    expect(dry.accountDeltas).toEqual([
      {
        accountId: "1000",
        code: "1000",
        name: "Checking",
        debit: "0.00",
        credit: "40.00",
        net: "-40.00",
      },
      {
        accountId: "5100",
        code: "5100",
        name: "Meals",
        debit: "40.00",
        credit: "0.00",
        net: "40.00",
      },
    ]);
    // Zero journals committed and item remains drafted!
    expect((await f.call("journal.list", { status: "Posted" })).body.data.count).toBe(0);
    expect((await f.call("inbox.get", { itemId: febId })).body.data.item.status).toBe("drafted");

    // Real post now commits cleanly.
    const real = await ingestAct(f, "inbox.post", { itemIds: [febId] });
    expect(real.applied).toBe(1);
    expect((await f.call("journal.list", { status: "Posted" })).body.data.count).toBe(1);
  });

  test("parseStatement reads .xlsx workbooks cleanly and rejects non-xlsx ZIP archives", () => {
    const xlsx = minimalXlsx([
      ["Date", "Description", "Amount"],
      ["2026-02-01", "ACME CLOUD", "-99.50"],
      ["2026-02-05", "CLIENT INVOICE", "1500.00"],
    ]);
    const parsed = parseStatement({
      bytes: xlsx,
      defaultCurrency: "USD",
      accountKey: "csv:1010",
    });
    expect(parsed.format).toBe("csv");
    expect(parsed.diagnostics.counts.errors).toBe(0);
    expect(parsed.lines).toHaveLength(2);
    expect(parsed.lines[0]?.line).toMatchObject({
      postedOn: "2026-02-01",
      description: "ACME CLOUD",
      amount: "-99.50",
    });
    expect(parsed.lines[1]?.line).toMatchObject({
      postedOn: "2026-02-05",
      description: "CLIENT INVOICE",
      amount: "1500.00",
    });

    const randomZip = zipBytes([{ name: "hello.txt", text: "not an excel sheet" }]);
    const bad = parseStatement({
      bytes: randomZip,
      defaultCurrency: "USD",
      accountKey: "csv:1010",
    });
    expect(bad.lines).toHaveLength(0);
    expect(bad.diagnostics.count("unsupported_file")).toBe(1);
  });
});

describe("entity legal profile, 2026 $2,000 1099 threshold, vendor seam fields and unified CPA packet", () => {
  test("saves normalized legal entity profile, tracks 2026 $2,000 1099 boundary + vendor fields, and builds deterministic CPA packet", async () => {
    const f = await taxFixture({ today: "2027-02-01" });
    await f.setupFromTemplate({ templateId: "sole-proprietor", basis: "cash", taxYear: 2026 });

    const updated = await taxAct(f, "book.update", {
      entity: {
        legalName: "Northwind Holdings LLC",
        ein: "123456789",
        entityType: "single_member_llc",
        formationState: "de",
        address: {
          line1: "100 Main St",
          city: "Austin",
          state: "TX",
          postalCode: "78701",
          country: "us",
        },
        contactEmail: "Founder@Northwind.example",
      },
    });
    expect(updated.changed).toEqual(["entity"]);
    expect(updated.settings.entity).toEqual({
      legalName: "Northwind Holdings LLC",
      ein: "12-3456789",
      entityType: "single_member_llc",
      formationState: "DE",
      address: {
        line1: "100 Main St",
        city: "Austin",
        state: "TX",
        postalCode: "78701",
        country: "US",
      },
      contactEmail: "founder@northwind.example",
    });

    await f.post(
      "2026-01-05",
      [
        ["1000", "50000.00", ""],
        ["3000", "", "50000.00"],
      ],
      "Owner capital",
    );
    await postBankLines(f, "6030", [
      {
        date: "2026-03-01",
        amount: "-1999.99",
        description: "ACH BELOW THRESHOLD",
        counterparty: "Under Contractor",
        providerId: "p-under",
      },
      {
        date: "2026-04-01",
        amount: "-2000.00",
        description: "ACH AT THRESHOLD",
        counterparty: "Over Contractor",
        providerId: "p-over",
      },
    ]);
    await taxAct(f, "taxVendors.setAccounts", { add: ["6030"] });
    await taxAct(f, "taxVendors.save", {
      name: "Under Contractor",
      payeeKeys: ["under contractor"],
      reporting: "yes",
      w9: "received",
      paidBy: "bank",
    });
    const overSaved = await taxAct(f, "taxVendors.save", {
      name: "Over Contractor",
      payeeKeys: ["over contractor"],
      reporting: "yes",
      w9: "received",
      paidBy: "bank",
      legalName: "Over Contractor Consulting LLC",
      address: { line1: "200 Oak Ave", city: "Denver", state: "CO", postalCode: "80202" },
      email: "billing@overcontractor.example",
      tinStatus: "on_file",
    });
    expect(overSaved.vendor).toMatchObject({
      legalName: "Over Contractor Consulting LLC",
      email: "billing@overcontractor.example",
      tinStatus: "on_file",
    });

    const list = await taxAct(f, "taxVendors.list", { taxYear: 2026 });
    expect(list.threshold.amount).toBe("2000.00");
    const underRow = list.vendors.find((v: Json) => v.vendor.name === "Under Contractor");
    const overRow = list.vendors.find((v: Json) => v.vendor.name === "Over Contractor");
    expect(underRow.meetsThreshold).toBe(false);
    expect(overRow.meetsThreshold).toBe(true);

    const packet1 = await taxAct(f, "taxCpaPacket.build", { taxYear: 2026 });
    const packet2 = await taxAct(f, "taxCpaPacket.build", { taxYear: 2026 });
    expect(packet1.format).toBe("rastrata-cpa-packet-v1");
    expect(packet1.folder).toBe("rastrata-cpa-packet-2026");
    expect(packet1.manifestSha256).toBe(packet2.manifestSha256);

    const paths = (packet1.files as { path: string }[]).map((file) => file.path);
    for (const required of [
      "README.md",
      "manifest.json",
      "statements/profit-and-loss.csv",
      "statements/balance-sheet.csv",
      "statements/cash-flow.csv",
      "statements/trial-balance.csv",
      "statements/general-ledger.csv",
      "accounting/chart-of-accounts.csv",
      "accounting/journal.csv",
      "accounting/changes.csv",
      "accounting/reconciliations.csv",
      "accounting/reconciliation-lines.csv",
      "accounting/adjusting-entries-template.csv",
      "tax/schedule-c-worksheet.csv",
      "tax/1099-vendors.csv",
      "tax/1099-payments.csv",
    ])
      expect(paths, required).toContain(required);

    const readme = packet1.files.find((file: Json) => file.path === "README.md").content as string;
    expect(readme).toContain("Northwind Holdings LLC");
    expect(readme).toContain("12-3456789");
    const vendorsCsv = packet1.files.find((file: Json) => file.path === "tax/1099-vendors.csv")
      .content as string;
    expect(vendorsCsv).toContain("Legal name,Address,Email,TIN status");
    expect(vendorsCsv).toContain("Over Contractor Consulting LLC");
    expect(vendorsCsv).toContain("on file");
  });
});
