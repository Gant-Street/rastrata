import { type JSX, Show } from "solid-js";
import { buttonAttrs } from "../button";
import { Status } from "../notice";
import type { ButtonLinkProps } from "./button-link";

export interface ConnectionCardProps {
  title: string;
  /** What is true now, in words: "Connected", "Not connected". Never colour alone. */
  status: string;
  /** What the state asks of the person: nothing (`calm`), a look (`attention`), a fix (`problem`). */
  tone?: "calm" | "attention" | "problem";
  /** A quieter line under the status: the accounts linked, when it was last read. */
  detail?: string | undefined;
  /** What the connection does, in a sentence. It comes after the control, not before. */
  body: string;
  /** The one control: where to set it up or look after it. */
  action: string;
  href: string;
  /** The status is still being read. */
  busy?: boolean;
  /** Draws the link the way the application navigates (through its router). */
  link?: (props: ButtonLinkProps) => JSX.Element;
}

/** One connection on Settings, Connections: a name and its state, the control to open it, and then what it
 * does. A column under a heavy rule, not a box. */
export function ConnectionCard(props: ConnectionCardProps): JSX.Element {
  const attrs = buttonAttrs({ variant: "secondary" });
  return (
    <li class="rt-connection" aria-busy={props.busy ? true : undefined}>
      <div class="rt-connection-head">
        <h2>{props.title}</h2>
        <Status tone={props.tone ?? "calm"}>{props.status}</Status>
      </div>
      <Show when={props.detail}>
        <p class="rt-connection-detail">{props.detail}</p>
      </Show>
      <p class="rt-connection-action">
        {props.link ? (
          props.link({ ...attrs, href: props.href, children: props.action })
        ) : (
          <a {...attrs} href={props.href}>
            {props.action}
          </a>
        )}
      </p>
      <p class="rt-connection-body">{props.body}</p>
    </li>
  );
}
