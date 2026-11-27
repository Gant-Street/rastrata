import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { decodeBookCommand, decodeDurableBook, hashCanonical } from "@rastrata/kernel";
import { PREPARED_OPERATION_PERMISSIONS } from "../schema.ts";
import { ApplicationError } from "../errors.ts";
import { sha256Hex } from "../safety/manifest.ts";
import type { Check, LedgerHead, Progress } from "../safety/types.ts";
import { checkExportFiles } from "./export-check.ts";
import { ensurePrivateDirectory, fsyncDirectory } from "./files.ts";
import { configureLocalDatabase, openLocalLedger } from "./ledger.ts";
import { LocalBookService } from "./open.ts";

export interface ImportResult {
  readonly to: string;
  readonly exportId: string;
  readonly head: LedgerHead;
  readonly outcomes: number;
  readonly journals: number;
  readonly sourcesRestored: number;
  readonly sourcesSkipped: number;
  readonly replayMs: number;
  readonly checks: readonly Check[];
  readonly note: string;
}

interface CommandLine {
  sequence: string;
  bookRevision: string;
  chainHash: string;
  disposition: string;
  commandId: string;
  type: string;
  command: string;
}

/** The kind of prepared operation each kind of command is retained as. */
const ACTION_KIND: Readonly<Record<string, string>> = {
  postJournal: "postDraft",
  correctJournal: "reverseJournal",
  closePeriod: "closePeriod",
  reopenPeriod: "reopenPeriod",
  replaceConfiguration: "createAccount",
};

interface ExportedJournal {
  id: string;
  date: string;
  narration: string;
  reference: string | null;
  commandId: string;
  source: { id: string; description: string | null; evidenceReference: string | null } | null;
  lines: { accountId: string; debit: string; credit: string }[];
}

/**
 * Give the rebuilt book the application's own record of what was done to it: an entry in the
 * operation index for every command in the ledger (so an old operation identity is found again, a
 * source's posting is known, and nothing can be posted twice), and for each journal posted from a
 * draft, a posted draft carrying the reference its owner gave it, so the Journal screen shows the
 * references again. All of it is derived from the sealed commands and the journals in the export.
 */
function rebuildOperationIndex(
  service: LocalBookService,
  commands: readonly CommandLine[],
  directory: string,
): void {
  const journals = new Map<string, ExportedJournal>();
  for (const line of lines(join(directory, "journals.jsonl"))) {
    const journal = JSON.parse(line) as ExportedJournal;
    journals.set(journal.commandId, journal);
  }
  service.store.transaction(() => {
    for (const line of commands) {
      const kind = ACTION_KIND[line.type];
      if (!kind || !Object.hasOwn(PREPARED_OPERATION_PERMISSIONS, kind)) continue;
      const journal = journals.get(line.commandId);
      let requestBody: string | null = null;
      if (line.type === "postJournal" && line.disposition === "committed" && journal) {
        const source = journal.source;
        const sourced = source !== null && source.description !== null && source.description !== "";
        if (source === null || sourced) {
          // A journal posted from a source event has a financial id of its own; the draft's id is
          // free. One posted without a source has the draft's id as its journal id.
          const draftId = source ? crypto.randomUUID() : journal.id;
          const body = {
            date: journal.date,
            reference: (journal.reference ?? journal.narration).slice(0, 80),
            narration: journal.narration,
            ...(source && sourced
              ? {
                  source: {
                    id: source.id,
                    description: source.description,
                    ...(source.evidenceReference
                      ? { evidenceReference: source.evidenceReference }
                      : {}),
                  },
                }
              : {}),
            lines: journal.lines.map((entry) => ({
              accountId: entry.accountId,
              debit: entry.debit === "0.00" ? "" : entry.debit,
              credit: entry.credit === "0.00" ? "" : entry.credit,
            })),
          };
          service.store
            .query(
              "INSERT INTO app_drafts (id, version, status, body, sealed_command, outcome_sequence, rejected) VALUES (?, 1, 'posted', ?, ?, ?, 0)",
            )
            .run(draftId, JSON.stringify(body), line.command, line.sequence);
          requestBody = JSON.stringify({ draftId, draftVersion: 1 });
        }
      }
      service.store
        .query(
          "INSERT OR IGNORE INTO app_actions (id, kind, sealed_command, request_body, submitted, outcome_sequence) VALUES (?, ?, ?, ?, 1, ?)",
        )
        .run(line.commandId, kind, line.command, requestBody, line.sequence);
    }
  });
}

const lines = (path: string): string[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);

/**
 * Rebuild a book from an open export, by replay. The export's files are checked against its
 * manifest first. Then the book's starting record is provisioned into a new database and every
 * sealed command in `commands.jsonl` is run again in order, and the chain hash after each one must
 * equal the one the export recorded: a command that gave a different result, or a missing or
 * altered line, stops the import at that sequence. Only when the last chain hash equals the
 * manifest's head is the new database moved to its name. An existing database is never touched.
 */
export async function importOpenExport(options: {
  readonly directory: string;
  readonly to: string;
  readonly progress?: Progress;
}): Promise<ImportResult> {
  const progress = options.progress ?? (() => {});
  const directory = resolve(options.directory);
  const to = resolve(options.to);
  if (existsSync(to) || existsSync(`${to}-wal`) || existsSync(`${to}-shm`))
    throw new ApplicationError(
      "import_target_exists",
      `${to} already exists. An import only creates a new database; choose another path.`,
      409,
    );

  progress({ stage: "Checking the export's files", done: null, total: null });
  const checked = await checkExportFiles(directory);
  if (!checked.passed || !checked.manifest)
    throw new ApplicationError(
      "import_export_invalid",
      `This export did not pass its own checks: ${checked.checks.find((check) => check.status === "failed")?.message ?? "unknown problem"}`.slice(
        0,
        590,
      ),
      422,
      checked.checks
        .filter((check) => check.status === "failed")
        .map((check) => ({ path: check.code, message: check.message })),
    );
  const manifest = checked.manifest;
  const book = JSON.parse(readFileSync(join(directory, "book.json"), "utf8")) as {
    setup?: unknown;
    ledger?: { genesis?: unknown; genesisSha256?: unknown };
  };
  const genesis = book.ledger?.genesis;
  if (
    typeof genesis !== "string" ||
    (await sha256Hex(genesis)) !== manifest.ledger.genesisSha256 ||
    book.ledger?.genesisSha256 !== manifest.ledger.genesisSha256
  )
    throw new ApplicationError(
      "import_export_invalid",
      "The book's starting record in book.json does not match the manifest.",
      422,
    );
  const decoded = decodeDurableBook(genesis);
  if (decoded.disposition !== "decoded")
    throw new ApplicationError(
      "import_export_invalid",
      "The book's starting record cannot be decoded.",
      422,
    );
  const commands = lines(join(directory, "commands.jsonl")).map((line, index): CommandLine => {
    try {
      return JSON.parse(line) as CommandLine;
    } catch {
      throw new ApplicationError(
        "import_export_invalid",
        `commands.jsonl line ${index + 1} is not valid JSON.`,
        422,
      );
    }
  });
  if (commands.length !== manifest.ledger.outcomes || commands.length === 0)
    throw new ApplicationError(
      "import_export_invalid",
      `commands.jsonl has ${commands.length} commands but the manifest says ${manifest.ledger.outcomes}.`,
      422,
    );

  ensurePrivateDirectory(dirname(to));
  const partial = join(dirname(to), `.${basename(to)}.importing-${randomBytes(4).toString("hex")}`);
  const cleanup = () => {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${partial}${suffix}`, { force: true });
  };
  const started = performance.now();
  let configuredAt: string = manifest.createdAt;
  try {
    const db = new Database(partial, { create: true });
    configureLocalDatabase(db);
    try {
      const local = await openLocalLedger(db);
      const first = decodeBookCommand(commands[0]?.command ?? "");
      if (first.disposition !== "decoded" || first.command.type !== "activateBook")
        throw new ApplicationError(
          "import_export_invalid",
          "The first command is not the book's activation.",
          422,
        );
      configuredAt = String(first.command.committedAt);
      // The rebuild runs each command through the ledger's own write path, which looks up keyed facts
      // instead of re-deriving the whole state, so a command costs the same whatever the book holds, for
      // both kinds of book (see replay-cost.ts): 1.2 ms a command at 2,000 journals with the chain-head
      // state commitment and without it, half-way at half the time. The replay at the first read that
      // follows is the one whose cost depends on the kind.
      progress({
        stage: "Rebuilding the ledger",
        done: 0,
        total: commands.length,
        model: "linear",
      });
      const provisioned = await local.ledger.provision(
        await local.credential(first.command.actorId),
        decoded.aggregate,
        first.command,
      );
      if (provisioned.result.disposition !== "committed")
        throw new ApplicationError("import_failed", "The activation did not commit.", 500);
      const page = await local.ledger.outcomes(await local.credential(), null, 1);
      const activation = page.outcomes[0];
      const expectedFirst = commands[0] as CommandLine;
      if (!activation || activation.head.chainHash !== expectedFirst.chainHash)
        throw new ApplicationError(
          "import_chain_mismatch",
          "The activation gives a different chain hash from the export's, so this export does not rebuild the book it describes.",
          422,
        );
      for (let index = 1; index < commands.length; index++) {
        const line = commands[index] as CommandLine;
        const command = decodeBookCommand(line.command);
        if (command.disposition !== "decoded" || command.command.id !== line.commandId)
          throw new ApplicationError(
            "import_export_invalid",
            `commands.jsonl line ${index + 1} does not hold the command it names.`,
            422,
          );
        const receipt = await local.ledger.execute(
          await local.credential(command.command.actorId),
          command.command,
        );
        const head = receipt.head;
        if (
          head.sequence !== line.sequence ||
          head.bookRevision !== line.bookRevision ||
          head.chainHash !== line.chainHash
        )
          throw new ApplicationError(
            "import_chain_mismatch",
            `Command ${line.sequence} (${line.type}) gives a different result when replayed than the export recorded, so the import stopped there and nothing was written.`,
            422,
          );
        if (index % 25 === 0 || index === commands.length - 1)
          progress({ done: index + 1, total: commands.length });
      }
      const finalPage = await local.ledger.outcomes(await local.credential(), null, 1);
      const tip = finalPage.observedTip;
      const head = manifest.ledger.head;
      if (
        tip.sequence !== head.sequence ||
        tip.bookRevision !== head.bookRevision ||
        tip.chainHash !== head.chainHash
      )
        throw new ApplicationError(
          "import_chain_mismatch",
          `The rebuilt ledger ends at ${tip.chainHash.slice(0, 12)}… but the export's head is ${head.chainHash.slice(0, 12)}….`,
          422,
        );
    } finally {
      db.close();
    }

    // The ledger is rebuilt and proved. Now the application's own record of the book and of the
    // source events it posted from, through the service so the tables are the service's.
    progress({ stage: "Recording the book and its sources", done: null, total: null });
    const service = await LocalBookService.open(partial, { safety: false });
    let restored = 0;
    let skipped = 0;
    try {
      service.store
        .query("INSERT INTO app_book (id, setup, configured_at, status) VALUES (1, ?, ?, 'active')")
        .run(JSON.stringify(book.setup), configuredAt);
      rebuildOperationIndex(service, commands, directory);
      for (const line of lines(join(directory, "sources.jsonl"))) {
        const source = JSON.parse(line) as {
          id?: unknown;
          description?: unknown;
          evidenceReference?: unknown;
          contentHash?: unknown;
          postingOperationId?: unknown;
        };
        if (
          typeof source.id !== "string" ||
          typeof source.description !== "string" ||
          typeof source.contentHash !== "string"
        ) {
          skipped += 1;
          continue;
        }
        const facts = {
          id: source.id,
          description: source.description,
          ...(typeof source.evidenceReference === "string"
            ? { evidenceReference: source.evidenceReference }
            : {}),
        };
        // A source is restored only if its text hashes to what the journal recorded: a source whose
        // text was not in the export would otherwise fail its integrity check later.
        if (source.description === "" || hashCanonical(facts).digest !== source.contentHash) {
          skipped += 1;
          continue;
        }
        service.store
          .query(
            "INSERT OR IGNORE INTO app_sources (id, body, content_hash, posting_operation_id) VALUES (?, ?, ?, ?)",
          )
          .run(
            facts.id,
            JSON.stringify(facts),
            source.contentHash,
            typeof source.postingOperationId === "string" ? source.postingOperationId : null,
          );
        restored += 1;
      }
      // Fold the write-ahead log into the main file, so the database that is moved into place is
      // one self-contained file.
      service.store.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      service.close();
    }
    for (const suffix of ["-wal", "-shm"]) {
      const leftover = `${partial}${suffix}`;
      if (!existsSync(leftover)) continue;
      if (suffix === "-wal" && statSync(leftover).size > 0)
        throw new ApplicationError(
          "import_failed",
          "The new database still holds unwritten changes in its write-ahead log.",
          500,
        );
      rmSync(leftover, { force: true });
    }
    renameSync(partial, to);
    fsyncDirectory(dirname(to));
    return {
      to,
      exportId: manifest.id,
      head: manifest.ledger.head,
      outcomes: manifest.ledger.outcomes,
      journals: manifest.counts.journals,
      sourcesRestored: restored,
      sourcesSkipped: skipped,
      replayMs: Math.round(performance.now() - started),
      checks: checked.checks,
      note: "The ledger was rebuilt command by command and ends at the export's chain hash. The service replays it once more the first time it reads the book. Drafts, Inbox items and other working state are not in an export.",
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
