import { For, type JSX } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Notice, Status, ToneMarker, TONES, type Tone, type ToneName } from "../../src";
import { Frame, darkUnlessAsked } from "./frame";

const WORDS: Record<Tone, { title: string; body: string; chip: string; line: string }> = {
  calm: {
    title: "The last backup was verified 2 hours ago",
    body: "12 changes have been made since then.",
    chip: "Posted",
    line: "Last verified backup: 2 hours ago",
  },
  info: {
    title: "Reports include posted entries only",
    body: "A draft appears here once you post it.",
    chip: "Early release",
    line: "Taxes: the form is an early-release draft",
  },
  attention: {
    title: "8 transactions are waiting for review",
    body: "They are not in your books until you accept them.",
    chip: "Needs review",
    line: "8 transactions to review",
  },
  problem: {
    title: "Your changes could not be saved",
    body: "Nothing was changed. Try again when the connection is back.",
    chip: "Could not save",
    line: "The last backup did not verify",
  },
};

/** A row of a list with its marker: the shape a screen's "needs you" or "where things stand" lines take.
 * The row is scaffolding for this page; the marker is the kit's. */
function Row(props: { tone: Tone; label: string; children: JSX.Element }) {
  return (
    <div
      style={{
        display: "flex",
        "flex-wrap": "wrap",
        "align-items": "baseline",
        gap: "0.25rem 1rem",
        padding: "0.875rem 0",
        "border-top": "1px solid var(--rt-divider)",
      }}
    >
      <span
        style={{
          display: "inline-flex",
          "align-items": "center",
          gap: "0.5rem",
          flex: "0 0 8rem",
          font: "700 0.6875rem / 1.4 var(--rt-mono)",
          "letter-spacing": "0.1em",
          "text-transform": "uppercase",
          color: "var(--rt-muted)",
        }}
      >
        <ToneMarker tone={props.tone} />
        {props.label}
      </span>
      <span
        style={{
          flex: "1 1 12rem",
          "min-width": 0,
          "font-weight": 700,
          "overflow-wrap": "anywhere",
        }}
      >
        {props.children}
      </span>
    </div>
  );
}

function ToneRow(props: { tone: ToneName; words: (typeof WORDS)[Tone]; marker: Tone }) {
  return (
    <div
      class="rt-stack"
      style={{ "padding-block": "1rem", "border-top": "1px solid var(--rt-divider)" }}
    >
      <Notice tone={props.tone} title={props.words.title}>
        {props.words.body}
      </Notice>
      <div>
        <Status tone={props.tone}>{props.words.chip}</Status>
      </div>
      <Row tone={props.marker} label="Example">
        {props.words.line}
      </Row>
    </div>
  );
}

const meta = {
  title: "Lanes/UXKit/Tones",
  component: Frame,
  // Every story renders its own page; these are the props the component needs to be typed without them.
  args: { children: null },
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof Frame>;
export default meta;
type Story = StoryObj<typeof meta>;

function Everything() {
  return (
    <For each={TONES}>
      {(note) => (
        <section aria-labelledby={`tone-${note.tone}`} style={{ "margin-bottom": "2.5rem" }}>
          <h2
            id={`tone-${note.tone}`}
            style={{ margin: "0 0 0.25rem", "font-size": "1.25rem", "font-weight": 800 }}
          >
            {note.tone} <span class="rt-hint">({note.colour})</span>
          </h2>
          <p style={{ margin: "0 0 0.75rem", "font-weight": 600 }}>{note.means}</p>
          <p class="rt-hint" style={{ margin: 0 }}>
            <strong>For:</strong> {note.use}
          </p>
          <p class="rt-hint" style={{ margin: "0 0 0.5rem" }}>
            <strong>Never for:</strong> {note.never}
          </p>
          <ToneRow tone={note.tone} words={WORDS[note.tone]} marker={note.tone} />
        </section>
      )}
    </For>
  );
}

/** The four tones, each with what it means and, in that tone, a Notice, a Status chip and the marker of a
 * row in a list. */
export const Default: Story = {
  render: () => (
    <Frame>
      <Everything />
    </Frame>
  ),
};

/** A new book is not a list of warnings: nothing here is orange or red. What is true is calm, and what
 * has not been done yet is said as a fact. */
export const Empty: Story = {
  render: () => (
    <Frame>
      <Notice tone="calm" title="Nothing imported yet">
        Import a statement and its transactions will wait for you to review.
      </Notice>
      <Row tone="calm" label="Backups">
        Never backed up
      </Row>
      <Row tone="calm" label="Reconcile">
        No accounts to reconcile yet
      </Row>
    </Frame>
  ),
};

/** Waiting is not a problem and not a warning: it is said in words, in the quiet tone. */
export const Loading: Story = {
  render: () => (
    <Frame>
      <Notice tone="info" title="Reading your books" role="status">
        This takes a moment. Nothing is changed while it reads.
      </Notice>
    </Frame>
  ),
};

/** A failed read is the problem tone, said in words, with the marker that looks like a warning sign. */
export const ErrorState: Story = {
  render: () => (
    <Frame>
      <Notice tone="problem" title="Your backups could not be read" role="alert">
        Nothing was changed. Try again.
      </Notice>
      <Row tone="problem" label="Backups">
        The last backup did not verify
      </Row>
    </Frame>
  ),
};

/** Long words wrap in a Notice, a chip and a row alike. */
export const LongContent: Story = {
  render: () => (
    <Frame width="22rem">
      <Notice
        tone="attention"
        title="Pneumonoultramicroscopicsilicovolcanoconiosis Consulting Services Incorporated has 8 transactions waiting"
      >
        A long explanation that goes on for more than one line so that wrapping inside the notice
        can be seen on a phone.
      </Notice>
      <div style={{ margin: "1rem 0" }}>
        <Status tone="problem">Could not save</Status>
      </div>
      <Row tone="attention" label="For review">
        8 transactions from Pneumonoultramicroscopicsilicovolcanoconiosis are waiting for you
      </Row>
    </Frame>
  ),
};

/** The names used before the kit still work: neutral is calm, review is attention, error is problem. */
export const LegacyNames: Story = {
  render: () => (
    <Frame>
      <ToneRow tone="neutral" words={WORDS.calm} marker="calm" />
      <ToneRow tone="review" words={WORDS.attention} marker="attention" />
      <ToneRow tone="error" words={WORDS.problem} marker="problem" />
    </Frame>
  ),
};

/** The dark theme: blue and red lighten, orange and its black text stay as they are. */
export const Dark: Story = {
  render: () => (
    <Frame>
      <Everything />
    </Frame>
  ),
  decorators: [darkUnlessAsked],
};
