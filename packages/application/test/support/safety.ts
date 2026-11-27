import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BackupDrillResult,
  BackupJob,
  BackupRecord,
  BackupVerification,
  ExportRecord,
} from "../../src/client-contracts.gen.ts";
import { ApplicationHttp } from "../../src/http.ts";
import { LocalBookService, type LocalOpenOptions } from "../../src/local.ts";
import { configureSafety } from "../../src/safety/jobs.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS } from "../../src/schema.ts";
import type { BusinessPermission } from "../../src/schema.ts";

/** A finished job as a test reads it: the member for the operation that ran is there. */
export type JobAnswer = Omit<BackupJob, "backup" | "verification" | "drill" | "export"> & {
  backup: BackupRecord;
  verification: BackupVerification;
  drill: BackupDrillResult;
  export: ExportRecord;
};

export const BOOK = {
  name: "Safety Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1000", name: "Cash", role: "asset" },
    { code: "3000", name: "Capital", role: "equity" },
    { code: "4000", name: "Sales", role: "income" },
    { code: "5000", name: "Expense", role: "expense" },
  ],
} as const;

const cleanup: (() => void)[] = [];
export const cleanupSafetyFixtures = () => {
  for (const work of cleanup.splice(0)) work();
};

export interface SafetyFixture {
  readonly directory: string;
  readonly databasePath: string;
  readonly backups: string;
  readonly exports: string;
  readonly service: LocalBookService;
  call(
    name: string,
    input?: unknown,
    operationId?: string,
    permissions?: readonly BusinessPermission[],
    // biome-ignore lint/suspicious/noExplicitAny: tests read untyped JSON answers
  ): Promise<{ status: number; body: any }>;
  /** Run a long operation to its end, asking again with the same identity while it is running. */
  finish(name: string, input?: unknown): Promise<JobAnswer>;
  post(count?: number, reference?: string): Promise<void>;
  restart(options?: LocalOpenOptions): Promise<LocalBookService>;
}

/** A real local book in a temporary directory, with a clock and a wait short enough for tests. */
export async function safetyFixture(
  options: { setup?: boolean; open?: LocalOpenOptions; directory?: string } = {},
): Promise<SafetyFixture> {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), "rastrata-safety-"));
  const databasePath = join(directory, "book.sqlite");
  let service = await LocalBookService.open(databasePath, options.open);
  configureSafety(service, { waitMs: 60_000 });
  const fixture: SafetyFixture = {
    directory,
    databasePath,
    backups: join(directory, "backups", "book"),
    exports: join(directory, "exports", "book"),
    get service() {
      return service;
    },
    async call(name, input = {}, operationId, permissions) {
      const http = new ApplicationHttp(service, {
        bookId: service.bookId,
        permissions: permissions ?? BUSINESS_PERMISSIONS,
      });
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
    },
    async finish(name, input = {}) {
      const id = crypto.randomUUID();
      for (let attempt = 0; attempt < 600; attempt++) {
        const answer = await fixture.call(name, input, id);
        if (answer.status !== 200) throw new Error(`${name}: ${JSON.stringify(answer.body.error)}`);
        const job = answer.body.data as BackupJob;
        if (job.state !== "running") return job as JobAnswer;
        await Bun.sleep(50);
      }
      throw new Error(`${name} did not finish`);
    },
    async post(count = 1, reference = "J") {
      for (let index = 0; index < count; index++) {
        const draft = service.createDraft({
          date: "2026-01-15",
          reference: `${reference}${index}`,
          narration: `${reference} ${index}`,
          lines: [
            { accountId: "1000", debit: "10.50", credit: "" },
            { accountId: "4000", debit: "", credit: "10.50" },
          ],
        });
        const result = await service.postDraft(draft.id);
        if (result.disposition !== "committed") throw new Error("A fixture journal was rejected");
      }
    },
    async restart(open) {
      service.close();
      service = await LocalBookService.open(databasePath, open ?? options.open);
      configureSafety(service, { waitMs: 60_000 });
      return service;
    },
  };
  cleanup.push(() => {
    try {
      service.close();
    } catch {
      // Already closed by the test.
    }
    rmSync(directory, { recursive: true, force: true });
  });
  if (options.setup !== false) {
    const done = await fixture.call("book.setup", BOOK, crypto.randomUUID());
    if (done.status !== 200) throw new Error(`setup failed: ${JSON.stringify(done.body)}`);
  }
  return fixture;
}
