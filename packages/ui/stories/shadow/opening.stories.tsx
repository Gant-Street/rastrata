import { createSignal, type JSX } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  CutoverStep,
  OpeningBalanceTable,
  OpeningEntryReview,
  OpeningIssueList,
  OpeningScreen,
  type OpeningScreenProps,
  UiProvider,
} from "../../src";
import { accounts, entry, issues, prepared, reviewed, screen, sections, sources } from "./fixtures";

const Frame = (props: { children: JSX.Element }) => (
  <UiProvider>
    <div class="rt-theme">{props.children}</div>
  </UiProvider>
);

const meta = {
  title: "Lanes/Shadow/Opening balances",
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const show = (props: OpeningScreenProps): Story => ({
  render: () => (
    <Frame>
      <OpeningScreen {...props} />
    </Frame>
  ),
});

/** A fresh book: the cutover date is recorded, no balance is typed and nothing can be reviewed. */
export const Empty: Story = show(screen.empty);

/** Balances typed. The offset is calculated and shown as its own row; the totals agree. */
export const Typing: Story = show(screen.typing);

/** An amount that cannot be read says why beside its field. The review stays closed until each is
 * fixed, and says how many there are. */
export const AmountProblems: Story = show({
  ...screen.typing,
  balances: {
    ...screen.typing.balances,
    sections: sections({ "1000": "12,000.00", "1010": "25oo.25", "2000": "523.105" }).map(
      (section) => ({
        ...section,
        rows: section.rows.map((row) =>
          row.id === "1010"
            ? {
                ...row,
                debit: "",
                credit: "",
                error:
                  "Enter an amount such as 1,234.56. Use a minus sign or brackets for the unusual side. Amounts are never rounded: use two decimal places at most.",
              }
            : row.id === "2000"
              ? {
                  ...row,
                  debit: "",
                  credit: "",
                  error:
                    "Enter an amount such as 1,234.56. Use a minus sign or brackets for the unusual side. Amounts are never rounded: use two decimal places at most.",
                }
              : row,
        ),
      }),
    ),
    problems: 2,
  },
});

/** The cutover date has not been recorded, so the review is not offered yet. */
export const CutoverNotRecorded: Story = show({
  ...screen.typing,
  cutover: { ...screen.typing.cutover, recorded: null, unchanged: false },
});

/** No account is named for opening balances: the person chooses the equity account that carries the
 * difference. */
export const OffsetToChoose: Story = show({
  ...screen.typing,
  balances: {
    ...screen.typing.balances,
    offset: null,
    offsetRequired: true,
    offsetChoices: [
      { value: "3000", label: "3000 · Owner's investment" },
      { value: "3100", label: "3100 · Owner's draw" },
    ],
    totals: { debit: "15800.75", credit: "598.10" },
  },
});

/** The review: the exact entry, the calculated offset, the totals, and a warning to look at. */
export const Reviewed: Story = show(reviewed);

/** Errors name their row or account; an error that names an account links to its field. */
export const ReviewedWithErrors: Story = show({
  ...screen.typing,
  review: {
    stage: "reviewed",
    stale: false,
    entry: null,
    issues,
    valid: false,
    onReview: () => {},
  },
});

/** The balances changed after the review: the old entry is marked stale and cannot be prepared. */
export const ReviewStale: Story = show({
  ...reviewed,
  review: { ...reviewed.review, stale: true },
});

export const Reviewing: Story = show({
  ...screen.typing,
  review: { ...screen.typing.review, stage: "reviewing" },
});

/** Prepared: the ledger has checked the exact entry. Nothing is posted until Post is chosen. */
export const Prepared: Story = show(prepared);

export const PreparedWithWarnings: Story = show({
  ...prepared,
  plan: {
    ...prepared.plan,
    warnings: ["The period October 2026 has ended and is still open."],
  },
});

/** The ledger would refuse the entry: Post is disabled and the reasons are listed. */
export const PreparedButRefused: Story = show({
  ...prepared,
  plan: {
    ...prepared.plan,
    valid: false,
    problems: ["Period November is closed. Reopen it before posting into it."],
  },
});

export const Posting: Story = show({
  ...prepared,
  post: { pending: true, done: false, onPost: () => {} },
});

export const PostRefused: Story = show({
  ...prepared,
  post: {
    pending: false,
    done: false,
    error: "The ledger refused the entry: the plan no longer matches the book.",
    onPost: () => {},
  },
});

/** Posted: the entry is read-only, the cutover date is locked and the next steps are listed. */
export const Posted: Story = show({
  ...screen.empty,
  opening: { status: "posted", date: "2026-10-31", entryHref: "/journal/source-8f2c" },
  cutover: { ...screen.empty.cutover, locked: true },
});

/** Entered by hand, as one journal against Opening balance equity before the cutover: it counts as the
 * opening entry, a second one is not offered, and the date is not locked. */
export const PostedByHand: Story = show({
  ...screen.empty,
  opening: { status: "posted", date: "2026-10-31", byHand: true, entryHref: "/journal/j-4417" },
});

/** Posted from this screen just now: the confirmation takes the focus and says what was done. */
export const PostedJustNow: Story = show({
  ...screen.empty,
  opening: { status: "posted", date: "2026-10-31", entryHref: "/journal/source-8f2c" },
  cutover: { ...screen.empty.cutover, locked: true },
  post: { pending: false, done: true, onPost: () => {} },
});

export const Reversed: Story = show({ ...screen.typing, opening: { status: "reversed" } });

export const PlannedNotPosted: Story = show({ ...reviewed, opening: { status: "planned" } });

/** The reply to a write was lost. Resuming the original request is the only thing offered. */
export const Uncertain: Story = show({ ...screen.typing, uncertain: { resuming: false } });

export const Resuming: Story = show({ ...screen.typing, uncertain: { resuming: true } });

export const Loading: Story = show({ ...screen.empty, state: "loading" });

/** Opened before the books are set up: not an error, and the way forward. */
export const NoBook: Story = show({ ...screen.empty, state: "error", noBook: true });

export const LoadFailed: Story = show({ ...screen.empty, state: "error", onRetry: () => {} });

/** A file was read: it says how many balances it filled. */
export const FileRead: Story = show({
  ...screen.typing,
  balances: {
    ...screen.typing.balances,
    file: { reading: false, message: "Read 5 balances from opening-balances.csv." },
  },
});

export const FileFailed: Story = show({
  ...screen.typing,
  balances: {
    ...screen.typing.balances,
    file: {
      reading: false,
      error: 'Row 8: No account has the code "9999". Add the account, or fix the code.',
    },
  },
});

/** A hundred and fifty accounts: the table scrolls inside its own box and stays usable. */
export const ManyAccounts: Story = show({
  ...screen.empty,
  balances: {
    ...screen.empty.balances,
    sections: [
      {
        id: "assets",
        title: "Assets",
        rows: Array.from({ length: 150 }, (_, index) => ({
          id: `a${index}`,
          code: String(1000 + index),
          name: `Account number ${index + 1}`,
          role: "asset" as const,
          value: "",
          debit: "",
          credit: "",
        })),
      },
    ],
  },
});

/** Hostile and very long text is data: shown as text, wrapped, never as markup. */
export const LongAndHostileNames: Story = show({
  ...screen.typing,
  balances: {
    ...screen.typing.balances,
    sections: [
      {
        id: "assets",
        title: "Assets",
        rows: [
          {
            id: "1000",
            code: "1000",
            name: "<img src=x onerror=alert(1)> Operating account at a bank with a very long name that keeps going and going and going",
            role: "asset",
            value: "100.00",
            debit: "100.00",
            credit: "",
          },
          {
            id: "1010",
            code: "1010",
            name: '=HYPERLINK("http://example.invalid", "click")',
            role: "asset",
            value: "",
            debit: "",
            credit: "",
          },
        ],
      },
    ],
  },
});

// ---- Parts -----------------------------------------------------------------------------------

export const BalanceTableAlone: Story = {
  render: () => (
    <Frame>
      <OpeningBalanceTable
        sections={sections({ "1000": "12,000.00", "2000": "523.10" })}
        offset={{
          code: "3900",
          name: "Opening balance equity",
          side: "credit",
          amount: "11476.90",
        }}
        entered={{ debit: "12000.00", credit: "523.10" }}
        totals={{ debit: "12000.00", credit: "12000.00" }}
        onInput={() => {}}
        onBlur={() => {}}
        onToggle={() => {}}
      />
    </Frame>
  ),
};

/** Interactive: Down and Enter move to the next amount, Up to the previous one. */
export const BalanceTableKeyboard: Story = {
  render: () => {
    const [open, setOpen] = createSignal(false);
    const [values, setValues] = createSignal<Record<string, string>>({});
    return (
      <Frame>
        <OpeningBalanceTable
          sections={sections(values()).map((section) => ({
            ...section,
            collapsed: section.collapsible ? !open() : false,
          }))}
          offset={null}
          entered={{ debit: "0.00", credit: "0.00" }}
          totals={{ debit: "0.00", credit: "0.00" }}
          onInput={(id, value) => setValues({ ...values(), [id]: value })}
          onBlur={() => {}}
          onToggle={() => setOpen(!open())}
        />
      </Frame>
    );
  },
};

export const EntryAlone: Story = {
  render: () => (
    <Frame>
      <OpeningEntryReview entry={entry} />
    </Frame>
  ),
};

export const EntryThatDoesNotBalance: Story = {
  render: () => (
    <Frame>
      <OpeningEntryReview entry={{ ...entry, credit: "15800.74", balanced: false }} />
    </Frame>
  ),
};

export const IssuesAlone: Story = {
  render: () => (
    <Frame>
      <OpeningIssueList issues={issues} />
    </Frame>
  ),
};

export const CutoverStepDefault: Story = {
  render: () => (
    <Frame>
      <CutoverStep
        date="2026-11-01"
        accounts={accounts}
        sources={[]}
        recorded={null}
        locked={false}
        onDate={() => {}}
        onToggle={() => {}}
        onSubmit={() => {}}
      />
    </Frame>
  ),
};

/** What the date would do to each kind of source, before it is recorded. */
export const CutoverStepWithEffects: Story = {
  render: () => (
    <Frame>
      <CutoverStep
        date="2026-11-01"
        accounts={accounts}
        sources={sources}
        recorded={{ date: "2026-10-15", recordedAt: "2026-10-16T08:00:00.000Z", by: "owner" }}
        locked={false}
        stripeNote="Stripe's first day is Jun 1, 2026. Recording the start date moves it to Nov 1, 2026, because nothing has been imported from Stripe yet."
        notes={[
          "No account is marked as having statements, so no import source starts on the date.",
        ]}
        onDate={() => {}}
        onToggle={() => {}}
        onSubmit={() => {}}
      />
    </Frame>
  ),
};

export const CutoverStepRecorded: Story = {
  render: () => (
    <Frame>
      <CutoverStep
        date="2026-11-01"
        accounts={accounts}
        sources={sources
          .slice(0, 2)
          .map((source) => ({ ...source, action: "unchanged", after: null }))}
        recorded={{ date: "2026-11-01", recordedAt: "2026-11-02T09:15:00.000Z", by: "owner" }}
        locked={false}
        unchanged
        onDate={() => {}}
        onToggle={() => {}}
        onSubmit={() => {}}
      />
    </Frame>
  ),
};

export const CutoverStepLocked: Story = {
  render: () => (
    <Frame>
      <CutoverStep
        date="2026-11-01"
        accounts={accounts}
        sources={sources
          .slice(0, 2)
          .map((source) => ({ ...source, action: "unchanged", after: null }))}
        recorded={{ date: "2026-11-01", recordedAt: "2026-11-02T09:15:00.000Z", by: "owner" }}
        locked
        onDate={() => {}}
        onToggle={() => {}}
        onSubmit={() => {}}
      />
    </Frame>
  ),
};

export const CutoverStepError: Story = {
  render: () => (
    <Frame>
      <CutoverStep
        date="2025-12-31"
        dateError="The book's calendar runs from Jan 1, 2026 to Dec 31, 2026; Dec 31, 2025 is outside it."
        accounts={accounts}
        sources={[]}
        recorded={null}
        locked={false}
        error="The start date could not be recorded: the book's calendar runs from Jan 1, 2026 to Dec 31, 2026."
        onDate={() => {}}
        onToggle={() => {}}
        onSubmit={() => {}}
      />
    </Frame>
  ),
};

export const CutoverStepPending: Story = {
  render: () => (
    <Frame>
      <CutoverStep
        date="2026-11-01"
        accounts={accounts}
        sources={sources}
        previewing
        pending
        recorded={null}
        locked={false}
        onDate={() => {}}
        onToggle={() => {}}
        onSubmit={() => {}}
      />
    </Frame>
  ),
};

export const CutoverStepNoAccounts: Story = {
  render: () => (
    <Frame>
      <CutoverStep
        date=""
        accounts={[]}
        sources={[]}
        recorded={null}
        locked={false}
        onDate={() => {}}
        onToggle={() => {}}
        onSubmit={() => {}}
      />
    </Frame>
  ),
};

/** Right to left: the layout mirrors and amounts stay left to right. */
export const RightToLeft: Story = {
  render: () => (
    <UiProvider>
      <div class="rt-theme" dir="rtl" lang="ar">
        <OpeningScreen {...reviewed} />
      </div>
    </UiProvider>
  ),
};
