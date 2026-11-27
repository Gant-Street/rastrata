import { encodeBookCommand } from "@rastrata/kernel";
import type { ExportRecord } from "../client-contracts.gen.ts";
import { ApplicationError } from "../errors.ts";
import type { ApplicationService } from "../service.ts";
import type { ApplicationAccess } from "../agent/principal.ts";
import { operationCatalog, validateSchema } from "../schema.ts";
import { writeOpenExport, type OutcomeLine, type SourceLine } from "./export-book.ts";
import { type ReadOperation, recordFiles } from "./export-records.ts";
import { backupIdFor } from "./manifest.ts";
import type { JobResult } from "./jobs.ts";
import { safetyRuntime } from "./jobs.ts";
import { exportHost } from "./operations.ts";
import type { LedgerHead, Progress } from "./types.ts";

type OutcomePage = Awaited<ReturnType<ApplicationService["outcomePage"]>>;

/** The ledger's retained outcomes in order, up to and including `through`: the book may move on
 * while an export is written, but the chain before a head never changes. */
async function* outcomesThrough(
  service: ApplicationService,
  through: LedgerHead,
): AsyncGenerator<OutcomeLine> {
  const last = BigInt(through.sequence);
  let page: OutcomePage = await service.outcomePage();
  for (;;) {
    for (const outcome of page.outcomes) {
      if (BigInt(outcome.head.sequence) > last) return;
      yield {
        sequence: outcome.head.sequence,
        bookRevision: outcome.head.bookRevision,
        previousChainHash: outcome.previousHash,
        chainHash: outcome.head.chainHash,
        disposition: outcome.payload.originalResult.disposition,
        commandId: outcome.payload.command.id,
        type: outcome.payload.command.type,
        command: encodeBookCommand(outcome.payload.command),
      };
    }
    if (BigInt(page.through.sequence) >= last) return;
    if (page.outcomes.length === 0)
      throw new ApplicationError("export_failed", "The ledger has a gap in its history.", 500);
    page = await service.outcomePage(page.through);
  }
}

interface SourceRow {
  id: string;
  body: string;
  content_hash: string;
  posting_operation_id: string | null;
}

function sourceLines(service: ApplicationService): Map<string, SourceLine> {
  const rows = service.store
    .query("SELECT id, body, content_hash, posting_operation_id FROM app_sources")
    .all() as SourceRow[];
  const found = new Map<string, SourceLine>();
  for (const row of rows) {
    try {
      const body = JSON.parse(row.body) as { description?: unknown; evidenceReference?: unknown };
      found.set(row.id, {
        id: row.id,
        description: typeof body.description === "string" ? body.description : "",
        ...(typeof body.evidenceReference === "string"
          ? { evidenceReference: body.evidenceReference }
          : {}),
        contentHash: row.content_hash,
        postingOperationId: row.posting_operation_id,
      });
    } catch {
      // A source row that cannot be read is exported by its hash alone, from the journal.
    }
  }
  return found;
}

/** The reference a person gave each posted journal, by the id of the command that posted it. It is
 * product state (the ledger stores narrations, not references), kept on the draft the journal was
 * posted from. */
function references(service: ApplicationService): Map<string, string> {
  const rows = service.store
    .query(
      "SELECT a.id AS command_id, d.body AS body FROM app_actions a JOIN app_drafts d ON d.id = json_extract(a.request_body, '$.draftId') WHERE a.kind = 'postDraft' AND d.status = 'posted'",
    )
    .all() as { command_id: string; body: string }[];
  const found = new Map<string, string>();
  for (const row of rows) {
    try {
      const body = JSON.parse(row.body) as { reference?: unknown };
      if (typeof body.reference === "string" && body.reference !== "")
        found.set(row.command_id, body.reference);
    } catch {
      // A draft that cannot be read has no reference to export.
    }
  }
  return found;
}

/** The application's read operations, called from inside the service for the files of records: the way a client would (the input and the reply checked against the
 * contract) and with `read` permission only, so the export reads what any member of the book may read and no more. */
export function readAsOwner(service: ApplicationService): ReadOperation {
  const access: ApplicationAccess = {
    bookId: service.bookId,
    permissions: ["read"],
    principal: { kind: "owner" },
  };
  return (async (name: string, input: Record<string, unknown> = {}) => {
    const definition = operationCatalog.find((item) => item.name === name);
    if (!definition) throw new Error(`Unknown operation ${name}`);
    validateSchema(input, definition.input);
    let data: unknown;
    if (name === "accounts.list") data = await service.accounts();
    else {
      // Loaded when first needed: the registry imports the handler of this operation (export.create), so a static import would be a cycle at start-up.
      const { sliceHandlers } = await import("../slices/handlers.ts");
      const handler = Object.hasOwn(sliceHandlers, name) ? sliceHandlers[name] : undefined;
      if (!handler) throw new Error(`Operation ${name} has no handler`);
      data = await handler(input, { service, access, operationId: "" });
    }
    validateSchema(data, definition.output, "output");
    return data;
  }) as ReadOperation;
}

/** The first day of the book's calendar: the day its history begins. */
const firstDay = (periods: readonly { readonly startsOn: unknown }[]): string =>
  periods.map((period) => String(period.startsOn)).sort()[0] ?? "1970-01-01";

/** Write the open export of the book as it stands now. */
export async function exportBook(
  service: ApplicationService,
  progress: Progress,
  read: ReadOperation = readAsOwner(service),
): Promise<JobResult> {
  const host = exportHost(service);
  const runtime = safetyRuntime(service);
  const setup = service.setupState();
  if (!setup)
    throw new ApplicationError("book_not_configured", "Set up the book before exporting it.", 409);
  progress({ stage: "Reading the book", done: null, total: null });
  const { aggregate, head } = await service.readAggregate();
  const genesis = (await service.outcomePage()).genesis;
  const now = runtime.now();
  const id = backupIdFor(now.toISOString(), head);
  const sink = await host.beginExport(id);
  try {
    const manifest = await writeOpenExport(
      {
        id,
        createdAt: now.toISOString(),
        book: { id: service.bookId, name: setup.name, currency: setup.currency },
        setup,
        ledger: { head, genesis },
        state: aggregate.state,
        outcomes: outcomesThrough(service, head),
        sources: sourceLines(service),
        references: references(service),
        records: recordFiles(read, firstDay(aggregate.state.periods)),
      },
      sink,
      progress,
    );
    const { location } = await sink.finish();
    const record: ExportRecord = {
      id: manifest.id,
      createdAt: manifest.createdAt,
      format: manifest.format,
      location,
      head: manifest.ledger.head,
      counts: manifest.counts,
      bytes: manifest.files.reduce((total, file) => total + file.bytes, 0),
      files: [...manifest.files],
      manifestSha256: manifest.manifestSha256,
    };
    return { export: record };
  } catch (error) {
    await sink.abort().catch(() => {});
    throw error;
  }
}
