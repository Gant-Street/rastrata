import { Show, type JSX } from "solid-js";
import { Check } from "../icons";
import { useUi } from "../locale";
import type { Tone } from "./tones";

/** The small mark that goes with a tone on a row of a list: an orange square asks for a decision, a red
 * triangle says something failed, a blue circle is good to know, a tick is checked and fine. Each tone has
 * its own shape as well as its own colour, so a marker means something without its colour.
 *
 * The mark is only a glance. The row's own words say what to do, and the tone is also said to a screen
 * reader ("Needs attention: "), except for `calm`, which is a fact and says nothing. Turn that off with
 * `announce={false}` where the words already say it. */
export function ToneMarker(props: { tone: Tone; announce?: boolean | undefined }): JSX.Element {
  const ui = useUi();
  const words = () => ui.messages.kit.tone[props.tone];
  return (
    <>
      <span class="rt-tone-marker" data-tone={props.tone} aria-hidden="true">
        <Show when={props.tone === "calm"}>
          <Check />
        </Show>
      </span>
      <Show when={props.announce !== false && words()}>
        <span class="rt-sr-only">{words()}: </span>
      </Show>
    </>
  );
}
