import type { QuickKind } from "@rastrata/ui";
import { createSignal } from "solid-js";
import { QuickEntry } from "./quick-entry.tsx";

/** The dialogs the lane registers. They are one form, "New transaction", with a switch at its top for the
 * kind (Spend money, Receive money, Transfer): "+ New, Transaction" opens it on Spend money, and the three
 * older ids open it on their own kind (Search finds each by its name, and `?new=receive` still works). The
 * shell gives each `open` (always true while it is mounted) and `onClose`. */
type Props = { open: boolean; onClose: () => void };

const transaction = (start: QuickKind) => (props: Props) => {
  const [kind, setKind] = createSignal<QuickKind>(start);
  return <QuickEntry kind={kind()} onKind={setKind} open={props.open} onClose={props.onClose} />;
};

export const TransactionDialog = transaction("spend");
export const SpendMoneyDialog = transaction("spend");
export const ReceiveMoneyDialog = transaction("receive");
export const TransferDialog = transaction("transfer");
