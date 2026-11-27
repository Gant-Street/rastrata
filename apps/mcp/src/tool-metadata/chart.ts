import type { ToolMetadata } from "./types.ts";

/** MCP tool metadata for the operations the chart slice adds, keyed by operation name. */
export const chartTools: Readonly<Record<string, ToolMetadata>> = {
  "accounts.setTags": {
    name: "rastrata_set_account_tags",
    title: "Tag an account",
    description:
      "Set, change or clear an account's tags from an effective date. Tags are cashFlowClass (balance-sheet accounts only: cash, operating, investing, financing, noncash), taxLine (a form line such as scheduleC.line18; list the valid lines with rastrata_list_tax_lines first) roleKey (a key such as stripe.balance that names exactly one account) and kind (bank on an asset that is a bank account, card on a liability that is a card: Home, Reconcile and the statement import list those). Each tag has its own timeline: a new value from a date supersedes the earlier one without erasing it, and null clears a tag. Reports that read tags change from that date, and the result warns when the date falls in a closed period. A tax line is a suggestion read from the IRS form, not tax advice; say so, and do not pick one for the user without showing it. This does not change any balance or journal.",
  },
  "accounts.tagHistory": {
    name: "rastrata_get_account_tag_history",
    title: "Read an account's tag history",
    description:
      "Read every recorded change to one account's tags, oldest first, including the tags it was given at setup. Use it to explain why a report classified an account the way it did.",
  },
  "templates.list": {
    name: "rastrata_list_chart_templates",
    title: "List chart templates",
    description:
      "Start here when a user wants to set up a book. Lists the chart templates (sole proprietor or single-member LLC on Schedule C, S corporation, partnership or multi-member LLC, other business) and the add-ons (online business with Stripe), and the tax years their tax lines cover. Works before a book exists and changes nothing. Ask the user which entity type they are; do not guess, because the template carries tax lines. Tax lines are suggestions from the IRS form, not tax advice.",
  },
  "templates.get": {
    name: "rastrata_get_chart_template",
    title: "Build a chart from a template",
    description:
      "Build one template's chart for the accounting basis the user chose (cash is the default; it cannot be changed after the book exists), a tax year and add-ons. Returns every account with its type, cash-flow class, tax line and role key, notes for the entity and the tax form lines used. To set the book up, pass each account's code, name, role, parentCode and tags to rastrata_setup_book and leave out note. A template carries no bank or card account: those are the user's own, added after setup from what they bring (a statement, a bank connection, their old books), named as the bank names them, as an asset tagged cashFlowClass cash and kind bank (codes 1000, 1010, …) or a liability tagged operating and kind card (2000, 2010, …); never invent one. Works before a book exists and changes nothing. Show the user the chart and the not-tax-advice notice before setting up.",
  },
  "taxLines.list": {
    name: "rastrata_list_tax_lines",
    title: "List tax form lines",
    description:
      "List the tax form lines an account can be tagged with (Schedule C, Form 1120-S, Form 1065, Form 1125-A) for one tax year, verified against the IRS forms. A line number can mean something different on another year's form (Schedule C interest is line 16b on the 2025 form and 16c on the 2026 draft), so use the year being prepared. A year marked draft is an IRS early-release draft. These are suggestions, not tax advice, and Rastrata files nothing.",
  },
};
