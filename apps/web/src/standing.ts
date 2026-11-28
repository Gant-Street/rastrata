import { createSignal } from "solid-js";

/** Dispatched on `window` when checkout finishes or billing standing changes so the shell reloads the banner immediately. */
export const BILLING_UPDATED_EVENT = "rastrata:billing-updated";
/** Dispatched on `window` when the active workspace is renamed so the header switcher updates immediately. */
export const WORKSPACE_RENAMED_EVENT = "rastrata:workspace-renamed";

const [readOnly, setReadOnly] = createSignal(false);

/** Whether the active workspace's owning account is currently in read-only billing state. */
export const workspaceReadOnly = (): boolean => readOnly();

/** Set by the shell from `/auth/workspaces/:id` standing; always false on non-hosted installs. */
export const setWorkspaceReadOnly = (value: boolean): void => {
  setReadOnly(value);
};
