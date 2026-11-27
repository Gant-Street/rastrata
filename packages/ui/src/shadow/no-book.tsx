import type { JSX } from "solid-js";
import { Notice } from "../notice";
import { words } from "./words";

/** What a screen says when the book it works on does not exist yet. It is not an error: nothing
 * failed, there is just nothing to show, and the way forward is to set the books up. */
export function NoBook(props: { href?: string | undefined }): JSX.Element {
  return (
    <Notice title={words.noBookTitle} tone="info" role="status">
      <p>{words.noBookBody}</p>
      <p>
        <a href={props.href ?? "/"}>{words.noBookLink}</a>
      </p>
    </Notice>
  );
}
