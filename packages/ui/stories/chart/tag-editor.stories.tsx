import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  type AccountView,
  TagEditor,
  type TagChange,
  type TagEvent,
  type TagResult,
  type TaxFormChoice,
} from "../../src";
import { accountViews as accounts, lineText, scheduleC } from "./fixtures";
import { Frame } from "./frame";

// ---- The tag editor ----------------------------------------------------------------------

const forms: TaxFormChoice[] = [scheduleC];
const history: TagEvent[] = [
  {
    tag: "taxLine",
    effectiveOn: "2026-01-01",
    value: "scheduleC.line27b",
    source: "setup",
    recordedAt: "2026-01-02T09:00:00Z",
  },
  {
    tag: "taxLine",
    effectiveOn: "2026-07-01",
    value: "scheduleC.line18",
    source: "change",
    recordedAt: "2026-06-20T12:30:00Z",
  },
  {
    tag: "roleKey",
    effectiveOn: "2026-07-01",
    value: null,
    source: "change",
    recordedAt: "2026-06-20T12:31:00Z",
  },
];

function Editor(props: {
  account: AccountView;
  history?: TagEvent[] | null;
  saving?: boolean;
  error?: string;
  result?: TagResult | null;
  uncertain?: boolean;
  closed?: { label: string; startsOn: string; endsOn: string }[];
  today?: string;
}) {
  const [last, setLast] = createSignal<TagChange | null>(null);
  return (
    <Frame>
      <div style={{ "max-width": "32rem" }}>
        <TagEditor
          account={props.account}
          taxForms={forms}
          taxLineText={lineText}
          today={props.today ?? "2026-10-04"}
          closedPeriods={props.closed ?? []}
          history={props.history === undefined ? history : props.history}
          saving={props.saving ?? false}
          {...(props.error ? { error: props.error } : {})}
          result={props.result ?? null}
          uncertain={props.uncertain ?? false}
          onSave={setLast}
          onResume={() => undefined}
          onClose={() => undefined}
        />
        <output class="rt-hint" aria-label="Last change sent">
          {last() ? JSON.stringify(last()) : "Nothing sent yet"}
        </output>
      </div>
    </Frame>
  );
}

const meta = {
  title: "Lanes/Chart/Tag editor",
  component: Editor,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Edit the tags of one account from a date. The date says which reports change, and the editor warns before saving when it reaches into a closed period. Only the tag that applies to the account's type is offered, plus the role key.",
      },
    },
  },
} satisfies Meta<typeof Editor>;

export default meta;

export const TaxLineForAnExpense: StoryObj<typeof Editor> = {
  render: () => <Editor account={accounts[13] as AccountView} />,
};

export const CashFlowClassForABankAccount: StoryObj<typeof Editor> = {
  render: () => <Editor account={accounts[0] as AccountView} history={[]} />,
};

export const ReachesAClosedPeriod: StoryObj<typeof Editor> = {
  render: () => (
    <Editor
      account={accounts[11] as AccountView}
      today="2026-01-15"
      closed={[{ label: "January", startsOn: "2026-01-01", endsOn: "2026-01-31" }]}
    />
  ),
};

export const Saved: StoryObj<typeof Editor> = {
  render: () => (
    <Editor
      account={accounts[11] as AccountView}
      result={{ changed: true, effectiveOn: "2026-10-04", warnings: [] }}
    />
  ),
};

export const SavedWithAWarning: StoryObj<typeof Editor> = {
  render: () => (
    <Editor
      account={accounts[11] as AccountView}
      result={{
        changed: true,
        effectiveOn: "2026-01-15",
        warnings: [
          "This takes effect in closed period (January, 2026-01-01 to 2026-01-31). Reports for it will differ from the ones recorded when it was closed. Start the tag after the last closed period to leave them as they were.",
        ],
      }}
    />
  ),
};

export const NothingChanged: StoryObj<typeof Editor> = {
  render: () => (
    <Editor
      account={accounts[11] as AccountView}
      result={{ changed: false, effectiveOn: "2026-10-04", warnings: [] }}
    />
  ),
};

export const Refused: StoryObj<typeof Editor> = {
  render: () => (
    <Editor
      account={accounts[0] as AccountView}
      error="Role key stripe.balance is on account 1100 (Stripe balance). A role key names one account: clear it there first."
    />
  ),
};

export const Saving: StoryObj<typeof Editor> = {
  render: () => <Editor account={accounts[11] as AccountView} saving />,
};

/** The reply was lost: the change may have been saved, so the original request is resumed, never replaced. */
export const ReplyLost: StoryObj<typeof Editor> = {
  render: () => (
    <Editor
      account={accounts[11] as AccountView}
      uncertain
      error="The result is uncertain. Resume the original request; do not create a replacement."
    />
  ),
};

export const HistoryLoading: StoryObj<typeof Editor> = {
  render: () => <Editor account={accounts[11] as AccountView} history={null} />,
};

export const UnknownCurrentLine: StoryObj<typeof Editor> = {
  render: () => <Editor account={accounts[14] as AccountView} />,
};

export const EditorRightToLeft: StoryObj<typeof Editor> = {
  render: () => (
    <Frame locale="ar">
      <div style={{ "max-width": "32rem" }}>
        <TagEditor
          account={accounts[11] as AccountView}
          taxForms={forms}
          taxLineText={lineText}
          today="2026-10-04"
          closedPeriods={[]}
          history={history}
          onSave={() => undefined}
          onResume={() => undefined}
          onClose={() => undefined}
        />
      </div>
    </Frame>
  ),
};
