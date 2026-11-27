import { readAccountTags } from "../../account-tags.ts";
import { CLASSIFIER_LOGIC, createClassifierProposer } from "../../rules/classifier.ts";
import { compileEntry, createRulesProposer, firstMatch, prepareLine } from "../../rules/engine.ts";
import {
  createStarterProposer,
  STARTER_LOGIC,
  STARTER_PROPOSER,
} from "../../rules/starter/proposer.ts";
import type { ApplicationService } from "../../service.ts";
import { type ProposerRegistration, registerProposer } from "../ingest/proposers.ts";
import { accountOf, parseSettings, resolveRoles } from "../stripe/settings.ts";
import { stripeStore } from "../stripe/store.ts";
import { learnIfBehind, loadHistory, loadModel } from "./classifier-ops.ts";
import { readConfig, readRules, rulesRevision, rulesState } from "./store.ts";

/** How rules, the classifier and the starter list reach the Inbox: as proposers in the ingest lane's
 * registry, in that order of standing. A rule decides; the classifier suggests what the book's own
 * history shows; the starter list (rules/starter) is asked last and only for a line nothing else has
 * a suggestion for.
 *
 * Both are pure and only suggest. The registry calls `create` once per proposing run and uses that
 * snapshot for every item, so a run never sees half of an edit. `revision` is how stored proposals
 * learn they are stale: it changes whenever a rule is created, changed, deleted, reordered or
 * switched on or off, and whenever the classifier is retrained or its thresholds change, and the
 * Inbox then proposes again for the items still open. The classifier learns again by itself at the
 * start of a reader's run (`prepare`) when the books or the Inbox's decisions moved on since it last
 * learned, so nobody has to train it for the next suggestions to reflect what was decided or posted.
 *
 * Product state is created on first use, so the first proposing run on a fresh book may be the
 * first thing in this lane to touch it; every entry point opens it through `rulesState`. */

export const rulesRegistration = {
  name: "rules",
  create(service: ApplicationService) {
    rulesState(service);
    return createRulesProposer(readRules(service.store, "active"));
  },
  revision(service: ApplicationService) {
    rulesState(service);
    return `rules:${rulesRevision(service.store)}`;
  },
};

export const classifierRegistration = {
  name: "classifier",
  prepare(service: ApplicationService) {
    return learnIfBehind(service).then(() => undefined);
  },
  create(service: ApplicationService) {
    rulesState(service);
    return createClassifierProposer(loadModel(service), readConfig(service.store));
  },
  revision(service: ApplicationService) {
    rulesState(service);
    const config = readConfig(service.store);
    // What it has learned is not in this: a change to the examples marks the lines it could change for
    // proposing again as it is made (`learning.ts`), and only those.
    return [
      "classifier",
      CLASSIFIER_LOGIC,
      config.enabled ? 1 : 0,
      config.minAgreement,
      config.minMargin,
      config.minExamples,
      config.minKnownWords,
    ].join(":");
  },
};

/** A short, cheap, stable string of a text, for the revision. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** Stripe has told the book about a payout. From then on a deposit is paired with its payout by the
 * Stripe lane, exactly, and the starter list says nothing about Stripe's transfers. */
const payoutsKnown = (service: ApplicationService): boolean =>
  !stripeStore(service).payoutRevision().startsWith("0.");

/** The starter list (rules/starter/proposer.ts): for a line that no rule decides and that the book's
 * own history says nothing about, the category its merchant usually is. Registered as a fallback, so
 * the Inbox asks it only when every other proposer had nothing. What it reads of the book is taken
 * once per run: the rules (a line a rule decides is left alone), how the merchants it knows were
 * booked before, the chart's tags, and which account the Stripe lane books payouts in transit to (the
 * owner's choice in Stripe's settings, else the account that carries the role key). */
export const starterRegistration: ProposerRegistration = {
  name: STARTER_PROPOSER,
  fallback: true,
  create(service: ApplicationService) {
    rulesState(service);
    const store = service.store;
    const rules = readRules(store, "active").map(compileEntry);
    const tags = readAccountTags(store);
    const settings = parseSettings(stripeStore(service).settingsBody());
    const known = payoutsKnown(service);
    const history = loadHistory(service);
    return createStarterProposer({
      decidedByRule: (item) =>
        item.line.kind === "bankLine" &&
        firstMatch(rules, prepareLine(item.line, item.ledgerAccountId)) !== null,
      bookedTo: (merchantId, direction) => history.bookedTo(merchantId, direction),
      tagsOf: (accountId, asOf) => tags.tagsFor(accountId, asOf),
      roleAccount: (roleKey, asOf, accounts) => {
        if (roleKey !== "payouts.in-transit") return undefined;
        if (known) return null;
        return accountOf(
          resolveRoles(
            settings ?? { mapping: [], salesTax: "none" },
            accounts.map((account) => ({
              id: account.id,
              code: account.code,
              role: account.role,
              closedOn: account.closedOn,
            })),
            (accountId, on) => tags.tagsFor(accountId, on).roleKey,
            asOf,
          ),
          "payouts.in-transit",
        );
      },
    });
  },
  revision(service: ApplicationService) {
    rulesState(service);
    const store = service.store;
    const stripe = stripeStore(service);
    return [
      STARTER_PROPOSER,
      STARTER_LOGIC,
      rulesRevision(store),
      readAccountTags(store).revision,
      fingerprint(stripe.settingsBody() ?? ""),
      stripe.payoutRevision(),
    ].join(":");
  },
};

registerProposer(rulesRegistration);
registerProposer(classifierRegistration);
registerProposer(starterRegistration);
