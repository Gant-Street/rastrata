import { For, Show } from "solid-js";
import { useUi } from "./locale";

export type Crumb = { label: string; href?: string };

/** Where you are: ancestors link back, the last item is the current page. */
export function Breadcrumbs(props: { items: readonly Crumb[]; label?: string }) {
  const ui = useUi();
  return (
    <nav class="rt-breadcrumbs" aria-label={props.label ?? ui.messages.breadcrumbs.label}>
      <ol>
        <For each={props.items}>
          {(item, index) => (
            <li>
              <Show
                when={index() === props.items.length - 1 || !item.href}
                fallback={<a href={item.href}>{item.label}</a>}
              >
                <span aria-current={index() === props.items.length - 1 ? "page" : undefined}>
                  {item.label}
                </span>
              </Show>
            </li>
          )}
        </For>
      </ol>
    </nav>
  );
}
