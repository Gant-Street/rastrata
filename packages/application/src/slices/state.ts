import type { ApplicationService } from "../service.ts";
import type { ApplicationStore } from "../storage.ts";

const memo = new WeakMap<ApplicationService, Map<string, unknown>>();

/** Runtime state a slice keeps for one service instance (prepared tables, caches). `create` runs
 * once per service and slice; call it from every handler instead of holding module globals, so
 * two books in one process never share state. */
export function sliceState<T>(
  service: ApplicationService,
  name: string,
  create: (store: ApplicationStore, service: ApplicationService) => T,
): T {
  let states = memo.get(service);
  if (!states) {
    states = new Map();
    memo.set(service, states);
  }
  if (!states.has(name)) states.set(name, create(service.store, service));
  return states.get(name) as T;
}

/** Ordered, append-only product-state migrations for one slice. A released step is never edited:
 * add a new one. Each step may hold several statements and runs in its own transaction with the
 * version bump, so a crash leaves the previous version intact. */
export function migrate(store: ApplicationStore, slice: string, steps: readonly string[]): void {
  store.exec(
    "CREATE TABLE IF NOT EXISTS app_slice_migrations (slice TEXT PRIMARY KEY, version INTEGER NOT NULL)",
  );
  const row = store.query("SELECT version FROM app_slice_migrations WHERE slice=?").get(slice) as {
    version: number;
  } | null;
  let version = row?.version ?? 0;
  if (version > steps.length)
    throw new Error(`The ${slice} product state was written by a newer release`);
  for (; version < steps.length; version++) {
    const step = steps[version] as string;
    store.transaction(() => {
      store.exec(step);
      store
        .query(
          "INSERT INTO app_slice_migrations (slice, version) VALUES (?, ?) ON CONFLICT(slice) DO UPDATE SET version=excluded.version",
        )
        .run(slice, version + 1);
    });
  }
}
