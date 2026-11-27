import { createSignal, type JSX } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  blankRuleCondition,
  blankRuleDraft,
  type FormError,
  Notice,
  type RuleDraft,
  RuleForm,
  type RulePreviewState,
  RulePreview,
  type RuleSplitPreview,
  type RuleTryResult,
  RuleTryLine,
  UiProvider,
} from "../../src";
import {
  expenseAccounts,
  githubDraft,
  groupedDraft,
  lineAccounts,
  previewReady,
  splitDraft,
  transferAccounts,
} from "./fixtures";

const Frame = (props: { children: JSX.Element }) => (
  <UiProvider>
    <div class="rt-theme rt-rules-page">{props.children}</div>
  </UiProvider>
);

const splitExample: RuleSplitPreview = {
  total: "120.00",
  parts: [
    { account: "6300 · Meals", amount: "72.00" },
    { account: "6900 · Personal (owner draw)", amount: "48.00" },
  ],
};

/** The editor with its draft held in a signal, as the real page holds it, so every control can be
 * driven by hand. Nothing here talks to a service. */
function Editor(props: {
  initial: () => RuleDraft;
  mode?: "new" | "edit";
  errors?: Readonly<Record<string, string>>;
  summary?: readonly FormError[];
  preview?: RulePreviewState;
  split?: RuleSplitPreview | null;
  saving?: boolean;
  locked?: boolean;
  banner?: JSX.Element;
  narrationExample?: string;
  tryResult?: RuleTryResult | null;
  tryOpen?: boolean;
}) {
  const [draft, setDraft] = createSignal(props.initial());
  const [amount, setAmount] = createSignal("120.00");
  const [days, setDays] = createSignal(90);
  const [values, setValues] = createSignal({
    description: "",
    counterparty: "",
    amount: "",
    accountId: "",
  });
  return (
    <RuleForm
      mode={props.mode ?? "new"}
      draft={draft()}
      onChange={setDraft}
      errors={props.errors ?? {}}
      summary={props.summary ?? []}
      attempt={props.summary?.length ? 1 : 0}
      accounts={expenseAccounts}
      transferAccounts={transferAccounts}
      lineAccounts={lineAccounts}
      split={{ amount: amount(), onAmount: setAmount, preview: props.split ?? null }}
      narrationExample={props.narrationExample}
      banner={props.banner}
      saving={props.saving}
      locked={props.locked}
      cancelHref="/rules"
      onSubmit={() => {}}
      onDelete={props.mode === "edit" ? () => {} : undefined}
      aside={
        <RulePreview
          state={props.preview ?? "ready"}
          data={previewReady}
          days={days()}
          dayChoices={[30, 90, 180, 365]}
          onDays={setDays}
        >
          <RuleTryLine
            values={values()}
            onChange={setValues}
            accounts={lineAccounts}
            onRun={() => {}}
            result={props.tryResult ?? null}
            open={props.tryOpen}
          />
        </RulePreview>
      }
    />
  );
}

const meta = {
  title: "Lanes/Rules/Editor",
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** A new rule starts with one empty condition. The check beside it waits until the rule can be
 * checked. */
export const NewRule: Story = {
  render: () => (
    <Frame>
      <Editor initial={blankRuleDraft} preview="incomplete" />
    </Frame>
  ),
};

/** Text conditions are compared without regard to case, accents or punctuation; the how list says
 * "does not contain" and the rest in words. */
export const Categorize: Story = {
  render: () => (
    <Frame>
      <Editor
        initial={githubDraft}
        mode="edit"
        narrationExample="Software: GitHub"
        tryOpen
        tryResult={{
          outcome: "applies",
          held: ["description contains “github”", "direction is out"],
          missed: [],
          wouldBook: [
            { account: "1010 · Checking", amount: "-21.00" },
            { account: "6100 · Software", amount: "21.00" },
          ],
          kind: "booking it to an account",
          narration: "Software: GitHub",
        }}
      />
    </Frame>
  ),
};

/** The split shows the exact cents of an example amount; the part that takes the rest gets any
 * cents the rounding leaves, so the parts always add up. */
export const Split: Story = {
  render: () => (
    <Frame>
      <Editor initial={splitDraft} split={splitExample} />
    </Frame>
  ),
};

export const SplitThatDoesNotAddUp: Story = {
  render: () => (
    <Frame>
      <Editor
        initial={() => {
          const draft = splitDraft();
          return {
            ...draft,
            action: {
              ...draft.action,
              parts: draft.action.parts.map((part, index) =>
                index === 1 ? { ...part, kind: "percent" as const, value: "30" } : part,
              ),
            },
          };
        }}
        errors={{
          "action.allocations":
            "The percentages add up to 90.00; they must total 100.00, or one part must take the rest",
        }}
        summary={[
          {
            id: "rule-action-allocations",
            message:
              "The percentages add up to 90.00; they must total 100.00, or one part must take the rest",
          },
        ]}
        split={{
          problem:
            "The percentages add up to 90.00; they must total 100.00, or one part must take the rest",
        }}
      />
    </Frame>
  ),
};

/** Groups hold the cases that need both: here, a large amount on either of two cloud providers,
 * but not on the retail account. The rule is limited to two accounts. */
export const GroupsAndScope: Story = {
  render: () => (
    <Frame>
      <Editor initial={groupedDraft} mode="edit" />
    </Frame>
  ),
};

export const Transfer: Story = {
  render: () => (
    <Frame>
      <Editor
        initial={() => ({
          ...githubDraft(),
          name: "Card payments",
          conditions: [
            { ...blankRuleCondition("description"), op: "contains", value: "payment thank you" },
          ],
          action: { ...blankRuleDraft().action, kind: "transfer", accountId: "acct-2100" },
        })}
      />
    </Frame>
  ),
};

export const Exclude: Story = {
  render: () => (
    <Frame>
      <Editor
        initial={() => {
          const draft = githubDraft();
          return {
            ...draft,
            name: "Personal transfers",
            action: {
              ...draft.action,
              kind: "exclude",
              accountId: "",
              narration: "",
              reason: "Personal, not a business transaction",
            },
          };
        }}
      />
    </Frame>
  ),
};

/** A failed save lists every problem in a summary that takes focus and links to the control each is
 * about; each control says what is wrong beside it, and everything valid stays where it was typed. */
export const WithProblems: Story = {
  render: () => (
    <Frame>
      <Editor
        initial={() => ({
          ...blankRuleDraft(),
          conditions: [
            { ...blankRuleCondition("description"), op: "contains", value: "" },
            { ...blankRuleCondition("amount"), op: "between", min: "12", max: "" },
          ],
        })}
        preview="incomplete"
        errors={{
          name: "Give the rule a name",
          "conditions[0].value":
            "Enter some text with at least one letter or digit; punctuation alone matches nothing",
          "conditions[1].min": "Enter the smallest amount with two decimals, for example 10.00",
          "action.accountId": "Choose an account",
        }}
        summary={[
          { id: "rule-name", message: "Give the rule a name" },
          {
            id: "rule-conditions-0-value",
            message:
              "Enter some text with at least one letter or digit; punctuation alone matches nothing",
          },
          {
            id: "rule-conditions-1-min",
            message: "Enter the smallest amount with two decimals, for example 10.00",
          },
          { id: "rule-action-accountId", message: "Choose an account" },
        ]}
      />
    </Frame>
  ),
};

/** The rule is being saved: nothing can be changed and the button says so. */
export const Saving: Story = {
  render: () => (
    <Frame>
      <Editor initial={githubDraft} mode="edit" saving />
    </Frame>
  ),
};

/** A retired rule can be read but not edited. */
export const Retired: Story = {
  render: () => (
    <Frame>
      <Editor
        initial={githubDraft}
        mode="edit"
        locked
        banner={
          <Notice title="This rule has been deleted" tone="review" role="status">
            <p>It no longer suggests anything and cannot be edited.</p>
          </Notice>
        }
      />
    </Frame>
  ),
};

export const StartedFromInboxLine: Story = {
  render: () => (
    <Frame>
      <Editor
        initial={githubDraft}
        banner={
          <Notice title="Started from a transaction" tone="info" role="status">
            <p>
              This rule was drafted from “GITHUB, INC. SAN FRANCISCO CA 4829104”. Check it before
              saving.
            </p>
          </Notice>
        }
      />
    </Frame>
  ),
};

/** A rule limited to some accounts lists the bank accounts to choose from. */
export const LimitedToAnAccount: Story = {
  render: () => (
    <Frame>
      <Editor
        initial={() => ({ ...githubDraft(), scope: "some", accountIds: ["acct-1010"] })}
        errors={{ accountIds: "Limit a rule to at most 50 accounts, or leave it for all" }}
      />
    </Frame>
  ),
};
