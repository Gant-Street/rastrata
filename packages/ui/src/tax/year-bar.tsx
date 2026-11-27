import { createMemo, type JSX } from "solid-js";
import { SelectField } from "../select-field";
import { words } from "./words";

/** The year a person is looking at, with the choices that go with it on the same row. The year is chosen
 * from the years whose IRS forms and rules were verified; the service says which. A tax year is a calendar
 * year, so its dates are not said. */
export function TaxYearBar(props: {
  years: readonly number[];
  year: number;
  onYear: (year: number) => void;
  disabled?: boolean | undefined;
  children?: JSX.Element;
}) {
  const items = createMemo(() =>
    props.years.map((year) => ({ label: String(year), value: String(year) })),
  );
  return (
    <div class="rt-tax-yearbar">
      <div class="rt-tax-yearbar-controls">
        <SelectField
          label={words.yearLabel}
          items={items()}
          value={String(props.year)}
          disabled={props.disabled ?? false}
          onChange={(value) => {
            const year = Number(value);
            if (Number.isInteger(year) && year !== props.year) props.onYear(year);
          }}
        />
        {props.children}
      </div>
    </div>
  );
}
