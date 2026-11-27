import { children, type JSX, Show } from "solid-js";
import { ChevronLeft } from "./icons";
import { shellWords } from "./shell-words";

export type PageHeaderProps = {
  /** The page's one heading. Say what the page is ("Transactions"), not what it does. */
  title: JSX.Element;
  /** One line under the title, where the title alone does not say what the page is for. Anything longer
   * belongs in the page's how-to, which the footer's Help link opens: a page has no explanation of itself. */
  description?: JSX.Element;
  /** The page's main buttons and links, beside the title. */
  actions?: JSX.Element;
  /** A state of the page's subject ("Draft", "Posted"), never a category or a place. */
  status?: JSX.Element;
  /** A way back to where a figure was opened from (an account's lines, back to the report). Never the page's
   * parent: the bar or the Settings list already marks it, and choosing it there goes back (the founder,
   * 2026-11-18: the "Back to ..." line above every title "is annoying"). */
  back?: { readonly label: string; readonly href: string };
  /** `home` is the larger "Today". */
  size?: "page" | "home";
  /** The title's id, for a page that points `aria-labelledby` at it. */
  titleId?: string;
  /** Takes the title element, so the page can move focus to it when it opens (a screen reader then
   * starts at the title). The title is focusable by script only and draws no ring. */
  titleRef?: (element: HTMLHeadingElement) => void;
  /** Rewords the back link. */
  backLabel?: (label: string) => string;
};

/**
 * The top of every page: a title in the heavy display face (32 px; Home 56 px), one line of description,
 * the page's main actions at the right of the title, and a state chip when the subject has a state. There
 * is no explanation of the page on the page (the footer's Help opens its how-to), and no eyebrow: the
 * place in the bar already says where you are.
 */
export function PageHeader(props: PageHeaderProps): JSX.Element {
  const backLabel = () => (props.backLabel ?? shellWords.back.to)(props.back?.label ?? "");
  // Each of these is read for two things (is there one, and what is it), so each is made once: a page
  // that hands in a `<Show>` does not build its button twice.
  const description = children(() => props.description);
  const status = children(() => props.status);
  const actions = children(() => props.actions);
  return (
    <header
      class="rt-page-header"
      data-size={props.size ?? "page"}
      data-description={description() ? "" : undefined}
    >
      <Show when={props.back}>
        {(back) => (
          <a class="rt-page-back" href={back().href}>
            <ChevronLeft aria-hidden="true" class="rt-dir-icon" />
            {backLabel()}
          </a>
        )}
      </Show>
      <div class="rt-page-title-row">
        <h1
          class="rt-page-title"
          id={props.titleId}
          tabindex="-1"
          ref={(element) => props.titleRef?.(element)}
        >
          {props.title}
        </h1>
        <Show when={status()}>
          <span class="rt-page-status">{status()}</span>
        </Show>
      </div>
      <Show when={description()}>
        <p class="rt-page-description">{description()}</p>
      </Show>
      <Show when={actions()}>
        <div class="rt-page-actions">{actions()}</div>
      </Show>
    </header>
  );
}
