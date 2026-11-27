import { readAccountTags } from "../../account-tags.ts";
import type {
  IngestItem,
  Proposal,
  ProposalContext,
  ProposedLeg,
  Proposer,
} from "../../ingest-types.ts";
import { absMoney, formatMoney, negateMoney, parseMoney } from "../../money.ts";
import type { ApplicationService } from "../../service.ts";
import {
  type DepositCandidate,
  type Pairing,
  type PayoutCandidate,
  matchPayouts,
} from "../../stripe/payout-match.ts";
import { type ProposerRegistration, registerProposer } from "../ingest/proposers.ts";
import { countsByStatus } from "../ingest/read.ts";
import { ingestRuntime } from "../ingest/store.ts";
import {
  type PluginInstallRecord,
  type PluginPayoutRecord,
  type StoredRoleSpec,
  pluginState,
} from "./store.ts";

/** Generic plugin proposer registered with the Inbox proposer registry.
 *
 * Does two jobs for EVERY installed ingestion plugin without per-provider core code:
 * 1. Resolves multi-leg `LedgerEvent` roles into the book's chart accounts (explicit `roleMap`
 *    override first, then chart `roleKey` tag effective on `eventOn`) and proposes the balanced
 *    entry at confidence 1.0. Covered evidence items are never proposed on their own.
 * 2. For plugins that declare `manifest.clearing` (e.g. Shopify, Square, Gumroad, Stripe), runs
 *    1-to-1 date-proximity matching (`matchPayouts`) between open bank deposits and recorded
 *    clearing payouts, proposing the deposit entry that clears the in-transit account. */

export const PLUGINS_PROPOSER = "plugins";
const MATCH_VERSION = 1;
const MAX_REASONS = 8;
const MAX_REASON_LENGTH = 300;

function boundedReasons(reasons: readonly string[]): string[] {
  return reasons
    .filter((r) => r.trim().length > 0)
    .slice(0, MAX_REASONS)
    .map((r) => (r.length > MAX_REASON_LENGTH ? `${r.slice(0, MAX_REASON_LENGTH - 1)}…` : r));
}

export interface ResolvedPluginRole {
  readonly spec: StoredRoleSpec;
  readonly accountId: string | null;
  readonly source: "override" | "roleKey" | "unmapped";
  readonly problem: string | null;
}

type AccountSummary = ProposalContext["accounts"][number];

function accountMatchesRoleKind(accountRole: string, wanted: StoredRoleSpec["kind"]): boolean {
  if (wanted === "income") return accountRole === "income" || accountRole === "gain";
  return accountRole === wanted;
}

function isOpenOn(account: AccountSummary, onDate: string): boolean {
  if (account.postingAllowed === false) return false;
  if (account.openedOn && onDate < account.openedOn) return false;
  if (account.closedOn && onDate > account.closedOn) return false;
  return true;
}

/** Resolve all roles declared by an installed plugin on a given date against chart accounts & tags. */
export function resolvePluginRoles(
  install: PluginInstallRecord,
  accounts: readonly AccountSummary[],
  tagsFor: (accountId: string, asOf: string) => { readonly roleKey?: string },
  asOf: string,
): ResolvedPluginRole[] {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const overrides = new Map(install.roleMap.map((r) => [r.role, r.accountId]));

  return install.manifest.roles.map((spec): ResolvedPluginRole => {
    const overrideId = overrides.get(spec.key);
    if (overrideId !== undefined) {
      const account = byId.get(overrideId);
      if (!account) {
        return {
          spec,
          accountId: null,
          source: "override",
          problem: `Mapped account "${overrideId}" for role "${spec.label}" does not exist.`,
        };
      }
      if (!accountMatchesRoleKind(account.role, spec.kind)) {
        return {
          spec,
          accountId: null,
          source: "override",
          problem: `Account "${account.name}" is ${account.role}, expected ${spec.kind} for "${spec.label}".`,
        };
      }
      if (!isOpenOn(account, asOf)) {
        return {
          spec,
          accountId: null,
          source: "override",
          problem: `Account "${account.name}" is closed on ${asOf}.`,
        };
      }
      return { spec, accountId: account.id, source: "override", problem: null };
    }

    const wantedKey = spec.defaultRoleKey ?? spec.key;
    const matched = accounts.filter(
      (account) =>
        isOpenOn(account, asOf) &&
        accountMatchesRoleKind(account.role, spec.kind) &&
        tagsFor(account.id, asOf).roleKey === wantedKey,
    );
    if (matched.length === 1 && matched[0]) {
      return { spec, accountId: matched[0].id, source: "roleKey", problem: null };
    }
    if (matched.length > 1) {
      return {
        spec,
        accountId: null,
        source: "unmapped",
        problem: `Multiple open accounts carry role key "${wantedKey}"; pick one in plugin configuration.`,
      };
    }
    return {
      spec,
      accountId: null,
      source: "unmapped",
      problem: spec.required
        ? `No open ${spec.kind} account is mapped for "${spec.label}" (${spec.key}).`
        : null,
    };
  });
}

interface DepositRow {
  readonly id: string;
  readonly provider: string;
  readonly posted_on: string;
  readonly amount: string;
  readonly currency: string;
  readonly status: string;
  readonly decision: string | null;
}

interface ClearingPlan {
  readonly plugin: PluginInstallRecord;
  readonly clearingAccountId: string;
  readonly forDeposit: ReadonlyMap<string, Pairing>;
  readonly payoutById: ReadonlyMap<string, PluginPayoutRecord>;
}

function buildClearingPlans(
  service: ApplicationService,
  installs: readonly PluginInstallRecord[],
  accounts: readonly AccountSummary[],
  tags: ReturnType<typeof readAccountTags>,
): ClearingPlan[] {
  const clearingPlugins = installs.filter(
    (install) => install.enabled && install.manifest.clearing !== undefined,
  );
  if (clearingPlugins.length === 0) return [];

  const deposits = ingestRuntime(service)
    .store.query(
      `SELECT id, provider, posted_on, amount, currency, status, decision FROM app_ingest_items
       WHERE kind = 'bankLine' AND status <> 'excluded'
         AND substr(amount, 1, 1) <> '-' AND amount <> '0.00'`,
    )
    .all() as DepositRow[];

  const today = service.now().slice(0, 10);
  const state = pluginState(service);
  const plans: ClearingPlan[] = [];

  for (const plugin of clearingPlugins) {
    const clearing = plugin.manifest.clearing;
    if (!clearing) continue;
    const resolved = resolvePluginRoles(
      plugin,
      accounts,
      (id, asOf) => tags.tagsFor(id, asOf),
      today,
    );
    const clearingRole = resolved.find((r) => r.spec.key === clearing.role);
    if (!clearingRole?.accountId) continue;
    const clearingAccountId = clearingRole.accountId;

    const payouts = state.listPayouts(plugin.pluginId);
    if (payouts.length === 0) continue;

    const settledPayouts = new Set<string>();
    const openCandidates: DepositCandidate[] = [];
    const settledPool: { id: string; settled: boolean }[] = [];

    for (const row of deposits) {
      if (row.provider === plugin.pluginId) continue;
      const cents = parseMoney(row.amount);
      if (cents <= 0n) continue;
      if (row.status === "drafted" || row.status === "posted") {
        const parsed = row.decision
          ? (JSON.parse(row.decision) as {
              legs?: { accountId?: string }[];
              links?: Record<string, string>;
            })
          : null;
        const clearsThis =
          parsed?.legs?.some((leg) => leg.accountId === clearingAccountId) ?? false;
        if (!clearsThis) continue;
        const namedPayout = parsed?.links?.payout;
        if (namedPayout) {
          settledPayouts.add(namedPayout);
          continue;
        }
        settledPool.push({ id: row.id, settled: true });
      } else {
        settledPool.push({ id: row.id, settled: false });
      }
      openCandidates.push({
        ref: row.id,
        amount: cents,
        currency: row.currency.toUpperCase(),
        date: row.posted_on,
      });
    }

    const payoutCandidates: PayoutCandidate[] = payouts
      .filter((p) => !settledPayouts.has(p.providerId))
      .map((p) => ({
        id: p.providerId,
        amount: p.amountCents,
        currency: p.currency.toUpperCase(),
        arrivalOn: p.eventOn,
      }));

    if (payoutCandidates.length === 0 || openCandidates.length === 0) continue;

    const matched = matchPayouts(payoutCandidates, openCandidates, clearing.windowDays);
    const settledFlag = new Map(settledPool.map((p) => [p.id, p.settled]));
    const forDeposit = new Map<string, Pairing>();
    for (const pair of matched.pairs) {
      if (!settledFlag.get(pair.deposit)) {
        forDeposit.set(pair.deposit, pair);
      }
    }
    plans.push({
      plugin,
      clearingAccountId,
      forDeposit,
      payoutById: new Map(payouts.map((p) => [p.providerId, p])),
    });
  }

  return plans;
}

function proposePluginEvent(
  item: IngestItem,
  install: PluginInstallRecord,
  context: ProposalContext,
  tags: ReturnType<typeof readAccountTags>,
): readonly Proposal[] {
  const line = item.line;
  if (line.kind !== "event" || line.coveredBy !== undefined) return [];
  if (context.currency && line.currency !== context.currency) return [];

  const resolved = resolvePluginRoles(
    install,
    context.accounts,
    (id, asOf) => tags.tagsFor(id, asOf),
    line.eventOn,
  );
  const byRole = new Map(resolved.map((r) => [r.spec.key, r]));

  const merged = new Map<string, bigint>();
  for (const leg of line.legs) {
    const target = byRole.get(leg.role);
    if (!target?.accountId) return [];
    merged.set(target.accountId, (merged.get(target.accountId) ?? 0n) + parseMoney(leg.amount));
  }

  const legs: ProposedLeg[] = [...merged]
    .filter(([, cents]) => cents !== 0n)
    .map(([accountId, cents]) => ({ accountId, amount: formatMoney(cents) }));
  if (legs.length < 2 || legs.reduce((sum, leg) => sum + parseMoney(leg.amount), 0n) !== 0n) {
    return [];
  }

  const reasons = [
    `${install.manifest.name} event ${line.providerId} (${line.legs.length} balanced legs mapped from plugin roles).`,
    ...line.legs.map((leg) => {
      const spec = byRole.get(leg.role)?.spec;
      const cents = parseMoney(leg.amount);
      return `${spec?.label ?? leg.role}: ${cents < 0n ? "credit" : "debit"} ${absMoney(leg.amount)}${leg.memo ? ` (${leg.memo})` : ""}`;
    }),
  ];

  return [
    {
      proposer: `plugin:${install.pluginId}`,
      kind: "event",
      confidence: 1,
      reasons: boundedReasons(reasons),
      legs,
      narration: line.summary,
      ...(line.links ? { links: line.links } : {}),
    },
  ];
}

function proposeClearingDeposit(
  item: IngestItem,
  plans: readonly ClearingPlan[],
): readonly Proposal[] {
  const line = item.line;
  if (line.kind !== "bankLine" || !item.ledgerAccountId) return [];
  if (parseMoney(line.amount) <= 0n) return [];

  const proposals: Proposal[] = [];
  for (const plan of plans) {
    if (line.provider === plan.plugin.pluginId) continue;
    const pairing = plan.forDeposit.get(item.id);
    if (!pairing) continue;
    const payout = plan.payoutById.get(pairing.payout);
    if (!payout) continue;

    const amount = absMoney(line.amount);
    const confidence = pairing.contested ? 0.6 : pairing.tier === "exact" ? 0.97 : 0.9;
    const timing = pairing.tier === "exact" ? "same day" : "within clearing window";
    proposals.push({
      proposer: `plugin:${plan.plugin.pluginId}`,
      kind: "categorize",
      confidence,
      reasons: boundedReasons([
        `Matches ${plan.plugin.manifest.name} payout ${payout.providerId} (${amount}, ${timing}) clearing ${plan.plugin.manifest.clearing?.role ?? "in-transit"}.`,
        ...pairing.reasons,
      ]),
      legs: [
        { accountId: item.ledgerAccountId, amount },
        { accountId: plan.clearingAccountId, amount: negateMoney(amount) },
      ],
      narration: `${plan.plugin.manifest.name} payout ${payout.providerId} bank deposit`,
      links: { payout: payout.providerId, plugin: plan.plugin.pluginId },
    });
  }
  return proposals;
}

export const pluginsProposerRegistration: ProposerRegistration = {
  name: PLUGINS_PROPOSER,
  revision(service) {
    const state = pluginState(service);
    const tags = readAccountTags(service.store);
    const lines = countsByStatus(service, {}).total;
    return `v${MATCH_VERSION}|${state.proposerRevision()}|n:${lines}|t:${tags.revision}`;
  },
  create(service): Proposer {
    const state = pluginState(service);
    const installs = state.listInstalls();
    const byId = new Map(installs.map((i) => [i.pluginId, i]));
    const tags = readAccountTags(service.store);
    let clearingPlans: ClearingPlan[] | null = null;
    const plansFor = (accounts: readonly AccountSummary[]): readonly ClearingPlan[] =>
      (clearingPlans ??= buildClearingPlans(service, installs, accounts, tags));

    return {
      name: PLUGINS_PROPOSER,
      propose(item, context) {
        if (item.line.kind === "event") {
          const install = byId.get(item.line.provider);
          if (!install?.enabled) return [];
          return proposePluginEvent(item, install, context, tags);
        }
        const plans = plansFor(context.accounts);
        if (plans.length > 0) {
          return proposeClearingDeposit(item, plans);
        }
        return [];
      },
    };
  },
};

registerProposer(pluginsProposerRegistration);
