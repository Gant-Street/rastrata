import { RadioGroup } from "@ark-ui/solid/radio-group";
import { createUniqueId, For, type JSX, Show } from "solid-js";
import { Button, buttonAttrs } from "../button";
import { FieldError } from "../field";
import { CopyButton } from "./copy";
import { askFor } from "./text";
import type { AgentChoice, AgentChoiceId } from "./types";
import { words } from "./words";

/**
 * Connecting an agent, as three steps a person reads top to bottom: what it may do, the one command to
 * run where the agent works, and what to say to it. The choice is made before the command exists, since
 * the command carries it; changing the choice takes the command away, and the page's one main button
 * asks for another. Where the command needs no code (a computer that runs the service itself), there is
 * no button: the command is there, and follows the choice.
 */
export function AgentConnect(props: {
  choices: readonly AgentChoice[];
  choice: AgentChoiceId;
  onChoice: (choice: AgentChoiceId) => void;
  /** The command to run, when there is one to show. It holds a code that works once, never a credential. */
  command: string | null;
  /** Asks for the command. Absent where the command is always there. */
  onGetCommand?: (() => void) | undefined;
  pending?: boolean | undefined;
  /** Why the command could not be made, in words. */
  problem?: string | undefined;
  /** Says under the command that its code works once, for ten minutes. */
  once?: boolean | undefined;
  /** The code that was showing ran out before it was used. */
  ranOut?: boolean | undefined;
  /** The name of the agent that has just connected with the command that was showing. */
  connected?: string | undefined;
  /** Where the command line is installed from, where that page is published. */
  installHref?: string | undefined;
  /** Anything the page must say before the command can be asked for (a sign-in that is too old). */
  children?: JSX.Element;
}): JSX.Element {
  const problemId = createUniqueId();
  return (
    <ol class="rt-agent-steps">
      <li class="rt-agent-step">
        <RadioGroup.Root
          class="rt-agent-choices"
          value={props.choice}
          disabled={props.pending ?? false}
          onValueChange={(detail) => {
            if (detail.value !== null && detail.value !== props.choice)
              props.onChoice(detail.value as AgentChoiceId);
          }}
        >
          <RadioGroup.Label class="rt-agent-step-title">{words.choiceTitle}</RadioGroup.Label>
          <For each={props.choices}>
            {(choice) => (
              <RadioGroup.Item class="rt-agent-choice" value={choice.id}>
                <RadioGroup.ItemControl class="rt-agent-choice-mark" />
                <RadioGroup.ItemText class="rt-agent-choice-text">
                  <strong>{words.choices[choice.id].label}</strong>
                  <Show when={words.choices[choice.id].detail}>{(detail) => <> {detail()}</>}</Show>
                </RadioGroup.ItemText>
                <RadioGroup.ItemHiddenInput />
              </RadioGroup.Item>
            )}
          </For>
        </RadioGroup.Root>
      </li>
      <li class="rt-agent-step">
        <h2 class="rt-agent-step-title">{words.commandTitle}</h2>
        {props.children}
        <Show
          when={props.command}
          fallback={
            <Show when={props.onGetCommand}>
              {(get) => (
                <>
                  <Show when={props.connected}>
                    {(name) => (
                      <p class="rt-agent-connected-now" role="status">
                        <bdi>{words.nowConnected(name())}</bdi>
                      </p>
                    )}
                  </Show>
                  <Show when={props.ranOut && !props.connected}>
                    <p class="rt-hint" role="status">
                      {words.codeRanOut}
                    </p>
                  </Show>
                  <Show when={props.problem}>
                    {(problem) => (
                      <div role="alert">
                        <FieldError id={problemId}>{problem()}</FieldError>
                      </div>
                    )}
                  </Show>
                  <div class="rt-agent-get">
                    <Button
                      type="button"
                      variant={props.connected ? "secondary" : "primary"}
                      label={props.connected ? words.another : words.getCommand}
                      pending={props.pending ?? false}
                      pendingLabel={words.gettingCommand}
                      onClick={() => get()()}
                    />
                    {/* The command needs the command line: the way to get it is beside the button, before the
                        code (which works for ten minutes) is asked for. */}
                    <Show when={!props.connected && props.installHref}>
                      {(href) => (
                        <a href={href()} target="_blank" rel="noopener">
                          {words.install}
                        </a>
                      )}
                    </Show>
                  </div>
                </>
              )}
            </Show>
          }
        >
          {(command) => (
            <>
              <div class="rt-agent-command-row">
                <code class="rt-agent-code" tabindex="0">
                  {command()}
                </code>
                <CopyButton text={command()} size="md" />
              </div>
              <Show when={props.once || props.installHref}>
                <Show when={props.once}>
                  <p class="rt-hint">{words.codeOnce}</p>
                </Show>
                <Show when={props.installHref}>
                  {(href) => (
                    <p>
                      <a
                        {...buttonAttrs({ variant: "secondary", size: "sm" })}
                        href={href()}
                        target="_blank"
                        rel="noopener"
                      >
                        {words.install}
                      </a>
                    </p>
                  )}
                </Show>
              </Show>
            </>
          )}
        </Show>
      </li>
      <li class="rt-agent-step">
        <h2 class="rt-agent-step-title">{words.askTitle}</h2>
        <blockquote class="rt-agent-ask">{`“${askFor(props.choice)}”`}</blockquote>
      </li>
    </ol>
  );
}
