import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Button, PageHeader, UiProvider } from "../../src";

/** The top of every page: a 32 px title (Home's "Today" 56 px), one line, the main actions at the right, a
 * state chip when the subject has a state, and a "How this works" disclosure for everything longer. There is
 * no eyebrow chip above the title. */
const meta = {
  title: "Lanes/UXShell/PageHeader",
  component: PageHeader,
  parameters: { a11y: { test: "error" } },
  decorators: [
    (Story) => (
      <UiProvider locale="en-US">
        <div class="rt-theme" style={{ "max-width": "72rem", padding: "1.5rem" }}>
          <Story />
          <p style={{ "margin-top": "2rem", color: "var(--rt-muted)" }}>
            The page's work starts here, within 220 px of the rule under the header.
          </p>
        </div>
      </UiProvider>
    ),
  ],
} satisfies Meta<typeof PageHeader>;
export default meta;
type Story = StoryObj<typeof meta>;

const actions = (
  <>
    <Button variant="secondary" label="Export" />
    <Button label="Journal entry" />
  </>
);

export const Default: Story = {
  args: {
    title: "Transactions",
    description: "Every entry in the books, newest first.",
    actions,
  },
};

/** One sentence under the title and the page's one action beside it. */
export const WithAction: Story = {
  args: {
    title: "Rules",
    description: "Rules suggest a category for each bank transaction.",
    actions: <Button label="New rule" />,
  },
};

/** A state of the page's subject is the one place the black chip survives. */
export const WithStatus: Story = {
  args: {
    title: "Journal entry",
    status: "Draft",
    back: { label: "Transactions", href: "/journal" },
    actions: (
      <>
        <Button variant="secondary" label="Save draft" />
        <Button label="Post" />
      </>
    ),
  },
};

export const TitleOnly: Story = { args: { title: "Business" } };

export const WithDescription: Story = {
  args: { title: "Connections", description: "Where transactions can come from besides files." },
};

/** Home's "Today" is 56 px. */
export const Home: Story = {
  args: {
    size: "home",
    title: "Today",
    description: "Willow Lane Studio · Cash basis · Fiscal year 2026",
    actions: <span>Sunday, Oct 4, 2026</span>,
  },
};

/** A long title wraps (and breaks inside a very long word) instead of pushing the page sideways. */
export const LongContent: Story = {
  args: {
    title:
      "Reconcile Business checking account ending in 4417 at the First Example Bank of Willow Lane",
    description:
      "A long description stays at about 75 characters wide, so it never runs across a wide page: it is one line when it can be and wraps when it must.",
    status: "In progress",
    actions: (
      <>
        <Button variant="secondary" label="Save and finish later" />
        <Button variant="secondary" label="Print" />
        <Button label="Finish" />
      </>
    ),
  },
};
