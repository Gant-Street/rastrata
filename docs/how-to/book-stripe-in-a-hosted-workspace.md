# Book Stripe in a hosted workspace

For someone whose books are in a Rastrata workspace on app.rastrata.com, takes payments through Stripe, and would rather keep a key of their own than press [Connect Stripe](connect-stripe-in-a-hosted-workspace.md) (a button on Stripe's page, opened from Accounts, which needs no key). A hosted workspace never holds a Stripe key, so it cannot read Stripe itself: a command on your own computer reads Stripe with a key that stays there, and hands the answers to your workspace, which books them. [How Rastrata books Stripe](../explanation/stripe-booking.md) says what ends up in the books: one entry for each payout, with every charge, fee, refund and dispute it paid out kept as evidence.
<!-- help: skip -->
If you run Rastrata on your own computer, use [Connect Stripe](connect-stripe.md) instead.
<!-- help: end -->

You need the command line, signed in to your workspace ([connect your agent to a hosted workspace](connect-your-agent-to-a-hosted-workspace.md) says how), and a Stripe account you can make a key in.

## 1. Make a restricted key

In the Stripe dashboard open Developers, then API keys, then create a restricted key. Give it Read access to exactly these and None to everything else (they are Stripe's own permission names):

| Permission | Why |
| --- | --- |
| `balance_read` | Balance transactions and Stripe's own balance |
| `balance_transaction_source_read` | The charge, refund or dispute behind each balance transaction |
| `charge_read` | The charges and refunds behind each balance transaction |
| `dispute_read` | The disputes behind each balance transaction |
| `payout_read` | Payouts and their transactions |
| `checkout_session_read` | The sales tax Stripe reports on Checkout payments |
| `invoice_read` | The sales tax Stripe reports on invoices and subscriptions |
| `connected_account_read` | Which Stripe account this is, and its time zone |

If Stripe refuses a request for a permission the key lacks, the message names it: add it. If you do not collect sales tax through Stripe, leave out the two tax permissions and choose `--sales-tax none` in step 3. The key starts with `rk_live_`. The command refuses a key that starts with `sk_` (it can do more than read) and a test key (`rk_test_`), unless you add `--test-mode=true` to book test data on purpose.

## 2. Keep the key on your computer, outside any chat

Put the key in an environment variable of the terminal you will run the command in, without it ending up in your shell's history:

```sh
read -rs RASTRATA_STRIPE_KEY && export RASTRATA_STRIPE_KEY
```

Paste the key and press Return. Nothing is shown. The key goes to Stripe, from this computer, and nowhere else: not to Rastrata, not to your workspace, not into a file. Do not paste it into a conversation with an agent, and no Rastrata tool will ask you to. An agent that runs the command for you needs the variable to be in its environment already, which you set before you start it.

## 3. Choose the accounts, once

Stripe is booked against eight roles in your chart: the Stripe balance, payouts in transit, sales, sales tax, refunds, chargebacks, Stripe fees and, if you want it, other adjustments. If your chart came from the online business template they are tagged already:

```sh
rastrata stripe configure --time-zone America/Denver --sync-from 2026-01-01
```

The answer lists each role and the account it resolves to, or what is missing. `--sync-from` is the first day to read and cannot change once Stripe has been read.
<!-- help: skip -->
The other options, and how to choose an account yourself, are in [Connect Stripe](connect-stripe.md#3-choose-the-accounts).
<!-- help: end -->

## 4. Pull

```sh
rastrata stripe pull
```

The command asks your workspace what it needs to see, reads exactly that from Stripe, and delivers it, round after round, until the workspace needs nothing more. A first pull of a year of a small business is a few dozen rounds and takes a minute or two; a pull a day later is a handful of rounds and a few seconds. It prints what it did:

```
Stripe pull: done in 9 rounds, 41 requests made of Stripe: 3 payouts booked, 27 lines queued in the Inbox.
```

It never posts anything and never changes anything in Stripe. For each payout Stripe has finished itemising, one entry waits in For review with the transactions it carries as evidence; a payout Stripe is still itemising is booked by a later pull. Run it whenever you like, for example each morning: each run reads what is new, with a three-day overlap so a late movement is not missed, and nothing is booked twice. If it stops partway (the connection, Stripe limiting requests), run it again and it carries on.

## 5. Check it and post

```sh
rastrata stripe status
rastrata stripe payouts
```

`status` compares Stripe's own balance with what Rastrata knows is in Stripe and not yet paid out, and says why they differ if they do. `payouts` shows each payout, how it is booked, whether the transactions Stripe lists for it add up to its amount to the cent, and whether a bank deposit has been matched to it. A payout that does not add up is reported and never booked. Then look at a few of the entries and accept and post the ones you have checked, as in [Work through For review](work-through-the-inbox.md).

## What your workspace sees

Stripe's own answers, byte for byte, in the same form the books keep as evidence when Rastrata reads Stripe itself. It sees nothing else of your Stripe account, and the command asks for nothing outside balance transactions, payouts, the account, the balance and the tax figures of Checkout sessions and invoices: if the workspace ever asked for anything else, the command would refuse and say so. What the workspace is told is the word of your computer, as a statement file you upload is: it checks that every payout's transactions add up to the payout to the cent and holds the ones that do not.

## If it does not work

| It says | What to do |
| --- | --- |
| `stripe_key_unusable` | The key is missing, is not a restricted live key, or is a test key. The message says which. |
| `stripe_not_configured` | An account Stripe needs is not in your chart: choose it (step 3). Nothing else has to be set first. |
| `stripe_permission_denied` | The key lacks a permission; the message names it. Add Read access for it in the dashboard, or leave sales tax out (step 1). |
| `stripe_account_changed` | The key belongs to a different Stripe account than the one this workspace has been reading. Nothing was imported. Use the original account's key. |
| `permission_denied` | The token you are signed in with cannot draft. A pull needs the right to draft (the `draft` preset of an agent key). |
| `clock_ahead` | Your computer's clock is more than two minutes ahead of the service's. Set it right. |
| `stripe_unreachable` | Stripe could not be reached or kept limiting requests. Run the pull again in a moment. |
| `stripe_pull_unavailable` | The workspace's service is older than this command line. Wait for it to be updated, or use an older command line. |
| `stripe_pull_stalled` | The pull stopped because it was not getting anywhere. Run it again; if it happens again, tell Rastrata. |
