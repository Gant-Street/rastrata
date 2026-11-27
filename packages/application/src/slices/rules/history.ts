import type { PostedLine } from "../../rules/history.ts";
import type { ChartAccount } from "../../rules/types.ts";
import type { ApplicationService } from "../../service.ts";
import { sliceState } from "../state.ts";
import { type SourceDescriptions, postedLinesFor } from "./lines.ts";

/** The book as the rules lane reads it: the chart, and the ordinary journals recovered as past
 * bank lines (see rules/history.ts) with the original text of the source event each was posted
 * from. Reversed and superseded journals are not decisions anyone stands behind, so they are left
 * out together with their corrections.
 *
 * The lines are kept current from the ledger's own new revisions (`lines.ts`), so a view after a
 * posting costs the posting; the view itself is cached per ledger head, so repeated calls while
 * nothing is posted cost one head check. */

export interface LedgerView {
  /** The book revision the view was read at. */
  readonly bookRevision: string;
  readonly currency: string;
  readonly chart: ReadonlyMap<string, ChartAccount>;
  readonly lines: readonly PostedLine[];
}

interface Cache {
  key: string;
  view: LedgerView;
}

const chartOf = (
  accounts: readonly {
    id: string;
    code: string;
    name: string;
    role: string;
    closedOn?: string | undefined;
  }[],
): Map<string, ChartAccount> =>
  new Map<string, ChartAccount>(
    accounts.map((account) => [
      account.id,
      {
        id: account.id,
        code: account.code,
        name: account.name,
        role: account.role as ChartAccount["role"],
        closedOn: account.closedOn ?? null,
      },
    ]),
  );

/** The chart alone, for the operations that only need to know which accounts there are (creating,
 * editing and listing rules): it does not build the history of posted lines. */
export async function readChart(
  service: ApplicationService,
): Promise<ReadonlyMap<string, ChartAccount>> {
  const { aggregate } = await service.readAggregate();
  return chartOf(aggregate.state.admissionSnapshot.accounts);
}

/** The descriptions of the source events entries were posted from, read from the book's own store. */
export function sourceDescriptions(service: ApplicationService): SourceDescriptions {
  const describe = (body: string): string | undefined => {
    try {
      const source = JSON.parse(body) as { description?: unknown };
      return typeof source.description === "string" ? source.description : undefined;
    } catch {
      // A source whose facts cannot be read contributes no description; the narration is used.
      return undefined;
    }
  };
  return {
    one(id) {
      const row = service.store.query("SELECT body FROM app_sources WHERE id = ?").get(id) as {
        body: string;
      } | null;
      return row ? describe(row.body) : undefined;
    },
    all() {
      const descriptions = new Map<string, string>();
      const rows = service.store.query("SELECT id, body FROM app_sources").all() as {
        id: string;
        body: string;
      }[];
      for (const row of rows) {
        const text = describe(row.body);
        if (text !== undefined) descriptions.set(row.id, text);
      }
      return descriptions;
    },
  };
}

export async function readLedgerView(service: ApplicationService): Promise<LedgerView> {
  const cache = sliceState(service, "rules.ledger", () => ({ current: null as Cache | null }));
  const tip = await service.ledgerHead();
  if (cache.current?.key === `${tip.sequence}:${tip.chainHash}`) return cache.current.view;
  const { aggregate, head } = await service.readAggregate();
  const state = aggregate.state;
  const lines = postedLinesFor(state, sourceDescriptions(service));
  const view: LedgerView = {
    bookRevision: head.bookRevision,
    currency: service.setupState()?.currency ?? "USD",
    chart: chartOf(state.admissionSnapshot.accounts),
    lines: lines.sorted(),
  };
  cache.current = { key: `${head.sequence}:${head.chainHash}`, view };
  return view;
}
