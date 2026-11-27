import type {
  BookUpdateInput,
  InboxRecategorizeInput,
  InboxUndoInput,
  JournalPostInput,
} from "../../client-contracts.gen.ts";
import { describePrincipal } from "../../agent/principal.ts";
import type { SliceHandlers } from "../types.ts";
import { postEntry } from "./post.ts";
import { recategorizeItems } from "./recategorize.ts";
import { updateBook } from "./settings.ts";
import { undoItems } from "./undo.ts";

export const entriesHandlers: SliceHandlers = {
  "journal.post": (input, { service, access, operationId }) =>
    postEntry(service, access, input as JournalPostInput, operationId),
  "inbox.undo": (input, { service, access, operationId }) =>
    undoItems(service, input as InboxUndoInput, operationId, describePrincipal(access.principal)),
  "inbox.recategorize": (input, { service, access, operationId }) =>
    recategorizeItems(service, access, input as InboxRecategorizeInput, operationId),
  "book.update": (input, { service, access, operationId }) =>
    updateBook(service, input as BookUpdateInput, operationId, describePrincipal(access.principal)),
};
