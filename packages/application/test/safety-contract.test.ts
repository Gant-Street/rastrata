import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationHttp } from "../src/http.ts";
import { ApplicationService } from "../src/service.ts";
import { LocalBookService } from "../src/local.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS, operationCatalog } from "../src/schema.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});

const book = {
  name: "Safety Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1000", name: "Cash", role: "asset" },
    { code: "3000", name: "Capital", role: "equity" },
  ],
};

async function call(
  http: ApplicationHttp,
  name: string,
  input: unknown = {},
  operationId?: string,
) {
  const response = await http.fetch(
    new Request(`http://127.0.0.1:4010/v1/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: APPLICATION_API_VERSION,
        bookId: "local-book",
        input,
        ...(operationId ? { operationId } : {}),
      }),
    }),
  );
  return { status: response.status, body: await response.json() };
}

/** A service that offers no host ports, as the hosted runtime would. */
async function bareService() {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-safety-contract-"));
  const local = await LocalBookService.open(join(directory, "book.sqlite"));
  // The local runtime injects the safety host; a bare service has none.
  const bare = new ApplicationService({
    store: local.store,
    ledger: local.ledger,
    credential: async () => "",
    scope: {
      tenantId: "t",
      bookId: local.bookId,
      objectId: "o",
      namespaceId: "n",
      generation: "0",
    },
    actorId: "local-operator",
  });
  cleanup.push(() => {
    local.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { local, bare };
}

const settings = {
  enabled: true,
  intervalHours: 24,
  onShutdown: true,
  verifyAfterBackup: true,
  keepDaily: 7,
  keepWeekly: 4,
  keepMonthly: 12,
  warnAfterHours: 48,
};
const inputFor = (name: string) => (name === "backup.configure" ? settings : {});

const operations = [
  ["backup.status", "read", false],
  ["backup.list", "read", false],
  ["backup.create", "configure", true],
  ["backup.verify", "configure", true],
  ["backup.drill", "configure", true],
  ["backup.configure", "provision", true],
  ["export.create", "configure", true],
  ["export.list", "read", false],
] as const;

test("the safety operations are in the catalog; settings are owner-only, the rest need configure or read", () => {
  for (const [name, permission, writes] of operations) {
    const entry = operationCatalog.find((item) => item.name === name);
    expect(entry, name).toBeDefined();
    expect(entry?.permission, name).toBe(permission);
    expect(entry?.writes, name).toBe(writes);
  }
});

test("a read-only caller can ask about backups but not make or change them", async () => {
  const { local } = await bareService();
  const readOnly = new ApplicationHttp(local, { bookId: local.bookId, permissions: ["read"] });
  const owner = new ApplicationHttp(local, {
    bookId: local.bookId,
    permissions: BUSINESS_PERMISSIONS,
  });
  await call(owner, "book.setup", book, crypto.randomUUID());
  for (const [name, permission] of operations) {
    const denied = await call(readOnly, name, inputFor(name), crypto.randomUUID());
    if (permission === "read") expect(denied.status, name).not.toBe(403);
    else {
      expect(denied.status, name).toBe(403);
      expect(denied.body.error.code).toBe("permission_denied");
    }
  }
});

test("a runtime without a safety host says so with a stable code and never pretends", async () => {
  const { local, bare } = await bareService();
  const owner = new ApplicationHttp(local, {
    bookId: local.bookId,
    permissions: BUSINESS_PERMISSIONS,
  });
  await call(owner, "book.setup", book, crypto.randomUUID());
  const http = new ApplicationHttp(bare, {
    bookId: bare.bookId,
    permissions: BUSINESS_PERMISSIONS,
  });
  for (const [name, , writes] of operations) {
    const result = await call(http, name, inputFor(name), writes ? crypto.randomUUID() : undefined);
    expect(result.status, name).toBe(501);
    expect(result.body.error.code, name).toBe("backup_unavailable");
    expect(JSON.stringify(result.body)).not.toContain("Error:");
  }
});
