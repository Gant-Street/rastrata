/** Isolated acceptance entrypoint. Never use this configuration for real books. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import LedgerService, {
  LedgerBook as ProductionBook,
  LedgerCatalog as ProductionCatalog,
} from "../src/index.ts";
import {
  bookObjectName,
  BOOK_ACCESS_TOKEN_TYPE,
  BOOK_ACCESS_CLOCK_SKEW_SECONDS,
  type CompleteBookScope,
  type NativeCatalogSnapshot,
} from "@rastrata/ledger";
import { catalogStub, type Environment } from "../src/environment.ts";
import { createLocalJWKSet, jwtVerify } from "jose";
import type { CatalogOperation } from "../src/catalog.ts";
import { profileRequest, profileStorage } from "./acceptance-profile.ts";

interface AcceptanceEnvironment extends Environment {
  ACCEPTANCE_KEY?: string;
  ACCEPTANCE_EXPIRES_AT: string;
  ACCEPTANCE_TENANT: string;
  ACCEPTANCE_VARIANT?: string;
  ACCEPTANCE_ALLOW_ACTIVE_LOSS?: string;
  ACCEPTANCE_LOCATION_HINT?: "wnam" | "enam";
  ACCEPTANCE_TRACE_LATENCY?: string;
}
function available(env: AcceptanceEnvironment) {
  const expires = Number(env.ACCEPTANCE_EXPIRES_AT);
  return (
    env.LEDGER_NAMESPACE_ID === "rastrata-ledger-acceptance-v1" &&
    Number.isSafeInteger(expires) &&
    Date.now() < expires &&
    expires - Date.now() <= 3_600_000
  );
}
function authorized(request: Request, env: AcceptanceEnvironment) {
  const expected = env.ACCEPTANCE_KEY;
  const supplied = request.headers.get("x-acceptance-key");
  return (
    expected !== undefined &&
    /^[a-f0-9]{64}$/.test(expected) &&
    supplied !== null &&
    /^[a-f0-9]{64}$/.test(supplied) &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))
  );
}

async function tokenDiagnostic(token: string, env: AcceptanceEnvironment) {
  const now = Date.now(),
    config = env.BOOK_AUTHORIZATION;
  try {
    await jwtVerify(token.slice(7), createLocalJWKSet(config.publicKeys), {
      algorithms: ["ES256"],
      issuer: config.issuer,
      audience: config.audience,
      typ: BOOK_ACCESS_TOKEN_TYPE,
      currentDate: new Date(now),
      clockTolerance: BOOK_ACCESS_CLOCK_SKEW_SECONDS,
    });
    return {
      now,
      result: "verified",
      deploymentTenant: env.ACCEPTANCE_TENANT,
      variant: env.ACCEPTANCE_VARIANT ?? "optimized",
    };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    const claim = error && typeof error === "object" && "claim" in error ? error.claim : null;
    return {
      now,
      deploymentTenant: env.ACCEPTANCE_TENANT,
      result: typeof code === "string" && /^[A-Z_]+$/.test(code) ? code : "other",
      claim:
        typeof claim === "string" && ["iat", "nbf", "exp", "iss", "aud"].includes(claim)
          ? claim
          : null,
    };
  }
}

export class LedgerCatalog extends ProductionCatalog {
  async acceptanceTokenDiagnostic(token: string) {
    const env = this.env as AcceptanceEnvironment;
    if (!available(env)) throw new Error("Acceptance expired");
    return tokenDiagnostic(token, env);
  }
}

export class LedgerBook extends ProductionBook {
  private latencyProbeInitialized = false;
  protected override ledgerStorage() {
    return profileStorage(this.ctx.storage);
  }
  async acceptanceLatencyProbe(mode: string, round: number) {
    if (!available(this.env as AcceptanceEnvironment)) throw new Error("Acceptance expired");
    if (
      !["noop", "read", "write-1k", "write-1k-gated", "write-16k", "write-64k"].includes(mode) ||
      !Number.isSafeInteger(round) ||
      round < 0 ||
      round >= 256
    )
      throw new Error("Acceptance probe refused");
    const started = performance.now();
    if (mode === "read") {
      this.ctx.storage.sql.exec("SELECT head FROM ledger_native_book WHERE singleton=1").one();
    } else if (mode.startsWith("write-")) {
      const size = mode.startsWith("write-1k") ? 1024 : mode === "write-16k" ? 16384 : 65536;
      // A separate diagnostic table: never alters ledger facts/outcomes. Random
      // bytes avoid conflating compressible padding with replicated payload size.
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS acceptance_latency_blob (id INTEGER PRIMARY KEY, value BLOB NOT NULL)",
      );
      const value = randomBytes(size);
      this.ctx.storage.transactionSync(() =>
        this.ctx.storage.sql.exec(
          "INSERT INTO acceptance_latency_blob VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
          value,
        ),
      );
      // The gated control relies on the platform's default output gate. It does
      // NOT use allowUnconfirmed. Compare client/tail wall time, not bookMs=0.
      if (mode !== "write-1k-gated") await this.ctx.storage.sync();
    }
    const bookMs = performance.now() - started;
    if ((this.env as AcceptanceEnvironment).ACCEPTANCE_TRACE_LATENCY === "true")
      console.log(JSON.stringify({ latencyProbe: mode, component: "book", round }));
    return { mode, round, bookMs };
  }
  async acceptanceDurabilityProbe(iterations: 1 | 32 = 32) {
    if (!available(this.env as AcceptanceEnvironment)) throw new Error("Acceptance expired");
    if (iterations !== 1 && iterations !== 32) throw new Error("Acceptance probe count refused");
    if (!this.latencyProbeInitialized) {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS acceptance_latency_probe (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)",
      );
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO acceptance_latency_probe VALUES (1,0)");
      await this.ctx.storage.sync();
      this.latencyProbeInitialized = true;
    }
    const milliseconds: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      this.ctx.storage.transactionSync(() =>
        this.ctx.storage.sql.exec("UPDATE acceptance_latency_probe SET value=value+1 WHERE id=1"),
      );
      await this.ctx.storage.sync();
      milliseconds.push(performance.now() - start);
    }
    return {
      scope: `${iterations} single-row SQLite durable commits; no accounting or signature work`,
      milliseconds,
    };
  }
  async acceptancePitr(scope: CompleteBookScope, action: string, bookmark?: string) {
    const env = this.env as AcceptanceEnvironment;
    if (
      !available(env) ||
      scope.tenantId !== env.ACCEPTANCE_TENANT ||
      scope.namespaceId !== env.LEDGER_NAMESPACE_ID ||
      scope.objectId !== this.ctx.id.toString()
    )
      throw new Error("Acceptance scope refused");
    const catalog = await catalogStub(env, scope).read(scope);
    // Test-only damage and rollback must never run against a serving book.
    const activeBookmark =
      action === "activeBookmark" &&
      env.ACCEPTANCE_ALLOW_ACTIVE_LOSS === "true" &&
      catalog.status === "active";
    if (!activeBookmark && (catalog.status !== "maintenance" || catalog.retirement !== null))
      throw new Error("Acceptance PITR requires maintenance before retirement");
    if (action === "restore") {
      if (typeof bookmark !== "string" || !/^[a-zA-Z0-9-]{1,256}$/.test(bookmark))
        throw new Error("Invalid acceptance bookmark");
      const undoBookmark = await this.ctx.storage.onNextSessionRestoreBookmark(bookmark);
      // Return the undo bookmark before the harness explicitly restarts this object.
      return { undoBookmark };
    }
    if (action === "damage") {
      this.ctx.storage.sql.exec(
        "UPDATE ledger_native_outcomes SET body='acceptance-corruption' WHERE sequence=(SELECT MAX(sequence) FROM ledger_native_outcomes)",
      );
      await this.ctx.storage.sync();
    } else if (action !== "bookmark" && action !== "inspect" && !activeBookmark) {
      throw new Error("Unknown acceptance PITR action");
    }
    await this.ctx.storage.sync();
    const hash = createHash("sha256");
    // Canonical data AND access/revocation records; exclude derived archive/alarm progress.
    const queries = [
      "SELECT * FROM ledger_native_book ORDER BY singleton",
      "SELECT * FROM ledger_native_outcomes ORDER BY sequence",
      "SELECT * FROM ledger_native_facts ORDER BY identity",
      "SELECT * FROM ledger_native_access ORDER BY singleton",
      "SELECT * FROM ledger_native_access_events ORDER BY request_id",
    ];
    for (const query of queries) {
      hash.update(JSON.stringify(query));
      for (const row of this.ctx.storage.sql.exec(query)) hash.update(JSON.stringify(row));
    }
    const digest = hash.digest("hex");
    return {
      digest,
      ...(action === "bookmark" || activeBookmark
        ? { bookmark: await this.ctx.storage.getCurrentBookmark() }
        : {}),
    };
  }
  async acceptanceTokenDiagnostic(token: string) {
    const env = this.env as AcceptanceEnvironment;
    if (!available(env)) throw new Error("Acceptance expired");
    return tokenDiagnostic(token, env);
  }
  override async fetch(request: Request) {
    if (!available(this.env as AcceptanceEnvironment)) return new Response(null, { status: 410 });
    const started = performance.now();
    const received = await profileRequest(() => super.fetch(request), "x-acceptance-book-profile");
    const response = new Response(received.body, received);
    response.headers.set("x-acceptance-book-wall-ms", String(performance.now() - started));
    response.headers.set("x-acceptance-book-now-ms", String(Date.now()));
    if ((this.env as AcceptanceEnvironment).ACCEPTANCE_TRACE_LATENCY === "true")
      console.log(JSON.stringify({ latencyProbe: "save", component: "book" }));
    response.headers.set(
      "x-acceptance-variant",
      (this.env as AcceptanceEnvironment).ACCEPTANCE_VARIANT ?? "optimized",
    );
    return response;
  }
  async acceptanceAlarm() {
    if (!available(this.env as AcceptanceEnvironment)) throw new Error("Acceptance expired");
    await super.alarm();
  }
  async acceptanceScheduleAlarm() {
    if (!available(this.env as AcceptanceEnvironment)) throw new Error("Acceptance expired");
    await this.ctx.storage.setAlarm(Date.now() + 1);
  }
  acceptanceStorageStatus() {
    if (!available(this.env as AcceptanceEnvironment)) throw new Error("Acceptance expired");
    return {
      ledgerTables: this.ctx.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name GLOB 'ledger_*'",
        )
        .one().count,
    };
  }
  async acceptanceLoss(token: string, scope: CompleteBookScope) {
    const env = this.env as AcceptanceEnvironment;
    if (!available(env) || scope.tenantId !== env.ACCEPTANCE_TENANT)
      throw new Error("Acceptance scope refused");
    // Loss injection is restricted to an independently approved, retired test
    // source. It cannot delete an active book or fabricate recovery approval.
    const catalog = await catalogStub(env, scope).read(scope);
    if (catalog.status !== "maintenance" || catalog.restore === null)
      throw new Error("Acceptance source is not approved for restore");
    await this.checkRecoveryAuthorization(token);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    // Deletion is the injected loss, not a pending write to roll back on abort.
    // Local workerd alone did not expose that distinction.
    await this.ctx.storage.sync();
    this.ctx.abort("Isolated acceptance primary-loss injection");
  }
  async acceptanceUnexpectedLoss(scope: CompleteBookScope) {
    const env = this.env as AcceptanceEnvironment;
    if (
      !available(env) ||
      env.ACCEPTANCE_ALLOW_ACTIVE_LOSS !== "true" ||
      scope.tenantId !== env.ACCEPTANCE_TENANT ||
      scope.namespaceId !== env.LEDGER_NAMESPACE_ID ||
      scope.objectId !== this.ctx.id.toString()
    )
      throw new Error("Acceptance scope refused");
    const catalog = await catalogStub(env, scope).read(scope);
    if (catalog.status !== "active" || catalog.restore !== null || catalog.retirement !== null)
      throw new Error("Unexpected-loss fixture must be active without restore preparation");
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.sync();
    this.ctx.abort("Isolated acceptance unexpected primary loss");
  }
  async acceptanceRestart() {
    if (!available(this.env as AcceptanceEnvironment)) throw new Error("Acceptance expired");
    this.ctx.abort("Isolated acceptance cold-owner injection");
  }
  acceptanceInspect() {
    if (!available(this.env as AcceptanceEnvironment)) throw new Error("Acceptance expired");
    return {
      databaseBytes: this.ctx.storage.sql.databaseSize,
      outcomes: this.ctx.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM ledger_native_outcomes")
        .one().count,
    };
  }
}

export default class AcceptanceService extends LedgerService {
  override async fetch(request: Request): Promise<Response> {
    const env = this.env as AcceptanceEnvironment;
    if (!available(env)) return new Response(null, { status: 410 });
    const url = new URL(request.url);
    if (url.pathname !== "/acceptance") {
      const started = performance.now();
      const received = await profileRequest(
        () => super.fetch(request),
        "x-acceptance-worker-profile",
      );
      const response = new Response(received.body, received);
      response.headers.set("x-acceptance-worker-wall-ms", String(performance.now() - started));
      response.headers.set("x-acceptance-worker-now-ms", String(Date.now()));
      response.headers.set("x-acceptance-colo", String(request.cf?.colo ?? "unknown"));
      if (env.ACCEPTANCE_TRACE_LATENCY === "true")
        console.log(JSON.stringify({ latencyProbe: "save", component: "gateway" }));
      return response;
    }
    if (request.method !== "POST" || url.search || !authorized(request, env))
      return new Response(null, { status: 403 });
    const declared = Number(request.headers.get("content-length"));
    if (!Number.isSafeInteger(declared) || declared <= 0 || declared > 2_200_000)
      return new Response(null, { status: 413 });
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength !== declared)
      return new Response(null, { status: 400 });
    try {
      const input = JSON.parse(body) as { method: string; args: unknown[] };
      if (!Array.isArray(input.args)) throw new Error("Malformed acceptance arguments");
      let result: unknown;
      switch (input.method) {
        case "resolveIdentity": {
          const [tenant, book] = input.args as [string, string];
          if (tenant !== env.ACCEPTANCE_TENANT) throw new Error("Acceptance tenant refused");
          result = this.resolveIdentity(tenant, book);
          const hint = env.ACCEPTANCE_LOCATION_HINT;
          if (hint !== undefined) {
            if (hint !== "wnam" && hint !== "enam") throw new Error("Acceptance placement refused");
            // Hints apply only to the first get. Instantiate this new isolated
            // test object with a read-only diagnostic before normal routing.
            const namespace = env.BOOKS as DurableObjectNamespace<LedgerBook>;
            await namespace
              .get(namespace.idFromName(bookObjectName(tenant, book)), { locationHint: hint })
              .acceptanceTokenDiagnostic("");
          }
          break;
        }
        case "provision":
          result = await this.provision(...(input.args as [string, string, string, string]));
          break;
        case "control":
          result = await this.control(
            ...(input.args as [string, CatalogOperation, NativeCatalogSnapshot, string]),
          );
          break;
        case "beginRecovery":
          result = await this.beginRecovery(
            ...(input.args as [string, NativeCatalogSnapshot, string]),
          );
          break;
        case "inspectRecoverySource":
          result = await this.inspectRecoverySource(
            ...(input.args as [string, NativeCatalogSnapshot, string]),
          );
          break;
        case "recoverUnavailableSource":
          result = await this.recoverUnavailableSource(
            ...(input.args as [string, NativeCatalogSnapshot, string]),
          );
          break;
        case "archiveStatus":
          result = await this.archiveStatus(input.args[0] as string);
          break;
        case "restoreStep":
          result = await this.restoreStep(input.args[0] as string);
          break;
        case "verifyRestoredSnapshot":
          result = await this.verifyRestoredSnapshot(input.args[0] as string);
          break;
        case "activateRestoredWriter":
          result = await this.activateRestoredWriter(input.args[0] as string);
          break;
        case "alarm":
        case "scheduleAlarm":
        case "storageStatus":
        case "tokenDiagnostic":
        case "restart":
        case "latencyProbe":
        case "durabilityProbe":
        case "inspect":
        case "pitr":
        case "unexpectedLoss":
        case "loss": {
          const scope = input.args[0] as CompleteBookScope;
          if (
            scope.tenantId !== env.ACCEPTANCE_TENANT ||
            scope.namespaceId !== env.LEDGER_NAMESPACE_ID
          )
            throw new Error("Acceptance scope refused");
          const namespace = env.BOOKS as DurableObjectNamespace<LedgerBook>;
          const id = namespace.idFromName(bookObjectName(scope.tenantId, scope.bookId));
          if (id.toString() !== scope.objectId) throw new Error("Acceptance object refused");
          const book = namespace.get(id);
          if (input.method === "latencyProbe") {
            const mode = input.args[1] as string,
              round = input.args[2] as number;
            if (!Number.isSafeInteger(round) || round < 0 || round >= 256)
              throw new Error("Acceptance probe refused");
            const start = performance.now();
            const probe =
              mode === "edge"
                ? { mode, round, bookMs: 0 }
                : await book.acceptanceLatencyProbe(mode, round);
            result = {
              ...probe,
              workerMs: performance.now() - start,
              colo: String(request.cf?.colo ?? "unknown"),
            };
            if (env.ACCEPTANCE_TRACE_LATENCY === "true")
              console.log(JSON.stringify({ latencyProbe: mode, component: "gateway", round }));
            break;
          }
          if (input.method === "unexpectedLoss") {
            await book.acceptanceUnexpectedLoss(scope);
            result = { completed: true };
            break;
          }
          if (input.method === "pitr") {
            result = await book.acceptancePitr(
              scope,
              input.args[1] as string,
              input.args[2] as string | undefined,
            );
            break;
          }
          if (input.method === "storageStatus") {
            result = await book.acceptanceStorageStatus();
            break;
          }
          if (input.method === "scheduleAlarm") {
            await book.acceptanceScheduleAlarm();
            result = { scheduled: true };
            break;
          }
          if (input.method === "tokenDiagnostic") {
            const token = input.args[1] as string;
            result = {
              gateway: await tokenDiagnostic(token, env),
              book: await book.acceptanceTokenDiagnostic(token),
              catalog: await (env.CATALOGS as DurableObjectNamespace<LedgerCatalog>)
                .get(env.CATALOGS.idFromName(bookObjectName(scope.tenantId, scope.bookId)))
                .acceptanceTokenDiagnostic(token),
            };
            break;
          }
          if (input.method === "inspect") {
            result = await book.acceptanceInspect();
            break;
          }
          if (input.method === "durabilityProbe") {
            result = await book.acceptanceDurabilityProbe(input.args[1] as 1 | 32 | undefined);
            break;
          }
          if (input.method === "alarm") await book.acceptanceAlarm();
          else if (input.method === "loss")
            await book.acceptanceLoss(input.args[1] as string, scope);
          else await book.acceptanceRestart();
          result = { completed: true };
          break;
        }
        default:
          throw new Error("Unknown acceptance operation");
      }
      return new Response(
        JSON.stringify(result, (_, value: unknown) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
        { headers: { "content-type": "application/json", "cache-control": "no-store" } },
      );
    } catch (error) {
      // Test errors identify the failed invariant, never reflect input/token data.
      const code =
        error instanceof Error && /^[a-z_]+$/.test(error.message)
          ? error.message
          : "acceptance_operation_failed";
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      const categories = [
        "different request",
        "exceeded",
        "timeout",
        "network",
        "internal error",
        "reset",
        "not a function",
        "immutable",
        "sql",
        "ledger_unauthorized",
        "jwk",
        "crypto",
        "i/o",
        "output gate",
        "input gate",
      ].filter((value) => message.includes(value));
      const deploymentRestarted =
        message === "durable object reset because its code was updated." ||
        /^ledger_provisioning_(?:reserve|initialize|activate|refresh|book_catalog|book_open|book_binding|book_activation|book_archive)_deployment_reset$/.test(
          message,
        );
      return Response.json({ error: code, categories, deploymentRestarted }, { status: 500 });
    }
  }
}
