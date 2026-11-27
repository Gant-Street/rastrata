import { createSignal, Show } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { CategorizeDialog, PostDialog, ReasonDialog, SourceDialog, UiProvider } from "../../src";
import { accounts, sources } from "./fixtures";

function DialogHarness(props: {
  kind: "exclude" | "restore" | "categorize" | "post" | "source";
  scope?: string;
}) {
  const [open, setOpen] = createSignal(true);
  const close = () => setOpen(false);
  return (
    <UiProvider locale="en-US">
      <div class="rt-theme rt-inbox-story">
        <Show when={!open()}>
          <p class="rt-hint" role="status">
            The dialog is closed. Choose the story again to see it open.
          </p>
        </Show>
        {props.kind === "exclude" ? (
          <ReasonDialog
            open={open()}
            title="Exclude 3 lines"
            body="Say why. The reason stays with each line, and you can return them to review later."
            confirm="Exclude 3 lines"
            quick={[
              "Personal expense",
              "Not this business",
              "Duplicate of another line",
              "Handled elsewhere",
            ]}
            {...(props.scope ? { scope: props.scope } : {})}
            onConfirm={close}
            onClose={close}
          />
        ) : props.kind === "restore" ? (
          <ReasonDialog
            open={open()}
            title="Return 2 lines to review"
            body="Excluded lines come back as waiting. A line with a draft loses the draft and starts again."
            confirm="Return 2 lines"
            onConfirm={close}
            onClose={close}
          />
        ) : props.kind === "categorize" ? (
          <CategorizeDialog
            open={open()}
            count={1621}
            accounts={accounts}
            {...(props.scope ? { scope: props.scope } : {})}
            onConfirm={close}
            onClose={close}
          />
        ) : props.kind === "post" ? (
          <PostDialog
            open={open()}
            count={88}
            {...(props.scope ? { scope: props.scope } : {})}
            onConfirm={close}
            onClose={close}
          />
        ) : (
          <SourceDialog
            open={open()}
            source={sources[2] ?? null}
            sourceLabel={(source) => `${source.accountKey} (${source.provider})`}
            accounts={accounts}
            onSave={close}
            onClose={close}
          />
        )}
      </div>
    </UiProvider>
  );
}

const meta = {
  title: "Lanes/Ingest/Dialogs",
  component: DialogHarness,
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta<typeof DialogHarness>;
export default meta;
type DialogStory = StoryObj<typeof meta>;

export const ExcludeWithAReason: DialogStory = { args: { kind: "exclude" } };
export const ExcludeEverythingMatching: DialogStory = {
  args: {
    kind: "exclude",
    scope:
      "This applies to all 1,621 lines matching the current filter, in steps, and stops if the list changes.",
  },
};
export const ReturnToReview: DialogStory = { args: { kind: "restore" } };
export const CategorizeMany: DialogStory = {
  args: {
    kind: "categorize",
    scope:
      "This applies to all 1,621 lines matching the current filter, in steps, and stops if the list changes.",
  },
};
export const PostConfirmation: DialogStory = { args: { kind: "post" } };
export const ChooseSourceAccount: DialogStory = { args: { kind: "source" } };
