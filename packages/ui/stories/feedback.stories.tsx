import { createSignal, Show } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Check, LockKeyhole } from "../src/icons";
import { Button, ErrorSummary, Notice, Progress, Status, TextField } from "../src";
import { Catalog, Specimen } from "./catalog";

function Feedback() {
  return (
    <Catalog
      section="03 / Feedback"
      title="Tell the truth about the state."
      description="Confirmation is quiet. Exceptions are specific. A missing response is not evidence that an entry failed."
    >
      <Specimen
        title="Status"
        note="Words carry the meaning. Color is supplementary; a negative amount is not an error."
      >
        <div class="catalog-row">
          <Status>Draft</Status>
          <Status>
            <Check aria-hidden="true" /> Posted
          </Status>
          <Status>
            <Check aria-hidden="true" /> Reconciled
          </Status>
          <Status tone="review">Needs review</Status>
          <Status tone="error">Could not save</Status>
          <Status>
            <LockKeyhole aria-hidden="true" /> Closed period
          </Status>
        </div>
      </Specimen>
      <Specimen
        title="Persistent notices"
        note="Important outcomes stay visible. Explain the consequence and the next available action."
      >
        <div class="rt-stack">
          <Notice title="This period is closed">
            Choose an open posting date, or ask an authorized person to reopen the period.
          </Notice>
          <Notice tone="review" title="Your entry has unsaved changes">
            Keep editing, or discard the changes before leaving.
          </Notice>
          <Notice tone="error" title="Your changes could not be saved">
            Your entries are still here. Try saving again when the connection is restored.
          </Notice>
        </div>
      </Specimen>
      <Specimen
        title="Progress"
        note="Determinate progress only when we know the amount of work. Never invent a percentage."
      >
        <div class="rt-stack">
          <Progress label="Preparing report" value={64} showValue />
          <Progress label="Checking posting status" value={null} />
        </div>
      </Specimen>
      <Specimen
        title="Empty & no results"
        note="An empty book and an unsuccessful search are different situations."
      >
        <div class="catalog-split">
          <Notice title="No entries yet">Posted entries will appear here.</Notice>
          <Notice title="No matching entries">Try another reference or clear your filters.</Notice>
        </div>
      </Specimen>
    </Catalog>
  );
}

function Validation() {
  const [reference, setReference] = createSignal("");
  const [description, setDescription] = createSignal("September workshop supplies");
  const [submitted, setSubmitted] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  const [attempts, setAttempts] = createSignal(0);
  const invalid = () => submitted() && !reference().trim();
  return (
    <Catalog
      section="03 / Error recovery"
      title="Help people finish the task."
      description="A form-level summary, an error beside the field, and every valid answer preserved."
    >
      <form
        class="rt-stack"
        novalidate
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
          setSaved(false);
          if (!reference().trim()) setAttempts((count) => count + 1);
          else setSaved(true);
        }}
      >
        <Show when={invalid()}>
          <ErrorSummary
            attempt={attempts()}
            errors={[{ id: "review-reference", message: "Enter a reference." }]}
          />
        </Show>
        <TextField
          id="review-reference"
          label="Reference"
          required
          value={reference()}
          onInput={(event) => setReference(event.currentTarget.value)}
          {...(invalid() ? { error: "Enter a reference." } : {})}
        />
        <TextField
          label="Description"
          value={description()}
          onInput={(event) => setDescription(event.currentTarget.value)}
        />
        <div>
          <Button label="Save draft" type="submit" />
        </div>
        <Show when={saved()}>
          <Notice title="Draft saved in this preview" role="status">
            Reloading clears it. Nothing has been posted.
          </Notice>
        </Show>
      </form>
    </Catalog>
  );
}

function Outcome(props: { state: "pending" | "unknown" | "rejected" | "confirmed" | "denied" }) {
  const [state, setState] = createSignal<typeof props.state | "draft">(props.state);
  const copy = () =>
    ({
      pending: ["Posting your entry", "Wait for confirmation before closing this view."],
      unknown: [
        "We haven't confirmed whether your entry was posted",
        "Do not create another entry. Check the status of this submission.",
      ],
      rejected: [
        "This entry was not posted",
        "The posting date is in a closed period. Your draft is unchanged.",
      ],
      confirmed: [
        "Entry JRN-0044 was posted",
        "The posting is confirmed. You can now review the entry.",
      ],
      denied: [
        "You don't have permission to post entries",
        "You can prepare a draft and ask an authorized person to post it.",
      ],
      draft: [
        "Back to your draft",
        "Your entry is unchanged. Choose an open posting date before submitting it again.",
      ],
    })[state()];
  return (
    <Catalog
      section="03 / Submission states"
      title="Certainty before confirmation."
      description="Deterministic response fixtures. Buttons change only this preview; no ledger request is made."
    >
      <div class="rt-stack">
        <Notice
          title={copy()[0] ?? ""}
          tone={state() === "unknown" ? "review" : state() === "rejected" ? "error" : "info"}
          role="status"
        >
          {copy()[1]}
        </Notice>
        <Show when={state() === "unknown"}>
          <div>
            <Button label="Check posting status" onClick={() => setState("confirmed")} />
          </div>
        </Show>
        <Show when={state() === "pending"}>
          <Button label="Posting entry" pendingLabel="Posting…" pending />
        </Show>
        <Show when={state() === "rejected"}>
          <div>
            <Button variant="secondary" label="Return to draft" onClick={() => setState("draft")} />
          </div>
        </Show>
      </div>
    </Catalog>
  );
}

export default {
  title: "Components/Feedback",
  component: Feedback,
  parameters: {
    layout: "fullscreen",
    options: { showPanel: false },
    controls: { disable: true },
  },
} satisfies Meta<typeof Feedback>;
type Story = StoryObj<typeof Feedback>;
export const Review: Story = {};
export const ValidationRecovery: Story = { render: () => <Validation /> };
export const Posting: Story = { render: () => <Outcome state="pending" /> };
export const UnknownOutcome: Story = { render: () => <Outcome state="unknown" /> };
export const Rejected: Story = { render: () => <Outcome state="rejected" /> };
export const Confirmed: Story = { render: () => <Outcome state="confirmed" /> };
export const PermissionDenied: Story = { render: () => <Outcome state="denied" /> };
