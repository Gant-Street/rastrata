import { describePrincipal, requireControlPlane } from "../../agent/principal.ts";
import type { WorkspaceRole } from "../../agent/member.ts";
import type { SliceHandlers } from "../types.ts";
import { memberState, type MemberRecord } from "./store.ts";

/** The wire shape of a member: who they are and what they are, and when. */
const present = (member: MemberRecord) => ({
  userId: member.userId,
  email: member.email,
  role: member.role,
  addedAt: member.addedAt,
  changedAt: member.changedAt,
  addedBy: member.addedBy,
  changedBy: member.changedBy,
});

const normalizeEmail = (value: string): string => value.trim().toLowerCase();

export const membersHandlers: SliceHandlers = {
  "members.list": (input, { service }) => ({
    members: memberState(service).list().map(present),
    retiredAt: memberState(service).retiredAt(),
    ...(input.includeRemoved === true ? { removed: memberState(service).listRemoved() } : {}),
  }),

  "book.retire": (input, { service, access, operationId }) => {
    const state = memberState(service);
    const by = describePrincipal(access.principal);
    return service.retainRequest(operationId, "book.retire", input, () => ({
      retired: true,
      retiredAt: state.retire(by),
    }));
  },

  "book.unretire": (input, { service, operationId }) => {
    const state = memberState(service);
    return service.retainRequest(operationId, "book.unretire", input, () => {
      state.unretire();
      return { retired: false, retiredAt: null };
    });
  },

  /** It keeps no answer by the call's identity (`retainRequest`): it says how things stand now, and the same words are said again when the workspace subscribes, lapses and subscribes. */
  "book.access": (input, { service, access }) => {
    requireControlPlane(access, "book.access");
    const since = memberState(service).setReadOnly(
      input.readOnly === true,
      describePrincipal(access.principal),
    );
    return { readOnly: since !== null, readOnlySince: since };
  },

  "members.add": (input, { service, access, operationId }) => {
    const state = memberState(service);
    const by = describePrincipal(access.principal);
    const added = service.retainRequest(operationId, "members.add", input, () => ({
      userId: state.add(
        input.userId as string,
        normalizeEmail(input.email as string),
        input.role as WorkspaceRole,
        by,
      ).userId,
    }));
    return present(state.require(added.userId));
  },

  "members.setRole": (input, { service, access, operationId }) => {
    const state = memberState(service);
    const by = describePrincipal(access.principal);
    const changed = service.retainRequest(operationId, "members.setRole", input, () => ({
      userId: state.setRole(input.userId as string, input.role as WorkspaceRole, by).userId,
    }));
    return present(state.require(changed.userId));
  },

  "members.remove": (input, { service, access, operationId }) => {
    const state = memberState(service);
    const by = describePrincipal(access.principal);
    const removed = service.retainRequest(operationId, "members.remove", input, () => {
      const was = state.get(input.userId as string) !== null;
      state.remove(input.userId as string, by);
      return { userId: input.userId as string, removed: was };
    });
    return { userId: removed.userId, removed: removed.removed };
  },
};
