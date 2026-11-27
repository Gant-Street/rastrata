import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { replayGrowthOf } from "../replay-cost.ts";
import { balancesThrough } from "../safety/balances.ts";
import {
  sameHead,
  type BackupManifest,
  type Check,
  type DrillOutcome,
  type LedgerHead,
  type Progress,
  type VerificationOutcome,
} from "../safety/types.ts";
import { copyFileDurably, freeBytes, hashFile, sizeLabel } from "./files.ts";
import { LocalBookService } from "./open.ts";
import { describeDatabase, readBookCommitment } from "./snapshot.ts";

export interface CheckParams {
  /** The backup file. It is only ever read. */
  readonly file: string;
  /** What the backup says about itself; null when it has no manifest to compare with. */
  readonly manifest: BackupManifest | null;
  /** A directory for the working copy the replay runs on. Created here, emptied here. */
  readonly scratchDir: string;
  /** A drill names its working copy as a restore step; a verification keeps it quiet. */
  readonly mode: "verify" | "drill";
  /** False skips the ledger replay: the checks that read the file alone still run. */
  readonly replay?: boolean;
  readonly progress?: Progress;
}

export interface CheckResult {
  readonly checks: readonly Check[];
  readonly replayMs: number | null;
  readonly outcomes: number;
  readonly journals: number;
  readonly head: LedgerHead | null;
  readonly kernelChain: string | null;
  readonly balances: Readonly<Record<string, string>> | null;
}

const KNOWN: readonly (readonly [string, string])[] = [
  [
    "native_ledger_outcome_corrupt",
    "A retained outcome fails its checksum or its place in the chain: the ledger was altered or damaged",
  ],
  ["native_ledger_head_corrupt", "The ledger's head does not match its chain"],
  ["recovery_segment_gap_detected", "The ledger has a gap: an outcome is missing"],
  ["native_ledger_fact_corrupt", "A stored record fails its checksum"],
  [
    "native_ledger_identity_mismatch",
    "This database belongs to a different book or a different ledger format",
  ],
  [
    "Book outcome does not match its kernel result",
    "Replaying a command gives a different result from the one the ledger recorded",
  ],
  ["Book genesis could not be decoded", "The book's starting record cannot be decoded"],
  [
    "Book balances do not match the kernel's rebuild",
    "The balances worked out while replaying differ from the kernel's own rebuild of the book",
  ],
];

/** A replay failure in words a person can act on, with the code kept for a bug report. */
export function explainReplayFailure(error: unknown): string {
  const raw = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ");
  const known = KNOWN.find(([needle]) => raw.includes(needle));
  return (
    known
      ? `${known[1]} (${raw.slice(0, 160)}).`
      : `The ledger could not be replayed: ${raw.slice(0, 300)}`
  ).slice(0, 590);
}

const seconds = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

/**
 * Everything a backup can be checked for, in the order that is cheapest first: that the file is
 * there; its size and SHA-256 against its manifest; SQLite's integrity check; the head and genesis
 * stored inside it against the manifest; then a copy of it is made and the whole ledger is
 * replayed through the same code that serves every read, command by command, each result compared
 * with the one the ledger retained. A check that fails makes the later, costlier ones skip: a file
 * known to be damaged is not worth minutes of replay. Runs in a worker thread or an offline tool,
 * never on the service's event loop.
 */
export async function checkBackupFile(params: CheckParams): Promise<CheckResult> {
  const { file, manifest, scratchDir } = params;
  const progress = params.progress ?? (() => {});
  const checks: Check[] = [];
  const add = (code: string, status: Check["status"], message: string) =>
    checks.push({ code, status, message });
  const result = (extra: Partial<CheckResult> = {}): CheckResult => ({
    checks,
    replayMs: null,
    outcomes: 0,
    journals: 0,
    head: null,
    kernelChain: null,
    balances: null,
    ...extra,
  });
  const failed = () => checks.some((check) => check.status === "failed");
  const name = basename(file);

  if (!existsSync(file)) {
    add("file_present", "failed", `The backup file ${name} is not in the backup folder.`);
    for (const code of ["file_sha256", "integrity", "ledger_stored", "ledger_replay"])
      add(code, "skipped", "Not run: the file is missing.");
    return result();
  }
  add("file_present", "passed", `${name} is in the backup folder.`);

  progress({ stage: "Checking the file", done: 0, total: null, model: "linear" });
  const hashed = hashFile(file, (done, total) => progress({ done, total }));
  if (manifest) {
    const sizeOk = hashed.bytes === manifest.file.bytes;
    const hashOk = hashed.sha256 === manifest.file.sha256;
    add(
      "file_sha256",
      sizeOk && hashOk ? "passed" : "failed",
      sizeOk && hashOk
        ? `The file is ${sizeLabel(hashed.bytes)} and its SHA-256 matches the manifest.`
        : `The file does not match its manifest (${sizeOk ? "same size" : `${hashed.bytes} bytes, expected ${manifest.file.bytes}`}, ${hashOk ? "same hash" : "different SHA-256"}): it was altered or damaged after it was written.`,
    );
  } else
    add(
      "file_sha256",
      "skipped",
      `There is no manifest, so the file's hash (${hashed.sha256.slice(0, 16)}…) has nothing to be compared with.`,
    );

  progress({ stage: "Checking the database structure", done: null, total: null });
  try {
    const db = new Database(file, { readonly: true });
    try {
      const rows = (db.query("PRAGMA integrity_check").all() as { integrity_check: string }[]).map(
        (row) => row.integrity_check,
      );
      if (rows.length === 1 && rows[0] === "ok")
        add("integrity", "passed", "SQLite's integrity check found no problem.");
      else
        add(
          "integrity",
          "failed",
          `SQLite's integrity check found problems: ${rows.slice(0, 3).join("; ")}`.slice(0, 590),
        );
    } finally {
      db.close();
    }
  } catch (error) {
    add(
      "integrity",
      "failed",
      `SQLite cannot read the file: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`,
    );
  }

  try {
    const stored = describeDatabase(file);
    const headOk = !manifest || sameHead(stored.head, manifest.ledger.head);
    const genesisOk = !manifest || stored.genesisSha256 === manifest.ledger.genesisSha256;
    add(
      "ledger_stored",
      headOk && genesisOk ? "passed" : "failed",
      !manifest
        ? `The ledger inside the file ends at outcome ${stored.head.sequence}.`
        : headOk && genesisOk
          ? `The ledger inside the file ends at outcome ${stored.head.sequence}, as the manifest says.`
          : `The ledger inside the file ends at ${stored.head.sequence} (${stored.head.chainHash.slice(0, 12)}…) but the manifest says ${manifest.ledger.head.sequence} (${manifest.ledger.head.chainHash.slice(0, 12)}…), or it belongs to a different book.`,
    );
  } catch (error) {
    add(
      "ledger_stored",
      "failed",
      `The file has no readable ledger: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`,
    );
  }

  if (params.replay === false) {
    add(
      "ledger_replay",
      "skipped",
      "Skipped on request. The service replays the whole ledger the first time it reads the book.",
    );
    return result();
  }
  if (failed()) {
    add(
      "ledger_replay",
      "skipped",
      "Not run: an earlier check failed, so this file cannot be trusted and a replay would only take time.",
    );
    return result();
  }

  rmSync(scratchDir, { recursive: true, force: true });
  mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
  const copy = join(scratchDir, "book.sqlite");
  try {
    const free = freeBytes(scratchDir);
    if (free !== null && free < hashed.bytes * 1.05 + 1_048_576) {
      add(
        params.mode === "drill" ? "restore_copy" : "ledger_replay",
        "failed",
        `There is not enough free space for a working copy: ${sizeLabel(hashed.bytes)} needed, ${sizeLabel(free)} free in ${scratchDir}.`,
      );
      return result();
    }
    progress({ stage: "Making a working copy", done: 0, total: hashed.bytes, model: "linear" });
    const copied = copyFileDurably(file, copy, (done, total) => progress({ done, total }));
    const copyOk = copied.sha256 === hashed.sha256;
    if (params.mode === "drill" || !copyOk)
      add(
        params.mode === "drill" ? "restore_copy" : "working_copy",
        copyOk ? "passed" : "failed",
        copyOk
          ? `Restored the backup into a temporary directory: ${sizeLabel(copied.bytes)}, identical to the backup file.`
          : "The working copy is not identical to the backup file, so the copy or the disk is faulty.",
      );
    if (!copyOk) return result();

    // What is left of a replay is extrapolated from how far it has got, by how its cost grows: with the
    // entries for a book made with the chain-head state commitment (every book the application makes
    // now), with their square for one made without it, and with the square for a book whose kind cannot
    // be read, the safer mistake (see replay-cost.ts).
    progress({
      stage: "Replaying the ledger",
      done: 0,
      total: null,
      model: replayGrowthOf(readBookCommitment(copy)),
    });
    const started = performance.now();
    let service: LocalBookService | null = null;
    try {
      service = await LocalBookService.open(copy, {
        safety: false,
        observe: (page) => progress({ done: Number(page.through), total: Number(page.tip) }),
      });
      const { aggregate, head } = await service.readAggregate(undefined, { verify: "full" });
      const replayMs = Math.round(performance.now() - started);
      const outcomes = service.readStats.verified;
      const journals = aggregate.state.journals.length;
      add(
        "ledger_replay",
        "passed",
        `Replayed ${outcomes} commands (${journals} journals) in ${seconds(replayMs)}; each gave exactly the result the ledger had recorded.`,
      );
      const headOk = !manifest || sameHead(head, manifest.ledger.head);
      add(
        "ledger_head",
        headOk ? "passed" : "failed",
        headOk
          ? `The replay ends at outcome ${head.sequence} with chain hash ${head.chainHash.slice(0, 16)}…${manifest ? ", the head the manifest recorded" : ""}.`
          : `The replay ends at outcome ${head.sequence} (${head.chainHash.slice(0, 12)}…), not at the manifest's ${manifest?.ledger.head.sequence} (${manifest?.ledger.head.chainHash.slice(0, 12)}…).`,
      );
      return result({
        replayMs,
        outcomes,
        journals,
        head: {
          sequence: head.sequence,
          bookRevision: head.bookRevision,
          chainHash: head.chainHash,
        },
        kernelChain: aggregate.state.revisions.at(-1)?.chainHash.digest ?? null,
        balances: balancesThrough(aggregate.state, aggregate.state.bookRevision),
      });
    } catch (error) {
      add("ledger_replay", "failed", explainReplayFailure(error));
      return result({ replayMs: Math.round(performance.now() - started) });
    } finally {
      try {
        service?.close();
      } catch {
        // The working copy is thrown away either way.
      }
    }
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

export interface VerifyTask {
  readonly kind: "verify" | "drill";
  readonly file: string;
  readonly manifest: BackupManifest | null;
  readonly scratchDir: string;
  readonly replay?: boolean;
}

export async function verifyBackupFile(
  task: Omit<VerifyTask, "kind">,
  progress?: Progress,
): Promise<VerificationOutcome> {
  const found = await checkBackupFile({
    ...task,
    mode: "verify",
    ...(progress ? { progress } : {}),
  });
  return {
    passed: found.checks.every((check) => check.status !== "failed"),
    replayMs: found.replayMs,
    outcomes: found.outcomes,
    journals: found.journals,
    head: found.head,
    checks: found.checks,
  };
}

export async function drillBackupFile(
  task: Omit<VerifyTask, "kind">,
  progress?: Progress,
): Promise<DrillOutcome> {
  const found = await checkBackupFile({
    ...task,
    mode: "drill",
    ...(progress ? { progress } : {}),
  });
  return {
    replayMs: found.replayMs,
    checks: found.checks,
    restoredHead: found.head,
    kernelChain: found.kernelChain,
    journals: found.journals,
    outcomes: found.outcomes,
    balances: found.balances,
  };
}
