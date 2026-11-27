import {
  BankAccounts,
  type BankAccountLine,
  type BankGroup,
  bankWords,
  Button,
  buttonAttrs,
  DateField,
  DateValue,
  Dialog,
  DialogClose,
  Notice,
  PageHeader,
  PageSkeleton,
  SelectField,
} from "@rastrata/ui";
import { formatInstant } from "@rastrata/ui/format";
import {
  type Accessor,
  createMemo,
  createEffect,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { AppLink } from "../../app-link";
import { BrowserApplicationClient } from "../../application-client";
import {
  type BankRow,
  type BanksController as Controller,
  BanksController,
  type BanksState,
  type BanksView,
  type BookCalls,
  NEW_ACCOUNT,
} from "../../banks-controller";
import { currentAccount } from "../../boot";
import { createLoader } from "../../loader";
import { createBankAccount } from "../accounting/create-bank-account";
import { bankingSummary } from "../ingest/summary";
import { banksWords as words } from "./words";

/** The book's side of the page: the reads and writes of the application. A write is kept in the browser until the service has answered it, so that a reply that is lost can be resumed. */
function bookCalls(client: BrowserApplicationClient): BookCalls {
  return {
    status: (fresh) => client.read("banks.status", {}, fresh ? { fresh: true } : {}),
    chart: async () => (await client.read("accounts.list", {})).accounts,
    book: (input) => client.write("banks.book", input, `banks:book:${input.account}`),
    unbook: (account) => client.write("banks.unbook", { account }, `banks:unbook:${account}`),
    // The account the bank names is made the normal way (a prepared plan, its commit, its tags) before the booking.
    createAccount: async (input) => {
      const made = await createBankAccount(
        client,
        await client.read("accounts.list", {}),
        input,
        `banks:create:${input.account}`,
      );
      return { id: made.account.id, warnings: made.warnings };
    },
  };
}

/** Bank accounts: which bank accounts feed the books, and the two ways to bring transactions in. A bank that is
 * connected asks nothing: its accounts are added to the books and read from the day the books start (the
 * controller's `settle`). A row asks one yes-or-no only where the books already hold an account it could be. The
 * look and the rules are docs/reference/design-language.md. It exists only where the service can connect a bank; a
 * page opened by its address elsewhere says so. */
export function BanksPage() {
  const account = currentAccount();
  return (
    <section aria-labelledby="banks-title">
      <Show
        when={account}
        fallback={
          <>
            <PageHeader titleId="banks-title" title={bankWords.title} />
            <Notice title={words.notHere} tone="info">
              <p>{words.notHereBody}</p>
            </Notice>
          </>
        }
      >
        {(present) => {
          const client = new BrowserApplicationClient(window.localStorage);
          // Made once: the page talks to the one controller it listens to.
          const controller = new BanksController({
            control: present(),
            book: bookCalls(client),
            go: (path) => window.location.assign(path),
          });
          return <BanksBody controller={controller} client={client} />;
        }}
      </Show>
    </section>
  );
}

function BanksBody(props: {
  readonly controller: Controller;
  readonly client: BrowserApplicationClient;
}) {
  const [state, setState] = createSignal<BanksState>(props.controller.state);
  const unsubscribe = props.controller.subscribe(setState);
  onCleanup(unsubscribe);
  // The page is read, and then whatever was just connected and needs no answer is put in the books.
  onMount(() => void props.controller.load().then(() => props.controller.settle()));
  const view = createMemo<BanksView | null>(() => {
    const current = state();
    return current.step === "ready" ? current.view : null;
  });
  const problem = () => {
    const current = state();
    return current.step === "problem" ? current.message : null;
  };

  // An account that is booked and has had nothing yet is waiting for the bank's first answer: look again every few seconds.
  createEffect(() => {
    const waiting = view()?.rows.some(
      (row) => row.state === "active" && row.booking !== null && row.lastReceivedAt === null,
    );
    if (!waiting) return;
    const timer = setTimeout(() => void props.controller.refresh(), 4000);
    onCleanup(() => clearTimeout(timer));
  });

  return (
    <>
      <Show when={state().step === "loading"}>
        <PageHeader titleId="banks-title" title={bankWords.title} />
        <PageSkeleton shape="table" label={words.loading} />
      </Show>
      <Show when={problem()}>
        {(message) => (
          <>
            <PageHeader titleId="banks-title" title={bankWords.title} />
            <Notice title={words.failed} tone="problem" role="alert">
              <p>{message()}</p>
              <Button
                variant="secondary"
                label={words.retry}
                onClick={() => void props.controller.load()}
              />
            </Notice>
          </>
        )}
      </Show>
      <Show when={view()}>
        {(ready) => <Ready view={ready} controller={props.controller} client={props.client} />}
      </Show>
    </>
  );
}

/** The rows of one bank as the page draws them. */
function groupsOf(
  view: BanksView,
  tiles: ReturnType<ReturnType<typeof bankingSummary>["tiles"]>,
  act: {
    readonly answer: (row: BankRow, choice: string) => void;
    readonly change: (row: BankRow) => void;
    readonly disconnect: (row: BankRow) => void;
    readonly reconnect: () => void;
  },
): BankGroup[] {
  const byBank = new Map<string, BankRow[]>();
  for (const row of view.rows)
    byBank.set(row.institution, [...(byBank.get(row.institution) ?? []), row]);
  return [...byBank].map(([institution, rows]) => {
    const stopped = rows.find((row) => row.state === "inactive");
    const last = rows
      .map((row) => row.lastReceivedAt)
      .filter((at): at is string => at !== null)
      .sort()
      .at(-1);
    const accounts: BankAccountLine[] = rows.map((row) => {
      const tile = tiles.find((item) => item.accountId === row.ledgerAccountId);
      const first = row.candidates[0];
      return {
        id: row.id,
        name: row.name,
        ending: row.ending,
        ...(row.state === "disconnected" ? { note: bankWords.disconnected } : {}),
        ledger:
          row.booking && row.ledgerAccountId
            ? {
                label: tile?.name ?? row.booking.account,
                href: `/ledger?accountId=${encodeURIComponent(row.ledgerAccountId)}`,
              }
            : null,
        review:
          row.ledgerAccountId && tile
            ? {
                count: tile.toReview,
                href: `/inbox?account=${encodeURIComponent(row.ledgerAccountId)}`,
              }
            : null,
        balance: tile?.bookBalance ?? null,
        ...(row.canBook && first
          ? {
              question: {
                account: first.label,
                onYes: () => act.answer(row, first.value),
                onNo: () => act.answer(row, NEW_ACCOUNT),
              },
            }
          : {}),
        actions: [
          ...(row.canUnbook
            ? [{ id: "change", label: bankWords.actions.change, onSelect: () => act.change(row) }]
            : []),
          ...(row.canDisconnect
            ? [
                {
                  id: "disconnect",
                  label: bankWords.actions.disconnect,
                  onSelect: () => act.disconnect(row),
                },
              ]
            : []),
        ],
      };
    });
    return {
      institution,
      dateline: last
        ? (stopped ? bankWords.lastUpdated : bankWords.updated)(formatInstant(last))
        : rows.some((row) => row.booking !== null && row.state === "active")
          ? bankWords.waiting
          : null,
      ...(stopped
        ? {
            attention: {
              text: bankWords.signInAgain,
              ...(stopped.canReconnect
                ? { action: { label: bankWords.signIn(institution), onSelect: act.reconnect } }
                : {}),
            },
          }
        : {}),
      accounts,
    };
  });
}

function Ready(props: {
  readonly view: Accessor<BanksView>;
  readonly controller: Controller;
  readonly client: BrowserApplicationClient;
}) {
  const view = props.view;
  const [busy, setBusy] = createSignal(false);
  const [asking, setAsking] = createSignal<BankRow | null>(null);
  const [changing, setChanging] = createSignal<BankRow | null>(null);
  const [choice, setChoice] = createSignal("");
  const [startOn, setStartOn] = createSignal("");
  const banking = bankingSummary();
  onMount(() => void banking.reload(2_000));
  const book = createLoader(() => props.client.read("book.get", {}));
  const currency = () => book.value()?.setup?.currency ?? "USD";

  async function act(work: () => Promise<unknown>) {
    if (busy()) return;
    setBusy(true);
    try {
      await work();
      await banking.reload(0);
    } finally {
      setBusy(false);
    }
  }
  const groups = createMemo(() =>
    groupsOf(view(), banking.tiles(), {
      answer: (row, chosen) => void act(() => props.controller.book(row.id, chosen, "")),
      change: (row) => {
        setChoice(row.ledgerAccountId ?? "");
        setStartOn(row.booking?.startOn ?? "");
        setChanging(row);
      },
      disconnect: (row) => setAsking(row),
      reconnect: () => props.controller.connect(),
    }),
  );
  const changeItems = (row: BankRow) => [
    { value: NEW_ACCOUNT, label: bankWords.newAccount(row.newAccount.name) },
    ...row.options,
  ];

  return (
    <>
      <Show when={view().error}>
        {(message) => <Notice title={message()} tone="problem" role="alert" />}
      </Show>
      <Show when={!view().error && view().notice}>
        {(message) => <Notice title={message()} tone="calm" role="status" />}
      </Show>
      <Show when={view().notes.length > 0}>
        <Notice title={words.notes} tone="info">
          <For each={view().notes}>{(note) => <p>{note}</p>}</For>
        </Notice>
      </Show>

      <BankAccounts
        titleId="banks-title"
        groups={groups()}
        currency={currency()}
        busy={busy()}
        emptyText={view().role === "owner" && !view().canConnect ? words.unavailable : undefined}
        onConnect={
          view().canConnect && !view().atLimit ? () => props.controller.connect() : undefined
        }
        onImport={() => window.location.assign("/import")}
        renderLink={(href, children, label) => (
          <AppLink href={href} {...(label ? { "aria-label": label } : {})}>
            {children}
          </AppLink>
        )}
      />
      <Show when={view().canConnect && view().atLimit}>
        <p>{words.atLimit(view().limit ?? 0)}</p>
      </Show>

      <Show when={view().heldCount > 0}>
        <Notice title={words.heldTitle} tone="info">
          <p>{words.heldBody}</p>
          <ul class="banks-held">
            <For each={view().held}>
              {(item) => (
                <li>
                  <Show when={item.postedOn}>
                    {(on) => (
                      <>
                        <DateValue value={on()} /> ·{" "}
                      </>
                    )}
                  </Show>
                  {item.reason}
                </li>
              )}
            </For>
          </ul>
        </Notice>
      </Show>

      <Show when={changing()}>
        {(row) => (
          <Dialog
            open={true}
            title={bankWords.change.title(`${row().institution} ${row().name}`)}
            onOpenChange={(open) => {
              if (!open) setChanging(null);
            }}
            footer={
              <>
                <DialogClose {...buttonAttrs({ variant: "secondary" })}>
                  {bankWords.change.cancel}
                </DialogClose>
                <Button
                  label={bankWords.change.save}
                  pending={busy()}
                  disabled={choice() === ""}
                  onClick={() =>
                    void act(async () => {
                      await props.controller.change(row().id, choice(), startOn());
                      setChanging(null);
                    })
                  }
                />
              </>
            }
          >
            <div class="banks-change">
              <SelectField
                label={bankWords.change.account}
                items={changeItems(row())}
                value={choice()}
                onChange={setChoice}
              />
              <DateField label={bankWords.change.from} value={startOn()} onChange={setStartOn} />
            </div>
          </Dialog>
        )}
      </Show>

      <Show when={asking()}>
        {(row) => (
          <Dialog
            open={true}
            role="alertdialog"
            title={words.disconnectTitle(`${row().institution} ${row().name}`)}
            description={words.disconnectBody}
            onOpenChange={(open) => {
              if (!open) setAsking(null);
            }}
            footer={
              <>
                <DialogClose {...buttonAttrs({ variant: "secondary" })}>{words.keep}</DialogClose>
                <Button
                  label={words.disconnect}
                  pending={busy()}
                  onClick={() =>
                    void act(async () => {
                      await props.controller.disconnect(row().id);
                      setAsking(null);
                    })
                  }
                />
              </>
            }
          />
        )}
      </Show>
    </>
  );
}
