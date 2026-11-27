import { Combobox, useListCollection } from "@ark-ui/solid/combobox";
import { Dialog } from "@ark-ui/solid/dialog";
import { createSignal, For } from "solid-js";
import { Portal } from "solid-js/web";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { buttonAttrs, UiProvider } from "../../src";

const accounts = [
  { label: "Cash", value: "cash" },
  { label: "Sales", value: "sales" },
  { label: "Archived account", value: "archived", disabled: true },
];

/** An Ark combobox inside an Ark dialog: the nesting every "choose an account in a dialog" screen has
 * (Spend money, Categorize, the New account drawer). It used to be the application's `/checks` page, a
 * scaffold fixture; it is a story now, and `tests/nested-controls.spec.ts` drives it in all three
 * browsers. Nothing is saved. */
function NestedControls() {
  const [account, setAccount] = createSignal("None");
  const { collection, filter } = useListCollection({
    initialItems: accounts,
    filter: (text, input) =>
      text.toLocaleLowerCase("en-US").includes(input.toLocaleLowerCase("en-US")),
  });
  return (
    <UiProvider locale="en-US">
      <div class="rt-theme" style={{ padding: "1.5rem" }}>
        <p>
          Try the account selector using your keyboard. These are sample options; nothing is saved.
        </p>
        <Dialog.Root>
          <Dialog.Trigger {...buttonAttrs({ variant: "secondary" })}>
            Choose an account
          </Dialog.Trigger>
          <Portal>
            <Dialog.Backdrop class="rt-backdrop" />
            <Dialog.Positioner class="rt-positioner">
              <Dialog.Content class="rt-dialog rt-theme">
                <Dialog.Title>Choose an account</Dialog.Title>
                <Dialog.Description>Search the sample accounts and select one.</Dialog.Description>
                <Combobox.Root
                  collection={collection()}
                  onInputValueChange={(event) => filter(event.inputValue)}
                  onValueChange={(event) => setAccount(event.value[0] ?? "None")}
                >
                  <Combobox.Label>Account</Combobox.Label>
                  <Combobox.Control style={{ display: "flex", gap: "0.5rem" }}>
                    <Combobox.Input style={{ flex: "1", "min-width": "0" }} />
                    <Combobox.Trigger aria-label="Show accounts">Show</Combobox.Trigger>
                  </Combobox.Control>
                  {/* Keep the popup inside the modal's accessible DOM subtree. */}
                  <Combobox.Positioner>
                    <Combobox.Content
                      style={{
                        background: "var(--rt-paper)",
                        border: "1.5px solid var(--rt-ink)",
                        "max-height": "15rem",
                        "overflow-y": "auto",
                      }}
                    >
                      <For each={collection().items}>
                        {(item) => (
                          <Combobox.Item item={item} style={{ padding: "0.5rem 0.75rem" }}>
                            <Combobox.ItemText>{item.label}</Combobox.ItemText>
                          </Combobox.Item>
                        )}
                      </For>
                    </Combobox.Content>
                  </Combobox.Positioner>
                </Combobox.Root>
                <Dialog.CloseTrigger style={{ "margin-top": "1.5rem" }}>Close</Dialog.CloseTrigger>
              </Dialog.Content>
            </Dialog.Positioner>
          </Portal>
        </Dialog.Root>
        <p>
          Selected account: <output aria-label="Selected account">{account()}</output>
        </p>
      </div>
    </UiProvider>
  );
}

const meta = {
  title: "Lanes/UXShell/NestedControls",
  component: NestedControls,
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof NestedControls>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Closed: a button that opens the dialog. The keyboard test opens it and works the combobox inside. */
export const Default: Story = {};
