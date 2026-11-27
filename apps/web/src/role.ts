/** The person's role in the open workspace, and what a role may do: read once from the control plane, so
 * a screen can leave out what is not theirs to do (a member is not offered the owner's setup steps) and
 * skip a read the service would refuse. The service still decides every request for itself. */
import { ROLE_PERMISSIONS } from "@rastrata/application/member";
import type { Role } from "./account";
import { currentAccount } from "./boot";
import { capabilities } from "./capabilities";
import { openWorkspace } from "./new-book";

let cached: { readonly workspace: string; readonly role: Promise<Role | null> } | undefined;

/** The role in the open workspace; "owner" on a service with no accounts (one person's own install); null
 * when the workspaces could not be read, which a page takes as "not known", never as "may not". */
export function currentRole(): Promise<Role | null> {
  const account = currentAccount();
  const workspace = openWorkspace();
  if (!capabilities().accounts || !account || !workspace) return Promise.resolve("owner");
  if (cached?.workspace !== workspace) {
    const role = account.workspaces().then(
      (list) => (list.ok ? (list.value.find((item) => item.id === workspace)?.role ?? null) : null),
      () => null,
    );
    cached = { workspace, role };
  }
  return cached.role;
}

/** Whether a role holds a permission. A role that is not known is not refused anything here: the service
 * answers for itself. */
export function may(role: Role | null | undefined, permission: string): boolean {
  if (role === null || role === undefined) return true;
  return (ROLE_PERMISSIONS[role] as readonly string[]).includes(permission);
}
