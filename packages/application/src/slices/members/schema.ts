import { WORKSPACE_ROLES } from "../../agent/member.ts";
import {
  array,
  id,
  nullable,
  object,
  operation,
  ref,
  text,
  type Schema,
} from "../../schema-kit.ts";
import type { SliceSchema } from "../types.ts";

const memberRole: Schema = { type: "string", enum: [...WORKSPACE_ROLES] };
const instant = text(40);
const email: Schema = {
  type: "string",
  minLength: 3,
  maxLength: 254,
  pattern: "^[^\\s@]+@[^\\s@]+$",
};

/** Who is in the book and as what. The control plane fills the table (the owner first, through the admin credential)
 * and the runtime reads it on every request of a member, so a role change or a removal takes effect at the next request.
 * Changing it needs `provision`: the owner's, the owner key's and the control plane's, never a member's or an agent's. */
export const membersSchema: SliceSchema = {
  name: "members",
  definitions: {
    /** `addedBy` and `changedBy` say who, as the book records a caller: "owner", "member:<id>", "service:<name>". */
    Member: object(
      {
        userId: id,
        email,
        role: memberRole,
        addedAt: instant,
        changedAt: instant,
        addedBy: text(100),
        changedBy: text(100),
      },
      ["userId", "email", "role", "addedAt", "changedAt"],
    ),
    /** A person who was taken out. The book keeps their identifier, their last role and the times, and has erased their address. */
    RemovedMember: object({
      userId: id,
      role: memberRole,
      addedAt: instant,
      addedBy: text(100),
      removedAt: instant,
      removedBy: text(100),
    }),
    /** `includeRemoved` also lists the people who were taken out, in `removed`, for the history of who had access. */
    MemberListInput: object({ includeRemoved: { type: "boolean" } }, []),
    /** `retiredAt` is the time the book was retired (it is being deleted and no member is let in), or null. */
    MemberList: object(
      {
        members: array(ref("Member"), 1000),
        retiredAt: nullable(instant),
        removed: array(ref("RemovedMember"), 1000),
      },
      ["members"],
    ),
    MemberAddInput: object({ userId: id, email, role: memberRole }),
    MemberSetRoleInput: object({ userId: id, role: memberRole }),
    MemberRemoveInput: object({ userId: id }),
    MemberRemoved: object({ userId: id, removed: { type: "boolean" } }),
    BookRetireInput: object({}, []),
    BookRetirement: object({ retired: { type: "boolean" }, retiredAt: nullable(instant) }),
    BookAccessInput: object({ readOnly: { type: "boolean" } }),
    /** `readOnlySince` is when the book became read-only (null when it is not). */
    BookAccess: object({ readOnly: { type: "boolean" }, readOnlySince: nullable(instant) }),
  },
  operations: [
    operation(
      "members.list",
      "List the people who are in this book and their roles (owner, admin, accountant, member), in the order they came.",
      "read",
      "MemberListInput",
      false,
      "MemberList",
    ),
    operation(
      "members.add",
      "Put a person in this book with a role: new, back after leaving, or with a new address or role. Asking again with the same words changes nothing a second time. The only owner cannot be given a lesser role. Needs provision.",
      "provision",
      "MemberAddInput",
      true,
      "Member",
    ),
    operation(
      "members.setRole",
      "Change a member's role. The only owner cannot be given a lesser role. Needs provision.",
      "provision",
      "MemberSetRoleInput",
      true,
      "Member",
    ),
    operation(
      "members.remove",
      "Take a person out of this book, and erase their address from it: the book keeps their identifier and the times, so that it still says who did what. Taking out someone who is not in changes nothing. The only owner cannot be taken out, unless the book is being deleted. Needs provision.",
      "provision",
      "MemberRemoveInput",
      true,
      "MemberRemoved",
    ),
    operation(
      "book.retire",
      "The book is being deleted: no member is let in (they are told it is being deleted) until it is restored. The people and their roles stay as they were. Asking again changes nothing. Needs provision, which only the control plane's key and the owner have.",
      "provision",
      "BookRetireInput",
      true,
      "BookRetirement",
    ),
    operation(
      "book.unretire",
      "The book is not being deleted after all: members are let in again, as they were. Restoring a book that is not retired changes nothing. Needs provision.",
      "provision",
      "BookRetireInput",
      true,
      "BookRetirement",
    ),
    operation(
      "book.access",
      "Say whether this book is read-only: a workspace that has no subscription may read its books and export them, and nothing more, until it has one. Asking for what is already so changes nothing. Only the control plane's key may call it.",
      "provision",
      "BookAccessInput",
      true,
      "BookAccess",
    ),
  ],
  readsBeforeSetup: ["members.list"],
  writesBeforeSetup: [
    "members.add",
    "members.setRole",
    "members.remove",
    "book.retire",
    "book.unretire",
    "book.access",
  ],
};
