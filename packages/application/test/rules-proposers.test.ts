import { afterEach, expect, test } from "bun:test";
import type { IngestItem, Proposal, ProposalContext } from "../src/ingest-types.ts";
import { sumMoney } from "../src/money.ts";
import { registeredProposers } from "../src/slices/ingest/proposers.ts";
import { agent, author, githubRule, rulesBook } from "./fixtures/rules-book.ts";
import { bankLine } from "./fixtures/rules-kit.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const work of cleanup.splice(0)) work();
});

async function fixture(options: { realClock?: boolean } = {}) {
  const f = await rulesBook({ clean: (work) => cleanup.push(work), ...options });
  await f.setup();
  return f;
}

const registration = (name: string) => {
  const found = registeredProposers().find((item) => item.name === name);
  if (!found) throw new Error(`${name} is not registered`);
  return found;
};

async function contextOf(f: Awaited<ReturnType<typeof fixture>>): Promise<ProposalContext> {
  const accounts = (await f.read("accounts.list")).accounts as {
    id: string;
    code: string;
    name: string;
    role: string;
    closedOn: string | null;
  }[];
  return { accounts, currency: "USD" };
}

const item = (partial: Partial<IngestItem> = {}): IngestItem => ({
  id: "item-1",
  line: bankLine({ description: "GITHUB, INC. 8F2K3", amount: "-4.00" }),
  batchId: "batch-1",
  status: "new",
  ledgerAccountId: "1010",
  ...partial,
});

test("rules and the classifier register as proposers with the Inbox", async () => {
  const names = registeredProposers().map((entry) => entry.name);
  expect(names).toContain("rules");
  expect(names).toContain("classifier");
  expect(names).toEqual([...names].sort());
});

test("a fresh book answers every read before any rule exists, with no setup call first", async () => {
  const f = await fixture({ realClock: true });
  expect((await f.read("rules.list")).count).toBe(0);
  expect((await f.read("classifier.status")).examples).toBe(0);
  expect((await f.read("classifier.evaluate")).examples).toBe(0);
  expect(
    (await f.read("rules.suggest", { description: "GITHUB", amount: "-4.00" })).rule,
  ).not.toBeNull();
  expect((await f.read("rules.test", { rule: githubRule() })).history.considered).toBe(0);
  // And the proposers can run first, before this lane has been touched in any other way.
  const again = await rulesBook({ clean: (work) => cleanup.push(work), realClock: true });
  await again.setup();
  const proposer = registration("rules").create(again.service);
  expect(proposer.propose(item(), await contextOf(again))).toEqual([]);
  expect(
    registration("classifier")
      .create(again.service)
      .propose(item(), await contextOf(again)),
  ).toEqual([]);
});

test("the rules proposer proposes from stored rules, using the real chart", async () => {
  const f = await fixture();
  await f.write("rules.create", { rule: githubRule(), madeBy: agent });
  const context = await contextOf(f);
  const proposer = registration("rules").create(f.service);
  const proposals = proposer.propose(item(), context);
  expect(proposals).toHaveLength(1);
  const proposal = proposals[0] as Proposal;
  expect(proposal.kind).toBe("categorize");
  expect(proposal.confidence).toBe(1);
  expect(proposal.legs).toEqual([
    { accountId: "1010", amount: "-4.00" },
    { accountId: "6100", amount: "4.00" },
  ]);
  expect(sumMoney((proposal.legs ?? []).map((leg) => leg.amount))).toBe("0.00");
  expect(proposal.reasons.length).toBeGreaterThan(0);
  expect(proposal.reasons.length).toBeLessThanOrEqual(8);
  for (const reason of proposal.reasons) expect(reason.length).toBeLessThanOrEqual(300);
  expect(proposal.proposer).toMatch(/^rule:/);
  // A line the rule does not match gets nothing; so does one in another status.
  expect(
    proposer.propose(item({ line: bankLine({ description: "SOMEONE ELSE" }) }), context),
  ).toEqual([]);
  expect(proposer.propose(item({ status: "posted" }), context)).toEqual([]);
  // The pipeline's snapshot is not changed by edits made after the run began.
  const created = (await f.read("rules.list")).rules[0];
  await f.write("rules.update", {
    ruleId: created.id,
    expectedRevision: 1,
    rule: githubRule({ enabled: false }),
    madeBy: author,
  });
  expect(proposer.propose(item(), context)).toHaveLength(1);
  expect(registration("rules").create(f.service).propose(item(), context)).toEqual([]);
});

test("the proposers' revisions change exactly when what they read changes", async () => {
  const f = await fixture();
  const rules = registration("rules");
  const classifier = registration("classifier");
  const start = {
    rules: rules.revision?.(f.service),
    classifier: classifier.revision?.(f.service),
  };
  expect(start.rules).toBeString();
  expect(rules.revision?.(f.service)).toBe(start.rules);
  const created = await f.write("rules.create", { rule: githubRule(), madeBy: author });
  const afterCreate = rules.revision?.(f.service);
  expect(afterCreate).not.toBe(start.rules);
  expect(classifier.revision?.(f.service)).toBe(start.classifier);
  const updated = await f.write("rules.update", {
    ruleId: created.id,
    expectedRevision: 1,
    rule: githubRule({ name: "Renamed" }),
    madeBy: author,
  });
  const afterUpdate = rules.revision?.(f.service);
  expect(afterUpdate).not.toBe(afterCreate);
  // A no-op edit changes nothing, so stored proposals are not needlessly redone.
  await f.write("rules.update", {
    ruleId: created.id,
    expectedRevision: updated.revision,
    rule: githubRule({ name: "Renamed" }),
    madeBy: author,
  });
  expect(rules.revision?.(f.service)).toBe(afterUpdate);
  const second = await f.write("rules.create", {
    rule: githubRule({ name: "Second" }),
    madeBy: author,
  });
  const listed = await f.read("rules.list");
  const before = rules.revision?.(f.service);
  await f.write("rules.reorder", {
    expectedRulesRevision: listed.rulesRevision,
    orderedRuleIds: [second.id, created.id],
    madeBy: author,
  });
  expect(rules.revision?.(f.service)).not.toBe(before);
  const beforeDelete = rules.revision?.(f.service);
  await f.write("rules.delete", { ruleId: second.id, expectedRevision: 1, madeBy: author });
  expect(rules.revision?.(f.service)).not.toBe(beforeDelete);
  // The classifier's revision follows its thresholds. What it has learned is not in it: learning marks the
  // lines it could change for proposing again as it happens (test/rules-learning.test.ts), and only those.
  await f.write("classifier.configure", { minAgreement: 80 });
  const afterConfigure = classifier.revision?.(f.service);
  expect(afterConfigure).not.toBe(start.classifier);
  await f.post("2026-03-02", "GITHUB, INC.", "-4.00", "6100");
  await f.write("classifier.train", {});
  expect(classifier.revision?.(f.service)).toBe(afterConfigure);
  // Both survive a restart: the revision is stored, not remembered.
  const remembered = {
    rules: rules.revision?.(f.service),
    classifier: classifier.revision?.(f.service),
  };
  await f.restart();
  expect(rules.revision?.(f.service)).toBe(remembered.rules);
  expect(classifier.revision?.(f.service)).toBe(remembered.classifier);
});

test("the classifier proposes from posted history once trained, and stays quiet when unsure", async () => {
  const f = await fixture();
  const memos: [string, string, string][] = [
    ["GITHUB, INC. SAN FRANCISCO CA", "-4.00", "6100"],
    ["FIGMA MONTHLY 8F2K3", "-15.00", "6100"],
    ["AWS EMEA 123456", "-61.20", "6200"],
    ["CLOUDFLARE INC", "-20.00", "6200"],
  ];
  let day = 1;
  for (let round = 0; round < 4; round++)
    for (const [memo, amount, account] of memos) {
      await f.post(`2026-03-${String(day).padStart(2, "0")}`, memo, amount, account);
      day = (day % 28) + 1;
    }
  const context = await contextOf(f);
  const make = () => registration("classifier").create(f.service);
  // Before training it has learned nothing and proposes nothing.
  expect(make().propose(item(), context)).toEqual([]);
  await f.write("classifier.train", {});
  const proposals = make().propose(item(), context);
  expect(proposals).toHaveLength(1);
  const proposal = proposals[0] as Proposal;
  expect(proposal.proposer).toBe("classifier");
  // "github" went to Software on 4 of the 4 lines containing it: (4 + 1) / (4 + 2), 83 percent.
  expect(proposal.confidence).toBe(0.83);
  expect(proposal.legs).toEqual([
    { accountId: "1010", amount: "-4.00" },
    { accountId: "6100", amount: "4.00" },
  ]);
  expect(proposal.reasons.join(" ")).toContain("6100 Software");
  expect(proposal.reasons.join(" ")).toContain("github");
  // A refund from the same merchant goes to the same account, with the entry the other way round.
  const refund = make().propose(
    item({ line: bankLine({ description: "GITHUB, INC.", amount: "4.00" }) }),
    context,
  );
  expect(refund[0]?.legs).toEqual([
    { accountId: "1010", amount: "4.00" },
    { accountId: "6100", amount: "-4.00" },
  ]);
  // A merchant it has never seen gets nothing: it says nothing rather than guessing.
  expect(
    make().propose(
      item({ line: bankLine({ description: "BRAND NEW VENDOR", amount: "-9.00" }) }),
      context,
    ),
  ).toEqual([]);
  // Switching it off silences it.
  await f.write("classifier.configure", { enabled: false });
  expect(make().propose(item(), context)).toEqual([]);
  // It never proposes the account the line is on, or a closed account.
  await f.write("classifier.configure", { enabled: true });
  expect(make().propose(item({ ledgerAccountId: "6100" }), context)).toEqual([]);
  const closed = {
    accounts: context.accounts.map((account) =>
      account.id === "6100" ? { ...account, closedOn: "2026-02-01" } : account,
    ),
  };
  expect(make().propose(item(), closed)).toEqual([]);
});

test("proposers are deterministic over a restart", async () => {
  const f = await fixture();
  await f.write("rules.create", { rule: githubRule(), madeBy: author });
  const context = await contextOf(f);
  const before = JSON.stringify(registration("rules").create(f.service).propose(item(), context));
  await f.restart();
  const after = JSON.stringify(registration("rules").create(f.service).propose(item(), context));
  expect(after).toBe(before);
});
