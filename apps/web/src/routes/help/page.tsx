import {
  Button,
  IndexList,
  type IndexLinkProps,
  Loading,
  Notice,
  PageHeader,
  Prose,
  ProseCode,
} from "@rastrata/ui";
import { useLocation, useParams } from "@tanstack/solid-router";
import { createEffect, createMemo, For, type JSX, on, Show } from "solid-js";
import { AppLink, useGoTo } from "../../app-link";
import { createKeyedLoader } from "../../loader";
import { helpAudience } from "./audience";
import { type HelpDocument, helpContentPath, topicFor, topicsByGroup } from "./topics";

const words = {
  title: "Help",
  loading: "Loading this topic",
  missingTitle: "There is no such topic",
  missingBody: "It may have been renamed. Every topic is in the list.",
  all: "See every topic",
  failedTitle: "This topic could not be opened",
  failedBody: "Nothing was changed. Try again in a moment.",
  retry: "Try again",
};

const link = (props: IndexLinkProps): JSX.Element => <AppLink {...props} />;

/** Help: every topic, under the place it belongs to. One link a row and nothing else on the page. */
export function HelpPage() {
  const groups = topicsByGroup(helpAudience());
  return (
    <section class="app-help" aria-labelledby="help-title">
      <PageHeader titleId="help-title" title={words.title} />
      <div class="rt-index-groups">
        <For each={groups}>
          {(group) => (
            <section aria-labelledby={`help-${group.id}`}>
              <h2 id={`help-${group.id}`} class="rt-index-groups-title">
                {group.label}
              </h2>
              <IndexList
                label={group.label}
                link={link}
                entries={group.topics.map((topic) => ({
                  label: topic.title,
                  href: `/help/${topic.id}`,
                }))}
              />
            </section>
          )}
        </For>
      </div>
    </section>
  );
}

/** A topic as the build wrote it for these readers. */
async function readTopic(path: string): Promise<HelpDocument> {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Help answered ${response.status}`);
  return (await response.json()) as HelpDocument;
}

/** One topic of Help: its name, the way back to the list, and the how-to itself, read when it is opened.
 * The name is known before the text arrives, so the page is never another page first; a topic that does
 * not exist says so and offers the list. */
export function HelpTopicPage() {
  const params = useParams({ strict: false }) as () => { topic?: string };
  const location = useLocation();
  const go = useGoTo();
  const topic = createMemo(() => topicFor(params().topic ?? "", helpAudience()));
  const content = createKeyedLoader(
    () => {
      const found = topic();
      return found ? helpContentPath(found.id, helpAudience()) : undefined;
    },
    (path) => readTopic(path),
  );
  // A link to one heading of a topic ("…#all-transactions") lands on it once the text is on the page.
  createEffect(
    on(
      () => [content.value(), location().hash] as const,
      ([document, hash]) => {
        if (!document || !hash) return;
        queueMicrotask(() =>
          window.document.getElementById(decodeURIComponent(hash))?.scrollIntoView(),
        );
      },
    ),
  );
  return (
    <section class="app-help" aria-labelledby="help-title">
      <Show
        when={topic()}
        fallback={
          <>
            <PageHeader titleId="help-title" title={words.missingTitle} />
            <Notice title={words.missingBody} role="status">
              <AppLink href="/help">{words.all}</AppLink>
            </Notice>
          </>
        }
      >
        {(found) => (
          <>
            <PageHeader titleId="help-title" title={found().title} />
            <Loading
              ready={content.value() !== undefined || content.error() !== undefined}
              shape="page"
              label={words.loading}
            >
              <Show
                when={content.value()}
                fallback={
                  <Notice title={words.failedTitle} tone="problem" role="alert">
                    <p>{words.failedBody}</p>
                    <Button
                      variant="secondary"
                      label={words.retry}
                      onClick={() => void content.reload()}
                    />
                  </Notice>
                }
              >
                {(document) => (
                  <article class="rt-prose-page">
                    <For each={document().blocks}>
                      {(block) =>
                        block.kind === "code" ? (
                          <ProseCode text={block.text} />
                        ) : (
                          <Prose html={block.html} onNavigate={go} />
                        )
                      }
                    </For>
                  </article>
                )}
              </Show>
            </Loading>
          </>
        )}
      </Show>
    </section>
  );
}
