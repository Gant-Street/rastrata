import { Match, Show, Switch } from "solid-js";
import { Button } from "../button";
import { formatInstant } from "../format";
import { Notice } from "../notice";
import { isCaller, makerName, type MarkVerdict } from "./logic";
import type { LookRecordView, LookState, MakerView } from "./types";
import { words } from "./words";

/** The person's statement "I have looked at these", and where it stands. The button is offered only when it
 * would be true: the list is all there is, no choice hides a change, and there is something in it. When it
 * is not offered, the reason is said, and the way to make it true. A saved statement is said only once the
 * service has confirmed it; a lost reply is "we could not tell", never "saved" and never "failed". */
export function ReviewBar(props: {
  verdict: MarkVerdict;
  look: LookState;
  lastReview: LookRecordView | null;
  /** The instant the list was read at: what the statement would cover. */
  asOf: string;
  caller?: MakerView | undefined;
  timeZone?: string | undefined;
  onLook: () => void;
  onReload: () => void;
  /** Put the choices back, so that the list is all there is. */
  onClear: () => void;
  /** Start the list at the last look, so that it holds what has not been looked at. */
  onFromLastLook: () => void;
}) {
  const who = (maker: MakerView) => (isCaller(maker, props.caller) ? words.you : makerName(maker));
  const showButton = () =>
    props.verdict.ok && (props.look.kind === "idle" || props.look.kind === "saving");
  const why = () => {
    const verdict = props.verdict;
    return verdict.ok || verdict.reason === "nothing" ? null : words.whyNot[verdict.reason];
  };
  return (
    <section class="rt-changes-look" data-look={props.look.kind}>
      <p class="rt-changes-lastlook" data-facts>
        <Show when={props.lastReview} fallback={words.neverLooked}>
          {(review) =>
            words.lastLook(
              formatInstant(review().at, { timeZone: props.timeZone }),
              who(review().by),
            )
          }
        </Show>
      </p>
      <Show when={showButton()}>
        <div class="rt-changes-look-action">
          <Button
            type="button"
            label={words.lookButton}
            pendingLabel={words.lookSaving}
            pending={props.look.kind === "saving"}
            onClick={() => props.onLook()}
          />
        </div>
      </Show>
      <Show when={why()}>{(text) => <p class="rt-description">{text()}</p>}</Show>
      <Show when={!props.verdict.ok && props.verdict.reason === "filtered"}>
        <Button
          type="button"
          label={words.clear}
          variant="secondary"
          size="sm"
          onClick={() => props.onClear()}
        />
      </Show>
      <Show when={!props.verdict.ok && props.verdict.reason === "window"}>
        <Button
          type="button"
          label={words.showWhatIsNew}
          variant="secondary"
          size="sm"
          onClick={() => props.onFromLastLook()}
        />
      </Show>
      <Switch>
        <Match when={props.look.kind === "saved" ? props.look : undefined}>
          {(saved) => (
            <Notice
              title={words.lookSaved(formatInstant(saved().at, { timeZone: props.timeZone }))}
              tone="calm"
              role="status"
            />
          )}
        </Match>
        <Match when={props.look.kind === "uncertain"}>
          <Notice title={words.lookUncertain.title} tone="attention" role="alert">
            <p>{words.lookUncertain.body}</p>
            <Button
              type="button"
              label={words.lookUncertain.action}
              variant="secondary"
              size="sm"
              onClick={() => props.onLook()}
            />
          </Notice>
        </Match>
        <Match when={props.look.kind === "stale"}>
          <Notice title={words.lookStale.title} tone="attention" role="alert">
            <p>{words.lookStale.body}</p>
            <Button
              type="button"
              label={words.lookStale.action}
              variant="secondary"
              size="sm"
              onClick={() => props.onReload()}
            />
          </Notice>
        </Match>
        <Match when={props.look.kind === "incomplete"}>
          <Notice title={words.lookIncomplete.title} tone="attention" role="alert">
            <p>{words.lookIncomplete.body}</p>
          </Notice>
        </Match>
        <Match when={props.look.kind === "denied"}>
          <Notice title={words.lookDenied.title} tone="attention" role="alert">
            <p>{words.lookDenied.body}</p>
          </Notice>
        </Match>
        <Match when={props.look.kind === "failed"}>
          <Notice title={words.lookFailed.title} tone="problem" role="alert">
            <p>{words.lookFailed.body}</p>
            <Button
              type="button"
              label={words.lookFailed.action}
              variant="secondary"
              size="sm"
              onClick={() => props.onLook()}
            />
          </Notice>
        </Match>
      </Switch>
    </section>
  );
}
