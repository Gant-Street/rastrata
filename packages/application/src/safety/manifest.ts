import {
  APPLICATION_RELEASE,
  BACKUP_FORMAT,
  BACKUP_REASONS,
  EXPORT_FORMAT,
  type BackupManifest,
  type BackupReason,
  type ExportCounts,
  type ExportFileInfo,
  type ExportManifest,
  type LedgerHead,
} from "./types.ts";

/** SHA-256 of a string's UTF-8 bytes as lowercase hex, through Web Crypto: the same call works in
 * Bun, a Worker and a browser, so the portable code needs no `node:` import. */
export async function sha256Hex(text: string | Uint8Array): Promise<string> {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const HEX64 = /^[0-9a-f]{64}$/;
const DIGITS = /^(0|[1-9][0-9]{0,18})$/;
const INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$/;
const ID = /^[0-9]{8}T[0-9]{6}Z-[0-9]{8,19}-[0-9a-f]{8}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

/** `20261003T181500Z-00000042-1a2b3c4d`: when, how far the ledger had got, and which chain. Sorts
 * by time, and two backups of the same state in the same second share an id. */
export function backupIdFor(createdAt: string, head: LedgerHead): string {
  const compact = createdAt.replace(/\.[0-9]+Z$/, "Z").replace(/[-:]/g, "");
  return `${compact}-${head.sequence.padStart(8, "0")}-${head.chainHash.slice(0, 8)}`;
}
export const isBackupId = (value: unknown): value is string =>
  typeof value === "string" && ID.test(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseHead(value: unknown): LedgerHead | null {
  if (!isRecord(value)) return null;
  const { sequence, bookRevision, chainHash } = value;
  if (
    typeof sequence !== "string" ||
    typeof bookRevision !== "string" ||
    typeof chainHash !== "string" ||
    !DIGITS.test(sequence) ||
    !DIGITS.test(bookRevision) ||
    !HEX64.test(chainHash) ||
    BigInt(bookRevision) > BigInt(sequence)
  )
    return null;
  return { sequence, bookRevision, chainHash };
}

/** Members in a fixed order: the manifest's hash is the hash of exactly this serialisation, so a
 * reader can recompute it from the parsed object without trusting the file's key order. */
function backupBody(m: Omit<BackupManifest, "manifestSha256">) {
  return {
    format: m.format,
    id: m.id,
    createdAt: m.createdAt,
    reason: m.reason,
    file: { name: m.file.name, bytes: m.file.bytes, sha256: m.file.sha256 },
    ledger: {
      formatId: m.ledger.formatId,
      head: {
        sequence: m.ledger.head.sequence,
        bookRevision: m.ledger.head.bookRevision,
        chainHash: m.ledger.head.chainHash,
      },
      genesisSha256: m.ledger.genesisSha256,
    },
    application: {
      release: m.application.release,
      stores: Object.fromEntries(
        Object.entries(m.application.stores).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
    },
    book: { name: m.book.name, currency: m.book.currency },
  };
}

export async function sealBackupManifest(
  body: Omit<BackupManifest, "manifestSha256" | "format" | "application"> & {
    readonly application?: Partial<BackupManifest["application"]> & {
      readonly stores: BackupManifest["application"]["stores"];
    };
  },
): Promise<BackupManifest> {
  const unsealed = {
    ...body,
    format: BACKUP_FORMAT,
    application: {
      release: body.application?.release ?? APPLICATION_RELEASE,
      stores: body.application?.stores ?? {},
    },
  } as Omit<BackupManifest, "manifestSha256">;
  const manifestSha256 = await sha256Hex(JSON.stringify(backupBody(unsealed)));
  return { ...backupBody(unsealed), manifestSha256 } as BackupManifest;
}

export type ParsedManifest<T> =
  | { readonly ok: true; readonly manifest: T }
  | { readonly ok: false; readonly problem: string };

/** Read a backup manifest from untrusted bytes. Every field is checked and the manifest's own hash
 * is recomputed; nothing in the file is trusted as a path or a command. */
export async function parseBackupManifest(text: string): Promise<ParsedManifest<BackupManifest>> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, problem: "The manifest is not valid JSON" };
  }
  if (!isRecord(raw)) return { ok: false, problem: "The manifest is not an object" };
  if (raw.format !== BACKUP_FORMAT)
    return { ok: false, problem: `Unsupported manifest format ${JSON.stringify(raw.format)}` };
  const { id, createdAt, reason, file, ledger, application, book, manifestSha256 } = raw;
  if (!isBackupId(id)) return { ok: false, problem: "The manifest has no valid backup id" };
  if (typeof createdAt !== "string" || !INSTANT.test(createdAt))
    return { ok: false, problem: "The manifest has no valid creation time" };
  if (typeof reason !== "string" || !BACKUP_REASONS.includes(reason as BackupReason))
    return { ok: false, problem: "The manifest has an unknown reason" };
  if (
    !isRecord(file) ||
    typeof file.name !== "string" ||
    !FILE_NAME.test(file.name) ||
    file.name !== `${id}.sqlite` ||
    typeof file.bytes !== "number" ||
    !Number.isSafeInteger(file.bytes) ||
    file.bytes < 0 ||
    typeof file.sha256 !== "string" ||
    !HEX64.test(file.sha256)
  )
    return { ok: false, problem: "The manifest describes its file incorrectly" };
  const head = isRecord(ledger) ? parseHead(ledger.head) : null;
  if (
    !isRecord(ledger) ||
    typeof ledger.formatId !== "string" ||
    ledger.formatId.length > 128 ||
    !head ||
    typeof ledger.genesisSha256 !== "string" ||
    !HEX64.test(ledger.genesisSha256)
  )
    return { ok: false, problem: "The manifest describes its ledger incorrectly" };
  if (
    !isRecord(application) ||
    typeof application.release !== "string" ||
    application.release.length > 40 ||
    !isRecord(application.stores) ||
    Object.entries(application.stores).some(
      ([name, version]) => !/^[a-z][a-z0-9_-]{0,40}$/.test(name) || !Number.isSafeInteger(version),
    )
  )
    return { ok: false, problem: "The manifest describes the application incorrectly" };
  if (
    !isRecord(book) ||
    typeof book.name !== "string" ||
    book.name.length > 200 ||
    typeof book.currency !== "string" ||
    book.currency.length > 3
  )
    return { ok: false, problem: "The manifest describes the book incorrectly" };
  if (typeof manifestSha256 !== "string" || !HEX64.test(manifestSha256))
    return { ok: false, problem: "The manifest has no hash" };
  const manifest = {
    format: BACKUP_FORMAT,
    id,
    createdAt,
    reason: reason as BackupReason,
    file: { name: file.name, bytes: file.bytes, sha256: file.sha256 },
    ledger: { formatId: ledger.formatId, head, genesisSha256: ledger.genesisSha256 },
    application: {
      release: application.release,
      stores: application.stores as Record<string, number>,
    },
    book: { name: book.name, currency: book.currency },
  } as const;
  const expected = await sha256Hex(JSON.stringify(backupBody(manifest)));
  if (expected !== manifestSha256)
    return { ok: false, problem: "The manifest does not match its own hash; it was altered" };
  return { ok: true, manifest: { ...backupBody(manifest), manifestSha256 } as BackupManifest };
}

function exportBody(m: Omit<ExportManifest, "manifestSha256">) {
  return {
    format: m.format,
    id: m.id,
    createdAt: m.createdAt,
    generator: { name: m.generator.name, release: m.generator.release },
    book: { id: m.book.id, name: m.book.name, currency: m.book.currency },
    ledger: {
      formatId: m.ledger.formatId,
      head: {
        sequence: m.ledger.head.sequence,
        bookRevision: m.ledger.head.bookRevision,
        chainHash: m.ledger.head.chainHash,
      },
      genesisSha256: m.ledger.genesisSha256,
      outcomes: m.ledger.outcomes,
    },
    counts: {
      journals: m.counts.journals,
      postings: m.counts.postings,
      accounts: m.counts.accounts,
      commands: m.counts.commands,
      sources: m.counts.sources,
    },
    files: m.files.map((f) => ({
      path: f.path,
      bytes: f.bytes,
      sha256: f.sha256,
      lines: f.lines,
    })),
  };
}

export async function sealExportManifest(input: {
  readonly id: string;
  readonly createdAt: string;
  readonly book: ExportManifest["book"];
  readonly ledger: ExportManifest["ledger"];
  readonly counts: ExportCounts;
  readonly files: readonly ExportFileInfo[];
}): Promise<ExportManifest> {
  const unsealed: Omit<ExportManifest, "manifestSha256"> = {
    format: EXPORT_FORMAT,
    id: input.id,
    createdAt: input.createdAt,
    generator: { name: "rastrata", release: APPLICATION_RELEASE },
    book: input.book,
    ledger: input.ledger,
    counts: input.counts,
    files: input.files,
  };
  const manifestSha256 = await sha256Hex(JSON.stringify(exportBody(unsealed)));
  return { ...exportBody(unsealed), manifestSha256 } as ExportManifest;
}

const EXPORT_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;

/** Read an export manifest from untrusted bytes, the same way as a backup manifest. */
export async function parseExportManifest(text: string): Promise<ParsedManifest<ExportManifest>> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, problem: "manifest.json is not valid JSON" };
  }
  if (!isRecord(raw) || raw.format !== EXPORT_FORMAT)
    return { ok: false, problem: `This is not a ${EXPORT_FORMAT} export` };
  const { id, createdAt, generator, book, ledger, counts, files, manifestSha256 } = raw;
  const head = isRecord(ledger) ? parseHead(ledger.head) : null;
  const count = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (
    typeof id !== "string" ||
    !ID.test(id) ||
    typeof createdAt !== "string" ||
    !INSTANT.test(createdAt) ||
    !isRecord(generator) ||
    typeof generator.name !== "string" ||
    typeof generator.release !== "string" ||
    !isRecord(book) ||
    typeof book.id !== "string" ||
    typeof book.name !== "string" ||
    typeof book.currency !== "string" ||
    !isRecord(ledger) ||
    typeof ledger.formatId !== "string" ||
    !head ||
    typeof ledger.genesisSha256 !== "string" ||
    !HEX64.test(ledger.genesisSha256) ||
    !count(ledger.outcomes) ||
    !isRecord(counts) ||
    !count(counts.journals) ||
    !count(counts.postings) ||
    !count(counts.accounts) ||
    !count(counts.commands) ||
    !count(counts.sources) ||
    !Array.isArray(files) ||
    files.length > 50 ||
    typeof manifestSha256 !== "string" ||
    !HEX64.test(manifestSha256)
  )
    return { ok: false, problem: "manifest.json is incomplete or malformed" };
  const parsedFiles: ExportFileInfo[] = [];
  for (const entry of files) {
    if (
      !isRecord(entry) ||
      typeof entry.path !== "string" ||
      !EXPORT_PATH.test(entry.path) ||
      !count(entry.bytes) ||
      typeof entry.sha256 !== "string" ||
      !HEX64.test(entry.sha256) ||
      (entry.lines !== null && !count(entry.lines))
    )
      return { ok: false, problem: "manifest.json lists a file incorrectly" };
    parsedFiles.push({
      path: entry.path,
      bytes: entry.bytes,
      sha256: entry.sha256,
      lines: entry.lines,
    });
  }
  const manifest: Omit<ExportManifest, "manifestSha256"> = {
    format: EXPORT_FORMAT,
    id,
    createdAt,
    generator: { name: generator.name, release: generator.release },
    book: { id: book.id, name: book.name, currency: book.currency },
    ledger: {
      formatId: ledger.formatId,
      head,
      genesisSha256: ledger.genesisSha256,
      outcomes: ledger.outcomes,
    },
    counts: {
      journals: counts.journals,
      postings: counts.postings,
      accounts: counts.accounts,
      commands: counts.commands,
      sources: counts.sources,
    },
    files: parsedFiles,
  };
  if ((await sha256Hex(JSON.stringify(exportBody(manifest)))) !== manifestSha256)
    return { ok: false, problem: "manifest.json does not match its own hash; it was altered" };
  return { ok: true, manifest: { ...exportBody(manifest), manifestSha256 } as ExportManifest };
}

/** A verification sidecar read from untrusted bytes. Returns null for anything malformed: an
 * unreadable record means "not verified", never a pass. */
export function parseVerification(text: string, backupId: string) {
  try {
    const raw: unknown = JSON.parse(text);
    if (!isRecord(raw) || raw.backupId !== backupId) return null;
    const { verifiedAt, passed, durationMs, replayMs, outcomes, journals, head, checks } = raw;
    if (
      typeof verifiedAt !== "string" ||
      !INSTANT.test(verifiedAt) ||
      typeof passed !== "boolean" ||
      typeof durationMs !== "number" ||
      !Number.isSafeInteger(durationMs) ||
      (replayMs !== null && (typeof replayMs !== "number" || !Number.isSafeInteger(replayMs))) ||
      typeof outcomes !== "number" ||
      !Number.isSafeInteger(outcomes) ||
      typeof journals !== "number" ||
      !Number.isSafeInteger(journals) ||
      !Array.isArray(checks) ||
      checks.length > 60
    )
      return null;
    const parsedHead = head === null ? null : parseHead(head);
    if (head !== null && !parsedHead) return null;
    const parsedChecks = [];
    for (const check of checks) {
      if (
        !isRecord(check) ||
        typeof check.code !== "string" ||
        typeof check.message !== "string" ||
        !["passed", "failed", "skipped"].includes(String(check.status))
      )
        return null;
      parsedChecks.push({
        code: check.code.slice(0, 60),
        status: check.status as "passed" | "failed" | "skipped",
        message: check.message.slice(0, 600),
      });
    }
    return {
      backupId,
      verifiedAt,
      passed,
      durationMs,
      replayMs: replayMs as number | null,
      outcomes,
      journals,
      head: parsedHead,
      checks: parsedChecks,
    };
  } catch {
    return null;
  }
}
