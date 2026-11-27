import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  APPLICATION_API_VERSION,
  definitions,
  operationCatalog,
  type OperationDefinition,
  type Schema,
} from "@rastrata/application/schema";
import type { ApplicationClient } from "./client.ts";
import { sliceToolMetadata } from "./tool-metadata/index.ts";
import { isHidden, type OperationMetadata, type ToolMetadata } from "./tool-metadata/types.ts";

export const operationIdSchema: Schema = {
  type: "string",
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
};

/** Inline the canonical schema so clients need no application-specific $ref resolver. */
export function inlineSchema(schema: Schema): Schema {
  if (schema.$ref) {
    const definition = definitions[schema.$ref.slice("#/$defs/".length)];
    if (!definition) throw new Error("Unknown application schema reference");
    return inlineSchema(definition);
  }
  return {
    ...schema,
    ...(schema.properties
      ? {
          properties: Object.fromEntries(
            Object.entries(schema.properties).map(([key, child]) => [key, inlineSchema(child)]),
          ),
        }
      : {}),
    ...(schema.items ? { items: inlineSchema(schema.items) } : {}),
    ...(schema.anyOf ? { anyOf: schema.anyOf.map(inlineSchema) } : {}),
  };
}

const coreMetadata: Readonly<Record<string, ToolMetadata>> = {
  "book.get": {
    name: "rastrata_get_book",
    title: "Inspect Rastrata book",
    description:
      "Start here: inspect the connected book, fiscal calendar, currency, granted MCP permissions and current revision. This connection has one fixed book.",
  },
  "book.setup": {
    name: "rastrata_setup_book",
    title: "Set up a book",
    description:
      "Initialize an unconfigured book using the user's chosen name, currency, fiscal year (the calendar year in which the first fiscal year starts), fiscalYearStartMonth (1 to 12, default 1), accounting basis (cash or accrual, default accrual), period model and chart. The basis, start month and period model cannot be changed afterwards, and the book's first period cannot be moved earlier; later years are added with the calendar tools. This writes immediately and cannot reset an existing book. Obtain authorization for these exact settings first.",
    destructive: true,
  },
  "capabilities.get": {
    name: "rastrata_get_capabilities",
    title: "Inspect supported workflows",
    description:
      "Discover the supported accounting workflows and schemas available to this connection, including the bases a new book can use and, once a book is configured, its own basis and fiscal year start month. The initial app supports manual bookkeeping; invoicing, bank feeds, payroll and tax filing are not available.",
  },
  "accounts.list": {
    name: "rastrata_list_accounts",
    title: "List chart of accounts",
    description:
      "Read the chart, balances and suggested effective date. Use returned account IDs in journal lines; never invent account IDs.",
  },
  "accounts.prepareCreate": {
    name: "rastrata_prepare_account",
    title: "Preview a new account",
    description:
      "Prepare an account with code, name, accounting role and effective date. Returns an immutable plan and diagnostics; no account is added until commit.",
  },
  "accounts.prepareChange": {
    name: "rastrata_prepare_account_change",
    title: "Preview an account change",
    description:
      "Prepare an account rename or closure. Review the effects and diagnostics before committing; closed accounts remain in accounting history.",
  },
  "drafts.list": {
    name: "rastrata_list_drafts",
    title: "List journal drafts",
    description:
      "Read saved drafts and their versions/statuses. Results are paginated; a draft is not a posted journal.",
  },
  "sources.get": {
    name: "rastrata_get_source",
    title: "Inspect a source event",
    description:
      "Inspect immutable source facts, linked drafts, posting operation and reversals before booking an event. A posted or uncertain source must not be submitted under another ID.",
  },
  "sources.list": {
    name: "rastrata_list_sources",
    title: "List source events",
    description:
      "Search and page retained source events and their posting status. Display references are freeform and do not prevent duplicate booking.",
  },
  "drafts.get": {
    name: "rastrata_get_draft",
    title: "Inspect a journal draft",
    description:
      "Read a saved draft before editing or preparing it. Use its returned version for optimistic concurrency.",
  },
  "drafts.create": {
    name: "rastrata_create_draft",
    title: "Save a journal draft",
    description:
      "Save a journal proposal without posting. Use exact decimal strings such as 25.00 and an empty string for the unused side. Supply source with a stable, book-scoped event ID and immutable source description/evidence reference; inspect that source before creating a second proposal. The display reference is freeform. Untagged drafts have no source duplicate protection.",
  },
  "drafts.save": {
    name: "rastrata_save_draft",
    title: "Edit a journal draft",
    description:
      "Save edits to a draft with its expected version. If the draft changed, reread and reconcile the edit rather than overwriting another writer.",
    destructive: true,
  },
  "drafts.discard": {
    name: "rastrata_discard_draft",
    title: "Discard a journal draft",
    description:
      "Delete an unposted draft at its expected version. This never deletes a posted journal.",
    destructive: true,
  },
  "drafts.recover": {
    name: "rastrata_recover_draft",
    title: "Recover a rejected journal draft",
    description:
      "Reopen the same draft for editing only after its original posting has a durable rejected outcome. Supply the draft's version and postingOperationId. The rejected operation remains immutable and inspectable. Use the returned new version, prepare a new posting identity, inspect its effects and obtain authorization before commit. Never recover an unresolved or committed posting.",
    destructive: true,
  },
  "journal.prepare": {
    name: "rastrata_prepare_journal",
    title: "Preview a journal posting",
    description:
      "Validate a saved draft at its expected version and retain an immutable posting plan. Inspect valid, problems, effects, planId and planHash. Preparing makes no posted financial change.",
  },
  "journal.list": {
    name: "rastrata_list_journals",
    title: "Search journal register",
    description:
      "Search journal entries by reference/text, date, account and status. Follow count/page/pageSize and pin revision for subsequent pages. Search sources before proposing another entry; references are not unique.",
  },
  "journal.get": {
    name: "rastrata_get_journal",
    title: "Inspect a posted journal",
    description:
      "Read journal lines and correction links. For report drill-through retain revision, asOf and populationHash together.",
  },
  "journal.prepareReverse": {
    name: "rastrata_prepare_reversal",
    title: "Preview a linked reversal",
    description:
      "Prepare a reversal of a posted journal with an explicit accounting date and reason. Review and authorize its effects before commit. The original remains immutable.",
  },
  "operations.get": {
    name: "rastrata_get_operation",
    title: "Recover an operation",
    description:
      "Inspect an original operation identity after success, rejection or a lost response. Prepared is not posted; unresolved is not failure; operation_not_found is not permission to duplicate an economic event.",
  },
  "operations.commit": {
    name: "rastrata_commit_operation",
    title: "Commit a reviewed accounting plan",
    description:
      "Submit the exact planId and planHash returned by a prepare tool after review and user authorization. This changes the books. Reuse that same pair on retries. The retained plan kind determines required permission, and stale plans are rejected.",
    destructive: true,
  },
};

/** Every operation needs an entry: the core table above, or the lane that added it under tool-metadata/. */
const metadata: Readonly<Record<string, OperationMetadata>> = {
  ...coreMetadata,
  ...sliceToolMetadata,
};

/** Operations that deliberately have no tool (see HiddenOperation), by operation name. */
export const hiddenOperations: ReadonlySet<string> = new Set(
  operationCatalog
    .filter((operation) => {
      const entry = metadata[operation.name];
      return entry !== undefined && isHidden(entry);
    })
    .map((operation) => operation.name),
);

export const NEW_OPERATION_TOOL: Tool = {
  name: "rastrata_new_operation_id",
  title: "Obtain a durable operation identity",
  description:
    "Obtain a UUID once before a new write or prepare. Retain it as operationId, and reuse it with the exact same tool/input on retries. A new UUID is for a new operation, never recovery. This does not reserve or change accounting state.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: {
    type: "object",
    properties: { operationId: operationIdSchema },
    required: ["operationId"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
};

export const BOOKKEEPING_GUIDE_TOOL: Tool = {
  name: "rastrata_get_bookkeeping_guide",
  title: "Read Rastrata bookkeeping guidance",
  description:
    "Read the bundled bookkeeping workflow before recording or correcting an event. Covers supported workflows, exact money, previews, authorization, duplicate-source review, durable recovery and report scope.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: {
    type: "object",
    properties: {
      uri: { type: "string" },
      text: { type: "string" },
      digest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
    },
    required: ["uri", "text", "digest"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

/** What a model reads about an operation: a deprecation notice first, then what the lane wrote,
 * then the retry rule for writes. */
export function toolDescription(
  operation: Pick<OperationDefinition, "deprecated">,
  description: string,
  needsId: boolean,
): string {
  return (
    (operation.deprecated ? `Deprecated: ${operation.deprecated} ` : "") +
    description +
    (needsId ? " Retain operationId and reuse it with identical input on retries." : "")
  );
}

export interface MappedTool {
  readonly tool: Tool;
  readonly operation: OperationDefinition;
  readonly input: Schema;
}

export function mappedTools(): readonly MappedTool[] {
  return operationCatalog.flatMap((operation): MappedTool[] => {
    const item = metadata[operation.name];
    if (!item) throw new Error(`Missing MCP metadata for ${operation.name}`);
    if (isHidden(item)) return [];
    const shape = inlineSchema(operation.input);
    const needsId = operation.writes && operation.name !== "operations.commit";
    const input: Schema = {
      ...shape,
      ...(needsId
        ? {
            properties: { ...shape.properties, operationId: operationIdSchema },
            required: [...(shape.required ?? []), "operationId"],
          }
        : {}),
    };
    return [
      {
        operation,
        input,
        tool: {
          name: item.name,
          title: item.title,
          description: toolDescription(operation, item.description, needsId),
          inputSchema: input as Tool["inputSchema"],
          outputSchema: {
            type: "object",
            properties: {
              version: { type: "string", enum: [APPLICATION_API_VERSION] },
              bookId: { type: "string" },
              ok: { type: "boolean", enum: [true] },
              data: inlineSchema(operation.output),
              operationId: operationIdSchema,
            },
            required: [
              "version",
              "bookId",
              "ok",
              "data",
              ...(operation.writes ? ["operationId"] : []),
            ],
            additionalProperties: false,
          },
          annotations: {
            readOnlyHint: !operation.writes,
            destructiveHint: item.destructive ?? false,
            idempotentHint: operation.writes,
            openWorldHint: false,
          },
        },
      },
    ];
  });
}

export function availableTools(client: ApplicationClient, mapped: readonly MappedTool[]): Tool[] {
  return [
    ...mapped.filter((item) => client.allows(item.operation)).map((item) => item.tool),
    NEW_OPERATION_TOOL,
    BOOKKEEPING_GUIDE_TOOL,
  ];
}
