import { expect, test } from "bun:test";
import {
  accept,
  CONFIG_LIMITS,
  ClassifierModel,
  type ClassifierConfig,
  createClassifierProposer,
  DEFAULT_CLASSIFIER_CONFIG,
  features,
  lineText,
  reasonsFor,
  type TrainingExample,
} from "../src/rules/classifier.ts";
import { evaluate } from "../src/rules/evaluate.ts";
import { ACCOUNTS, classifierHistory } from "./fixtures/classifier-history.ts";
import { bankLine, item, random } from "./fixtures/rules-kit.ts";
import { expectWithin } from "./support/budget.ts";

const percent = (ratio: { basisPoints: number | null }) =>
  ratio.basisPoints === null ? "n/a" : `${(ratio.basisPoints / 100).toFixed(2)}%`;
const defaults = DEFAULT_CLASSIFIER_CONFIG;
const lines = (
  model: ClassifierModel,
  account: string,
  count: number,
  words: string[],
  direction: "in" | "out" = "out",
) => {
  for (let index = 0; index < count; index++) model.add(account, words, direction);
};

/** A model whose every count is known by hand, so the estimator can be checked against exact
 * fractions: A has four lines, B three, one of B's moved money in. */
function tiny(): ClassifierModel {
  const model = new ClassifierModel();
  lines(model, "A", 3, ["alpha", "beta"]);
  lines(model, "A", 1, ["alpha"]);
  lines(model, "B", 2, ["beta", "gamma"]);
  lines(model, "B", 1, ["gamma"], "in");
  return model;
}

test("the estimator is exactly naive Bayes with add-one smoothing, a prior and a direction factor", () => {
  const model = tiny();
  expect(model.examples).toBe(7);
  expect(model.vocabulary).toBe(3);
  const prediction = model.predict(["alpha", "beta"], "out");
  // prior A 5/9, B 4/9; direction A 5/6, B 3/5; alpha A 5/10, B 1/8; beta A 4/10, B 3/8.
  // A = 5/54 and B = 1/80, so A's share is 400/454 and B's 54/454.
  const [first, second] = prediction?.candidates ?? [];
  expect(first?.accountId).toBe("A");
  expect(first?.score).toBeCloseTo(400 / 454, 12);
  expect(second?.score).toBeCloseTo(54 / 454, 12);
  expect((first?.score ?? 0) + (second?.score ?? 0)).toBeCloseTo(1, 12);
  expect([first?.examples, second?.examples]).toEqual([4, 3]);
  expect(prediction?.knownWords).toBe(2);
});

test("the suggestion rests on the line's most reliable word, smoothed by Laplace's rule of succession", () => {
  const prediction = tiny().predict(["alpha", "beta"], "out");
  // alpha went to A on 4 of the 4 lines containing it; beta on 3 of 5.
  expect(prediction?.record).toEqual({ word: "alpha", inAccount: 4, inAll: 4, agreement: 1 });
  expect(prediction?.confidence).toBeCloseTo(5 / 6, 12);
  expect(prediction?.confidencePercent).toBe(83);
  expect(prediction?.evidence.map((entry) => entry.word)).toContain("alpha");
  // 3 of 3 reads 80%, 18 of 18 reads 95%, 48 of 48 reads 98%: few lines cannot read as certain.
  const read = (count: number) => {
    const model = new ClassifierModel();
    lines(model, "A", count, ["solo"]);
    // As many other lines, so "solo" is half of all of them and not a word written into most.
    lines(model, "B", count + 5, ["other"]);
    return model.predict(["solo"], "out")?.confidencePercent;
  };
  expect([read(3), read(8), read(18), read(48), read(1000)]).toEqual([80, 90, 95, 98, 99]);
});

test("unknown words are left out, and a line with none the model knows gets no answer", () => {
  const model = tiny();
  const withNoise = model.predict(["alpha", "beta", "never", "seen"], "out");
  const without = model.predict(["alpha", "beta"], "out");
  expect(withNoise?.candidates).toEqual(without?.candidates);
  expect(withNoise?.knownWords).toBe(2);
  expect(model.predict(["never", "seen"], "out")).toBeNull();
  expect(model.predict([], "out")).toBeNull();
  expect(new ClassifierModel().predict(["alpha"], "out")).toBeNull();
});

test("direction is a factor of its own, so money in is told apart from money out", () => {
  const model = tiny();
  // gamma went to B on three lines (one money in) and never to A. prior A 5/9, B 4/9; word factors
  // A 1/10, B 4/8. Out: A 5/9 x 5/6 x 1/10 = 25/540, B 4/9 x 3/5 x 1/2 = 72/540, so B is 72/97.
  // In: A 5/9 x 1/6 x 1/10 = 5/540, B 4/9 x 2/5 x 1/2 = 48/540, so B is 48/53.
  expect(model.predict(["gamma"], "out")?.candidates[0]?.score).toBeCloseTo(72 / 97, 12);
  expect(model.predict(["gamma"], "in")?.candidates[0]?.score).toBeCloseTo(48 / 53, 12);
  // Direction is never a word of the memo, so it cannot make long memos look unlike short ones.
  expect(model.vocabulary).toBe(3);
});

test("a word seen once does not make an account certain, and one sighting is not enough", () => {
  const model = new ClassifierModel();
  lines(model, "A", 1, ["rare"]);
  lines(model, "B", 6, ["common", "other"]);
  const prediction = model.predict(["rare"], "out");
  expect(prediction?.candidates[0]?.accountId).toBe("A");
  // GnuCash would say 100%. With smoothing and priors one sighting is far from certain, and the
  // record is 1 line, below the three the suggestion needs.
  expect(prediction?.candidates[0]?.score).toBeLessThan(0.9);
  expect(prediction?.confidencePercent).toBe(66);
  expect(accept(prediction, defaults)).toBeNull();
  expect(accept(prediction, { ...defaults, minExamples: 1, minMargin: 0 })?.accountId).toBe("A");
});

test("a spotless single-word merchant is trusted even when add-one smoothing flattens naive Bayes", () => {
  // Fifteen other accounts with a few hundred distinct words make the vocabulary large, which is
  // what makes a bare "github" score low under add-one smoothing.
  const model = new ClassifierModel();
  lines(model, "software", 18, ["github"]);
  for (let account = 0; account < 15; account++)
    for (let line = 0; line < 20; line++)
      model.add(
        `other${account}`,
        [`w${account}a${line}`, `w${account}b${line}`, `w${account}c`],
        "out",
      );
  const prediction = model.predict(["github"], "out");
  expect(prediction?.candidates[0]?.score).toBeLessThan(0.9);
  expect(prediction?.record).toEqual({ word: "github", inAccount: 18, inAll: 18, agreement: 1 });
  expect(prediction?.confidencePercent).toBe(95);
  expect(accept(prediction, defaults)?.accountId).toBe("software");
});

test("a merchant booked more than one way is left alone, whatever naive Bayes says", () => {
  const model = new ClassifierModel();
  // Amazon: 70 lines to office, 30 to equipment. Equipment memos are longer (many extra words), so
  // naive Bayes, which multiplies the four shared words as if each were independent evidence,
  // scores office near 100%. The record says 70 of 100.
  const filler = Array.from({ length: 10 }, (_, index) => `filler${index}`);
  lines(model, "office", 70, ["amazon", "mktp", "amzn", "bill"]);
  lines(model, "equipment", 30, ["amazon", "mktp", "amzn", "bill", ...filler]);
  lines(model, "software", 40, ["github"]);
  const prediction = model.predict(["amazon", "mktp", "amzn", "bill"], "out");
  expect(prediction?.candidates[0]?.accountId).toBe("office");
  expect(prediction?.candidates[0]?.score).toBeGreaterThan(0.99);
  expect(prediction?.record.agreement).toBeCloseTo(0.7, 12);
  expect(prediction?.record.inAccount).toBe(70);
  expect(prediction?.record.inAll).toBe(100);
  expect(prediction?.confidencePercent).toBe(69);
  expect(accept(prediction, defaults)).toBeNull();
  // It is the person's call to trust 70%: lowering the bar says so out loud.
  const lowered = { ...defaults, minAgreement: 70 };
  const taken = accept(prediction, lowered);
  expect(taken?.accountId).toBe("office");
  const reasons = reasonsFor(
    prediction as NonNullable<typeof prediction>,
    taken as NonNullable<typeof taken>,
    (id) => id,
  );
  expect(reasons.join(" ")).toContain("70 of the 100 lines");
  expect(reasons.join(" ")).toContain("Confidence 69%");
  // A merchant booked one way, however many words the memo has, has a clean record.
  expect(accept(model.predict(["github"], "out"), defaults)?.accountId).toBe("software");
});

test("each threshold is configuration and each boundary is exact", () => {
  const model = new ClassifierModel();
  lines(model, "A", 9, ["nine", "tenths"]);
  lines(model, "B", 1, ["nine", "tenths"]);
  lines(model, "A", 40, ["padding", "words"]);
  const line = model.predict(["nine", "tenths"], "out");
  // 9 of 10 is exactly 90 percent, not 89.999...: the integer comparison accepts it and rejects 91.
  expect(line?.record).toMatchObject({ inAccount: 9, inAll: 10, agreement: 0.9 });
  expect(accept(line, { ...defaults, minAgreement: 90 })?.accountId).toBe("A");
  expect(accept(line, { ...defaults, minAgreement: 91 })).toBeNull();
  // The record needs enough lines behind it.
  expect(accept(line, { ...defaults, minAgreement: 90, minExamples: 9 })?.accountId).toBe("A");
  expect(accept(line, { ...defaults, minAgreement: 90, minExamples: 10 })).toBeNull();
  // The line needs enough words the model has seen.
  expect(accept(line, { ...defaults, minAgreement: 90, minKnownWords: 2 })?.accountId).toBe("A");
  expect(accept(line, { ...defaults, minAgreement: 90, minKnownWords: 3 })).toBeNull();
  // The candidate must lead the runner-up. A near tie is left alone.
  const tied = new ClassifierModel();
  lines(tied, "A", 5, ["tie"]);
  lines(tied, "B", 5, ["tie"]);
  lines(tied, "C", 20, ["elsewhere"]);
  const tie = tied.predict(["tie"], "out");
  expect(accept(tie, { ...defaults, minAgreement: 50, minMargin: 10 })).toBeNull();
  expect(accept(null, defaults)).toBeNull();
  // The displayed confidence can be asked for too, as a bulk accept would.
  expect(accept(line, { ...defaults, minAgreement: 90 }, 90)).toBeNull();
  expect(accept(line, { ...defaults, minAgreement: 90 }, 80)?.accountId).toBe("A");
  // The limits the schema allows are the limits the defaults sit inside.
  for (const [key, { min, max }] of Object.entries(CONFIG_LIMITS)) {
    const value = defaults[key as keyof typeof CONFIG_LIMITS];
    expect(value >= min && value <= max, key).toBe(true);
  }
});

/** The Rho layout puts the account's own name on every row. */
const OWN = "Willow Lane Studio Rho Checking";
const VENDORS = [
  "FIGMA",
  "VERCEL",
  "DROPBOX",
  "NAMECHEAP",
  "MAILCHIMP",
  "CLOUDFLARE",
  "LINEAR",
  "NOTION",
];

/** A first week: eight software lines on the Rho account, and a few of other kinds on the Chase one. */
function firstWeek(options: { sources: boolean }): ClassifierModel {
  const model = new ClassifierModel();
  const learn = (account: string, text: string, source: string) =>
    model.addExample({
      key: `${source}:${text}:${model.examples}`,
      accountId: account,
      text,
      direction: "out",
      on: "2026-03-05",
      ...(options.sources ? { source } : {}),
    });
  for (const vendor of VENDORS) learn("software", `${vendor} INC ${OWN}`, "rho");
  for (const [account, merchant] of [
    ["meals", "CHIPOTLE"],
    ["travel", "UBER TRIP"],
    ["supplies", "STAPLES"],
    ["fees", "BANK SERVICE FEE"],
  ] as const)
    for (let line = 0; line < 4; line++) learn(account, merchant, "chase");
  return model;
}

test("words a statement writes into every line are not evidence: a merchant never seen gets no suggestion", () => {
  const model = firstWeek({ sources: true });
  const deposit = features(`STRIPE TRANSFER ${OWN}`);
  // "checking", "rho", "lane", "studio" and "willow" are on all eight Rho lines, and every one of
  // them went to software: read as evidence they say software, for a merchant never seen.
  expect(model.predict(deposit, "in", { source: "rho" })).toBeNull();
  // Another account's lines are read as they always were.
  expect(
    model.predict(features("CHIPOTLE"), "out", { source: "chase" })?.candidates[0]?.accountId,
  ).toBe("meals");
  // Without the account to judge by, the eight Rho lines are a minority of twenty-four and the
  // words look like a record. This is why the account is kept with every line it learns from.
  expect(accept(model.predict(deposit, "in"), defaults)?.accountId).toBe("software");
});

test("a merchant's own word still counts on the same statement", () => {
  const model = firstWeek({ sources: true });
  for (let line = 0; line < 4; line++)
    model.addExample({
      key: `figma:${line}`,
      accountId: "software",
      text: `FIGMA INC ${OWN}`,
      direction: "out",
      on: "2026-03-20",
      source: "rho",
    });
  const prediction = model.predict(features(`FIGMA INC ${OWN}`), "out", { source: "rho" });
  expect(accept(prediction, defaults)?.accountId).toBe("software");
  // The record is the merchant's own word, not the words every line has.
  expect(prediction?.record.word).toBe("figma");
  expect(prediction?.record).toMatchObject({ inAccount: 5, inAll: 5 });
  expect(prediction?.evidence.map((entry) => entry.word)).not.toContain("checking");
});

test("with no account known, a word in most of all the lines is still left out", () => {
  const model = new ClassifierModel();
  for (const vendor of VENDORS)
    model.addExample({
      key: vendor,
      accountId: "software",
      text: `${vendor} INC ${OWN}`,
      direction: "out",
      on: "2026-03-05",
    });
  expect(model.predict(features(`STRIPE TRANSFER ${OWN}`), "in")).toBeNull();
});

test("fewer than five lines cannot say what most lines share", () => {
  const afterLines = (count: number) => {
    const model = new ClassifierModel();
    for (let line = 0; line < count; line++)
      model.addExample({
        key: `${line}`,
        accountId: "software",
        text: `ACME ${OWN}`,
        direction: "out",
        on: "2026-03-05",
        source: "rho",
      });
    return model.predict(features(`OTHER ${OWN}`), "out", { source: "rho" });
  };
  // Four lines that all carry a word: it is read, as a merchant's would be. Five say "most".
  expect(afterLines(4)?.record.word).toBe("checking");
  expect(afterLines(5)).toBeNull();
});

test("the replay reads words the way suggesting does, so a first week is not scored as lucky", () => {
  const vendors = [...VENDORS, "ASANA", "BOX", "ZAPIER", "CALENDLY"];
  const examples: TrainingExample[] = vendors.map((vendor, index) => ({
    key: `${index}`,
    accountId: "software",
    text: `${vendor} INC ${OWN}`,
    direction: "out",
    on: `2026-03-${String(1 + index).padStart(2, "0")}`,
    source: "rho",
  }));
  // Twelve different vendors, one account, and nothing in common but the account's own name: no
  // line is like one seen before, so nothing is suggested and nothing is claimed.
  const report = evaluate(examples, { config: defaults, warmup: 6 });
  expect(report.scored).toBe(6);
  expect(report.proposed).toBe(0);
});

test("the same history gives the same classifier, however it arrives", () => {
  const history = classifierHistory();
  const forward = ClassifierModel.from(history);
  const backward = ClassifierModel.from([...history].reverse());
  const next = random(5);
  for (let run = 0; run < 200; run++) {
    const example = history[Math.floor(next() * history.length)] as TrainingExample;
    const words = features(example.text);
    expect(JSON.stringify(forward.predict(words, example.direction))).toBe(
      JSON.stringify(backward.predict(words, example.direction)),
    );
  }
  expect(forward.accounts()).toEqual(backward.accounts());
});

test("the fixture is deterministic, large, hard and ASCII", () => {
  const first = classifierHistory();
  expect(JSON.stringify(classifierHistory())).toBe(JSON.stringify(first));
  expect(JSON.stringify(classifierHistory({ seed: 1 }))).not.toBe(JSON.stringify(first));
  expect(first.length).toBeGreaterThan(1200);
  expect(first.length).toBeLessThan(1700);
  expect(new Set(first.map((example) => example.accountId)).size).toBe(
    Object.keys(ACCOUNTS).length,
  );
  expect(first.map((example) => example.on)).toEqual(
    [...first.map((example) => example.on)].sort(),
  );
  for (const example of first) {
    expect(example.on).toMatch(/^20(25|26)-\d\d-\d\d$/);
    for (const char of example.text) expect(char.charCodeAt(0)).toBeLessThan(128);
  }
  // Amazon really is booked several ways in this history.
  const amazon = new Set(
    first
      .filter((example) => example.text.includes("AMAZON MKTP"))
      .map((example) => example.accountId),
  );
  expect(amazon.size).toBeGreaterThanOrEqual(4);
});

test("evaluation on a realistic history: precision, recall and coverage at the defaults", () => {
  const history = classifierHistory();
  const report = evaluate(history, { config: defaults });
  console.log(
    `classifier evaluation (synthetic fixture): ${report.examples} lines, ${report.warmup} learned before scoring, ${report.scored} scored; ` +
      `${report.proposed} suggested, ${report.correct} right; precision ${percent(report.precision)}, recall ${percent(report.recall)}, coverage ${percent(report.coverage)}`,
  );
  for (const row of report.thresholds)
    console.log(
      `  confidence >= ${row.minConfidence}%: ${row.proposed} suggested, ${row.correct} right, precision ${percent(row.precision)}, recall ${percent(row.recall)}`,
    );
  expect(report.examples).toBe(history.length);
  expect(report.warmup).toBe(Math.floor(history.length / 4));
  expect(report.scored).toBe(history.length - report.warmup);
  // The bar: when it speaks it is almost always right, and it speaks for most lines.
  expect(report.precision.basisPoints).toBeGreaterThanOrEqual(9600);
  expect(report.recall.basisPoints).toBeGreaterThanOrEqual(6500);
  expect(report.coverage.basisPoints).toBeGreaterThanOrEqual(6500);
});

test("the bar holds on other histories of the same kind", () => {
  const seen: string[] = [];
  for (const seed of [7, 99, 2026, 31337, 4242]) {
    const report = evaluate(classifierHistory({ seed }), { config: defaults });
    seen.push(
      `seed ${seed}: precision ${percent(report.precision)}, recall ${percent(report.recall)}`,
    );
    expect(report.precision.basisPoints, `seed ${seed}`).toBeGreaterThanOrEqual(9500);
    expect(report.recall.basisPoints, `seed ${seed}`).toBeGreaterThanOrEqual(6500);
  }
  console.log(`classifier evaluation across seeds: ${seen.join("; ")}`);
  // With no human slips at all the same classifier is nearly perfect: the errors above are the
  // fixture's deliberate two-in-a-hundred mis-bookings, not the model.
  const clean = evaluate(classifierHistory({ wrongShare: 0 }), { config: defaults });
  console.log(
    `classifier evaluation with no mis-bookings: precision ${percent(clean.precision)}, recall ${percent(clean.recall)}`,
  );
  expect(clean.precision.basisPoints).toBeGreaterThanOrEqual(9900);
});

test("a higher displayed confidence is a stricter filter", () => {
  const report = evaluate(classifierHistory(), { config: defaults });
  expect(JSON.stringify(evaluate([...classifierHistory()].reverse(), { config: defaults }))).toBe(
    JSON.stringify(report),
  );
  expect(report.thresholds.map((row) => row.minConfidence)).toEqual([
    50, 60, 70, 80, 85, 90, 95, 99,
  ]);
  for (let index = 1; index < report.thresholds.length; index++)
    expect((report.thresholds[index] as { proposed: number }).proposed).toBeLessThanOrEqual(
      (report.thresholds[index - 1] as { proposed: number }).proposed,
    );
  // Taking only the most confident suggestions is right more often than taking them all.
  const top = report.thresholds.find((row) => row.minConfidence === 95);
  expect(top?.precision.basisPoints ?? 0).toBeGreaterThanOrEqual(report.precision.basisPoints ?? 0);
  expect(top?.proposed ?? 0).toBeLessThan(report.proposed);
});

test("the evaluation report adds up", () => {
  const history = classifierHistory();
  const report = evaluate(history, { config: defaults });
  expect(report.precision).toEqual({
    numerator: report.correct,
    denominator: report.proposed,
    basisPoints: Math.floor((report.correct * 10000) / report.proposed),
  });
  expect(report.recall.denominator).toBe(report.scored);
  expect(report.coverage.numerator).toBe(report.proposed);
  // Per account: precision over the suggestions made for it, recall over the lines that belong to
  // it, and the columns add up to the headline numbers.
  let scored = 0;
  let proposed = 0;
  let correct = 0;
  for (const row of report.accounts) {
    scored += row.scored;
    proposed += row.proposed;
    correct += row.correct;
    expect(row.recall).toEqual({
      numerator: row.correct,
      denominator: row.scored,
      basisPoints: row.scored === 0 ? null : Math.floor((row.correct * 10000) / row.scored),
    });
    expect(row.precision.numerator).toBe(row.correct);
    expect(row.precision.denominator).toBe(row.proposed);
    expect(row.correct).toBeLessThanOrEqual(Math.min(row.scored, row.proposed));
  }
  expect([scored, proposed, correct]).toEqual([report.scored, report.proposed, report.correct]);
  // The wrong suggestions are listed, most frequent first, never more than were made.
  const wrong = report.confusions.reduce((sum, row) => sum + row.count, 0);
  expect(wrong).toBeLessThanOrEqual(report.proposed - report.correct);
  expect(report.confusions.map((row) => row.count)).toEqual(
    [...report.confusions.map((row) => row.count)].sort((a, b) => b - a),
  );
  for (const row of report.confusions) expect(row.actual).not.toBe(row.predicted);
});

test("every line is scored by a classifier that has not seen it", () => {
  const same = (key: string, on: string, account: string): TrainingExample => ({
    key,
    accountId: account,
    text: "ACME COFFEE",
    direction: "out",
    on,
  });
  const lenient: ClassifierConfig = { ...defaults, minAgreement: 50, minMargin: 0, minExamples: 1 };
  // Two identical lines: the first is scored by an empty model and gets nothing; the second is
  // suggested "A" from the first, which is wrong because it truly belongs to B.
  const two = evaluate([same("1", "2026-01-01", "A"), same("2", "2026-01-02", "B")], {
    config: lenient,
    warmup: 0,
  });
  expect(two.scored).toBe(2);
  expect(two.proposed).toBe(1);
  expect(two.correct).toBe(0);
  expect(two.confusions).toEqual([{ actual: "B", predicted: "A", count: 1 }]);
  // A line that has never been seen is never suggested.
  const fresh = Array.from({ length: 30 }, (_, index) => ({
    key: `k${index}`,
    accountId: "A",
    text: `VENDOR${String.fromCharCode(97 + (index % 26))}${String.fromCharCode(97 + Math.floor(index / 26))}`,
    direction: "out" as const,
    on: `2026-02-${String(1 + (index % 28)).padStart(2, "0")}`,
  }));
  // Every memo is "vendorXY" with no words in common, so nothing is ever known.
  expect(evaluate(fresh, { config: lenient, warmup: 0 }).proposed).toBe(0);
  expect(evaluate([], { config: defaults }).scored).toBe(0);
  expect(evaluate([], { config: defaults }).precision.basisPoints).toBeNull();
  // Warm-up lines are learned from but not scored.
  const history = classifierHistory();
  expect(evaluate(history, { config: defaults, warmup: 100 }).scored).toBe(history.length - 100);
  expect(evaluate(history, { config: defaults, warmup: 10_000 }).scored).toBe(0);
});

test("the proposer reads a bank line the same way training read the memo", () => {
  const model = ClassifierModel.from(classifierHistory());
  const proposer = createClassifierProposer(model, defaults);
  const accounts = Object.values(ACCOUNTS).map((code) => ({
    id: code,
    code,
    name: `Account ${code}`,
    role: code < "4000" ? "equity" : code < "6000" ? "income" : "expense",
    closedOn: null as string | null,
  }));
  const ctx = {
    accounts: [
      { id: "1010", code: "1010", name: "Checking", role: "asset", closedOn: null },
      ...accounts,
    ],
  };
  const on = (description: string, amount = "-4.00", extra: { counterparty?: string } = {}) =>
    proposer.propose(
      item(bankLine({ description, amount, ...extra }), { ledgerAccountId: "1010" }),
      ctx,
    );
  const proposals = on("GITHUB, INC. SAN FRANCISCO CA 9Z8Y7X");
  expect(proposals).toHaveLength(1);
  expect(proposals[0]?.legs?.map((leg) => leg.accountId)).toEqual([
    "1010",
    ACCOUNTS.software as string,
  ]);
  expect(proposals[0]?.confidence).toBeGreaterThan(0.9);
  expect(proposals[0]?.confidence).toBeLessThanOrEqual(0.99);
  // A bare merchant name is enough: its record is what counts.
  expect(on("GITHUB")[0]?.legs?.[1]?.accountId).toBe(ACCOUNTS.software as string);
  // The counterparty is read with the memo, as it will be when the Inbox supplies one.
  expect(lineText({ counterparty: "GitHub", description: "monthly" })).toBe("GitHub monthly");
  expect(on("PAYMENT 4421", "-4.00", { counterparty: "GitHub" })[0]?.legs?.[1]?.accountId).toBe(
    ACCOUNTS.software as string,
  );
  // Reasons are short enough for the Inbox and say what the suggestion rests on.
  const reasons = proposals[0]?.reasons ?? [];
  expect(reasons.length).toBeGreaterThanOrEqual(3);
  expect(reasons.length).toBeLessThanOrEqual(8);
  for (const reason of reasons) expect(reason.length).toBeLessThanOrEqual(300);
  expect(reasons.join(" ")).toContain("github");
  expect(reasons.join(" ")).toMatch(/went to 6100 Account 6100 on \d+ of the \d+ lines/);
  // Ambiguous merchants get no suggestion at all: Amazon is supplies, equipment and groceries.
  expect(on("AMAZON MKTP US*2K4AB5 AMZN.COM/BILL WA", "-23.99")).toEqual([]);
  // Money in is read as money in.
  expect(on("STRIPE TRANSFER ST-8F3K2L", "900.00")[0]?.legs?.[1]?.accountId).toBe(
    ACCOUNTS.revenue as string,
  );
  // It never suggests the account the line is on, or a closed one.
  const closed = {
    accounts: ctx.accounts.map((account) =>
      account.id === ACCOUNTS.software ? { ...account, closedOn: "2026-02-01" } : account,
    ),
  };
  expect(
    proposer.propose(
      item(bankLine({ description: "GITHUB, INC.", amount: "-4.00" }), { ledgerAccountId: "1010" }),
      closed,
    ),
  ).toEqual([]);
  expect(
    proposer.propose(
      item(bankLine({ description: "GITHUB, INC.", amount: "-4.00" }), {
        ledgerAccountId: ACCOUNTS.software as string,
      }),
      ctx,
    ),
  ).toEqual([]);
  // It is off when switched off, and quiet for lines that are not bank lines in review.
  expect(
    createClassifierProposer(model, { ...defaults, enabled: false }).propose(
      item(bankLine({ description: "GITHUB" })),
      ctx,
    ),
  ).toEqual([]);
  expect(
    proposer.propose(item(bankLine({ description: "GITHUB" }), { status: "posted" }), ctx),
  ).toEqual([]);
  expect(proposer.propose(item(bankLine({ description: "GITHUB", amount: "0.00" })), ctx)).toEqual(
    [],
  );
});

test("training and evaluating thousands of lines takes well under a second", () => {
  const base = classifierHistory();
  const history: TrainingExample[] = [];
  for (let copy = 0; copy < 8; copy++)
    for (const example of base) history.push({ ...example, key: `${example.key}:${copy}` });
  const started = performance.now();
  const model = ClassifierModel.from(history);
  const trained = performance.now() - started;
  const report = evaluate(base, { config: defaults });
  const evaluated = performance.now() - started - trained;
  const proposerStarted = performance.now();
  const proposer = createClassifierProposer(model, defaults);
  const ctx = {
    accounts: Object.values(ACCOUNTS).map((code) => ({
      id: code,
      code,
      name: code,
      role: "expense",
      closedOn: null,
    })),
  };
  let proposed = 0;
  for (const example of base)
    proposed += proposer.propose(
      item(
        bankLine({
          description: example.text,
          amount: example.direction === "in" ? "10.00" : "-10.00",
        }),
        { ledgerAccountId: "1010" },
      ),
      ctx,
    ).length;
  const proposing = performance.now() - proposerStarted;
  console.log(
    `classifier performance: train on ${history.length} lines ${trained.toFixed(0)} ms; evaluate ${base.length} lines ${evaluated.toFixed(0)} ms; propose for ${base.length} lines ${proposing.toFixed(0)} ms (${proposed} suggested)`,
  );
  expect(report.scored).toBeGreaterThan(0);
  expectWithin("training the classifier", trained, 2000);
  expectWithin("evaluating it", evaluated, 5000);
  expectWithin("proposing with it", proposing, 5000);
});
