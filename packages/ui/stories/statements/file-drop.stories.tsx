import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { ImportFileDrop } from "../../src";
import { Frame } from "./frame";

function Drop(props: Parameters<typeof ImportFileDrop>[0]) {
  return (
    <Frame width="40rem">
      <ImportFileDrop {...props} />
    </Frame>
  );
}

const meta = {
  title: "Lanes/Statements/File drop",
  component: Drop,
  args: { state: "idle", onFile: () => {} },
} satisfies Meta<typeof Drop>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const Dragging: Story = { args: { dragging: true } };

export const Uploading: Story = {
  args: { state: "uploading", fileName: "Chase1234_Activity.csv", fileSize: 14540 },
};

export const Reading: Story = { args: { state: "reading", fileName: "statement.qfx" } };

export const Chosen: Story = { args: { fileName: "Chase1234_Activity.csv", fileSize: 14540 } };

export const TooLarge: Story = {
  args: {
    state: "error",
    error: "That file is larger than 16 MiB. Download a shorter date range and import it in parts.",
  },
};

export const NotAStatement: Story = {
  args: {
    state: "error",
    fileName: "statement.pdf",
    error:
      "That looks like a PDF, which cannot be imported. Download the statement as CSV, OFX, QFX or QBO from your bank instead.",
  },
};

export const Disabled: Story = { args: { disabled: true } };

export const LongFileName: Story = {
  args: {
    fileName:
      "Chase_Business_Complete_Checking_Account_Activity_From_2026-01-01_To_2026-12-31_Exported_On_A_Tuesday_Afternoon.csv",
    fileSize: 3 * 1024 * 1024,
  },
};

export const Interactive: Story = {
  render: () => {
    const [name, setName] = createSignal("");
    return (
      <Frame width="40rem">
        <ImportFileDrop
          state="idle"
          fileName={name() || undefined}
          fileSize={1234}
          onFile={(file) => setName(file.name)}
        />
      </Frame>
    );
  },
};
