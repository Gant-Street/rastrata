import { createSignal, For, Show } from "solid-js";
import { Button } from "../button";
import { TriangleAlert } from "../icons";
import { safeText } from "./format";
import type { Diagnostic } from "./types";
import { words } from "./words";

const COLLAPSED = 6;

/** Everything the reader noticed in the file, errors first, each with the row it is about as a
 * spreadsheet numbers rows. Severity is a word and an icon as well as a place in the list. Messages
 * come from the service already bounded and with any quoted cell made safe; they are shown as
 * plain text. */
export function ImportDiagnostics(props: {
  diagnostics: readonly Diagnostic[];
  errors: number;
  warnings: number;
  infos: number;
}) {
  const [all, setAll] = createSignal(false);
  const shown = () => (all() ? props.diagnostics : props.diagnostics.slice(0, COLLAPSED));
  const label = (severity: Diagnostic["severity"]) =>
    severity === "error"
      ? words.severityError
      : severity === "warning"
        ? words.severityWarning
        : words.severityNote;
  // A note is not a problem: a file that drew only notes is headed "Notes", not "Problems".
  const title = () => (props.errors + props.warnings > 0 ? words.problems : words.notesOnly);
  return (
    <section class="rt-imp-problems" aria-labelledby="rt-imp-problems-title">
      <h3 id="rt-imp-problems-title">{title()}</h3>
      <Show when={props.diagnostics.length > 0}>
        <ul class="rt-imp-problem-list" aria-label={title()} data-facts>
          <For each={shown()}>
            {(item) => (
              <li data-severity={item.severity}>
                <span class="rt-imp-problem-kind">
                  <Show when={item.severity !== "info"}>
                    <TriangleAlert aria-hidden="true" />
                  </Show>
                  {label(item.severity)}
                </span>
                <span class="rt-imp-problem-text">
                  <Show when={item.row !== undefined}>
                    <strong class="rt-imp-problem-row">{words.row(item.row as number)}</strong>{" "}
                  </Show>
                  {safeText(item.message)}
                </span>
              </li>
            )}
          </For>
        </ul>
        <Show when={props.diagnostics.length > COLLAPSED}>
          <Button
            label={all() ? words.showFewer : words.showAll(props.diagnostics.length)}
            variant="quiet"
            size="sm"
            aria-expanded={all()}
            onClick={() => setAll(!all())}
          />
        </Show>
      </Show>
    </section>
  );
}
