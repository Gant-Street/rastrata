import { API_VERSION } from "@rastrata/application/client-contracts";
import { ambientFetch } from "../../ambient";
import type { ApplicationFetch } from "../../application-client";
import {
  announceSignInRequired,
  SESSION_ENDED_MESSAGE,
  SIGN_IN_REQUIRED_CODE,
} from "../../session";

/** The largest statement file the service takes. */
export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

export type UploadReceipt = { sha256: string; size: number; mediaType: string; name?: string };

/** A refusal or a failure of the upload, in words the page can show beside the file. */
export class UploadError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** Extensions that can never be a statement, so the person is told before the bytes travel. The
 * service decides by content, not by name; this only saves the trip. */
const NOT_STATEMENTS: Readonly<Record<string, string>> = {
  ".pdf": "a PDF",
  ".xls": "a legacy Excel workbook",
  ".numbers": "a Numbers spreadsheet",
  ".png": "an image",
  ".jpg": "an image",
  ".jpeg": "an image",
  ".heic": "an image",
  ".zip": "a ZIP archive",
  ".gz": "a compressed file",
  ".json": "a JSON file",
  ".docx": "a Word document",
};

/** What is wrong with a file before it is sent, or null when nothing is. */
export function refuseFile(file: Pick<File, "name" | "size">): string | null {
  if (file.size === 0) return "That file is empty.";
  if (file.size > MAX_UPLOAD_BYTES)
    return "That file is larger than 16 MiB. Download a shorter date range and import it in parts.";
  const dot = file.name.lastIndexOf(".");
  const extension = dot === -1 ? "" : file.name.slice(dot).toLowerCase();
  const kind = NOT_STATEMENTS[extension];
  return kind
    ? `That looks like ${kind}, which cannot be imported. Download the statement as CSV, XLSX, OFX, QFX or QBO from your bank instead.`
    : null;
}

/** Send a statement file as the raw body of `POST /v1/uploads`. The service archives it under the
 * SHA-256 of its bytes, so sending the same file twice is harmless and no operation identity is
 * needed. The file name travels percent-encoded as a label only. */
export async function uploadStatement(
  file: File,
  bookId: string,
  fetcher: ApplicationFetch = ambientFetch,
): Promise<UploadReceipt> {
  let response: Response;
  try {
    response = await fetcher("/v1/uploads", {
      method: "POST",
      headers: {
        "content-type": file.type || "application/octet-stream",
        "x-upload-name": encodeURIComponent(file.name),
      },
      body: file,
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new UploadError(
      "The file could not be uploaded. Check that the application is running, then try again.",
      "upload_failed",
    );
  }
  let body: {
    version?: string;
    bookId?: string;
    ok?: boolean;
    data?: UploadReceipt;
    error?: { code?: string; message?: string };
  };
  try {
    body = await response.json();
  } catch {
    throw new UploadError("The application's reply could not be read. Try again.", "upload_failed");
  }
  // A service that wants a sign-in says so before it looks at the file; the page asks for the sign-in.
  if (response.status === 401 && body.error?.code === SIGN_IN_REQUIRED_CODE) {
    announceSignInRequired();
    throw new UploadError(SESSION_ENDED_MESSAGE, SIGN_IN_REQUIRED_CODE);
  }
  if (body.version !== API_VERSION || body.bookId !== bookId)
    throw new UploadError(
      "The application's reply did not match this book. Try again.",
      "upload_failed",
    );
  if (body.ok === false || !response.ok)
    throw new UploadError(
      typeof body.error?.message === "string" ? body.error.message : "The file was refused.",
      typeof body.error?.code === "string" ? body.error.code : "upload_refused",
    );
  const receipt = body.data;
  if (
    !receipt ||
    typeof receipt.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(receipt.sha256) ||
    !Number.isInteger(receipt.size)
  )
    throw new UploadError(
      "The application's reply was not a file receipt. Try again.",
      "upload_failed",
    );
  return receipt;
}
