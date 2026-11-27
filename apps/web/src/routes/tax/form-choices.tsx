import { HelpTip, SelectField, taxWords, type TaxFormId } from "@rastrata/ui";
import { type Accessor, Show } from "solid-js";
import { type MealsPercent, TAX_FORMS } from "./controller";

const FORM_ITEMS: readonly { value: TaxFormId; label: string }[] = [
  { value: "scheduleC", label: taxWords.formScheduleC },
  { value: "form1120S", label: taxWords.form1120S },
  { value: "form1065", label: taxWords.form1065 },
];
const MEALS_ITEMS = [
  { value: "50", label: taxWords.meals50 },
  { value: "80", label: taxWords.meals80 },
] as const;

/** The two choices that decide what the worksheet and the year-end pack are built from: which form (the
 * one the book's tax-line tags point at until a person chooses another) and, for Schedule C, the share of
 * business meals that goes on line 24b. They sit in the row of choices beside the year, so the table comes
 * straight after them, and they are kept in the address. The pack is built from the same choices, which is
 * why they are not inside the worksheet's own tab. */
export function TaxFormChoices(props: {
  /** The form a person chose, or null for the one the book's tags point at. */
  form: Accessor<TaxFormId | null>;
  /** The form the book's tags point at, as the service says it. */
  defaultForm: Accessor<string | undefined>;
  meals: Accessor<MealsPercent>;
  onForm: (form: TaxFormId) => void;
  onMeals: (meals: MealsPercent) => void;
}) {
  const shownForm = (): TaxFormId => {
    const chosen = props.form();
    if (chosen) return chosen;
    const fallback = props.defaultForm();
    return TAX_FORMS.includes(fallback as TaxFormId) ? (fallback as TaxFormId) : "scheduleC";
  };
  return (
    <>
      <SelectField
        label={taxWords.formLabel}
        items={FORM_ITEMS}
        value={shownForm()}
        onChange={(value) => props.onForm(value as TaxFormId)}
      />
      <Show when={shownForm() === "scheduleC"}>
        <SelectField
          label={taxWords.mealsLabel}
          items={MEALS_ITEMS}
          value={String(props.meals())}
          onChange={(value) => props.onMeals(value === "80" ? 80 : 50)}
        />
        <HelpTip topic={taxWords.mealsLabel}>{taxWords.mealsHint}</HelpTip>
      </Show>
    </>
  );
}
