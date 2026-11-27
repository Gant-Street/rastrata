import type { JSX } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  GapsScreen,
  type GapsScreenProps,
  TieoutScreen,
  type TieoutScreenProps,
  UiProvider,
  XeroScreen,
  type XeroScreenProps,
} from "../../src";
import { gapsScreen, tieoutScreen, xeroScreen } from "./xero-fixtures";

const Frame = (props: { children: JSX.Element }) => (
  <UiProvider>
    <div class="rt-theme">{props.children}</div>
  </UiProvider>
);

const meta = {
  title: "Lanes/Shadow/Xero",
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const gaps = (props: GapsScreenProps): Story => ({
  render: () => (
    <Frame>
      <GapsScreen {...props} />
    </Frame>
  ),
});
const tieout = (props: TieoutScreenProps): Story => ({
  render: () => (
    <Frame>
      <TieoutScreen {...props} />
    </Frame>
  ),
});
const xero = (props: XeroScreenProps): Story => ({
  render: () => (
    <Frame>
      <XeroScreen {...props} />
    </Frame>
  ),
});

// ---- The gap log ----------------------------------------------------------------------------------

/** Three gaps are open: two found by the comparison, one added by hand. */
export const GapsOpen: Story = gaps(gapsScreen.open);
/** The closed gaps keep what was found and who closed them, and can be reopened. */
export const GapsClosed: Story = gaps(gapsScreen.closed);
export const GapsAll: Story = gaps(gapsScreen.all);
/** Nothing found yet. */
export const GapsNone: Story = gaps(gapsScreen.none);
/** Every gap has been closed: the move is done when the checklist agrees. */
export const GapsAllClear: Story = gaps(gapsScreen.allClear);
export const GapAddFormFilled: Story = gaps(gapsScreen.adding);
export const GapTitleMissing: Story = gaps(gapsScreen.titleMissing);
export const GapCloseRefused: Story = gaps(gapsScreen.closeFailed);
export const GapBusy: Story = gaps(gapsScreen.busy);
export const GapsUncertain: Story = gaps(gapsScreen.uncertain);
export const GapsLoading: Story = gaps(gapsScreen.loading);
export const GapsLoadFailed: Story = gaps(gapsScreen.failed);
/** Opened before the books are set up: not an error, and the way forward. */
export const GapsNoBook: Story = gaps(gapsScreen.noBook);

// ---- The comparison -------------------------------------------------------------------------------

/** Two periods: July matches, August does not and says which lines explain it. */
export const Comparison: Story = tieout(tieoutScreen.report);
export const ComparisonRecorded: Story = tieout(tieoutScreen.recorded);
/** Nothing from Xero covers a month Xero reconciled: the screen says what is missing, not "all clear". */
export const NothingComparable: Story = tieout(tieoutScreen.nothingComparable);
export const ToleranceProblem: Story = tieout(tieoutScreen.toleranceProblem);
export const Comparing: Story = tieout(tieoutScreen.running);
export const RecordFailed: Story = tieout(tieoutScreen.recordFailed);
export const ComparisonUncertain: Story = tieout(tieoutScreen.uncertain);
export const ComparisonLoading: Story = tieout(tieoutScreen.loading);
export const ComparisonLoadFailed: Story = tieout(tieoutScreen.failed);
export const ComparisonNoBook: Story = tieout(tieoutScreen.noBook);

// ---- The Xero import ------------------------------------------------------------------------------

/** Nothing imported yet. */
export const ImportEmpty: Story = xero(xeroScreen.empty);
/** A chart, a trial balance and a month of transactions read and shown, with what needs a decision first. */
export const ImportRead: Story = xero(xeroScreen.imported);
/** One account nothing resembled was mapped from the keyboard; the choice shows what was chosen. */
export const ImportDecided: Story = xero(xeroScreen.decided);
export const ImportUncertain: Story = xero(xeroScreen.uncertain);
export const ImportNoBook: Story = xero(xeroScreen.noBook);
export const ImportLoading: Story = xero({ ...xeroScreen.empty, state: "loading", status: null });
export const ImportLoadFailed: Story = xero({
  ...xeroScreen.empty,
  state: "error",
  status: null,
  onRetry: () => {},
});
