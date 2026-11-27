import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  BankTileBand,
  type BankTileData,
  formatWeekdayDate,
  HomeStart,
  type HomeStartView,
  homeWords,
  MoneyInOut,
  type MoneyMonthView,
  type NeedRowView,
  NeedsYou,
  PageHeader,
  UiProvider,
} from "../../src";
import { everyKind, links } from "../uxbanking/fixtures";
import { rows, sixMonths, startConnect } from "./fixtures";

/** The whole page, as the web application lays it out: what needs a person, the money in and out, then
 * the accounts (the banking lane's component, read here from its own fixtures). A new book is the start
 * alone. A section with nothing to show is not on the page. */
function Page(props: {
  start?: HomeStartView;
  needs?: readonly NeedRowView[];
  months?: readonly MoneyMonthView[];
  tiles?: readonly BankTileData[];
  width?: string;
}) {
  return (
    <UiProvider locale="en-US">
      <div class="rt-theme" style={{ "max-width": props.width ?? "76rem", padding: "1rem" }}>
        <div class="rt-today">
          <PageHeader
            size="home"
            title={homeWords.title}
            actions={
              <p class="rt-home-date">
                <time datetime="2026-10-05">{formatWeekdayDate("2026-10-05")}</time>
              </p>
            }
          />
          {props.start ? <HomeStart start={props.start} /> : null}
          {props.needs ? (
            <div class="rt-home-columns">
              <NeedsYou rows={props.needs} total={props.needs.length} hidden={0} state="ready" />
              {props.months ? (
                <MoneyInOut
                  months={props.months}
                  state="ready"
                  cash
                  currency="USD"
                  any
                  profit="3278.41"
                />
              ) : null}
            </div>
          ) : null}
          {props.tiles ? (
            <div class="rt-tiles">
              <h2 class="rt-home-heading">{homeWords.tiles.heading}</h2>
              <BankTileBand tiles={props.tiles} links={links} headingLevel={3} />
            </div>
          ) : null}
        </div>
      </div>
    </UiProvider>
  );
}

const meta = {
  title: "Lanes/UXHome/Home",
  component: Page,
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof Page>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A new book: one thing to do, and nothing else on the page. */
export const NewBook: Story = { args: { start: startConnect } };

/** The working day of a book: what needs a person (the first row is the next step and carries the page's
 * one button), the last six months, and the accounts. */
export const WorkingDay: Story = {
  args: { needs: [rows.review, rows.reconcile, rows.backup], months: sixMonths, tiles: everyKind },
};

/** Transactions have come in and nothing is posted yet: there is no chart to draw, so there is none. */
export const FirstImport: Story = { args: { needs: [rows.review], tiles: everyKind } };

/** Everything is done and nothing needs anyone. */
export const AllQuiet: Story = { args: { needs: [], months: sixMonths, tiles: everyKind } };

/** A phone: one column; a row keeps its verb beside its sentence. */
export const AtPhoneWidth: Story = {
  args: {
    needs: [rows.review, rows.reconcile, rows.closeReady],
    months: sixMonths,
    tiles: everyKind,
    width: "24rem",
  },
};

/** A new book on a phone. */
export const NewBookAtPhoneWidth: Story = { args: { start: startConnect, width: "22.5rem" } };
