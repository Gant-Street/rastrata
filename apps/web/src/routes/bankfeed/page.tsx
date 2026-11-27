import type { BankfeedSyncResult } from "@rastrata/application/client-contracts";
import {
  BankfeedAccounts,
  BankfeedAttentionList,
  BankfeedConnection,
  BankfeedDaily,
  type BankfeedPauseView,
  BankfeedSyncPanel,
  type BankfeedSyncState,
  bankfeedWords as words,
  Button,
  Notice,
  PageHeader,
} from "@rastrata/ui";
import { createMemo, createSignal, onMount, Show } from "solid-js";
import {
  ApplicationRequestError,
  BrowserApplicationClient,
  type PendingRequest,
} from "../../application-client";
import { createLoader } from "../../loader";
import {
  accountView,
  attentionView,
  chartOptions,
  DISCONNECT,
  linkKey,
  messageOf,
  pauseFromStatus,
  pauseOf,
  REFRESH,
  runView,
  saidBy,
  SETTINGS,
  SYNC,
  syncBlocked,
  unlinkKey,
} from "./controller";

/** Each call to the service works within a few seconds so the browser's own reply timeout is never
 * the limit; a long first sync is simply several calls. */
const BUDGET_SECONDS = 4;
const MAX_CALLS = 400;

/** A client that keeps nothing. The setup token is the one secret this screen handles, and the
 * ordinary client keeps every write in the browser's storage until it is answered, so that a lost
 * reply can be resumed. A setup token cannot be resumed (it works once), so it goes through this one:
 * it leaves no copy of the token behind, however the attempt ends. */
function clientThatKeepsNothing(): BrowserApplicationClient {
  const held = new Map<string, string>();
  return new BrowserApplicationClient({
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => void held.set(key, value),
    removeItem: (key) => void held.delete(key),
  });
}

const lost = (cause: unknown): boolean =>
  cause instanceof ApplicationRequestError && cause.code === "operation_unresolved";

/** Settings, Bank connection: connect the SimpleFIN Bridge with a setup token, choose which of its accounts
 * are read and which chart account each is recorded to, sync into For review, and optionally sync by
 * itself once a day. A write whose reply is lost is "uncertain; resume", never a silent retry or a
 * pretend success. */
export function BankfeedPage() {
  const client = new BrowserApplicationClient(window.localStorage);
  // Every read is held in plain signals (see loader.ts): the page is never suspended, so the control a
  // person just used keeps its focus when the figures are read again.
  const status = createLoader(() => client.read("bankfeed.status", {}));
  const chart = createLoader(() => client.read("accounts.list", {}));

  const [connecting, setConnecting] = createSignal(false);
  const [connectFailure, setConnectFailure] = createSignal<string | null>(null);
  const [connectUncertain, setConnectUncertain] = createSignal(false);
  const [justConnected, setJustConnected] = createSignal(false);
  const [disconnecting, setDisconnecting] = createSignal(false);
  const [disconnectFailure, setDisconnectFailure] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [refreshing, setRefreshing] = createSignal(false);
  const [refreshFailure, setRefreshFailure] = createSignal<string | null>(null);
  const [errors, setErrors] = createSignal<Readonly<Record<string, string>>>({});
  const [notes, setNotes] = createSignal<Readonly<Record<string, readonly string[]>>>({});
  const [syncState, setSyncState] = createSignal<BankfeedSyncState>("idle");
  const [failure, setFailure] = createSignal<string | null>(null);
  const [pause, setPause] = createSignal<BankfeedPauseView | null>(null);
  const [progress, setProgress] = createSignal<{ calls: number; lines: number } | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  const [settingsFailure, setSettingsFailure] = createSignal<string | null>(null);
  const [uncertain, setUncertain] = createSignal<string | null>(null);
  let heading: HTMLHeadingElement | undefined;

  const retained = (key: string): PendingRequest | null => {
    try {
      return client.pending(key);
    } catch {
      return null;
    }
  };
  onMount(() => {
    if (retained(SYNC)) setSyncState("uncertain");
    heading?.focus();
  });

  const noBook = createMemo(() => {
    const failed = status.error();
    return failed instanceof ApplicationRequestError && failed.code === "book_not_configured";
  });
  const options = createMemo(() => chartOptions(chart.value()?.accounts ?? []));
  const accounts = createMemo(() => (status.value()?.accounts ?? []).map(accountView));
  const history = createMemo(() => (status.value()?.history ?? []).map(runView));
  const lastRun = createMemo(() => {
    const last = status.value()?.lastSync;
    return last ? runView(last) : null;
  });
  const standingPause = createMemo(() => {
    const current = status.value();
    return current ? pauseFromStatus(current, new Date()) : null;
  });
  const blocked = createMemo(() => {
    const current = status.value();
    return current ? syncBlocked(current, new Date()) : words.checking;
  });

  const focusAccounts = () =>
    queueMicrotask(() => document.getElementById("rt-bankfeed-accounts")?.focus());

  async function connect(token: string) {
    setConnectFailure(null);
    setConnectUncertain(false);
    setJustConnected(false);
    setConnecting(true);
    try {
      await clientThatKeepsNothing().write("bankfeed.connect", { setupToken: token }, "connect");
      setJustConnected(true);
      await status.reload();
      focusAccounts();
    } catch (cause) {
      if (lost(cause)) setConnectUncertain(true);
      else setConnectFailure(messageOf(cause, "The bank connection could not be made."));
      await status.reload();
    } finally {
      setConnecting(false);
    }
  }

  async function disconnect() {
    setDisconnectFailure(null);
    setDisconnecting(true);
    try {
      await client.write("bankfeed.disconnect", {}, DISCONNECT);
      setJustConnected(false);
      setPause(null);
      setFailure(null);
      setSyncState("idle");
      await status.reload();
    } catch (cause) {
      if (lost(cause)) setUncertain(DISCONNECT);
      else setDisconnectFailure(messageOf(cause, "The bank connection could not be disconnected."));
    } finally {
      setDisconnecting(false);
    }
  }

  async function refresh() {
    setRefreshFailure(null);
    setRefreshing(true);
    try {
      await client.write("bankfeed.accounts", {}, REFRESH);
    } catch (cause) {
      if (lost(cause)) setUncertain(REFRESH);
      else setRefreshFailure(messageOf(cause, "The accounts could not be read."));
    } finally {
      setRefreshing(false);
      await status.reload();
    }
  }

  const remember = (accountId: string, message: string | null) =>
    setErrors((current) => {
      const { [accountId]: _dropped, ...rest } = current;
      return message === null ? rest : { ...rest, [accountId]: message };
    });

  async function link(accountId: string, ledgerAccountId: string, startOn: string) {
    remember(accountId, null);
    setBusy(accountId);
    try {
      const result = await client.write(
        "bankfeed.link",
        { accountId, ledgerAccountId, ...(startOn ? { startOn } : {}) },
        linkKey(accountId),
      );
      setNotes((current) => ({ ...current, [accountId]: result.notes }));
      await status.reload();
    } catch (cause) {
      if (lost(cause)) setUncertain(linkKey(accountId));
      else remember(accountId, messageOf(cause, "The account could not be linked."));
    } finally {
      setBusy(null);
    }
  }

  async function unlink(accountId: string) {
    remember(accountId, null);
    setBusy(accountId);
    try {
      await client.write("bankfeed.unlink", { accountId }, unlinkKey(accountId));
      setNotes((current) => {
        const { [accountId]: _dropped, ...rest } = current;
        return rest;
      });
      await status.reload();
    } catch (cause) {
      if (lost(cause)) setUncertain(unlinkKey(accountId));
      else remember(accountId, messageOf(cause, "The account could not be unlinked."));
    } finally {
      setBusy(null);
    }
  }

  async function saveSettings(next: { dailySync: boolean; dailyAt: string }) {
    setSettingsFailure(null);
    setSaved(false);
    setSaving(true);
    try {
      await client.write("bankfeed.settings", next, SETTINGS);
      setSaved(true);
      await status.reload();
    } catch (cause) {
      if (lost(cause)) setUncertain(SETTINGS);
      else setSettingsFailure(messageOf(cause, "The setting could not be saved."));
    } finally {
      setSaving(false);
    }
  }

  /** Send exactly what was sent before, for a write whose reply was lost. */
  async function resume(key: string) {
    try {
      await client.resume(key);
      setUncertain(null);
    } catch (cause) {
      if (!lost(cause)) setUncertain(null);
    } finally {
      await status.reload();
    }
  }

  async function sync(resumeFirst: boolean) {
    setFailure(null);
    setPause(null);
    setSyncState("running");
    setProgress({ calls: 0, lines: 0 });
    try {
      let first = resumeFirst;
      for (let call = 1; call <= MAX_CALLS; call++) {
        let outcome: BankfeedSyncResult | null;
        if (first) {
          // The reply to the original request was lost: send exactly what was retained.
          const done = await client.resume(SYNC);
          outcome = done.name === "bankfeed.sync" ? done.data : null;
        } else {
          outcome = await client.write("bankfeed.sync", { budgetSeconds: BUDGET_SECONDS }, SYNC);
        }
        first = false;
        if (!outcome) break;
        const lines = outcome.run.newLines;
        setProgress((current) => ({
          calls: (current?.calls ?? 0) + 1,
          lines: (current?.lines ?? 0) + lines,
        }));
        // A pause is the Bridge's limit, or its request to slow down: asking again would only spend
        // what is left, so stop and say when it may be asked again.
        const stopped = pauseOf(outcome);
        if (stopped) {
          setPause(stopped);
          break;
        }
        if (!outcome.more) break;
      }
      setSyncState("idle");
    } catch (cause) {
      if (lost(cause)) setSyncState("uncertain");
      else {
        setFailure(messageOf(cause, "The sync stopped. Nothing was posted."));
        setSyncState("failed");
      }
    } finally {
      setProgress(null);
      await status.reload();
    }
  }

  const connected = () => status.value()?.connected === true;
  const listState = () =>
    status.value() ? "ready" : status.error() !== undefined ? "error" : "loading";

  return (
    <section class="rt-bankfeed-page" aria-labelledby="bankfeed-title">
      <PageHeader
        titleId="bankfeed-title"
        titleRef={(element) => {
          heading = element;
        }}
        title={words.title}
        description={words.pageLine}
      />
      <Show
        when={!noBook()}
        fallback={
          <Notice title={words.noBookTitle} tone="review">
            <p>{words.noBook}</p>
            <a href="/">{words.home}</a>
          </Notice>
        }
      >
        <Show
          when={status.error() === undefined || status.value() !== undefined}
          fallback={
            <Notice title={words.unavailable} tone="error" role="alert">
              <p>{words.unavailableBody}</p>
              <Button
                variant="secondary"
                label={words.tryAgain}
                onClick={() => void status.reload()}
              />
            </Notice>
          }
        >
          <Show when={uncertain()}>
            {(key) => (
              <Notice title={words.uncertainTitle} tone="review" role="status">
                <p>{words.uncertainBody}</p>
                <Button
                  variant="secondary"
                  label={words.resume}
                  onClick={() => void resume(key())}
                />
              </Notice>
            )}
          </Show>
          <BankfeedConnection
            state={status.value() ? "ready" : status.error() !== undefined ? "error" : "loading"}
            connected={connected()}
            host={status.value()?.credential.host ?? null}
            problem={status.value()?.credential.problem ?? null}
            connecting={connecting()}
            connectFailure={connectFailure()}
            connectUncertain={connectUncertain()}
            justConnected={justConnected()}
            disconnecting={disconnecting()}
            disconnectFailure={disconnectFailure()}
            onConnect={(token) => void connect(token)}
            onDisconnect={() => void disconnect()}
          />
          <Show when={connected() || (status.value()?.attention.length ?? 0) > 0}>
            <BankfeedAttentionList
              items={attentionView(status.value()?.attention ?? [])}
              said={saidBy(status.value()?.problems ?? [])}
            />
          </Show>
          <Show when={connected() || accounts().length > 0}>
            <Show when={refreshFailure()}>
              <Notice title={words.accountsFailed} tone="error" role="alert">
                <bdi>{refreshFailure()}</bdi>
              </Notice>
            </Show>
            <BankfeedAccounts
              state={listState()}
              accounts={accounts()}
              chart={options()}
              bookCurrency={status.value()?.bookCurrency ?? ""}
              busy={busy()}
              refreshing={refreshing()}
              errors={errors()}
              notes={notes()}
              connected={connected()}
              onRefresh={() => void refresh()}
              onLink={(accountId, ledgerAccountId, startOn) =>
                void link(accountId, ledgerAccountId, startOn)
              }
              onUnlink={(accountId) => void unlink(accountId)}
            />
          </Show>
          <Show when={connected()}>
            <BankfeedSyncPanel
              state={syncState()}
              blocked={blocked()}
              progress={progress()}
              pause={pause() ?? standingPause()}
              lastRun={lastRun()}
              history={history()}
              requests={status.value()?.requests ?? null}
              failure={failure()}
              inboxHref="/inbox"
              onSync={() => void sync(false)}
              onResume={() => void sync(true)}
            />
            <Show when={status.value()?.settings}>
              {(settings) => (
                <BankfeedDaily
                  settings={settings()}
                  scheduler={status.value()?.scheduler === true}
                  saving={saving()}
                  saved={saved()}
                  failure={settingsFailure()}
                  onSave={(next) => void saveSettings(next)}
                />
              )}
            </Show>
          </Show>
        </Show>
      </Show>
    </section>
  );
}
