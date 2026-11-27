import type { QuickAccount } from "../../src";

/** A small business's chart, as the entry dialogs read it. */
export const chart: readonly QuickAccount[] = [
  { id: "1000", code: "1000", name: "Business checking", role: "asset", bank: true },
  { id: "1100", code: "1100", name: "Business savings", role: "asset", bank: true },
  { id: "1500", code: "1500", name: "Prepaid insurance", role: "asset" },
  { id: "2000", code: "2000", name: "Business credit card", role: "liability", bank: true },
  { id: "2100", code: "2100", name: "Sales tax payable", role: "liability" },
  { id: "3000", code: "3000", name: "Owner's investment", role: "equity" },
  { id: "3100", code: "3100", name: "Owner's draw", role: "equity" },
  { id: "4000", code: "4000", name: "Sales", role: "income" },
  { id: "4100", code: "4100", name: "Consulting income", role: "income" },
  { id: "5000", code: "5000", name: "Software and subscriptions", role: "expense" },
  { id: "5100", code: "5100", name: "Meals", role: "expense" },
  { id: "5200", code: "5200", name: "Office supplies", role: "expense" },
  { id: "5300", code: "5300", name: "Operating expenses", role: "expense", group: true },
  { id: "5900", code: "5900", name: "Old account", role: "expense", closed: true },
];

/** The same, with names as long as people make them, and many of them. */
export const longChart: readonly QuickAccount[] = [
  ...chart,
  ...Array.from(
    { length: 40 },
    (_, index): QuickAccount => ({
      id: `6${String(index).padStart(3, "0")}`,
      code: `6${String(index).padStart(3, "0")}`,
      name: `Professional services and consulting fees paid to outside contractors, region ${index + 1}`,
      role: "expense",
    }),
  ),
];
