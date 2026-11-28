import { FileUpload, useFileUpload } from "@ark-ui/solid/file-upload";
import { type JSX, Show } from "solid-js";
import { buttonAttrs } from "./button";

/** Choose one file, with a button; where `drop` is set, the field is also a place to drop it. Ark owns the
 * choosing and the dropping. The field keeps no file of its own: it reports the file and the screen says
 * what became of it, so the same file can be chosen twice. A file of a kind the field does not ask for is
 * reported too: the screen, which reads it, says what is wrong with it in its own words. */
export function FileField(props: {
  /** What the file is ("Xero's chart of accounts"). It names the field for assistive technology. */
  label: string;
  /** Keep the label for assistive technology only, where the button's own words say what the file is. */
  hideLabel?: boolean | undefined;
  /** A name of the caller's own for the label, where a screen sets it its own way. */
  labelClass?: string | undefined;
  /** The button's words: "Choose a file", "Choose another file". */
  button: string;
  variant?: "primary" | "secondary" | undefined;
  /** The kinds of file the picker offers, as an input's `accept`: ".csv,text/csv". */
  accept?: string | undefined;
  disabled?: boolean | undefined;
  /** Ids of text that describes the field (a hint, an error), and whether what was chosen is wrong. */
  describedBy?: string | undefined;
  invalid?: boolean | undefined;
  onFile: (file: File) => void;
  /** Allow choosing or dropping multiple files at once; all files are reported in order. */
  multiple?: boolean | undefined;
  onFiles?: ((files: File[]) => void) | undefined;
  /** More than one file was dropped; none is reported. */
  onTooMany?: (() => void) | undefined;
  /** The field is a place to drop the file. */
  drop?: boolean | undefined;
  /** Shows the look of a file held over the field without one, for stories and tests. */
  dragging?: boolean | undefined;
  /** Above the button: a title, a hint. It is told whether a file is held over the field. */
  lead?: ((dragging: () => boolean) => JSX.Element) | undefined;
  /** Beside the button, on its line. */
  beside?: JSX.Element;
  /** Under the button: the file chosen, progress, what is wrong. */
  children?: JSX.Element;
  class?: string | undefined;
  /** A name of the caller's own for the line the button is on. */
  actionsClass?: string | undefined;
}): JSX.Element {
  const take = (accepted: File[], rejected: { file: File; errors: string[] }[]) => {
    const all = [...accepted, ...rejected.map((item) => item.file)];
    if (props.multiple) {
      if (all.length === 0) return;
      if (props.onFiles) {
        props.onFiles(all);
        return;
      }
      const first = all[0];
      if (first) props.onFile(first);
      return;
    }
    if (all.length > 1) {
      props.onTooMany?.();
      return;
    }
    const file = all[0];
    if (file) props.onFile(file);
  };
  const upload = useFileUpload(() => ({
    maxFiles: props.multiple ? 24 : 1,
    disabled: props.disabled ?? false,
    invalid: props.invalid ?? false,
    allowDrop: props.drop ?? false,
    onFileChange: (detail) => {
      if (detail.acceptedFiles.length + detail.rejectedFiles.length === 0) return;
      // Never a file of its own (see above): Ark says nothing of a file it already holds, and the same file
      // chosen again must be reported again. It is let go of first and reported after, because the screen may
      // turn the field off as soon as it has the file, and Ark does not clear a field that is off.
      setTimeout(() => {
        upload().clearFiles();
        take(detail.acceptedFiles, detail.rejectedFiles);
      }, 0);
    },
  }));
  const inside = (dragging: () => boolean) => (
    <>
      {props.lead?.(dragging)}
      <div class={props.actionsClass ?? "rt-file-actions"}>
        <FileUpload.Trigger {...buttonAttrs({ variant: props.variant ?? "secondary" })}>
          {props.button}
        </FileUpload.Trigger>
        {props.beside}
      </div>
      {props.children}
    </>
  );
  return (
    <FileUpload.RootProvider
      value={upload}
      class={props.class ? `rt-file ${props.class}` : "rt-file"}
    >
      <FileUpload.Label class={props.hideLabel ? "rt-sr-only" : props.labelClass}>
        {props.label}
      </FileUpload.Label>
      {(() => {
        const dragging = () => (props.dragging ?? false) || upload().dragging;
        return (
          <Show when={props.drop} fallback={inside(dragging)}>
            {/* The place to drop is not itself a button: the button inside it is the way in for a keyboard,
                and one way in is enough. */}
            <FileUpload.Dropzone
              class="rt-file-drop"
              disableClick
              role="group"
              aria-label={props.label}
              tabindex={-1}
              data-dragging={dragging() ? "" : undefined}
              data-invalid={props.invalid ? "" : undefined}
            >
              {inside(dragging)}
            </FileUpload.Dropzone>
          </Show>
        );
      })()}
      {/* The kinds are told to the picker only. Told to Ark, a file of another kind is turned away before
          the screen hears of it. */}
      <FileUpload.HiddenInput
        {...(props.accept ? { accept: props.accept } : {})}
        aria-describedby={props.describedBy}
        aria-invalid={props.invalid ? "true" : undefined}
      />
    </FileUpload.RootProvider>
  );
}
