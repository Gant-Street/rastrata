import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { ImportMappingEditor, type ImportMapping } from "../../src";
import { chaseColumns, chaseMapping, splitMapping, unknownColumns } from "./fixtures";
import { Frame } from "./frame";

function Editor(props: Parameters<typeof ImportMappingEditor>[0]) {
  return (
    <Frame width="48rem">
      <ImportMappingEditor {...props} />
    </Frame>
  );
}

const meta = {
  title: "Lanes/Statements/Mapping editor",
  component: Editor,
  args: {
    columns: chaseColumns,
    mapping: chaseMapping,
    headerRow: 1,
    resetKey: "story",
    onChange: () => {},
  },
} satisfies Meta<typeof Editor>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ReadAsChase: Story = {};

export const NothingChosenYet: Story = {
  args: { columns: unknownColumns, mapping: undefined, headerRow: 1 },
};

export const MoneyOutAndMoneyIn: Story = {
  args: { columns: unknownColumns, mapping: splitMapping },
};

export const AmountWithDirection: Story = {
  args: {
    columns: [
      { index: 1, header: "Transaction Date", samples: ["01/15/2026"] },
      { index: 2, header: "Transaction Amount", samples: ["12.34"] },
      { index: 3, header: "Transaction Type", samples: ["Debit", "Credit"] },
      { index: 4, header: "Transaction Description", samples: ["GITHUB INC"] },
    ],
    mapping: {
      headerRow: 1,
      date: { header: "Transaction Date", index: 1 },
      dateOrder: "mdy",
      amount: {
        kind: "direction",
        amount: { header: "Transaction Amount", index: 2 },
        direction: { header: "Transaction Type", index: 3 },
        outValues: ["Debit"],
        inValues: ["Credit"],
      },
      description: [{ header: "Transaction Description", index: 4 }],
    },
  },
};

export const FlippedSigns: Story = {
  args: {
    mapping: {
      ...chaseMapping,
      amount: { kind: "signed", amount: { header: "Amount", index: 4 }, invert: true },
    },
  },
};

export const NoHeaderRow: Story = {
  args: {
    columns: [
      { index: 1, header: "", samples: ["02/27/2026", "02/14/2026"] },
      { index: 2, header: "", samples: ["-750.00", "1200.00"] },
      { index: 3, header: "", samples: ["*"] },
      { index: 4, header: "", samples: ["1041"] },
      { index: 5, header: "", samples: ["RENT PAYMENT ACH WEWORK"] },
    ],
    mapping: undefined,
    headerRow: 0,
  },
};

export const LongHeaders: Story = {
  args: {
    columns: [
      {
        index: 1,
        header: "The date on which the bank posted this transaction to the account",
        samples: ["01/15/2026"],
      },
      {
        index: 2,
        header:
          "Description including the full merchant name, city and state as reported by the card network",
        samples: ["GITHUB INC SAN FRANCISCO CA"],
      },
      { index: 3, header: "Signed amount in United States dollars", samples: ["-12.34"] },
    ],
    mapping: undefined,
    headerRow: 1,
  },
};

export const Disabled: Story = { args: { disabled: true } };

export const ReportsOnlyCompleteChoices: Story = {
  render: () => {
    const [sent, setSent] = createSignal<ImportMapping | null>(null);
    return (
      <Frame width="48rem">
        <ImportMappingEditor
          columns={unknownColumns}
          mapping={undefined}
          headerRow={1}
          resetKey="x"
          onChange={setSent}
        />
        <p class="rt-hint" role="status">
          {sent()
            ? "A complete mapping was sent to the preview."
            : "Nothing is sent until the mapping is complete."}
        </p>
      </Frame>
    );
  },
};
