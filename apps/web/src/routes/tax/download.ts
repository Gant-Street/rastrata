import { safeDownloadName } from "./controller";

/** Save something the service built as a file on this machine. Nothing leaves the browser: the bytes the
 * service returned are handed to the browser's own download. A name is cleaned to plain characters first,
 * whatever it was. */
function save(filename: string, mediaType: string, parts: BlobPart[]): string {
  const name = safeDownloadName(filename);
  const url = URL.createObjectURL(new Blob(parts, { type: mediaType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}

/** Text as a file, as UTF-8 with a byte order mark so a spreadsheet reads accented names correctly. The
 * service's own file has none; this is only for the download. */
export function saveCsv(filename: string, mediaType: string, content: string): string {
  return save(filename, mediaType, ["﻿", content]);
}

/** Bytes as a file (a zip). */
export function saveBytes(filename: string, mediaType: string, bytes: Uint8Array): string {
  return save(filename, mediaType, [bytes as BlobPart]);
}
