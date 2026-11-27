import { parseMoney } from "../money.ts";
import { merchantPhrase, titleCase } from "./normalize.ts";
import { canonicalWords } from "./text.ts";
import type { RuleCondition, RuleDefinition } from "./types.ts";

/** Generalising one bank line into a candidate rule. The line says "AMZN Mktp US*2K4AB5 AMZN.COM/BILL
 * WA"; a rule that only ever matches that exact text is useless, so numbers, dates, reference ids,
 * payment-rail words and trailing locations are stripped (see normalize.ts) and what is left is the
 * merchant. The candidate always matches the line it came from. It is a suggestion: nothing is
 * saved until a person or an agent creates it. */

export interface SuggestInput {
  readonly description: string;
  readonly counterparty?: string;
  /** Signed, two places. Its sign becomes a direction condition. */
  readonly amount: string;
  /** The category account the line was (or should be) booked to, when known. */
  readonly categoryAccountId?: string;
}

export interface Suggestion {
  /** Null when the line says nothing that identifies a merchant (only numbers, say). */
  readonly rule: RuleDefinition | null;
  readonly basis: {
    readonly field: "counterparty" | "description";
    readonly phrase: string;
    readonly dropped: readonly string[];
  } | null;
  /** What was generalised and what the candidate will and will not catch, in plain words. */
  readonly notes: readonly string[];
}

export function suggestRule(input: SuggestInput): Suggestion {
  const fromCounterparty = input.counterparty ? merchantPhrase(input.counterparty) : null;
  const useCounterparty = fromCounterparty !== null && fromCounterparty.phrase !== "";
  const found = useCounterparty
    ? (fromCounterparty as NonNullable<typeof fromCounterparty>)
    : merchantPhrase(input.description);
  const field = useCounterparty ? "counterparty" : "description";
  if (found.phrase === "")
    return {
      rule: null,
      basis: null,
      notes: [
        "Nothing in this line identifies who was paid: it holds only numbers, reference ids or payment-rail words. Write the rule by hand, for example on an exact amount.",
      ],
    };
  const words = canonicalWords(found.phrase);
  const single = words.length === 1;
  const shortWord = single && (words[0] as string).length <= 4;
  const condition: RuleCondition = {
    field,
    operator: single && shortWord ? "wholeWord" : "contains",
    value: found.phrase,
  };
  const conditions: RuleCondition[] = [condition];
  const notes: string[] = [
    `Matches ${field === "counterparty" ? "the counterparty" : "the description"} containing “${found.phrase}”.`,
  ];
  if (found.dropped.length > 0)
    notes.push(
      "Numbers, dates, reference ids, payment-rail words and locations were left out, so the rule keeps matching next month's lines.",
    );
  if (shortWord)
    notes.push(
      "The name is short, so it must match as a whole word to avoid catching longer words that contain it.",
    );
  let cents = 0n;
  try {
    cents = parseMoney(input.amount);
  } catch {
    cents = 0n;
  }
  if (cents !== 0n) {
    conditions.push({ field: "direction", operator: "is", value: cents > 0n ? "in" : "out" });
    notes.push(
      cents > 0n
        ? "Limited to money coming in, so a payment to the same name is not caught."
        : "Limited to money going out, so a refund from the same name is not caught.",
    );
  }
  notes.push(
    "Applies to every account. Limit it to one account if the same name means different things in different accounts.",
  );
  const rule: RuleDefinition = {
    name: titleCase(found.phrase),
    enabled: true,
    accountIds: [],
    match: "all",
    conditions,
    groups: [],
    action: {
      kind: "categorize",
      ...(input.categoryAccountId ? { accountId: input.categoryAccountId } : {}),
    },
  };
  return { rule, basis: { field, phrase: found.phrase, dropped: found.dropped }, notes };
}
