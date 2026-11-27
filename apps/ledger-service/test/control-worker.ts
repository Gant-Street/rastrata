// Local test driver for actual private service-binding RPC. Never deployed.
import type LedgerService from "../src/index.ts";
import type { LedgerBook } from "./service-worker.ts";
import { bookObjectName, type CompleteBookScope } from "@rastrata/ledger";

export default {
  async fetch(
    request: Request,
    env: {
      LEDGER: Service<LedgerService>;
      BOOKS: DurableObjectNamespace<LedgerBook>;
    },
  ) {
    const input = (await request.json()) as { method: string; args: unknown[] };
    try {
      let result: unknown;
      switch (input.method) {
        case "checkBookAuthorization": {
          const scope = input.args[0] as CompleteBookScope;
          const book = env.BOOKS.get(
            env.BOOKS.idFromName(bookObjectName(scope.tenantId, scope.bookId)),
          );
          await book.checkAuthorization(input.args[1] as string, "execute");
          result = { authorized: true };
          break;
        }
        case "captureRecoveryEvidence": {
          const scope = input.args[0] as CompleteBookScope;
          const book = env.BOOKS.get(
            env.BOOKS.idFromName(bookObjectName(scope.tenantId, scope.bookId)),
          );
          result = await book.captureRecoveryEvidence(
            scope,
            input.args[1] as string,
            input.args[2] as string,
          );
          break;
        }
        case "recoverUnavailableSource":
          result = await env.LEDGER.recoverUnavailableSource(
            ...(input.args as Parameters<LedgerService["recoverUnavailableSource"]>),
          );
          break;
        case "beginRecovery":
          result = await env.LEDGER.beginRecovery(
            ...(input.args as Parameters<LedgerService["beginRecovery"]>),
          );
          break;
        case "inspectRecoverySource":
          result = await env.LEDGER.inspectRecoverySource(
            ...(input.args as Parameters<LedgerService["inspectRecoverySource"]>),
          );
          break;
        case "archiveStatus":
          result = await env.LEDGER.archiveStatus(input.args[0] as string);
          break;
        case "simulatePrimaryLoss":
        case "deliverArchiveAlarm": {
          const scope = input.args[0] as CompleteBookScope;
          const book = env.BOOKS.get(
            env.BOOKS.idFromName(bookObjectName(scope.tenantId, scope.bookId)),
          );
          if (input.method === "simulatePrimaryLoss") await book.simulatePrimaryLoss();
          else await book.deliverArchiveAlarm();
          result = { completed: true };
          break;
        }
        case "restoreStep":
          result = await env.LEDGER.restoreStep(
            ...(input.args as Parameters<LedgerService["restoreStep"]>),
          );
          break;
        case "verifyRestoredSnapshot":
          result = await env.LEDGER.verifyRestoredSnapshot(input.args[0] as string);
          break;
        case "activateRestoredWriter":
          result = await env.LEDGER.activateRestoredWriter(
            ...(input.args as Parameters<LedgerService["activateRestoredWriter"]>),
          );
          break;
        case "resolveIdentity":
          result = await env.LEDGER.resolveIdentity(
            ...(input.args as Parameters<LedgerService["resolveIdentity"]>),
          );
          break;
        case "provision":
          result = await env.LEDGER.provision(
            ...(input.args as Parameters<LedgerService["provision"]>),
          );
          break;
        case "control":
          result = await env.LEDGER.control(
            ...(input.args as Parameters<LedgerService["control"]>),
          );
          break;
        default:
          throw new Error("Unsupported test operation");
      }
      return new Response(
        JSON.stringify(result, (_, value: unknown) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
        { headers: { "content-type": "application/json" } },
      );
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.stack : String(error) },
        { status: 500 },
      );
    }
  },
};
