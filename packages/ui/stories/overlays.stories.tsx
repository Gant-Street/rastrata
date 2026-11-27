import { Menu } from "@ark-ui/solid/menu";
import { createSignal, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { Ellipsis, Info } from "../src/icons";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  Button,
  buttonAttrs,
  Dialog,
  DialogClose,
  HelpTip,
  Notice,
  TextField,
  Tooltip,
} from "../src";
import { AccountPicker } from "./controls";
import { Catalog, Specimen } from "./catalog";

function Overlays() {
  const [action, setAction] = createSignal("");
  return (
    <Catalog
      section="03 / Overlays"
      title="Only the detail you need."
      description="Ark handles opening, dismissal, focus and keyboard navigation. Consequential choices get a clear explanation, not a vague “Are you sure?”."
    >
      <Specimen
        title="Menu"
        note="Secondary actions stay discoverable. A menu is for actions, not selecting form values."
      >
        <div class="rt-stack">
          <Menu.Root onSelect={(detail) => setAction(`${detail.value} selected in preview.`)}>
            <Menu.Trigger {...buttonAttrs({ variant: "secondary" })}>
              Entry actions <Ellipsis aria-hidden="true" />
            </Menu.Trigger>
            <Portal>
              <Menu.Positioner>
                <Menu.Content class="rt-popup">
                  <Menu.Item class="rt-item" value="View history">
                    View history
                  </Menu.Item>
                  <Menu.Item class="rt-item" value="Copy reference">
                    Copy reference
                  </Menu.Item>
                  <Menu.Item class="rt-item" value="Reverse entry" disabled>
                    Reverse entry (permission required)
                  </Menu.Item>
                </Menu.Content>
              </Menu.Positioner>
            </Portal>
          </Menu.Root>
          <Show when={action()}>
            <p role="status" class="rt-hint">
              {action()}
            </p>
          </Show>
        </div>
      </Specimen>
      <Specimen
        title="Tooltip & help"
        note="A tooltip clarifies; it never contains essential instructions, because touch users cannot hover. Anything a person must be able to read belongs in a help popover."
      >
        <div class="catalog-row">
          <Tooltip content="Posting records this entry in your books.">
            {(attrs) => (
              <Button
                {...attrs()}
                variant="secondary"
                iconOnly
                icon={<Info />}
                label="About posting"
              />
            )}
          </Tooltip>
          <HelpTip
            topic="posted"
            label="What does posted mean?"
            title="Part of the permanent record"
          >
            Posted entries affect your books. Corrections should preserve the original entry and its
            history.
          </HelpTip>
        </div>
      </Specimen>
      <Specimen
        title="Nested account selector"
        note="Escape closes the account list first, then the dialog. Focus returns to the opening control."
      >
        <Dialog
          triggerLabel="Edit entry details"
          title="Edit entry details"
          closeLabel="Close entry details"
          description="Preview only. Nothing will be saved to your books."
          footer={<DialogClose {...buttonAttrs({ variant: "secondary" })}>Done</DialogClose>}
        >
          <TextField label="Reference" value="September adjustments" />
          <AccountPicker />
        </Dialog>
      </Specimen>
      <Specimen
        title="Discard confirmation"
        note="Name what will be lost. Put initial focus on keeping the work, not discarding it."
      >
        <Discard />
      </Specimen>
    </Catalog>
  );
}

function Discard() {
  const [open, setOpen] = createSignal(false);
  const [discarded, setDiscarded] = createSignal(false);
  let cancel: HTMLButtonElement | undefined;
  return (
    <div class="rt-stack">
      <div>
        <Button variant="danger" label="Discard draft" onClick={() => setOpen(true)} />
      </div>
      <Dialog
        role="alertdialog"
        open={open()}
        onOpenChange={setOpen}
        initialFocusEl={() => cancel ?? null}
        title="Discard this draft?"
        description="Your unsaved reference and entry lines will be removed. Posted entries will not be changed."
        footer={
          <>
            <DialogClose ref={cancel} {...buttonAttrs({ variant: "secondary" })}>
              Keep editing
            </DialogClose>
            <Button
              label="Discard draft"
              variant="danger"
              onClick={() => {
                setDiscarded(true);
                setOpen(false);
              }}
            />
          </>
        }
      />
      <Show when={discarded()}>
        <Notice title="Preview draft discarded" role="status">
          No real entries were changed.
        </Notice>
      </Show>
    </div>
  );
}
export default {
  title: "Components/Overlays",
  component: Overlays,
  parameters: {
    layout: "fullscreen",
    options: { showPanel: false },
    controls: { disable: true },
  },
} satisfies Meta<typeof Overlays>;
export const Review: StoryObj<typeof Overlays> = {};
