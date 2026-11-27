import { Show, type JSX } from "solid-js";
import { TriangleAlert } from "./icons";
import { toneOf, type ToneName } from "./kit/tones";

/** Persistent feedback. Use role="alert" only when an urgent message appears.
 *
 * The tone says what the person should do about it (see `kit/tones.ts`): `calm` a fact, `info` good to
 * know (the default), `attention` a person must decide, `problem` something failed. The old names
 * `review` and `error` still work and mean `attention` and `problem`. */
export function Notice(props: {
  title: string;
  children?: JSX.Element;
  tone?: ToneName | undefined;
  role?: "status" | "alert" | undefined;
}) {
  const tone = () => toneOf(props.tone, "info");
  return (
    <div class="rt-notice" data-tone={tone()} role={props.role}>
      <strong>
        <Show when={tone() === "problem"}>
          <TriangleAlert class="rt-notice-icon" aria-hidden="true" />
        </Show>
        {props.title}
      </strong>
      <Show when={props.children}>
        <div>{props.children}</div>
      </Show>
    </div>
  );
}

/** Status is always communicated by text, never color alone. The tone is the same four as `Notice`'s;
 * `calm` is the default and the old `neutral` is the same thing. */
export function Status(props: { children: JSX.Element; tone?: ToneName | undefined }) {
  const tone = () => toneOf(props.tone, "calm");
  return (
    <span class="rt-status" data-tone={tone()}>
      <Show when={tone() === "problem"}>
        <TriangleAlert aria-hidden="true" />
      </Show>
      {props.children}
    </span>
  );
}
