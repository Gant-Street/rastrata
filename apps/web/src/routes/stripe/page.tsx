import {
  Button,
  buttonAttrs,
  Details,
  Dialog,
  DialogClose,
  Notice,
  PageHeader,
  PageSkeleton,
  StripeAccount,
  type StripeAttention,
  StripeConnection,
  type StripeSettingsErrors,
  StripeSettingsForm,
  type StripeSettingsValues,
  type StripeSyncState,
  stripeWords as words,
} from "@rastrata/ui";
import { formatInstant, formatMoneyAbsolute, isNegativeMoney } from "@rastrata/ui/format";
import type { StripeSyncResult } from "@rastrata/application/client-contracts";
import { createMemo, createSignal, onMount, Show } from "solid-js";
import { AppLink } from "../../app-link";
import {
  ApplicationRequestError,
  BrowserApplicationClient,
  type PendingRequest,
} from "../../application-client";
import { currentAccount } from "../../boot";
import { clear as forgetHeld } from "../../held";
import { capabilities } from "../../capabilities";
import { type StripeApp, useStripeApp } from "./app";
import { createKeyedLoader, createLoader } from "../../loader";
import {
  accountOptions,
  balanceView,
  fiscalYearStart,
  openRoles,
  payoutView,
  roleView,
  runView,
  SETTINGS,
  settingsErrors,
  settingsValues,
  SYNC,
} from "./controller";

/** Each call to the service works within a few seconds so the browser's own reply timeout is never
 * the limit; a long first sync is simply several calls. */
const BUDGET_SECONDS = 4;
const MAX_CALLS = 400;

/** Stripe: the way to connect it, and once it is connected the account and its payouts as one block, with the
 * options folded under it (docs/reference/design-language.md; the block is Bank accounts' block). The page says what
 * needs the person and nothing about what works: when Stripe was read and what that booked, a balance that agrees and
 * a payout that is in the books are the normal state. Where the service is given a Stripe key (one a person runs
 * themselves) the same block has a Sync button, and the key is spoken of only when it is missing or cannot be used.
 * A write whose reply is lost is "uncertain; resume", never a silent retry or a pretend success. */
export function StripePage() {
  const client = new BrowserApplicationClient(window.localStorage);
  // Where the service keeps no Stripe credential (a hosted one), Stripe is connected with the button and Rastrata reads it itself; there is no key and no sync to run from here.
  const connectedByButton = !capabilities().connections;
  const account = connectedByButton ? currentAccount() : null;
  // Every read is held in plain signals (see loader.ts): the page is never suspended, so the control
  // a person just used keeps its focus when the figures are read again.
  const status = createLoader(() => client.read("stripe.status", {}));
  const chart = createLoader(() => client.read("accounts.list", {}));
  const book = createLoader(() => client.read("book.get", {}));
  /** Only the payouts that do not add up, which is where the page sends a person who is told of them. */
  const [onlyOff, setOnlyOff] = createSignal(false);
  const [page, setPage] = createSignal(1);
  const payouts = createKeyedLoader(
    () => ({ filter: onlyOff() ? ("mismatch" as const) : ("all" as const), page: page() }),
    (query) => client.read("stripe.payouts", query),
  );
  const [errors, setErrors] = createSignal<StripeSettingsErrors>({});
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  const [syncState, setSyncState] = createSignal<StripeSyncState>("idle");
  const [failure, setFailure] = createSignal<string | null>(null);
  const [progress, setProgress] = createSignal<number | null>(null);
  let heading: HTMLHeadingElement | undefined;

  const app: StripeApp | null = account
    ? useStripeApp({
        account,
        link: () => {
          const linked = status.value()?.link;
          return linked
            ? { accountId: linked.accountId, livemode: linked.livemode, since: linked.since }
            : null;
        },
        onChanged: () => {
          // A reading the control plane made (it ended, or the connection changed) booked payouts behind the page's own requests: what the page holds is let go, so that the books are read and not remembered.
          forgetHeld();
          void Promise.all([status.reload(), payouts.reload()]);
        },
      })
    : null;
  const view = () => app?.ready()?.view ?? null;

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

  const initial = createMemo(() => {
    const current = status.value();
    const setup = book.value()?.setup;
    if (!current || !setup) return null;
    return settingsValues(current, fiscalYearStart(setup));
  });
  /** What the book holds of the options, as one value: the form is made again when it changes, and only then. */
  const savedKey = createMemo(() => {
    const start = initial();
    return start ? JSON.stringify(start.values) : null;
  });
  const options = createMemo(() => accountOptions(chart.value()?.accounts ?? []));
  const roles = createMemo(() => (status.value()?.roles ?? []).map(roleView));
  // What the latest reading did as a whole, which is what a person asks, and not what the last of its calls did.
  const lastRun = createMemo(() => {
    const last = status.value()?.lastRead ?? status.value()?.lastSync;
    return last ? runView(last) : null;
  });
  /** The accounts Stripe needs and has none for, by name: the one thing the options ask of a person. */
  const unsettled = createMemo(() => {
    const current = status.value();
    return current ? openRoles(current) : [];
  });
  const keyInfo = () => status.value()?.key ?? null;
  const keyWorks = () => keyInfo()?.present === true && keyInfo()?.problem === null;

  async function save(values: StripeSettingsValues) {
    setErrors({});
    setSaved(false);
    setSaving(true);
    try {
      await client.write(
        "stripe.configure",
        {
          // Only the accounts chosen here. A role left out uses its chart role key, and an empty
          // list clears an earlier choice.
          mapping: Object.entries(values.mapping).flatMap(([role, accountId]) =>
            accountId ? [{ role: role as never, accountId }] : [],
          ),
          // Before anything is saved the first day is the book's own default (the day the books begin, or the cutover): it is sent only when the person chose another.
          ...(initial()?.saved === false && values.syncFrom === initial()?.values.syncFrom
            ? {}
            : { syncFrom: values.syncFrom }),
          timeZone: values.timeZone,
          salesTax: values.salesTax,
          overlapDays: Number(values.overlapDays),
          matchWindowDays: Number(values.matchWindowDays),
        },
        SETTINGS,
      );
      setSaved(true);
      await status.reload();
    } catch (cause) {
      if (cause instanceof ApplicationRequestError) {
        setErrors(
          cause.uncertain
            ? { form: words.saveUncertain }
            : settingsErrors(cause.message, status.value()?.roles ?? []),
        );
      } else setErrors({ form: words.saveNothing });
    } finally {
      setSaving(false);
    }
  }

  async function sync(resumeFirst: boolean) {
    setFailure(null);
    setSyncState("running");
    setProgress(0);
    try {
      let first = resumeFirst;
      for (let call = 1; call <= MAX_CALLS; call++) {
        let outcome: StripeSyncResult | null;
        if (first) {
          // The reply to the original request was lost: send exactly what was retained.
          const done = await client.resume(SYNC);
          outcome = done.name === "stripe.sync" ? done.data : null;
        } else {
          outcome = await client.write("stripe.sync", { budgetSeconds: BUDGET_SECONDS }, SYNC);
        }
        first = false;
        if (!outcome) break;
        const booked = outcome.run.payouts;
        setProgress((current) => (current ?? 0) + booked);
        if (!outcome.more) break;
      }
      setSyncState("idle");
    } catch (cause) {
      if (cause instanceof ApplicationRequestError && cause.uncertain) setSyncState("uncertain");
      else {
        setFailure(cause instanceof Error ? cause.message : words.syncFailed);
        setSyncState("failed");
      }
    } finally {
      setProgress(null);
      await Promise.all([status.reload(), payouts.reload()]);
    }
  }

  /** There is an account to show: Stripe is connected, or was, or something of it is in the books. Until then the page is the way to connect it. */
  const hasAccount = () => {
    const current = status.value();
    if (!connectedByButton) return keyWorks() || !!current?.through;
    const stage = view()?.stage;
    return (
      stage === "connected" ||
      stage === "stopped" ||
      !!current?.link ||
      !!current?.through ||
      (payouts.value()?.count ?? 0) > 0
    );
  };
  const reading = () => view()?.reading === true || app?.ready()?.busy === "readNow";

  const dateline = (): string | null => {
    if (reading()) return words.reading;
    if (syncState() === "running") return words.syncing;
    const current = view();
    const at = connectedByButton
      ? (current?.syncedAt ?? null)
      : (lastRun()?.finishedAt ?? lastRun()?.startedAt ?? null);
    if (at === null) return null;
    return (current?.stage === "stopped" ? words.lastUpdated : words.updated)(formatInstant(at));
  };

  const note = (): string | undefined => {
    const current = view();
    if (current?.stage === "stopped") return words.disconnected;
    const practice = connectedByButton
      ? current?.stage === "connected" && current.live === false
      : keyInfo()?.mode === "test";
    return practice ? words.practice : undefined;
  };

  /** What needs the person, most pressing first. Nothing here is said while things work. */
  const attention = (): StripeAttention[] => {
    const current = status.value();
    const list: StripeAttention[] = [];
    const asked = app?.ready()?.error;
    if (asked) list.push({ text: asked });
    const open = unsettled();
    if (open.length > 0) list.push({ text: words.needAccountsNamed(open.join(", ")) });
    const problem = view()?.problem ?? null;
    if (problem !== null && !(open.length > 0 && problem === words.needAccounts))
      list.push({ text: problem });
    if (syncState() === "uncertain")
      list.push({
        text: words.syncUncertain,
        action: { label: words.resume, onSelect: () => void sync(true) },
      });
    if (syncState() === "failed") list.push({ text: failure() ?? words.syncFailed });
    const off = current?.payouts.mismatched ?? 0;
    if (off > 0)
      list.push({
        text: words.offPayouts(off),
        action: onlyOff()
          ? {
              label: words.showAll,
              onSelect: () => {
                setPage(1);
                setOnlyOff(false);
              },
            }
          : {
              label: words.showThem,
              onSelect: () => {
                setPage(1);
                setOnlyOff(true);
              },
            },
      });
    // The balance is spoken of only when it does not agree, after a reading that finished: one that agrees is the normal state.
    const balance = current ? balanceView(current) : null;
    if (
      balance &&
      balance.difference !== null &&
      balance.stripeTotal !== null &&
      !balance.ties &&
      lastRun()?.disposition === "complete" &&
      !reading() &&
      syncState() !== "running"
    ) {
      const negative = isNegativeMoney(balance.difference);
      const figure = `${formatMoneyAbsolute(balance.difference)} ${balance.currency.toUpperCase()}`;
      list.push({ text: (negative ? words.moreInRastrata : words.moreInStripe)(figure) });
    }
    return list;
  };

  const menu = () => {
    const current = view();
    if (!app || current?.stage !== "connected") return [];
    const busy = app.ready()?.busy ?? null;
    return [
      ...(current.canReadNow && !current.reading && busy === null
        ? [{ id: "read", label: words.readNow, onSelect: () => app.readNow() }]
        : []),
      ...(current.canDisconnect && busy === null
        ? [{ id: "disconnect", label: words.disconnect, onSelect: () => app.askToStop() }]
        : []),
    ];
  };

  const connectButton = () => (
    <Button
      label={words.appConnect}
      pendingLabel={words.appConnecting}
      pending={app?.ready()?.busy === "connect"}
      disabled={(app?.ready()?.busy ?? null) !== null}
      onClick={() => app?.connect()}
    />
  );

  /** The page's one button: connect Stripe where it is not connected and can be, and the sync where a person runs it. */
  const headerAction = () => {
    if (connectedByButton)
      return (
        <Show when={hasAccount() && view()?.stage !== "connected" && view()?.canConnect}>
          {connectButton()}
        </Show>
      );
    return (
      <Show
        when={keyWorks()}
        fallback={
          // No key that works yet: the page's one button asks the service again, once the key is where the steps say.
          <Show when={keyInfo()}>
            <Button label={words.checkAgain} onClick={() => void status.reload()} />
          </Show>
        }
      >
        <Button
          label={words.syncNow}
          pendingLabel={words.syncing}
          pending={syncState() === "running"}
          disabled={unsettled().length > 0 || syncState() === "uncertain"}
          onClick={() => void sync(false)}
        />
      </Show>
    );
  };

  const appState = () => app?.state() ?? null;

  return (
    <section class="rt-stripe-page" aria-labelledby="stripe-title">
      <PageHeader
        titleId="stripe-title"
        titleRef={(element) => {
          heading = element;
        }}
        title={words.title}
        description={connectedByButton && view()?.stage === "connected" ? words.lead : undefined}
        actions={headerAction()}
      />
      <Show
        when={status.error() === undefined}
        fallback={
          <Notice title={words.unavailableTitle} tone="error" role="alert">
            <p>{words.connectionFailed}</p>
            <Button
              variant="secondary"
              label={words.tryAgain}
              onClick={() => void status.reload()}
            />
          </Notice>
        }
      >
        <Show when={app?.told()}>
          {(notice) => (
            <Notice
              title={notice().text}
              tone={notice().tone === "problem" ? "problem" : "info"}
              role={notice().tone === "problem" ? "alert" : "status"}
            />
          )}
        </Show>
        <Show when={appState()?.step === "problem"}>
          <Notice title={words.unavailableTitle} tone="problem" role="alert">
            <p>
              {(() => {
                const current = appState();
                return current?.step === "problem" ? current.message : "";
              })()}
            </p>
          </Notice>
        </Show>
        <Show
          when={!connectedByButton || appState()?.step !== "loading"}
          fallback={<PageSkeleton shape="statement" label={words.checking} />}
        >
          <Show when={!hasAccount()}>
            <Show
              when={connectedByButton}
              fallback={
                <Show
                  when={keyInfo()}
                  fallback={<PageSkeleton shape="statement" label={words.checking} />}
                >
                  {(info) => <StripeConnection keyInfo={info()} />}
                </Show>
              }
            >
              <Show when={appState()?.step === "ready"}>
                <div class="rt-stripe-empty">
                  <p class="rt-stripe-empty-lead">
                    {view()?.stage === "unavailable"
                      ? words.appUnavailable
                      : view()?.canConnect
                        ? words.empty
                        : words.emptyMember}
                  </p>
                  <Show when={view()?.canConnect}>{connectButton()}</Show>
                </div>
              </Show>
            </Show>
          </Show>
          <Show when={hasAccount()}>
            <Show when={!connectedByButton && keyInfo() && !keyWorks()}>
              <StripeConnection keyInfo={keyInfo() as NonNullable<ReturnType<typeof keyInfo>>} />
            </Show>
            <StripeAccount
              accountId={
                view()?.accountId ??
                status.value()?.link?.accountId ??
                status.value()?.account?.id ??
                null
              }
              note={note()}
              dateline={dateline()}
              attention={attention()}
              progress={
                syncState() === "running" && progress() !== null
                  ? words.syncProgress(progress() ?? 0)
                  : null
              }
              actions={menu()}
              rows={(payouts.value()?.payouts ?? []).map(payoutView)}
              count={payouts.value()?.count ?? 0}
              page={page()}
              pageSize={payouts.value()?.pageSize ?? 25}
              state={
                payouts.error() !== undefined
                  ? "error"
                  : payouts.loading() && !payouts.value()
                    ? "loading"
                    : "ready"
              }
              currency={status.value()?.bookCurrency ?? "USD"}
              inboxHref="/inbox"
              onPageChange={setPage}
              onRetry={() => void payouts.reload()}
              busy={(app?.ready()?.busy ?? null) !== null}
              renderLink={(href, children) => <AppLink href={href}>{children}</AppLink>}
            />
          </Show>
          {/* The options: every one has its default, so they are folded away, and open by themselves only when an account Stripe needs has none. A disconnected account has none: nothing reads it. */}
          <Show when={connectedByButton ? hasAccount() && view()?.stage !== "stopped" : true}>
            <Show
              when={initial()}
              fallback={<PageSkeleton shape="form" label={words.optionsLoading} />}
            >
              <Details
                class="rt-stripe-options-fold"
                flush
                defaultOpen={unsettled().length > 0}
                summary={words.settingsTitle}
              >
                {/* The form starts from what the book holds, and starts again when that changes behind it (the first reading saves the defaults, with the time zone of the Stripe
                    account): not at every look at the book, which would take away what a person is typing. */}
                <Show when={savedKey()} keyed>
                  {(_key) => (
                    <StripeSettingsForm
                      accounts={options()}
                      initial={(initial() as NonNullable<ReturnType<typeof initial>>).values}
                      roles={roles()}
                      startLocked={!!status.value()?.through}
                      errors={errors()}
                      pending={saving()}
                      saved={saved()}
                      onSubmit={(values) => void save(values)}
                    />
                  )}
                </Show>
              </Details>
            </Show>
          </Show>
        </Show>
      </Show>
      <Show when={app?.ready()?.stopping}>
        <Dialog
          open={true}
          role="alertdialog"
          title={words.disconnectTitle}
          description={words.disconnectBody}
          onOpenChange={(open) => {
            if (!open) app?.keepReading();
          }}
          footer={
            <>
              <DialogClose {...buttonAttrs({ variant: "secondary" })}>{words.keep}</DialogClose>
              <Button
                label={words.disconnect}
                pending={app?.ready()?.busy === "disconnect"}
                onClick={() => app?.stop()}
              />
            </>
          }
        />
      </Show>
    </section>
  );
}
