import { createUniqueId, For, Show, type JSX } from "solid-js";
import { FileField } from "../file-field";
import { CheckField } from "../accounting-controls";
import { FieldError } from "../field";
import type { ColumnView, FileStepView, KeepView } from "./xero-types";
import { columnLabel, xeroWords as words } from "./xero-words";
import { Details } from "../kit/details";

/** Choose one export from Xero. The file is read in the browser and shown before anything is kept. It is the
 * browser's own file input, so it opens from the keyboard and works with a screen reader; what is seen is the
 * product's button, which is the input's label, and the input itself is kept out of sight (it draws its own
 * button and "No file chosen" in the browser's words). Only the file's name is in the view: its name is data
 * and is shown as text. */
export function FileChoice(props: {
  step: FileStepView;
  /** What the file is, and where Xero has it: "Xero's chart of accounts (Accounting, Chart of accounts, Export)". */
  label: string;
}): JSX.Element {
  const id = createUniqueId();
  return (
    <FileField
      class="rt-xero-file"
      label={props.label}
      labelClass="rt-xero-file-what"
      button={props.step.fileName ? words.chooseAnother : words.chooseFile}
      variant={props.step.fileName ? "secondary" : "primary"}
      accept=".csv,text/csv,text/plain"
      invalid={Boolean(props.step.fileError)}
      describedBy={props.step.fileError ? `${id}-error` : undefined}
      onFile={(file) => props.step.onFile(file)}
    >
      <Show when={props.step.fileError}>
        <FieldError id={`${id}-error`}>{props.step.fileError}</FieldError>
      </Show>
      <p role="status" class="rt-hint" data-facts>
        <Show when={props.step.busy}>{words.reading}</Show>
        <Show when={!props.step.busy && props.step.fileName}>
          {(name) => <bdi>{words.readFile(name())}</bdi>}
        </Show>
      </p>
    </FileField>
  );
}

/** The rows of a file that could not be read are listed above it; the file is kept only if the
 * person agrees to leave them out. Nothing is shown when every row was read. */
export function SkipUnreadable(props: { keep: KeepView }): JSX.Element {
  return (
    <Show when={props.keep.unreadable > 0}>
      <CheckField
        label={words.skipUnreadable(props.keep.unreadable)}
        hint={words.skipUnreadableHint}
        checked={props.keep.skipUnreadable}
        onChange={(checked) => props.keep.onSkipUnreadable(checked)}
      />
    </Show>
  );
}

/** How the columns of a file were read: the header the file used and what it was taken to be. A
 * column that was expected and is not here is the usual difference between Xero's documentation and a
 * real export, so it is one disclosure away before anything is kept. The headers are the file's own
 * text, shown as text. */
export function ColumnsRead(props: { columns: readonly ColumnView[] }): JSX.Element {
  return (
    <Show when={props.columns.length > 0}>
      <Details flush summary={words.columnsRead(props.columns.length)}>
        <p class="rt-hint">{words.columnsHint}</p>
        <section class="rt-table-scroll" tabindex="0" aria-label={words.columnsCaption}>
          <table class="rt-table rt-xero-table">
            <caption class="rt-sr-only">{words.columnsCaption}</caption>
            <thead>
              <tr>
                <th scope="col">{words.colYourColumn}</th>
                <th scope="col">{words.colReadAs}</th>
              </tr>
            </thead>
            <tbody>
              <For each={props.columns}>
                {(column) => (
                  <tr>
                    <th scope="row">
                      <bdi>{column.header}</bdi>
                    </th>
                    <td>{columnLabel(column.field)}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </section>
      </Details>
    </Show>
  );
}
