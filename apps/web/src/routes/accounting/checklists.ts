import type { ChecklistView } from "@rastrata/ui";
import { createSignal } from "solid-js";
import type { BrowserApplicationClient } from "../../application-client";
import { checklistView } from "../shadow/logic";

/** What is known of one month's checklist: not asked for yet, being read, could not be read, or read (and
 * when). A read that failed is never shown as a pass: the page says it could not check. */
export type ChecklistRead =
  | { readonly state: "idle" }
  | { readonly state: "checking" }
  | { readonly state: "failed" }
  | { readonly state: "ready"; readonly view: ChecklistView; readonly at: Date };

/** The checklists of the months Close the books asks about, read when the card needs one and read again when
 * asked. Held in plain signals, so reading one never suspends the page or takes focus from what is in use; an
 * answer that arrives after a newer question for the same month was asked is ignored. */
export function createChecklists(client: BrowserApplicationClient) {
  const [reads, setReads] = createSignal<ReadonlyMap<string, ChecklistRead>>(new Map());
  const asked = new Map<string, number>();
  const set = (id: string, read: ChecklistRead) =>
    setReads((previous) => new Map(previous).set(id, read));

  async function run(id: string): Promise<void> {
    const mine = (asked.get(id) ?? 0) + 1;
    asked.set(id, mine);
    set(id, { state: "checking" });
    try {
      const result = await client.read("cutover.checklist", { periodId: id }, { fresh: true });
      if (asked.get(id) === mine)
        set(id, { state: "ready", view: checklistView(result), at: new Date() });
    } catch {
      if (asked.get(id) === mine) set(id, { state: "failed" });
    }
  }

  return {
    read: (id: string): ChecklistRead => reads().get(id) ?? { state: "idle" },
    /** Read it once, the first time the month is on show. */
    ensure(id: string): void {
      if (!reads().has(id)) void run(id);
    },
    /** Read it now and wait for the answer: what a run of closes asks before each month. */
    async load(id: string): Promise<ChecklistRead> {
      await run(id);
      return reads().get(id) ?? { state: "idle" };
    },
    /** Read it again: the figures that were on show are replaced when the new ones arrive. */
    refresh(id: string): void {
      void run(id);
    },
    /** Drop what was read of one month, so that it is read again the next time it is wanted. */
    forget(id: string): void {
      asked.delete(id);
      setReads((previous) => {
        const next = new Map(previous);
        next.delete(id);
        return next;
      });
    },
    /** The book changed: nothing read before is current. */
    forgetAll(): void {
      asked.clear();
      setReads(new Map());
    },
  };
}
