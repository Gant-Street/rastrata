import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onMount,
  Show,
  Switch,
  type JSX,
} from "solid-js";
import { createStore } from "solid-js/store";
import { Dynamic } from "solid-js/web";
import { Button } from "../button";
import { ErrorSummary } from "../error-summary";
import { Details } from "../kit/details";
import { Notice } from "../notice";
import { TextField } from "../text-field";
import {
  chartKey,
  clampTaxYear,
  fiscalYearSpan,
  formShortName,
  MAX_NAME,
  toSetupDocument,
} from "./chart-logic";
import { ChartPreview } from "./chart-preview";
import type {
  AddOnChoice,
  Basis,
  BuiltChart,
  ChartAccount,
  ChartProblem,
  Currency,
  SetupChoices,
  SetupDocument,
  TaxFormChoice,
  TemplateChoice,
} from "./chart-types";
import { SelectField } from "../select-field";
import { PageSkeleton } from "../skeleton";
import { ChoiceCards, ChoiceCheck } from "./choice-cards";
import { mergeChartMessages, type ChartMessageOverrides } from "./messages";
import { StepIndicator } from "./step-indicator";

export interface ChartRequest {
  readonly templateId: string;
  readonly basis: Basis;
  readonly taxYear: number;
  readonly addOns: readonly string[];
}

export interface SetupWizardProps {
  /** The types of business, the add-ons and the tax years, which the first step does not need: the wizard opens
   * while they load (`loading`), and the step that offers them waits for them. */
  templates: readonly TemplateChoice[];
  addOns: readonly AddOnChoice[];
  /** The tax years the verified catalog covers. */
  taxYears: readonly number[];
  /** The year offered as the first fiscal year: this year. */
  defaultYear: number;
  /** The setup choices (templates, add-ons, tax years) are still on their way. */
  loading?: boolean;
  /** Build the chart for the choices. A rejection is shown with a way to try again. */
  loadChart: (request: ChartRequest) => Promise<BuiltChart>;
  /** Create the book. The wizard stays on the review step; the parent reports progress through
   * `creating`, failure through `error`, and a lost reply through `uncertain`. */
  onCreate: (document: SetupDocument) => void | Promise<void>;
  creating?: boolean;
  /** Why the last attempt to create the book failed. */
  error?: string;
  /** A write whose reply was lost: the book may exist. Creating waits until it is resumed. */
  uncertain?: boolean;
  initial?: Partial<SetupChoices>;
  /** The level of the wizard's own title: 1 when it is the whole page (a new book's Home), else 2. */
  headingLevel?: 1 | 2;
  /** Start on a later step (stories and tests). */
  initialStep?: number;
  messages?: ChartMessageOverrides;
}

interface ChartState {
  status: "idle" | "loading" | "ready" | "error";
  key: string | null;
  accounts: ChartAccount[];
  taxForms: readonly TaxFormChoice[];
  taxYear: number | null;
  asked: number;
  notes: readonly string[];
  disclaimer: string;
  error: string;
}

const STEP_KEYS = ["business", "kind", "books", "review"] as const;

/**
 * The first screens of a new book: four short steps, then a book. Business, type of business,
 * accounting method, and a review: the choices, and the chart the template makes, folded under its
 * heading to be read, never edited here (an account is changed on the Chart of accounts once the books
 * exist). Nothing asks for bank accounts or cards: those are made from what the person brings, when they
 * connect a bank or import a statement. Every choice is explained where it is made, the two that cannot be
 * changed later (the basis and the currency) say so, and nothing is sent until the last step.
 *
 * The component owns the questions; the parent owns the network: it supplies
 * `loadChart` and `onCreate`, so the same wizard runs against the real application and in a story.
 */
export function SetupWizard(props: SetupWizardProps): JSX.Element {
  const m = createMemo(() => mergeChartMessages(props.messages));
  const [choices, setChoices] = createStore<SetupChoices>({
    name: "",
    currency: "USD",
    firstYear: props.defaultYear,
    startMonth: 1,
    periodModel: "monthly",
    basis: "cash",
    templateId: props.templates[0]?.id ?? "",
    addOns: [],
    ...props.initial,
  });
  const [step, setStep] = createSignal(props.initialStep ?? 0);
  const [problems, setProblems] = createSignal<ChartProblem[]>([]);
  const [attempt, setAttempt] = createSignal(0);
  const [chart, setChart] = createStore<ChartState>({
    status: "idle",
    key: null,
    accounts: [],
    taxForms: [],
    taxYear: null,
    asked: props.defaultYear,
    notes: [],
    disclaimer: "",
    error: "",
  });
  let heading: HTMLHeadingElement | undefined;
  let latest = 0;
  onMount(() => {
    // A story or test may open on a later step; the chart that step shows must exist.
    if (step() >= 3) void ensureChart();
  });

  createEffect(
    on(
      step,
      () => {
        queueMicrotask(() => heading?.focus());
      },
      { defer: true },
    ),
  );

  const titles = () => STEP_KEYS.map((key) => m().wizard.steps[key]);
  const errorFor = (id: string) => problems().find((problem) => problem.id === id)?.message ?? "";
  const addOn = (id: string) => choices.addOns.includes(id);
  const taxYear = () => clampTaxYear(choices.firstYear, props.taxYears);
  // The review is the summary and the Create book button. The chart is a long list, folded under its
  // heading for whoever wants to look.
  const [chartOpen, setChartOpen] = createSignal(false);
  // The choices arrived after the wizard opened: the first type of business is chosen, as it is when they are there from the start.
  createEffect(() => {
    const first = props.templates[0];
    if (choices.templateId === "" && first) setChoices("templateId", first.id);
  });

  async function ensureChart(): Promise<void> {
    const year = taxYear();
    const key = chartKey(choices, year);
    if (chart.key === key && chart.status === "ready") return;
    const token = ++latest;
    setChart({ status: "loading", error: "" });
    try {
      const built = await props.loadChart({
        templateId: choices.templateId,
        basis: choices.basis,
        taxYear: year,
        addOns: [...choices.addOns],
      });
      if (token !== latest) return;
      setChart({
        status: "ready",
        key,
        accounts: [...built.accounts],
        taxForms: built.taxForms,
        taxYear: built.taxYear,
        asked: choices.firstYear,
        notes: built.notes,
        disclaimer: built.disclaimer,
        error: "",
      });
    } catch (cause) {
      if (token !== latest) return;
      setChart({
        status: "error",
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  function check(index: number): ChartProblem[] {
    const found: ChartProblem[] = [];
    if (index === 0) {
      if (choices.name.trim() === "")
        found.push({ id: "wizard-name", message: m().business.nameRequired });
      else if (choices.name.trim().length < 2)
        found.push({ id: "wizard-name", message: m().business.nameShort });
      else if (choices.name.length > MAX_NAME)
        found.push({ id: "wizard-name", message: m().business.nameTooLong });
    }
    if (index === 1 && !props.templates.some((item) => item.id === choices.templateId))
      found.push({ id: "wizard-kind", message: m().kind.required });
    return found;
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const index = step();
    const found = check(index);
    setProblems(found);
    if (found.length > 0) {
      setAttempt((value) => value + 1);
      return;
    }
    if (index === 2) {
      setStep(3);
      void ensureChart();
      return;
    }
    if (index === 3) {
      if (props.creating || props.uncertain) return;
      try {
        await props.onCreate(toSetupDocument(choices, chart.accounts));
      } catch {
        // The parent reports the failure through `error`; the choices stay as they are.
      }
      return;
    }
    setStep(index + 1);
  }

  function back(): void {
    setProblems([]);
    setStep(Math.max(0, step() - 1));
  }

  const summary = () => {
    const span = fiscalYearSpan(choices.firstYear, choices.startMonth);
    const template = props.templates.find((item) => item.id === choices.templateId);
    const added = props.addOns.filter((item) => addOn(item.id)).map((item) => item.name);
    return [
      { key: "business", term: m().review.business, value: choices.name.trim() },
      {
        key: "currency",
        term: m().review.currency,
        value: m().business.currencyChoices[choices.currency] ?? choices.currency,
      },
      { key: "booksStart", term: m().review.booksStart, value: span.from },
      {
        key: "basis",
        term: m().review.basis,
        value: choices.basis === "cash" ? m().books.cash : m().books.accrual,
      },
      { key: "kind", term: m().review.kind, value: template?.name ?? "" },
      {
        key: "addOns",
        term: m().review.addOns,
        value: added.length > 0 ? added.join(", ") : m().review.none,
      },
    ] as const;
  };
  const primaryForm = () => chart.taxForms[0];
  /** The button that goes on from a step. On the review step it is Create book, at the foot after the
   * folded chart, so a keyboard reaches it in a few stops. */
  const submitButton = (last: boolean, id?: string): JSX.Element => (
    <Button
      type="submit"
      id={id}
      label={last ? m().wizard.create : m().wizard.continue}
      pending={last && props.creating === true}
      pendingLabel={m().wizard.creating}
      disabled={
        (step() === 1 && props.loading === true) ||
        (last && props.uncertain === true) ||
        (last && chart.status !== "ready")
      }
    />
  );

  // A refusal shows above the chart, which the foot's button leaves far off screen: bring it into view.
  createEffect(
    on(
      () => props.error,
      (error) => {
        if (error)
          queueMicrotask(() =>
            document.getElementById("wizard-create-failed")?.scrollIntoView({ block: "center" }),
          );
      },
      { defer: true },
    ),
  );

  const stepForm = (children: JSX.Element, last = false): JSX.Element => (
    <form class="rt-wizard-form" onSubmit={(event) => void submit(event)} noValidate>
      {/* Read to a screen reader, which is moved here at each step; on screen the steps above say the same. */}
      <h3
        class="rt-wizard-heading rt-sr-only"
        tabindex="-1"
        ref={(element) => {
          heading = element;
        }}
      >
        {m().wizard.stepOf(step() + 1, STEP_KEYS.length, titles()[step()] ?? "")}
      </h3>
      <Show when={problems().length > 0}>
        <ErrorSummary errors={problems()} attempt={attempt()} />
      </Show>
      {children}
      <div class="rt-wizard-actions">
        <Show when={step() > 0}>
          <Button id="wizard-back" variant="secondary" label={m().wizard.back} onClick={back} />
        </Show>
        {submitButton(last, last ? "wizard-create" : undefined)}
      </div>
    </form>
  );

  return (
    <section class="rt-wizard" aria-labelledby="wizard-title">
      <Dynamic
        component={props.headingLevel === 1 ? "h1" : "h2"}
        id="wizard-title"
        class="rt-wizard-title"
      >
        {m().wizard.title}
      </Dynamic>
      <StepIndicator
        steps={titles()}
        current={step()}
        label={m().wizard.stepsLabel}
        doneLabel="done"
      />
      <Switch>
        <Match when={step() === 0}>
          {stepForm(
            <div class="rt-stack">
              <TextField
                label={m().business.name}
                id="wizard-name"
                name="businessName"
                required
                autocomplete="organization"
                maxLength={200}
                hint={m().business.nameHint}
                error={errorFor("wizard-name")}
                value={choices.name}
                onInput={(event) => setChoices("name", event.currentTarget.value)}
              />
              <SelectField
                label={m().business.currency}
                id="wizard-currency"
                hint={m().business.currencyHint}
                value={choices.currency}
                items={Object.entries(m().business.currencyChoices).map(([value, label]) => ({
                  value,
                  label,
                }))}
                onChange={(value) => setChoices("currency", value as Currency)}
              />
            </div>,
          )}
        </Match>
        <Match when={step() === 1}>
          {stepForm(
            <div class="rt-stack">
              <Show when={props.loading}>
                <PageSkeleton shape="cards" label={m().kind.loading} />
              </Show>
              <Show when={!props.loading}>
                <ChoiceCards
                  legend={m().kind.legend}
                  help={m().kind.help}
                  name="template"
                  id="wizard-kind"
                  value={choices.templateId}
                  error={errorFor("wizard-kind")}
                  choices={props.templates.map((item) => ({ value: item.id, title: item.name }))}
                  onChange={(value) => setChoices("templateId", value)}
                />
              </Show>
              <Show when={!props.loading && props.addOns.length > 0}>
                <fieldset class="rt-choice-cards">
                  <legend class="rt-choice-cards-legend">{m().kind.addOnLegend}</legend>
                  <For each={props.addOns}>
                    {(item) => (
                      <ChoiceCheck
                        label={item.id === "online-business" ? m().kind.stripe : item.name}
                        {...(item.id === "online-business" ? {} : { hint: item.description })}
                        checked={addOn(item.id)}
                        onChange={(checked) =>
                          setChoices(
                            "addOns",
                            checked
                              ? [...choices.addOns, item.id]
                              : choices.addOns.filter((id) => id !== item.id),
                          )
                        }
                      />
                    )}
                  </For>
                </fieldset>
              </Show>
            </div>,
          )}
        </Match>
        <Match when={step() === 2}>
          {stepForm(
            <div class="rt-stack">
              <ChoiceCards
                legend={m().books.basisLegend}
                name="basis"
                id="wizard-basis"
                value={choices.basis}
                choices={[
                  { value: "cash", title: m().books.cash, description: m().books.cashHelp },
                  {
                    value: "accrual",
                    title: m().books.accrual,
                    description: m().books.accrualHelp,
                  },
                ]}
                onChange={(value) => setChoices("basis", value as Basis)}
              />
              <Notice title={m().books.basisWarningTitle} tone="review">
                {m().books.basisWarning}
              </Notice>
            </div>,
          )}
        </Match>
        <Match when={step() === 3}>
          {stepForm(
            <div class="rt-stack">
              <section aria-labelledby="wizard-summary">
                <h4 id="wizard-summary" class="rt-wizard-subheading">
                  {m().review.summaryHeading}
                </h4>
                <dl class="rt-wizard-summary">
                  <For each={summary()}>
                    {(row) => (
                      <div>
                        <dt>{row.term}</dt>
                        <dd>
                          <bdi>{row.value}</bdi>
                        </dd>
                      </div>
                    )}
                  </For>
                </dl>
                <p class="rt-hint">{m().wizard.cannotChange}</p>
              </section>
              <Show when={props.error}>
                <div id="wizard-create-failed">
                  <Notice title={m().review.createFailedTitle} tone="error" role="alert">
                    {props.error}
                  </Notice>
                </div>
              </Show>
              <Switch>
                <Match when={chart.status === "loading" || chart.status === "idle"}>
                  <PageSkeleton shape="cards" label={m().review.loading} />
                </Match>
                <Match when={chart.status === "error"}>
                  <Notice title={m().review.loadFailedTitle} tone="error" role="alert">
                    <p>{m().review.loadFailedBody}</p>
                    <p class="rt-hint">{chart.error}</p>
                    <Button
                      variant="secondary"
                      label={m().review.retry}
                      onClick={() => void ensureChart()}
                    />
                  </Notice>
                </Match>
                <Match when={chart.status === "ready"}>
                  <Details
                    summary={m().review.chartHeading(chart.accounts.length)}
                    open={chartOpen()}
                    onOpenChange={setChartOpen}
                  >
                    <div class="rt-stack">
                      <p class="rt-wizard-lead">
                        <Show when={primaryForm()}>
                          {(form) => `${m().review.taxNotice(formShortName(form()))} `}
                        </Show>
                        {m().review.chartChange}
                      </p>
                      <ChartPreview
                        accounts={chart.accounts}
                        taxForms={chart.taxForms}
                        messages={props.messages ?? {}}
                      />
                    </div>
                  </Details>
                </Match>
              </Switch>
            </div>,
            true,
          )}
        </Match>
      </Switch>
    </section>
  );
}
