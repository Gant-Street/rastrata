import { MAX_LINES } from "../../reconcile/engine.ts";
import type { ApplicationService } from "../../service.ts";
import type { ApplicationStore } from "../../storage.ts";
import { sliceState } from "../state.ts";
import { loadBookView, type BookView } from "./book.ts";
import { ReconcileStore } from "./store.ts";

/** Everything the reconcile slice keeps for one service: its product-state tables, the clock and
 * the size limit. The book itself is read through `readAggregate`, never cached here. */
export class ReconcileState {
  readonly store: ReconcileStore;
  /** An ISO instant: the service's own clock unless a test replaces it, so every date and timestamp
   * in a test that injects a clock is deterministic. */
  now: () => string = () => this.service.now();
  /** The most lines one reconciliation holds. A host or a test may lower it. */
  maxLines: number = MAX_LINES;
  /** How the book is read. Tests replace it to run the operations over a synthetic book. */
  readBook: () => Promise<BookView> = () => loadBookView(this.service);

  constructor(
    db: ApplicationStore,
    private readonly service: ApplicationService,
  ) {
    this.store = new ReconcileStore(db);
  }

  /** The book's today, YYYY-MM-DD: the service's one clock, so a test that sets it moves every
   * date the product reads. */
  today(): string {
    return this.service.today();
  }
}

export function reconcileState(service: ApplicationService): ReconcileState {
  return sliceState(service, "reconcile", (db) => new ReconcileState(db, service));
}

/** For tests and hosts: replace the clock the reconcile slice reads. */
export function setReconcileClock(service: ApplicationService, now: () => string): void {
  reconcileState(service).now = now;
}

/** For tests and hosts: lower the number of lines one reconciliation may hold. */
export function setReconcileMaxLines(service: ApplicationService, maxLines: number): void {
  reconcileState(service).maxLines = maxLines;
}

/** For tests: read the book from somewhere else, for example a synthetic account with thousands of
 * lines that would take minutes to post through the kernel. */
export function setReconcileBookReader(
  service: ApplicationService,
  reader: () => Promise<BookView>,
): void {
  reconcileState(service).readBook = reader;
}
