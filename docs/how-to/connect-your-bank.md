# Connect your bank

A connected bank sends its transactions to **For review** by itself, so you do not download and import a
statement each time. Nothing is posted until you accept it there.

Rastrata reads your bank through Stripe, and only the transactions of the accounts you choose. It cannot
move money, and it never sees your bank password. You can stop at any time, and what is already in your
books stays.

## Connect a bank

Only an owner can connect a bank.

1. Open **Bank accounts** and choose **Connect a bank**.
2. Sign in to your bank in the window from Stripe, and choose the accounts to read.

That is all. Back on **Bank accounts**, each account you chose has an account of its own in your books,
named as the bank names it, and its transactions since your books' start date begin to arrive.

If your books already hold a bank account or a card that one of them could be, that row asks **Is this the
same account?** Answer **Yes** to put its transactions in the account you have, or **No** to keep it
separate.

Each row says where the account goes in your books, how many of its transactions are waiting in For
review, and what your books hold in it. To put an account somewhere else, or to bring in transactions from
another day, open the menu at the end of its row and choose **Change account in books**.

## Work through what arrives

Open **Transactions**. What the bank sent is in **For review** with a suggested category where Rastrata
has one ([Work through For review](work-through-the-inbox.md)). On **Accounts**, the bank account's row
says what the bank says its balance is when that is not what your books hold.

## If the bank asks you to sign in again

A bank ends a connection from time to time. The bank then says **Needs you to sign in again**: choose
**Sign in to** and the bank's name. Nothing that already arrived is lost, and reading carries on from where it
stopped.

## Disconnect an account

Open the menu at the end of the account's row and choose **Disconnect**. Nothing more is read from the
account. Transactions waiting for review and in your books stay. To read it again you connect the bank
again.

## If a transaction could not be read exactly

A transaction whose figures could not be read exactly is not brought in, and nothing is guessed. It is
listed on **Bank accounts** under **Transactions that could not be read exactly**. Import a statement for
those days instead ([Import a bank statement](import-a-bank-statement.md)): a transaction is never added
twice.
