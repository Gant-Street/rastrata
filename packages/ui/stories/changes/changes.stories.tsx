import { createSignal, type JSX } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  ChangesWorkspace,
  DEFAULT_CHANGES_STATE,
  UiProvider,
  type ChangeListView,
  type ChangesLoad,
  type ChangesScreenState,
  type LookState,
} from "../../src";
import {
  accountantsView,
  ACCOUNTANT,
  hostile,
  hrefFor,
  listOf,
  lookedAtMarch,
  manyChanges,
  TODAY,
  NOW,
  nothingNew,
  recent,
  sinceTheLook,
  WEEKLY,
  ZONE,
} from "./fixtures";

const Frame = (props: { children: JSX.Element; dir?: "rtl" }) => (
  <UiProvider>
    <div class="rt-theme" dir={props.dir}>
      {props.children}
    </div>
  </UiProvider>
);

/** The screen with its choices working: a choice shows in the control, and "I have looked at these" goes
 * through saving to saved, as it does against the service. The list itself is the one the story gives. */
function Screen(props: {
  list?: ChangeListView;
  load?: ChangesLoad;
  busy?: boolean;
  failure?: string;
  state?: Partial<ChangesScreenState>;
  look?: LookState;
}) {
  const [state, setState] = createSignal<ChangesScreenState>({
    ...DEFAULT_CHANGES_STATE,
    ...props.state,
  });
  const [look, setLook] = createSignal<LookState>(props.look ?? { kind: "idle" });
  return (
    <ChangesWorkspace
      load={props.load ?? "ready"}
      busy={props.busy}
      list={props.list}
      failure={props.failure}
      state={state()}
      today={TODAY}
      timeZone={ZONE}
      look={look()}
      onChange={(patch) =>
        setState({ ...state(), ...patch, page: "page" in patch ? (patch.page ?? 1) : 1 })
      }
      onClear={() => setState({ ...state(), who: "", what: "", text: "", page: 1 })}
      onRetry={() => {}}
      onReload={() => {}}
      onLook={() => {
        setLook({ kind: "saving" });
        setTimeout(
          () => setLook({ kind: "saved", at: props.list?.asOf ?? NOW.toISOString() }),
          700,
        );
      }}
      hrefFor={hrefFor}
    />
  );
}

const meta = {
  title: "Lanes/Changes/Screen",
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** What happened since the owner last looked: an agent's weekly routine, an entry by hand and an
 * accountant closing March. The button says the owner has looked; nothing else on the page changes
 * the books. */
export const SinceYouLastLooked: Story = {
  render: () => (
    <Frame>
      <Screen list={sinceTheLook} />
    </Frame>
  ),
};

/** The books have never been marked as looked at: the list starts at the start of the books. Changes
 * made before the books recorded who made them say "not recorded", and the foot says from when makers
 * are known. */
export const WholeBookNeverLookedAt: Story = {
  render: () => (
    <Frame>
      <Screen list={listOf()} />
    </Frame>
  ),
};

/** Nothing has changed since the last look: it is said, with when they looked, and the way to see more. */
export const NothingNewSinceYouLooked: Story = {
  render: () => (
    <Frame>
      <Screen list={nothingNew} />
    </Frame>
  ),
};

/** A person who may not read who has access sees the list without that part, and is told so above the
 * list. They cannot say they have looked: what they did not see would never be shown to anyone. */
export const APartCouldNotBeRead: Story = {
  render: () => (
    <Frame>
      <Screen
        list={listOf({
          ...accountantsView,
          changes: recent.filter((item) => item.kind !== "access.granted"),
        })}
      />
    </Frame>
  ),
};

/** Choosing one maker narrows the list. A list that shows only some changes cannot be marked as looked at,
 * and the page says how to make it true. */
export const OnlyTheAgentsChanges: Story = {
  render: () => (
    <Frame>
      <Screen
        list={listOf({
          changes: recent.filter((item) => item.by.id === WEEKLY.id),
          beforeChoices: recent,
          actors: listOf().actors,
        })}
        state={{ since: "all", who: `agent@${WEEKLY.id}` }}
      />
    </Frame>
  ),
};

/** A list that starts after the books were last closed, when the last look was before that: it does not hold
 * everything that has not been looked at, so it cannot be marked, and the page offers the way to it. */
export const StartsAfterWhatWasNotLookedAt: Story = {
  render: () => (
    <Frame>
      <Screen
        list={listOf({
          changes: recent.slice(0, 3),
          since: "the last time a period was closed (Apr 1, 2026)",
          lastReview: { ...lookedAtMarch, upToRevision: "30", upToAt: "2026-03-25T18:00:00.000Z" },
          window: { sinceRevision: "46", sinceAt: "2026-04-01T17:20:00.000Z" },
        })}
        state={{ since: "close" }}
      />
    </Frame>
  ),
};

/** The same list seen by the accountant: "you" is the accountant, and the owner's changes are the owner's. */
export const SeenByTheAccountant: Story = {
  render: () => (
    <Frame>
      <Screen
        list={listOf({ ...accountantsView, caller: ACCOUNTANT, changes: recent.slice(0, 5) })}
      />
    </Frame>
  ),
};

/** Words that match nothing. */
export const NoChangeMatches: Story = {
  render: () => (
    <Frame>
      <Screen
        list={listOf({ changes: [], actors: [], since: "the start of the book" })}
        state={{ since: "all", text: "nothing like this" }}
      />
    </Frame>
  ),
};

/** A date the address carries is a choice too. */
export const StartingOnADate: Story = {
  render: () => (
    <Frame>
      <Screen
        list={listOf({
          changes: recent.slice(0, 7),
          since: "Mar 19, 2026 (UTC)",
          window: { sinceRevision: "40", sinceAt: "2026-03-19T00:00:00.000Z" },
        })}
        state={{ since: "2026-03-19" }}
      />
    </Frame>
  ),
};

/** Text from outside is shown as text. Markup, a formula, an instruction, a name that runs on without
 * a space and a name that reverses the line are all just words in the sentence. */
export const LongAndHostileText: Story = {
  render: () => (
    <Frame>
      <Screen list={listOf({ changes: hostile, since: "the start of the book" })} />
    </Frame>
  ),
};

/** The second of six pages. Every page is read at the same moment, so a page does not shift. */
export const ManyChanges: Story = {
  render: () => (
    <Frame>
      <Screen
        list={listOf({ changes: manyChanges(118), count: 143, page: 2 })}
        state={{ page: 2 }}
      />
    </Frame>
  ),
};

/** The address names a page past the end. */
export const PastTheEnd: Story = {
  render: () => (
    <Frame>
      <Screen list={listOf({ changes: [], count: 12, page: 9 })} state={{ page: 9 }} />
    </Frame>
  ),
};

export const Reading: Story = {
  render: () => (
    <Frame>
      <Screen load="loading" />
    </Frame>
  ),
};

/** A failed read is said, and is not an empty list. */
export const CouldNotBeRead: Story = {
  render: () => (
    <Frame>
      <Screen load="failed" failure="The service did not answer in time." />
    </Frame>
  ),
};

/** A newer list is being read; the old one stays on the screen a little quieter. */
export const ReadingAgain: Story = {
  render: () => (
    <Frame>
      <Screen list={sinceTheLook} busy />
    </Frame>
  ),
};

/** A read that fails after one succeeded keeps the old list and says it is old. */
export const CouldNotBeReadAgain: Story = {
  render: () => (
    <Frame>
      <Screen list={sinceTheLook} load="failed" failure="The service did not answer in time." />
    </Frame>
  ),
};

export const RightToLeft: Story = {
  render: () => (
    <Frame dir="rtl">
      <Screen list={sinceTheLook} />
    </Frame>
  ),
};

const look = (state: LookState): Story => ({
  render: () => (
    <Frame>
      <Screen list={sinceTheLook} look={state} />
    </Frame>
  ),
});

/** Saving: the button waits, and cannot be pressed twice. */
export const LookSaving: Story = look({ kind: "saving" });

/** Saved: said only after the service confirmed it. */
export const LookSaved: Story = look({ kind: "saved", at: "2026-04-02T15:25:00.000Z" });

/** The reply was lost. It is neither "saved" nor "not saved": the same request can be checked. */
export const LookNotKnown: Story = look({ kind: "uncertain" });

/** Someone looked at newer changes while the page was open. */
export const LookSomeoneElseLooked: Story = look({ kind: "stale" });

export const LookListWasIncomplete: Story = look({ kind: "incomplete" });

export const LookNotAllowed: Story = look({ kind: "denied" });

export const LookNotSaved: Story = look({ kind: "failed" });
