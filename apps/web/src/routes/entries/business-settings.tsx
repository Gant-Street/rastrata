import {
  BusinessSettingsForm,
  type BusinessValues,
  businessWords,
  Button,
  changesIn,
  formatDate,
  Notice,
  PageSkeleton,
} from "@rastrata/ui";
import { createMemo, createSignal, onMount, Show } from "solid-js";
import { ApplicationRequestError, BrowserApplicationClient } from "../../application-client";
import {
  bookSettings,
  businessName,
  bookSettingsUnreadable,
  readBookSettings,
  rememberBookUpdate,
} from "../../book-settings";
import { currentAccount } from "../../boot";
import { WORKSPACE_RENAMED_EVENT } from "../../standing";

/** One retained write at a time for this form. */
const WORKFLOW = "book-settings";

/** What the choices that need one look like, written by the same formatter every screen uses. The year-first
 * choice says what it is in words: a date written that way is the book's own form, and it is not shown as
 * text on a screen (it stays in exports, tooltips and `datetime`). */
const EXAMPLE_DAY = "2026-03-20";
const DATE_EXAMPLES = {
  medium: formatDate(EXAMPLE_DAY, { format: "medium" }),
  numeric: formatDate(EXAMPLE_DAY, { format: "numeric" }),
} as const;

/** Settings, Business: rename the business, how dates read, account numbers, and what accepting a
 * suggestion does. The reply to `book.update` becomes what every screen reads, so a change shows at once
 * (the header, the lists, Accept) without a reload. */
export function BusinessSettings() {
  const client = new BrowserApplicationClient(window.localStorage);
  const [pending, setPending] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const [error, setError] = createSignal("");
  const [uncertain, setUncertain] = createSignal(false);
  const [read, setRead] = createSignal(false);

  onMount(() => {
    void readBookSettings().then(() => setRead(true));
    try {
      setUncertain(client.pending(WORKFLOW) !== null);
    } catch {
      setUncertain(true);
    }
  });

  const saved = createMemo<BusinessValues | undefined>(() => {
    const name = businessName();
    return name === undefined ? undefined : { name, ...bookSettings() };
  });

  const finish = (result: Parameters<typeof rememberBookUpdate>[0]) => {
    rememberBookUpdate(result);
    setMessage(result.changed.length === 0 ? businessWords.nothingChanged : businessWords.saved);
    setUncertain(false);
    // Keep the control-plane workspace name in sync when a hosted business is renamed.
    if (result.changed.includes("name")) {
      const account = currentAccount();
      const id = account?.scope();
      if (account && id) {
        void account.renameWorkspace(id, result.name).then(() => {
          window.dispatchEvent(
            new CustomEvent(WORKSPACE_RENAMED_EVENT, { detail: { id, name: result.name } }),
          );
        });
      }
    }
  };

  async function save(values: BusinessValues) {
    const current = saved();
    if (!current || pending()) return;
    const changes = changesIn(current, values);
    if (Object.keys(changes).length === 0) {
      setMessage(businessWords.nothingChanged);
      return;
    }
    setPending(true);
    setError("");
    setMessage("");
    try {
      finish(await client.write("book.update", changes, WORKFLOW));
    } catch (cause) {
      if (cause instanceof ApplicationRequestError && cause.uncertain) setUncertain(true);
      setError(cause instanceof Error ? cause.message : businessWords.failed);
    } finally {
      setPending(false);
    }
  }

  async function resume() {
    if (pending()) return;
    setPending(true);
    setError("");
    try {
      const completion = await client.resume(WORKFLOW);
      if (completion.name === "book.update") finish(completion.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : businessWords.failed);
    } finally {
      setPending(false);
    }
  }

  return (
    <section class="rt-settings-block" aria-labelledby="business-preferences">
      {/* The page's own title already says what this is; the heading is for a screen reader's outline, and
          it keeps the name field the first thing on the page. */}
      <h2 id="business-preferences" class="rt-sr-only">
        {businessWords.sectionTitle}
      </h2>
      <Show
        when={saved()}
        fallback={
          <Show
            when={read() && bookSettingsUnreadable()}
            fallback={<PageSkeleton shape="form" label={businessWords.loading} />}
          >
            <Notice title={businessWords.loadFailed} tone="error" role="alert">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                label={businessWords.retry}
                onClick={() => void readBookSettings({ again: true })}
              />
            </Notice>
          </Show>
        }
      >
        {(values) => (
          <BusinessSettingsForm
            saved={values()}
            dateExamples={DATE_EXAMPLES}
            pending={pending()}
            message={message() || undefined}
            error={error() || undefined}
            uncertain={uncertain()}
            onResume={() => void resume()}
            onSave={(next) => void save(next)}
          />
        )}
      </Show>
    </section>
  );
}
