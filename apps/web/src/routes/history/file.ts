import { MAX_UPLOAD_BYTES } from "../statements/upload";

/** Extensions that can never be a list of entries, so the person is told before the bytes travel. The service
 * decides by content, not by name; this only saves the trip. */
const NOT_JOURNALS: Readonly<Record<string, string>> = {
  ".pdf": "a PDF",
  ".xls": "an old Excel workbook (.xls)",
  ".numbers": "a Numbers spreadsheet",
  ".png": "an image",
  ".jpg": "an image",
  ".jpeg": "an image",
  ".zip": "a ZIP archive",
  ".gz": "a compressed file",
  ".json": "a JSON file",
  ".docx": "a Word document",
  ".qbw": "a QuickBooks company file",
  ".qbb": "a QuickBooks backup",
  ".iif": "an IIF file",
};

/** What is wrong with a file before it is sent, or null when nothing is. */
export function refuseJournal(file: Pick<File, "name" | "size">): string | null {
  if (file.size === 0) return "That file is empty.";
  if (file.size > MAX_UPLOAD_BYTES)
    return "That file is larger than 16 MiB. Export it in parts, oldest first, and bring in each part.";
  const dot = file.name.lastIndexOf(".");
  const kind = NOT_JOURNALS[dot === -1 ? "" : file.name.slice(dot).toLowerCase()];
  return kind
    ? `That looks like ${kind}, which cannot be read. Export the entries as an Excel file (.xlsx) or a CSV and choose that file.`
    : null;
}
