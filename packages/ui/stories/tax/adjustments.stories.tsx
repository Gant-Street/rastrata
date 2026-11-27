import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Button, TaxAdjustmentsImport, taxWords } from "../../src";
import { Frame } from "./frame";
import { previewAlready, previewFileProblem, previewNew, previewProblems } from "./fixtures";

const meta = {
  title: "Lanes/Tax/Adjusting entries",
  parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const noop = () => undefined;
const common = {
  journalHref: "/journal",
  onFile: noop,
  onImport: noop,
  extra: <Button variant="quiet" label={taxWords.accountantTemplate} onClick={noop} />,
} as const;

export const AdjustmentsChoose: Story = {
  name: "Adjusting entries: no file chosen yet",
  render: () => (
    <Frame>
      <TaxAdjustmentsImport {...common} state="idle" preview={null} imported={null} />
    </Frame>
  ),
};

export const AdjustmentsChecking: Story = {
  name: "Adjusting entries: checking the file",
  render: () => (
    <Frame>
      <TaxAdjustmentsImport
        {...common}
        state="checking"
        fileName="year-end-adjustments.csv"
        fileSize={612}
        preview={null}
        imported={null}
      />
    </Frame>
  ),
};

export const AdjustmentsReady: Story = {
  name: "Adjusting entries: two new entries, one in a closed period",
  render: () => (
    <Frame>
      <TaxAdjustmentsImport
        {...common}
        state="checked"
        fileName="year-end-adjustments.csv"
        fileSize={612}
        preview={previewNew}
        imported={null}
      />
    </Frame>
  ),
};

export const AdjustmentsUncertain: Story = {
  name: "Adjusting entries: an import was interrupted and its result is not known",
  render: () => (
    <Frame>
      <TaxAdjustmentsImport
        {...common}
        state="checked"
        fileName="year-end-adjustments.csv"
        fileSize={612}
        preview={previewNew}
        imported={null}
        uncertain
        onResume={noop}
      />
    </Frame>
  ),
};

export const AdjustmentsImporting: Story = {
  name: "Adjusting entries: importing",
  render: () => (
    <Frame>
      <TaxAdjustmentsImport
        {...common}
        state="importing"
        fileName="year-end-adjustments.csv"
        fileSize={612}
        preview={previewNew}
        imported={null}
      />
    </Frame>
  ),
};

export const AdjustmentsProblems: Story = {
  name: "Adjusting entries: problems with their rows, and a conflict",
  render: () => (
    <Frame>
      <TaxAdjustmentsImport
        {...common}
        state="checked"
        fileName="from-the-accountant.csv"
        fileSize={540}
        preview={previewProblems}
        imported={null}
      />
    </Frame>
  ),
};

export const AdjustmentsAlready: Story = {
  name: "Adjusting entries: everything was imported before",
  render: () => (
    <Frame>
      <TaxAdjustmentsImport
        {...common}
        state="checked"
        fileName="year-end-adjustments.csv"
        fileSize={612}
        preview={previewAlready}
        imported={null}
      />
    </Frame>
  ),
};

export const AdjustmentsFileProblem: Story = {
  name: "Adjusting entries: a file with no usable header",
  render: () => (
    <Frame>
      <TaxAdjustmentsImport
        {...common}
        state="checked"
        fileName="notes.csv"
        fileSize={88}
        preview={previewFileProblem}
        imported={null}
      />
    </Frame>
  ),
};

export const AdjustmentsImported: Story = {
  name: "Adjusting entries: imported as drafts, nothing posted",
  render: () => (
    <Frame>
      <TaxAdjustmentsImport
        {...common}
        state="imported"
        fileName="year-end-adjustments.csv"
        fileSize={612}
        preview={previewNew}
        imported={{
          fileName: "year-end-adjustments.csv",
          created: [
            { entry: "AJE-1", draftId: "d1" },
            { entry: "AJE-2", draftId: "d2" },
          ],
          skipped: [],
          nextStep: "2 drafts were saved.",
        }}
      />
    </Frame>
  ),
};

export const AdjustmentsFailed: Story = {
  name: "Adjusting entries: the file could not be read",
  render: () => (
    <Frame>
      <TaxAdjustmentsImport
        {...common}
        state="failed"
        preview={null}
        imported={null}
        error="This file is too large to import. Split it into several files."
      />
    </Frame>
  ),
};
