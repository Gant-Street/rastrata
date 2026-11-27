import type { ApplicationService } from "../../service.ts";
import { sliceState } from "../state.ts";

/** Run `work` after every earlier piece of work for this service has finished. Recording a cutover
 * and planning an opening entry are several steps each (read, change other lanes' sources, record);
 * two requests that interleave could leave the Inbox's start dates and the recorded date disagreeing,
 * so they run one at a time. A failure does not stop the ones behind it. */
export function serialized<T>(service: ApplicationService, work: () => Promise<T>): Promise<T> {
  const state = sliceState(service, "shadow.queue", () => ({
    tail: Promise.resolve() as Promise<unknown>,
  }));
  const run = state.tail.then(work, work);
  state.tail = run.catch(() => undefined);
  return run;
}
