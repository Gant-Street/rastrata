import {
  describePrincipal,
  requireControlPlane,
  type ApplicationAccess,
} from "../../agent/principal.ts";
import type { WorkspaceRole } from "../../agent/member.ts";
import { ApplicationError } from "../../errors.ts";
import type { SliceHandlers } from "../types.ts";
import { memberState, type MemberRecord } from "./store.ts";

/** In hosted mode, workspace membership and retirement live in the control plane (D1) so seat caps,
 * invites and billing-owner guards stay authoritative. A workspace member token cannot call these
 * directly on the pod; the control plane (`service`) and local owner mode keep access. */
function requireControlPlaneOrLocalOwner(access: ApplicationAccess, operation: string): void {
  if (access.principal?.kind === "member")
    throw new ApplicationError(
      "service_only",
      `${operation} is managed by the control plane and cannot be called directly by a workspace member.`,
      403,
    );
}

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
    requireControlPlaneOrLocalOwner(access, "book.retire");
    const state = memberState(service);
    const by = describePrincipal(access.principal);
    return service.retainRequest(operationId, "book.retire", input, () => ({
      retired: true,
      retiredAt: state.retire(by),
    }));
  },

  "book.unretire": (input, { service, access, operationId }) => {
    requireControlPlaneOrLocalOwner(access, "book.unretire");
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

  "book.usage": (_input, { service, access }) => {
    requireControlPlane(access, "book.usage");
    const hasTable = (name: string): boolean =>
      service.store
        .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(name) !== null;
    const countOf = (sql: string): number => {
      const row = service.store.query(sql).get() as { n?: number } | null;
      return typeof row?.n === "number" ? row.n : 0;
    };
    return {
      statementsImported: hasTable("app_ingest_batches")
        ? countOf("SELECT COUNT(*) AS n FROM app_ingest_batches")
        : 0,
      transactionsImported: hasTable("app_ingest_items")
        ? countOf("SELECT COUNT(*) AS n FROM app_ingest_items")
        : 0,
      exportsCreated: hasTable("app_requests")
        ? countOf("SELECT COUNT(*) AS n FROM app_requests WHERE operation = 'export.create'")
        : 0,
    };
  },

  "members.add": (input, { service, access, operationId }) => {
    requireControlPlaneOrLocalOwner(access, "members.add");
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
    requireControlPlaneOrLocalOwner(access, "members.setRole");
    const state = memberState(service);
    const by = describePrincipal(access.principal);
    const changed = service.retainRequest(operationId, "members.setRole", input, () => ({
      userId: state.setRole(input.userId as string, input.role as WorkspaceRole, by).userId,
    }));
    return present(state.require(changed.userId));
  },

  "members.remove": (input, { service, access, operationId }) => {
    requireControlPlaneOrLocalOwner(access, "members.remove");
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
