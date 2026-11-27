/** The gap log: what the move has found that is not yet right, and what was decided about it.
 *
 * The cutover is not finished when the opening balances are posted and two months reconcile. It is
 * finished when every difference the tie-out found against Xero has been looked at: a line missing
 * from one book, an account nothing maps, something Xero did that Rastrata does not. Each is a gap
 * until a person closes it with a note saying what was found. Nothing here changes the books, and
 * nothing is deleted: a closed gap stays, with who closed it and why.
 *
 * Gaps found by the tie-out carry a key made from what they are (the period, the account, the line),
 * so running the tie-out again does not add them twice, and a closed one is not reopened by it. */
import { describePrincipal } from "../../agent/principal.ts";
import type {
  Gap,
  GapAddInput,
  GapList,
  GapListInput,
  GapUpdateInput,
  TieoutInput,
  TieoutRecordResult,
} from "../../client-contracts.gen.ts";
import { ApplicationError } from "../../errors.ts";
import { sha256Hex } from "../../ingest/hash.ts";
import { sanitizeText } from "../../ingest/text.ts";
import type { SliceContext } from "../types.ts";
import { shadowStore } from "./store.ts";
import { tieOutReport } from "./tieout.ts";

/** The most gaps one tie-out records: a book that differs everywhere has a problem a list of two
 * thousand lines would not help with. */
const MAX_RECORDED = 300;

type Kind = Gap["kind"];

export function listGaps(context: SliceContext, input: GapListInput): GapList {
  const store = shadowStore(context.service);
  const all = store.gaps();
  const status = input.status ?? "open";
  return {
    gaps: status === "all" ? all : all.filter((gap) => gap.status === status),
    open: all.filter((gap) => gap.status === "open").length,
    closed: all.filter((gap) => gap.status === "closed").length,
  };
}

export function addGap(context: SliceContext, input: GapAddInput): Gap {
  const title = sanitizeText(input.title, 200);
  if (title.length < 3)
    throw new ApplicationError("invalid_input", "A gap needs a title of a few words", 400);
  return shadowStore(context.service).addGap({
    key: null,
    kind: input.kind ?? "other",
    title,
    detail: sanitizeText(input.detail ?? "", 1500),
    source: "manual",
    openedAt: context.service.now(),
    openedBy: describePrincipal(context.access.principal),
  });
}

export function updateGap(context: SliceContext, input: GapUpdateInput): Gap {
  const store = shadowStore(context.service);
  const existing = store.gap(input.id);
  if (!existing) throw new ApplicationError("gap_not_found", `There is no gap ${input.id}`, 404);
  const resolution = sanitizeText(input.resolution ?? "", 600);
  if (input.status === "closed" && resolution.length < 3)
    throw new ApplicationError(
      "resolution_required",
      "Say what was found when closing a gap: a few words are enough",
      400,
    );
  return store.setGapStatus(
    input.id,
    input.status,
    resolution,
    context.service.now(),
    describePrincipal(context.access.principal),
  );
}

const amountText = (debit: string, credit: string): string =>
  debit !== "0.00" ? `${debit} debit` : `${credit} credit`;

/** Record what a tie-out found as gaps: one for each line in one book and not the other, one for
 * each difference the lines could not explain, and one for each Xero account with a balance that
 * nothing maps. Returns what was added and what was already there. */
export async function recordTieOut(
  context: SliceContext,
  input: TieoutInput,
): Promise<TieoutRecordResult> {
  const report = await tieOutReport(context, input);
  const store = shadowStore(context.service);
  const now = context.service.now();
  const by = describePrincipal(context.access.principal);
  const added: Gap[] = [];
  let existing = 0;
  let skipped = 0;
  const add = (key: string, kind: Kind, title: string, detail: string): void => {
    if (store.gapByKey(key)) {
      existing++;
      return;
    }
    if (added.length >= MAX_RECORDED) {
      skipped++;
      return;
    }
    added.push(
      store.addGap({
        key,
        kind,
        title: sanitizeText(title, 200),
        detail: sanitizeText(detail, 1500),
        source: "tieout",
        openedAt: now,
        openedBy: by,
      }),
    );
  };
  const seenUnmapped = new Set<string>();
  for (const period of report.periods) {
    for (const account of period.accounts) {
      if (account.status !== "differs") continue;
      const where = `${account.code} ${account.name}, ${period.from} to ${period.to}`;
      for (const line of account.unmatched ?? []) {
        const only = line.side === "xero" ? "Xero" : "Rastrata";
        const other = line.side === "xero" ? "Rastrata" : "Xero";
        const fingerprint = sha256Hex(`${line.description}\u0000${line.reference}`).slice(0, 8);
        add(
          `difference:${period.from}:${account.code}:${line.side}:${line.date}:${line.debit}:${line.credit}:${fingerprint}`,
          "difference",
          `${only} only: ${line.date} ${amountText(line.debit, line.credit)} on ${account.code} ${account.name}`,
          `${where}. The line is in ${only} and ${other} has no line of the same amount within ${report.toleranceDays} days. ${
            line.description ? `Description: ${line.description}. ` : ""
          }${line.reference ? `Reference: ${line.reference}. ` : ""}${
            line.side === "xero"
              ? "Check the statement: if the line is on it, it is missing from Rastrata; if not, Xero holds a line the bank does not."
              : "Check the statement: if the line is on it, Xero is missing it; if not, Rastrata holds a line the bank does not."
          }`,
        );
      }
      if (account.residual !== null && account.residual !== "0.00")
        add(
          `unexplained:${period.from}:${account.code}:${account.residual}`,
          "difference",
          `Unexplained ${account.residual} on ${account.code} ${account.name}, ${period.from} to ${period.to}`,
          `${where}. After matching lines, ${account.residual} of the period's difference is still not accounted for. The Xero lines imported for the period may be incomplete: import the account transactions again.`,
        );
      else if (account.unmatched === null)
        add(
          `no-lines:${period.from}:${account.code}`,
          "data",
          `Differs by ${account.difference} on ${account.code} ${account.name}, ${period.from} to ${period.to}, with no transactions to explain it`,
          `${where}. Xero's figure is ${account.xero} and Rastrata's is ${account.rastrata}. Import Xero's account transactions for the period to see which lines differ.`,
        );
    }
    for (const item of period.unmapped) {
      if (seenUnmapped.has(item.code)) continue;
      seenUnmapped.add(item.code);
      add(
        `unmapped:${item.code}`,
        "unmapped",
        `Xero account ${item.code} ${item.name} is not mapped`,
        `It holds ${item.net} (debits less credits) in Xero and no account of the book stands for it. Map it, or leave it out on purpose with xero mapping set.`,
      );
    }
  }
  if (skipped > 0)
    added.push(
      store.addGap({
        key: `more:${now}`,
        kind: "other",
        title: `${skipped} more differences were not recorded`,
        detail: `The tie-out found more than ${MAX_RECORDED} differences to record. Fix the largest, then run the tie-out again.`,
        source: "tieout",
        openedAt: now,
        openedBy: by,
      }),
    );
  return { summary: report.summary, added: added.length, existing, gaps: added };
}
