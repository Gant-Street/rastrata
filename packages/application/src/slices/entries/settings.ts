/** The business name and the display settings: product state, never ledger facts.
 *
 * Nothing in the books depends on any of it. The name lives in the stored setup (see
 * `ApplicationService.renameBook`) so reports, exports and the header read one name; the display
 * settings (how a date is written, whether lists show account numbers, what accepting a suggestion
 * does) live in a small table of their own. Every change is recorded with who made it, so a rename
 * can be traced. */
import type {
  BookEntityProfile,
  BookSettings,
  BookUpdateInput,
  BookUpdateResult,
  EntityAddress,
} from "../../client-contracts.gen.ts";
import { ApplicationError } from "../../errors.ts";
import { sanitizeText } from "../../ingest/text.ts";
import type { ApplicationService } from "../../service.ts";
import type { ApplicationStore } from "../../storage.ts";
import { ACCEPT_MODES, DATE_FORMATS, ENTITY_TYPES } from "./schema.ts";
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

const EIN_PATTERN = /^\d{2}-?\d{7}$/;
const STATE_PATTERN = /^[A-Za-z]{2}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

function normalizeAddress(raw: EntityAddress | null | undefined): EntityAddress | null {
  if (raw === null || raw === undefined) return null;
  const line1 = raw.line1 !== undefined ? sanitizeText(raw.line1, 200) : "";
  const line2 = raw.line2 !== undefined ? sanitizeText(raw.line2, 200) : "";
  const city = raw.city !== undefined ? sanitizeText(raw.city, 120) : "";
  const state = raw.state !== undefined ? sanitizeText(raw.state, 40) : "";
  const postalCode = raw.postalCode !== undefined ? sanitizeText(raw.postalCode, 20) : "";
  const country = raw.country !== undefined ? sanitizeText(raw.country, 2).toUpperCase() : "";
  if (country !== "" && !STATE_PATTERN.test(country))
    throw new ApplicationError(
      "invalid_input",
      "Country must be a 2-letter code (for example US).",
    );
  const clean: Record<string, string> = {};
  if (line1 !== "") clean.line1 = line1;
  if (line2 !== "") clean.line2 = line2;
  if (city !== "") clean.city = city;
  if (state !== "") clean.state = state;
  if (postalCode !== "") clean.postalCode = postalCode;
  if (country !== "") clean.country = country;
  return Object.keys(clean).length > 0 ? (clean as EntityAddress) : null;
}

function normalizeEntity(
  current: BookEntityProfile | undefined,
  patch: BookEntityProfile,
): BookEntityProfile | undefined {
  const base: BookEntityProfile = current ?? {};
  const next: Record<string, unknown> = { ...base };
  if (patch.legalName !== undefined) {
    if (patch.legalName === null) delete next.legalName;
    else {
      const cleaned = sanitizeText(patch.legalName, 200);
      if (cleaned === "") delete next.legalName;
      else next.legalName = cleaned;
    }
  }
  if (patch.ein !== undefined) {
    if (patch.ein === null) delete next.ein;
    else {
      const trimmed = patch.ein.trim();
      if (!EIN_PATTERN.test(trimmed))
        throw new ApplicationError("invalid_input", "EIN must be nine digits (XX-XXXXXXX).");
      const digits = trimmed.replace("-", "");
      next.ein = `${digits.slice(0, 2)}-${digits.slice(2)}`;
    }
  }
  if (patch.entityType !== undefined) {
    if (patch.entityType === null) delete next.entityType;
    else if (!(ENTITY_TYPES as readonly string[]).includes(patch.entityType))
      throw new ApplicationError("invalid_input", "Entity type is not recognised.");
    else next.entityType = patch.entityType;
  }
  if (patch.formationState !== undefined) {
    if (patch.formationState === null) delete next.formationState;
    else {
      const state = patch.formationState.trim().toUpperCase();
      if (!STATE_PATTERN.test(state))
        throw new ApplicationError(
          "invalid_input",
          "Formation state must be a 2-letter US state code.",
        );
      next.formationState = state;
    }
  }
  if (patch.address !== undefined) {
    const addr = normalizeAddress(patch.address);
    if (addr === null) delete next.address;
    else next.address = addr;
  }
  if (patch.contactEmail !== undefined) {
    if (patch.contactEmail === null) delete next.contactEmail;
    else {
      const email = patch.contactEmail.trim().toLowerCase();
      if (!EMAIL_PATTERN.test(email) || email.length > 254)
        throw new ApplicationError("invalid_input", "Contact email must be a valid email address.");
      next.contactEmail = email;
    }
  }
  return Object.keys(next).length > 0 ? (next as BookEntityProfile) : undefined;
}

function parseStoredEntity(raw: string | undefined): BookEntityProfile | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as BookEntityProfile;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return Object.keys(parsed).length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The settings as stored, with the default for anything never set (or set by a release that knew
 * more choices than this one). */
export function readBookSettings(service: ApplicationService): BookSettings {
  const rows = settingsStore(service).query("SELECT key, value FROM app_book_settings").all() as {
    key: string;
    value: string;
  }[];
  const saved = new Map(rows.map((row) => [row.key, row.value]));
  const entity = parseStoredEntity(saved.get("entity"));
  return {
    dateFormat: oneOf(saved.get("dateFormat"), DATE_FORMATS, DEFAULT_SETTINGS.dateFormat),
    showAccountNumbers: saved.has("showAccountNumbers")
      ? saved.get("showAccountNumbers") === "true"
      : DEFAULT_SETTINGS.showAccountNumbers,
    acceptMode: oneOf(saved.get("acceptMode"), ACCEPT_MODES, DEFAULT_SETTINGS.acceptMode),
    ...(entity ? { entity } : {}),
  };
}

/** `book.update`: rename the business and change the display settings or legal entity profile in one retained step. A
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
    input.acceptMode === undefined &&
    input.entity === undefined
  )
    throw new ApplicationError(
      "invalid_input",
      "Give something to change: name, dateFormat, showAccountNumbers, acceptMode or entity.",
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
    const wanted: Record<"dateFormat" | "showAccountNumbers" | "acceptMode", string | undefined> = {
      dateFormat: input.dateFormat,
      showAccountNumbers:
        input.showAccountNumbers === undefined ? undefined : String(input.showAccountNumbers),
      acceptMode: input.acceptMode,
    };
    for (const key of Object.keys(wanted) as (
      | "dateFormat"
      | "showAccountNumbers"
      | "acceptMode"
    )[]) {
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
    if (input.entity !== undefined) {
      const nextEntity = normalizeEntity(current.entity, input.entity);
      const beforeJson = current.entity ? JSON.stringify(current.entity) : "";
      const afterJson = nextEntity ? JSON.stringify(nextEntity) : "";
      if (afterJson !== beforeJson) {
        if (nextEntity === undefined)
          store.query("DELETE FROM app_book_settings WHERE key = 'entity'").run();
        else
          store
            .query(
              "INSERT INTO app_book_settings (key, value) VALUES ('entity', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            )
            .run(afterJson);
        record("entity", beforeJson || null, afterJson);
        changed.push("entity");
      }
    }
    return {
      name: service.setupState()?.name ?? setup.name,
      settings: readBookSettings(service),
      changed,
      previousName,
    };
  });
}
