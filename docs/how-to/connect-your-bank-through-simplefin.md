# Connect your bank through SimpleFIN

For someone who already runs a book in Rastrata and wants the bank's posted transactions to arrive in
[For review](work-through-the-inbox.md) without downloading a statement each time. Statement files keep
working and stay the fallback: [Import a statement](import-a-bank-statement.md) is unchanged, and
it is what you use for any bank this does not cover.

Read the first section before you pay for anything. A bank connection is a convenience bought from other
companies, and whether it works for your bank is something only a search at the Bridge can tell you.

## What you are agreeing to

- **A third party sees your bank data.** The [SimpleFIN Bridge](https://beta-bridge.simplefin.org) is a
  separate, paid service. Your bank is reached through an aggregator it uses (MX), then the Bridge, then
  your copy of Rastrata. The Bridge's pages say your bank login goes to the aggregator and never to its
  own servers, and Rastrata never sees your bank login at all. The Bridge's security page also
  discloses an incident in May 2026, in which a bug let up to 39 of its users see each other's
  transactions for about four hours. Read its privacy and security pages yourself and decide.
- **It costs money.** When this was written (2026-10-04) the Bridge's own pages said $1.50 a month or
  $15.00 a year, plus tax. Check its page for the price today.
- **Whether your bank works depends on the bank.** The Bridge lists the banks it can reach on a public
  page, [Supported institutions](https://beta-bridge.simplefin.org/search-institutions): type part of your
  bank's name and it says whether it is supported. You do not need an account to search. Its coverage is
  the United States and Canada. **Search for your bank before you pay**, and if it is not there, stop
  here and use statement files. A listing is a bank, not a kind of account, and the page says nothing
  about business accounts, which are covered less often than personal ones: only connecting tells you
  whether the account you want can be read. When this was written (2026-10-04) a search for "Chase"
  found Chase Bank and a search for "Rho" found Rho, so for the two banks this page was written for the
  answer was "listed", and still not "works for a business account". Do not assume.
- **It reads, never writes.** Rastrata asks the Bridge for transactions. It cannot move money, post
  anything by itself, or change anything at your bank. A sync queues transactions in For review,
  exactly where a statement import puts them, and you accept and post them as you always do.
- **Only posted transactions come in.** A pending transaction is imported once the bank has posted it:
  nothing says whether a pending item keeps its identity when it posts, and importing one that does not
  would book it twice. Expect a delay of a day or two for some banks.
- **Rastrata is careful with the Bridge's limits.** The Bridge expects about 24 requests a day and
  disables an access that asks too often. Rastrata counts every request, in your book, so a restart
  does not forget, and stops at 20 in any 24 hours. If the Bridge itself asks it to slow down, it stops
  asking for 24 hours.

## 1. Check your bank, then set up the Bridge

At the Bridge: check that your institution is listed (the search page above), create an account, add your bank there (you sign
in to your bank through the Bridge's aggregator, not through Rastrata), and create a **setup token** for
an application. A setup token is one long line of letters and digits. The Bridge's developer guide
(`https://beta-bridge.simplefin.org/info/developers`) describes it; the Bridge's menus and wording may
differ from this page, and the idea is the same.

A setup token **works once**. Rastrata trades it for an access URL and keeps that. Treat the token like
a password anyway: never paste it into a chat, an email or an agent. If you pasted it anywhere else,
disable it at the Bridge and create another.

## 2. Connect it to Rastrata

In the app, open **Settings, Connections**, then **Bank connection**. The page puts the setup token field first,
and what you are agreeing to (the cost, who sees your data, and how to get a token) under **Before you connect**,
open below it. Paste the setup token into the masked field and press **Connect**. The field is emptied the moment you press it,
and the token is never shown again. The accounts the Bridge lists then appear, each **not linked**.

From the command line, give the token on standard input or in a file. **Never as an argument**: an
argument is visible to every program on your computer in the process list and is kept in your shell
history, so `--token` is refused with that reason.

```sh
pbpaste | rastrata bankfeed connect          # macOS: the token from the clipboard
rastrata bankfeed connect --token-file token.txt   # or from a file, then delete the file
```

What Rastrata keeps is the **access URL**, in a private file named `simplefin.access` in the data folder
beside your book, readable only by you. It is never shown, logged or returned, and it is **in no
backup and no export**, on purpose: those have more readers than your book should give a credential for
your bank data. The cost is that restoring a backup on another computer brings your links and your
imported transactions but not the connection; connect again there with a new setup token.

## 3. Choose which accounts to read

Rastrata reads **only the accounts you link**. For each account the Bridge lists, choose the chart
account it is recorded to (an open asset or liability account that is not a Stripe account) and, if you
want, the first day to read. The first day defaults to your start date (see
[Move from Xero](move-from-xero.md)), or the first day of the fiscal year if there is none; transactions before
it are set aside, visibly, in For review.

```sh
rastrata accounts list                                   # the chart's account ids
rastrata bankfeed accounts                               # the Bridge's accounts (one request of its day)
rastrata bankfeed link --account "<Bridge account id>" --to <chart account id> --from 2026-01-01
```

An account that appears at your bank later is shown as **not linked** and is never read or linked for
you. An account in a currency other than your book's can be linked, but Rastrata never converts: its
transactions are held for you in For review. If statement files already feed the same chart account, the
screen says so, because the same transactions would be queued twice for the dates both cover: choose a
first day after your last imported transaction.

## 4. Sync, then review

Press **Sync now** on the screen, or run `rastrata bankfeed sync`. The first sync reads from the first
day you chose, in windows of 45 days, so it can take several steps; each step says how far it got. Each
window is one of the Bridge's requests, so a first day a year back costs about eight of the day's
twenty, and a first day two years back more than the day allows: Rastrata then stops, says when it may
ask again, and carries on the next day. Choose the first day you actually need. When it finishes it
says how many transactions are waiting. Open For review and accept them as you would any
others ([Work through For review](work-through-the-inbox.md)).

Every later sync reads from five days before where the last one stopped, so a transaction the bank
posts late is still caught, and a transaction already imported is recognised and not queued again.

If a sync stops with **paused**, do not ask again: either the day's budget is spent (it carries on when a
request frees up) or the Bridge asked Rastrata to slow down (24 hours). The command exits with code 3 and
says when it may be asked again.

## 5. The balance, and reconciling

Each linked account shows the **balance from the connection**, what the Bridge says, beside what your books
hold, what is waiting in For review and what was set aside, and the part that is not explained. A difference
is normal at first: an opening balance not yet entered, transactions still waiting in For review, or a first
day after the account started. **A balance from the connection is what the Bridge says, not your bank's
statement.** Reconcile still asks for
the statement's own ending balance ([Reconcile an account](reconcile-an-account.md)); the connection never
stands in for it, and Rastrata never adjusts anything to make the two agree.

A transaction the Bridge sends that cannot be written exactly in cents is **held**, listed on the
screen and not imported. Import that period from a statement file, or add the entry by hand.

## 6. Optionally, sync by itself once a day

Off until you turn it on. On the screen choose **Sync once a day by itself** and a time (a minute that
is not on the hour is kinder to the Bridge), or run `rastrata bankfeed settings --daily true --at 07:42`.
It runs inside the installed Rastrata service only (a copy you started for development does not run it,
and the screen says so), uses the same request budget as pressing the button, never posts anything, and
tries at most twice a day: the second time only after the Bridge could not be reached, two hours later.
A computer that was asleep at the chosen time syncs when it wakes. When the Bridge has refused the access,
it does not try again by itself: that needs you.

## 7. When something needs you

The **What needs you** list on the screen says which bank and where to go; Home says only that your
bank connection needs attention, in its own **Needs you** list, with a link here. The common ones:

| It says | What it means and what to do |
| --- | --- |
| This is not a SimpleFIN setup token | Copy all of the token, with nothing before or after it |
| The token points to a server that is not the SimpleFIN Bridge | It did not come from the Bridge: do not use it |
| The token does not exist or has already been used | A token works once. Disable it at the Bridge and create a new one |
| A bank needs you to sign in again at the Bridge | The bank is asking for your login. Reconnect it at the Bridge; Rastrata cannot do it for you and never sees the login |
| The Bridge refused the access | It was revoked or disabled (an access that asks too often is disabled). Create a new setup token and connect again |
| The Bridge asked Rastrata to slow down | Nothing is asked for 24 hours, then it carries on by itself |
| Some transactions were not imported | They could not be read exactly. Use a statement file for that period |
| The connection is not saved on this computer | A restored backup or a copied book does not carry it. Connect again with a new token |
| The last successful sync was N days ago | Sync now, or look at the connection at the Bridge |

## Stopping

**Disconnect** on the screen, or `rastrata bankfeed disconnect --yes`, deletes the saved access URL.
Imported transactions, your links and how far each account was read are kept, so connecting again with a new
token carries on from there. It does not tell the Bridge: to stop the access working, disable it in
your Bridge account too, and cancel the subscription there if you are done with it.

## What it does not do

It does not post, match a transaction from the connection against one from a statement, convert currencies, import pending
transactions, read investment holdings, or let an agent connect, disconnect or turn on the daily sync
(an agent can check the status, link and unlink an account you named, and sync).
<!-- help: skip -->
How this was built and
checked, and what is still open, is in [the bank feed lane's record](../reference/program/bankfeed.md).
<!-- help: end -->
