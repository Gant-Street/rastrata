import { WORKSPACE_ROLES } from "./agent/member.ts";
import { ApplicationError } from "./errors.ts";
import { ENTRY_TYPES } from "./journal-type.ts";
import {
  BUSINESS_PERMISSIONS,
  array,
  amountInput,
  code,
  date,
  hash,
  id,
  money,
  nullable,
  object,
  operation,
  page,
  ref,
  revision,
  role,
  signedMoney,
  text,
  version,
  type BusinessPermission,
  type OperationDefinition,
  type Schema,
} from "./schema-kit.ts";
import { sliceSchemas } from "./slices/catalog.ts";

export { ApplicationError, BUSINESS_PERMISSIONS };
export type { BusinessPermission, OperationDefinition, Schema };

export const APPLICATION_API_VERSION = "rastrata-application-v1";

/** A commit is authorized by its retained command kind, never by caller input. Slices add
 * the kinds of the prepared operations they create through `preparedPermissions`. */
const corePreparedPermissions: Readonly<Record<string, BusinessPermission>> = {
  createAccount: "configure",
  changeAccount: "configure",
  postDraft: "post",
  reverseJournal: "correct",
  closePeriod: "close",
  reopenPeriod: "close",
};

/** Merge named parts, refusing a name declared twice so two slices cannot silently shadow each other. */
function mergeUnique<T>(
  what: string,
  parts: readonly (readonly [string, Readonly<Record<string, T>>])[],
): Readonly<Record<string, T>> {
  const merged: Record<string, T> = {};
  const owner = new Map<string, string>();
  for (const [source, entries] of parts)
    for (const [key, value] of Object.entries(entries)) {
      if (Object.hasOwn(merged, key))
        throw new Error(`Duplicate ${what} ${key}: declared by ${owner.get(key)} and ${source}`);
      merged[key] = value;
      owner.set(key, source);
    }
  return merged;
}

/** The plan kinds the core operations create; their commit permissions are part of the first frozen contract. */
export const CORE_PREPARED_PERMISSIONS = corePreparedPermissions;

export const PREPARED_OPERATION_PERMISSIONS: Readonly<Record<string, BusinessPermission>> =
  mergeUnique("prepared operation kind", [
    ["core", corePreparedPermissions],
    ...sliceSchemas.map((slice) => [slice.name, slice.preparedPermissions ?? {}] as const),
  ]);

/** Read operations that need no configured book, declared by slices through `readsBeforeSetup`. */
export const READS_BEFORE_SETUP: ReadonlySet<string> = new Set(
  sliceSchemas.flatMap((slice) => slice.readsBeforeSetup ?? []),
);

/** Operations that write and still need no configured book, declared through `writesBeforeSetup`: the member
 * table, which the control plane fills before the owner sets the book up. */
export const WRITES_BEFORE_SETUP: ReadonlySet<string> = new Set(
  sliceSchemas.flatMap((slice) => slice.writesBeforeSetup ?? []),
);

/** Supported JSON Schema subset is deliberately small and exercised by tests.
 * These definitions are also emitted as the language-neutral client contract. */
const coreDefinitions: Readonly<Record<string, Schema>> = {
  Empty: object({}),
  InitialAccount: object(
    {
      code,
      name: { ...text(120), minLength: 1, pattern: "\\S" },
      role,
      parentCode: code,
      tags: ref("AccountTags"),
    },
    ["code", "name", "role"],
  ),
  BookSetup: object(
    {
      name: { ...text(120), minLength: 2, pattern: "\\S[\\s\\S]*\\S" },
      currency: { type: "string", enum: ["USD", "EUR", "GBP"] },
      // The calendar year in which the first fiscal year starts.
      fiscalYear: { type: "integer", minimum: 2000, maximum: 2100 },
      periodModel: { type: "string", enum: ["monthly", "quarterly"] },
      // 1 to 12; omitted means 1 (January). Fixed once the book exists.
      fiscalYearStartMonth: { type: "integer", minimum: 1, maximum: 12 },
      // Omitted means accrual. Fixed once the book exists.
      basis: { type: "string", enum: ["cash", "accrual"] },
      // The last fiscal year of the calendar; omitted means the fiscal year the book is created in.
      calendarThrough: { type: "integer", minimum: 2000, maximum: 2100 },
      // The day the books begin; omitted means the first day of the first fiscal year.
      booksStartOn: date,
      accounts: { ...array(ref("InitialAccount"), 200), minItems: 2 },
    },
    ["name", "currency", "fiscalYear", "periodModel", "accounts"],
  ),
  JournalLine: object({ accountId: id, debit: amountInput, credit: amountInput }),
  SourceEvent: object(
    {
      id,
      description: { ...text(1000), minLength: 1, pattern: "\\S" },
      evidenceReference: text(1000),
    },
    ["id", "description"],
  ),
  JournalDraftData: object(
    {
      date,
      reference: text(80),
      narration: text(1000),
      source: ref("SourceEvent"),
      lines: { ...array(ref("JournalLine"), 100), minItems: 2 },
    },
    ["date", "reference", "narration", "lines"],
  ),
  SavedDraft: object(
    {
      id,
      version,
      status: { type: "string", enum: ["draft", "posting", "rejected", "posted"] },
      data: ref("JournalDraftData"),
      journalId: id,
      postingOperationId: id,
      outcomeSequence: revision,
      recoveredFromOperationId: id,
    },
    ["id", "version", "status", "data"],
  ),
  DraftIdInput: object({ draftId: id }),
  DraftCreateInput: object({ data: ref("JournalDraftData") }),
  DraftSaveInput: object({ draftId: id, expectedVersion: version, data: ref("JournalDraftData") }),
  DraftVersionInput: object({ draftId: id, expectedVersion: version }),
  DraftRecoveryInput: object({ draftId: id, expectedVersion: version, postingOperationId: id }),
  PageInput: object({ page }, []),
  SourceGetInput: object({ sourceId: id, page }, ["sourceId"]),
  SourceListInput: object({ page, text: text(200) }, []),
  SourceSummary: object(
    {
      source: ref("SourceEvent"),
      contentHash: hash,
      journalId: id,
      bookRevision: revision,
      status: { type: "string", enum: ["unposted", "posting", "rejected", "posted"] },
      postingOperationId: id,
      outcomeSequence: revision,
    },
    ["source", "contentHash", "journalId", "bookRevision", "status"],
  ),
  SourceDraft: object({
    id,
    version,
    status: { type: "string", enum: ["draft", "posting", "rejected", "posted"] },
  }),
  SourceDraftPage: object({
    count: { type: "integer", minimum: 0 },
    page,
    pageSize: { type: "integer", minimum: 1 },
    drafts: array(ref("SourceDraft"), 25),
  }),
  SourceRecord: object(
    {
      source: ref("SourceEvent"),
      contentHash: hash,
      journalId: id,
      bookRevision: revision,
      status: { type: "string", enum: ["unposted", "posting", "rejected", "posted"] },
      postingOperationId: id,
      outcomeSequence: revision,
      drafts: ref("SourceDraftPage"),
      corrections: array(ref("Correction")),
    },
    ["source", "contentHash", "journalId", "bookRevision", "status", "drafts", "corrections"],
  ),
  SourcePage: object({
    count: { type: "integer", minimum: 0 },
    page,
    pageSize: { type: "integer", minimum: 1 },
    sources: array(ref("SourceSummary"), 25),
  }),
  AccountCreateInput: object(
    {
      code,
      name: { ...text(120), minLength: 1, pattern: "\\S" },
      role,
      parentId: id,
      effectiveOn: date,
    },
    ["code", "name", "role", "effectiveOn"],
  ),
  AccountChangeInput: object({
    accountId: id,
    name: { ...text(120), minLength: 1, pattern: "\\S" },
    close: { type: "boolean" },
    effectiveOn: date,
  }),
  ReverseInput: object({
    journalId: id,
    accountingDate: date,
    reason: { ...text(500), minLength: 1 },
  }),
  JournalQuery: object(
    {
      page,
      text: text(200),
      from: date,
      to: date,
      accountId: id,
      status: { type: "string", enum: ["Posted", "Draft"] },
      /** Where the entry came from: a bank statement or feed, Stripe, the opening balances, or typed in
       * by hand. A reversal is of the same type as the entry it reverses. */
      type: { type: "string", enum: [...ENTRY_TYPES] },
      revision,
    },
    [],
  ),
  JournalGetInput: object(
    { journalId: id, revision, asOf: date, populationHash: hash, reportFrom: date },
    ["journalId"],
  ),
  CommitInput: object({ planId: id, planHash: hash }),
  OperationInput: object({ operationId: id }),
  Money: money,
  AccountRow: object(
    {
      id,
      code: id,
      name: text(120),
      role,
      parentId: nullable(id),
      openedOn: date,
      closedOn: nullable(date),
      balance: signedMoney,
      tags: ref("AccountTags"),
    },
    ["id", "code", "name", "role", "parentId", "openedOn", "closedOn", "balance"],
  ),
  AccountList: object(
    {
      currency: text(3),
      configurationRevision: revision,
      suggestedEffectiveOn: date,
      accounts: array(ref("AccountRow")),
      tagsAsOf: date,
      tagsRevision: revision,
      tagsHash: hash,
    },
    ["currency", "configurationRevision", "suggestedEffectiveOn", "accounts"],
  ),
  DraftPage: object({
    count: { type: "integer", minimum: 0 },
    page,
    pageSize: { type: "integer", minimum: 1 },
    drafts: array(ref("SavedDraft"), 25),
  }),
  Problem: object({ code: text(200), message: text(2000) }),
  PlanWarning: object({ code: text(80), message: text(500) }),
  MutationReceipt: object({
    disposition: text(40),
    operationId: id,
    outcomeSequence: nullable(revision),
    diagnostics: array(text(2000)),
    problems: array(ref("Problem")),
  }),
  PreparedJournal: object({ id, date, narration: text(1000), lines: array(ref("JournalLine")) }),
  PreparedAccount: object({ id, code: id, name: text(120), closedOn: nullable(date) }),
  PreparedPeriod: object(
    {
      periodId: id,
      kind: text(80),
      reason: text(500),
      closePackageId: id,
      reportPopulationHash: hash,
      // For a reopening: the other periods whose closes it supersedes.
      supersededPeriodIds: array(id),
    },
    ["periodId", "kind", "reason"],
  ),
  PreparedEffects: object(
    {
      journals: array(ref("PreparedJournal")),
      accounts: array(ref("PreparedAccount")),
      periods: array(ref("PreparedPeriod")),
      // Periods a configuration change adds to the fiscal calendar (see slices/calendar).
      calendar: array(ref("PreparedCalendarPeriod")),
    },
    ["journals", "accounts", "periods"],
  ),
  PreparedOperation: object(
    {
      disposition: { type: "string", enum: ["prepared"] },
      operationId: id,
      outcomeSequence: nullable(revision),
      diagnostics: array(text(2000)),
      problems: array(ref("Problem")),
      /** Advisory notes from the lanes (a reversal of a reconciled line, a close with an
       * unreconciled bank account). Never blocks a commit and never changes `valid`. */
      warnings: array(ref("PlanWarning"), 50),
      planId: id,
      planHash: hash,
      bookRevision: revision,
      kind: text(80),
      valid: { type: "boolean" },
      effects: ref("PreparedEffects"),
    },
    [
      "disposition",
      "operationId",
      "outcomeSequence",
      "diagnostics",
      "problems",
      "planId",
      "planHash",
      "bookRevision",
      "kind",
      "valid",
      "effects",
    ],
  ),
  LedgerHead: object({ sequence: revision, chainHash: hash, bookRevision: revision }),
  AccessPrincipal: object(
    {
      kind: { type: "string", enum: ["owner", "token"] },
      tokenId: id,
      label: text(80),
      expiresAt: text(40),
    },
    ["kind"],
  ),
  /** A person of the book's workspace, as this book knows them. */
  MemberContext: object({ userId: id, role: { type: "string", enum: [...WORKSPACE_ROLES] } }),
  BookContext: object(
    {
      enabled: { type: "boolean" },
      bookId: id,
      setup: nullable(ref("BookSetup")),
      mode: text(40),
      permissions: array(text(40)),
      head: nullable(ref("LedgerHead")),
      /** Who this connection is: the owner, or an agent token with its label and expiry. Absent for a member, who is
       * described by `member` instead (a choice added to this enum would break a client that checks it), and for the
       * control plane. */
      principal: ref("AccessPrincipal"),
      /** Present when this connection is a member of the book's workspace: who they are and their role here. */
      member: ref("MemberContext"),
      /** `open`: any program on this computer can act as the owner without a token, so a token
       * bounds only an agent that uses it. `key`: the owner must present the owner key. */
      ownerAccess: { type: "string", enum: ["open", "key"] },
      /** How the app shows things and what accepting a suggestion does (see `book.update`). Present
       * once the book is set up. Product state: nothing in the ledger depends on it. */
      settings: ref("BookSettings"),
    },
    ["enabled", "bookId", "setup", "mode", "permissions", "head"],
  ),
  SetupResult: object({ setup: ref("BookSetup"), outcomeSequence: revision }),
  DiscardResult: object({ disposition: { type: "string", enum: ["discarded"] }, draftId: id }),
  Correction: object(
    {
      kind: text(40),
      originalJournalId: id,
      correctionJournalId: id,
      /** The numbers of the two entries ("No. 23"), so a screen can say "Reversed by No. 29" without
       * reading the other entry. */
      originalPostingSequence: revision,
      correctionPostingSequence: revision,
    },
    ["kind", "originalJournalId", "correctionJournalId"],
  ),
  EntryLine: object(
    {
      id,
      accountId: id,
      account: text(200),
      debit: signedMoney,
      credit: signedMoney,
      /** The account's code and name on their own; `account` is the two together. */
      code: id,
      name: text(120),
    },
    ["id", "accountId", "account", "debit", "credit"],
  ),
  JournalSource: object({ id, contentHash: hash, originalJournalId: id }),
  JournalEntry: object(
    {
      id,
      kind: text(40),
      date,
      narration: text(2000),
      recordedAt: text(80),
      postingSequence: revision,
      bookRevision: revision,
      viewedAtRevision: revision,
      currency: text(3),
      correction: nullable(ref("Correction")),
      source: ref("JournalSource"),
      lines: array(ref("EntryLine")),
    },
    [
      "id",
      "kind",
      "date",
      "narration",
      "recordedAt",
      "postingSequence",
      "bookRevision",
      "viewedAtRevision",
      "currency",
      "correction",
      "lines",
    ],
  ),
  OperationStatus: object(
    {
      operationId: id,
      kind: text(80),
      disposition: {
        type: "string",
        enum: ["prepared", "unresolved", "completed", "committed", "rejected"],
      },
      outcomeSequence: revision,
      diagnostics: array(text(2000)),
      problems: array(ref("Problem")),
      planHash: hash,
      result: {},
    },
    ["operationId", "kind", "disposition"],
  ),
  OperationDefinition: object({
    name: text(100),
    description: text(2000),
    permission: text(40),
    writes: { type: "boolean" },
    input: {},
    output: {},
  }),
  Capabilities: object(
    {
      version: text(100),
      bookId: id,
      currencies: array(text(3)),
      // The bases a new book can be set up on.
      bases: array(text(40)),
      periodModels: array(text(40)),
      pageSize: { type: "integer", minimum: 1 },
      permissions: array(text(40)),
      operations: array(ref("OperationDefinition")),
      // The configured book's own basis and fiscal year start month; absent before setup.
      basis: { type: "string", enum: ["cash", "accrual"] },
      fiscalYearStartMonth: { type: "integer", minimum: 1, maximum: 12 },
    },
    [
      "version",
      "bookId",
      "currencies",
      "bases",
      "periodModels",
      "pageSize",
      "permissions",
      "operations",
    ],
  ),
  AccountChoice: object(
    {
      value: id,
      label: text(200),
      path: id,
      group: role,
      disabled: { type: "boolean" },
      reason: text(120),
      /** The account's code and its name on their own: `label` is the two together. A list names an
       * account by its name and keeps the code for the places that need it. */
      code: id,
      name: text(120),
    },
    ["value", "label", "path", "group"],
  ),
  RegisterLine: object({
    id,
    accountId: id,
    debit: nullable(signedMoney),
    credit: nullable(signedMoney),
  }),
  RegisterHistory: object({ at: text(80), description: text(2000) }),
  RegisterEntry: object(
    {
      id,
      date,
      isoDate: date,
      reference: text(2000),
      amount: text(100),
      status: { type: "string", enum: ["Posted", "Draft"] },
      lines: array(ref("RegisterLine")),
      debitTotal: text(100),
      creditTotal: text(100),
      history: array(ref("RegisterHistory")),
      /** The entry's number in the book: its posting sequence, so a person can say "No. 23" and not read
       * out an identifier. Posted entries only; a draft has none until it is posted. */
      postingSequence: revision,
      /** What the entry is about, in words: its narration (a draft's narration, or its reference when
       * it has none). `reference` is the short name a person gave it. */
      description: text(2000),
      /** Where the entry came from (see the `type` filter of `journal.list`). */
      type: { type: "string", enum: [...ENTRY_TYPES] },
    },
    [
      "id",
      "date",
      "isoDate",
      "reference",
      "amount",
      "status",
      "lines",
      "debitTotal",
      "creditTotal",
      "history",
    ],
  ),
  RegisterScope: object({
    revision,
    asOf: date,
    populationHash: hash,
    basis: text(40),
    currency: text(3),
    compilerVersion: text(80),
  }),
  RegisterContext: object({
    bookName: text(120),
    currency: text(3),
    description: text(200),
    savedMessage: text(200),
  }),
  DraftSummary: object({ id, version, status: text(40) }),
  JournalPage: object({
    head: ref("LedgerHead"),
    scope: ref("RegisterScope"),
    context: ref("RegisterContext"),
    accounts: array(ref("AccountChoice")),
    entries: array(ref("RegisterEntry"), 25),
    count: { type: "integer", minimum: 0 },
    page,
    pageSize: { type: "integer", minimum: 1 },
    drafts: array(ref("DraftSummary"), 25),
    corrections: array(ref("Correction")),
  }),
};

/** Every definition, core first and then each slice in registry order. */
export const definitions: Readonly<Record<string, Schema>> = mergeUnique("definition", [
  ["core", coreDefinitions],
  ...sliceSchemas.map((slice) => [slice.name, slice.definitions] as const),
]);

const coreOperations: readonly OperationDefinition[] = [
  operation(
    "book.get",
    "Inspect the configured book, connection scope and current revision.",
    "read",
    "Empty",
    false,
    "BookContext",
  ),
  operation(
    "book.setup",
    "Initialize the local book with an explicit fiscal calendar and starting chart.",
    "provision",
    "BookSetup",
    true,
    "SetupResult",
  ),
  operation(
    "capabilities.get",
    "Discover supported workflows, currencies, basis and request contracts.",
    "read",
    "Empty",
    false,
    "Capabilities",
  ),
  operation(
    "accounts.list",
    "List accounts, balances and suggested effective date.",
    "read",
    "Empty",
    false,
    "AccountList",
  ),
  operation(
    "accounts.prepareCreate",
    "Prepare and review a new account before changing the chart.",
    "configure",
    "AccountCreateInput",
    true,
    "PreparedOperation",
  ),
  operation(
    "accounts.prepareChange",
    "Prepare an account rename or closure under existing accounting rules.",
    "configure",
    "AccountChangeInput",
    true,
    "PreparedOperation",
  ),
  operation(
    "sources.get",
    "Inspect a retained source event, its drafts, posting and immutable corrections.",
    "read",
    "SourceGetInput",
    false,
    "SourceRecord",
  ),
  operation(
    "sources.list",
    "Page retained source events and their posting status.",
    "read",
    "SourceListInput",
    false,
    "SourcePage",
  ),
  operation(
    "drafts.list",
    "Page saved drafts that have not completed posting.",
    "read",
    "PageInput",
    false,
    "DraftPage",
  ),
  operation(
    "drafts.get",
    "Inspect one draft including its version and posting status.",
    "read",
    "DraftIdInput",
    false,
    "SavedDraft",
  ),
  operation(
    "drafts.create",
    "Save a new journal draft without changing posted balances.",
    "draft",
    "DraftCreateInput",
    true,
    "SavedDraft",
  ),
  operation(
    "drafts.save",
    "Edit a saved draft using its expected version.",
    "draft",
    "DraftSaveInput",
    true,
    "SavedDraft",
  ),
  operation(
    "drafts.recover",
    "Reopen a durably rejected posting for editing at a new draft version. Preserve the rejected operation; prepare and review a new posting before committing. Unresolved or committed postings cannot be reopened.",
    "draft",
    "DraftRecoveryInput",
    true,
    "SavedDraft",
  ),
  operation(
    "drafts.discard",
    "Discard an editable draft using its expected version.",
    "draft",
    "DraftVersionInput",
    true,
    "DiscardResult",
  ),
  operation(
    "journal.prepare",
    "Validate a draft and prepare its exact posting effects without posting.",
    "post",
    "DraftVersionInput",
    true,
    "PreparedOperation",
  ),
  operation(
    "journal.list",
    "Filter and page journals at an explicit or newly pinned book revision. The corrections listed are the ones that name an entry of the page.",
    "read",
    "JournalQuery",
    false,
    "JournalPage",
  ),
  operation(
    "journal.get",
    "Inspect a journal and its immutable correction relationships.",
    "read",
    "JournalGetInput",
    false,
    "JournalEntry",
  ),
  operation(
    "journal.prepareReverse",
    "Prepare an immutable reversal with an explicit accounting date and reason.",
    "correct",
    "ReverseInput",
    true,
    "PreparedOperation",
  ),
  operation(
    "operations.get",
    "Look up a retained operation after success, rejection or an interrupted request.",
    "read",
    "OperationInput",
    false,
    "OperationStatus",
  ),
  operation(
    "operations.commit",
    "Submit the exact prepared operation; its recorded kind determines the required permission.",
    "post",
    "CommitInput",
    true,
    "MutationReceipt",
  ),
];

/** Every operation, core first and then each slice in registry order. Names are unique. */
export const operationCatalog: readonly OperationDefinition[] = (() => {
  const seen = new Map<string, string>();
  const all: OperationDefinition[] = [];
  for (const [source, operations] of [
    ["core", coreOperations] as const,
    ...sliceSchemas.map((slice) => [slice.name, slice.operations] as const),
  ])
    for (const item of operations) {
      if (seen.has(item.name))
        throw new Error(
          `Duplicate operation ${item.name}: declared by ${seen.get(item.name)} and ${source}`,
        );
      seen.set(item.name, source);
      all.push(item);
    }
  return all;
})();

/** Whether a caller holding `permissions` may call `operation`. A commit is authorized by its
 * retained plan's kind, so here it is allowed if any prepared kind is; the plan itself is checked
 * again when it is committed. */
export function permitsOperation(
  permissions: readonly BusinessPermission[],
  operation: OperationDefinition,
): boolean {
  return operation.name === "operations.commit"
    ? Object.values(PREPARED_OPERATION_PERMISSIONS).some((permission) =>
        permissions.includes(permission),
      )
    : permissions.includes(operation.permission);
}

export const applicationSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://rastrata.invalid/schema/application-v1",
  version: APPLICATION_API_VERSION,
  $defs: definitions,
  operations: operationCatalog,
  /** The permission needed to commit each kind of prepared action. Part of the contract: a plan's
   * kind decides who may commit it. */
  preparedPermissions: PREPARED_OPERATION_PERMISSIONS,
};

export function validateSchema(value: unknown, schema: Schema, path = "input"): void {
  if (schema.anyOf) {
    for (const variant of schema.anyOf) {
      try {
        validateSchema(value, variant, path);
        return;
      } catch (error) {
        if (!(error instanceof ApplicationError)) throw error;
      }
    }
    throw new ApplicationError("invalid_input", "Value does not match a supported schema", 400, [
      { path, message: "Unsupported value type" },
    ]);
  }
  if (schema.$ref) {
    const definition = definitions[schema.$ref.slice("#/$defs/".length)];
    if (!definition) throw new Error("Unknown schema reference");
    validateSchema(value, definition, path);
    return;
  }
  const fail = (message: string): never => {
    throw new ApplicationError(
      "invalid_input",
      "Request does not match the operation schema",
      400,
      [{ path, message }],
    );
  };
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("Expected an object");
    const data = value as Record<string, unknown>;
    for (const required of schema.required ?? [])
      if (!Object.hasOwn(data, required)) fail(`Missing ${required}`);
    for (const [key, child] of Object.entries(data)) {
      const field = Object.hasOwn(schema.properties ?? {}, key)
        ? schema.properties?.[key]
        : undefined;
      if (!field) {
        if (schema.additionalProperties !== true) fail(`Unknown field ${key}`);
      } else validateSchema(child, field, `${path}.${key}`);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) fail("Expected an array");
    const data = value as unknown[];
    if (
      data.length < (schema.minItems ?? 0) ||
      data.length > (schema.maxItems ?? Number.MAX_SAFE_INTEGER)
    )
      fail("Array length is outside the supported range");
    if (schema.items)
      for (const [index, child] of data.entries())
        validateSchema(child, schema.items, `${path}[${index}]`);
  } else if (schema.type === "string") {
    if (typeof value !== "string") fail("Expected a string");
    const data = value as string;
    if (
      data.length < (schema.minLength ?? 0) ||
      data.length > (schema.maxLength ?? Number.MAX_SAFE_INTEGER)
    )
      fail("String length is outside the supported range");
    if (schema.pattern && !new RegExp(schema.pattern).test(data))
      fail("Value has an unsupported format");
  } else if (schema.type === "integer") {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < (schema.minimum ?? Number.MIN_SAFE_INTEGER) ||
      value > (schema.maximum ?? Number.MAX_SAFE_INTEGER)
    )
      fail("Expected an integer in the supported range");
  } else if (schema.type === "boolean" && typeof value !== "boolean") fail("Expected a boolean");
  if (schema.type === "null" && value !== null) fail("Expected null");
  if (schema.enum && !schema.enum.some((item) => item === value))
    fail("Value is not a supported choice");
}
