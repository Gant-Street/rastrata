import { ApplicationError } from "../../errors.ts";
import { operationCatalog, permitsOperation, validateSchema } from "../../schema.ts";
import type { SliceContext } from "../types.ts";

/** Call another lane's operation from inside this one, the way a client would: by its published
 * name, with the caller's own permissions, the input checked against its contract and the answer
 * checked against its contract. The shadow lane reads reconciliation, backups, periods, the Inbox
 * and Stripe this way and never reaches into their tables.
 *
 * A failure is the other operation's own `ApplicationError`; the caller decides what a section it
 * could not read means. */
export async function callOperation<T>(
  context: SliceContext,
  name: string,
  input: Record<string, unknown> = {},
  operationId = "",
): Promise<T> {
  const definition = operationCatalog.find((item) => item.name === name);
  if (!definition) throw new Error(`Unknown operation ${name}`);
  if (!permitsOperation(context.access.permissions, definition))
    throw new ApplicationError(
      "permission_denied",
      `This needs ${definition.permission} permission`,
      403,
    );
  validateSchema(input, definition.input);
  let data: unknown;
  if (name === "accounts.list") data = await context.service.accounts();
  else {
    // Loaded when first needed: the registry imports this lane's handlers, so a static import would
    // be a cycle at start-up.
    const { sliceHandlers } = await import("../handlers.ts");
    const handler = Object.hasOwn(sliceHandlers, name) ? sliceHandlers[name] : undefined;
    if (!handler) throw new Error(`Operation ${name} has no handler`);
    data = await handler(input, { ...context, operationId });
  }
  validateSchema(data, definition.output, "output");
  return data as T;
}
