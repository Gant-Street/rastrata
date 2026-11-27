# Connect Stripe in a hosted workspace

For an owner of a workspace on app.rastrata.com whose sales go through Stripe. You press a button, choose your Stripe account and approve read-only access in Stripe. There is no key to make or copy.
Rastrata then reads your payouts every day and queues one entry in For review for each, with every charge, fee, refund and dispute it paid out kept as evidence. It never posts anything and never changes anything in Stripe.
[How Rastrata books Stripe](../explanation/stripe-booking.md) says what ends up in your books.

If you would rather keep a key of your own and read Stripe from your computer, use [Book Stripe in a hosted workspace](book-stripe-in-a-hosted-workspace.md) instead.
<!-- help: skip -->
If you run Rastrata on your own computer, use [Connect Stripe](connect-stripe.md).
<!-- help: end -->

## 1. Connect

Open **Accounts** and press **Connect Stripe** on the Stripe row (it opens Stripe's page; Search finds **Stripe** by name too), then press **Connect Stripe** there. Stripe asks which of your accounts, and shows what the Rastrata app asks for: to read your balance, payouts, charges, refunds, disputes and the sales tax Stripe reports.
All of it is reading; the app cannot move money or change anything. Approve, and Stripe sends you back to Rastrata, which starts reading at once. Nothing else is asked.

Only an owner connects. You need to be an administrator of your Stripe account to install an app there.

## 2. If an account is missing

Each payout is booked to accounts in your chart: Sales, Stripe fees, Refunds and the rest. If your chart came from the online business template, they are found already and there is nothing to do. If one is not, the Stripe
page says *Choose an account for* and names it, and its **Options** are open on that account: choose it and press **Save**. The reading carries on by itself.

The other options have their defaults and are folded under **Options**: the time zone that decides the day a payout falls on (the one your Stripe dashboard reports in), and whether sales tax is taken from Stripe.

## 3. Check and post

The first reading of a year of a small business takes a few minutes: the Stripe page says *Reading now*, and each payout appears in For review as it is read. Open **For review**: each payout is one entry, with its transactions as
evidence, and a payout whose transactions do not add up to it to the cent is shown with the difference and never booked. Stripe's own balance is compared with what Rastrata has read at every reading; the Stripe page speaks of it only when the two differ.
Accept and post what you have checked, as in [Work through For review](work-through-the-inbox.md).

After that Rastrata reads the account every day. **Read now**, in the menu on the Stripe page, reads it at once.

## Real sales and practice data

A workspace reads one kind of Stripe data for good, the first it takes: real sales (live mode) or practice data (test mode, which a Stripe sandbox has). It will not take the other kind, so that practice payouts are never in
your real books. If you try, the page says so; use a workspace of its own for practice data. A workspace reads one Stripe account for good, too: connect the account the books were started with.

## Disconnecting

**Disconnect** (an owner, in the menu on the Stripe page) stops the reading. What is already in your books stays. To take the Rastrata app out of Stripe too, open the Stripe dashboard, then Settings and Installed apps. If you
remove the app there, Rastrata stops reading, and the page says so; **Connect Stripe** starts it again.

## If it does not work

| The page says | What to do |
| --- | --- |
| Stripe could not be connected. Nothing was changed. | Try again. If it keeps happening, tell Rastrata. |
| The connection timed out | Press Connect Stripe to start again; the link is good for fifteen minutes. |
| These books read a different Stripe account | Connect the account the books were started with, or use a new workspace for the other one. |
| These books hold the other kind of Stripe data | Use a workspace of its own for it. |
| Choose an account for ... | An account Stripe needs is not in your chart: see step 2. |
| This workspace is read-only until it is subscribed | An owner subscribes in Settings, Billing; Stripe is read again after that. |
| The Rastrata app was removed in Stripe | Press Connect Stripe to install it again. |
| Stripe refused access to this account | The app may have been removed in Stripe: press Connect Stripe again. |
| Stripe could not be read. Rastrata is trying again. | Nothing to do: it is tried again by itself. **Read now** tries at once. |
