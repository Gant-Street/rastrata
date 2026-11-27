import { createSignal, For, Show } from "solid-js";
import { PageSkeleton } from "../skeleton";
import { Button } from "../button";
import { Dialog } from "../dialog";
import { Details } from "../kit";
import { Check, TriangleAlert } from "../icons";
import { Notice } from "../notice";
import { TextField } from "../text-field";
import type { BankfeedListState } from "./types";
import { words } from "./words";

/** Whether the bank feed is connected, and the way to connect it or disconnect it.
 *
 * The setup token is the one secret this screen ever handles. It is typed into a masked field, sent
 * once, and the field is emptied the moment Connect is pressed, whether or not the attempt works: a
 * token that was claimed is spent, and one that was not is pasted again in a second. The page keeps
 * it nowhere else (not in the address, not in storage, not in the page's own state), and the access
 * URL that comes back is never shown: it lives in a private file beside the book. */
export function BankfeedConnection(props: {
  state?: BankfeedListState;
  connected: boolean;
  /** Which host the saved access URL points to; never the URL itself. */
  host: string | null;
  /** Why a saved connection cannot be used, in words. */
  problem?: string | null;
  connecting?: boolean;
  connectFailure?: string | null;
  /** The reply to a connect was lost: the token may be spent. */
  connectUncertain?: boolean;
  /** Connected in this visit: say what to do next. */
  justConnected?: boolean;
  disconnecting?: boolean;
  disconnectFailure?: string | null;
  onConnect: (token: string) => void;
  onDisconnect: () => void;
}) {
  const [token, setToken] = createSignal("");
  const [missing, setMissing] = createSignal(false);
  const [asking, setAsking] = createSignal(false);
  let keep: HTMLButtonElement | undefined;

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const value = token().trim();
    if (value === "") {
      setMissing(true);
      return;
    }
    setMissing(false);
    props.onConnect(value);
    setToken("");
  };

  return (
    <section class="rt-bankfeed-section" data-lead aria-labelledby="rt-bankfeed-connection">
      <h2 id="rt-bankfeed-connection" class="rt-sr-only">
        {words.connectionTitle}
      </h2>
      <Show
        when={props.state !== "loading" && props.state !== "error"}
        fallback={
          props.state === "error" ? (
            <Notice title={words.unavailable} tone="error" role="alert">
              {words.unavailableBody}
            </Notice>
          ) : (
            <PageSkeleton shape="statement" label={words.checking} />
          )
        }
      >
        <Show when={props.justConnected && props.connected}>
          <Notice title={words.connected} tone="info" role="status" />
        </Show>
        <Show
          when={props.connected}
          fallback={
            <>
              <p class="rt-bankfeed-state" data-state="attention">
                <TriangleAlert aria-hidden="true" /> <span>{words.notConnected}</span>
              </p>
              <Show when={props.problem}>
                <Notice title={words.unusable} tone="error">
                  <bdi>{props.problem}</bdi>
                </Notice>
              </Show>
              <Show when={props.connectUncertain}>
                <Notice title={words.uncertainTitle} tone="review" role="status">
                  {words.connectUncertain}
                </Notice>
              </Show>
              <Show when={props.connectFailure}>
                <Notice title={words.connectFailed} tone="error" role="alert">
                  <bdi>{props.connectFailure}</bdi>
                </Notice>
              </Show>
              <form class="rt-bankfeed-connect" onSubmit={submit} noValidate>
                <TextField
                  label={words.tokenLabel}
                  hint={words.tokenHint}
                  type="password"
                  name="setup-token"
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck={false}
                  data-lpignore="true"
                  data-1p-ignore
                  maxLength={4096}
                  value={token()}
                  {...(missing() ? { error: words.tokenMissing } : {})}
                  onInput={(event) => setToken(event.currentTarget.value)}
                />
                <div class="rt-bankfeed-actions">
                  <Button
                    type="submit"
                    label={words.connect}
                    pendingLabel={words.connecting}
                    pending={props.connecting ?? false}
                  />
                </div>
              </form>
              <Details summary={words.beforeSummary} defaultOpen>
                <div class="rt-bankfeed-before">
                  <h3>{words.whatTitle}</h3>
                  <ul>
                    <For each={words.whatPoints}>{(point) => <li>{point}</li>}</For>
                  </ul>
                  <h3>{words.stepsTitle}</h3>
                  <ol>
                    <For each={words.steps}>{(step) => <li>{step}</li>}</For>
                  </ol>
                </div>
              </Details>
            </>
          }
        >
          <p class="rt-bankfeed-state" data-state="ok">
            <Check aria-hidden="true" />{" "}
            <span>{words.connectedTo(props.host ?? "the SimpleFIN Bridge")}</span>
          </p>
          <p class="rt-hint">{words.connectedFacts}</p>
          <Show when={props.problem}>
            <Notice title={words.unusable} tone="error">
              <bdi>{props.problem}</bdi>
            </Notice>
          </Show>
          <Show when={props.disconnectFailure}>
            <Notice title={words.disconnectFailed} tone="error" role="alert">
              <bdi>{props.disconnectFailure}</bdi>
            </Notice>
          </Show>
          <div class="rt-bankfeed-actions">
            <Button
              variant="secondary"
              label={words.disconnect}
              pendingLabel={words.disconnecting}
              pending={props.disconnecting ?? false}
              onClick={() => setAsking(true)}
            />
          </div>
          <Dialog
            open={asking()}
            onOpenChange={(open) => {
              if (!open && !props.disconnecting) setAsking(false);
            }}
            role="alertdialog"
            title={words.disconnectTitle}
            description={words.disconnectBody}
            initialFocusEl={() => keep ?? null}
            footer={
              <>
                <Button
                  type="button"
                  label={words.disconnectKeep}
                  variant="secondary"
                  ref={(element: HTMLButtonElement) => {
                    keep = element;
                  }}
                  disabled={props.disconnecting ?? false}
                  onClick={() => setAsking(false)}
                />
                <Button
                  type="button"
                  label={words.disconnectDo}
                  pendingLabel={words.disconnecting}
                  variant="danger"
                  pending={props.disconnecting ?? false}
                  onClick={() => {
                    props.onDisconnect();
                    setAsking(false);
                  }}
                />
              </>
            }
          />
        </Show>
      </Show>
    </section>
  );
}
