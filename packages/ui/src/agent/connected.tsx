import { createUniqueId, For, type JSX, Show } from "solid-js";
import { Button } from "../button";
import { Notice } from "../notice";
import { PageSkeleton } from "../skeleton";
import { connectedLine } from "./text";
import type { AgentConnectedRow } from "./types";
import { words } from "./words";

/** The id of a row's Disconnect button, so that focus can go back to it when its dialog is dismissed. */
export const agentDisconnectId = (id: string): string => `agent-disconnect-${id}`;

/**
 * What is connected: one agent a row, by the name the command line gave it, with one line (what it may
 * do, when it was last used) and Disconnect. Nothing says "active": being on the list is that. One that
 * ran out stays for a month, with the day it ended and no button, so that an agent that stopped is
 * explained; one a person disconnected is gone.
 */
export function AgentConnectedList(props: {
  rows: readonly AgentConnectedRow[];
  loading?: boolean | undefined;
  failed?: boolean | undefined;
  onRetry?: (() => void) | undefined;
  /** The agent being disconnected; its button is busy. */
  disconnecting?: string | undefined;
  onDisconnect: (row: AgentConnectedRow) => void;
  /** Where the changes agents made are listed, for someone who may read them. */
  changesHref?: string | undefined;
  /** The clock, for a story or a test that fixes it. */
  now?: Date | undefined;
}): JSX.Element {
  const titleId = createUniqueId();
  const now = () => props.now ?? new Date();
  return (
    <section class="rt-agent-connected" aria-labelledby={titleId}>
      <h2 id={titleId} class="rt-agent-connected-title">
        {words.connectedTitle}
      </h2>
      <Show when={props.failed}>
        <Notice title={words.connectedFailed} tone="error" role="alert">
          <Show when={props.onRetry}>
            <Button
              label={words.retry}
              variant="secondary"
              size="sm"
              onClick={() => props.onRetry?.()}
            />
          </Show>
        </Notice>
      </Show>
      <Show when={props.loading && props.rows.length === 0 && !props.failed}>
        <PageSkeleton shape="table" label={words.connectedLoading} />
      </Show>
      <Show when={!props.loading && !props.failed && props.rows.length === 0}>
        <p class="rt-agent-connected-empty">{words.connectedEmpty}</p>
      </Show>
      <Show when={props.rows.length > 0}>
        <ul class="rt-agent-connected-list" data-facts="">
          <For each={props.rows}>
            {(row) => (
              <li class="rt-agent-connected-row" data-status={row.status}>
                <span class="rt-agent-connected-text">
                  <bdi class="rt-agent-connected-name">{row.name}</bdi>
                  <span class="rt-agent-connected-line">
                    <bdi>{connectedLine(row, now())}</bdi>
                  </span>
                </span>
                <Show when={row.status === "active"}>
                  <Button
                    id={agentDisconnectId(row.id)}
                    label={words.disconnect}
                    aria-label={words.disconnectFor(row.name)}
                    variant="quiet"
                    size="sm"
                    pending={props.disconnecting === row.id}
                    pendingLabel={words.disconnecting}
                    onClick={() => props.onDisconnect(row)}
                  />
                </Show>
              </li>
            )}
          </For>
        </ul>
        <Show when={props.changesHref}>
          {(href) => (
            <p class="rt-agent-connected-more">
              <a href={href()}>{words.changes}</a>
            </p>
          )}
        </Show>
      </Show>
    </section>
  );
}
