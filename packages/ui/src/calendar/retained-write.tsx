import { Button } from "../button";
import { Notice } from "../notice";
import { words } from "./words";

/** A change that was sent and not answered. The browser keeps the exact request, so the only safe
 * thing to do is send that same request again; making the change a second time to find out what
 * happened is how a book ends up with it twice. */
export function RetainedWrite(props: { busy?: boolean; onResume: () => void }) {
  return (
    <Notice title={words.uncertainTitle} tone="review" role="status">
      <p>{words.retainedBody}</p>
      <p>{words.retained}</p>
      <Button
        label={words.resume}
        variant="secondary"
        disabled={props.busy ?? false}
        onClick={props.onResume}
      />
    </Notice>
  );
}
