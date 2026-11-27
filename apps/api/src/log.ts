/** The installed service's log: one file in the data directory, a line per event, rotated by size.
 * It records what the service did (start, stop, backups that failed, errors), never what it was
 * asked: no request, no operation payload and no credential reaches it. A message is written as one
 * line with control characters (terminal escapes among them) removed, so text that came from a
 * bank or a file name cannot rewrite a screen when somebody reads the log. */
import { appendFileSync, existsSync, renameSync, rmSync, statSync } from "node:fs";

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, cause?: unknown): void;
}

export interface LoggerOptions {
  readonly file: string;
  /** Rotate when the file reaches this size. Default 2 MiB. */
  readonly maxBytes?: number;
  /** How many rotated files to keep (service.log.1 is the newest). Default 3. */
  readonly keep?: number;
  /** Also write each line to standard error. Default: only when it is a terminal. */
  readonly echo?: boolean;
  readonly now?: () => Date;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** One line of text with no control characters. */
export const oneLine = (text: string): string =>
  text.replace(CONTROL, " ").replace(/ {2,}/g, " ").trim();

function rotate(file: string, keep: number): void {
  rmSync(`${file}.${keep}`, { force: true });
  for (let index = keep - 1; index >= 1; index--)
    if (existsSync(`${file}.${index}`)) renameSync(`${file}.${index}`, `${file}.${index + 1}`);
  renameSync(file, `${file}.1`);
}

export function createLogger(options: LoggerOptions): Logger {
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const keep = options.keep ?? 3;
  const now = options.now ?? (() => new Date());
  const echo = options.echo ?? Boolean(process.stderr.isTTY);
  const write = (level: string, message: string, cause?: unknown) => {
    const lines = [`${now().toISOString()} ${level} ${oneLine(message)}`];
    if (cause instanceof Error) {
      lines[0] += `: ${oneLine(cause.message)}`;
      for (const frame of (cause.stack ?? "").split("\n").slice(1, 8))
        if (oneLine(frame)) lines.push(`  ${oneLine(frame)}`);
    } else if (cause !== undefined) lines[0] += `: ${oneLine(String(cause))}`;
    const text = `${lines.join("\n")}\n`;
    try {
      if (existsSync(options.file) && statSync(options.file).size >= maxBytes)
        rotate(options.file, keep);
      appendFileSync(options.file, text, { mode: 0o600 });
    } catch {
      // A log that cannot be written must never stop the service; the line still goes to the
      // terminal below when there is one.
    }
    if (echo) process.stderr.write(text);
  };
  return {
    info: (message) => write("info", message),
    warn: (message) => write("warn", message),
    error: (message, cause) => write("error", message, cause),
  };
}
