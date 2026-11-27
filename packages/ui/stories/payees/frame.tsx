import { createSignal, type JSX } from "solid-js";
import {
  type DateRangeValue,
  PageHeader,
  PayeeControls,
  type PayeeDirection,
  payeesWords,
  UiProvider,
} from "../../src";

/** The page every payees story sits in: the product's own base styles and the page's own layout. The
 * theme comes from the toolbar (or `?globals=theme:dark`). */
export const Frame = (props: { children: JSX.Element; dir?: "rtl" | "ltr" }) => (
  <UiProvider>
    <main
      class="rt-theme app-payees"
      dir={props.dir ?? "ltr"}
      style={{ padding: "1rem", "max-width": "76rem" }}
    >
      {props.children}
    </main>
  </UiProvider>
);

/** The book's fiscal years and today, as the page reads them. */
export const calendar = {
  years: [{ year: 2026, startsOn: "2026-01-01", endsOn: "2026-12-31" }],
  today: "2026-10-17",
};

export const march: DateRangeValue = { preset: "custom", from: "2026-03-01", to: "2026-03-31" };

/** The whole page around a state of the report: its header, the choices above it and what is under them. */
export function Page(props: {
  children: JSX.Element;
  direction?: PayeeDirection;
  busy?: boolean;
  dir?: "rtl" | "ltr";
}) {
  const [range, setRange] = createSignal<DateRangeValue>(march);
  const [direction, setDirection] = createSignal<PayeeDirection>(props.direction ?? "both");
  return (
    <Frame dir={props.dir ?? "ltr"}>
      <PageHeader
        titleId="payees-title"
        title={payeesWords.title}
        description={payeesWords.description}
      />
      <PayeeControls
        calendar={calendar}
        range={range()}
        onRange={setRange}
        direction={direction()}
        onDirection={setDirection}
        disabled={props.busy ?? false}
      />
      {props.children}
    </Frame>
  );
}
