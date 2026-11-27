/** The payees' operations: the list, one row of the report opened, a payee recorded, words tried before
 * they are saved, the report and the report as CSV. Reads build one picture of the book, the payees
 * and the Inbox's text and answer from it; the one write is retained by operation identity. */
import type { PayeeList } from "../../client-contracts.gen.ts";
import type { SliceHandlers } from "../types.ts";
import { load, payeeWire, payeesOf } from "./read.ts";
import { compileFor, detailWire, exportFile, testWire, totalsWire } from "./report.ts";
import { savePayee } from "./save.ts";

const LIST_PAGE = 100;

export const payeesHandlers: SliceHandlers = {
  "payees.list": (input, context): PayeeList => {
    const { payeeState, vendors } = payeesOf(context, input);
    const needle = typeof input.text === "string" ? input.text.trim().toLowerCase() : "";
    const includeRetired = input.includeRetired === true;
    const found = payeeState.payees.filter(
      (payee) =>
        (includeRetired || !payee.retired) &&
        (needle === "" ||
          payee.name.toLowerCase().includes(needle) ||
          payee.note.toLowerCase().includes(needle) ||
          payee.words.some((word) => word.includes(needle))),
    );
    const page = typeof input.page === "number" ? input.page : 1;
    const size = typeof input.pageSize === "number" ? input.pageSize : LIST_PAGE;
    return {
      payees: found.slice((page - 1) * size, page * size).map((payee) => payeeWire(payee, vendors)),
      count: found.length,
      page,
      pageSize: size,
      payeesRevision: String(payeeState.revision),
      payeesHash: payeeState.hash,
    };
  },

  "payees.get": async (input, context) => {
    const loaded = await load(input, context);
    return detailWire(loaded, input, compileFor(loaded));
  },

  "payees.save": (input, context) => savePayee(context, input, context.operationId),

  "payees.test": async (input, context) => testWire(await load(input, context), input),

  "payees.totals": async (input, context) => {
    const loaded = await load(input, context);
    return totalsWire(loaded, input, compileFor(loaded, input.byMonth === true));
  },

  "payees.export": async (input, context) => {
    const loaded = await load(input, context);
    return exportFile(context, loaded, input, compileFor(loaded));
  },
};
