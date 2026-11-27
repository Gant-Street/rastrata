# Connect Stripe

For someone who already runs a book in Rastrata and wants every Stripe charge, fee, refund, dispute
and payout in it. Read [How Rastrata books Stripe](../explanation/stripe-booking.md) for what ends
up in the books: one entry for each payout, with its transactions kept as evidence.

Rastrata only reads from Stripe. It uses a restricted key that cannot move money, and the key is
never printed, logged, returned or sent anywhere except to Stripe.

<!-- help: skip -->
This page is for Rastrata running on your own computer. If your books are in a workspace on
app.rastrata.com, which holds no Stripe key, use [Book Stripe in a hosted workspace](book-stripe-in-a-hosted-workspace.md).
<!-- help: end -->

## 1. Create a restricted, read-only key

In the Stripe dashboard open Developers, then API keys, then create a restricted key. Give it Read
access to exactly these, and None to everything else. The names are Stripe's own permissions from its
[API permissions reference](https://docs.stripe.com/keys/permissions-reference):

| Permission | Why |
| --- | --- |
| `balance_read` | Balance transactions and Stripe's own balance |
| `charge_read` | The charges and refunds behind each balance transaction |
| `dispute_read` | The disputes behind each balance transaction |
| `payout_read` | Payouts and their transactions |
| `checkout_session_read` | The sales tax Stripe reports on Checkout payments |
| `invoice_read` | The sales tax Stripe reports on invoices and subscriptions |
| `connected_account_read` | Which Stripe account this is, and its time zone |

A restricted key starts with `rk_live_` (live) or `rk_test_` (test). A key that starts with `sk_` works
but is unrestricted; Rastrata will say so. If you do not collect sales tax, you can leave out the
Checkout and invoice permissions and set sales tax to `none` (step 3).

## 2. Give Rastrata the key, outside any chat

Put the key where only you can read it. Either set the environment variable of the Rastrata service:

```sh
export RASTRATA_STRIPE_KEY=rk_live_...
```

or save it in a file named `stripe.key` in the data folder beside the book, readable only by you:

```sh
chmod 600 path/to/data/stripe.key
```

Rastrata refuses a key file that other users can read, and tells you the command to fix it. Never
paste the key into a prompt for an agent, an issue or a message: no Rastrata tool accepts one.

Once Rastrata can read the key, the **Stripe** tile on Home is a link, **Finish setting up Stripe**. That
is the next step and not a fault: a key that has a problem, or a sync that failed, is what makes the tile
say the connection needs attention.

## 3. Choose the accounts

Rastrata books Stripe against eight roles: `stripe.balance`, `payouts.in-transit`, `revenue.sales`,
`tax.sales`, `refunds`, `chargebacks`, `stripe.fees`, and the optional `stripe.adjustments` (for
adjustments, top-ups and reserves inside a payout). Each is the account that carries that **role
key** in your chart. Rastrata never goes by an account's name or code.

If your chart came from the online business template, its Stripe accounts carry the keys already:

```sh
rastrata stripe configure
```

The answer lists each role and the account it resolves to (or what is missing or ambiguous). If two
accounts carry one key, or none does, say which account is meant:

```sh
rastrata stripe configure \
  --map "stripe.fees=6025,refunds=4100" \
  --sync-from 2026-01-01 --time-zone America/Denver --sales-tax stripe
```

`--map` replaces the accounts you have chosen; a role you leave out uses the account carrying its
role key. `--map none` clears your choices. To give an account a key yourself, set it in the chart:
`rastrata accounts tag ACCOUNT_ID --role-key stripe.fees --effective-on 2026-01-01`, or the Accounts screen. A key is read as of the date of each entry, so a
key that moves to another account on a date is followed.

`--sync-from` is the first day to import and cannot change once Stripe transactions are imported. `--time-zone`
decides which day a payout was made and sent; use the zone Stripe's dashboard reports in if you
compare with its reports. `rastrata stripe status` shows Stripe's own time zone once it has been
read.

## 4. Sync

```sh
rastrata stripe sync
```

The first sync reads from `--sync-from`, in steps; it keeps going until it is caught up. It never
posts anything. For each payout Stripe has finished itemising, one entry waits in For review, with
the transactions it carries listed as evidence. Transactions Stripe has not paid out yet wait, and a
payout Stripe is still itemising is booked on a later sync. Run it again whenever you like; each run
reads only what is new, with a three-day overlap so a late-arriving movement is not missed, and
nothing is ever imported twice.

## 5. Check it

Open Settings, then Connections, then Stripe in the web app. **Sync now** is the page's button, and under it are
the payouts: each with its date, its amount, and whether its bank deposit is matched (the way to match one is the
link in its row). The page speaks of the key only when it is missing or cannot be used, of an account only when a
role has none, and of Stripe's balance only when it differs from what was read. The time zone, sales tax and each
role's account are under **Options**. A sync needs nothing saved first: a book that was told nothing uses its
defaults (the day the books begin, the time zone of the Stripe dashboard, sales tax as Stripe reports it). The same
from the command line:

```sh
rastrata stripe status
rastrata stripe payouts
```

`status` compares Stripe's own balance (available plus pending) with what Rastrata knows is in Stripe
and not yet paid out, and explains any difference. `payouts` shows each payout, how it is booked,
whether the transactions Stripe lists for it add up to the payout amount to the cent, and whether a
bank deposit has been matched to it (`--filter unmatched` lists the ones still waiting). A payout
that does not add up is reported and never booked.

## 6. Post what you have checked

The entries wait in For review, one for each payout (**Transactions > For review**, with **Stripe** chosen in
the account strip). Look at a few payouts (`rastrata inbox show ITEM_ID` lists the transactions each one
is made of), then accept and post the ones the Stripe proposer is sure of:

```sh
rastrata inbox accept --provider=stripe --proposer=stripe --min-confidence=100
rastrata inbox post --provider=stripe
```

Bank deposits you import from your statements are then matched to the payouts (For review proposes
clearing payouts in transit); accept those the same way. Payouts of the same amount are paired with
their deposits one to one, the closest dates first, and each proposal names its payout and says how it
was chosen; one with a doubt (another transaction of that amount is just as close) is proposed at a lower
confidence, so a bulk accept at 90 or more leaves it for you to look at. A payout is matched once its
deposit is accepted; one that should have arrived days ago and has no deposit is reported as overdue.

## When it stops

| Code | Meaning | What to do |
| --- | --- | --- |
| `stripe_not_configured` | An account Stripe needs is not settled | Step 3: the message names each role and what is wrong with it |
| `stripe_key_missing` | No key found | Step 2 |
| `stripe_key_unusable` | The key or its file is unusable | Fix what the message says |
| `stripe_key_rejected` | Stripe refused the key | Create a new restricted key |
| `stripe_permission_denied` | The key lacks a read permission | Add the one Stripe names (an account with top-ups or transfers needs Read for those too, because each movement's source is read with it) |
| `stripe_account_changed` | The key is for a different Stripe account | Use the original account's key |
| `stripe_rate_limited`, `stripe_unavailable` | Stripe is busy or down | Wait, then sync again |

A sync that stops partway resumes from the last page it applied. A payout is booked whole or not at
all, so a stop never leaves half a payout.
