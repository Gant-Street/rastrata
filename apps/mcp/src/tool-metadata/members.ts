import type { OperationMetadata } from "./types.ts";

const people =
  "Who is in the book is the owner's business and the control plane's to change. A model has no need to read other people's addresses, and must never be able to change who may use the book or what they may do.";

/** MCP tool metadata for the operations the members slice adds. None is a tool: the web app and the control plane use them. */
export const membersTools: Readonly<Record<string, OperationMetadata>> = {
  "members.list": { hidden: true, reason: people },
  "members.add": { hidden: true, reason: people },
  "members.setRole": { hidden: true, reason: people },
  "members.remove": { hidden: true, reason: people },
  "book.retire": {
    hidden: true,
    reason:
      "Deleting a book is the owner's decision and the control plane's work; a model must never be able to start or undo it.",
  },
  "book.unretire": {
    hidden: true,
    reason:
      "Deleting a book is the owner's decision and the control plane's work; a model must never be able to start or undo it.",
  },
  "book.access": {
    hidden: true,
    reason:
      "Whether a workspace is read-only follows its subscription and is the control plane's word alone; a model must never be able to set it or lift it.",
  },
};
