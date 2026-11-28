import { Menu as ArkMenu } from "@ark-ui/solid/menu";
import { createSignal, For, type JSX, Show } from "solid-js";
import { Check, ChevronDown, Plus } from "./icons";
import { shellWords } from "./shell-words";

export interface WorkspaceOption {
  readonly id: string;
  readonly name: string;
  readonly slug?: string | undefined;
  readonly role?: string | undefined;
  readonly state?: "provisioning" | "ready" | "deleting" | "deleted" | undefined;
  readonly readOnly?: boolean | undefined;
}

/** Stripe-style workspace switcher for the header: Ark UI Menu anchored beside the wordmark.
 * Lists active workspaces (marking the current one and any read-only workspace), plus an action
 * to create a new workspace in place and a link to the full workspace list. */
export function WorkspaceSwitcher(props: {
  /** Active workspace display name (typically the book's name, or the workspace's name before the book loads). */
  currentName: string;
  /** Active workspace ID. */
  currentId?: string | null | undefined;
  /** Workspaces available to switch into. */
  workspaces: readonly WorkspaceOption[];
  /** True while the workspace list is loading on first open. */
  loading?: boolean | undefined;
  /** Called when the user opens the menu (so the parent can refresh the workspace list lazily if needed). */
  onOpen?: (() => void) | undefined;
  /** Switch to an existing ready workspace. */
  onSelect: (workspaceId: string) => void;
  /** Open the in-place dialog to create a new workspace. */
  onCreate: () => void;
  /** Optional link to the full workspace management view (`/start?choose=1`). */
  manageHref?: string | undefined;
}): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const words = shellWords.workspace;

  const readyWorkspaces = () =>
    props.workspaces.filter((item) => item.state === undefined || item.state === "ready");

  return (
    <div class="rt-ws">
      <ArkMenu.Root
        loopFocus
        open={open()}
        onOpenChange={(detail) => {
          setOpen(detail.open);
          if (detail.open) props.onOpen?.();
        }}
        onSelect={(detail) => {
          if (detail.value === "__create__") {
            setTimeout(() => props.onCreate(), 0);
            return;
          }
          if (detail.value === "__manage__") return;
          if (detail.value && detail.value !== props.currentId) {
            props.onSelect(detail.value);
          }
        }}
      >
        <ArkMenu.Trigger
          class="rt-ws-trigger"
          aria-label={words.switchLabel(props.currentName)}
          title={props.currentName}
        >
          <span class="rt-ws-name">{props.currentName}</span>
          <ChevronDown class="rt-ws-chevron" aria-hidden="true" />
        </ArkMenu.Trigger>
        <ArkMenu.Content class="rt-ws-panel">
          <div class="rt-ws-heading">{words.heading}</div>
          <Show
            when={!props.loading || readyWorkspaces().length > 0}
            fallback={<p class="rt-ws-empty">{words.loading}</p>}
          >
            <For each={readyWorkspaces()}>
              {(item) => {
                const active = () => item.id === props.currentId;
                return (
                  <ArkMenu.Item
                    value={item.id}
                    class="rt-ws-item"
                    data-active={active() ? "" : undefined}
                  >
                    <span class="rt-ws-item-check" aria-hidden="true">
                      <Show when={active()}>
                        <Check />
                      </Show>
                    </span>
                    <span class="rt-ws-item-body">
                      <span class="rt-ws-item-name">{item.name}</span>
                      <Show when={item.readOnly}>
                        <span class="rt-ws-item-note">{words.readOnly}</span>
                      </Show>
                    </span>
                  </ArkMenu.Item>
                );
              }}
            </For>
          </Show>
          <ArkMenu.Separator class="rt-ws-separator" />
          <ArkMenu.Item value="__create__" class="rt-ws-item rt-ws-create">
            <span class="rt-ws-item-check" aria-hidden="true">
              <Plus />
            </span>
            <span class="rt-ws-item-body">
              <span class="rt-ws-item-name">{words.create}</span>
            </span>
          </ArkMenu.Item>
          <Show when={props.manageHref}>
            {(href) => (
              <ArkMenu.Item
                value="__manage__"
                asChild={(part) => (
                  <a
                    {...(part() as JSX.AnchorHTMLAttributes<HTMLAnchorElement>)}
                    class="rt-ws-item rt-ws-manage"
                    href={href()}
                  >
                    <span class="rt-ws-item-check" aria-hidden="true" />
                    <span class="rt-ws-item-body">
                      <span class="rt-ws-item-name">{words.manage}</span>
                    </span>
                  </a>
                )}
              />
            )}
          </Show>
        </ArkMenu.Content>
      </ArkMenu.Root>
    </div>
  );
}
