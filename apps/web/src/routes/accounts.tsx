import type { ApplicationOutputs } from "@rastrata/application/client-contracts";
import { sumMoney } from "@rastrata/application/money";
import {
  type AccountView,
  BankRows,
  type BankTileData,
  bankReconcileId,
  Button,
  buttonAttrs,
  type ChartGroupId,
  ChartGroups,
  chartGroupOf,
  chartMessages,
  chartWords,
  Details,
  DetailsList,
  formatDate,
  groupAccounts,
  ListSearch,
  Loading,
  Notice,
  openAtRest,
  PageHeader,
  searchAccounts,
} from "@rastrata/ui";
import { useRouter } from "@tanstack/solid-router";
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { ApplicationRequestError, BrowserApplicationClient } from "../application-client";
import { capabilities } from "../capabilities";
import { createLoader } from "../loader";
import { createAccountEditing } from "./accounting/account-editing";
import { loadTaxLines } from "./accounting/tax-lines";
import { bankingSummary, bankTileLinks, connectBankPath } from "./ingest/summary";
import { hasRetainedStart, StartReconciliation } from "./reconcile/start";

type AccountList = ApplicationOutputs["accounts.list"];

const NEW_BUTTON_ID = "new-account";
const OPEN_KEY = "rastrata:accounts:open";

/** The kinds of account a person opened or shut, for this visit of the browser: coming back from an
 * account finds the chart as it was left. Only what was touched is kept, so a kind nobody touched still
 * opens by itself when it comes to hold something. A per-viewer convenience, so it may be unavailable;
 * the chart then opens as it does the first time. */
type Touched = Partial<Record<ChartGroupId, boolean>>;

function readTouched(): Touched {
  try {
    const kept = window.sessionStorage.getItem(OPEN_KEY) ?? "";
    return Object.fromEntries(
      kept
        .split(",")
        .filter(Boolean)
        .map((entry) => {
          const [id, open] = entry.split(":");
          return [id, open === "1"];
        }),
    ) as Touched;
  } catch {
    return {};
  }
}

function writeTouched(touched: Touched): void {
  try {
    window.sessionStorage.setItem(
      OPEN_KEY,
      Object.entries(touched)
        .map(([id, open]) => `${id}:${open ? "1" : "0"}`)
        .join(","),
    );
  } catch {
    // The chart opens as it does the first time.
  }
}

const client = new BrowserApplicationClient(window.localStorage);

/** The chart, or null when no book has been set up yet. */
async function loadAccounts(): Promise<AccountList | null> {
  try {
    return await client.read("accounts.list", {});
  } catch (cause) {
    if (cause instanceof ApplicationRequestError && cause.code === "book_not_configured")
      return null;
    throw cause;
  }
}

/** Accounts: the bank and card accounts first (what the bank says, the balance, Reconcile on the row), then
 * the Chart of accounts folded by kind, each kind with what it adds up to. An open kind lists the accounts
 * that hold something; a name opens the account, where it is edited. "New account" opens a drawer, and
 * "Connect a bank" goes where a bank is connected, where the service can. */
export function AccountsPage() {
  const w = chartWords;
  const router = useRouter();
  // Every read is held in plain signals (see loader.ts), so reading the chart again after a save
  // never suspends the page and the control just used keeps its focus.
  const chart = createLoader(loadAccounts);
  const taxLines = createLoader(() => loadTaxLines(client));
  const calendar = createLoader(() => client.read("periods.list", {}));
  const [query, setQuery] = createSignal("");
  let searchBox: HTMLInputElement | undefined;
  // The bank, card and Stripe accounts come from the summary the whole application shares.
  const banking = bankingSummary();
  onMount(() => void banking.reload(2_000));
  // Where Stripe is connected with a button, its row is always here: this page is the way to Stripe's own,
  // so a book with nothing of Stripe in it yet still has the way in ("Not connected", Connect Stripe).
  const bankRows = createMemo((): readonly BankTileData[] => {
    const tiles = banking.tiles();
    if (!capabilities().stripeApp || tiles.some((tile) => tile.kind === "stripe")) return tiles;
    return [
      ...tiles,
      {
        accountId: "",
        code: "",
        name: "Stripe",
        kind: "stripe",
        bookBalance: null,
        toReview: 0,
        imported: false,
        connection: { kind: "stripe", state: "not_connected" },
      },
    ];
  });
  // Reconcile opens its small form over the page; a start whose reply was lost is offered again.
  const [reconciling, setReconciling] = createSignal<{ open: boolean; account: string }>({
    open: hasRetainedStart(),
    account: "",
  });
  // Adding an account, and what is said about a change to one that is waiting or was just saved, is
  // shared with an account's own page, where an account is edited.
  const editing = createAccountEditing({
    client,
    chart: chart.value,
    reload: () => chart.reload(),
    taxLines: taxLines.value,
    periods: calendar.value,
    newButtonId: NEW_BUTTON_ID,
    created: (account) => {
      const kind = chartGroupOf(account.role);
      toggle(kind, true);
      showFull(kind, true);
    },
  });
  const { views, taxLineText, drawers } = editing;
  const searching = () => query().trim() !== "";
  const groups = createMemo(() => groupAccounts(searchAccounts(views(), query(), taxLineText)));
  // What is open: a kind the person opened or shut in this visit is as they left it; any other is open
  // when it is income or expenses that hold something.
  const [touched, setTouched] = createSignal<Touched>(readTouched());
  const open = () => {
    const atRest = openAtRest(groups());
    return groups()
      .map((group) => group.id)
      .filter((id) => touched()[id] ?? atRest.includes(id));
  };
  const toggle = (id: ChartGroupId, isOpen: boolean) => {
    const next = { ...touched(), [id]: isOpen };
    setTouched(next);
    writeTouched(next);
  };
  // The kinds that list their accounts with nothing in them too: asked for under the kind, and opened for
  // an account that was just added, so that it is seen where it now lives.
  const [full, setFull] = createSignal<readonly ChartGroupId[]>([]);
  const showFull = (id: ChartGroupId, isFull: boolean) =>
    setFull(isFull ? [...new Set([...full(), id])] : full().filter((kind) => kind !== id));

  const registerHref = (account: AccountView) =>
    `/ledger?accountId=${encodeURIComponent(account.id)}`;

  // "/" jumps to the search box, as it does in the Transactions list; never while typing or in a dialog.
  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable], [role=dialog]")) return;
      if (!editing.idle()) return;
      event.preventDefault();
      searchBox?.focus();
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });

  // The addresses "+ New" and Search send people to: `?new=1` opens the new-account drawer, `?account=<id>`
  // opens that account's transactions. The query is taken out of the address as it is used.
  onMount(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.get("new") === "1") {
      const url = new URL(window.location.href);
      url.searchParams.delete("new");
      window.history.replaceState(window.history.state, "", url);
      const open = () => {
        if (chart.value()) drawers.openNew(NEW_BUTTON_ID);
        else setTimeout(open, 50);
      };
      open();
    }
    const account = query.get("account");
    if (account) router.history.replace(`/ledger?accountId=${encodeURIComponent(account)}`);
  });

  return (
    <section class="app-accounts rt-acct-page" aria-labelledby="accounts-title">
      <PageHeader
        titleId="accounts-title"
        title={w.title}
        actions={
          <>
            <Button
              id={NEW_BUTTON_ID}
              variant={connectBankPath() === null ? "primary" : "secondary"}
              label={w.newAccount}
              disabled={chart.value() === undefined}
              onClick={() => drawers.openNew(NEW_BUTTON_ID)}
            />
            <Show when={connectBankPath()}>
              {(href) => (
                <a {...buttonAttrs({ variant: "primary" })} href={href()}>
                  {w.connectBank}
                </a>
              )}
            </Show>
          </>
        }
      />
      <editing.Notices />
      <Loading
        ready={chart.value() !== undefined || chart.error() !== undefined}
        shape="table"
        label={w.loading}
      >
        <Show
          when={chart.error() === undefined}
          fallback={
            <Notice title={w.failedTitle} tone="problem" role="alert">
              <p>{w.failedBody}</p>
              <Button variant="secondary" label={w.retry} onClick={() => void chart.reload()} />
            </Notice>
          }
        >
          <Show
            when={chart.value()}
            fallback={
              <Notice title={w.noBookTitle}>
                <p>{w.noBookBody}</p>
              </Notice>
            }
          >
            {(data) => (
              <>
                <Show when={banking.state() !== "ready" || bankRows().length > 0}>
                  <section class="rt-accounts-section" aria-labelledby="accounts-bank-title">
                    <div class="rt-accounts-section-head">
                      <h2 id="accounts-bank-title" class="rt-accounts-section-title">
                        {w.bankAndCards}
                      </h2>
                    </div>
                    <BankRows
                      label={w.bankAndCards}
                      tiles={bankRows()}
                      state={banking.state()}
                      stale={banking.stale()}
                      links={bankTileLinks}
                      onReconcile={(tile: BankTileData) =>
                        setReconciling({ open: true, account: tile.accountId })
                      }
                      onRetry={() => void banking.reload()}
                    />
                  </section>
                </Show>
                <section class="rt-accounts-section" aria-labelledby="accounts-chart-title">
                  <div class="rt-accounts-section-head">
                    <h2 id="accounts-chart-title" class="rt-accounts-section-title">
                      {w.chart}
                    </h2>
                    <ListSearch
                      label={chartMessages.accounts.search}
                      placeholder={chartMessages.accounts.search}
                      hint={chartMessages.accounts.searchHint}
                      keyshortcuts="/"
                      value={query()}
                      onInput={setQuery}
                      inputRef={(element) => {
                        searchBox = element;
                      }}
                    />
                  </div>
                  <Show
                    when={groups().length > 0}
                    fallback={
                      <Notice title={w.empty.title} role="status">
                        <p>{w.empty.body}</p>
                      </Notice>
                    }
                  >
                    <ChartGroups
                      groups={groups()}
                      total={(group) => sumMoney(group.accounts.map((account) => account.balance))}
                      open={open()}
                      onToggle={toggle}
                      full={full()}
                      onFull={showFull}
                      searching={searching()}
                      accountHref={registerHref}
                    />
                  </Show>
                </section>
                <div class="rt-chart-details">
                  <Details summary={w.details}>
                    <DetailsList
                      items={[
                        {
                          label: w.chartRevision,
                          value: String(data().configurationRevision),
                          mono: true,
                        },
                        ...(data().tagsAsOf
                          ? [{ label: w.tagsInForce, value: formatDate(data().tagsAsOf as string) }]
                          : []),
                      ]}
                    />
                  </Details>
                </div>
              </>
            )}
          </Show>
        </Show>
      </Loading>
      <StartReconciliation
        open={reconciling().open}
        account={reconciling().account || undefined}
        onClose={() => {
          const account = reconciling().account;
          setReconciling({ open: false, account: "" });
          if (account) document.getElementById(bankReconcileId(account))?.focus();
        }}
      />
      <editing.Dialogs />
    </section>
  );
}
