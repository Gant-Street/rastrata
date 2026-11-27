// Offline tools for the book's files: restore a backup, rebuild a book from an export, check an
// export. They run without the service, directly on files, and are what `rastrata restore`,
// `rastrata import-export` and `rastrata export verify` start. Usage:
//
//   bun apps/api/src/tool.ts restore <backup|id|latest> --to <db> [--replace] [--no-manifest] [--quick] [--backup-dir DIR]
//   bun apps/api/src/tool.ts import-export <export folder> --to <db>
//   bun apps/api/src/tool.ts check-export <export folder>
//
// Progress goes to stderr; stdout is one JSON envelope. Exit codes: 0 done, 2 usage, 3 refused or
// failed verification, 4 failed.
import { checkExportFiles, importOpenExport, restoreBackup } from "@rastrata/application/local";
import { ApplicationError } from "@rastrata/application/schema";

const VERSION = "rastrata-application-v1";

interface Parsed {
  readonly positional: string[];
  readonly flags: Map<string, string>;
}

const BOOLEAN_FLAGS = new Set(["replace", "no-manifest", "quick"]);

function parse(argv: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [name = "", inline] = arg.slice(2).split(/=(.*)/s);
    if (inline !== undefined) flags.set(name, inline);
    else if (BOOLEAN_FLAGS.has(name)) flags.set(name, "true");
    else {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      flags.set(name, value);
      index += 1;
    }
  }
  return { positional, flags };
}

class UsageError extends Error {}

const out = (value: unknown, code = 0): never => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exit(code);
};
const fail = (code: string, message: string, exit: number, details: unknown[] = []): never =>
  out({ version: VERSION, ok: false, error: { code, message, details, retryable: false } }, exit);

/** Progress lines for a person watching a terminal: stage changes, and every few seconds how far a
 * long step has got, with an estimate when the step has run long enough to extrapolate from. */
function reporter() {
  let stage = "";
  let started = 0;
  let last = 0;
  let model: "linear" | "quadratic" = "linear";
  return (update: {
    stage?: string;
    done?: number | null;
    total?: number | null;
    model?: "linear" | "quadratic";
  }) => {
    const now = Date.now();
    if (update.model) model = update.model;
    if (update.stage !== undefined && update.stage !== stage) {
      stage = update.stage;
      started = now;
      last = 0;
      process.stderr.write(`${stage}...\n`);
    }
    if (update.done == null || update.total == null || update.total <= 0) return;
    if (now - last < 3000 && update.done < update.total) return;
    last = now;
    const fraction = update.done / update.total;
    const elapsed = now - started;
    const remaining =
      fraction >= 0.1 && elapsed >= 1500 && update.done < update.total
        ? Math.round(
            (elapsed * (model === "quadratic" ? 1 / (fraction * fraction) - 1 : 1 / fraction - 1)) /
              1000,
          )
        : null;
    process.stderr.write(
      `  ${update.done} of ${update.total} (${Math.round(fraction * 100)}%)${remaining === null ? "" : `, about ${remaining} s left (an estimate${model === "quadratic" ? "; the last part is the slowest" : ""})`}\n`,
    );
  };
}

/** Run the tool with the arguments after its name. It writes its one JSON envelope and exits the
 * process; the installed executable runs it as `rastrata-service tool ...`. */
export async function runTool(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv;
  let parsed: Parsed;
  try {
    parsed = parse(rest);
  } catch (error) {
    return fail("usage_error", (error as Error).message, 2);
  }
  const { positional, flags } = parsed;
  try {
    if (command === "restore") {
      const backup = positional[0];
      const to = flags.get("to");
      if (!backup || !to || positional.length !== 1)
        return fail(
          "usage_error",
          "Use: restore <backup file, backup id or latest> --to <database path> [--replace] [--no-manifest] [--quick]",
          2,
        );
      const dir = flags.get("backup-dir");
      const result = await restoreBackup({
        backup,
        to,
        ...(flags.get("replace") === "true" ? { replace: true } : {}),
        ...(flags.get("no-manifest") === "true" ? { allowNoManifest: true } : {}),
        ...(flags.get("quick") === "true" ? { quick: true } : {}),
        ...(dir ? { backupDirectory: dir } : {}),
        progress: reporter(),
      });
      for (const warning of result.warnings) process.stderr.write(`Note: ${warning}\n`);
      process.stderr.write(`${result.firstStart.note}\n`);
      if (result.safetyCopy)
        process.stderr.write(`The database that was replaced is kept in ${result.safetyCopy}\n`);
      return out({ version: VERSION, ok: true, data: result });
    }
    if (command === "import-export") {
      const directory = positional[0];
      const to = flags.get("to");
      if (!directory || !to || positional.length !== 1)
        return fail(
          "usage_error",
          "Use: import-export <export folder> --to <new database path>",
          2,
        );
      const result = await importOpenExport({ directory, to, progress: reporter() });
      return out({ version: VERSION, ok: true, data: result });
    }
    if (command === "check-export") {
      const directory = positional[0];
      if (!directory || positional.length !== 1)
        return fail("usage_error", "Use: check-export <export folder>", 2);
      const result = await checkExportFiles(directory);
      return out(
        {
          version: VERSION,
          ok: result.passed,
          data: { passed: result.passed, checks: result.checks, manifest: result.manifest },
        },
        result.passed ? 0 : 3,
      );
    }
    return fail("usage_error", "Commands: restore, import-export, check-export", 2);
  } catch (error) {
    // A refusal or a failed verification is the person's to act on (3); anything else is a failure (4).
    if (error instanceof ApplicationError)
      return fail(error.code, error.message, error.status >= 500 ? 4 : 3, [...error.details]);
    return fail("tool_failed", error instanceof Error ? error.message : String(error), 4);
  }
}

if (import.meta.main) await runTool();
