// Local-only workerd harness. Fixed authority, no public authorization surface.
import {
  canonicalAccountingValue,
  canonicalEncode,
  decodeBookRow,
  type BookCommand,
} from "@rastrata/kernel";
import { NativeLedger } from "../src/native-ledger.ts";
import { nativeInventoryWorkflow } from "./native-inventory-workflow.ts";
import { consolidationWorkflow } from "./commercial-workflow.ts";
import { ExactRational } from "@rastrata/kernel";
import { SqliteLedgerRepository } from "../src/sqlite-ledger-repository.ts";
import type { SqliteStorage } from "../src/sqlite.ts";
import {
  BOOK,
  genesis,
  activation,
  posting,
  configuration,
  correction,
  closing,
  reopening,
  openItemRecognition,
  settlementPayment,
  unallocatedPayment,
  applyExistingPayment,
} from "./fixtures.ts";
import {
  taxWorkflow,
  allocationAndTaxWorkflow,
  workflowTerminationCommand,
  currencyRecoveryWorkflow,
} from "./accounting-workflows.ts";

interface Environment {
  BOOKS: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
}
export class NativeLedgerObject {
  private readonly ledger: NativeLedger;
  private readonly repository: SqliteLedgerRepository;
  private statements = 0;
  private rollback = false;
  private lostReply = false;
  private failSync = false;
  constructor(private readonly ctx: { id: { toString(): string }; storage: SqliteStorage }) {
    const storage: SqliteStorage = {
      sql: {
        exec: (sql, ...bindings) => {
          this.statements++;
          const rows = ctx.storage.sql.exec(sql, ...bindings);
          if (sql.startsWith("UPDATE ledger_native_book")) {
            if (this.rollback) {
              this.rollback = false;
              throw new Error("injected native rollback");
            }
            if (this.lostReply) {
              this.lostReply = false;
              this.failSync = true;
            }
          }
          return rows;
        },
      },
      transactionSync: (operation) => ctx.storage.transactionSync(operation),
      sync: async () => {
        await ctx.storage.sync();
        if (this.failSync) {
          this.failSync = false;
          throw new Error("injected native lost acknowledgement");
        }
      },
    };
    const scope = {
      tenantId: "native-runtime",
      bookId: BOOK,
      objectId: ctx.id.toString(),
      namespaceId: "native-runtime",
      generation: "0",
    };
    this.repository = new SqliteLedgerRepository(storage, scope, scope.objectId, () => ({
      fence: "0",
      pending: false,
    }));
    this.ledger = new NativeLedger(this.repository);
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/provision" || url.pathname === "/open-item/provision") {
        await this.ledger.provision(genesis(), activation());
        return Response.json({ provisioned: true });
      }
      if (url.pathname === "/tax/provision") {
        await this.ledger.provision(taxWorkflow().initial, activation());
        return Response.json({ provisioned: true });
      }
      if (url.pathname === "/inventory/provision") {
        const workflow = await nativeInventoryWorkflow(await request.text());
        const command = workflow.commands[0];
        if (!command) throw new Error("Missing inventory activation");
        await this.ledger.provision(workflow.initial, command);
        return Response.json({ provisioned: true });
      }
      if (url.pathname === "/fx/provision") {
        await this.ledger.provision(currencyRecoveryWorkflow().initial, activation());
        return Response.json({ provisioned: true });
      }
      if (url.pathname === "/consolidation/provision") {
        await this.ledger.provision(
          consolidationWorkflow(ExactRational.of(4n, 5n)).initial,
          activation(),
        );
        return Response.json({ provisioned: true });
      }
      if (url.pathname === "/deferred/provision") {
        await this.ledger.provision(genesis(), activation());
        await this.ledger.execute(unallocatedPayment("prepayment", 1n));
        await this.ledger.execute(openItemRecognition("invoice-a", 2n));
        await this.ledger.execute(openItemRecognition("invoice-b", 3n));
        return Response.json({ provisioned: true });
      }
      if (url.pathname === "/settlement/provision") {
        await this.ledger.provision(genesis(), activation());
        await this.ledger.execute(openItemRecognition("invoice", 1n));
        return Response.json({ provisioned: true });
      }
      if (url.pathname === "/allocation/provision") {
        await this.ledger.provision(allocationAndTaxWorkflow("1.1.0").initial, activation());
        return Response.json({ provisioned: true });
      }
      if (
        url.pathname === "/count" ||
        url.pathname === "/open-item/count" ||
        url.pathname === "/settlement/count" ||
        url.pathname === "/deferred/count" ||
        url.pathname === "/tax/count" ||
        url.pathname === "/fx/count" ||
        url.pathname === "/inventory/count" ||
        url.pathname === "/consolidation/count" ||
        url.pathname === "/allocation/count"
      )
        return Response.json(
          Array.from(
            this.ctx.storage.sql.exec("SELECT count(*) AS count FROM ledger_native_outcomes"),
          )[0],
        );
      if (
        ![
          "/post",
          "/rollback",
          "/lost",
          "/configure",
          "/reverse",
          "/close",
          "/reopen",
          "/tax",
          "/fx",
          "/inventory",
          "/consolidation",
          "/open-item",
          "/settlement",
          "/deferred",
          "/allocation",
        ].includes(url.pathname)
      )
        return new Response("Unknown test operation", { status: 404 });
      const revision = BigInt(url.searchParams.get("revision") ?? "1");
      const id = url.searchParams.get("id") ?? "sale";
      let command: BookCommand;
      if (url.pathname === "/inventory") {
        const workflow = await nativeInventoryWorkflow(await request.text());
        const selected = workflow.commands[Number(url.searchParams.get("step"))];
        if (selected?.type !== "postOwnedInventoryTransaction")
          throw new Error("Invalid inventory step");
        command = selected;
      } else if (url.pathname === "/consolidation") {
        command = consolidationWorkflow(ExactRational.of(4n, 5n)).command;
      } else if (url.pathname === "/fx") {
        const selected = currencyRecoveryWorkflow().commands[Number(url.searchParams.get("step"))];
        if (selected === undefined || selected.type === "activateBook")
          throw new Error("Invalid FX step");
        command = selected;
      } else if (url.pathname === "/deferred") {
        const step = url.searchParams.get("step") ?? "1";
        if (step !== "1" && step !== "2") throw new Error("Invalid deferred step");
        command = applyExistingPayment(
          unallocatedPayment("prepayment", 1n),
          `application-${step}`,
          step === "1" ? 4n : 5n,
          [
            {
              openItemId: openItemRecognition(step === "1" ? "invoice-a" : "invoice-b", 2n).request
                .value.id,
              amount: step === "1" ? 40n : 60n,
            },
          ],
        );
      } else if (url.pathname === "/settlement") {
        const step = url.searchParams.get("step") ?? "1";
        if (step !== "1" && step !== "2") throw new Error("Invalid settlement step");
        command = settlementPayment(`payment-${step}`, step === "1" ? 2n : 3n, [
          {
            openItemId: openItemRecognition("invoice", 1n).request.value.id,
            amount: step === "1" ? 40n : 60n,
          },
        ]);
      } else if (url.pathname === "/open-item")
        command = openItemRecognition(
          url.searchParams.get("id") ?? "invoice",
          BigInt(url.searchParams.get("revision") ?? "1"),
        );
      else if (url.pathname === "/tax") command = taxWorkflow().command;
      else if (url.pathname === "/allocation") {
        const scenario = allocationAndTaxWorkflow("1.1.0");
        const selected = [...scenario.commands, workflowTerminationCommand(scenario)][
          Number(url.searchParams.get("step"))
        ];
        if (selected === undefined || selected.type === "activateBook")
          throw new Error("Invalid allocation step");
        command = selected;
      } else if (url.pathname === "/configure")
        command = configuration(
          {
            ...genesis().state,
            bookRevision: revision,
            configurationRevision: BigInt(url.searchParams.get("configurationRevision") ?? "0"),
          },
          id,
        );
      else if (url.pathname === "/close")
        command = closing(id, revision, url.searchParams.get("withJournal") === "1");
      else if (url.pathname === "/reopen" && !url.searchParams.has("original"))
        command = reopening(id, revision);
      else if (url.pathname === "/reverse" || url.pathname === "/reopen") {
        const original = url.searchParams.get("original") ?? "sale";
        const row = await this.repository.transact((view) => ({
          write: false,
          value: view.facts([{ collection: "journals", key: original }])[0],
        }));
        if (!row.value) throw new Error("Missing source journal");
        const decoded = decodeBookRow("state.journals", row.value.encoded);
        if (decoded.disposition !== "decoded") throw new Error("Invalid source journal");
        command =
          url.pathname === "/reopen"
            ? reopening(id, revision, decoded.row)
            : correction(decoded.row, id, revision);
      } else command = posting(id, revision);
      this.rollback = url.pathname === "/rollback" || url.searchParams.get("fault") === "rollback";
      this.lostReply = url.pathname === "/lost" || url.searchParams.get("fault") === "lost";
      this.statements = 0;
      const result = await this.ledger.execute(command);
      const original = result.value.originalResult;
      return Response.json({
        disposition: result.value.result.disposition,
        head: result.head,
        outcomeSequence: result.value.outcomeSequence,
        original:
          original === null
            ? null
            : new TextDecoder().decode(canonicalEncode(canonicalAccountingValue(original))),
        sql: this.statements,
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  }
}
export default {
  fetch(request: Request, env: Environment) {
    const path = new URL(request.url).pathname;
    const name = path.startsWith("/inventory")
      ? "inventory-book"
      : path.startsWith("/consolidation")
        ? "consolidation-book"
        : path.startsWith("/fx")
          ? "fx-book"
          : path.startsWith("/tax")
            ? "tax-book"
            : path.startsWith("/allocation")
              ? "allocation-book"
              : path.startsWith("/open-item")
                ? "open-item-book"
                : path.startsWith("/settlement")
                  ? "settlement-book"
                  : path.startsWith("/deferred")
                    ? "deferred-book"
                    : "native-book";
    return env.BOOKS.get(env.BOOKS.idFromName(name)).fetch(request);
  },
};
