import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { BankTileBand, type BankTileData, UiProvider } from "../../src";
import {
  card,
  checking,
  everyKind,
  feedBroken,
  feedChecking,
  links,
  longNames,
  manyAccounts,
  reviewed,
  rightToLeft,
  stripeConnected,
  stripeIdle,
  stripeSetup,
} from "./fixtures";

/** The band of bank, card and Stripe accounts, as Home shows it. Every story is scanned in both themes
 * by the lane story sweep, so a story never sets the theme itself. A cell is the account's name, what
 * the books hold and one line (what the bank says when that differs, how many transactions wait); the
 * cell is the link to the account. The links go to anchors on this page: a story sends nothing. */
function Harness(props: {
  tiles: readonly BankTileData[];
  state?: "ready" | "loading" | "error";
  stale?: boolean;
  width?: string;
  locale?: string;
}) {
  return (
    <UiProvider locale={props.locale ?? "en-US"}>
      <div class="rt-theme" style={{ "max-width": props.width ?? "76rem" }}>
        <BankTileBand
          tiles={props.tiles}
          state={props.state ?? "ready"}
          stale={props.stale ?? false}
          links={links}
          onRetry={() => undefined}
        />
      </div>
    </UiProvider>
  );
}

const meta = {
  title: "Lanes/UXBanking/BankTileBand",
  component: Harness,
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta<typeof Harness>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A checking account whose bank says another figure and has eight transactions to review, a savings
 * account nobody has imported, a card that owes money, and Stripe, not connected yet. */
export const Default: Story = { args: { tiles: everyKind } };

/** Everything reviewed and reconciled: each cell is a name and a figure. */
export const AllReviewed: Story = { args: { tiles: reviewed } };

/** A bank feed that is working, a feed that needs attention, and Stripe connected with another figure. */
export const Connections: Story = {
  args: { tiles: [feedChecking, feedBroken, stripeConnected] },
};

export const StripeNotConnected: Story = { args: { tiles: [checking, stripeIdle] } };

/** A Stripe key that works whose accounts are not chosen yet: the tile's link is the next step. */
export const StripeSetup: Story = { args: { tiles: [checking, stripeSetup] } };

export const SingleAccount: Story = { args: { tiles: [checking] } };

export const Card: Story = { args: { tiles: [card] } };

/** Seven accounts wrap onto a second row; each row is divided by rules. */
export const ManyAccounts: Story = { args: { tiles: manyAccounts } };

/** A name that is far too long, and a figure past a billion: both wrap and neither is cut off. */
export const LongContent: Story = { args: { tiles: longNames } };

export const RightToLeft: Story = { args: { tiles: rightToLeft, locale: "ar" } };

export const Loading: Story = { args: { tiles: [], state: "loading" } };

export const Failed: Story = { args: { tiles: [], state: "error" } };

/** The last read failed after one worked: the figures stay and say they may be old. */
export const Stale: Story = { args: { tiles: everyKind, stale: true } };

/** The row decides how many cells fit from its own width: here, a phone. */
export const Narrow: Story = { args: { tiles: everyKind, width: "22rem" } };

export const Medium: Story = { args: { tiles: manyAccounts, width: "40rem" } };
