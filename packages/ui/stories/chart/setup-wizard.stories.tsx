import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { SetupWizard, type SetupWizardProps } from "../../src";
import { addOns, fixtureChart, templates } from "./fixtures";
import { Frame } from "./frame";

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const base: SetupWizardProps = {
  templates,
  addOns,
  taxYears: [2025, 2026],
  defaultYear: 2026,
  loadChart: async (request) => {
    await pause(80);
    return fixtureChart(request);
  },
  onCreate: () => undefined,
};

const named = { name: "Example Studio" };

const meta = {
  title: "Lanes/Chart/Setup wizard",
  component: SetupWizard,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "The first screens of a new book: four short steps, then a book. The chart is listed on the review step, never edited there; the component owns the questions and the application supplies loadChart and onCreate. Every story uses fictional data and calls nothing.",
      },
    },
  },
  decorators: [
    (Story) => (
      <Frame>
        <Story />
      </Frame>
    ),
  ],
  args: base,
} satisfies Meta<typeof SetupWizard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The first step, empty: a name and a currency. */
export const YourBusiness: Story = {};

export const TypeOfBusiness: Story = { args: { initialStep: 1, initial: named } };

export const TypeOfBusinessWithStripe: Story = {
  args: { initialStep: 1, initial: { ...named, addOns: ["online-business"] } },
};

/** Cash is selected, and the choice that cannot be undone says so. Nothing about the calendar is asked. */
export const AccountingMethod: Story = { args: { initialStep: 2, initial: named } };

/** A start that is not January, from a retained choice or an agent: the review says when the books start. */
export const AccrualOctoberStart: Story = {
  args: {
    initialStep: 3,
    initial: { ...named, basis: "accrual", periodModel: "quarterly", startMonth: 10 },
  },
};

/** The summary and Create book; the chart is folded under its heading, for whoever wants to look, as a list
 * with each account's tax line and nothing to edit. The summary says when the books start. */
export const ReviewAndCreate: Story = {
  args: { initialStep: 3, initial: { ...named, addOns: ["online-business"] } },
};

export const ReviewAccrualBook: Story = {
  args: { initialStep: 3, initial: { ...named, basis: "accrual" } },
};

/** The chart is still being built: the step says so and Create book waits. */
export const BuildingTheChart: Story = {
  args: { initialStep: 3, initial: named, loadChart: () => new Promise(() => {}) },
};

export const ChartFailedToBuild: Story = {
  args: {
    initialStep: 3,
    initial: named,
    loadChart: async () => {
      await pause(20);
      throw new Error("Application service unavailable; start bun run dev:api");
    },
  },
};

/** Work in progress: the button keeps its place and ignores clicks, so a slow save cannot be sent twice. */
export const Creating: Story = {
  args: { initialStep: 3, initial: named, creating: true },
};

export const CreateFailed: Story = {
  args: {
    initialStep: 3,
    initial: named,
    error:
      "Account 4000: Gross receipts or sales (line 1) takes an income or a gain account; this is an expense account.",
  },
};

/** The reply was lost, so the book may exist: creating waits until the original request is resumed. */
export const ReplyLost: Story = {
  args: { initialStep: 3, initial: named, uncertain: true },
};

export const LongBusinessName: Story = {
  args: {
    initialStep: 3,
    initial: {
      name: "The Northern Regional Association of Independent Craft Producers, Importers and Distributors of Handmade Goods, Limited Liability Company",
    },
  },
};

export const RightToLeft: Story = {
  decorators: [
    (Story) => (
      <Frame locale="ar">
        <Story />
      </Frame>
    ),
  ],
  args: { initialStep: 3, initial: { name: "استوديو المثال" } },
};
