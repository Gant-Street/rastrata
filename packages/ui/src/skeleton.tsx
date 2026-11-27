import {
  createEffect,
  createSignal,
  For,
  type JSX,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
} from "solid-js";

/** The shapes a loading page can take, each the outline of what arrives. `page`: a heading, cards and a list (Home).
 * `cards`: a stack of choices (a step that offers some). `table`: a row of filters over a table (Transactions and
 * the other lists). `report`: tabs, a toolbar and a statement's rows, a label on the left and a figure on the right.
 * `statement`: the statement alone, under tabs and a toolbar that are already on screen. `form`: labels and fields
 * (a setting, an entry, a rule). `tiles`: a row of cards (the bank accounts on Home). `chart`: one block where a chart
 * will be (money in and out). */
export type SkeletonShape =
  | "page"
  | "cards"
  | "table"
  | "report"
  | "statement"
  | "form"
  | "tiles"
  | "chart";

/** How long a read may take before anything is drawn: a page that is quick shows no flash. */
const DELAY_MS = 200;
/** Once drawn, how long the outline stays at the least, so it never flickers on and off. */
const HOLD_MS = 500;

const blocks = (count: number, render: (index: number) => JSX.Element) => (
  <For each={Array.from({ length: count }, (_, index) => index)}>{render}</For>
);

/** A statement's title, then its rows: an account's name on the left and its figure on the right. */
function StatementRows() {
  return (
    <>
      <div class="rt-skeleton rt-skeleton-title" style={{ width: "35%" }} />
      {blocks(7, (index) => (
        <div class="rt-skeleton-tr">
          <div
            class="rt-skeleton rt-skeleton-cell"
            style={{ width: `${[30, 22, 36, 26, 18, 32, 24][index]}%` }}
          />
          <div class="rt-skeleton rt-skeleton-cell rt-skeleton-figure" />
        </div>
      ))}
    </>
  );
}

function Outline(props: { shape: SkeletonShape }) {
  return (
    <Switch
      fallback={
        <div class="rt-page-skeleton-body" aria-hidden="true">
          <div class="rt-skeleton rt-skeleton-title" style={{ width: "30%" }} />
          <div class="rt-skeleton rt-skeleton-line" style={{ width: "45%" }} />
          <div class="rt-page-skeleton-cards">
            {blocks(3, () => (
              <div class="rt-skeleton rt-skeleton-card" />
            ))}
          </div>
          {blocks(4, () => (
            <div class="rt-skeleton rt-skeleton-row" />
          ))}
        </div>
      }
    >
      <Match when={props.shape === "cards"}>
        <div class="rt-page-skeleton-body" aria-hidden="true">
          {blocks(4, () => (
            <div class="rt-skeleton rt-skeleton-choice" />
          ))}
        </div>
      </Match>
      <Match when={props.shape === "table"}>
        <div class="rt-page-skeleton-body rt-skeleton-table" aria-hidden="true">
          <div class="rt-skeleton-toolbar">
            {blocks(5, () => (
              <div class="rt-skeleton rt-skeleton-field" />
            ))}
          </div>
          {blocks(8, (index) => (
            <div class="rt-skeleton-tr">
              <div class="rt-skeleton rt-skeleton-cell" style={{ width: "6rem" }} />
              <div
                class="rt-skeleton rt-skeleton-cell"
                style={{ width: `${[52, 38, 60, 44][index % 4]}%` }}
              />
              <div class="rt-skeleton rt-skeleton-cell rt-skeleton-figure" />
            </div>
          ))}
        </div>
      </Match>
      <Match when={props.shape === "report"}>
        <div class="rt-page-skeleton-body rt-skeleton-report" aria-hidden="true">
          <div class="rt-skeleton-tabs">
            {blocks(5, () => (
              <div class="rt-skeleton rt-skeleton-tab" />
            ))}
          </div>
          <div class="rt-skeleton-toolbar">
            {blocks(3, () => (
              <div class="rt-skeleton rt-skeleton-field" />
            ))}
          </div>
          <StatementRows />
        </div>
      </Match>
      <Match when={props.shape === "form"}>
        <div class="rt-page-skeleton-body rt-skeleton-form" aria-hidden="true">
          {blocks(4, (index) => (
            <div class="rt-skeleton-labelled">
              <div
                class="rt-skeleton rt-skeleton-label"
                style={{ width: `${[7, 9, 6, 8][index]}rem` }}
              />
              <div class="rt-skeleton rt-skeleton-input" />
            </div>
          ))}
        </div>
      </Match>
      <Match when={props.shape === "tiles"}>
        <div class="rt-page-skeleton-body" aria-hidden="true">
          <div class="rt-page-skeleton-cards">
            {blocks(3, () => (
              <div class="rt-skeleton rt-skeleton-card" />
            ))}
          </div>
        </div>
      </Match>
      <Match when={props.shape === "chart"}>
        <div class="rt-page-skeleton-body" aria-hidden="true">
          <div class="rt-skeleton rt-skeleton-chart" />
        </div>
      </Match>
      <Match when={props.shape === "statement"}>
        <div class="rt-page-skeleton-body rt-skeleton-report" aria-hidden="true">
          <StatementRows />
        </div>
      </Match>
    </Switch>
  );
}

/** A page's shape while it loads: grey blocks where its parts will be, so nothing jumps when they arrive. Ark has no
 * skeleton part, so this one is the design system's own. It waits a moment before it draws anything, and a screen
 * reader is told `label`. Use `Loading` around a page's content so that the outline also stays long enough not to
 * flicker; this one alone is for a fallback whose content decides for itself when to replace it. */
export function PageSkeleton(props: {
  /** What is being loaded, for a screen reader ("Opening your book…"). */
  label: string;
  /** How long to wait before drawing, in milliseconds. */
  delay?: number;
  shape?: SkeletonShape;
}) {
  const [shown, setShown] = createSignal(false);
  onMount(() => {
    const timer = setTimeout(() => setShown(true), props.delay ?? DELAY_MS);
    onCleanup(() => clearTimeout(timer));
  });
  return (
    <div class="rt-page-skeleton" role="status" aria-busy="true">
      <span class="rt-sr-only">{props.label}</span>
      <Show when={shown()}>
        <Outline shape={props.shape ?? "page"} />
      </Show>
    </div>
  );
}

/** A page's content once it is `ready`, and its outline until then, the conventional way: nothing for the first
 * moment (a quick read never flashes), then the outline, which once drawn stays at least half a second (it never
 * flickers). Once the content has shown it stays: a read again keeps what is on screen, as the loaders do. */
export function Loading(props: {
  ready: boolean;
  /** What is being loaded, for a screen reader ("Loading your transactions"). */
  label: string;
  shape?: SkeletonShape;
  children: JSX.Element;
}) {
  const [released, setReleased] = createSignal(untrack(() => props.ready));
  const [drawnAt, setDrawnAt] = createSignal<number | null>(null);
  let wait: ReturnType<typeof setTimeout> | undefined;
  let hold: ReturnType<typeof setTimeout> | undefined;
  onMount(() => {
    if (released()) return;
    wait = setTimeout(() => {
      if (!released()) setDrawnAt(performance.now());
    }, DELAY_MS);
  });
  createEffect(() => {
    if (!props.ready || released()) return;
    clearTimeout(wait);
    const at = drawnAt();
    const left = at === null ? 0 : HOLD_MS - (performance.now() - at);
    if (left <= 0) setReleased(true);
    else hold = setTimeout(() => setReleased(true), left);
  });
  onCleanup(() => {
    clearTimeout(wait);
    clearTimeout(hold);
  });
  return (
    <Show
      when={released()}
      fallback={
        <div class="rt-page-skeleton" role="status" aria-busy="true">
          <span class="rt-sr-only">{props.label}</span>
          <Show when={drawnAt() !== null}>
            <Outline shape={props.shape ?? "page"} />
          </Show>
        </div>
      }
    >
      {props.children}
    </Show>
  );
}
