import { createSignal, createUniqueId, Show } from "solid-js";
import { FileField } from "../file-field";
import { FieldError } from "../field";
import { Progress } from "../progress";
import { formatBytes } from "../format";
import { shownName } from "./format";
import type { UploadState } from "./types";
import { words } from "./words";

/** Drop a statement file here, or choose one. Dragging is a convenience: every action it offers is
 * also a button, so a keyboard, a screen reader and a phone work the same way. The component only
 * reports the file; the page decides whether it is acceptable and uploads it. */
export function ImportFileDrop(props: {
  state: UploadState;
  /** The file already chosen, when there is one. */
  fileName?: string | undefined;
  fileSize?: number | undefined;
  /** What is wrong with the file or the upload, in words a person can act on. */
  error?: string | undefined;
  disabled?: boolean | undefined;
  /** Shows the dragging look without a drag, for stories and tests. */
  dragging?: boolean | undefined;
  /** The words and the kinds of file when the drop is for something other than a statement. */
  copy?: { title: string; hint: string; accept: string } | undefined;
  /** Accept multiple files dropped or chosen at once. */
  multiple?: boolean | undefined;
  onFile: (file: File) => void;
  onFiles?: ((files: File[]) => void) | undefined;
}) {
  const uid = createUniqueId();
  const hintId = `${uid}-hint`;
  const errorId = `${uid}-error`;
  const [dropProblem, setDropProblem] = createSignal("");
  const busy = () => props.state === "reading" || props.state === "uploading";
  const inactive = () => props.disabled === true || busy();
  const problem = () => props.error ?? dropProblem();
  return (
    <FileField
      class="rt-imp-drop"
      label={props.copy?.title ?? words.dropTitle}
      hideLabel
      drop
      multiple={props.multiple}
      dragging={props.dragging}
      button={props.fileName ? words.chooseAnother : words.choose}
      variant={props.fileName ? "secondary" : "primary"}
      accept={
        props.copy?.accept ??
        ".csv,.xlsx,.ofx,.qfx,.qbo,.txt,.tsv,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/x-ofx,application/vnd.intu.qfx,application/vnd.intu.qbo"
      }
      disabled={inactive()}
      invalid={Boolean(problem())}
      describedBy={
        [props.copy?.hint ? hintId : "", problem() ? errorId : ""].filter(Boolean).join(" ") ||
        undefined
      }
      onFile={(file) => {
        setDropProblem("");
        props.onFile(file);
      }}
      onFiles={(files) => {
        setDropProblem("");
        if (props.onFiles) props.onFiles(files);
        else if (files[0]) props.onFile(files[0]);
      }}
      onTooMany={() => setDropProblem(words.dropOne)}
      actionsClass="rt-imp-drop-actions"
      lead={(dragging) => (
        <>
          <p class="rt-imp-drop-title">
            {dragging() ? words.dropActive : (props.copy?.title ?? words.dropTitle)}
          </p>
          <Show when={props.copy?.hint}>
            <p id={hintId} class="rt-hint">
              {props.copy?.hint}
            </p>
          </Show>
        </>
      )}
      beside={
        <Show when={props.fileName && !busy()}>
          <p class="rt-imp-drop-file">
            {words.uploaded(shownName(props.fileName as string), formatBytes(props.fileSize ?? 0))}
          </p>
        </Show>
      }
    >
      <Show when={busy()}>
        <div class="rt-imp-drop-progress" role="status">
          <Progress
            label={
              props.state === "uploading"
                ? words.uploading(shownName(props.fileName ?? ""))
                : words.reading(shownName(props.fileName ?? ""))
            }
            value={null}
          />
        </div>
      </Show>
      <Show when={problem()}>
        <FieldError id={errorId}>{problem()}</FieldError>
      </Show>
    </FileField>
  );
}
