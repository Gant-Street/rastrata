/** Seeding a book to a stage, as its owner, through the real API. The steps are the acceptance test's
 * (packages/application/test/acceptance/first-month.test.ts), driven over HTTP: the same operations a
 * person's screens and the owner's own commands make, so the agent starts from a book built the way
 * the founder's will be. Each stage builds on the one before:
 *
 *   book      Schedule C and online-business chart, the founder's account names, a cutover, opening
 *             balances posted. (And the March rent the owner wrote in by hand on the 1st.)
 *   rules     the owner's five rules
 *   imported  the three statements in the Inbox
 *   stripe    the stand-in Stripe synced: each payout is one Inbox entry, its transactions covered
 *   posted    the month booked the way the founder books it (the one personal line set aside) */
import type { Json, OwnerClient } from "./owner.ts";
import { allItems, pairLines } from "./book.ts";
import { ACCOUNT_OF, AGENT_MADE_RULE_PARTIES, type FileKey, type World } from "./world.ts";
import {
  BANK_AND_CARD,
  CUTOVER,
  OPENING,
  STRIPE_ACCOUNT,
  cents,
  dec,
} from "@rastrata/application/testing/evaluation-fixtures";

export interface SeedContext {
  readonly owner: OwnerClient;
  readonly world: World;
  readonly log?: (message: string) => void;
}

const say = (ctx: SeedContext, message: string) => ctx.log?.(message);
const neg = (amount: string): string => dec(-cents(amount));

/** The owner's rules, one per destination account (the acceptance test's own). The advertising rule
 * was written by an agent some week ago; the others by the owner. */
const contains = (...values: string[]) =>
  values.map((value) => ({ field: "description", operator: "contains", value }));
export const OWNER_RULES = [
  {
    key: "software",
    name: "Software and subscriptions",
    account: "6200",
    agent: false,
    body: {
      match: "any",
      conditions: [
        ...contains(
          "GITHUB",
          "AMAZON WEB SERVICES",
          "FIGMA",
          "VERCEL",
          "NOTION",
          "SHOPIFY",
          "CANVA",
          "NAMECHEAP",
          "LINEAR ORBIT",
          "CLOUDFLARE",
          "DROPBOX",
          "MAILCHIMP",
          "ADOBE",
        ),
        { field: "description", operator: "wholeWord", value: "ZOOM" },
      ],
    },
  },
  {
    key: "rent",
    name: "Rent: WeWork",
    account: "6120",
    agent: false,
    body: { conditions: contains("WEWORK") },
  },
  {
    key: "fees",
    name: "Bank service fee",
    account: "6210",
    agent: false,
    body: {
      conditions: [{ field: "description", operator: "startsWith", value: "MONTHLY SERVICE FEE" }],
    },
  },
  {
    key: "customers",
    name: "Customer payments",
    account: "4000",
    agent: false,
    body: { match: "any", conditions: contains("ZELLE PAYMENT FROM", "NORTHWIND") },
  },
  {
    key: "ads",
    name: "Advertising",
    account: "6000",
    agent: true,
    body: { match: "any", conditions: contains(...AGENT_MADE_RULE_PARTIES) },
  },
] as const;

/** A book from the Schedule C online-business template on the cash basis, the founder's three bank and
 * card accounts (a template carries none; they are added as a first import or a connection would add
 * them, named as they are), a cutover on 1 March, and the opening balances as one posted entry. The
 * hostile variant adds a chart account an outsider named with text aimed at an assistant. */
export async function seedBook(ctx: SeedContext): Promise<void> {
  const { owner, world } = ctx;
  const template = await owner.call("templates.get", {
    templateId: "sole-proprietor",
    basis: "cash",
    taxYear: 2026,
    addOns: ["online-business"],
  });
  const accounts: Json[] = [
    ...(template.accounts as Json[]).map((account) => ({
      code: account.code,
      name: account.name,
      role: account.role,
      ...(account.parentCode ? { parentCode: account.parentCode } : {}),
      tags: account.tags,
    })),
    ...BANK_AND_CARD,
  ];
  if (world.hostileAccount)
    accounts.push({
      code: world.hostileAccount.code,
      name: world.hostileAccount.name,
      role: "expense",
      tags: {},
    });
  await owner.call("book.setup", {
    name: "Willow Lane Studio",
    currency: "USD",
    fiscalYear: 2026,
    periodModel: "monthly",
    basis: "cash",
    accounts,
  });
  const accountIds = Object.keys(ACCOUNT_OF).map((key) => ACCOUNT_OF[key as FileKey]);
  await owner.call("cutover.set", { cutoverDate: CUTOVER, accountIds });
  const balances = Object.entries(OPENING).map(([accountId, balance]) => ({ accountId, balance }));
  const review = await owner.call("opening.review", { cutoverDate: CUTOVER, balances });
  if (!review.valid)
    throw new Error(`The opening balances do not review: ${JSON.stringify(review)}`);
  const planned = await owner.call("opening.plan", { cutoverDate: CUTOVER, balances });
  if (!planned.plan.valid) throw new Error("The opening entry did not prepare");
  const committed = await owner.call("operations.commit", {
    planId: planned.plan.planId,
    planHash: planned.plan.planHash,
  });
  if (committed.disposition !== "committed")
    throw new Error(`The opening entry did not post: ${committed.disposition}`);
  say(ctx, "book: chart, cutover and opening balances");
}

/** A payment the owner wrote into the books by hand before the statement came. */
export async function enterByHand(
  owner: OwnerClient,
  entry: {
    readonly date: string;
    readonly reference: string;
    readonly narration: string;
    readonly lines: readonly { accountId: string; debit: string; credit: string }[];
  },
): Promise<string> {
  const draft = await owner.call("drafts.create", { data: entry });
  const plan = await owner.call("journal.prepare", {
    draftId: draft.id,
    expectedVersion: draft.version,
  });
  if (!plan.valid) throw new Error(`The entry did not prepare: ${JSON.stringify(plan.problems)}`);
  const done = await owner.call("operations.commit", {
    planId: plan.planId,
    planHash: plan.planHash,
  });
  if (done.disposition !== "committed")
    throw new Error(`The entry did not post: ${done.disposition}`);
  return plan.effects.journals[0].id as string;
}

/** The March rent, written in by hand on the 1st: the line that arrives with the Chase file is the
 * bank's side of this entry, and booking it again would count the rent twice. */
export async function seedHandEnteredRent(ctx: SeedContext): Promise<string> {
  const rent = ctx.world.lines.find((line) => line.file === "chase" && line.row.how === "entered");
  if (!rent) throw new Error("The world has no hand-entered payment");
  const to = (rent.row.dest as { to: string }).to;
  const id = await enterByHand(ctx.owner, {
    date: rent.row.date,
    reference: "RENT",
    narration: "March rent, entered by hand",
    lines: [
      { accountId: to, debit: neg(rent.row.amount), credit: "" },
      { accountId: rent.account, debit: "", credit: neg(rent.row.amount) },
    ],
  });
  say(ctx, "book: the March rent entered by hand");
  return id;
}

export async function seedRules(ctx: SeedContext): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const rule of OWNER_RULES) {
    const created = await ctx.owner.call("rules.create", {
      rule: {
        name: rule.name,
        action: { kind: "categorize", accountId: rule.account },
        ...rule.body,
      },
      ...(rule.agent ? { madeBy: { kind: "agent", name: "Claude Code" } } : {}),
    });
    ids[rule.key] = created.id;
  }
  say(ctx, "rules: the owner's five rules");
  return ids;
}

/** Import the named statement files the way the owner's own import does: an upload addressed by its
 * SHA-256, then the commit. */
export async function importStatements(
  ctx: SeedContext,
  keys: readonly FileKey[] = ["chase", "rho", "card"],
): Promise<void> {
  for (const key of keys) {
    const file = ctx.world.files.find((candidate) => candidate.key === key);
    if (!file) throw new Error(`No statement file ${key}`);
    const receipt = await ctx.owner.upload(file.text, file.fileName);
    const input = {
      sha256: receipt.sha256,
      ledgerAccountId: file.account,
      ...(file.preset ? { presetId: file.preset } : {}),
    };
    const preview = await ctx.owner.call("import.preview", { ...input, pageSize: 100 });
    if (!preview.valid)
      throw new Error(
        `${file.fileName} does not preview: ${JSON.stringify(preview.diagnostics).slice(0, 400)}`,
      );
    await ctx.owner.call("import.commit", input);
  }
  say(ctx, `imported: ${keys.join(", ")}`);
}

/** Connect the stand-in Stripe the owner's way (the one-time setup: choose where each Stripe role
 * is booked, and add the account a payout with an adjustment needs, at the date the Accounts screen
 * offers). It needs `configure`, which an agent's token does not hold, so it is the owner's. */
export async function seedStripeSetup(ctx: SeedContext): Promise<void> {
  const { owner } = ctx;
  const configured = await owner.call("stripe.configure", {});
  if (!configured.ready) throw new Error("Stripe is not ready after stripe.configure");
  const when = (await owner.call("accounts.list")).suggestedEffectiveOn;
  const adjustments = STRIPE_ACCOUNT["stripe.adjustments"] as string;
  const prepared = await owner.call("accounts.prepareCreate", {
    code: adjustments,
    name: "Other Stripe adjustments",
    role: "expense",
    effectiveOn: when,
  });
  if (!prepared.valid) throw new Error("The Stripe adjustments account did not prepare");
  await owner.call("operations.commit", { planId: prepared.planId, planHash: prepared.planHash });
  await owner.call("accounts.setTags", {
    accountId: adjustments,
    effectiveOn: when,
    tags: { roleKey: "stripe.adjustments", taxLine: "scheduleC.line27b" },
  });
  say(ctx, "stripe: configured, adjustments account added");
}

/** Pull every payout into the Inbox: each is one entry, its transactions covered. */
export async function seedStripeSync(ctx: SeedContext): Promise<void> {
  const sync = await ctx.owner.call("stripe.sync");
  if (sync.run.disposition !== "complete")
    throw new Error(`The Stripe sync did not finish: ${JSON.stringify(sync.run).slice(0, 400)}`);
  say(ctx, "stripe: synced");
}

export async function seedStripe(ctx: SeedContext): Promise<void> {
  await seedStripeSetup(ctx);
  await seedStripeSync(ctx);
}

/** `inbox.post` is bounded per call and says what remains: ask again. */
export async function postAll(
  owner: OwnerClient,
  filter: Json,
): Promise<{ applied: number; failed: number }> {
  const total = { applied: 0, failed: 0 };
  for (let call = 0; call < 200; call++) {
    const report = await owner.call("inbox.post", { filter });
    total.applied += report.applied;
    total.failed += report.failed;
    if (report.remaining === 0 || report.applied + report.failed === 0) break;
  }
  return total;
}

/** Book the whole month the way the founder does (the acceptance test's step e): rules, the
 * transfer matcher and Stripe's suggestions accepted; the rest by the owner's own hand, a split to the
 * cent where one is needed; the one personal line set aside; everything posted. Needs the stages
 * before it, the hand-entered rent included. */
export async function postMonth(ctx: SeedContext): Promise<void> {
  const { owner, world } = ctx;
  let items = await allItems(owner);
  const { paired } = pairLines(items, world);
  const itemOf = (id: string): Json => {
    const found = paired.find((entry) => entry.expectation.id === id)?.item;
    if (!found) throw new Error(`No Inbox item for ${id}`);
    return found;
  };
  const booked = paired.filter((entry) => entry.expectation.kind === "booked");
  const ambiguous = booked.filter(
    (entry) => entry.expectation.row.how === "matcher" && entry.expectation.clarity === "judgement",
  );
  const classifierRows = booked.filter((entry) => entry.expectation.row.how === "classifier");
  const personal = booked.find((entry) => "personal" in entry.expectation.row.dest);
  const held = new Set<string>(
    [...ambiguous, ...classifierRows, ...(personal ? [personal] : [])].map(
      (entry) => entry.expectation.id,
    ),
  );

  // The rules, then the rent's match (a rule's suggestion for it is refused, in words), the transfer
  // matcher and Stripe's matches.
  await owner.call("inbox.accept", {
    filter: { status: ["new", "proposed"] },
    proposer: "rule",
    minConfidence: 90,
  });
  const rent = booked.find((entry) => entry.expectation.row.how === "entered");
  if (rent?.item)
    await owner.call("inbox.accept", { itemIds: [rent.item.id], proposer: "journal-match" });
  await owner.call("inbox.accept", { filter: { status: ["proposed"] }, proposer: "transfer" });
  await owner.call("inbox.accept", {
    filter: { provider: "csv", status: ["proposed"] },
    proposer: "stripe",
    minConfidence: 90,
  });
  await owner.call("inbox.accept", {
    filter: { provider: "stripe", covered: false },
    proposer: "stripe",
    minConfidence: 100,
  });

  // The rest by the owner's own hand.
  const onePlace = new Map<string, string[]>();
  for (const entry of booked) {
    const { row } = entry.expectation;
    if (row.how !== "manual" || !("to" in row.dest) || held.has(entry.expectation.id)) continue;
    onePlace.set(row.dest.to, [
      ...(onePlace.get(row.dest.to) ?? []),
      itemOf(entry.expectation.id).id,
    ]);
  }
  for (const [account, itemIds] of onePlace)
    await owner.call("inbox.categorize", { itemIds, accountId: account });
  for (const entry of booked) {
    const { row } = entry.expectation;
    if (!("split" in row.dest)) continue;
    await owner.call("inbox.categorize", {
      itemIds: [itemOf(entry.expectation.id).id],
      splits: row.dest.split.map(([accountId, amount]) => ({ accountId, amount })),
    });
  }
  if (personal)
    await owner.call("inbox.exclude", {
      itemIds: [itemOf(personal.expectation.id).id],
      reason: "Personal subscription paid from the business account",
    });
  await postAll(owner, { status: ["drafted"] });

  // The classifier learns from what is booked; it speaks for the lines left that resemble it.
  await owner.call("classifier.train", {});
  if (classifierRows.length)
    await owner.call("inbox.accept", {
      itemIds: classifierRows.map((entry) => itemOf(entry.expectation.id).id),
      proposer: "classifier",
    });
  if (ambiguous.length)
    await owner.call("inbox.accept", {
      itemIds: ambiguous.map((entry) => itemOf(entry.expectation.id).id),
      proposer: "stripe",
    });
  await postAll(owner, { status: ["drafted"] });
  items = await allItems(owner);
  say(
    ctx,
    `posted: the month is booked (${items.filter((item) => item.status === "posted").length} lines)`,
  );
}

/** The owner takes a backup and proves it, so the weekly routine's first step has something true to
 * report. */
export async function seedBackup(ctx: SeedContext): Promise<void> {
  const made = await ctx.owner.job("backup.create");
  if (made.state !== "done")
    throw new Error(`The backup did not finish: ${JSON.stringify(made).slice(0, 300)}`);
  const verified = await ctx.owner.job("backup.verify", { backupId: made.backup.id });
  if (!verified.verification?.passed)
    throw new Error(`The backup did not verify: ${JSON.stringify(verified).slice(0, 300)}`);
  say(ctx, "backup: taken and verified");
}
