import {
  array,
  code,
  date,
  hash,
  id,
  nullable,
  object,
  operation,
  ref,
  revision,
  role,
  text,
  type Schema,
} from "../../schema-kit.ts";
import type { SliceSchema } from "../types.ts";

/** A tax form's year. The verified catalog covers a few of them; the service says which. */
const taxYear: Schema = { type: "integer", minimum: 2000, maximum: 2100 };

/** The five cash-flow classes, written out here because a slice schema imports from the schema kit
 * only. A test keeps this list equal to the one the service validates against. */
const cashFlowClass: Schema = {
  type: "string",
  enum: ["cash", "operating", "investing", "financing", "noncash"],
};
/** "scheduleC.line16c": the form, then the printed line number. Which lines exist is checked by
 * the service against the verified tax-line catalog. */
const taxLine: Schema = {
  type: "string",
  minLength: 7,
  maxLength: 40,
  pattern: "^[A-Za-z][A-Za-z0-9]{1,15}\\.line[0-9]{1,2}[a-z]?$",
};
/** "stripe.balance": lower-case words joined by dots or hyphens. */
const roleKey: Schema = {
  type: "string",
  minLength: 2,
  maxLength: 40,
  pattern: "^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$",
};
/** "bank" on an asset that is a bank account, "card" on a liability that is a card. */
const taggedKind: Schema = { type: "string", enum: ["bank", "card"] };

export const chartSchema: SliceSchema = {
  name: "chart",
  definitions: {
    AccountTags: object({ cashFlowClass, taxLine, roleKey, kind: taggedKind }, []),
    AccountTagsPatch: object(
      {
        cashFlowClass: nullable(cashFlowClass),
        taxLine: nullable(taxLine),
        roleKey: nullable(roleKey),
        kind: nullable(taggedKind),
      },
      [],
    ),
    AccountSetTagsInput: object({
      accountId: id,
      effectiveOn: date,
      tags: ref("AccountTagsPatch"),
    }),
    AccountSetTagsResult: object({
      accountId: id,
      effectiveOn: date,
      tags: ref("AccountTags"),
      changed: { type: "boolean" },
      tagsRevision: revision,
      tagsHash: hash,
      warnings: array(text(600), 20),
    }),
    AccountTagHistoryInput: object({ accountId: id }),
    AccountTagEvent: object(
      {
        tag: { type: "string", enum: ["cashFlowClass", "taxLine", "roleKey", "kind"] },
        effectiveOn: date,
        value: nullable(text(60)),
        source: { type: "string", enum: ["setup", "change"] },
        recordedAt: text(40),
        /** Who made the change, as the book records a caller ("owner", "agent:<id>", "member:<id>"); absent for a
         * change made before the book recorded it. */
        by: text(100),
      },
      ["tag", "effectiveOn", "value", "source", "recordedAt"],
    ),
    AccountTagHistory: object({
      accountId: id,
      tagsRevision: revision,
      tagsHash: hash,
      events: array(ref("AccountTagEvent")),
    }),
    TaxSourceInfo: object({ title: text(200), url: text(300) }),
    TaxLineInfo: object(
      {
        id: text(40),
        number: text(4),
        label: text(200),
        part: text(40),
        kind: { type: "string", enum: ["income", "costOfGoods", "expense"] },
        roles: array(role, 8),
        note: text(400),
      },
      ["id", "number", "label", "part", "kind", "roles"],
    ),
    TaxFormInfo: object({
      id: text(20),
      name: text(60),
      subject: text(200),
      taxYear: taxYear,
      status: { type: "string", enum: ["final", "draft"] },
      verifiedOn: date,
      sources: array(ref("TaxSourceInfo"), 10),
      lines: array(ref("TaxLineInfo"), 100),
    }),
    TaxLinesInput: object(
      {
        taxYear,
        form: { type: "string", enum: ["scheduleC", "form1120S", "form1065", "form1125A"] },
      },
      [],
    ),
    TaxLines: object({
      taxYear,
      taxYears: array(taxYear, 10),
      disclaimer: text(300),
      forms: array(ref("TaxFormInfo"), 4),
    }),
    TemplateSummary: object(
      {
        id,
        name: text(120),
        description: text(600),
        entity: {
          type: "string",
          enum: ["soleProprietor", "sCorporation", "partnership", "generic"],
        },
        taxForm: text(20),
        taxFormName: text(60),
      },
      ["id", "name", "description", "entity"],
    ),
    AddOnSummary: object({ id, name: text(120), description: text(600) }),
    TemplateList: object({
      templates: array(ref("TemplateSummary"), 20),
      addOns: array(ref("AddOnSummary"), 20),
      taxYears: array(taxYear, 10),
      latestTaxYear: taxYear,
      disclaimer: text(300),
    }),
    TemplateGetInput: object(
      {
        templateId: id,
        basis: { type: "string", enum: ["cash", "accrual"] },
        taxYear,
        addOns: array(id, 10),
      },
      ["templateId"],
    ),
    TemplateAccount: object(
      {
        code,
        name: { ...text(120), minLength: 1, pattern: "\\S" },
        role,
        parentCode: code,
        tags: ref("AccountTags"),
        note: text(400),
      },
      ["code", "name", "role", "tags"],
    ),
    TemplateDetail: object({
      id,
      name: text(120),
      description: text(600),
      entity: {
        type: "string",
        enum: ["soleProprietor", "sCorporation", "partnership", "generic"],
      },
      basis: { type: "string", enum: ["cash", "accrual"] },
      taxYear: nullable(taxYear),
      taxForms: array(ref("TaxFormInfo"), 4),
      addOns: array(id, 10),
      disclaimer: text(300),
      notes: array(text(600), 30),
      accounts: array(ref("TemplateAccount"), 200),
    }),
  },
  readsBeforeSetup: ["templates.list", "templates.get", "taxLines.list"],
  operations: [
    operation(
      "accounts.setTags",
      "Set, change or clear an account's tags (cash-flow class, tax line, role key) from an effective date. Tags are versioned by date and never edited in place; reports that use them change from that date.",
      "configure",
      "AccountSetTagsInput",
      true,
      "AccountSetTagsResult",
    ),
    operation(
      "accounts.tagHistory",
      "Read every recorded change to one account's tags, oldest first, including the tags it was given at setup.",
      "read",
      "AccountTagHistoryInput",
      false,
      "AccountTagHistory",
    ),
    operation(
      "templates.list",
      "List the chart templates (entity types) and add-ons a book can start from, the tax years their tax lines cover and the not-tax-advice notice. Works before a book exists.",
      "read",
      "Empty",
      false,
      "TemplateList",
    ),
    operation(
      "templates.get",
      "Build one template's chart for an accounting basis, tax year and add-ons: every account with its type, cash-flow class, tax line and role key, notes for the entity, and the tax form lines used. Pass each account's code, name, role, parentCode and tags to book.setup (leave out note). A template carries no bank or card account: add the person's own, named as the bank names them, when a statement, a bank connection or their old books bring them. Tax lines are suggestions; verify against the current form; not tax advice. Works before a book exists.",
      "read",
      "TemplateGetInput",
      false,
      "TemplateDetail",
    ),
    operation(
      "taxLines.list",
      "List the tax form lines accounts can be tagged with (Schedule C, Form 1120-S, Form 1065, Form 1125-A), verified against the IRS forms, for one tax year. Line numbers can mean different things on different years' forms, so read the year being prepared. Not tax advice. Works before a book exists.",
      "read",
      "TaxLinesInput",
      false,
      "TaxLines",
    ),
  ],
};
