/** How each worksheet reads: the order of the lines as the IRS form prints them, which lines are sums
 * of accounts and which are arithmetic on other lines, and which lines the books cannot know.
 *
 * The lines themselves, with their printed captions and numbers per tax year, are the chart lane's
 * verified catalog (chart/tax-lines.ts). This file adds only what a worksheet needs on top of it:
 * the computed lines with the IRS's own wording of how each is figured (read from the 2025 forms
 * and the 2026 drafts on 2026-10-04: docs/reference/program/tax.md), and the order. A test checks
 * that every catalog line of a form appears in its layout exactly once, so a line the catalog gains
 * cannot be silently left out of a worksheet.
 *
 * Pure and portable. */
import { taxForm, type TaxFormId } from "../chart/tax-lines.ts";

export type WorksheetFormId = "scheduleC" | "form1120S" | "form1065";
export const WORKSHEET_FORMS: readonly WorksheetFormId[] = ["scheduleC", "form1120S", "form1065"];
export const isWorksheetForm = (value: unknown): value is WorksheetFormId =>
  typeof value === "string" && (WORKSHEET_FORMS as readonly string[]).includes(value);

/** One term of a computed line: add (1) or subtract (-1) another line, by id. */
export type Term = readonly [sign: 1 | -1, id: string];

/** A line that is the sum of the accounts tagged with it. `plus` names computed lines whose total
 * is also part of it (Form 1120-S line 2 takes Form 1125-A line 8). */
export interface TaggedItem {
  readonly kind: "tagged";
  readonly id: string;
  readonly plus?: readonly string[];
  /** Said after the catalog's own note for the line. */
  readonly more?: string;
}

/** A line the form figures from other lines. `formula` is the IRS's printed wording. */
export interface ComputedItem {
  readonly kind: "computed";
  readonly id: string;
  readonly number: string;
  readonly label: string;
  readonly formula: string;
  readonly terms: readonly Term[];
}

/** A line the books cannot know (an inventory count). It reads 0.00 and says so. */
export interface UntrackedItem {
  readonly kind: "untracked";
  readonly id: string;
  readonly number: string;
  readonly label: string;
  readonly note: string;
}

export type LayoutItem = TaggedItem | ComputedItem | UntrackedItem;

export interface LayoutPart {
  readonly key: string;
  readonly label: string;
  /** The form the part's lines are printed on: Form 1125-A for the cost-of-goods-sold part of an
   * S corporation or a partnership. */
  readonly form: TaxFormId;
  readonly items: readonly LayoutItem[];
}

export interface FormLayout {
  readonly form: WorksheetFormId;
  /** The forms the layout draws lines from, the return itself first. */
  readonly forms: readonly TaxFormId[];
  readonly parts: readonly LayoutPart[];
  /** The line that is the worksheet's net: net profit, or ordinary business income. */
  readonly net: string;
  /** The line this worksheet's meals percentage applies to, when the form has one. */
  readonly meals?: string;
}

const tagged = (id: string, extra: Omit<TaggedItem, "kind" | "id"> = {}): TaggedItem => ({
  kind: "tagged",
  id,
  ...extra,
});
const computed = (
  id: string,
  number: string,
  label: string,
  formula: string,
  ...terms: readonly Term[]
): ComputedItem => ({ kind: "computed", id, number, label, formula, terms });
const untracked = (id: string, number: string, label: string, note: string): UntrackedItem => ({
  kind: "untracked",
  id,
  number,
  label,
  note,
});

const INVENTORY_NOTE =
  "Rastrata does not value inventory, so this is shown as 0.00. Enter your count if you keep an inventory.";
const add = (...ids: readonly string[]): readonly Term[] => ids.map((id) => [1, id] as const);

// ---------------------------------------------------------------------------------------------
// Schedule C (Form 1040). 2025 final; 2026 IRS draft. Interest is 16a and 16b on the 2025 form and
// 16a, 16b (vehicle loan) and 16c on the 2026 draft: the catalog says which exist.
// ---------------------------------------------------------------------------------------------
const sc = (number: string) => `scheduleC.line${number}`;

function scheduleC(taxYear: number): FormLayout {
  const expenses = [
    "8",
    "9",
    "10",
    "11",
    "12",
    "13",
    "14",
    "15",
    "16a",
    ...(taxYear >= 2026 ? ["16b", "16c"] : ["16b"]),
    "17",
    "18",
    "19",
    "20a",
    "20b",
    "21",
    "22",
    "23",
    "24a",
    "24b",
    "25",
    "26",
    "27a",
    "27b",
  ].map(sc);
  return {
    form: "scheduleC",
    forms: ["scheduleC"],
    net: sc("31"),
    meals: sc("24b"),
    parts: [
      {
        key: "income",
        label: "Part I: Income",
        form: "scheduleC",
        items: [
          tagged(sc("1")),
          tagged(sc("2")),
          computed(
            sc("3"),
            "3",
            "Gross receipts less returns and allowances",
            "Subtract line 2 from line 1",
            [1, sc("1")],
            [-1, sc("2")],
          ),
          computed(sc("4"), "4", "Cost of goods sold", "From line 42", [1, sc("42")]),
          computed(
            sc("5"),
            "5",
            "Gross profit",
            "Subtract line 4 from line 3",
            [1, sc("3")],
            [-1, sc("4")],
          ),
          tagged(sc("6")),
          computed(sc("7"), "7", "Gross income", "Add lines 5 and 6", ...add(sc("5"), sc("6"))),
        ],
      },
      {
        key: "expenses",
        label: "Part II: Expenses",
        form: "scheduleC",
        items: [
          ...expenses.map((id) => tagged(id, id === sc("27b") ? { more: PART_V } : {})),
          computed(
            sc("28"),
            "28",
            "Total expenses before expenses for business use of home",
            "Add lines 8 through 27b",
            ...add(...expenses),
          ),
          computed(
            sc("29"),
            "29",
            "Tentative profit or (loss)",
            "Subtract line 28 from line 7",
            [1, sc("7")],
            [-1, sc("28")],
          ),
          tagged(sc("30")),
          computed(
            sc("31"),
            "31",
            "Net profit or (loss)",
            "Subtract line 30 from line 29",
            [1, sc("29")],
            [-1, sc("30")],
          ),
        ],
      },
      {
        key: "cogs",
        label: "Part III: Cost of goods sold",
        form: "scheduleC",
        items: [
          untracked(sc("35"), "35", "Inventory at beginning of year", INVENTORY_NOTE),
          tagged(sc("36")),
          tagged(sc("37")),
          tagged(sc("38")),
          tagged(sc("39")),
          computed(
            sc("40"),
            "40",
            "Total of lines 35 through 39",
            "Add lines 35 through 39",
            ...add(sc("35"), sc("36"), sc("37"), sc("38"), sc("39")),
          ),
          untracked(sc("41"), "41", "Inventory at end of year", INVENTORY_NOTE),
          computed(
            sc("42"),
            "42",
            "Cost of goods sold",
            "Subtract line 41 from line 40",
            [1, sc("40")],
            [-1, sc("41")],
          ),
        ],
      },
    ],
  };
}
const PART_V = "List each account below in Part V (line 48).";

// ---------------------------------------------------------------------------------------------
// Form 1125-A (Rev. November 2024), the cost-of-goods-sold detail an S corporation or a partnership
// attaches. The same revision serves both tax years.
// ---------------------------------------------------------------------------------------------
const f25 = (number: string) => `form1125A.line${number}`;
function costOfGoodsSold(): LayoutPart {
  return {
    key: "form1125A",
    label: "Cost of goods sold (Form 1125-A)",
    form: "form1125A",
    items: [
      untracked(f25("1"), "1", "Inventory at beginning of year", INVENTORY_NOTE),
      tagged(f25("2")),
      tagged(f25("3")),
      tagged(f25("4")),
      tagged(f25("5")),
      computed(
        f25("6"),
        "6",
        "Total of lines 1 through 5",
        "Add lines 1 through 5",
        ...add(f25("1"), f25("2"), f25("3"), f25("4"), f25("5")),
      ),
      untracked(f25("7"), "7", "Inventory at end of year", INVENTORY_NOTE),
      computed(
        f25("8"),
        "8",
        "Cost of goods sold",
        "Subtract line 7 from line 6",
        [1, f25("6")],
        [-1, f25("7")],
      ),
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Form 1120-S, page 1 (2025 final, 2026 IRS draft). Line 2 takes Form 1125-A line 8.
// ---------------------------------------------------------------------------------------------
const s = (number: string) => `form1120S.line${number}`;
function form1120S(): FormLayout {
  const deductions = [
    "7",
    "8",
    "9",
    "10",
    "11",
    "12",
    "13",
    "14",
    "15",
    "16",
    "17",
    "18",
    "19",
    "20",
  ];
  return {
    form: "form1120S",
    forms: ["form1120S", "form1125A"],
    net: s("22"),
    parts: [
      {
        key: "income",
        label: "Income",
        form: "form1120S",
        items: [
          tagged(s("1a")),
          tagged(s("1b")),
          computed(s("1c"), "1c", "Balance", "Line 1a less line 1b", [1, s("1a")], [-1, s("1b")]),
          tagged(s("2"), { plus: [f25("8")] }),
          computed(
            s("3"),
            "3",
            "Gross profit",
            "Subtract line 2 from line 1c",
            [1, s("1c")],
            [-1, s("2")],
          ),
          tagged(s("4")),
          tagged(s("5")),
          computed(
            s("6"),
            "6",
            "Total income (loss)",
            "Add lines 3 through 5",
            ...add(s("3"), s("4"), s("5")),
          ),
        ],
      },
      {
        key: "deductions",
        label: "Deductions",
        form: "form1120S",
        items: [
          ...deductions.map((number) => tagged(s(number))),
          computed(
            s("21"),
            "21",
            "Total deductions",
            "Add lines 7 through 20",
            ...add(...deductions.map(s)),
          ),
          computed(
            s("22"),
            "22",
            "Ordinary business income (loss)",
            "Subtract line 21 from line 6",
            [1, s("6")],
            [-1, s("21")],
          ),
        ],
      },
      costOfGoodsSold(),
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Form 1065, page 1 (2025 final, 2026 IRS draft). Lines 4 and 5 (income from other partnerships,
// net farm profit) and 16b (depreciation already reported on Form 1125-A) are not in the books.
// ---------------------------------------------------------------------------------------------
const p = (number: string) => `form1065.line${number}`;
function form1065(): FormLayout {
  const before = ["9", "10", "11", "12", "13", "14", "15", "16a"];
  const after = ["17", "18", "19", "20", "21"];
  const NOT_TRACKED =
    "Rastrata does not track this line, so it is shown as 0.00. Enter it from your records.";
  return {
    form: "form1065",
    forms: ["form1065", "form1125A"],
    net: p("23"),
    parts: [
      {
        key: "income",
        label: "Income",
        form: "form1065",
        items: [
          tagged(p("1a")),
          tagged(p("1b")),
          computed(p("1c"), "1c", "Balance", "Line 1a less line 1b", [1, p("1a")], [-1, p("1b")]),
          tagged(p("2"), { plus: [f25("8")] }),
          computed(
            p("3"),
            "3",
            "Gross profit",
            "Subtract line 2 from line 1c",
            [1, p("1c")],
            [-1, p("2")],
          ),
          untracked(
            p("4"),
            "4",
            "Ordinary income (loss) from other partnerships, estates, and trusts",
            NOT_TRACKED,
          ),
          untracked(p("5"), "5", "Net farm profit (loss)", NOT_TRACKED),
          tagged(p("6")),
          tagged(p("7")),
          computed(
            p("8"),
            "8",
            "Total income (loss)",
            "Combine lines 3 through 7",
            ...add(p("3"), p("4"), p("5"), p("6"), p("7")),
          ),
        ],
      },
      {
        key: "deductions",
        label: "Deductions",
        form: "form1065",
        items: [
          ...before.map((number) => tagged(p(number))),
          untracked(
            p("16b"),
            "16b",
            "Less depreciation reported on Form 1125-A and elsewhere on return",
            NOT_TRACKED,
          ),
          computed(
            p("16c"),
            "16c",
            "Depreciation",
            "Line 16a less line 16b",
            [1, p("16a")],
            [-1, p("16b")],
          ),
          ...after.map((number) => tagged(p(number))),
          computed(
            p("22"),
            "22",
            "Total deductions",
            "Add the amounts shown in the far right column for lines 9 through 21",
            ...add(
              ...before.filter((number) => number !== "16a").map(p),
              p("16c"),
              ...after.map(p),
            ),
          ),
          computed(
            p("23"),
            "23",
            "Ordinary business income (loss)",
            "Subtract line 22 from line 8",
            [1, p("8")],
            [-1, p("22")],
          ),
        ],
      },
      costOfGoodsSold(),
    ],
  };
}

/** The layout of a worksheet for a form and a tax year. */
export function worksheetLayout(formId: WorksheetFormId, taxYear: number): FormLayout {
  switch (formId) {
    case "scheduleC":
      return scheduleC(taxYear);
    case "form1120S":
      return form1120S();
    case "form1065":
      return form1065();
  }
}

/** Every catalog line of the forms a layout draws on, which a test compares with the layout. */
export function catalogLineIds(formId: WorksheetFormId, taxYear: number): readonly string[] {
  return worksheetLayout(formId, taxYear).forms.flatMap(
    (id) => taxForm(id, taxYear)?.lines.map((line) => line.id) ?? [],
  );
}
