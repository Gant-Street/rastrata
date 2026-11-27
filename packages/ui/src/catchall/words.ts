/** Every word the catch-all screens say, in the product's vocabulary: For review, Transactions, Close the
 * books, categorize. Data (account names, amounts, dates, what a bank wrote) is never in this file. The
 * glossary test reads it. */

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

export const catchallWords = {
  /** What Close the books says about money collecting in an account for what fits nowhere else. */
  notes: {
    region: "Notes about this month",
    holdsTitle: (account: string) => `Money is collecting in ${account}`,
    holds: (account: string, amount: string, count: number, period: string, soFar: boolean) =>
      `${account} holds ${amount} from ${count} ${plural(count, "transaction", "transactions")} in ${period}${soFar ? " so far" : ""}.`,
    largestHeading: "Where most of it went",
    unnamed: "not named yet",
    ambiguous: "matches more than one payee",
    reassure:
      "This does not stop you closing the month. Moving these transactions to the accounts they belong to makes your reports say more.",
    see: "See these transactions",
    seeIn: (account: string) => `See these transactions in ${account}`,
    notCheckedTitle: (account: string) => `${account} could not be checked`,
    notChecked: (account: string, period: string) =>
      `What ${account} took in ${period} could not be read, so it is not known whether money is collecting there. Your books have not been changed.`,
  },

  /** Changing the account of posted transactions from Transactions. */
  change: {
    action: "Change account",
    title: (count: number) =>
      count === 1
        ? "Change the account of this transaction"
        : `Change the account of ${count} transactions`,
    close: "Close",
    cancel: "Cancel",
    back: "Back",
    done: "Done",
    intro:
      "Choose the account these transactions should be on. You will see what happens to each one before anything changes.",
    how: "Nothing is edited or deleted. Each old entry stays in your books, a linked entry cancels it, and a new entry is made on the new account.",
    capped: (included: number, left: number) =>
      `This change takes ${included} transactions at a time. The first ${included} are included; ${left} more were selected. Select them again afterwards.`,
    accountLabel: "Move to account",
    accountRequired: "Choose the account to move them to.",
    accountsFailed: "The accounts could not be read, so none can be chosen.",
    accountsRetry: "Read the accounts again",
    reasonLabel: "Reason",
    reasonHint: "Optional. Kept in each transaction's history.",
    show: "Show what will happen",
    planning: "Checking…",
    denied:
      "Your access does not allow changing the account of transactions. Ask the owner of the books.",
    planFailedTitle: "Nothing was changed",
    planIncomplete:
      "There was not time to check all of them, so nothing was changed. Select fewer transactions and try again.",

    plan: {
      caption: "What will happen to each transaction",
      scroll: "The transactions and what will happen to each",
      columnDate: "Date",
      columnDescription: "Description",
      columnFrom: "Now on",
      columnTo: "Moves to",
      columnAmount: "Amount",
      columnResult: "What happens",
      willMove: "Will move",
      notMoved: "Not moved",
      left: {
        review: "Waiting for review again: categorize it",
        ready: "Ready to post",
      },
      all: (count: number, target: string) =>
        count === 1
          ? `This transaction will move to ${target}.`
          : `All ${count} transactions will move to ${target}.`,
      some: (moving: number, total: number, target: string) =>
        `${moving} of ${total} transactions will move to ${target}. ${total - moving} cannot be moved.`,
      none: (total: number, target: string) =>
        total === 1
          ? `This transaction cannot be moved to ${target}.`
          : `None of the ${total} transactions can be moved to ${target}.`,
      warnings: "Before you move them",
      confirm: (count: number) => `Move ${count} ${plural(count, "transaction", "transactions")}`,
      confirmNone: "Nothing to move",
    },

    working: (done: number, total: number) => `Moving ${done} of ${total}…`,
    workingLabel: "Moving transactions",
    uncertainTitle: "Waiting for the answer",
    uncertain:
      "The request was sent and no answer came back. It is kept: resume it to finish, and nothing is done twice.",
    resume: "Resume",
    stoppedTitle: "The change stopped",
    waitingTitle: "A change of account is waiting for an answer",
    waiting:
      "A change of account was sent and no answer came back. Resume it to find out what was done and to finish; nothing is done twice.",
    result: {
      moved: (count: number, target: string) =>
        `${count} ${plural(count, "transaction", "transactions")} moved to ${target}.`,
      movedNone: "Nothing was moved.",
      notReached: "It was not reached. Select it again to move it.",
      notMoved: (count: number) =>
        `${count} ${plural(count, "transaction was", "transactions were")} not moved:`,
      notMovedList: "The transactions that were not moved",
      toast: (count: number, target: string) =>
        `${count} ${plural(count, "transaction", "transactions")} moved to ${target}.`,
      stays: "The old entries stay in your books, each with a linked entry that cancels it.",
    },
  },

  /** Marking an account to be watched at month end, on the Chart of accounts. */
  watch: {
    action: "Watch this account",
    stopAction: "Stop watching this account",
    note: "Watched at month end",
    watchTitle: (account: string) => `Watch ${account}`,
    stopTitle: (account: string) => `Stop watching ${account}`,
    explainExpense: (account: string) =>
      `When you close a month, you will see how much was spent on ${account}, from how many transactions, and which payees took the most. Use it for the account where expenses go when they fit nowhere else. It never stops you closing a month.`,
    explainIncome: (account: string) =>
      `When you close a month, you will see how much was received in ${account}, from how many transactions, and which payees it came from. Use it for the account where income goes when it fits nowhere else. It never stops you closing a month.`,
    replacesTitle: "Another account is watched now",
    replaces: (other: string) => `Watching this account instead stops watching ${other}.`,
    stopExplain: (account: string) =>
      `You will no longer see what ${account} took when you close a month. Nothing in your books changes.`,
    confirm: "Watch this account",
    stopConfirm: "Stop watching",
    cancel: "Cancel",
    close: "Close",
    working: "Saving…",
    watching: (account: string) => `${account} is watched at month end.`,
    stopped: (account: string) => `${account} is not watched any more.`,
    failedTitle: "That could not be saved",
    failed: "Your chart of accounts has not been changed.",
    inUse:
      "Another account was marked in the meantime. Close this, read the chart again and choose once more.",
    uncertainTitle: "Waiting for the answer",
    uncertain:
      "The change was sent and no answer came back. It is kept: resume it to finish, and nothing is done twice.",
    resume: "Resume",
  },
};
