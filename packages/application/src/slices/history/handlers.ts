import { describePrincipal } from "../../agent/principal.ts";
import { ApplicationError } from "../../errors.ts";
import { importHistory, previewHistory, type HistoryInput } from "../../history/run.ts";
import { tieOut, type TieOutInput } from "../../history/tie-out.ts";
import { serialized } from "../shadow/queue.ts";
import type { SliceHandlers } from "../types.ts";

export const historyHandlers: SliceHandlers = {
  "history.preview": (input, { service }) =>
    previewHistory(service, input as unknown as HistoryInput),
  "history.tieOut": (input, { service }) => tieOut(service, input as unknown as TieOutInput),
  "history.import": (input, { service, access, operationId }) => {
    // Adding accounts to the book is a change of its configuration, which `post` alone does not allow.
    const adds = ((input as unknown as HistoryInput).map ?? []).some(
      (pair) => pair.add !== undefined,
    );
    if (adds && !access.permissions.includes("configure"))
      throw new ApplicationError(
        "permission_denied",
        access.principal?.kind === "token"
          ? `Adding accounts requires configure permission; this token grants ${access.permissions.join(", ") || "nothing"}`
          : "Adding accounts requires configure permission",
        403,
      );
    return service.retainAsyncRequest(operationId, "history.import", input, () =>
      serialized(service, () =>
        importHistory(service, input as unknown as HistoryInput, {
          by: describePrincipal(access.principal),
          operation: "history.import",
        }),
      ),
    );
  },
};
