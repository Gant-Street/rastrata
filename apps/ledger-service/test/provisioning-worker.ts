// Local fault campaign only. Never part of a deployed entrypoint.
import { LedgerBook as ProductionBook } from "../src/book.ts";
import { LedgerCatalog as ProductionCatalog, type CatalogOperation } from "../src/catalog.ts";
import type { Environment } from "../src/environment.ts";
import type { CompleteBookScope, NativeCatalogSnapshot } from "@rastrata/ledger";
export { default } from "../src/index.ts";

interface FaultEnvironment extends Environment {
  PROVISION_FAULT: string;
}
function fail(env: Environment, point: string) {
  if ((env as FaultEnvironment).PROVISION_FAULT === point)
    throw new Error("injected lost response; private provider detail");
}

export class LedgerCatalog extends ProductionCatalog {
  override async reserve(token: string, genesis: string, requestId: string) {
    fail(this.env, "reserve-before");
    const result = await super.reserve(token, genesis, requestId);
    fail(this.env, "reserve-after");
    return result;
  }
  override async operate(
    token: string,
    operation: CatalogOperation,
    expected: NativeCatalogSnapshot,
    requestId: string,
  ) {
    if (operation === "activate") fail(this.env, "activate-before");
    const result = await super.operate(token, operation, expected, requestId);
    if (operation === "activate") fail(this.env, "activate-after");
    return result;
  }
}

export class LedgerBook extends ProductionBook {
  constructor(ctx: DurableObjectState, env: FaultEnvironment) {
    let puts = 0;
    const archive = new Proxy(env.ARCHIVE, {
      get(target, property) {
        const member = Reflect.get(target, property, target);
        if (typeof member !== "function") return member;
        if (property !== "put") return member.bind(target);
        return async (...args: unknown[]) => {
          const ordinal = ++puts;
          fail(env, `archive-${ordinal}-before`);
          const result: unknown = await Reflect.apply(member, target, args);
          fail(env, `archive-${ordinal}-after`);
          return result;
        };
      },
    });
    super(ctx, { ...env, ARCHIVE: archive });
  }
  override async provision(token: string, genesis: string, command: string) {
    fail(this.env, "initialize-before");
    const result = await super.provision(token, genesis, command);
    fail(this.env, "initialize-after");
    return result;
  }
  override async refreshAuthority(scope: CompleteBookScope) {
    fail(this.env, "refresh-before");
    const result = await super.refreshAuthority(scope);
    fail(this.env, "refresh-after");
    return result;
  }
}
