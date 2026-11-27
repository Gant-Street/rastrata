import { ApplicationError } from "../../errors.ts";
import {
  ADD_ONS,
  addOnSpec,
  buildTemplate,
  TEMPLATES,
  templateSpec,
  type TemplateBasis,
} from "../../chart/templates.ts";
import {
  isTaxFormId,
  LATEST_TAX_YEAR,
  TAX_DISCLAIMER,
  TAX_FORM_SHORT_NAMES,
  TAX_YEARS,
  taxForms,
} from "../../chart/tax-lines.ts";
import type { SliceHandlers } from "../types.ts";

const yearsText = () => TAX_YEARS.join(" and ");

/** A tax year the verified catalog covers. Asking for another is an error, never a silent nearest
 * year: the line numbers of a form differ between years, so the wrong year is the wrong line. */
function coveredYear(requested: unknown): number {
  if (requested === undefined) return LATEST_TAX_YEAR;
  if (typeof requested === "number" && TAX_YEARS.includes(requested)) return requested;
  throw new ApplicationError(
    "tax_year_unsupported",
    `Rastrata's verified tax-line catalog covers ${yearsText()}. Line numbers differ between years' forms, so choose one of those years.`,
    400,
    [{ path: "input.taxYear", message: `Supported: ${yearsText()}` }],
  );
}

/** Catalog reads. They need no book, so they work before `book.setup`: the setup wizard and an
 * agent starting a new book both read them first. */
export const catalogHandlers: SliceHandlers = {
  "templates.list": () => ({
    templates: TEMPLATES.map((template) => ({
      id: template.id,
      name: template.name,
      description: template.description,
      entity: template.entity,
      ...(template.form
        ? { taxForm: template.form, taxFormName: TAX_FORM_SHORT_NAMES[template.form] }
        : {}),
    })),
    addOns: ADD_ONS.map((addOn) => ({
      id: addOn.id,
      name: addOn.name,
      description: addOn.description,
    })),
    taxYears: [...TAX_YEARS],
    latestTaxYear: LATEST_TAX_YEAR,
    disclaimer: TAX_DISCLAIMER,
  }),

  "templates.get": (input) => {
    const request = input as {
      templateId: string;
      basis?: TemplateBasis;
      taxYear?: number;
      addOns?: string[];
    };
    if (!templateSpec(request.templateId))
      throw new ApplicationError(
        "template_not_found",
        `There is no template ${request.templateId}. List them with templates.list.`,
        404,
      );
    const addOns = [...new Set(request.addOns ?? [])];
    const unknown = addOns.find((id) => !addOnSpec(id));
    if (unknown !== undefined)
      throw new ApplicationError(
        "add_on_not_found",
        `There is no add-on ${unknown}. List them with templates.list.`,
        400,
        [{ path: "input.addOns", message: `Unknown add-on ${unknown}` }],
      );
    return buildTemplate(request.templateId, {
      addOns,
      basis: request.basis ?? "cash",
      taxYear: coveredYear(request.taxYear),
    });
  },

  "taxLines.list": (input) => {
    const request = input as { taxYear?: number; form?: string };
    const year = coveredYear(request.taxYear);
    const wanted = request.form;
    return {
      taxYear: year,
      taxYears: [...TAX_YEARS],
      disclaimer: TAX_DISCLAIMER,
      forms: taxForms(year).filter(
        (form) => wanted === undefined || (isTaxFormId(wanted) && form.id === wanted),
      ),
    };
  },
};
