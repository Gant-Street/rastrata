# Track your 1099 vendors

**1099 vendors**, under **Reports**, **Tax time**, answers one question for you or your accountant: how much was each
person paid in the year, from the accounts you say hold payments that may need a Form 1099-NEC or 1099-MISC,
and what is still missing (a decision, a W-9). It is a list.

<!-- help: skip -->
**Rastrata books and reports. It files no 1099 and fills in no form, gives no tax advice, never collects or
stores a taxpayer identification number (there is no field for one), and does not decide whether anyone needs
a form.**
<!-- help: end -->
You decide, with your accountant. What the screen can say is what your books show and what the IRS's
own pages say about the threshold, read on 2026-10-04:

- For payments made **before 2026** the reporting threshold is **$600**. For payments made **in 2026** it is
  **$2,000**. The IRS has published no figure for 2027 and later, so the tool offers tax years 2025 and 2026.
- Payments made by **credit or debit card or through a payment app or other third-party network** are
  reported by the processor on Form 1099-K, not by you. They are not counted.
- The IRS's instructions leave out, among other things, payments to a corporation (but not for legal
  services, and medical payments are reportable), merchandise, freight and similar items, wages, payments to
  tax-exempt organizations and governments, and personal payments.

The screen shows the threshold's exceptions and its sources under the figure (**Where this comes from**), and
the IRS's own wording about card payments, payments that need no form and Form W-9, each with the page it was
read from, at the foot (**Notes and sources**).
<!-- help: skip -->
The lane's [verification record](../reference/program/tax.md#the-1099-rules) lists each page and what it says.
<!-- help: end -->

<!-- help: skip -->
For why it counts the way it does, see
[What the tax tools do, and what they leave to you](../explanation/what-the-tax-tools-do.md).
<!-- help: end -->
To hand the list to
whoever files, see [Get your books ready for tax time](get-your-books-ready-for-tax-time.md) (the list is in the
year-end pack) and [Work with your accountant](work-with-your-accountant.md).

## Before you start

Marking accounts and saving vendors changes how the 1099 totals read, so it needs the permission that changes
tags (**configure**): the owner has it, and an agent token has it only if you gave it. Reading the list needs
only **read**.

The payee names come from your bank transactions, so it helps to have imported and posted them first
([Work through For review](work-through-the-inbox.md)).

## Mark the accounts that hold these payments

1. Open **Reports**, then **1099 vendors** under **Tax time**, and choose the **tax year**.
2. **Accounts that hold these payments** lists your expense accounts. Only the ones you mark are counted. An
   account marked **Suggested** is tagged with a Schedule C line the IRS instructions tie to 1099 reporting
   (commissions and fees, contract labor, legal and professional services, rent); that is a hint, not a
   decision. Mark the accounts that really hold payments to people who may need a form, for example
   *Contract labor*.
3. Each tick is saved as soon as you make it, and recorded with who made it and when. If it could not be
   saved the screen says nothing was changed.

## Add the people you paid

1. **Paid, and not a vendor yet** lists payees found in the bank transactions of the marked accounts, largest first, with
   how many payments, on which dates, and exactly what the bank wrote. A payee that matches more than one vendor
   is given to none and says so. The list is on the page once a marked account has a payee that is not a vendor;
   until then, **Add a vendor** beside **Vendors** starts one from nothing.
2. Press **Add a vendor** on the payee's row (a screen reader hears "Make *payee* a vendor", and the form starts with
   that payee's text), or **Add a vendor** above the table to start from nothing. The form asks for:
   - **Name**: how you know them.
   - **Payee texts**, one per line: words that appear whole and in order in a bank transaction's name or description,
     such as `jane doe`. At least three characters each. There is no pattern language and no guessing, so
     `acme` matches `ACME PAYROLL` and not `ACMETECH`. These are the payee's words
     ([a vendor is a payee](#a-vendor-is-a-payee)). **Never a taxpayer identification number or an account
     number.**
   - **Does it need a 1099?**: *Needs a 1099*, *No 1099* (with **Why not**: a corporation, an employee, personal,
     merchandise or freight, a tax-exempt organization or government, paid by card or payment app, or other), or
     *Not decided*.
   - **W-9**: *Not requested*, *Requested* or *Received*, and the **W-9 date**. Rastrata records that you have it
     and when, never what is on it. The IRS describes Form W-9 as the form a payer uses to request a person's
     taxpayer identification number and certifications.
   - **Tax classification on the W-9**, if you want it recorded (individual or sole proprietor, C corporation,
     S corporation, partnership, trust or estate, or an LLC taxed as one of those).
   - **How it is paid**: *Not confirmed*, *Bank transfer, check or cash*, or *Card or payment app*.
   - **Filing details (optional)**: **Legal name**, **Email**, **TIN / W-9 status** (*Not collected*, *On file*, or *Verified*), and **Mailing address**. These track filing readiness without storing a taxpayer identification number.
   - **Notes**. Never a taxpayer identification number.
3. **Save.** Every save is a new version of the vendor, with who and when, shown under **History**. Two people
   cannot overwrite each other: a change names the version it changes, and a stale one is refused with a message
   that the vendor changed since you read it. Close the form and open it again to apply your change to the
   current version.

## A vendor is a payee

A **payee** is any person or business you pay or are paid by, with one name and the words that find it in what
the bank wrote. A **1099 vendor is a payee that also has 1099 details** (whether it needs a form, the W-9, how it
is paid). They are one list with one id, not two lists that could drift apart:

- Every vendor you save appears under **Reports**, **Money by payee**, with the same name and the same words (the
  **Payee texts** above are a payee's words). A payee you named there is not a vendor until you add its 1099
  details here.
- Change the name or the words in either place and the other agrees: each place records a new version, with who
  made it and when, and the other place reads it. The vendor's 1099 details stay on the 1099 tab.
- Each vendor on the table has a **Money by payee** link under its name. It opens the payee beside the report, with
  every transaction it was paid and received, on any account.
- The two screens answer different questions. The 1099 tab counts only the accounts you marked, against the
  threshold, and tells card payments apart. **Money by payee** counts every income and expense account and tells you
  nothing about forms.

For naming payees and reading the report, see
[See who you paid and who paid you](see-who-you-paid-and-who-paid-you.md).

## Read the list

The **Vendors** table shows, for each vendor, whether it needs a 1099, whether a W-9 is on file, and three
amounts for the year:

- **Counted**: payments from your bank accounts, compared with the threshold. A refund from a vendor reduces its
  total.
- **By card or app**: payments from a card account, or all of a vendor you recorded as paid by card or payment
  app. These are the processor's to report and are not counted.
- **Other**: owner money, another asset, a move between expense accounts, or a payment made partly by bank and
  partly by card. Listed with the reason, never counted.

**At or over the threshold** and **Under the threshold** say where *Counted* stands. **Needs** says what is
missing for a vendor at or over it: *Decide whether it needs a 1099*, *No W-9 on file*, or *Payment method not
confirmed*.

### Why a total can be uncertain

A bank transaction cannot say whether a payment was made by debit card or through a payment app, which the IRS says the
processor reports instead. Until you set a vendor's **How it is paid**, a total at or over the threshold is not
certain: the vendor's row says *Payment method not confirmed* under **Needs**, and the CSV says so. When you
know how you paid someone, record it.

In a book kept on the accrual basis the dates are booking dates, not payment dates, and the screen warns you.

## Save the list

**Download the vendor list (CSV)** and **Download every payment (CSV)** save the same two files that go in the
year-end pack. Each is headed by the book revision, the threshold and the accounts counted. A text cell that a
spreadsheet could run as a formula is saved with a leading quote, so a bank's text is only ever text.

## Do it from the command line

```sh
rastrata tax accounts mark 6030 6080                 # the account ids you want counted; "unmark" to stop
rastrata tax vendors --year 2026                     # vendors, and payees that are not vendors yet
rastrata tax vendor save --name "Jane Doe Design" --payees "jane doe" \
  --reporting yes --w9 received --w9-on 2026-02-10 --paid-by bank
rastrata tax vendor save --id VENDOR_ID --expected-version 1 --w9 received    # change one
rastrata tax vendor show VENDOR_ID --year 2026       # its versions and the payments behind its total
rastrata tax vendors --year 2026 --format csv > 1099-vendors.csv
```

## Ask your agent

"Who might need a 1099 for 2026?" An agent reads the list, tells you each total with what
is counted and what is left out, and says what is missing. It does not tell you that anyone does or does not
need a form, and it will not ask you for a taxpayer identification number. With **configure** it can mark the
accounts and save a vendor from what you tell it; you decide each flag.

## What this does not do

- It does not file Form 1099-NEC or 1099-MISC, fill in a form, send anything to a vendor or the IRS, or
  collect a Form W-9.
- It does not decide who needs a form, whether a payee is exempt, or whether a payment is reportable. It lists
  what the books show, so that you and your accountant can.
- It does not handle Form 1099-K. Payments by card and payment app are listed and left out because the IRS says the
  processor reports them.
- It does not withhold anything. The IRS says backup withholding at a flat 24% rate applies when a payee fails to
  give a correct taxpayer identification number when required (Topic no. 307); that is for you and your
  accountant, and Rastrata neither computes nor tracks it.
