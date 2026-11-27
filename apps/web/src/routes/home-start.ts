/** The start of a new book: with nothing in it and no bank connected yet, Home shows the one thing to do
 * (add the bank) and nothing else. Connecting a bank is the way in where the service can connect one, and
 * a statement file is the other; where it cannot, the file is the way in. Two quiet lines sit under it,
 * each for the person it is for: one for whoever is moving from another system, until their history or
 * their opening entry is in, and one for whoever has an agent. It stays until something has come in or
 * been posted, or a bank is connected (its transactions are then on their way, and asking for the bank
 * again would be wrong). Pure: the facts go in, the view comes out; null says this is not a new book.
 * Every role may bring transactions in. */
import type { HomeStartLine, HomeStartView } from "@rastrata/ui/home-types";
import { homeWords } from "@rastrata/ui/home-words";
import { capabilities } from "../capabilities";
import { may } from "../role";
import type { HomeFacts } from "./home-facts";
import { isNewBook } from "./home-needs";
import { connectBankPath } from "./ingest/summary";

const IMPORT_HREF = "/import";
/** Where books from before are brought in: the page of that name, which lists the ways (the start date
 * and opening balances, history from a file, the move from Xero). */
const MOVER_HREF = "/settings/bring-in";
const AGENT_HREF = "/settings/agent";

/** A bank is connected: a feed the service keeps, or an account connected in Stripe's window and booked
 * to an account of the books. A read that failed does not say so. */
export function bankConnected(facts: Pick<HomeFacts, "bankfeed" | "banks">): boolean {
  return (
    (facts.bankfeed.ok && facts.bankfeed.value.connected) ||
    (facts.banks.ok && facts.banks.value.accounts.some((account) => account.booking !== null))
  );
}

/** Whether the books were brought in: a history imported, or an opening entry posted (a planned or
 * reversed one is not). Null when that could not be read. */
function broughtIn(facts: HomeFacts): boolean | null {
  const { closing } = facts;
  return closing.ok
    ? closing.value.opening.status === "posted" || closing.value.historyImported === true
    : null;
}

export function homeStart(facts: HomeFacts): HomeStartView | null {
  if (!isNewBook(facts) || bankConnected(facts)) return null;
  const words = homeWords.start;
  const connect = connectBankPath();
  const lines: HomeStartLine[] = [];
  if (broughtIn(facts) === false && may(facts.role, "post"))
    lines.push({ id: "mover", ...words.mover, href: MOVER_HREF });
  // The agent keys are the owner's to make.
  if (capabilities().agents && may(facts.role, "provision"))
    lines.push({ id: "agent", ...words.agent, href: AGENT_HREF });
  return connect === null
    ? {
        title: words.statement.title,
        text: words.statement.text,
        action: { label: words.statement.action, href: IMPORT_HREF },
        lines,
      }
    : {
        title: words.connect.title,
        text: words.connect.text,
        action: { label: words.connect.action, href: connect },
        alt: { label: words.connect.alt, href: IMPORT_HREF },
        lines,
      };
}
