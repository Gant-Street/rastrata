import { readAccountTags } from "../../account-tags.ts";
import { type ApplicationAccess, describePrincipal } from "../../agent/principal.ts";
import { expiryFrom, issuePluginToken, normalizeLabel } from "../../agent/token.ts";
import { ApplicationError } from "../../errors.ts";
import { isCalendarDate, sanitizeText } from "../../ingest/text.ts";
import type {
  BalanceCheck,
  BankLine,
  IngestBatch,
  IngestLine,
  LedgerEvent,
} from "../../ingest-types.ts";
import { formatMoney, isMoney, parseMoney } from "../../money.ts";
import type { ApplicationService } from "../../service.ts";
import { blobInfo } from "../ingest/blobs.ts";
import { ingestPort } from "../ingest/port.ts";
import type { SliceHandlers } from "../types.ts";
import { resolvePluginRoles } from "./proposer.ts";
import {
  type PluginAccountBinding,
  type PluginConfigEntry,
  type PluginInstallRecord,
  type PluginRoleBinding,
  type PluginTokenRecord,
  type StoredPluginManifest,
  pluginState,
  pluginTokenStatus,
} from "./store.ts";

/** Side-effect import ensures the generic plugin proposer registers when handlers load. */
import "./proposer.ts";

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function assertPluginScope(access: ApplicationAccess, pluginId: string): void {
  if (access.principal?.kind === "plugin" && access.principal.pluginId !== pluginId) {
    throw new ApplicationError(
      "plugin_scope_denied",
      `This plugin token is bound to "${access.principal.pluginId}" and cannot access "${pluginId}".`,
      403,
    );
  }
}

function validateAndNormalizeManifest(raw: Record<string, unknown>): StoredPluginManifest {
  const id = String(raw.id);
  const version = String(raw.version);
  const name = sanitizeText(String(raw.name), 60);
  const description = sanitizeText(String(raw.description), 160);
  if (!name) throw new ApplicationError("invalid_input", "Plugin manifest requires a name.");
  if (!description)
    throw new ApplicationError("invalid_input", "Plugin manifest requires a description.");

  const authKind = raw.authKind as StoredPluginManifest["authKind"];
  const rawDomains = (raw.domains as string[]) ?? [];
  const domains: string[] = [];
  const seenDomains = new Set<string>();
  for (const domain of rawDomains) {
    const clean = domain.trim().toLowerCase();
    if (
      clean !== domain ||
      clean.includes("*") ||
      IPV4.test(clean) ||
      clean === "localhost" ||
      !HOSTNAME.test(clean)
    ) {
      throw new ApplicationError(
        "invalid_manifest",
        `Invalid outbound domain "${domain}". Use exact lowercase HTTPS hostnames only (no wildcards, ports, or IP addresses).`,
      );
    }
    if (!seenDomains.has(clean)) {
      seenDomains.add(clean);
      domains.push(clean);
    }
  }
  if ((authKind === "api_key" || authKind === "oauth2") && domains.length === 0) {
    throw new ApplicationError(
      "invalid_manifest",
      `Plugin "${id}" uses ${authKind} auth and must declare at least one outbound HTTPS domain in manifest.domains.`,
    );
  }

  const rawRoles = (raw.roles as StoredPluginManifest["roles"] | undefined) ?? [];
  const seenRoles = new Set<string>();
  const roles = rawRoles.map((role) => {
    if (seenRoles.has(role.key)) {
      throw new ApplicationError(
        "invalid_manifest",
        `Duplicate role key "${role.key}" in manifest.roles.`,
      );
    }
    seenRoles.add(role.key);
    return {
      key: role.key,
      label: sanitizeText(role.label, 80) || role.key,
      kind: role.kind,
      required: role.required,
      ...(role.defaultRoleKey ? { defaultRoleKey: role.defaultRoleKey } : {}),
    };
  });

  const rawClearing = raw.clearing as { role: string; windowDays?: number } | undefined;
  let clearing: StoredPluginManifest["clearing"];
  if (rawClearing) {
    if (!seenRoles.has(rawClearing.role)) {
      throw new ApplicationError(
        "invalid_manifest",
        `Clearing role "${rawClearing.role}" must be declared in manifest.roles.`,
      );
    }
    clearing = {
      role: rawClearing.role,
      windowDays: rawClearing.windowDays ?? 7,
    };
  }

  return {
    id,
    version,
    name,
    description,
    domains,
    authKind,
    ...(typeof raw.authLabel === "string" ? { authLabel: sanitizeText(raw.authLabel, 80) } : {}),
    ...(typeof raw.authEnvVar === "string" ? { authEnvVar: raw.authEnvVar } : {}),
    roles,
    ...(clearing ? { clearing } : {}),
  };
}

async function validateBindings(
  manifest: StoredPluginManifest,
  roleMap: readonly PluginRoleBinding[],
  accountMap: readonly PluginAccountBinding[],
  service: ApplicationService,
): Promise<void> {
  const accounts = new Set<string>((await service.accounts()).accounts.map((a) => a.id));
  const declaredRoles = new Set(manifest.roles.map((r) => r.key));
  const seenRoleBindings = new Set<string>();
  for (const entry of roleMap) {
    if (!declaredRoles.has(entry.role)) {
      throw new ApplicationError(
        "invalid_input",
        `Role "${entry.role}" is not declared by plugin "${manifest.id}".`,
      );
    }
    if (seenRoleBindings.has(entry.role)) {
      throw new ApplicationError("invalid_input", `Duplicate roleMap binding for "${entry.role}".`);
    }
    seenRoleBindings.add(entry.role);
    if (!accounts.has(entry.accountId)) {
      throw new ApplicationError(
        "account_not_found",
        `Chart account "${entry.accountId}" mapped to role "${entry.role}" does not exist.`,
        404,
      );
    }
  }
  const seenAccounts = new Set<string>();
  for (const entry of accountMap) {
    if (seenAccounts.has(entry.accountKey)) {
      throw new ApplicationError(
        "invalid_input",
        `Duplicate accountMap binding for "${entry.accountKey}".`,
      );
    }
    seenAccounts.add(entry.accountKey);
    if (!accounts.has(entry.ledgerAccountId)) {
      throw new ApplicationError(
        "account_not_found",
        `Chart account "${entry.ledgerAccountId}" mapped to "${entry.accountKey}" does not exist.`,
        404,
      );
    }
    if (entry.startOn && !isCalendarDate(entry.startOn)) {
      throw new ApplicationError(
        "invalid_input",
        `Invalid startOn date "${entry.startOn}" for account "${entry.accountKey}".`,
      );
    }
  }
}

async function detailView(service: ApplicationService, install: PluginInstallRecord) {
  const state = pluginState(service);
  const accounts = (await service.accounts()).accounts.map((a) => ({
    id: a.id,
    code: a.code,
    name: a.name,
    role: a.role,
    closedOn: a.closedOn,
  }));
  const tags = readAccountTags(service.store);
  const asOf = service.now().slice(0, 10);
  const resolvedRoles = resolvePluginRoles(
    install,
    accounts,
    (id, date) => tags.tagsFor(id, date),
    asOf,
  );
  const missingRequired = resolvedRoles.filter((r) => r.spec.required && r.accountId === null);
  const cursors = state.listCursors(install.pluginId);
  return {
    pluginId: install.pluginId,
    version: install.version,
    name: install.manifest.name,
    description: install.manifest.description,
    enabled: install.enabled,
    ready: install.enabled && missingRequired.length === 0,
    domains: [...install.manifest.domains],
    authKind: install.manifest.authKind,
    authLabel: install.manifest.authLabel ?? null,
    authEnvVar: install.manifest.authEnvVar ?? null,
    config: [...install.config],
    roles: resolvedRoles.map((r) => ({
      role: r.spec.key,
      label: r.spec.label,
      kind: r.spec.kind,
      required: r.spec.required,
      accountId: r.accountId,
      source: r.source,
      problem: r.problem,
    })),
    accountMap: [...install.accountMap],
    clearing: install.manifest.clearing ?? null,
    cursors: cursors.map((c) => ({
      sourceKey: c.sourceKey,
      cursor: c.cursor,
      lastSyncAt: c.lastSyncAt,
      lastError: c.lastError,
    })),
    installedAt: install.installedAt,
    updatedAt: install.updatedAt,
  };
}

async function summaryView(service: ApplicationService, install: PluginInstallRecord) {
  const detail = await detailView(service, install);
  const lastSyncAt =
    detail.cursors.length > 0
      ? (detail.cursors
          .map((c) => c.lastSyncAt)
          .sort()
          .at(-1) ?? null)
      : null;
  return {
    pluginId: detail.pluginId,
    version: detail.version,
    name: detail.name,
    description: detail.description,
    enabled: detail.enabled,
    ready: detail.ready,
    domains: detail.domains,
    authKind: detail.authKind,
    missingRoles: detail.roles.filter((r) => r.required && r.accountId === null).map((r) => r.role),
    lastSyncAt,
    installedAt: detail.installedAt,
    updatedAt: detail.updatedAt,
  };
}

function tokenSummary(record: PluginTokenRecord, now: Date) {
  return {
    id: record.id,
    pluginId: record.pluginId,
    label: record.label,
    status: pluginTokenStatus(record, now),
    createdAt: record.createdAt,
    createdBy: record.createdBy,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
    revokedReason: record.revokedReason,
    lastUsedAt: record.lastUsedAt,
  };
}

function buildIngestLines(
  install: PluginInstallRecord,
  rawBankLines: readonly Record<string, unknown>[],
  rawEvents: readonly Record<string, unknown>[],
): {
  readonly lines: IngestLine[];
  readonly clearingPayouts: {
    readonly providerId: string;
    readonly accountKey: string;
    readonly eventOn: string;
    readonly amountCents: bigint;
    readonly currency: string;
    readonly clearingRole: string;
  }[];
} {
  const lines: IngestLine[] = [];
  const clearingPayouts: {
    readonly providerId: string;
    readonly accountKey: string;
    readonly eventOn: string;
    readonly amountCents: bigint;
    readonly currency: string;
    readonly clearingRole: string;
  }[] = [];

  const declaredRoles = new Set(install.manifest.roles.map((r) => r.key));
  const clearingRole = install.manifest.clearing?.role;

  for (const item of rawBankLines) {
    const postedOn = String(item.postedOn);
    const amount = String(item.amount);
    if (!isCalendarDate(postedOn)) {
      throw new ApplicationError(
        "invalid_input",
        `Invalid postedOn date "${postedOn}" on bankLine (rawIndex ${String(item.rawIndex)}).`,
      );
    }
    if (!isMoney(amount) || amount === "-0.00") {
      throw new ApplicationError(
        "invalid_input",
        `Invalid amount "${amount}" on bankLine (rawIndex ${String(item.rawIndex)}).`,
      );
    }
    const line: BankLine = {
      kind: "bankLine",
      provider: install.pluginId,
      accountKey: String(item.accountKey),
      rawIndex: Number(item.rawIndex),
      postedOn,
      amount,
      currency: String(item.currency),
      description: sanitizeText(String(item.description), 1000),
      ...(typeof item.providerId === "string" ? { providerId: item.providerId } : {}),
      ...(typeof item.counterparty === "string"
        ? { counterparty: sanitizeText(item.counterparty, 200) }
        : {}),
      ...(typeof item.reference === "string"
        ? { reference: sanitizeText(item.reference, 200) }
        : {}),
      ...(typeof item.runningBalance === "string" ? { runningBalance: item.runningBalance } : {}),
      ...(typeof item.excerpt === "string" ? { excerpt: item.excerpt } : {}),
    };
    lines.push(line);
  }

  for (const item of rawEvents) {
    const providerId = String(item.providerId);
    const eventOn = String(item.eventOn);
    if (!isCalendarDate(eventOn)) {
      throw new ApplicationError(
        "invalid_input",
        `Invalid eventOn date "${eventOn}" on event "${providerId}".`,
      );
    }
    const rawLegs = item.legs as { role: string; amount: string; memo?: string }[];
    let debits = 0n;
    let credits = 0n;
    let clearingCents = 0n;

    for (const leg of rawLegs) {
      if (!declaredRoles.has(leg.role)) {
        const allowed = [...declaredRoles].join(", ") || "(none)";
        throw new ApplicationError(
          "undeclared_role",
          `Event "${providerId}" uses role "${leg.role}", which is not declared by plugin "${install.pluginId}" (allowed: ${allowed}).`,
        );
      }
      if (!isMoney(leg.amount) || leg.amount === "-0.00") {
        throw new ApplicationError(
          "invalid_input",
          `Invalid amount "${leg.amount}" on event "${providerId}" role "${leg.role}".`,
        );
      }
      const cents = parseMoney(leg.amount);
      if (cents > 0n) debits += cents;
      else credits += -cents;
      if (clearingRole && leg.role === clearingRole) {
        clearingCents += cents;
      }
    }
    if (debits !== credits) {
      const diff = debits - credits;
      const sign = diff > 0n ? "+" : "";
      throw new ApplicationError(
        "unbalanced_event",
        `Event "${providerId}" (${eventOn}) does not balance by ${sign}${formatMoney(diff)} (debits ${formatMoney(debits)}, credits ${formatMoney(credits)}).`,
      );
    }

    const rawLinks = item.links as { key: string; value: string }[] | undefined;
    const links =
      rawLinks && rawLinks.length > 0
        ? Object.fromEntries(rawLinks.map((entry) => [entry.key, entry.value]))
        : undefined;

    const event: LedgerEvent = {
      kind: "event",
      provider: install.pluginId,
      accountKey: String(item.accountKey),
      providerId,
      rawIndex: Number(item.rawIndex),
      eventOn,
      summary: sanitizeText(String(item.summary), 500),
      currency: String(item.currency),
      legs: rawLegs.map((leg) => ({
        role: leg.role,
        amount: leg.amount,
        ...(leg.memo ? { memo: sanitizeText(leg.memo, 300) } : {}),
      })),
      ...(typeof item.amount === "string" ? { amount: item.amount } : {}),
      ...(links ? { links } : {}),
      ...(typeof item.coveredBy === "string" ? { coveredBy: item.coveredBy } : {}),
      ...(typeof item.evidence === "string" ? { evidence: sanitizeText(item.evidence, 300) } : {}),
      ...(typeof item.sourceId === "string" ? { sourceId: item.sourceId } : {}),
      ...(typeof item.excerpt === "string" ? { excerpt: item.excerpt } : {}),
    };
    lines.push(event);

    if (clearingRole && !event.coveredBy && clearingCents > 0n) {
      clearingPayouts.push({
        providerId,
        accountKey: event.accountKey,
        eventOn,
        amountCents: clearingCents,
        currency: event.currency,
        clearingRole,
      });
    }
  }

  return { lines, clearingPayouts };
}

export const pluginsHandlers: SliceHandlers = {
  "plugins.list": async (_input, { service }) => {
    const installs = pluginState(service).listInstalls();
    const plugins = [];
    for (const install of installs) {
      plugins.push(await summaryView(service, install));
    }
    return { plugins };
  },

  "plugins.install": (input, { service, access, operationId }) =>
    service.retainAsyncRequest(operationId, "plugins.install", input, async () => {
      const state = pluginState(service);
      const manifest = validateAndNormalizeManifest(input.manifest as Record<string, unknown>);
      const existing = state.getInstall(manifest.id);
      const config = (input.config as PluginConfigEntry[] | undefined) ?? existing?.config ?? [];
      const roleMap = (input.roleMap as PluginRoleBinding[] | undefined) ?? existing?.roleMap ?? [];
      const accountMap =
        (input.accountMap as PluginAccountBinding[] | undefined) ?? existing?.accountMap ?? [];
      const enabled =
        typeof input.enabled === "boolean" ? input.enabled : (existing?.enabled ?? true);

      await validateBindings(manifest, roleMap, accountMap, service);

      const saved = state.upsertInstall({
        pluginId: manifest.id,
        manifest,
        config,
        roleMap,
        accountMap,
        enabled,
        at: service.now(),
        by: describePrincipal(access.principal),
      });
      return detailView(service, saved);
    }),

  "plugins.configure": (input, { service, access, operationId }) =>
    service.retainAsyncRequest(operationId, "plugins.configure", input, async () => {
      const state = pluginState(service);
      const pluginId = String(input.pluginId);
      const existing = state.requireInstall(pluginId);
      const config = (input.config as PluginConfigEntry[] | undefined) ?? existing.config;
      const roleMap = (input.roleMap as PluginRoleBinding[] | undefined) ?? existing.roleMap;
      const accountMap =
        (input.accountMap as PluginAccountBinding[] | undefined) ?? existing.accountMap;
      const enabled = typeof input.enabled === "boolean" ? input.enabled : existing.enabled;

      await validateBindings(existing.manifest, roleMap, accountMap, service);

      const saved = state.upsertInstall({
        pluginId,
        manifest: existing.manifest,
        config,
        roleMap,
        accountMap,
        enabled,
        at: service.now(),
        by: describePrincipal(access.principal),
      });
      return detailView(service, saved);
    }),

  "plugins.status": async (input, { service, access }) => {
    const pluginId = String(input.pluginId);
    assertPluginScope(access, pluginId);
    const install = pluginState(service).requireInstall(pluginId);
    return detailView(service, install);
  },

  "plugins.push": async (input, { service, access, operationId }) => {
    const pluginId = String(input.pluginId);
    assertPluginScope(access, pluginId);
    return service.retainAsyncRequest(operationId, "plugins.push", input, async () => {
      const state = pluginState(service);
      const install = state.requireInstall(pluginId);
      if (!install.enabled) {
        throw new ApplicationError(
          "plugin_disabled",
          `Plugin "${pluginId}" is disabled. Enable it with plugins.configure before syncing.`,
          409,
        );
      }

      const rawSha256 = String(input.rawSha256);
      const raw = blobInfo(service.store, rawSha256);
      if (!raw) {
        throw new ApplicationError(
          "upload_not_found",
          `Raw payload ${rawSha256.slice(0, 12)} is not archived in this book. Upload it first via POST /v1/uploads with X-Upload-For: plugin.`,
          404,
        );
      }

      const rawBankLines = (input.bankLines as Record<string, unknown>[] | undefined) ?? [];
      const rawEvents = (input.events as Record<string, unknown>[] | undefined) ?? [];
      if (rawBankLines.length + rawEvents.length > 500) {
        throw new ApplicationError(
          "invalid_input",
          "A single plugins.push call accepts at most 500 lines total (bankLines + events). Split into smaller batches.",
        );
      }

      const { lines, clearingPayouts } = buildIngestLines(install, rawBankLines, rawEvents);
      const balances = ((input.balances as BalanceCheck[] | undefined) ?? []).map((b) => {
        if (!isCalendarDate(b.asOf)) {
          throw new ApplicationError("invalid_input", `Invalid balance check date "${b.asOf}".`);
        }
        if (!isMoney(b.balance) || b.balance === "-0.00") {
          throw new ApplicationError(
            "invalid_input",
            `Invalid balance check amount "${b.balance}".`,
          );
        }
        return b;
      });

      const sourceKey = String(input.sourceKey);
      const accountKeys = new Set(lines.map((l) => l.accountKey));
      const singleAccountKey = accountKeys.size === 1 ? [...accountKeys][0] : undefined;
      const configuredAccount = singleAccountKey
        ? install.accountMap.find((a) => a.accountKey === singleAccountKey)
        : undefined;

      const ledgerAccountId =
        typeof input.ledgerAccountId === "string"
          ? input.ledgerAccountId
          : configuredAccount?.ledgerAccountId;
      const startOn =
        typeof input.startOn === "string" ? input.startOn : configuredAccount?.startOn;
      const cursor = typeof input.cursor === "string" ? input.cursor : undefined;
      const fetchedAt = typeof input.fetchedAt === "string" ? input.fetchedAt : service.now();

      const batch: IngestBatch = {
        provider: install.pluginId,
        sourceKey,
        raw,
        lines,
        balances,
        fetchedAt,
        ...(cursor !== undefined ? { cursor } : {}),
        ...(ledgerAccountId !== undefined ? { ledgerAccountId } : {}),
        ...(startOn !== undefined ? { startOn } : {}),
        ...(input.catchUp === true ? { catchUp: true } : {}),
      };

      const port = ingestPort(service);
      let submitted: ReturnType<typeof port.submit> | undefined;
      service.store.transaction(() => {
        submitted = port.submit(batch);
        state.saveCursor({
          pluginId,
          sourceKey,
          cursor: cursor ?? null,
          syncedAt: fetchedAt,
          error: null,
        });
        for (const payout of clearingPayouts) {
          state.recordPayout({
            pluginId,
            providerId: payout.providerId,
            accountKey: payout.accountKey,
            eventOn: payout.eventOn,
            amountCents: payout.amountCents,
            currency: payout.currency,
            clearingRole: payout.clearingRole,
          });
        }
      });
      if (!submitted) {
        throw new Error("Plugin ingest transaction did not yield a batch report");
      }

      const balanceChecks = balances.length > 0 ? await port.checkBalances(batch) : [];
      const savedCursor =
        state.listCursors(pluginId).find((c) => c.sourceKey === sourceKey)?.cursor ?? null;

      return {
        pluginId,
        sourceKey,
        batchId: submitted.batchId,
        newCount: submitted.newCount,
        duplicateCount: submitted.duplicateCount,
        overlapCount: submitted.overlapCount,
        excludedCount: submitted.excludedCount ?? 0,
        cursor: savedCursor,
        balances: balanceChecks.map((check) => ({
          accountKey: check.accountKey,
          asOf: check.asOf,
          reported: check.reported,
          ledger: check.ledger,
          waiting: check.waiting,
          excluded: check.excluded,
          difference: check.difference,
        })),
      };
    });
  },

  "plugins.remove": (input, { service, operationId }) =>
    service.retainRequest(operationId, "plugins.remove", input, () => {
      const state = pluginState(service);
      const pluginId = String(input.pluginId);
      state.requireInstall(pluginId);
      state.removeInstall(pluginId, service.now());
      return { pluginId, removed: true };
    }),

  "plugins.createToken": async (input, { service, access, operationId }) => {
    const state = pluginState(service);
    const pluginId = String(input.pluginId);
    state.requireInstall(pluginId);
    const label = normalizeLabel(String(input.label));
    const now = state.now();
    const expiresAt = expiryFrom(now, input.expiresInDays as number | undefined);
    const issued = await issuePluginToken();
    let token: string | null = null;
    // The retained response holds the token's id only. The secret is returned once by the call
    // that created it and is never written to SQLite, so replaying operationId returns token: null.
    const created = service.retainRequest(operationId, "plugins.createToken", input, () => {
      token = issued.token;
      return {
        id: state.insertToken({
          id: issued.id,
          pluginId,
          label,
          secretHash: issued.secretHash,
          createdAt: now.toISOString(),
          createdBy: describePrincipal(access.principal),
          expiresAt,
          operationId,
        }).id,
      };
    });
    return {
      token,
      record: tokenSummary(state.requireToken(created.id), state.now()),
    };
  },

  "plugins.listTokens": (input, { service }) => {
    const state = pluginState(service);
    const pluginId = typeof input.pluginId === "string" ? input.pluginId : undefined;
    const now = state.now();
    return {
      tokens: state.listTokens(pluginId).map((record) => tokenSummary(record, now)),
    };
  },

  "plugins.revokeToken": (input, { service, operationId }) =>
    service.retainRequest(operationId, "plugins.revokeToken", input, () => {
      const state = pluginState(service);
      const id = String(input.tokenId);
      const reason =
        typeof input.reason === "string" && input.reason.trim()
          ? sanitizeText(input.reason, 200)
          : null;
      const updated = state.revokeToken(id, reason);
      return { record: tokenSummary(updated, state.now()) };
    }),
};
