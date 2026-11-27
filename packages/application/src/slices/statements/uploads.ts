import { ApplicationError } from "../../errors.ts";
import type { ApplicationService } from "../../service.ts";
import { checkedReceipt, ingestFor } from "./ports.ts";

/** The most a statement upload may carry. Operations keep their 128 KiB JSON limit; only this one
 * route takes a raw body. */
export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;
/** Generous for a loopback transfer, short enough that a stalled client does not hold the route. */
const UPLOAD_TIMEOUT_MS = 60_000;
const MAX_NAME_CODE_POINTS = 200;

/** Media types a statement file arrives as. Browsers and operating systems label the same CSV
 * `text/csv`, `application/vnd.ms-excel` or nothing at all, and Intuit files carry their own types,
 * so detection looks at the bytes. This list only turns away what can never be a statement. */
const ACCEPTED = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "text/plain",
  "text/comma-separated-values",
  "text/tab-separated-values",
  "text/ofx",
  "text/x-ofx",
  "text/xml",
  "application/csv",
  "application/xml",
  "application/ofx",
  "application/x-ofx",
  "application/vnd.intu.qfx",
  "application/vnd.intu.qbo",
  "application/x-qfx",
  "application/x-qbo",
  "application/vnd.ms-excel",
  "application/octet-stream",
]);

const PLUGIN_ACCEPTED = new Set([
  ...ACCEPTED,
  "application/json",
  "application/gzip",
  "application/x-gzip",
]);

/** What an upload is for. A statement file is the default. A Stripe pull delivers its answers in a
 * bundle (`X-Upload-For: stripe`, `application/gzip`). An ingestion plugin archives raw payloads
 * with `X-Upload-For: plugin` (JSON, CSV, XML, gzip, or octet-stream). */
function purposeOf(header: string | null): "statement" | "stripe" | "plugin" {
  if (header === null || header === "") return "statement";
  const value = header.trim().toLowerCase();
  if (value === "stripe") return "stripe";
  if (value === "plugin") return "plugin";
  throw new ApplicationError(
    "invalid_input",
    "X-Upload-For must be stripe, plugin, or omitted for a statement file.",
  );
}

function mediaTypeOf(header: string | null, purpose: "statement" | "stripe" | "plugin"): string {
  const base = (header ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (purpose === "stripe") {
    if (base !== "application/gzip" && base !== "application/x-gzip")
      throw new ApplicationError(
        "media_type_unsupported",
        "Answers from Stripe are delivered in a gzip bundle: send it with the content type application/gzip.",
        415,
      );
    return "application/gzip";
  }
  if (purpose === "plugin") {
    if (base === "") return "application/octet-stream";
    if (!PLUGIN_ACCEPTED.has(base))
      throw new ApplicationError(
        "media_type_unsupported",
        "Plugin raw payloads must use JSON, CSV, plain text, XML, gzip, or application/octet-stream.",
        415,
      );
    return base;
  }
  if (base === "") return "application/octet-stream";
  if (!ACCEPTED.has(base))
    throw new ApplicationError(
      "media_type_unsupported",
      "Upload a CSV, OFX, QFX, QBO or Excel (.xlsx) file as the raw request body. PDF statements, images and JSON are not supported.",
      415,
    );
  return base;
}

/** A file name is attacker-controlled text. Keep the last path segment, drop control and
 * direction-changing characters, and bound its length. It is a label, never a path. */
export function cleanFileName(header: string | null): string | undefined {
  if (header === null || header === "") return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(header);
  } catch {
    decoded = header;
  }
  const segment = decoded.split(/[\\/]/).pop() ?? "";
  let cleaned = "";
  for (const symbol of segment) {
    const point = symbol.codePointAt(0) ?? 0;
    const unsafe =
      point < 0x20 ||
      (point >= 0x7f && point <= 0x9f) ||
      (point >= 0x200b && point <= 0x200f) ||
      (point >= 0x202a && point <= 0x202e) ||
      (point >= 0x2066 && point <= 0x2069) ||
      point === 0x2028 ||
      point === 0x2029 ||
      point === 0xfeff;
    cleaned += unsafe ? " " : symbol;
  }
  const name = [...cleaned.replace(/\s+/g, " ").trim()].slice(0, MAX_NAME_CODE_POINTS).join("");
  return name === "" || name === "." || name === ".." ? undefined : name;
}

/** Read the whole body, bounded in bytes and in time, with or without a Content-Length. */
async function readBody(request: Request): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_UPLOAD_BYTES))
    throw tooLarge();
  if (!request.body)
    throw new ApplicationError("invalid_input", "Send the statement file as the request body");
  const reader = request.body.getReader();
  const interrupted = Promise.withResolvers<never>();
  const abort = () =>
    interrupted.reject(
      new ApplicationError(
        "request_aborted",
        "Upload was interrupted; send it again",
        408,
        [],
        true,
      ),
    );
  request.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () =>
      interrupted.reject(
        new ApplicationError("request_timeout", "Upload timed out; send it again", 408, [], true),
      ),
    UPLOAD_TIMEOUT_MS,
  );
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    if (request.signal.aborted) abort();
    for (;;) {
      const chunk = await Promise.race([reader.read(), interrupted.promise]);
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_UPLOAD_BYTES) throw tooLarge();
      chunks.push(chunk.value);
    }
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (total === 0) throw new ApplicationError("invalid_input", "The file is empty");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

const tooLarge = () =>
  new ApplicationError(
    "request_too_large",
    "The file exceeds 16 MiB. Export a shorter date range and import it in parts.",
    413,
  );

/** What a successful upload returns: the content address the import operations take. */
export interface UploadReceipt {
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
  readonly name?: string;
}

/** `POST /v1/uploads`: archive the raw bytes once, addressed by their SHA-256, and hand back the
 * reference. Uploading the same bytes again returns the same reference and stores nothing new, so
 * a client that lost the reply simply sends the file again. Nothing is parsed here. */
export async function receiveUpload(
  service: ApplicationService,
  request: Request,
): Promise<UploadReceipt> {
  const purpose = purposeOf(request.headers.get("x-upload-for"));
  const mediaType = mediaTypeOf(request.headers.get("content-type"), purpose);
  const name = cleanFileName(request.headers.get("x-upload-name"));
  const port = ingestFor(service);
  const bytes = await readBody(request);
  const receipt = checkedReceipt(bytes, port.archive(bytes, mediaType, name));
  return {
    sha256: receipt.sha256,
    size: receipt.size,
    mediaType: receipt.mediaType,
    ...(receipt.name !== undefined ? { name: receipt.name } : {}),
  };
}
