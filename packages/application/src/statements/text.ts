/** Turning the bytes of a statement file into text. Pure and portable: web standards only.
 *
 * A bank file arrives in whatever encoding its exporter liked. UTF-8 with or without a byte order
 * mark is common, Excel writes UTF-16 for "Unicode text", and older bank software writes Windows-1252.
 * Decoding never throws: undecodable bytes become U+FFFD and the caller is told. */

export type TextEncoding = "utf-8" | "utf-16le" | "utf-16be" | "windows-1252";

export interface DecodedText {
  readonly text: string;
  readonly encoding: TextEncoding;
  /** True when the file started with a byte order mark (which is removed from `text`). */
  readonly bom: boolean;
  /** NUL characters replaced with U+FFFD: a database text column cannot hold them safely. */
  readonly nulReplaced: number;
  /** Characters that could not be decoded in the chosen encoding. */
  readonly undecodable: number;
}

/** The Windows-1252 code points for bytes 0x80 to 0x9F; the rest of the range is Latin-1. A table
 * rather than `TextDecoder("windows-1252")`, so every runtime (Bun, a Worker, a browser) agrees. */
const CP1252_HIGH = [
  0x20ac, 0xfffd, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0xfffd, 0x017d, 0xfffd, 0xfffd, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0xfffd, 0x017e, 0x0178,
] as const;

function decodeWindows1252(bytes: Uint8Array): { text: string; undecodable: number } {
  const parts: string[] = [];
  let undecodable = 0;
  const chunk = 8192;
  for (let start = 0; start < bytes.length; start += chunk) {
    const end = Math.min(bytes.length, start + chunk);
    const codes = new Array<number>(end - start);
    for (let index = start; index < end; index++) {
      const byte = bytes[index] as number;
      let code = byte;
      if (byte >= 0x80 && byte <= 0x9f) {
        code = CP1252_HIGH[byte - 0x80] as number;
        if (code === 0xfffd) undecodable++;
      }
      codes[index - start] = code;
    }
    parts.push(String.fromCharCode(...codes));
  }
  return { text: parts.join(""), undecodable };
}

function decodeUtf16(bytes: Uint8Array, bigEndian: boolean): { text: string; undecodable: number } {
  const parts: string[] = [];
  let undecodable = 0;
  const units = bytes.length >> 1;
  const chunk = 8192;
  for (let start = 0; start < units; start += chunk) {
    const end = Math.min(units, start + chunk);
    const codes = new Array<number>(end - start);
    for (let index = start; index < end; index++) {
      const first = bytes[index * 2] as number;
      const second = bytes[index * 2 + 1] as number;
      codes[index - start] = bigEndian ? (first << 8) | second : (second << 8) | first;
    }
    parts.push(String.fromCharCode(...codes));
  }
  let text = parts.join("");
  if (bytes.length % 2 === 1) {
    text += "�";
    undecodable++;
  }
  // A lone surrogate is not text; say so rather than pass it on.
  const before = text;
  text = text.toWellFormed();
  if (text !== before) undecodable++;
  return { text, undecodable };
}

function replaceNul(text: string): { text: string; count: number } {
  if (!text.includes("\u0000")) return { text, count: 0 };
  let count = 0;
  const replaced = text.replaceAll("\u0000", () => {
    count++;
    return "�";
  });
  return { text: replaced, count };
}

/** Decode a statement file. `declared` is the encoding a header announced (OFX `CHARSET`), used
 * only when the bytes are not valid UTF-8. */
export function decodeText(bytes: Uint8Array, declared?: TextEncoding): DecodedText {
  let encoding: TextEncoding;
  let body = bytes;
  let bom = false;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    encoding = "utf-8";
    body = bytes.subarray(3);
    bom = true;
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf-16le";
    body = bytes.subarray(2);
    bom = true;
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf-16be";
    body = bytes.subarray(2);
    bom = true;
  } else {
    encoding = "utf-8";
  }
  let raw: string;
  let undecodable = 0;
  if (encoding === "utf-16le" || encoding === "utf-16be") {
    const decoded = decodeUtf16(body, encoding === "utf-16be");
    raw = decoded.text;
    undecodable = decoded.undecodable;
  } else {
    try {
      raw = new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
      // Not UTF-8. Bank software that says nothing is almost always Windows-1252.
      encoding = declared === "utf-8" ? "utf-8" : "windows-1252";
      if (encoding === "utf-8") {
        raw = new TextDecoder("utf-8").decode(body);
        undecodable = (raw.match(/�/g) ?? []).length;
      } else {
        const decoded = decodeWindows1252(body);
        raw = decoded.text;
        undecodable = decoded.undecodable;
      }
    }
  }
  const nul = replaceNul(raw);
  return { text: nul.text, encoding, bom, nulReplaced: nul.count, undecodable };
}

/** Bytes that are clearly not a text statement: a PDF, a ZIP (Excel workbooks are ZIPs), an image, a
 * gzip stream, or text with so many control bytes it is a binary file. Returned as a plain-language
 * name for the kind of file, or null when it may be text. */
export function binaryKind(bytes: Uint8Array): string | null {
  const starts = (...signature: number[]) =>
    signature.every((byte, index) => bytes[index] === byte);
  if (starts(0x25, 0x50, 0x44, 0x46)) return "a PDF";
  if (starts(0x50, 0x4b, 0x03, 0x04) || starts(0x50, 0x4b, 0x05, 0x06))
    return "a ZIP archive or an Excel workbook";
  if (starts(0xd0, 0xcf, 0x11, 0xe0)) return "an old Excel workbook";
  if (starts(0x1f, 0x8b)) return "a compressed file";
  if (starts(0x89, 0x50, 0x4e, 0x47) || starts(0xff, 0xd8, 0xff) || starts(0x47, 0x49, 0x46, 0x38))
    return "an image";
  if (bytes.length >= 4 && (starts(0xff, 0xfe) || starts(0xfe, 0xff))) return null;
  // Sample for control bytes other than tab, line feed, carriage return and the form feed some
  // exporters add. A UTF-16 file without a byte order mark shows up as alternating NULs.
  const sample = Math.min(bytes.length, 65536);
  let control = 0;
  for (let index = 0; index < sample; index++) {
    const byte = bytes[index] as number;
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c) control++;
  }
  return sample > 0 && control * 20 > sample ? "a binary file" : null;
}
