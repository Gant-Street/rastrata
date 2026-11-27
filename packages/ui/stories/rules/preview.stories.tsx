import { createSignal, type JSX } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  type RulePreviewData,
  type RulePreviewState,
  RulePreview,
  type RuleTryResult,
  RuleTryLine,
  UiProvider,
} from "../../src";
import { lineAccounts, previewNone, previewReady, previewTruncated } from "./fixtures";

const Frame = (props: { children: JSX.Element }) => (
  <UiProvider>
    <div class="rt-theme rt-rules-page" style={{ "max-width": "26rem" }}>
      {props.children}
    </div>
  </UiProvider>
);

function Preview(props: {
  state: RulePreviewState;
  data?: RulePreviewData | null;
  children?: JSX.Element;
}) {
  const [days, setDays] = createSignal(90);
  return (
    <RulePreview
      state={props.state}
      data={props.data}
      days={days()}
      dayChoices={[30, 90, 180, 365]}
      onDays={setDays}
      onRetry={() => {}}
    >
      {props.children}
    </RulePreview>
  );
}

function Try(props: { result?: RuleTryResult | null; problem?: string; open?: boolean }) {
  const [values, setValues] = createSignal({
    description: "GITHUB, INC. SAN FRANCISCO CA 4829104",
    counterparty: "",
    amount: "-21.00",
    accountId: "",
  });
  return (
    <RuleTryLine
      values={values()}
      onChange={setValues}
      accounts={lineAccounts}
      onRun={() => {}}
      problem={props.problem}
      result={props.result ?? null}
      open={props.open ?? true}
    />
  );
}

const meta = {
  title: "Lanes/Rules/Preview",
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Idle: Story = {
  render: () => (
    <Frame>
      <Preview state="idle" />
    </Frame>
  ),
};

export const Incomplete: Story = {
  render: () => (
    <Frame>
      <Preview state="incomplete" />
    </Frame>
  ),
};

export const Checking: Story = {
  render: () => (
    <Frame>
      <Preview state="loading" />
    </Frame>
  ),
};

/** The last answer stays while the next is worked out, marked as being checked again. */
export const CheckingAgain: Story = {
  render: () => (
    <Frame>
      <Preview state="loading" data={previewReady} />
    </Frame>
  ),
};

/** Matches, where past bookings agree and where one does not, the lines an earlier rule takes, a
 * line the rule cannot be applied to, and samples showing the entry the rule would suggest. */
export const Matches: Story = {
  render: () => (
    <Frame>
      <Preview state="ready" data={previewReady} />
    </Frame>
  ),
};

export const NoMatches: Story = {
  render: () => (
    <Frame>
      <Preview state="ready" data={previewNone} />
    </Frame>
  ),
};

export const TruncatedInbox: Story = {
  render: () => (
    <Frame>
      <Preview state="ready" data={previewTruncated} />
    </Frame>
  ),
};

export const CouldNotCheck: Story = {
  render: () => (
    <Frame>
      <Preview state="error" />
    </Frame>
  ),
};

export const TryALineApplies: Story = {
  render: () => (
    <Frame>
      <Try
        result={{
          outcome: "applies",
          held: ["description contains “github”", "direction is out"],
          missed: [],
          wouldBook: [{ account: "6100 · Software", amount: "21.00" }],
          kind: "booking it to an account",
          narration: "Software: GitHub",
        }}
      />
    </Frame>
  ),
};

export const TryALineDoesNotMatch: Story = {
  render: () => (
    <Frame>
      <Try
        result={{
          outcome: "no_match",
          held: ["direction is out"],
          missed: ["description contains “github”"],
          wouldBook: [],
        }}
      />
    </Frame>
  ),
};

export const TryALineTakenByAnEarlierRule: Story = {
  render: () => (
    <Frame>
      <Try
        result={{
          outcome: "shadowed",
          detail: "Software (general)",
          held: ["description contains “github”"],
          missed: [],
          wouldBook: [],
        }}
      />
    </Frame>
  ),
};

export const TryALineCannotApply: Story = {
  render: () => (
    <Frame>
      <Try
        result={{
          outcome: "unusable",
          detail: "6150 Subscriptions is closed",
          held: ["description contains “github”"],
          missed: [],
          wouldBook: [],
        }}
      />
    </Frame>
  ),
};

export const TryALineProblem: Story = {
  render: () => (
    <Frame>
      <Try problem="Complete the rule first, then try a line." />
    </Frame>
  ),
};

/** A pasted memo is data: markup, long unbroken text and right-to-left text are shown as text. */
export const HostileText: Story = {
  render: () => (
    <Frame>
      <Try
        result={{
          outcome: "applies",
          held: [
            "description contains “<img src=x onerror=alert(1)> {{amount}} $(rm -rf /) ' OR 1=1 --”",
          ],
          missed: [],
          wouldBook: [{ account: "6100 · <b>Software</b>", amount: "21.00" }],
          kind: "booking it to an account",
          narration: "<script>alert(1)</script> WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW",
        }}
      />
    </Frame>
  ),
};
