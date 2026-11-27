import { createUniqueId, For, Show } from "solid-js";
import { ChangeRow } from "./change-row";
import type { DayGroup } from "./logic";
import type { MakerView, SubjectView } from "./types";

/** The changes of a page, newest first, a day at a time. Each day is a section with its own heading, so a
 * screen reader can move from one day to the next, and each change is an item of a list. */
export function ChangeList(props: {
  groups: readonly DayGroup[];
  caller?: MakerView | undefined;
  timeZone?: string | undefined;
  hrefFor: (subject: SubjectView) => string | undefined;
}) {
  const id = createUniqueId();
  return (
    <div class="rt-changes-days" data-facts>
      <For each={props.groups}>
        {(group, index) => (
          <section class="rt-changes-day" aria-labelledby={`${id}-${index()}`}>
            <h3 class="rt-changes-day-head" id={`${id}-${index()}`}>
              <span>{group.heading}</span>
              <Show when={group.when !== ""}>
                <span class="rt-changes-day-date">{group.when}</span>
              </Show>
            </h3>
            <ol class="rt-changes-rows">
              <For each={group.changes}>
                {(change) => (
                  <ChangeRow
                    change={change}
                    caller={props.caller}
                    timeZone={props.timeZone}
                    hrefFor={props.hrefFor}
                  />
                )}
              </For>
            </ol>
          </section>
        )}
      </For>
    </div>
  );
}
