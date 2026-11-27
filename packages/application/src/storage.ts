/** Synchronous application persistence port. The adapter owns runtime/database
 * setup; the application owns its draft and retained-operation tables. */
export type ApplicationBinding = string | number | bigint | null | Uint8Array;
export interface ApplicationStore {
  exec(sql: string): void;
  query(sql: string): {
    get(...bindings: ApplicationBinding[]): unknown;
    all(...bindings: ApplicationBinding[]): unknown[];
    run(...bindings: ApplicationBinding[]): { changes: number };
  };
  transaction<T>(work: () => T): T;
  close(): void;
}
