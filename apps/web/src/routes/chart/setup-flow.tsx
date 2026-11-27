import type { ApplicationOutputs } from "@rastrata/application/client-contracts";
import {
  type BuiltChart,
  Button,
  type ChartAccount,
  type ChartRole,
  localToday,
  newKey,
  Notice,
  SetupWizard,
  type TaxFormChoice,
} from "@rastrata/ui";
import { createSignal, onMount, Show } from "solid-js";
import {
  ApplicationRequestError,
  BrowserApplicationClient,
  type PendingRequest,
} from "../../application-client";
import { currentAccount } from "../../boot";
import { capabilities } from "../../capabilities";
import { createLoader } from "../../loader";
import { openWorkspace } from "../../new-book";

type TemplateDetail = ApplicationOutputs["templates.get"];

const ROLES: readonly string[] = ["asset", "liability", "equity", "income", "expense"];

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "The request could not be completed.";

/** The retained `book.setup` request, if a reply was lost. Shared by the notice at the top of Home
 * (which must show even when the book already exists, because the write may have succeeded) and the
 * wizard (which steps aside while one is waiting). */
const [pendingSetup, setPendingSetup] = createSignal<PendingRequest | null>(null);

/** Read the retained request into the shared signal. Returns why it could not be read, or "". */
function syncPending(client: BrowserApplicationClient): string {
  try {
    setPendingSetup(client.pending("setup"));
    return "";
  } catch (cause) {
    return messageOf(cause);
  }
}

/** Tells the shell that a book now exists, so its header (only the wordmark before there is one) can show
 * the business name. The wizard creates the book without a navigation, so nothing else would. */
export function announceBook(): void {
  try {
    window.dispatchEvent(new CustomEvent("rastrata:book-created"));
  } catch {
    // Nothing is listening, which only means the header reads the book again on its own schedule.
  }
}

/** The wire chart as the editor holds it: rows with a key, and only the types this screen edits. */
function toChart(detail: TemplateDetail): BuiltChart {
  const accounts: ChartAccount[] = detail.accounts.map((account) => {
    if (!ROLES.includes(account.role))
      throw new Error(`The chart has an account type (${account.role}) this screen cannot edit.`);
    return {
      key: newKey(),
      code: account.code,
      name: account.name,
      role: account.role as ChartRole,
      tags: {
        ...(account.tags.cashFlowClass ? { cashFlowClass: account.tags.cashFlowClass } : {}),
        ...(account.tags.taxLine ? { taxLine: account.tags.taxLine } : {}),
        ...(account.tags.roleKey ? { roleKey: account.tags.roleKey } : {}),
        ...(account.tags.kind ? { kind: account.tags.kind } : {}),
      },
      ...(account.note ? { note: account.note } : {}),
    };
  });
  const taxForms: TaxFormChoice[] = detail.taxForms.map((form) => ({
    id: form.id,
    name: form.name,
    taxYear: form.taxYear,
    status: form.status,
    lines: form.lines.map((line) => ({
      id: line.id,
      number: line.number,
      label: line.label,
      part: line.part,
      roles: line.roles,
      ...(line.note ? { note: line.note } : {}),
    })),
  }));
  return {
    accounts,
    taxForms,
    taxYear: detail.taxYear,
    notes: detail.notes,
    disclaimer: detail.disclaimer,
  };
}

/**
 * A setup request whose reply was lost. The write may have succeeded, so this shows whether or not
 * a book exists, and the only way forward is to resume the exact request, never to send another.
 */
export function PendingSetup(props: { onResolved: () => unknown }) {
  const client = new BrowserApplicationClient(window.localStorage);
  const [busy, setBusy] = createSignal(false);
  const [problem, setProblem] = createSignal("");
  onMount(() => setProblem(syncPending(client)));

  async function resume(): Promise<void> {
    if (busy()) return;
    setBusy(true);
    setProblem("");
    try {
      await client.resume("setup");
      announceBook();
      await props.onResolved();
    } catch (cause) {
      setProblem(messageOf(cause));
    } finally {
      setProblem((current) => syncPending(client) || current);
      setBusy(false);
    }
  }

  return (
    <>
      <Show when={problem()}>
        <Notice title="Setup needs attention" tone="error" role="alert">
          {problem()}
        </Notice>
      </Show>
      <Show when={pendingSetup()}>
        <Notice title="A setup request is waiting" tone="review" role="status">
          <p>An original setup request is retained. Resume it before making another change.</p>
          <Button
            variant="secondary"
            label="Resume original request"
            disabled={busy()}
            onClick={() => void resume()}
          />
        </Notice>
      </Show>
    </>
  );
}

/** The setup choices (the types of business, the add-ons, the tax years), read once per page load. They are the same for
 * every book, so Home asks for them while it opens the book (`prefetchSetupChoices`) and a new book's first screen does
 * not wait for them; a read that failed is asked again. */
let early: Promise<ApplicationOutputs["templates.list"]> | undefined;
export function prefetchSetupChoices(): Promise<ApplicationOutputs["templates.list"]> {
  if (!early) {
    const asked = new BrowserApplicationClient(window.localStorage).read("templates.list", {});
    early = asked;
    asked.catch(() => {
      if (early === asked) early = undefined;
    });
  }
  return early;
}

/**
 * The first screen of a new book. It reads the templates from the application, lets the person
 * answer the wizard, and sends `book.setup` as one retained write: a lost reply leaves the exact
 * request saved (see `PendingSetup`), and the wizard steps aside until it is resumed.
 */
export function SetupFlow(props: { onCreated: () => unknown }) {
  const client = new BrowserApplicationClient(window.localStorage);
  // Held in plain signals (see loader.ts): reading the choices never suspends the page.
  const catalog = createLoader(prefetchSetupChoices);
  // On a service with accounts the workspace was just named, usually after the business: the business name
  // starts as that, and is changed here when it differs.
  const workspaceName = createLoader(async (): Promise<string | null> => {
    const account = currentAccount();
    const id = openWorkspace();
    if (!capabilities().accounts || !account || !id) return null;
    const list = await account.workspaces();
    return list.ok ? (list.value.find((item) => item.id === id)?.name ?? null) : null;
  });
  const [busy, setBusy] = createSignal(false);
  const [problem, setProblem] = createSignal("");
  const [failure, setFailure] = createSignal("");
  onMount(() => setProblem(syncPending(client)));

  async function create(document: Parameters<typeof client.write<"book.setup">>[1]): Promise<void> {
    if (busy()) return;
    setFailure("");
    setProblem("");
    setBusy(true);
    try {
      await client.write("book.setup", document, "setup");
      announceBook();
      await props.onCreated();
    } catch (cause) {
      // Another window or an earlier attempt already created a book: show the book, not a stale form.
      if (
        cause instanceof ApplicationRequestError &&
        cause.code === "book_configuration_conflict"
      ) {
        setProblem(cause.message);
        announceBook();
        await props.onCreated();
      } else setFailure(messageOf(cause));
    } finally {
      setProblem((current) => syncPending(client) || current);
      setBusy(false);
    }
  }

  return (
    <div class="setup-flow">
      <Show when={problem()}>
        <Notice title="Setup needs attention" tone="error" role="alert">
          {problem()}
        </Notice>
      </Show>
      <Show when={!pendingSetup()}>
        {/* The wizard opens at once: its first step needs none of the choices, and the step that offers them waits. */}
        <Show when={catalog.error() !== undefined}>
          <Notice title="The setup choices could not be loaded" tone="error" role="alert">
            <p>{messageOf(catalog.error())}</p>
            <Button variant="secondary" label="Try again" onClick={() => void catalog.reload()} />
          </Notice>
        </Show>
        <Show when={!workspaceName.loading()}>
          <SetupWizard
            headingLevel={1}
            initial={workspaceName.value() ? { name: workspaceName.value() as string } : {}}
            loading={catalog.value() === undefined}
            templates={(catalog.value()?.templates ?? []).map((template) => ({
              id: template.id,
              name: template.name,
            }))}
            addOns={catalog.value()?.addOns ?? []}
            taxYears={catalog.value()?.taxYears ?? []}
            defaultYear={Number(localToday().slice(0, 4))}
            loadChart={async (request) =>
              toChart(
                await client.read("templates.get", {
                  templateId: request.templateId,
                  basis: request.basis,
                  taxYear: request.taxYear,
                  addOns: [...request.addOns],
                }),
              )
            }
            onCreate={create}
            creating={busy()}
            error={failure()}
          />
        </Show>
      </Show>
    </div>
  );
}
