import { sanitizeText } from "./redact.ts";
import type {
  BalanceCheck,
  BankLine,
  BankLineInput,
  EmitHelpers,
  InferRoleKeys,
  IngestPlugin,
  LedgerEvent,
  LedgerEventInput,
  PluginManifest,
} from "./types.ts";
import {
  assertValidIssues,
  validateBalanceCheck,
  validateLine,
  validateManifest,
} from "./validate.ts";

/** Create typed `emit` builders scoped to a plugin's manifest.
 *
 * Automatically fills `provider`, auto-increments `rawIndex` when omitted, sanitizes text, and
 * fails fast with Stripe-style hints if a date, money string, role key, or event balance is wrong. */
export function createEmit<const M extends PluginManifest>(
  manifest: M,
): EmitHelpers<InferRoleKeys<M>> {
  let nextIndex = 0;

  return {
    bankLine(input: BankLineInput): BankLine {
      const rawIndex = input.rawIndex ?? nextIndex++;
      const line: BankLine = {
        kind: "bankLine",
        provider: manifest.id,
        accountKey: input.accountKey,
        rawIndex,
        postedOn: input.postedOn,
        amount: input.amount,
        currency: input.currency.toUpperCase(),
        description: sanitizeText(input.description, 1000),
        ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
        ...(input.counterparty !== undefined
          ? { counterparty: sanitizeText(input.counterparty, 200) }
          : {}),
        ...(input.reference !== undefined ? { reference: sanitizeText(input.reference, 200) } : {}),
        ...(input.runningBalance !== undefined ? { runningBalance: input.runningBalance } : {}),
        ...(input.excerpt !== undefined ? { excerpt: input.excerpt } : {}),
      };
      assertValidIssues(validateLine(line, manifest, `bankLine[${rawIndex}]`));
      return line;
    },

    event(input: LedgerEventInput<InferRoleKeys<M>>): LedgerEvent<InferRoleKeys<M>> {
      const rawIndex = input.rawIndex ?? nextIndex++;
      const event: LedgerEvent<InferRoleKeys<M>> = {
        kind: "event",
        provider: manifest.id,
        accountKey: input.accountKey,
        providerId: input.providerId,
        rawIndex,
        eventOn: input.eventOn,
        summary: sanitizeText(input.summary, 500),
        currency: input.currency.toUpperCase(),
        legs: input.legs.map((leg) => ({
          role: leg.role,
          amount: leg.amount,
          ...(leg.memo !== undefined ? { memo: sanitizeText(leg.memo, 300) } : {}),
        })),
        ...(input.amount !== undefined ? { amount: input.amount } : {}),
        ...(input.links !== undefined ? { links: input.links } : {}),
        ...(input.coveredBy !== undefined ? { coveredBy: input.coveredBy } : {}),
        ...(input.evidence !== undefined ? { evidence: sanitizeText(input.evidence, 300) } : {}),
        ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
        ...(input.excerpt !== undefined ? { excerpt: input.excerpt } : {}),
      };
      assertValidIssues(validateLine(event, manifest, `event[${input.providerId}]`));
      return event;
    },

    balance(input: BalanceCheck): BalanceCheck {
      assertValidIssues(validateBalanceCheck(input));
      return input;
    },
  };
}

/** Define a Rastrata ingestion plugin with full compile-time inference for `config`, `auth`, and
 * `LedgerEvent` role keys straight from `manifest` — no `as const` needed.
 *
 * Validates `manifest` immediately at load time so misconfigurations fail fast with exact hints. */
export function definePlugin<const M extends PluginManifest>(
  plugin: IngestPlugin<M>,
): IngestPlugin<M> {
  assertValidIssues(validateManifest(plugin.manifest));
  return plugin;
}
