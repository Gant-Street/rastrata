/** The business name and the display settings: product state, never ledger facts.
 *
 * Nothing in the books depends on any of it. The name lives in the stored setup (see
 * `ApplicationService.renameBook`) so reports, exports and the header read one name; the display
 * settings (how a date is written, whether lists show account numbers, what accepting a suggestion
 * does) live in a small table of their own. Every change is recorded with who made it, so a rename
 * can be traced. */
import type {
  BookSettings,
  BookUpdateInput,
  BookUpdateResult,
} from "../../client-contracts.gen.ts";
import { ApplicationError } from "../../errors.ts";
import { sanitizeText } from "../../ingest/text.ts";
import type { ApplicationService } from "../../service.ts";
import type { ApplicationStore } from "../../storage.ts";
import { ACCEPT_MODES, DATE_FORMATS } from "./schema.ts";
import { entriesStore } from "./store.ts";

export const DEFAULT_SETTINGS: BookSettings = {
  dateFormat: "medium",
  showAccountNumbers: false,
  acceptMode: "post",
};

function settingsStore(service: ApplicationService): ApplicationStore {
  return entriesStore(service);
}

const oneOf = <T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T => allowed.find((item) => item === value) ?? fallback;

/** The settings as stored, with the default for anything never set (or set by a release that knew
 * more choices than this one). */
export function readBookSettings(service: ApplicationService): BookSettings {
  const rows = settingsStore(service).query("SELECT key, value FROM app_book_settings").all() as {
    key: string;
    value: string;
  }[];
  const saved = new Map(rows.map((row) => [row.key, row.value]));
  return {
    dateFormat: oneOf(saved.get("dateFormat"), DATE_FORMATS, DEFAULT_SETTINGS.dateFormat),
    showAccountNumbers: saved.has("showAccountNumbers")
      ? saved.get("showAccountNumbers") === "true"
      : DEFAULT_SETTINGS.showAccountNumbers,
    acceptMode: oneOf(saved.get("acceptMode"), ACCEPT_MODES, DEFAULT_SETTINGS.acceptMode),
  };
}

/** `book.update`: rename the business and change the display settings in one retained step. A
 * request that asks for what is already so changes nothing and says so (`changed` is empty). */
export function updateBook(
  service: ApplicationService,
  input: BookUpdateInput,
  operationId: string,
  principal: string,
): BookUpdateResult {
  if (
    input.name === undefined &&
    input.dateFormat === undefined &&
    input.showAccountNumbers === undefined &&
    input.acceptMode === undefined
  )
    throw new ApplicationError(
      "invalid_input",
      "Give something to change: name, dateFormat, showAccountNumbers or acceptMode.",
    );
  // A name is one line of plain text: no control or direction-changing characters, no runs of space.
  const name = input.name === undefined ? undefined : sanitizeText(input.name, 120);
  if (name !== undefined && name.length < 2)
    throw new ApplicationError("invalid_input", "A business name needs at least two characters.");
  const store = settingsStore(service);
  return service.retainRequest(operationId, "book.update", input, () => {
    const setup = service.setupState();
    if (!setup) throw new ApplicationError("book_not_configured", "Book is not configured", 409);
    const now = service.now();
    const changed: string[] = [];
    const record = (setting: string, before: string | null, after: string) =>
      store
        .query(
          "INSERT INTO app_book_changes (at, actor, setting, before, after) VALUES (?, ?, ?, ?, ?)",
        )
        .run(now, principal, setting, before, after);
    let previousName: string | null = null;
    if (name !== undefined && name !== setup.name) {
      previousName = service.renameBook(name);
      record("name", previousName, name);
      changed.push("name");
    }
    const current = readBookSettings(service);
    const wanted: Record<keyof BookSettings, string | undefined> = {
      dateFormat: input.dateFormat,
      showAccountNumbers:
        input.showAccountNumbers === undefined ? undefined : String(input.showAccountNumbers),
      acceptMode: input.acceptMode,
    };
    for (const key of Object.keys(wanted) as (keyof BookSettings)[]) {
      const next = wanted[key];
      if (next === undefined || next === String(current[key])) continue;
      store
        .query(
          "INSERT INTO app_book_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(key, next);
      record(key, String(current[key]), next);
      changed.push(key);
    }
    return {
      name: service.setupState()?.name ?? setup.name,
      settings: readBookSettings(service),
      changed,
      previousName,
    };
  });
}
